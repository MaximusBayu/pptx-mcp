# Component Catalog (Recompose R1) — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** R1 of the "component-kit recompose" initiative — letting the
agent recompose slides from the template's own parts (decor, fonts, pictures,
slot boxes) instead of only filling fixed slots. R1 is the **read side**: a
catalog of every reusable component the agent can see. R2 (composition spec +
assembler, the write side) and R3 (guardrails + agent guidance, folding in the
bullet fix and box-grow) are separate sub-projects.

## Goal

Expose, over MCP, a complete inventory of the template's components so the agent
can understand a deck and (in R2) recompose from its parts. Each component
carries a stable id, type, geometry, a best-effort style summary, its source
slide, and whether it is a fillable slot. Read-only; no rendering, no template
mutation.

## Background

- `extract_shapes(pptx_bytes)` (`shapes.py`) already walks every shape on every
  slide and emits `shape_id`, `name`, `type` (text/image/table), absolute
  `x/y/w/h`, and `bbox_pct`. But it has **no style** (font/fill/color), **no
  classification** (which shapes are fillable slots vs decor), and **no stable
  cross-slide id** — `shape_id` is unique within a slide but can repeat across
  slides.
- `get_schema(template)` (`schema.py`, MCP `get_template_schema`) exposes only
  **fillable slots** per slide_type, with Theme C geometry. It never surfaces
  decorative shapes or pictures the agent might reuse.
- The MCP tool wiring pattern (`mcp_server.py`): a `tool_<name>(storage, ...)`
  function calls an engine function on `storage.load(template_id)` (which
  returns a `Template` with `pptx_path`, `slide_types`, etc.), and a
  `@mcp.tool()` wrapper in `build_server` exposes it. `tool_get_template_schema`
  → `get_schema(storage.load(template_id))` is the model to mirror.
- A `Template` has `slide_types`; each `SlideType` has `source_slide_index` and
  `slots`; each `Slot` has `shape_id` and `id`. So a shape on slide `i` with
  shape id `s` is a fillable slot iff some slot has
  `(source_slide_index, shape_id) == (i, s)`.

## Decisions

1. **Full inventory** (user's choice). Every shape on every slide — slots,
   pictures, and all decor (boxes, lines, logos). R2 needs the full set to
   recompose; filtering now would hide reusable pieces.
2. **A new dedicated MCP tool `get_template_components`** (user's choice), not an
   extension of `get_template_schema`. The schema is slot-centric (per
   slide_type); the catalog is component-centric (per slide, all shapes) — a
   different data model. `get_schema` stays unchanged (back-compat).
3. **Compute from the stored pptx at call time** (like `get_schema`), not a
   persisted catalog. Single source of truth, always accurate, no migration.
4. **Stable composite id `"{slide_index}:{shape_id}"`.** Deterministic from the
   pptx, unique across the deck, and the handle R2 will use to place a
   component.
5. **Best-effort style summary** — `font_name`, `font_pt`, `font_color` (hex),
   `fill_color` (hex), each `null` when theme-inherited or unreadable. No
   gradient/image-fill decomposition; solid fore color or null.
6. **MCP only** (like Theme C geometry). The web has its own schema view; a web
   surface for the catalog is a separate follow-up.

## Components

### 1. `engine/src/pptx_mcp/catalog.py` (new)

```
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

_TEXT_SAMPLE_MAX = 200


def _component_type(shp) -> str:
    if getattr(shp, "has_table", False):
        return "table"
    if shp.shape_type == MSO_SHAPE_TYPE.PICTURE:
        return "image"
    if getattr(shp, "has_text_frame", False):
        return "text"
    return "other"


def _pct(value, total) -> float:
    return round(min(100.0, max(0.0, 100.0 * value / total)), 3) if total else 0.0


def _sample_text(shp) -> str:
    if not getattr(shp, "has_text_frame", False):
        return ""
    t = (shp.text_frame.text or "").strip()
    return t[: _TEXT_SAMPLE_MAX - 1] + "…" if len(t) > _TEXT_SAMPLE_MAX else t


def _hex_or_none(color) -> str | None:
    # color.rgb raises (TypeError/AttributeError) for theme/inherited colors.
    try:
        if color is not None and color.type is not None:
            return str(color.rgb)
    except (TypeError, AttributeError):
        pass
    return None


def _shape_style(shp) -> dict:
    style = {"font_name": None, "font_pt": None, "font_color": None, "fill_color": None}
    if getattr(shp, "has_text_frame", False):
        paras = shp.text_frame.paragraphs
        runs = paras[0].runs if paras else []
        if runs:
            f = runs[0].font
            style["font_name"] = f.name
            style["font_pt"] = f.size.pt if f.size is not None else None
            style["font_color"] = _hex_or_none(f.color)
    try:
        fill = shp.fill
        if fill.type is not None:
            style["fill_color"] = _hex_or_none(fill.fore_color)
    except (TypeError, AttributeError, ValueError):
        pass
    return style


def _component_dict(shp, slide_index, sw, sh, slot_id) -> dict:
    x = shp.left or 0; y = shp.top or 0
    w = shp.width or 0; h = shp.height or 0
    return {
        "component_id": f"{slide_index}:{shp.shape_id}",
        "source_slide": slide_index,
        "type": _component_type(shp),
        "fillable": slot_id is not None,
        "slot_id": slot_id,
        "name": shp.name or "",
        "geometry": {
            "bbox_pct": {"x": _pct(x, sw), "y": _pct(y, sh),
                         "w": _pct(w, sw), "h": _pct(h, sh)},
            "width_emu": int(w), "height_emu": int(h),
        },
        "style": _shape_style(shp),
        "text": _sample_text(shp),
    }


def get_catalog(template) -> dict:
    prs = Presentation(template.pptx_path)
    sw, sh = prs.slide_width, prs.slide_height
    fillable = {(st.source_slide_index, s.shape_id): s.id
                for st in template.slide_types for s in st.slots}
    components = []
    for i, slide in enumerate(prs.slides):
        for shp in slide.shapes:
            slot_id = fillable.get((i, shp.shape_id))
            components.append(_component_dict(shp, i, sw, sh, slot_id))
    return {"id": template.id, "name": template.name,
            "description": template.description, "components": components}
```

`get_catalog` reads from `template.pptx_path` (matching `get_schema`); no bytes
loading needed.

### 2. `engine/src/pptx_mcp/mcp_server.py`

Mirror `tool_get_template_schema`:

```
from .catalog import get_catalog   # add to imports

def tool_get_template_components(storage: Storage, template_id: str) -> dict:
    return get_catalog(storage.load(template_id))

# inside build_server:
@mcp.tool()
def get_template_components(template_id: str) -> dict:
    """List every reusable component (slots, pictures, decor) in a template,
    with geometry and style — the kit for composing slides."""
    return tool_get_template_components(storage, template_id)
```

## Data flow

```
Agent -> MCP get_template_components(template_id)
      -> tool_get_template_components -> get_catalog(storage.load(id))
      -> open template.pptx, build (source_slide, shape_id) -> slot_id map
      -> per slide, per shape: _component_dict (id, type, fillable, geometry, style, text)
      -> {id, name, description, components: [...]}
```

## Error handling / edges

- **Theme/inherited colors:** `color.rgb` raises for non-RGB colors;
  `_hex_or_none` swallows it and returns `null`. No crash.
- **Fill that has no solid fore color** (background, picture, gradient fill):
  the `try/except` around `shp.fill` returns `fill_color: null`.
- **Shape with no text frame** (picture, line, connector): `font_*` stay null;
  `type` is `image`/`other`; `text` is `""`.
- **Empty deck / slide with no shapes:** `components` is `[]` (or omits that
  slide's contribution). No crash.
- **Cross-slide duplicate shape_id:** disambiguated by the `"{slide}:{shape_id}"`
  composite id. Two decor boxes with the same shape_id on different slides get
  distinct component ids.
- **Back-compat:** purely additive — a new tool and a new module. `get_schema`,
  `extract_shapes`, render, and all existing tools are untouched.

## Security

- Read-only. No new input is parsed beyond an existing `template_id`; no
  rendering, no subprocess, no network, no template mutation. The catalog
  exposes only geometry/style/sample-text already present in the template the
  caller is authorized to read.

## Testing

- **engine `get_catalog`** (on the sample template): returns a `components`
  list covering all four sample slides; the title-slide title shape has
  `fillable: true` and `slot_id == "title"`; `component_id` matches
  `"{slide}:{shape_id}"`; each component has a `geometry.bbox_pct` with x/y/w/h
  and `width_emu`/`height_emu`; the table slide's table shape has
  `type == "table"`; the image slide's picture has `type == "image"`.
- **engine `_component_dict`**: with `slot_id=None` → `fillable` is `false` and
  `slot_id` is `null`; with `slot_id="title"` → `fillable` is `true`.
- **engine `_shape_style`** (best-effort): a run with an explicit font size/name
  → `font_pt`/`font_name` populated; a shape with a theme-inherited color →
  `font_color`/`fill_color` are `null` and no exception is raised.
- **engine `get_catalog` decor branch**: build a small pptx with one shape that
  is NOT in any slot map → that component has `fillable: false`. (The sample
  template maps every shape to a slot, so a standalone fixture exercises the
  decor path.)
- **engine `tool_get_template_components`**: returns the same catalog dict for a
  stored template id; the MCP `get_template_components` tool is registered.

## Out of scope

- R2: the composition spec form (`{component_id, target_bbox_pct, content?}`) and
  the cross-slide cloning assembler. R1 only lets the agent *see* components.
- R3: guardrails (bounding placements, on-brand enforcement), agent tool-doc
  guidance, the bullet/list fix, and box-grow.
- A web UI surface for the catalog (MCP only, like Theme C geometry).
- De-duplicating components that repeat across slides (the agent/R2 decides
  reuse; R1 reports every instance).
- Gradient/image-fill or multi-run style decomposition (best-effort solid color
  + first-run font only).
