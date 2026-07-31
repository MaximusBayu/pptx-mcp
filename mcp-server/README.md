# pptx-mcp MCP server

A thin [MCP](https://modelcontextprotocol.io) server that lets an AI agent
fill your saved templates. It is a stateless proxy: every tool call hits the
web app's internal API (`/api/mcp/...`) using your API key. It holds no
database or storage of its own.

## Prerequisites

1. The web app is running and reachable (locally via `docker compose up`, or a
   deployed URL).
2. You created a template and tagged at least one slot.
3. You created an API key on the **API keys** page (`pk_...`). Copy it — it is
   shown once.

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

## Tools exposed

| Tool                      | Args                          | Returns                              |
|---------------------------|-------------------------------|--------------------------------------|
| `list_templates_tool`     | —                             | templates available to the key       |
| `get_template_schema_tool`| `template_id`                 | slot schema (slide_types[].slots[])  |
| `render_deck_tool`        | `template_id`, `deck_spec`    | `{ validation, download_url, warnings }` |
| `render_preview_tool`     | `template_id`, `deck_spec`    | `{ validation, previews[] }` (PNG)    |
| `suggest_layout_tool`     | `template_id`, `content`, `used` (optional) | ranked candidates: `slide_type`, `name`, `repeatable`, `score`, `reason` |

`deck_spec` shape:

```json
{
  "slides": [
    { "slide_type": "slide_0", "slots": { "title": "Q3 Review", "body": "…" } }
  ]
}
```

Get the exact `slide_type` ids and slot ids from `get_template_schema_tool`,
or from the template's **Use** page in the web UI.

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

## Typical agent flow

1. `list_templates_tool` → pick a `template_id`.
2. `get_template_schema_tool(template_id)` → read the slot ids/types.
3. `render_deck_tool(template_id, deck_spec)` → get `download_url`.
4. (Optional) `render_preview_tool` first to eyeball PNGs before rendering.

If `validation` is non-empty the deck was rejected; fix the listed slots and
retry. The `download_url` is a presigned link — see `RUN.md` for making it
reachable outside the Docker network.
