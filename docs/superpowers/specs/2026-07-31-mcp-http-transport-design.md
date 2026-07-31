# MCP Streamable HTTP Transport (Langflow ingress) — Design

**Date:** 2026-07-31
**Branch:** Max-dev
**Status:** Approved (design)

Make the pptx-mcp MCP server reachable over Streamable HTTP so Langflow's MCP
component ("Streamable HTTP/SSE" mode: Name / URL / Headers) can call it. Today
the server speaks stdio only and is not deployed.

Scope is the transport and its ingress. Tool behaviour is unchanged.

---

## Current state (verified)

- `mcp-server/server.py` ends in `build_server().run()` — FastMCP's default
  transport, i.e. **stdio**. There is no HTTP path.
- The API key is read from the `PPTX_API_KEY` environment variable inside
  `_headers()`, so it is fixed per process.
- `compose.prod.yml` sets `mcp-server.deploy.replicas: 0` — the service does not
  run in production at all.
- `mcp-server/requirements.txt` pins `fastmcp>=0.2.0`; the installed version is
  **3.2.4**, which supports `transport="http"`, `get_http_headers()`,
  `custom_route()` and `stateless_http`.
- `mcp.maxflow.space` already resolves to the **web app** (external nginx
  `rise-gateway` proxies it to `web:3000`). It serves `/api/mcp/...`, which is
  what this MCP server itself calls. The hostname is not free.
- The web app defines no root `/mcp` route (`/dashboard`, `/gallery`,
  `/settings`, `/templates`, `/login`, `/register`, `/api/*`, `/fonts` only), so
  the **path** `/mcp` on that host is free.

---

## Goal

`https://mcp.maxflow.space/mcp` speaks MCP Streamable HTTP. A Langflow MCP
component configured with that URL and an `x-api-key` header lists and calls the
five existing tools. stdio keeps working unchanged for existing clients.

---

## Decisions

| Question | Decision |
|---|---|
| Target | Public VPS (production) |
| Authentication | Per-request `x-api-key` header; no environment fallback in HTTP mode |
| Tool scope | The existing five tools only |
| Hostname | `mcp.maxflow.space`, MCP mounted at path `/mcp` |

---

## Architecture

One process, one file. `mcp-server/server.py` gains a transport switch; FastMCP
owns the ASGI server. Rejected alternatives: a separate `http_server.py`
(duplicates tool registration) and a hand-built Starlette app around
`http_app()` (only needed for extra routes, and `custom_route` already covers
the one route we want).

```
Langflow ──HTTPS──> rise-gateway (nginx, VPS host)
                      location = /mcp/health -> mcp-server:8765/health
                      location /mcp          -> mcp-server:8765
                      location /             -> web:3000
mcp-server ──HTTP──> web:3000/api/mcp/...   (docker network, x-api-key forwarded)
```

### Key resolution becomes mode-aware

`_headers()` today reads the environment unconditionally. It is replaced by a
resolver whose behaviour depends on the transport:

- **HTTP mode** — read `x-api-key` from the inbound request via
  `fastmcp.server.dependencies.get_http_headers()`. That helper lower-cases
  header names and its default exclude list does not contain `x-api-key`, so the
  header arrives intact. A missing or blank value raises
  `ToolError("missing x-api-key header")`. There is no environment fallback: on
  a public endpoint a fallback would silently serve anonymous callers under the
  operator's key.
- **stdio mode** — read `PPTX_API_KEY` from the environment, exactly as today,
  so existing stdio clients keep working.

The five proxy functions take the resolved key as an argument rather than
reading the environment themselves, which keeps them pure and directly testable.

### Entrypoint

Three environment variables, all with defaults that preserve today's behaviour:

| Var | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` | `8765` | HTTP bind port |

In HTTP mode the server runs with `stateless_http=True`. Streamable HTTP
otherwise keeps per-session state, which would require session affinity at the
proxy and would break when Langflow reconnects. Stateless mode removes that
coupling; the server holds no state of its own to lose.

### Health route

`@mcp.custom_route("/health", methods=["GET"])` returns a plain `200`. The MCP
endpoint itself rejects requests without MCP-shaped `Accept` headers, so a
container healthcheck or proxy probe needs a route that speaks plain HTTP.

### Upstream error mapping

The key is now supplied by the caller, so a wrong or revoked key is the most
likely failure. A `401` or `403` from the web app is translated to
`ToolError("invalid or revoked API key")` instead of surfacing a raw
`httpx.HTTPStatusError`. Other status codes keep today's `raise_for_status()`
behaviour.

---

## Deployment

**`mcp-server/requirements.txt`** — raise the floor to `fastmcp>=3.2`. The
current `>=0.2.0` permits versions with no Streamable HTTP transport and no
`get_http_headers`, so a clean image build could install a release that cannot
run this design at all.

**`mcp-server/Dockerfile`** — add `EXPOSE 8765`. `CMD` stays `python server.py`;
the transport is chosen by environment.

**`docker-compose.yml`** (development) — `mcp-server` gains
`MCP_TRANSPORT=http` and publishes `8765:8765` so a local Langflow can reach it
at `http://localhost:8765/mcp`.

**`compose.prod.yml`** — remove `deploy.replicas: 0`, add
`restart: unless-stopped` and a healthcheck against `/health`. No `ports:` entry:
rise-gateway reaches `mcp-server:8765` over the shared docker network, matching
the existing `!reset []` policy for every other service.

**rise-gateway (external, not in this repository)** — two `location` blocks
inside the existing `mcp.maxflow.space` server block. An exact-match `location
/mcp/health` routes the health probe; a prefix-match `location /mcp` routes all
MCP requests to the server, with no URI rewriting. `proxy_pass` uses a bare
upstream hostname (no `resolver`/`upstream` block), so nginx resolves
`mcp-server` when the config is **parsed**, not per request — the `mcp-server`
container must already be running before this config is applied, or `nginx -t`
fails with `host not found in upstream "mcp-server"` and a later plain nginx
restart would refuse to start and take the web app on that host down with it.
`DEPLOY.md` documents this as `§7b`, placed after the section that starts the
containers rather than immediately after the compose override.

Three directives are required or streaming responses stall, and a fourth
prevents a scheme downgrade on the app's own redirect:

```nginx
location = /mcp/health {
    proxy_pass http://mcp-server:8765/health;
}

location /mcp {
    proxy_pass http://mcp-server:8765;
    proxy_http_version 1.1;      # default 1.0 breaks chunked streaming
    proxy_buffering off;         # else SSE events queue in nginx's buffer
    proxy_read_timeout 3600s;    # else long renders are cut at the 60s default
    proxy_set_header Host $host;
    proxy_redirect http:// https://;   # a 307 from /mcp/ must not downgrade the scheme —
                                       # it would re-send x-api-key over plaintext port 80
}
```

`proxy_pass` without a trailing slash passes the request URI through
unchanged, so `/mcp/` reaches the app as `/mcp/` unrewritten and the app
answers with its own 307 redirect to `/mcp`. nginx does not follow or
re-route that redirect — it relays the response as-is. Without
`proxy_redirect`, the `Location` header on that 307 would be absolute with
scheme `http` (the app sees a plain-HTTP request from nginx, and the block
sets no `X-Forwarded-Proto`), and since a 307 preserves method, body, and
headers, a client following it would resend `x-api-key` in the clear on port
80. `proxy_redirect http:// https://;` rewrites that `Location` back to
`https://` before it reaches the client, so the retry lands on
`https://mcp.maxflow.space/mcp` over TLS, matched by this same prefix block.

Because this is a path on an existing host, no DNS record and no certificate
change are needed. The snippet and its verification step are documented in
`DEPLOY.md`; the repository cannot apply them, as rise-gateway lives outside it.

**Langflow component configuration:**

| Field | Value |
|---|---|
| Name | `pptx` |
| Streamable HTTP/SSE URL | `https://mcp.maxflow.space/mcp` |
| Headers | `x-api-key` → the `pk_...` key |
| Environment variables | none |

---

## Error handling

- Missing or blank `x-api-key` in HTTP mode → `ToolError("missing x-api-key
  header")`. The agent sees a directive it can act on rather than a transport
  error.
- Upstream `401`/`403` → `ToolError("invalid or revoked API key")`.
- Other upstream failures keep the current `raise_for_status()` behaviour, which
  FastMCP already reports as a tool error.
- An unknown `MCP_TRANSPORT` value fails at startup with a clear message rather
  than silently falling back to stdio, which would leave the port closed and the
  container healthy-looking.

---

## Security

The endpoint is internet-facing and has no rate limiting. The API key is the
only gate, so a leaked key lets a third party spend the owner's render quota.
Mitigation is key rotation through the existing API-keys page. Per-key rate
limiting is deliberately out of scope; it belongs with the web app's key model,
not the transport.

Requiring the header — rather than falling back to `PPTX_API_KEY` — is what
keeps the container from holding a credential that the URL alone would unlock.

---

## Testing

- **Key resolution** — HTTP mode extracts `x-api-key` from request headers;
  a missing or blank header raises; stdio mode reads the environment.
- **Proxy functions** — the existing five `respx` tests, updated to pass the key
  explicitly, still assert the `x-api-key` header reaches the web app.
- **Error mapping** — a mocked `401` produces the "invalid or revoked API key"
  message; a `500` still raises.
- **Transport selection** — `MCP_TRANSPORT` unset selects stdio; `http` selects
  HTTP with the configured host and port; an unknown value fails loudly.
- **HTTP surface** — `http_app()` builds, and `GET /health` returns `200`,
  exercised through an ASGI test client without binding a real port.

---

## Out of scope

- The composition tools (`get_template_components`, `render_composition`,
  `validate_composition`). They exist in the engine but have no `/api/mcp/*`
  route in the web app, so exposing them means building web routes first. That
  is its own spec.
- DNS and TLS provisioning, and any change to rise-gateway's own configuration
  management.
- Per-key rate limiting and usage quotas.
- OAuth or any authentication scheme beyond the existing API key.
