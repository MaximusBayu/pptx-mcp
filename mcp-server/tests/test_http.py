import httpx
import pytest
import respx
from starlette.testclient import TestClient

import server


class _FakeMCP:
    """Records how the entrypoint would have started the server."""

    def __init__(self):
        self.calls = []

    def run(self, *args, **kwargs):
        self.calls.append((args, kwargs))


def test_main_defaults_to_stdio(monkeypatch):
    fake = _FakeMCP()
    monkeypatch.delenv("MCP_TRANSPORT", raising=False)
    monkeypatch.setattr(server, "build_server", lambda: fake)
    server.main()
    assert fake.calls == [((), {})]


def test_main_treats_empty_transport_as_stdio(monkeypatch):
    """A compose file or shell prefix can set MCP_TRANSPORT to the empty
    string. That must mean "default", not "unknown transport"."""
    fake = _FakeMCP()
    monkeypatch.setenv("MCP_TRANSPORT", "")
    monkeypatch.setattr(server, "build_server", lambda: fake)
    server.main()
    assert fake.calls == [((), {})]


def test_main_http_uses_env_host_and_port(monkeypatch):
    fake = _FakeMCP()
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setenv("MCP_HOST", "127.0.0.1")
    monkeypatch.setenv("MCP_PORT", "9999")
    monkeypatch.setattr(server, "build_server", lambda: fake)
    server.main()
    (_args, kwargs), = fake.calls
    assert kwargs == {"transport": "http", "host": "127.0.0.1",
                      "port": 9999, "stateless_http": True}


def test_main_http_defaults(monkeypatch):
    fake = _FakeMCP()
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.delenv("MCP_HOST", raising=False)
    monkeypatch.delenv("MCP_PORT", raising=False)
    monkeypatch.setattr(server, "build_server", lambda: fake)
    server.main()
    (_args, kwargs), = fake.calls
    assert kwargs["host"] == "0.0.0.0"
    assert kwargs["port"] == 8765


def test_main_rejects_unknown_transport(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "carrier-pigeon")
    # build_server must not even be reached for an unusable transport.
    monkeypatch.setattr(server, "build_server",
                        lambda: pytest.fail("build_server called for unknown transport"))
    with pytest.raises(SystemExit) as excinfo:
        server.main()
    assert "carrier-pigeon" in str(excinfo.value)


def test_health_route_returns_200():
    app = server.build_server().http_app(stateless_http=True)
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.text == "ok"


def test_http_app_exposes_mcp_endpoint():
    """The MCP endpoint lives at the exact path /mcp — that is the path nginx
    proxies and the URL pasted into Langflow. GET is not its method: FastMCP's
    Streamable HTTP transport only accepts POST (and DELETE for session
    teardown), so a GET to /mcp must fail with 405 (route exists, wrong
    method), not 404 (route missing). A POST is not a valid MCP request
    without the right body/headers, so the assertion there is only that the
    route is reached at all, not that it succeeds.
    """
    app = server.build_server().http_app(stateless_http=True)
    with TestClient(app) as client:
        get_response = client.get("/mcp")
        post_response = client.post("/mcp")
    assert get_response.status_code == 405
    assert post_response.status_code != 404


BASE = "http://web:3000"


@pytest.mark.anyio
async def test_http_transport_forwards_callers_own_key_to_upstream(monkeypatch):
    """Drive the real stack end-to-end for a genuine MCP tools/call, with no
    monkeypatching of fastmcp internals.

    tests/test_auth.py monkeypatches
    fastmcp.server.dependencies.get_http_headers in every HTTP-mode test, so
    nothing there would notice if fastmcp changed how request headers reach a
    tool — every one of those tests would stay green while 100% of production
    calls started returning "missing x-api-key header". This test builds the
    real ASGI app via build_server().http_app(...), speaks real Streamable
    HTTP to it (POST with an SSE-capable Accept header, a real
    initialize/tools-call handshake via mcp.ClientSession), and only mocks the
    *upstream* web app with respx. It asserts that the caller's own
    x-api-key header — not the decoy PPTX_API_KEY environment value — is what
    reaches the upstream request, proving the real header-extraction path
    works end to end.
    """
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    monkeypatch.setenv("MCP_TRANSPORT", "http")
    # Distinct from the caller's header value below, so the assertion proves
    # which one actually reaches the upstream call.
    monkeypatch.setenv("PPTX_API_KEY", "pk_decoy_env_key")
    monkeypatch.setenv("WEB_URL", BASE)

    app = server.build_server().http_app(stateless_http=True)

    # Route the MCP client -> MCP server hop straight into the real ASGI app
    # in-process, so no real socket is involved for that hop.
    http_client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        headers={"x-api-key": "pk_caller_supplied"},
    )

    with respx.mock(assert_all_called=False) as respx_mock:
        route = respx_mock.get(f"{BASE}/api/mcp/templates").mock(
            return_value=httpx.Response(200, json=[{"id": "t1"}]))

        # httpx.ASGITransport talks straight to the ASGI `app` callable and
        # never sends the ASGI "lifespan" events a real server would, but
        # FastMCP's session manager needs its task group created by that
        # lifespan startup. Drive it explicitly so the in-process transport
        # behaves like a real deployment for the duration of the call.
        async with app.router.lifespan_context(app):
            async with http_client:
                async with streamable_http_client(
                    "http://testserver/mcp", http_client=http_client,
                ) as (read_stream, write_stream, _get_session_id):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        result = await session.call_tool("list_templates_tool", {})

    assert result.isError is not True
    assert route.calls.last.request.headers["x-api-key"] == "pk_caller_supplied"
    assert route.calls.last.request.headers["x-api-key"] != "pk_decoy_env_key"
