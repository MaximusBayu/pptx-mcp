import pytest
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
    """The MCP endpoint must exist at /mcp/ — that is the path nginx proxies
    and the URL pasted into Langflow. A plain GET is not a valid MCP request,
    so the assertion is that the path is routed at all, not that it succeeds.
    """
    app = server.build_server().http_app(stateless_http=True)
    with TestClient(app) as client:
        response = client.get("/mcp/")
    assert response.status_code != 404
