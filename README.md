# pptx-mcp

Template-driven PowerPoint generation for AI agents.

You upload a `.pptx`, tag the parts an agent may fill (title, body, table,
image), and save it as a **template**. An agent then fills those slots through
an API or an MCP tool and gets back a finished `.pptx` that keeps your design —
fonts, alignment, colors, layout.

## Architecture — two pieces

```
            YOUR HOST (the "brain")                 AGENT'S MACHINE
  ┌─────────────────────────────────────┐        ┌────────────────────┐
  │ web (Next.js)  auth · templates · API│  HTTP  │ mcp-server (stdio) │
  │ engine-service (python-pptx render)  │◄───────│  thin proxy        │
  │ Postgres · MinIO (S3)                │  x-api │  WEB_URL + API key │
  └─────────────────────────────────────┘  -key  └────────────────────┘
        docker compose up                          run by Claude/agent
```

- **The brain** = `web` + `engine-service` + Postgres + MinIO. One host runs it
  (via `docker compose`). It owns login, your templates, storage, and rendering.
- **The MCP server** = a small stdio proxy. It holds **no** data — it forwards
  tool calls to the brain's `/api/mcp/...` using an API key. Run it on whatever
  machine your agent lives on.

You do **not** install the whole stack on the agent's machine — only
`mcp-server` + an API key.

---

## Part 1 — Run the brain (host machine, once)

Full detail in [RUN.md](RUN.md). Short version:

```bash
cp .env.example .env          # set AUTH_SECRET (openssl rand -hex 32)
# first run only: generate the initial Prisma migration (see RUN.md §3)
docker compose build
docker compose up -d
```

| Service        | URL                     |
|----------------|-------------------------|
| web            | http://localhost:3000   |
| engine-service | http://localhost:8000   |
| MinIO console  | http://localhost:9001   |

If the agent runs on a **different machine**, the brain must be reachable from
there: use the host's LAN IP or a domain (e.g. `http://192.168.1.20:3000` or
`https://pptx.example.com`), not `localhost`. Also set `S3_PUBLIC_ENDPOINT` in
`.env` to an address the agent can reach, or download links won't open
(see [RUN.md](RUN.md) → "S3 / object storage").

---

## Part 2 — Make a template + API key (web UI)

1. Open the web URL → register / log in.
2. **New template** → upload a `.pptx`. The editor auto-detects shapes and
   pre-tags likely slots.
3. For each slot set a **Slot id** (the name the agent fills), a **Type**
   (text / table / image), and any limits. Drag boxes to reposition.
4. **Save template.**
5. **Settings → API keys → Create**. Copy the `pk_...` key (shown once).

---

## Part 3 — Install the MCP server (agent's machine)

The MCP server needs two env vars:

| Var            | Meaning                       | Example                          |
|----------------|-------------------------------|----------------------------------|
| `WEB_URL`      | Base URL of the brain         | `http://192.168.1.20:3000`       |
| `PPTX_API_KEY` | Your API key                  | `pk_ab12...`                     |

### Get the code on that machine

```bash
git clone <this-repo>            # or copy just the mcp-server/ folder
cd pptx-mcp/mcp-server
pip install -r requirements.txt
```

### Wire it into your MCP client

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pptx-mcp": {
      "command": "python",
      "args": ["/absolute/path/to/pptx-mcp/mcp-server/server.py"],
      "env": {
        "WEB_URL": "http://192.168.1.20:3000",
        "PPTX_API_KEY": "pk_your_key_here"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add pptx-mcp \
  --env WEB_URL=http://192.168.1.20:3000 \
  --env PPTX_API_KEY=pk_your_key_here \
  -- python /absolute/path/to/pptx-mcp/mcp-server/server.py
```

**Docker (no Python on the client):**

```bash
docker build -f mcp-server/Dockerfile -t pptx-mcp-server .
# then in the client config use:
#   command: docker
#   args: ["run","--rm","-i","-e","WEB_URL=...","-e","PPTX_API_KEY=...","pptx-mcp-server"]
```

Restart the client. The `pptx-mcp` tools appear.

---

## Part 4 — Agent flow

1. `list_templates_tool` → pick a `template_id`.
2. `get_template_schema_tool(template_id)` → read slot ids / types.
3. `render_deck_tool(template_id, deck_spec)` → `{ validation, download_url }`.
4. Optional: `render_preview_tool` → PNGs to eyeball first.

`deck_spec`:

```json
{
  "slides": [
    { "slide_type": "slide_0",
      "slots": {
        "title": "Q3 Results",
        "body": "Revenue up 18%.",
        "table_1": [["Region", "Rev"], ["EU", "1.2M"]],
        "image_1": "https://example.com/chart.png"
      } }
  ]
}
```

Slot values: **text** = string · **table** = `list[list]` · **image** = URL or
`data:image/png;base64,…`. Filled text keeps the template's font/alignment;
images fit centered; overflow shrinks then sentence-truncates (reported in
`warnings`). If `validation` is non-empty the deck was rejected — fix the listed
slots and retry.

---

## Without MCP (plain HTTP)

Same thing over HTTP with the `x-api-key` header:

```bash
curl -X POST $WEB_URL/api/mcp/templates/$TEMPLATE_ID/render \
  -H "x-api-key: $PPTX_API_KEY" -H "Content-Type: application/json" \
  -d '{ "deck_spec": { "slides": [ { "slide_type": "slide_0",
        "slots": { "title": "Hi" } } ] } }'
```

Response: `{ validation, download_url, warnings }`.

---

## Docs

- [RUN.md](RUN.md) — running the stack, migrations, production deployment.
- [mcp-server/README.md](mcp-server/README.md) — MCP server details + tools.
- `docs/superpowers/specs` / `docs/superpowers/plans` — design + build history.
