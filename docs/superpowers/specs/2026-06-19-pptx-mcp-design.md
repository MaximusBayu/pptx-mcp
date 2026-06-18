# Technical Spec — Template-Driven PPTX MCP (v1)

**Date:** 2026-06-19
**Status:** Draft (approved design)
**Scope:** v1 = render engine + MCP server + CLI registration helper. Website/SaaS = phase 2 (out of scope).
**Companion:** see [PRD](2026-06-19-pptx-mcp-prd.md).

## 1. Overview

A Python render engine fills professionally-designed PowerPoint slide kits with agent-supplied content into named, typed slots. An MCP server (FastMCP) exposes this to AI agents through a minimal, stateless tool surface. The agent supplies only content; the template owns all design.

```
agent ──MCP──▶ MCP server ──▶ render engine ──▶ python-pptx ──▶ .pptx
                  │                  │
                  │                  └──▶ LibreOffice headless ──▶ preview PNGs
                  └──▶ file server (token links) ──▶ end user download
```

## 2. Components

Each component is independently testable with a defined interface.

### 2.1 Template Package (the contract)
A template is a directory:
```
my-template/
  base.pptx        # the slide kit: each slide = one slide type, designed in PowerPoint
  manifest.json    # machine contract mapping slide types + slots to shapes
```

`manifest.json` schema:
```json
{
  "template": { "id": "pitch-v1", "name": "Pitch Deck", "description": "..." },
  "slide_types": [
    {
      "id": "title",
      "name": "Title Slide",
      "description": "Opening slide with title + subtitle",
      "source_slide_index": 0,
      "slots": [
        {
          "id": "title",
          "name": "Main title",
          "type": "text",
          "target": { "shape_id": 2 },
          "required": true,
          "default": null,
          "constraints": { "max_chars": 60, "max_lines": 2, "shrink_floor_pt": 28 }
        }
      ]
    }
  ]
}
```

Slot `type` ∈ `text` | `table` | `image`. Constraints by type:
- `text`: `max_chars`, `max_lines`, `shrink_floor_pt`
- `table`: `max_rows`, `max_cols`
- `image`: `fit` ∈ `cover` | `contain`

`target.shape_id` pins the python-pptx shape on `source_slide_index`. Shape id is stable in the saved `.pptx`; the CLI reads it directly from the file, so authoring and render agree.

### 2.2 Render engine (`engine/`) — pure Python lib, no MCP/web coupling
Interface:
- `load_template(path) -> Template` — parse manifest, open base.pptx, validate manifest against actual shapes (fail fast if a `target.shape_id` is missing).
- `get_schema(template) -> dict` — agent-facing JSON: slide types, slots, types, constraints, required/defaults. No internal shape ids leaked.
- `validate(deck_spec, template) -> list[SlotError]` — structural + overflow checks. Empty list = valid.
- `render(deck_spec, template) -> bytes` — assemble + fill, return `.pptx` bytes.
- `preview(pptx_bytes) -> list[bytes]` — one PNG per slide via LibreOffice headless `--convert-to`.

`deck_spec` schema:
```json
{
  "slides": [
    { "slide_type": "title", "slots": { "title": "Acme Q3", "subtitle": "..." } },
    { "slide_type": "bullet", "slots": { "heading": "...", "bullets": ["a","b"] } }
  ]
}
```

### 2.3 Deck assembly (the hard part)
python-pptx cannot copy a slide. Engine assembles the agent's chosen order by:
1. Start from a copy of `base.pptx` (carries theme, masters, layouts).
2. For each entry in `deck_spec.slides`, deep-copy the XML of `base.pptx` slide at `source_slide_index` plus its relationships (images, layout ref) into a new slide appended to the output.
3. Delete the original kit slides from the output so only assembled slides remain.
4. Fill each new slide's slots by `shape_id`.

This XML/relationship deep-copy is isolated in one module (`assembler.py`) and is the #1 risk — covered by dedicated tests reading the output back.

### 2.4 Fill logic (`filler.py`)
Per slot type, by `shape_id`:
- **text** — set run text, preserve template run/paragraph formatting (do not overwrite font/color/size unless auto-shrink fires). Rich text = list of paragraphs/bullets.
- **table** — write rows/cols into the existing table shape, reuse its table style.
- **image** — replace the picture in the existing image placeholder; apply `fit` (cover = crop to fill frame; contain = letterbox within frame). Never resize/move the frame.

### 2.5 MCP server (`mcp_server/`) — FastMCP, stateless
Tools:
- `list_templates() -> [{id, name, description, slide_types: [{id, name, description}]}]`
- `get_template_schema(template_id) -> schema` (from `get_schema`)
- `render_preview(template_id, deck_spec) -> {validation: [...], previews: [png_url...]}` — validates + renders + previews, stores PNGs, returns links. No final `.pptx` committed.
- `render_deck(template_id, deck_spec) -> {validation: [...], download_url | null}` — validates; if valid, renders + stores `.pptx`, returns token link; if invalid, `download_url=null` + errors.

### 2.6 File server (`fileserver/`) — small FastAPI app
- Serves stored `.pptx` and preview PNGs under tokenized, short-lived URLs (TTL configurable, default 1h).
- In-memory or on-disk token→path map. v1 single-process is fine.

### 2.7 CLI registration helper (`cli/`)
- `pptx-mcp init-template <base.pptx> -o manifest.json`
- Reads each slide, lists every shape `(slide_index, shape_id, shape_name, shape_type)`.
- Emits a `manifest.json` scaffold (one slide_type per slide, one slot stub per fillable shape, constraint placeholders) for the author to edit.
- This is the v1 stand-in for the phase-2 web tag editor; both produce the same `manifest.json`.

## 3. Data Flow

1. Agent → `list_templates` → picks a template.
2. Agent → `get_template_schema` → learns slide types + slots + constraints.
3. Agent builds `deck_spec` (orders/repeats slide types, fills slots).
4. (optional) Agent → `render_preview` → eyeballs PNGs + reads validation; revises.
5. Agent → `render_deck` → gets `download_url`.
6. End user downloads `.pptx`.

## 4. Error Handling

All errors structured: `{ slide_index, slot_id, code, message }`.
- `unknown_slide_type` — lists available slide types.
- `unknown_slot` / `missing_required_slot` — lists expected slots.
- `wrong_type` — slot expected text/table/image, got other.
- **Overflow (text):** content over `max_chars`/`max_lines` → attempt auto-shrink down to `shrink_floor_pt`. If it fits at/above floor → render shrunk (report `warning`). If still overflowing at floor → `reject` with `text_overflow` and the measured vs allowed.
- **Overflow (table):** over `max_rows`/`max_cols` → `table_overflow`, reject.
- **Image:** wrong aspect handled by `fit` (never an error); unreadable/missing image bytes → `image_invalid`, reject.
- Engine never silently clips or overlaps. Either it fits (possibly shrunk) or it rejects.

## 5. Testing

- **Unit** — `validate` against every constraint (under/at/over limits); schema generation hides internal shape ids; manifest-vs-pptx validation fails fast on missing shapes.
- **Assembler** — assemble a 3-slide deck from a 2-type kit (incl. a repeated type), reopen output with python-pptx, assert slide count/order and that theme/masters survive.
- **Filler** — render a known deck_spec, reopen, assert each slot's text/table/image landed in the right shape; assert untouched formatting preserved.
- **Overflow** — text just over limit auto-shrinks; way over rejects; table over rows rejects.
- **MCP contract** — each tool returns declared shape; `render_deck` with invalid spec returns `download_url=null` + errors.
- **Preview smoke** — gated on LibreOffice present; renders ≥1 PNG of nonzero size.

## 6. Tech Stack

- Engine + MCP + CLI + file server: **Python** (python-pptx, FastMCP, FastAPI).
- Preview: **LibreOffice headless**.
- Phase-2 website: **Next.js full-stack (TS)** — out of scope here.

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| python-pptx slide copy unsupported | Isolated `assembler.py` w/ XML deep-copy + read-back tests; spike this first |
| LibreOffice dependency | Document install; containerize in phase 2; preview is optional path |
| Shape-id drift author↔render | CLI reads ids straight from the `.pptx`; engine fails fast if id missing |
| Auto-shrink unreadable | Hard `shrink_floor_pt` floor; reject below it |

## 8. Out of Scope (v1)

Charts; multi-tenant auth/accounts; web upload + tag editor + light refine; Postgres/object storage; per-user API-key scoping. All deferred to phase 2.
