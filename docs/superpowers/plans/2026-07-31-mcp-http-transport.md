# MCP Streamable HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the existing five pptx-mcp tools over MCP Streamable HTTP at `https://mcp.maxflow.space/mcp` so Langflow's MCP component can call them, without changing stdio behaviour.

**Architecture:** `mcp-server/server.py` gains an `MCP_TRANSPORT` switch (default `stdio`). In HTTP mode the API key is resolved per request from the `x-api-key` header instead of the environment, and every upstream call goes through one shared helper that attaches the key and maps `401`/`403` to a readable tool error. Deployment enables the previously-disabled prod service and path-mounts it behind the existing external nginx.

**Tech Stack:** Python 3.11, FastMCP 3.2.4, httpx, Starlette (transitive via FastMCP), pytest + respx, Docker Compose.

## Global Constraints

- `MCP_TRANSPORT` defaults to `stdio`. Existing stdio clients must keep working with no config change.
- In HTTP mode there is **no environment fallback** for the API key. A missing or blank `x-api-key` header must raise, never silently use `PPTX_API_KEY`.
- Exact error strings: missing header → `"missing x-api-key header"`; upstream 401/403 → `"invalid or revoked API key"`.
- Default bind: `MCP_HOST=0.0.0.0`, `MCP_PORT=8765`.
- HTTP mode runs with `stateless_http=True`.
- `fastmcp>=3.2` — lower versions lack `transport="http"` and `get_http_headers`.
- Only the five existing tools are exposed. Do not add composition tools.
- Hostname is `mcp.maxflow.space`; MCP is mounted at the **path** `/mcp/`. That host already serves the web app at `/`, so nothing may claim the whole host.
- No `ports:` for `mcp-server` in `compose.prod.yml` — external nginx reaches it over the docker network, matching the `!reset []` policy used by every other service.
- Tests run with `python -m pytest -q` from the `mcp-server/` directory. Baseline before this plan: **5 passed**.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `mcp-server/server.py` | Transport switch, key resolution, upstream helper, tools, health route | 1, 2 |
| `mcp-server/tests/test_auth.py` | *(new)* Key resolution per transport; upstream error mapping | 1 |
| `mcp-server/tests/test_proxy.py` | Existing proxy passthrough tests, updated for the new signatures | 1 |
| `mcp-server/tests/test_http.py` | *(new)* Transport selection in `main()`; `/health` over a real ASGI app | 2 |
| `mcp-server/requirements.txt` | Dependency floor | 3 |
| `mcp-server/Dockerfile` | Declare the port | 3 |
| `docker-compose.yml` | Dev: run in HTTP mode, publish 8765 | 3 |
| `compose.prod.yml` | Prod: enable the service, healthcheck, no published ports | 3 |
| `.env.example` | Document the new variables | 3 |
| `DEPLOY.md` | nginx `location /mcp/` step and its verification | 4 |
| `mcp-server/README.md` | HTTP mode and Langflow setup | 4 |

---

## Task 1: Per-request key resolution and upstream error mapping

**Files:**
- Modify: `mcp-server/server.py:1-45` (imports and the five proxy functions)
- Create: `mcp-server/tests/test_auth.py`
- Modify: `mcp-server/tests/test_proxy.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `_transport() -> str` — lower-cased `MCP_TRANSPORT`, default `"stdio"`.
  - `_api_key() -> str` — resolved caller key for the current transport.
  - `_request(method: str, path: str, api_key: str, **kw) -> dict | list` — upstream call with key header and error mapping.
  - `list_templates(api_key: str) -> list`
  - `get_template_schema(template_id: str, api_key: str) -> dict`
  - `render_deck(template_id: str, deck_spec: dict, api_key: str) -> dict`
  - `render_preview(template_id: str, deck_spec: dict, api_key: str) -> dict`
  - `suggest_layout(template_id: str, content: str, used: dict | None, api_key: str) -> dict`

Note the argument order: `api_key` is **last** on every proxy function, so the tool wrappers in `build_server()` read naturally.

- [ ] **Step 1: Write the failing tests**

Create `mcp-server/tests/test_auth.py`:

```python
import httpx
import pytest
import respx
from fastmcp.exceptions import ToolError

import server

BASE = "http://web:3000"


def test_stdio_mode_reads_key_from_env(monkeypatch):
    monkeypatch.delenv("MCP_TRANSPORT", raising=False)
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    assert server._api_key() == "pk_env"


def test_http_mode_reads_key_from_request_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    # The env key must be ignored in http mode, so set it to a distinct value.
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {"x-api-key": "pk_header"})
    assert server._api_key() == "pk_header"


def test_http_mode_rejects_missing_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {})
    with pytest.raises(ToolError) as excinfo:
        server._api_key()
    assert str(excinfo.value) == "missing x-api-key header"


def test_http_mode_rejects_blank_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {"x-api-key": "   "})
    with pytest.raises(ToolError):
        server._api_key()


@respx.mock
def test_upstream_401_maps_to_tool_error(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(401, json={"error": "unauthorized"}))
    with pytest.raises(ToolError) as excinfo:
        server.list_templates("pk_bad")
    assert str(excinfo.value) == "invalid or revoked API key"


@respx.mock
def test_upstream_403_maps_to_tool_error(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"}))
    with pytest.raises(ToolError):
        server.list_templates("pk_bad")


@respx.mock
def test_upstream_500_still_raises_http_error(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(500, text="boom"))
    with pytest.raises(httpx.HTTPStatusError):
        server.list_templates("pk_ok")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-server && python -m pytest tests/test_auth.py -q`
Expected: FAIL — `AttributeError: module 'server' has no attribute '_api_key'`.

- [ ] **Step 3: Rewrite the top of `server.py`**

Replace everything from line 1 through the end of `suggest_layout` (currently line 44) with:

```python
import os

import httpx
from fastmcp.exceptions import ToolError


def _base() -> str:
    return os.environ.get("WEB_URL", "http://web:3000")


def _transport() -> str:
    # `or "stdio"` also covers MCP_TRANSPORT being set but empty, which a
    # compose file or a shell prefix can easily produce; a bare .get() would
    # return "" there and fail the transport check.
    return (os.environ.get("MCP_TRANSPORT") or "stdio").strip().lower()


def _api_key() -> str:
    """Resolve the caller's API key for the active transport.

    Over HTTP the key belongs to the caller and arrives per request; falling
    back to PPTX_API_KEY there would serve anonymous callers under the
    operator's key. Over stdio the client launched this process, so the
    environment is the only channel available.
    """
    if _transport() == "stdio":
        return os.environ.get("PPTX_API_KEY", "")
    from fastmcp.server.dependencies import get_http_headers
    key = get_http_headers().get("x-api-key", "").strip()
    if not key:
        raise ToolError("missing x-api-key header")
    return key


def _request(method: str, path: str, api_key: str, **kw):
    r = httpx.request(method, f"{_base()}{path}",
                      headers={"X-API-Key": api_key}, **kw)
    if r.status_code in (401, 403):
        raise ToolError("invalid or revoked API key")
    r.raise_for_status()
    return r.json()


def list_templates(api_key: str) -> list:
    return _request("GET", "/api/mcp/templates", api_key, timeout=30)


def get_template_schema(template_id: str, api_key: str) -> dict:
    return _request("GET", f"/api/mcp/templates/{template_id}/schema",
                    api_key, timeout=30)


def render_deck(template_id: str, deck_spec: dict, api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/render",
                    api_key, json={"deck_spec": deck_spec}, timeout=120)


def render_preview(template_id: str, deck_spec: dict, api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/preview",
                    api_key, json={"deck_spec": deck_spec}, timeout=120)


def suggest_layout(template_id: str, content: str, used: dict | None,
                   api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/suggest-layout",
                    api_key, json={"content": content, "used": used or {}},
                    timeout=30)
```

The old `_headers()` function is deleted; `_request` owns header construction now.

- [ ] **Step 4: Update the tool wrappers in `build_server()`**

Inside `build_server()`, each tool body now resolves the key and passes it. Change only the `return` line of each of the five tools; **leave every docstring exactly as it is** — `tests/test_proxy.py` asserts on their content.

```python
        return list_templates(_api_key())
```
```python
        return get_template_schema(template_id, _api_key())
```
```python
        return render_deck(template_id, deck_spec, _api_key())
```
```python
        return render_preview(template_id, deck_spec, _api_key())
```
```python
        return suggest_layout(template_id, content, used, _api_key())
```

- [ ] **Step 5: Update `tests/test_proxy.py` for the new signatures**

The three passthrough tests call the proxy functions directly, so they now pass the key as an argument instead of setting `PPTX_API_KEY`. Replace the file's three `@respx.mock` tests with:

```python
@respx.mock
def test_list_templates(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    route = respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(200, json=[{"id": "t1"}]))
    out = list_templates("pk_a_b")
    assert out[0]["id"] == "t1"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"


@respx.mock
def test_render_deck_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.post(f"{BASE}/api/mcp/templates/t1/render").mock(
        return_value=httpx.Response(200, json={"validation": [], "download_url": "https://d/u"}))
    out = render_deck("t1", {"slides": []}, "pk_a_b")
    assert out["download_url"] == "https://d/u"


@respx.mock
def test_suggest_layout_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    from server import suggest_layout
    route = respx.post(f"{BASE}/api/mcp/templates/t1/suggest-layout").mock(
        return_value=httpx.Response(200, json={"candidates": [{"slide_type": "slide_2", "repeatable": True}]}))
    out = suggest_layout("t1", "Severity CRITICAL", {"slide_2": 1}, "pk_a_b")
    assert out["candidates"][0]["slide_type"] == "slide_2"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"
```

The two docstring tests in that file are unchanged — do not touch them.

- [ ] **Step 6: Run the full suite**

Run: `cd mcp-server && python -m pytest -q`
Expected: PASS, 12 passed (5 pre-existing + 7 new).

- [ ] **Step 7: Commit**

```bash
git add mcp-server/server.py mcp-server/tests/test_proxy.py mcp-server/tests/test_auth.py
git commit -m "feat(mcp): resolve API key per request and map upstream auth errors

Over HTTP the key belongs to the caller, so read x-api-key off the
request rather than the process environment; an env fallback there would
serve anonymous callers under the operator's key. stdio keeps reading
PPTX_API_KEY. One shared request helper attaches the header and turns an
upstream 401/403 into a readable tool error instead of a raw httpx
traceback, which is now the likeliest failure mode."
```

---

## Task 2: Transport switch and health route

**Files:**
- Modify: `mcp-server/server.py` (inside `build_server()`, and the `__main__` block at the end)
- Create: `mcp-server/tests/test_http.py`

**Interfaces:**
- Consumes: `_transport() -> str` and `build_server()` from Task 1.
- Produces: `main() -> None` — the entrypoint that selects a transport.

- [ ] **Step 1: Write the failing tests**

Create `mcp-server/tests/test_http.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-server && python -m pytest tests/test_http.py -q`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'main'`.

- [ ] **Step 3: Add the health route inside `build_server()`**

Add this import at the top of `server.py`, below the `httpx` import:

```python
from starlette.responses import PlainTextResponse
```

Then, inside `build_server()` immediately after `mcp = FastMCP("pptx-mcp")`, add:

```python
    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request):
        """Plain-HTTP liveness probe.

        The MCP endpoint rejects requests without MCP-shaped Accept headers,
        so container healthchecks and proxy probes need a route that speaks
        ordinary HTTP.
        """
        return PlainTextResponse("ok")
```

- [ ] **Step 4: Replace the `__main__` block**

Replace the final two lines of `server.py`:

```python
if __name__ == "__main__":
    build_server().run()
```

with:

```python
def main() -> None:
    transport = _transport()
    if transport == "stdio":
        build_server().run()
    elif transport in ("http", "streamable-http"):
        build_server().run(
            transport="http",
            host=os.environ.get("MCP_HOST", "0.0.0.0"),
            port=int(os.environ.get("MCP_PORT", "8765")),
            stateless_http=True,
        )
    else:
        raise SystemExit(
            f"unknown MCP_TRANSPORT {transport!r}; expected 'stdio' or 'http'")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the full suite**

Run: `cd mcp-server && python -m pytest -q`
Expected: PASS, 19 passed (12 from Task 1 + 7 new).

- [ ] **Step 6: Verify stdio still works by hand**

Run: `cd mcp-server && echo '' | MCP_TRANSPORT= PPTX_API_KEY=pk_test python server.py`
Expected: the process starts, waits on stdin, and exits on EOF without a traceback. This proves the default path is unchanged for existing clients.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/server.py mcp-server/tests/test_http.py
git commit -m "feat(mcp): MCP_TRANSPORT switch with stateless HTTP and /health

Default stays stdio so existing clients need no config change. HTTP mode
runs stateless because Streamable HTTP otherwise keeps per-session state,
which would demand session affinity at the proxy and break whenever a
client reconnects. The MCP endpoint rejects probes that lack MCP-shaped
Accept headers, so /health exists for container and proxy checks. An
unknown transport exits loudly rather than falling back to stdio and
leaving a healthy-looking container with a closed port."
```

---

## Task 3: Deployment wiring

**Files:**
- Modify: `mcp-server/requirements.txt:1`
- Modify: `mcp-server/Dockerfile:6`
- Modify: `docker-compose.yml:44-47`
- Modify: `compose.prod.yml:48-50`
- Modify: `.env.example:22-23`

**Interfaces:**
- Consumes: `MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT` from Task 2; the `/health` route from Task 2.
- Produces: a `mcp-server` container listening on `8765` inside the compose network.

- [ ] **Step 1: Raise the dependency floor**

In `mcp-server/requirements.txt`, change the first line from `fastmcp>=0.2.0` to:

```
fastmcp>=3.2
```

Versions below 3.2 have neither `transport="http"` nor `get_http_headers`, so a clean image build could install a release that cannot run this server at all.

- [ ] **Step 2: Declare the port in the image**

In `mcp-server/Dockerfile`, insert a line between `COPY mcp-server/ .` and the `CMD` line:

```dockerfile
EXPOSE 8765
```

`CMD ["python", "server.py"]` is unchanged — the transport comes from the environment.

- [ ] **Step 3: Run the service in HTTP mode in development**

In `docker-compose.yml`, replace the `mcp-server` service block:

```yaml
  mcp-server:
    build: { context: ., dockerfile: mcp-server/Dockerfile }
    env_file: .env
    environment:
      MCP_TRANSPORT: http
    depends_on: [web]
    ports: ["8765:8765"]
```

`environment:` takes precedence over `env_file:`, so `MCP_TRANSPORT` is fixed here regardless of what `.env` holds. `WEB_URL` still comes from `.env` and must stay `http://web:3000` — the container reaches the web app over the compose network, not through the public hostname.

- [ ] **Step 4: Enable the service in production**

In `compose.prod.yml`, replace the `mcp-server` block:

```yaml
  mcp-server:
    restart: unless-stopped
    ports: !reset []
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8765/health',timeout=3).status==200 else 1)\""]
      interval: 15s
      timeout: 5s
      retries: 5
```

The `deploy: replicas: 0` stanza is deleted, which is what actually starts the service. `ports: !reset []` drops the development port publication so the container is reachable only over the docker network, matching every other service in this file. The healthcheck mirrors the `engine-service` pattern already in this file — the image is `python:3.11-slim` and has no `curl`.

- [ ] **Step 5: Document the new variables**

In `.env.example`, replace the two existing lines:

```
WEB_URL=http://web:3000
PPTX_API_KEY=
```

with:

```
# Reached over the compose network — not the public hostname, which would
# send the MCP server's own calls back out through nginx.
WEB_URL=http://web:3000
# Only used when MCP_TRANSPORT=stdio. In http mode the caller supplies the
# key per request via the x-api-key header and this value is ignored.
PPTX_API_KEY=
# stdio (default) or http. Compose sets http for the mcp-server service.
MCP_TRANSPORT=stdio
MCP_PORT=8765
```

- [ ] **Step 6: Verify both compose files still parse and merge**

Run: `docker compose config >/dev/null && echo DEV_OK`
Expected: prints `DEV_OK`.

Run: `docker compose -f docker-compose.yml -f compose.prod.yml config | grep -A2 "mcp-server:"`
Expected: the `mcp-server` service is present, with no `replicas: 0` and no published ports.

- [ ] **Step 7: Verify the container actually serves HTTP**

Run:
```bash
docker compose up -d --build mcp-server
curl -fsS http://localhost:8765/health
```
Expected: prints `ok`.

Then confirm the MCP endpoint answers a real client, not just the health route:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/mcp/
```
Expected: a non-404 status (a plain GET is not a valid MCP request; the point is that the route exists).

- [ ] **Step 8: Commit**

```bash
git add mcp-server/requirements.txt mcp-server/Dockerfile docker-compose.yml compose.prod.yml .env.example
git commit -m "feat(deploy): run mcp-server over HTTP on 8765

The service was pinned to replicas: 0 and so never ran in production.
Enable it, add a plain-HTTP healthcheck matching the engine-service
pattern (the slim image has no curl), and keep ports unpublished in prod
so the external nginx reaches it over the docker network like every other
service. Raise the fastmcp floor to 3.2, below which the HTTP transport
and get_http_headers do not exist."
```

---

## Task 4: Ingress and client documentation

**Files:**
- Modify: `DEPLOY.md:118` (section 5 heading) and a new section after it
- Modify: `mcp-server/README.md:51-111` (the "Run it from an MCP client" section)

**Interfaces:**
- Consumes: the `mcp-server:8765` service from Task 3 and the `/mcp/` path from Task 2.
- Produces: no code.

- [ ] **Step 1: Fix the stale section heading in `DEPLOY.md`**

Line 118 currently reads `## 5. Production compose override + Caddy`. Caddy was removed in commit `fd3d896`; TLS is handled by the external nginx. Change it to:

```markdown
## 5. Production compose override
```

- [ ] **Step 2: Add the ingress step to `DEPLOY.md`**

Insert this as a new section immediately before `## 6. Generate the Prisma migration (first deploy only)`. It is numbered `5b` so every existing step reference stays valid.

````markdown
## 5b. Expose the MCP server through nginx

The MCP server listens on `mcp-server:8765` inside the compose network and is
not published to the host. The VPS nginx (`rise-gateway`) already terminates
TLS for `mcp.maxflow.space` and proxies it to `web:3000`. Add two `location`
blocks to that existing server block: one for the health probe, one for the MCP
endpoint. The health route is an exact match, which nginx evaluates at higher
priority, so it wins even though `/mcp` prefix matches will also match
`/mcp/health`. Without the exact match, a request to `/mcp/health` would be
rewritten to `/health` — which is correct — then proxied to the server, but
`/mcp` also matches, so nginx reorders and `/mcp` wins, and the request
becomes a loop.

```nginx
location = /mcp/health {
    proxy_pass http://mcp-server:8765/health;
}

location /mcp {
    proxy_pass http://mcp-server:8765;
    proxy_http_version 1.1;      # the 1.0 default breaks chunked streaming
    proxy_buffering off;         # else streamed events sit in nginx's buffer
    proxy_read_timeout 3600s;    # else long renders are cut at the 60s default
    proxy_set_header Host $host;
}
```

The `proxy_pass` without a trailing slash passes the original request URI
through unchanged. Both `/mcp` and `/mcp/` are matched by the prefix; neither
has a path segment that is rewritten. This way, a client posting to
`https://mcp.maxflow.space/mcp` or `https://mcp.maxflow.space/mcp/` reaches
upstream `/mcp` without redirect loops.

No DNS record and no certificate change are needed: this is a path on an
existing host.

**Verify:**
```bash
nginx -t && systemctl reload nginx
curl -fsS https://mcp.maxflow.space/mcp/health   # -> ok
```

If `curl` returns `404` or the web app's HTML, the routing is wrong — check
that both `location` blocks sit inside the `mcp.maxflow.space` server block.
````

- [ ] **Step 3: Rewrite the client section of `mcp-server/README.md`**

Replace the section that begins `## Run it from an MCP client` and its "Option A / Option B / Claude Code" subsections (lines 51-111) with:

````markdown
## Configuration

| Var | Default | Meaning |
|---|---|---|
| `WEB_URL` | `http://web:3000` | Base URL of the web app |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` | `8765` | HTTP bind port |
| `PPTX_API_KEY` | — | Your `pk_...` key. **stdio mode only** |

In `http` mode `PPTX_API_KEY` is ignored: the key belongs to the caller and is
read from the `x-api-key` header of each request. A request without that header
is rejected, so the deployed server holds no credential of its own.

## Run it over HTTP (Langflow, n8n, any remote MCP client)

The deployed server is at `https://mcp.maxflow.space/mcp`.

In Langflow, add an **MCP Tools** component, choose **Streamable HTTP/SSE**, and fill in:

| Field | Value |
|---|---|
| Name | `pptx` |
| Streamable HTTP/SSE URL | `https://mcp.maxflow.space/mcp` |
| Headers | key `x-api-key`, value your `pk_...` key |
| Environment Variables | leave empty |

Locally instead, `docker compose up mcp-server` serves the same thing at
`http://localhost:8765/mcp`.

Check it is alive with `curl -fsS https://mcp.maxflow.space/mcp/health`, which
prints `ok`.

## Run it over stdio (Claude Desktop, Claude Code)

This is the default transport; no extra configuration is needed.

```bash
cd mcp-server
pip install -r requirements.txt
WEB_URL=https://mcp.maxflow.space PPTX_API_KEY=pk_... python server.py
```

Client config for any MCP client that launches a stdio command:

```json
{
  "mcpServers": {
    "pptx-mcp": {
      "command": "python",
      "args": ["/absolute/path/to/mcp-server/server.py"],
      "env": {
        "WEB_URL": "https://mcp.maxflow.space",
        "PPTX_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add pptx-mcp \
  --env WEB_URL=https://mcp.maxflow.space \
  --env PPTX_API_KEY=pk_your_key_here \
  -- python /absolute/path/to/mcp-server/server.py
```
````

- [ ] **Step 4: Verify the docs describe what the code does**

Run: `grep -n "MCP_TRANSPORT\|x-api-key\|8765" mcp-server/README.md DEPLOY.md`
Expected: `MCP_TRANSPORT` and `x-api-key` appear in the README; `8765` appears in both files.

Run: `grep -n "MCP_TRANSPORT\|MCP_HOST\|MCP_PORT" mcp-server/server.py`
Expected: all three variables the README documents are read by the code.

- [ ] **Step 5: Commit**

```bash
git add DEPLOY.md mcp-server/README.md
git commit -m "docs: nginx ingress for /mcp/ and HTTP client setup

Document the location block that routes mcp.maxflow.space/mcp/ to the MCP
server while every other path keeps reaching the web app, including the
/api/mcp routes the MCP server itself calls. The three streaming
directives are not optional: nginx's defaults buffer events and cut the
connection at 60s. Also drop 'Caddy' from the section 5 heading, stale
since fd3d896."
```

---

## Manual acceptance (after all tasks)

1. Deploy, then from a machine that is not the VPS:
   `curl -fsS https://mcp.maxflow.space/mcp/health` → `ok`
2. Confirm the web app is unharmed: `curl -fsSI https://mcp.maxflow.space/login` → `200`
3. In Langflow, add the MCP component with the URL and `x-api-key` header above. The tool list must populate with five tools: `list_templates_tool`, `get_template_schema_tool`, `render_deck_tool`, `render_preview_tool`, `suggest_layout_tool`.
4. Remove the header in Langflow and re-run: the call must fail with `missing x-api-key header`, proving the endpoint is not open.
5. Confirm the existing stdio client still works unchanged.

---

## Out of scope

- Composition tools (`get_template_components`, `render_composition`, `validate_composition`) — they have no `/api/mcp/*` route in the web app yet.
- DNS and TLS provisioning; rise-gateway's own configuration management.
- Per-key rate limiting and usage quotas.
- OAuth or any authentication scheme beyond the existing API key.
