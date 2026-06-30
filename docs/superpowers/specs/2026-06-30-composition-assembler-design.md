# Composition Assembler (R2) — Design

**Date:** 2026-06-30
**Status:** Approved
**Sub-project:** R2 of the component-kit recompose initiative (R1 Component Catalog → **R2 composition spec + cross-slide assembler** → R3 guardrails + agent guidance).

## Goal

Give the agent a write-side path to **compose a new slide from catalog components**: pick a base slide as a canvas, then place chosen components (from any slide in the template) at chosen positions and fill them with content. This is the direct answer to "the agent can't replicate a slide that features bullet points — it just skips them": the bullet-list component on slide N can now be cloned onto a different slide.

R2 ships the engine, an MCP tool pair, and an engine-service endpoint pair. No web UI (deferred).

## Background / current state

- `deck_spec = {"slides":[{"slide_type","slots":{slot_id:value}}]}`. `assemble(order, template)` clones **whole base slides** by `source_slide_index`, then `render()` fills predefined slots in place. Layout is frozen — you pick a whole slide and fill its slots; you cannot rearrange components across slides.
- `assembler._duplicate_slide` already solves the hard XML problem for a *whole slide*: deep-copy each shape element + copy/remap the slide part's relationships (`r:embed`/`r:link`/`r:id`) so images/charts survive a save→reopen. R2 needs the same trick at **per-shape** granularity.
- R1's catalog gives every shape a stable `component_id = "{slide_index}:{shape_id}"`, a `type` (text/image/table/other), `fillable`/`slot_id`, geometry (`bbox_pct`), and style. R2 consumes those ids.
- `move.py` establishes the `bbox_pct = {x,y,w,h}` → EMU convention: `int(slide_dim * pct / 100)`. Reused verbatim for placement geometry.
- `filler.py` fills by type: `_fill_text(shape, slot, value)`, `_fill_table(shape, rows)`, `_fill_image(slide, shape, value, fit)`.

## Design decisions (resolved during brainstorming)

1. **Additive.** New composition spec + new `render_composition` tool + `/compose` endpoint + new engine path. Existing `render_deck`/`deck_spec` untouched.
2. **Canvas model = base slide as canvas.** Each composed slide names a source base slide; it inherits that slide's background/theme/layout/master.
3. **Manifest model (drop unmentioned).** The canvas's **foreground shapes are NOT carried over**. Only background/theme/layout/master are inherited. Every foreground shape on the output slide is an explicit placement that clones a catalog component. This is the full-recompose end of the design space (resolves the R3 tension toward maximum control).
4. **Surface = engine + MCP + engine-service endpoint only.** No web UI in R2.
5. **Clone strategy = per-shape clone + per-shape rel remap** (generalizes `_duplicate_slide` to one shape; no wasted/duplicated rels).
6. **bbox optional** → absent keeps the component's source geometry. **content optional** → absent clones the shape verbatim (keeps sample text/look; the decor case); present fills by component type.
7. **Minimal validation in R2.** Overlap detection, font/color lock, off-slide clamping are deferred to R3.

## Composition spec format

```json
{
  "slides": [
    {
      "canvas": 2,
      "placements": [
        { "component_id": "2:5", "content": "New Title" },
        { "component_id": "2:7", "bbox_pct": {"x":6,"y":22,"w":60,"h":64} },
        { "component_id": "5:9", "bbox_pct": {"x":8,"y":24,"w":55,"h":60},
          "content": ["point one","point two","point three"] }
      ]
    }
  ]
}
```

- `canvas` (int, **required**): source-slide index supplying background/theme/layout/master. Foreground shapes not carried.
- `placements` (list, **ordered**): paint order = list order; later placements render on top (z-order).
  - `component_id` (str, **required**): `"{slide_index}:{shape_id}"` from the catalog.
  - `bbox_pct` (object, optional): `{x,y,w,h}` in slide-percent. Absent → component keeps its source geometry.
  - `content` (optional): absent → shape cloned verbatim (keeps sample content). Present → filled by component type:
    - text → `str`
    - table → `list[list]`
    - image → URL or base64 `str`
    - a placement on an `other`-type component with `content` set → `wrong_type` (only text/table/image are fillable).

## Module architecture

```
engine/src/pptx_mcp/
  composer.py        NEW  compose() + validate_composition() + ComposeRejected
  assembler.py       MOD  extract _remap_rels(src_part, dest_part, element)
                          → shared by _duplicate_slide AND composer
  filler.py          MOD  extract fill_shape(slide, shape, kind, value, constraints)
                          → shared by fill_slot AND composer
  mcp_server.py      MOD  tool_render_composition / tool_validate_composition + @mcp.tool registrations
engine-service/app.py     MOD  POST /compose  +  POST /validate-composition
```

### Boundaries

- `composer` owns slide construction and the placement loop. It delegates:
  - rel remapping → `assembler._remap_rels`
  - geometry → the `move.py` bbox→EMU formula (4 lines, inlined)
  - content → `filler.fill_shape`
- `assembler._remap_rels(src_part, dest_part, element)`: copy every relationship that `element` references (`r:embed`/`r:link`/`r:id`), skipping slide-layout rels, into `dest_part`; rewrite the ids on `element` in place. `_duplicate_slide` is refactored to call it (regression-tested).
- `filler.fill_shape(slide, shape, kind, value, constraints)`: dispatch on `kind`:
  - `"text"` → existing `_fill_text` path, taking a `Constraints` directly (text fill currently reads `slot.constraints`; refactor so it reads a `Constraints` object the caller supplies — `fill_slot` passes `slot.constraints`, `composer` passes the registered slot's constraints if the component is a slot, else `Constraints()`).
  - `"table"` → `_fill_table(shape, value)` (already slot-free).
  - `"image"` → `_fill_image(slide, shape, value, constraints.fit)`.
  - returns the same `list[SlotError]` warnings.

## compose() flow

`compose(composition_spec, template) -> tuple[bytes, list[dict]]` — mirrors `render()`'s return shape.

1. Validate first (`validate_composition`); raise `ComposeRejected(errors)` if any. (`ComposeRejected` parallels `RenderRejected` — carries `errors: list[SlotError]`.)
2. `prs = Presentation(template.pptx_path)`; capture `original_count = len(prs.slides)` and `sw, sh = prs.slide_width, prs.slide_height`.
3. For each output-slide spec:
   1. `canvas_slide = prs.slides[spec["canvas"]]`.
   2. `dest = prs.slides.add_slide(canvas_slide.slide_layout)` — inherits master/layout/theme.
   3. If `canvas_slide` has a slide-level background override (`<p:cSld>/<p:bg>`), deep-copy that element into `dest`'s `<p:cSld>`; else the layout/master background shows through.
   4. Remove placeholder shapes `add_slide` injected from the layout (same loop as `_duplicate_slide`).
   5. For each placement in order:
      - parse `component_id` → `(src_idx, shape_id)`; `src_shape = find_shape(prs.slides[src_idx], shape_id)`.
      - `el = copy.deepcopy(src_shape._element)`; `dest.shapes._spTree.append(el)`.
      - `_remap_rels(prs.slides[src_idx].part, dest.part, el)`.
      - take the just-appended shape as `dest.shapes[-1]` (located by identity, not shape_id — see collision note); if `bbox_pct` given set `left/top/width/height` via `int(sw*pct/100)` etc.
      - if `content` given: `kind = component_type(shape)`; `constraints =` registered slot's constraints if `(src_idx, shape_id)` maps to a slot else `Constraints()`; `warnings += fill_shape(dest, shape, kind, content, constraints)`.
4. Drop the original base slides from the package (reuse `assemble`'s sldId-removal + `drop_rel` sequence over the first `original_count` slides).
5. Each warning's `slide_index` is reassigned to its output-slide index (as `render()` does). Save to bytes; return `(bytes, warnings)`.

### Shape-id collision note

`shape_id` is unique per slide, not across a package. Locate the appended shape by **identity** — `dest.shapes[-1]` immediately after the append, before the next placement — rather than re-searching by id. The flow appends and positions one placement fully before the next, so "last appended shape" is unambiguous.

## Background & theme interaction

**The canvas background always wins.** A shape's backdrop is a slide-level `<p:bg>` element, not part of the shape's XML, and `_remap_rels` only copies relationships the shape element itself references. Cloning a component therefore brings the shape but **never its source slide's background**. Output slide built on `canvas: 2` shows slide 2's background regardless of where each placed component came from. To reuse another slide's backdrop, name that slide as the `canvas`.

This is correct and intended (the manifest model), but it creates a **legibility risk** when a component is cloned onto a canvas with a different background:

- **Explicit-color text.** Text with an explicit RGB color (e.g. white, chosen for a dark source slide) keeps that color on a light canvas → can become invisible. The color stays; the backdrop does not follow.
- **Theme-color text.** Text using a theme color (e.g. `accent1`) re-resolves against the canvas's master/theme. Single-master template → unchanged. Multi-master template → the color may shift.

Neither case breaks rendering — both are quality/contrast issues. **Deferred to R3 guardrails** (font/color lock + contrast check): R3 may re-resolve a cloned component's font color to the canvas theme or emit a `low_contrast` warning when a placed text component lands on a poorly-contrasting canvas background. Computing a slide's effective background (image / gradient / theme fill) is non-trivial and correctly belongs to R3. R2 places mechanically and does not inspect contrast.

## Validation (`validate_composition`)

`validate_composition(composition_spec, template) -> list[SlotError]`. Reuses `SlotError`. Per slide (index `i`) / placement:

| Check | Code |
|---|---|
| `canvas` present and in `range(len(base slides))` | `unknown_canvas` |
| `component_id` matches `int:int`, slide index in range, shape_id on that slide | `unknown_component` |
| `content` type matches component type (text→str, table→list[list], image→str/bytes); content on `other` | `wrong_type` |
| `bbox_pct` (if present) has numeric x,y,w,h; each in 0–100; w>0; h>0 | `bad_bbox` |

`SlotError.slide_index` = output-slide index `i`; `slot_id` = the `component_id` for placement-scoped errors, else `None`.

Deferred to R3: overlap detection, font/color lock, off-slide clamping.

## Surface contract

### MCP (`mcp_server.py`)

- `render_composition(template_id, composition_spec) -> {"validation": [...], "download_url": str|None, "warnings": [...]}` — on reject, `{"validation": errors, "download_url": None}`. Mirrors `render_deck`.
- `validate_composition(template_id, composition_spec) -> {"errors": [...], "warnings": [...]}`. Mirrors `validate_deck` dry-run.

### Engine-service (`app.py`)

- `POST /compose` — form `file` + `manifest` + `composition_spec`. Returns `.pptx` bytes (`media_type=_PPTX`, `X-Overflow-Warnings` header) on success; `422 {"validation": [...]}` on `ComposeRejected`. Temp pptx unlinked in `finally`. Mirrors `/render-deck`.
- `POST /validate-composition` — form `file` + `manifest` + `composition_spec`. Returns `{"errors","warnings"}`. Mirrors `/validate-deck`.

### Web

None in R2.

## Testing

- `engine/tests/test_composer.py`:
  - single placement clones + places a component onto a canvas;
  - cross-slide **image** placement keeps the picture after save→reopen (rel survived);
  - manifest model: a canvas foreground shape not in any placement is absent from output;
  - verbatim clone (no `content`) keeps the component's sample text;
  - `content` fill truncates oversized text and emits a `text_truncated` warning;
  - z-order: with two overlapping placements, the later one is last in `spTree`;
  - `bbox_pct` repositions the placed shape to the target geometry.
- `engine/tests/test_validate_composition.py`: one case per reject code (`unknown_canvas`, `unknown_component`, `wrong_type`, `bad_bbox`).
- `engine/tests/test_assembler.py`: `_remap_rels` extraction does not regress `_duplicate_slide` (existing whole-slide image round-trip still passes).
- `engine-service/tests/test_endpoints.py`: `/compose` returns pptx bytes for a valid spec and 422 for an invalid one; `/validate-composition` returns the error list.
- `engine/tests/test_mcp_server.py`: `render_composition` returns a download_url for a valid spec; `validate_composition` returns errors for an invalid one.

## Out of scope (later sub-projects)

- Guardrails: overlap detection, font/color lock to template, off-slide clamping (R3).
- The bullet/list slot fix and decorative-box-grows-with-text (R3).
- Agent guidance: tool docs + catalog descriptions that teach composition (R3).
- Web composition UI (visual drag/drop editor) — separate future project.
