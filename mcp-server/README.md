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

The server reads two environment variables:

| Var            | Meaning                                   | Example                     |
|----------------|-------------------------------------------|-----------------------------|
| `WEB_URL`      | Base URL of the web app                   | `http://localhost:3000`     |
| `PPTX_API_KEY` | Your API key (`pk_...`)                   | `pk_ab12...`                |

> Inside Docker Compose the default `WEB_URL` is `http://web:3000`. From an
> agent running on your host, point it at `http://localhost:3000` (or your
> deployed URL).

## Tools exposed

| Tool                      | Args                          | Returns                              |
|---------------------------|-------------------------------|--------------------------------------|
| `list_templates_tool`     | —                             | templates available to the key       |
| `get_template_schema_tool`| `template_id`                 | slot schema (slide_types[].slots[])  |
| `render_deck_tool`        | `template_id`, `deck_spec`    | `{ validation, download_url }`        |
| `render_preview_tool`     | `template_id`, `deck_spec`    | `{ validation, previews[] }` (PNG)    |

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

## Run it from an MCP client

The server speaks MCP over stdio. Run it directly with Python or via the
Docker image.

### Option A — local Python

```bash
cd mcp-server
pip install -r requirements.txt
WEB_URL=http://localhost:3000 PPTX_API_KEY=pk_... python server.py
```

Client config (e.g. Claude Desktop `claude_desktop_config.json`, or any MCP
client that launches a stdio command):

```json
{
  "mcpServers": {
    "pptx-mcp": {
      "command": "python",
      "args": ["/absolute/path/to/mcp-server/server.py"],
      "env": {
        "WEB_URL": "http://localhost:3000",
        "PPTX_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

### Option B — Docker image

```bash
docker build -f mcp-server/Dockerfile -t pptx-mcp-server .
```

```json
{
  "mcpServers": {
    "pptx-mcp": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "WEB_URL=http://host.docker.internal:3000",
        "-e", "PPTX_API_KEY=pk_your_key_here",
        "pptx-mcp-server"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add pptx-mcp \
  --env WEB_URL=http://localhost:3000 \
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
