# Dry-Run Validate + Geometry in Schema — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** Theme C of the VAPT-feedback sprint. Addresses feedback #6 and
#9 (no standalone validation / no content-size guidance before render) and #7
(schema doesn't expose usable dimensions).

## Goal

Tighten the author's feedback loop so problems surface **without** a full render:

1. **Dry-run validate (#6/#9).** A way to get `{errors, warnings}` — the same
   constraint errors *and* the same truncation warnings a render produces —
   without producing a `.pptx` download or LibreOffice preview. Available to MCP
   agents (who filed the feedback) and the web app.
2. **Geometry in schema (#7).** Each slot in the template schema carries its box
   dimensions, font size, and computed text capacity, so an author can predict
   whether content fits before sending it.

Both are read-only / non-destructive and reuse existing engine logic.

## Background

- `validate(deck_spec, template) -> list[SlotError]` (`validate.py`) returns
  **constraint errors only** (e.g. `missing_required_slot`). It does no filling,
  so it cannot produce truncation warnings.
- `render(deck_spec, template) -> tuple[bytes, list[dict]]` (`render.py`) raises
  `RenderRejected(errors)` when validation fails, otherwise fills every slot and
  returns the `.pptx` bytes plus a list of warning dicts (e.g. `text_truncated`).
  The fill itself is fast; the expensive step is the LibreOffice PNG preview,
  which `render` does **not** do (that lives in `preview.py`, called separately).
- Layering for the web path (verified):
  `web route -> web/src/lib/engine.ts -> engine-service (FastAPI) HTTP -> engine`.
  `render-deck` exists at every layer: `lib/engine.ts renderDeck` →
  `engine-service POST /render-deck` (form: `file`, `manifest`, `deck_spec`) →
  `render()`. There are **two** web render routes: `/api/templates/[id]/render`
  (session auth) and `/api/mcp/templates/[id]/render` (api-key auth).
- The MCP path is in-process: `mcp_server.py` calls engine functions directly
  (`tool_render_deck` → `render`).
- `get_schema(template) -> dict` (`schema.py`) serialises slot id/name/type/
  required/default/constraints. It does **not** open the pptx and exposes **no**
  geometry. `Slot` carries `shape_id` but no dimensions; geometry is not
  persisted — it lives in the template's `.pptx`.
- `estimate_max_chars(width_emu, height_emu, font_pt) -> (max_chars, lines)`
  (`autodetect.py`) is the shared capacity formula.

## Decisions

1. **Dry-run depth = errors + warnings via dry-fill** (user's choice). The
   dry-run runs the full fill pipeline to collect truncation warnings, then
   discards the bytes. Errors-only was rejected — it misses the truncation
   feedback authors most need.
2. **Reuse `render()` for the dry-run** rather than a separate no-save fill path.
   `render` already returns `(bytes, warnings)` and raises `RenderRejected` with
   errors; a thin `dry_run` wrapper catches that and drops the bytes. DRY; the
   buffer save it still does is negligible next to the avoided preview.
3. **Surfaces = MCP tool + web endpoint** (user's choice). One engine `dry_run`
   function backs a `validate_deck` MCP tool (in-process) and an engine-service
   `/validate-deck` route consumed by web `/api/templates/[id]/validate`
   (+ the api-key sibling), mirroring the render-deck pair exactly.
4. **Geometry computed at schema time, not persisted** (no `Slot` model change,
   no migration). `get_schema` opens the template `.pptx` once and reads each
   slot's shape. Single source of truth; always accurate.
5. **Geometry fields = `width_emu`, `height_emu`, `font_pt`, `capacity_chars`**
   (user's choice). `font_pt`/`capacity_chars` are text-only (null for image/
   table); `capacity_chars` directly answers "will my N-char value fit".

## Components

### C1 — Dry-run validate

**1. `engine/src/pptx_mcp/render.py` — `dry_run`**

```
def dry_run(deck_spec: dict, template: Template) -> dict:
    """Validate + fill without producing output; return errors and warnings."""
    try:
        _bytes, warnings = render(deck_spec, template)
    except RenderRejected as e:
        return {"errors": [err.to_dict() for err in e.errors], "warnings": []}
    return {"errors": [], "warnings": warnings}
```

`warnings` are already dicts (`render` returns `w.to_dict()` items).

**2. `engine/src/pptx_mcp/mcp_server.py` — `validate_deck` tool**

```
def tool_validate_deck(storage, template_id, deck_spec) -> dict:
    return dry_run(deck_spec, storage.load(template_id))

# inside build_server:
@mcp.tool()
def validate_deck(template_id: str, deck_spec: dict) -> dict:
    """Dry-run validate a deck: returns {errors, warnings} without rendering output."""
    return tool_validate_deck(storage, template_id, deck_spec)
```

Import `dry_run` alongside `render`.

**3. `engine-service/app.py` — `POST /validate-deck`**

Mirrors `/render-deck` (form: `file`, `manifest`, `deck_spec`) but returns the
`dry_run` dict as JSON and always 200 (errors are in the body, not an HTTP
error). Reuses the same `load_from_bytes` + temp-file cleanup pattern.

```
@app.post("/validate-deck")
async def validate_deck_route(file: UploadFile = File(...),
                              manifest: str = Form(...), deck_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        result = dry_run(json.loads(deck_spec), tpl)
    finally:
        if tpl is not None:
            try: os.unlink(tpl.pptx_path)
            except OSError: pass
    return JSONResponse(content=result)
```

Import `dry_run` from `pptx_mcp.render`.

**4. `web/src/lib/engine.ts` — `validateDeck`**

```
export async function validateDeck(pptx: Buffer, manifest: unknown, deckSpec: unknown):
  Promise<{ errors: unknown[]; warnings: unknown[] }> {
  const r = await fetch(`${BASE}/validate-deck`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (!r.ok) throw new Error(`validate-deck failed: ${r.status}`);
  return r.json();
}
```

(Match the exact `form(...)` / field-name convention `renderDeck` uses.)

**5. `web` routes — `POST /api/templates/[id]/validate` (+ `/api/mcp/...` sibling)**

Each mirrors its render counterpart's auth (session vs api-key), loads the
template pptx + manifest, calls `validateDeck`, and returns the `{errors,
warnings}` JSON. No persistence, no S3 writes.

### C2 — Geometry in schema

**6. `engine/src/pptx_mcp/schema.py` — geometry per slot**

`get_schema` opens the template once and resolves each slot's shape on its
slide-type's `source_slide_index`:

```
def get_schema(template: Template) -> dict:
    prs = Presentation(template.pptx_path)
    out_types = []
    for st in template.slide_types:
        slide = prs.slides[st.source_slide_index]
        slots = [_slot_dict(s) | {"geometry": _slot_geometry(slide, s)} for s in st.slots]
        out_types.append({"id": st.id, "name": st.name,
                          "description": st.description, "slots": slots})
    return {"id": template.id, "name": template.name,
            "description": template.description, "slide_types": out_types}


def _slot_geometry(slide, slot) -> dict | None:
    try:
        shape = find_shape(slide, slot.shape_id)
    except KeyError:
        return None
    w, h = shape.width or 0, shape.height or 0
    font_pt = capacity = None
    if slot.type == "text":
        font_pt = _shape_font_pt(shape)          # first-run pt or DEFAULT_FONT_PT
        capacity, _ = estimate_max_chars(w, h, font_pt)
    return {"width_emu": int(w), "height_emu": int(h),
            "font_pt": font_pt, "capacity_chars": capacity}
```

`_shape_font_pt(shape)` reads the first run's font size (pt) or falls back to
`DEFAULT_FONT_PT` — the same rule autodetect/filler use. `font_pt` and
`capacity_chars` are `null` for image/table slots. Geometry flows into the MCP
`get_template_schema` tool (which calls engine `get_schema`). **Note:** the web
schema view is built separately by `web/src/lib/schema.ts toAgentSchema` from the
DB `manifestJson` and does **not** call engine `get_schema`, so it does not
receive geometry — surfacing geometry in the web UI would be a separate
follow-up. The MCP agent (the consumer that filed #7) is covered.

## Data flow

```
Agent -> MCP validate_deck(template_id, deck_spec)
      -> dry_run -> render() [fill, drop bytes] -> {errors, warnings}

Web   -> POST /api/templates/[id]/validate
      -> lib/engine validateDeck -> engine-service POST /validate-deck
      -> dry_run -> {errors, warnings} (JSON)

Schema -> get_schema(template) opens template.pptx
       -> per slot: find shape on source slide -> {width_emu, height_emu, font_pt, capacity_chars}
```

## Error handling / edges

- **Invalid deck:** `dry_run` returns `{errors: [...], warnings: []}`; no bytes,
  no exception escapes to the caller.
- **Valid but overflowing deck:** `{errors: [], warnings: [text_truncated...]}`.
- **engine-service temp file:** `/validate-deck` unlinks the temp pptx in
  `finally`, same as `/render-deck`.
- **Schema, missing shape:** `_slot_geometry` catches `find_shape`'s `KeyError`
  → `geometry: null`; schema never crashes on a stale slot.
- **Schema, non-text slot:** `font_pt`/`capacity_chars` are `null`; `width_emu`/
  `height_emu` still populated.
- **Back-compat:** schema gains a `geometry` key per slot (additive); existing
  consumers ignoring it are unaffected. `validate`/`render` are unchanged.

## Testing

- **engine:** `dry_run` returns errors (and no warnings) for an invalid deck;
  returns `[]` errors + a `text_truncated` warning for a valid-but-overflowing
  deck; produces no file. `get_schema` includes `geometry` with a positive
  `capacity_chars` for a text slot, `null` font/capacity for an image/table
  slot, and `geometry: null` when a slot's shape is absent.
- **engine-service:** `POST /validate-deck` returns 200 with `{errors, warnings}`
  for both a valid and an invalid deck; the temp pptx is cleaned up.
- **web:** `/api/templates/[id]/validate` (and the `/api/mcp/...` sibling) return
  the `{errors, warnings}` JSON for an authorised request; unauthorised is
  rejected like the render routes. MCP `validate_deck` tool is registered.

## Out of scope

- Persisting geometry on `Slot` (computed at schema time instead).
- `suggest_layout` content-overflow hints (#9 stretch) — separate.
- Preview timeout (#8) — Theme E.
- API key bootstrap (#10) — Theme B.
- Constraint-cap relaxation (#1), repeatable flags (#3), agenda numbering (#5) —
  Theme D / separate.
