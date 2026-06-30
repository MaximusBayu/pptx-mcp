# Composition Assembler (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent compose a new slide from catalog components — pick a base slide as canvas, clone chosen components (from any slide) onto it at chosen positions, and fill content.

**Architecture:** New `composer.py` builds each output slide from the canvas slide's layout (inheriting background/theme/master), strips its foreground, then per placement deep-copies a source shape's XML, remaps that shape's rels into the dest part, sets geometry, and fills content by type. Reuses three pieces of existing code: `assembler`'s rel-remap + base-slide-drop logic, `move.py`'s bbox→EMU formula, and `filler`'s fill-by-type. Additive — `render_deck`/`deck_spec` untouched.

**Tech Stack:** Python, python-pptx, pytest; FastMCP (mcp_server), FastAPI (engine-service).

## Global Constraints

- Additive only: do not modify `render()`, `deck_spec`, or the existing `render_deck`/`validate_deck` tools/endpoints.
- `component_id` format is `"{slide_index}:{shape_id}"` (the R1 catalog format).
- `bbox_pct` is `{x,y,w,h}` in slide-percent; EMU = `int(slide_dim * pct / 100.0)` (matches `move.py`).
- Composition spec shape: `{"slides":[{"canvas": int, "placements":[{"component_id": str, "bbox_pct"?: {x,y,w,h}, "content"?: str|list[list]|bytes}]}]}`.
- Canvas background always wins; cloned shapes never carry their source slide's background. No contrast/font-lock work in R2 (that is R3).
- `compose()` returns `(bytes, list[dict])` — warnings are `SlotError.to_dict()` with `slide_index` set to the output-slide index, mirroring `render()`.
- Reject errors use `SlotError`; `compose()` raises `ComposeRejected(errors)` (parallel to `RenderRejected`).
- Reject codes: `unknown_canvas`, `unknown_component`, `wrong_type`, `bad_bbox`.
- MCP/endpoint envelopes mirror the deck equivalents exactly (`render_composition`↔`render_deck`, `validate_composition`↔`validate_deck`, `/compose`↔`/render-deck`, `/validate-composition`↔`/validate-deck`).
- Run engine tests from `engine/` with `python -m pytest`; engine-service tests from `engine-service/`.

---

### Task 1: `fill_shape` — slot-free content fill in filler.py

Extract a content-fill entry point that fills any shape by kind + constraints (no `Slot`/deck dependency), and make `fill_slot` delegate to it. This is what `composer` will call for placement content.

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (add `fill_shape`; rewrite `fill_slot` to delegate)
- Test: `engine/tests/test_filler.py` (add tests)

**Interfaces:**
- Consumes: existing `_fill_text(shape, slot, value)`, `_fill_table(shape, rows)`, `_fill_image(slide, shape, value, fit)`; `Slot`, `Constraints`, `SlotError` from `.models`; `find_shape` from `.assembler`.
- Produces: `fill_shape(slide, shape, kind: str, value, constraints: Constraints, slot_id: str | None = None) -> list[SlotError]`. `kind` ∈ `{"text","table","image"}` (any other kind is a no-op returning `[]`).

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/test_filler.py`:

```python
def test_fill_shape_text_truncates_and_warns(sample_template_dir):
    from pptx import Presentation
    from pptx_mcp.filler import fill_shape
    from pptx_mcp.models import Constraints
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    slide = prs.slides[0]
    shape = slide.shapes[0]  # the TITLE textbox
    warns = fill_shape(slide, shape, "text", "x" * 500,
                       Constraints(max_chars=40), slot_id="title")
    assert any(w.code == "text_truncated" for w in warns)
    assert "x" in shape.text_frame.text


def test_fill_shape_table_fills(sample_template_dir):
    from pptx import Presentation
    from pptx_mcp.filler import fill_shape
    from pptx_mcp.models import Constraints
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    slide = prs.slides[2]  # table slide
    table_shape = next(s for s in slide.shapes if s.has_table)
    fill_shape(slide, table_shape, "table", [["A", "B"], ["C", "D"]], Constraints())
    assert table_shape.table.cell(0, 0).text == "A"


def test_fill_shape_unknown_kind_is_noop(sample_template_dir):
    from pptx import Presentation
    from pptx_mcp.filler import fill_shape
    from pptx_mcp.models import Constraints
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    slide = prs.slides[0]
    assert fill_shape(slide, slide.shapes[0], "other", "x", Constraints()) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_filler.py -k fill_shape -v`
Expected: FAIL with `ImportError: cannot import name 'fill_shape'`.

- [ ] **Step 3: Add `fill_shape` and make `fill_slot` delegate**

In `engine/src/pptx_mcp/filler.py`, replace the existing `fill_slot` function (currently lines ~49-57) with:

```python
def fill_shape(slide, shape, kind: str, value, constraints: Constraints,
               slot_id: str | None = None) -> list[SlotError]:
    """Fill an arbitrary shape by content kind, using `constraints` directly.

    No dependency on a deck Slot — `composer` calls this for placement content.
    text/table/image dispatch to the existing fill helpers; any other kind is a
    no-op (decor placed verbatim).
    """
    if kind == "text":
        synthetic = Slot(id=slot_id or "", name="", type="text",
                         shape_id=shape.shape_id, constraints=constraints)
        return _fill_text(shape, synthetic, value)
    if kind == "table":
        return _fill_table(shape, value)
    if kind == "image":
        _fill_image(slide, shape, value, constraints.fit)
        return []
    return []


def fill_slot(slide, slot: Slot, value) -> list[SlotError]:
    shape = find_shape(slide, slot.shape_id)
    return fill_shape(slide, shape, slot.type, value, slot.constraints, slot.id)
```

Add `Constraints` to the existing models import at the top of the file:

```python
from .models import Constraints, Slot, SlotError
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_filler.py -v`
Expected: PASS (new tests + all pre-existing filler tests still green — `fill_slot` behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(filler): add slot-free fill_shape; fill_slot delegates to it"
```

---

### Task 2: `_remap_rels` + `drop_base_slides` — extract from assembler.py

Extract the per-element relationship remap and the base-slide removal from `_duplicate_slide`/`assemble` so `composer` can reuse them. Behavior of `assemble` must not change.

**Files:**
- Modify: `engine/src/pptx_mcp/assembler.py`
- Test: `engine/tests/test_assembler.py` (add a focused `_remap_rels` test; existing round-trip test guards against regression)

**Interfaces:**
- Consumes: module constants `_REL_NS`, `_RID_ATTR`, `_SLIDE_LAYOUT_RELTYPE_FRAGMENT` (already defined).
- Produces:
  - `_remap_rels(src_part, dest_part, element) -> dict` — copies every relationship that `element` (and its descendants) reference via `r:embed`/`r:link`/`r:id` from `src_part` into `dest_part` (skipping slide-layout rels), rewrites those ids on `element` in place, returns the `old_rid -> new_rid` map.
  - `drop_base_slides(prs, count) -> None` — removes the first `count` slides from the package (the `<p:sldId>` + `drop_rel` sequence).

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/test_assembler.py`:

```python
def test_remap_rels_copies_referenced_image_rel(sample_template_dir):
    """A single picture element deep-copied to a fresh slide has its blip rel
    remapped into the dest part."""
    import copy
    from pptx import Presentation
    from pptx_mcp.assembler import _remap_rels

    prs = Presentation(str(sample_template_dir / "base.pptx"))
    src_slide = prs.slides[3]  # image slide
    pic = next(s for s in src_slide.shapes if s.shape_type == 13)

    dest = prs.slides.add_slide(prs.slide_layouts[6])
    el = copy.deepcopy(pic._element)
    dest.shapes._spTree.append(el)

    mapping = _remap_rels(src_slide.part, dest.part, el)
    assert mapping  # at least the blip rel was remapped

    embed_attr = "{%s}embed" % "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    new_rids = {e.get(embed_attr) for e in el.iter() if e.get(embed_attr)}
    assert new_rids
    for rid in new_rids:
        assert rid in dest.part.rels  # resolves in the dest part
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_assembler.py::test_remap_rels_copies_referenced_image_rel -v`
Expected: FAIL with `ImportError: cannot import name '_remap_rels'`.

- [ ] **Step 3: Add the helpers and refactor `_duplicate_slide`/`assemble`**

In `engine/src/pptx_mcp/assembler.py`, add these helpers (after the constants, before `find_shape`):

```python
_EMBED_ATTR = "{%s}embed" % _REL_NS
_LINK_ATTR = "{%s}link" % _REL_NS
_ID_ATTR = "{%s}id" % _REL_NS
_REL_ATTRS = (_EMBED_ATTR, _LINK_ATTR, _ID_ATTR)


def _remap_rels(src_part, dest_part, element) -> dict:
    """Copy the relationships *element* references from src_part into dest_part,
    rewrite the r:embed/r:link/r:id ids on element in place, and return the
    old_rid -> new_rid map. Slide-layout rels are skipped (already wired via
    add_slide)."""
    used = set()
    for el in element.iter():
        for attr in _REL_ATTRS:
            val = el.get(attr)
            if val:
                used.add(val)

    old_to_new: dict[str, str] = {}
    for rid in used:
        if rid not in src_part.rels:
            continue
        rel = src_part.rels[rid]
        if _SLIDE_LAYOUT_RELTYPE_FRAGMENT in rel.reltype:
            continue
        if rel.is_external:
            old_to_new[rid] = dest_part.relate_to(rel._target, rel.reltype, is_external=True)
        else:
            old_to_new[rid] = dest_part.relate_to(rel._target, rel.reltype)

    if old_to_new:
        for el in element.iter():
            for attr in _REL_ATTRS:
                val = el.get(attr)
                if val and val in old_to_new:
                    el.set(attr, old_to_new[val])
    return old_to_new


def drop_base_slides(prs, count: int) -> None:
    """Remove the first *count* slides from the package: drop each <p:sldId>
    (ref-count -> 0) then drop_rel so the serialiser omits the orphaned Part."""
    xml_slides = prs.slides._sldIdLst
    originals = list(xml_slides)[:count]
    rids = [sid.get(_RID_ATTR) for sid in originals]
    for sid, rid in zip(originals, rids):
        xml_slides.remove(sid)
        if rid is not None:
            prs.part.drop_rel(rid)
```

Then in `_duplicate_slide`, replace the relationship-copy + rewrite block (the loop over `source.part.rels.items()` through the `dest.shapes._spTree.iter()` rewrite — currently lines ~54-76) with a single call placed right after the shape deep-copy loop:

```python
    # Deep-copy each source shape element into the dest spTree.
    for shp in source.shapes:
        dest.shapes._spTree.append(copy.deepcopy(shp._element))

    # Copy + remap the relationships those shapes reference into the dest part.
    _remap_rels(source.part, dest.part, dest.shapes._spTree)

    return dest
```

In `assemble`, replace the original-slide removal block (the `xml_slides = prs.slides._sldIdLst` through the `prs.part.drop_rel(rId)` loop — currently lines ~105-117) with:

```python
    drop_base_slides(prs, original_count)
    return prs
```

- [ ] **Step 4: Run the assembler suite to verify pass + no regression**

Run: `cd engine && python -m pytest tests/test_assembler.py -v`
Expected: PASS — the new test plus the existing `test_assemble_order_and_count`, `test_assembled_slides_keep_shapes`, `test_find_shape_by_id` all green (proves the refactor preserved behavior).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/assembler.py engine/tests/test_assembler.py
git commit -m "refactor(assembler): extract _remap_rels and drop_base_slides for reuse"
```

---

### Task 3: `validate_composition` + `ComposeRejected` — composer.py validation

Create `composer.py` with the structural validator and the rejection exception. No assembling yet.

**Files:**
- Create: `engine/src/pptx_mcp/composer.py`
- Test: `engine/tests/test_validate_composition.py`

**Interfaces:**
- Consumes: `get_catalog(template)` from `.catalog` (returns `{"components":[{"component_id","type","source_slide","slot_id",...}]}`); `SlotError`, `Template` from `.models`.
- Produces:
  - `class ComposeRejected(Exception)` with `.errors: list[SlotError]`.
  - `validate_composition(composition_spec: dict, template: Template) -> list[SlotError]`.

- [ ] **Step 1: Write the failing tests**

Create `engine/tests/test_validate_composition.py`:

```python
from pptx_mcp.template import load_template
from pptx_mcp.composer import validate_composition


def _ids(tpl):
    from pptx_mcp.catalog import get_catalog
    comps = get_catalog(tpl)["components"]
    title = next(c for c in comps if c.get("slot_id") == "title")
    table = next(c for c in comps if c["type"] == "table")
    return title["component_id"], table["component_id"]


def test_unknown_canvas(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 99, "placements": [{"component_id": cid}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_canvas" for e in errs)


def test_unknown_component(sample_template_dir):
    tpl = load_template(sample_template_dir)
    spec = {"slides": [{"canvas": 0, "placements": [{"component_id": "9:9"}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_component" for e in errs)


def test_wrong_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)  # title is a text component
    spec = {"slides": [{"canvas": 0,
                        "placements": [{"component_id": cid, "content": [["a"]]}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "wrong_type" for e in errs)


def test_bad_bbox(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": cid, "bbox_pct": {"x": -5, "y": 0, "w": 50, "h": 50}}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "bad_bbox" for e in errs)


def test_valid_spec_has_no_errors(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": cid, "content": "Hello",
         "bbox_pct": {"x": 5, "y": 5, "w": 50, "h": 20}}]}]}
    assert validate_composition(spec, tpl) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_validate_composition.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pptx_mcp.composer'`.

- [ ] **Step 3: Create `composer.py` with validation**

Create `engine/src/pptx_mcp/composer.py`:

```python
import re

from .catalog import get_catalog
from .models import SlotError, Template

_CID_RE = re.compile(r"^\d+:\d+$")
# catalog type -> predicate the content value must satisfy
_CONTENT_OK = {
    "text": lambda v: isinstance(v, str),
    "table": lambda v: isinstance(v, list) and all(isinstance(r, list) for r in v),
    "image": lambda v: bool(v) and isinstance(v, (str, bytes)),
}


class ComposeRejected(Exception):
    def __init__(self, errors: list[SlotError]):
        self.errors = errors
        super().__init__(f"{len(errors)} composition error(s)")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _bbox_ok(b) -> bool:
    if not isinstance(b, dict) or not all(k in b for k in ("x", "y", "w", "h")):
        return False
    if not all(_num(b[k]) for k in ("x", "y", "w", "h")):
        return False
    if not (0 <= b["x"] <= 100 and 0 <= b["y"] <= 100):
        return False
    return 0 < b["w"] <= 100 and 0 < b["h"] <= 100


def validate_composition(composition_spec: dict, template: Template) -> list[SlotError]:
    cat = get_catalog(template)
    by_id = {c["component_id"]: c for c in cat["components"]}
    n_slides = 1 + max((c["source_slide"] for c in cat["components"]), default=-1)

    errors: list[SlotError] = []
    for i, slide in enumerate(composition_spec.get("slides", [])):
        canvas = slide.get("canvas")
        if not isinstance(canvas, int) or isinstance(canvas, bool) or not (0 <= canvas < n_slides):
            errors.append(SlotError(i, None, "unknown_canvas",
                                    f"canvas {canvas!r}; slides 0..{n_slides - 1}"))
        for placement in slide.get("placements", []):
            cid = placement.get("component_id")
            if not isinstance(cid, str) or not _CID_RE.match(cid) or cid not in by_id:
                errors.append(SlotError(i, cid, "unknown_component",
                                        f"no component {cid!r} in template"))
                continue
            ctype = by_id[cid]["type"]
            if "content" in placement and placement["content"] is not None:
                check = _CONTENT_OK.get(ctype)
                if check is None or not check(placement["content"]):
                    errors.append(SlotError(i, cid, "wrong_type",
                                            f"content not valid for {ctype} component"))
            if "bbox_pct" in placement and not _bbox_ok(placement["bbox_pct"]):
                errors.append(SlotError(i, cid, "bad_bbox",
                                        "bbox_pct needs numeric x,y(0-100), w,h(0-100, >0)"))
    return errors
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_validate_composition.py -v`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/composer.py engine/tests/test_validate_composition.py
git commit -m "feat(composer): validate_composition + ComposeRejected (R2 validation)"
```

---

### Task 4: `compose` — the cross-slide assembler

Add the assembling core to `composer.py`: build each output slide from its canvas, clone+place+fill each placement, drop the base slides, return bytes + warnings. Also promote `catalog._component_type` to public `component_type` for reuse.

**Files:**
- Modify: `engine/src/pptx_mcp/catalog.py` (rename `_component_type` → public `component_type`, keep internal caller working)
- Modify: `engine/src/pptx_mcp/composer.py` (add `compose`, `compose_dry_run`)
- Test: `engine/tests/test_composer.py`

**Interfaces:**
- Consumes: `assembler._remap_rels`, `assembler.drop_base_slides`, `assembler.find_shape`; `filler.fill_shape`; `catalog.component_type`; `models.Constraints`, `models.Template`, `models.SlotError`; `validate_composition`, `ComposeRejected` from Task 3.
- Produces:
  - `compose(composition_spec: dict, template: Template) -> tuple[bytes, list[dict]]`.
  - `compose_dry_run(composition_spec: dict, template: Template) -> dict` (`{"errors":[...], "warnings":[...]}`).

- [ ] **Step 1: Promote `component_type` in catalog.py**

In `engine/src/pptx_mcp/catalog.py`, rename `_component_type` to `component_type` (public) and update its one caller. Change the def line:

```python
def component_type(shp) -> str:
```

and in `_component_dict`, change `"type": _component_type(shp),` to `"type": component_type(shp),`.

- [ ] **Step 2: Write the failing tests**

Create `engine/tests/test_composer.py`:

```python
import io

from pptx import Presentation
from pptx_mcp.template import load_template
from pptx_mcp.catalog import get_catalog
from pptx_mcp.composer import compose


def _components(tpl):
    comps = get_catalog(tpl)["components"]
    return {
        "title": next(c for c in comps if c.get("slot_id") == "title"),
        "subtitle": next(c for c in comps if c.get("slot_id") == "subtitle"),
        "image": next(c for c in comps if c["type"] == "image"),
    }


def _reopen(data):
    return Presentation(io.BytesIO(data))


def test_single_placement_places_component(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "Hello World"}]}]}
    data, warnings = compose(spec, tpl)
    prs = _reopen(data)
    assert len(prs.slides) == 1
    texts = [s.text_frame.text for s in prs.slides[0].shapes if s.has_text_frame]
    assert "Hello World" in texts


def test_cross_slide_image_survives_roundtrip(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["image"]["component_id"],
         "bbox_pct": {"x": 10, "y": 10, "w": 40, "h": 40}}]}]}
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    pics = [s for s in prs.slides[0].shapes if s.shape_type == 13]
    assert pics, "cloned picture missing after save/reopen"


def test_manifest_model_drops_unmentioned(sample_template_dir):
    # canvas 0 has TITLE + SUBTITLE; only place TITLE -> SUBTITLE must be gone.
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"]}]}]}
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    texts = [s.text_frame.text for s in prs.slides[0].shapes if s.has_text_frame]
    assert not any("SUBTITLE" in t for t in texts)


def test_verbatim_clone_keeps_sample_text(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"]}]}]}  # no content
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    texts = [s.text_frame.text for s in prs.slides[0].shapes if s.has_text_frame]
    assert any("TITLE" in t for t in texts)


def test_oversized_text_warns(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "First sentence. " * 30}]}]}
    _data, warnings = compose(spec, tpl)
    assert any(w["code"] == "text_truncated" for w in warnings)


def test_zorder_follows_placement_order(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "AAA"},
        {"component_id": c["subtitle"]["component_id"], "content": "BBB"}]}]}
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    last = prs.slides[0].shapes[-1]
    assert last.has_text_frame and last.text_frame.text == "BBB"


def test_bbox_repositions(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    src = Presentation(str(sample_template_dir / "base.pptx"))
    sw = src.slide_width
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "X",
         "bbox_pct": {"x": 50, "y": 50, "w": 25, "h": 10}}]}]}
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    shp = next(s for s in prs.slides[0].shapes if s.has_text_frame)
    assert abs(shp.left - int(sw * 0.5)) < int(sw * 0.01)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_composer.py -v`
Expected: FAIL with `ImportError: cannot import name 'compose'`.

- [ ] **Step 4: Implement `compose` and `compose_dry_run`**

Add to `engine/src/pptx_mcp/composer.py`. First extend the imports at the top (the existing file imports only `re`, `get_catalog`, `SlotError`, `Template`):

```python
import copy
import io
import re

from pptx import Presentation
from pptx.oxml.ns import qn

from .assembler import drop_base_slides, find_shape, _remap_rels
from .catalog import component_type, get_catalog
from .filler import fill_shape
from .models import Constraints, SlotError, Template
```

(Keep the existing `_CID_RE`, `_CONTENT_OK`, `ComposeRejected`, `_num`, `_bbox_ok`, `validate_composition`.)

Then append:

```python
def _copy_background(src_slide, dest_slide) -> None:
    """Copy the canvas slide's slide-level <p:bg> (if any) so the output slide
    matches the canvas background. If absent, the layout/master bg shows through.
    """
    src_csld = src_slide._element.find(qn("p:cSld"))
    if src_csld is None:
        return
    bg = src_csld.find(qn("p:bg"))
    if bg is None:
        return
    dest_csld = dest_slide._element.find(qn("p:cSld"))
    dest_csld.insert(0, copy.deepcopy(bg))  # schema: bg precedes spTree


def _set_geometry(shape, bbox, sw, sh) -> None:
    shape.left = int(sw * bbox["x"] / 100.0)
    shape.top = int(sh * bbox["y"] / 100.0)
    shape.width = int(sw * bbox["w"] / 100.0)
    shape.height = int(sh * bbox["h"] / 100.0)


def compose(composition_spec: dict, template: Template) -> tuple[bytes, list[dict]]:
    errors = validate_composition(composition_spec, template)
    if errors:
        raise ComposeRejected(errors)

    prs = Presentation(template.pptx_path)
    original_count = len(prs.slides)
    base_slides = list(prs.slides)[:original_count]
    sw, sh = prs.slide_width, prs.slide_height

    # slot constraints keyed by (source_slide_index, shape_id) for fill defaults
    slot_map = {(st.source_slide_index, s.shape_id): s
                for st in template.slide_types for s in st.slots}

    warnings: list[dict] = []
    for out_index, slide_spec in enumerate(composition_spec["slides"]):
        canvas = base_slides[slide_spec["canvas"]]
        dest = prs.slides.add_slide(canvas.slide_layout)
        _copy_background(canvas, dest)
        # strip placeholder shapes add_slide injected from the layout
        for shp in list(dest.shapes):
            shp._element.getparent().remove(shp._element)

        for placement in slide_spec.get("placements", []):
            src_idx, shape_id = (int(x) for x in placement["component_id"].split(":"))
            src_shape = find_shape(base_slides[src_idx], shape_id)
            dest.shapes._spTree.append(copy.deepcopy(src_shape._element))
            _remap_rels(base_slides[src_idx].part, dest.part, dest.shapes._spTree[-1])
            placed = dest.shapes[-1]

            if "bbox_pct" in placement:
                _set_geometry(placed, placement["bbox_pct"], sw, sh)

            content = placement.get("content")
            if content is not None:
                kind = component_type(placed)
                slot = slot_map.get((src_idx, shape_id))
                constraints = slot.constraints if slot is not None else Constraints()
                for w in fill_shape(dest, placed, kind, content, constraints,
                                    slot_id=placement["component_id"]):
                    w.slide_index = out_index
                    warnings.append(w.to_dict())

    drop_base_slides(prs, original_count)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), warnings


def compose_dry_run(composition_spec: dict, template: Template) -> dict:
    """Validate + compose, discard the bytes; return errors and warnings."""
    try:
        _bytes, warnings = compose(composition_spec, template)
    except ComposeRejected as e:
        return {"errors": [err.to_dict() for err in e.errors], "warnings": []}
    return {"errors": [], "warnings": warnings}
```

Note: `_remap_rels` is called on `dest.shapes._spTree[-1]` (the element just appended), so each placement's media is copied once and only that element's ids are rewritten. `placed = dest.shapes[-1]` locates the wrapper by identity (last appended), avoiding cross-slide `shape_id` collisions.

- [ ] **Step 5: Run the composer suite to verify pass**

Run: `cd engine && python -m pytest tests/test_composer.py -v`
Expected: PASS (all seven tests).

- [ ] **Step 6: Run the full engine suite (no regressions)**

Run: `cd engine && python -m pytest -q`
Expected: PASS (existing suite + the new composer/validation/filler/assembler tests).

- [ ] **Step 7: Commit**

```bash
git add engine/src/pptx_mcp/catalog.py engine/src/pptx_mcp/composer.py engine/tests/test_composer.py
git commit -m "feat(composer): compose() cross-slide assembler + compose_dry_run"
```

---

### Task 5: MCP tools — `render_composition` / `validate_composition`

Expose composition through the MCP server, mirroring the deck tools.

**Files:**
- Modify: `engine/src/pptx_mcp/mcp_server.py`
- Test: `engine/tests/test_mcp_server.py` (add tests)

**Interfaces:**
- Consumes: `composer.compose`, `composer.compose_dry_run`, `composer.ComposeRejected`; `Storage.load`, `Storage.put_output`.
- Produces:
  - `tool_render_composition(storage, base_url, template_id, composition_spec) -> {"validation":[...], "download_url": str|None, "warnings":[...]}`.
  - `tool_validate_composition(storage, template_id, composition_spec) -> {"errors":[...], "warnings":[...]}`.
  - `@mcp.tool()` `render_composition(template_id, composition_spec)` and `validate_composition(template_id, composition_spec)` in `build_server`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/test_mcp_server.py`:

```python
def test_render_composition_ok(storage):
    from pptx_mcp.mcp_server import tool_render_composition
    from pptx_mcp.catalog import get_catalog
    tpl = storage.load("sample")
    cid = next(c["component_id"] for c in get_catalog(tpl)["components"]
               if c.get("slot_id") == "title")
    spec = {"slides": [{"canvas": 0, "placements": [{"component_id": cid, "content": "Hi"}]}]}
    out = tool_render_composition(storage, "http://x", "sample", spec)
    assert out["validation"] == []
    assert out["download_url"].startswith("http://x/files/")
    assert "warnings" in out


def test_validate_composition_returns_errors(storage):
    from pptx_mcp.mcp_server import tool_validate_composition
    spec = {"slides": [{"canvas": 99, "placements": []}]}
    out = tool_validate_composition(storage, "sample", spec)
    assert "errors" in out and "warnings" in out
    assert any(e["code"] == "unknown_canvas" for e in out["errors"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_mcp_server.py -k composition -v`
Expected: FAIL with `ImportError: cannot import name 'tool_render_composition'`.

- [ ] **Step 3: Add the tool functions and registrations**

In `engine/src/pptx_mcp/mcp_server.py`, add to the top imports (next to the existing `from .render import ...` line):

```python
from .composer import ComposeRejected, compose, compose_dry_run
```

Add the two tool functions (next to `tool_render_deck`/`tool_validate_deck`):

```python
def tool_render_composition(storage: Storage, base_url: str, template_id: str,
                            composition_spec: dict) -> dict:
    tpl = storage.load(template_id)
    try:
        data, warnings = compose(composition_spec, tpl)
    except ComposeRejected as e:
        return {"validation": [err.to_dict() for err in e.errors], "download_url": None}
    token = storage.put_output(data, ".pptx")
    return {"validation": [], "download_url": f"{base_url}/files/{token}", "warnings": warnings}


def tool_validate_composition(storage: Storage, template_id: str,
                              composition_spec: dict) -> dict:
    return compose_dry_run(composition_spec, storage.load(template_id))
```

Register them inside `build_server` (next to the other `@mcp.tool()` defs):

```python
    @mcp.tool()
    def render_composition(template_id: str, composition_spec: dict) -> dict:
        """Compose a slide from catalog components: pick a canvas base slide,
        place components (from any slide) at target positions, fill content.
        Returns validation + download_url + warnings."""
        return tool_render_composition(storage, base_url, template_id, composition_spec)

    @mcp.tool()
    def validate_composition(template_id: str, composition_spec: dict) -> dict:
        """Dry-run a composition spec: returns {errors, warnings} without output."""
        return tool_validate_composition(storage, template_id, composition_spec)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_mcp_server.py -v`
Expected: PASS (new composition tests + all existing mcp_server tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/mcp_server.py engine/tests/test_mcp_server.py
git commit -m "feat(mcp): render_composition + validate_composition tools"
```

---

### Task 6: Engine-service endpoints — `/compose` / `/validate-composition`

Expose composition over HTTP, mirroring `/render-deck` and `/validate-deck`.

**Files:**
- Modify: `engine-service/app.py`
- Test: `engine-service/tests/test_endpoints.py` (add tests)

**Interfaces:**
- Consumes: `composer.compose`, `composer.compose_dry_run`, `composer.ComposeRejected`; `load_from_bytes`.
- Produces: `POST /compose` (form `file`+`manifest`+`composition_spec` → pptx bytes + `X-Overflow-Warnings`, or 422 `{validation}`); `POST /validate-composition` (→ `{errors,warnings}`).

- [ ] **Step 1: Write the failing tests**

Add to `engine-service/tests/test_endpoints.py`:

```python
def _title_cid(sample_template_dir, sample_manifest):
    from pptx_mcp.bytesio import load_from_bytes
    from pptx_mcp.catalog import get_catalog
    tpl = load_from_bytes((sample_template_dir / "base.pptx").read_bytes(), sample_manifest)
    return next(c["component_id"] for c in get_catalog(tpl)["components"]
                if c.get("slot_id") == "title")


def test_compose_ok(sample_template_dir, sample_manifest):
    cid = _title_cid(sample_template_dir, sample_manifest)
    spec = {"slides": [{"canvas": 0, "placements": [{"component_id": cid, "content": "Hi"}]}]}
    r = client.post("/compose", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest),
                          "composition_spec": json.dumps(spec)})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"


def test_compose_rejects(sample_template_dir, sample_manifest):
    spec = {"slides": [{"canvas": 99, "placements": []}]}
    r = client.post("/compose", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest),
                          "composition_spec": json.dumps(spec)})
    assert r.status_code == 422
    assert r.json()["validation"][0]["code"] == "unknown_canvas"


def test_validate_composition_endpoint(sample_template_dir, sample_manifest):
    spec = {"slides": [{"canvas": 99, "placements": []}]}
    r = client.post("/validate-composition", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest),
                          "composition_spec": json.dumps(spec)})
    assert r.status_code == 200
    body = r.json()
    assert "errors" in body and "warnings" in body
    assert any(e["code"] == "unknown_canvas" for e in body["errors"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py -k compos -v`
Expected: FAIL (404 from the missing routes).

- [ ] **Step 3: Add the routes**

In `engine-service/app.py`, extend the composer import (the file already does `from pptx_mcp.render import RenderRejected, dry_run, render`):

```python
from pptx_mcp.composer import ComposeRejected, compose, compose_dry_run
```

Add the two routes (after `/validate-deck`):

```python
@app.post("/compose")
async def compose_route(file: UploadFile = File(...),
                        manifest: str = Form(...), composition_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        out, warnings = compose(json.loads(composition_spec), tpl)
    except ComposeRejected as e:
        return JSONResponse(status_code=422,
                            content={"validation": [x.to_dict() for x in e.errors]})
    finally:
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass
    return Response(content=out, media_type=_PPTX,
                   headers={"X-Overflow-Warnings": json.dumps(warnings)})


@app.post("/validate-composition")
async def validate_composition_route(file: UploadFile = File(...),
                                     manifest: str = Form(...),
                                     composition_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        result = compose_dry_run(json.loads(composition_spec), tpl)
    finally:
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass
    return JSONResponse(content=result)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py -v`
Expected: PASS (new composition endpoint tests + all existing endpoint tests).

- [ ] **Step 5: Commit**

```bash
git add engine-service/app.py engine-service/tests/test_endpoints.py
git commit -m "feat(engine-service): /compose + /validate-composition endpoints"
```

---

## Self-Review

**Spec coverage:**
- Composition spec format (canvas/placements/component_id/bbox_pct/content) → Tasks 3 (validation) + 4 (compose). ✓
- Additive new path, `render_deck` untouched → no task modifies `render.py`. ✓
- Canvas model + manifest model (drop unmentioned) → Task 4 strips placeholders + clones only placements; `test_manifest_model_drops_unmentioned`. ✓
- Per-shape clone + per-shape rel remap → Task 2 `_remap_rels`, used per element in Task 4. ✓
- bbox optional (default source geometry) / content optional (verbatim clone) → Task 4 `if "bbox_pct"` / `if content is not None`; `test_verbatim_clone_keeps_sample_text`. ✓
- Background copy + canvas-bg-wins → Task 4 `_copy_background`; cloned shapes never carry source bg (rel-only copy). ✓
- Validation codes `unknown_canvas`/`unknown_component`/`wrong_type`/`bad_bbox` → Task 3 + tests. ✓
- `fill_shape` extraction → Task 1. ✓
- MCP `render_composition`/`validate_composition` → Task 5. ✓
- `/compose`/`/validate-composition` → Task 6. ✓
- Shape-id collision avoided via identity (`dest.shapes[-1]`) → Task 4. ✓
- Warnings `slide_index` reassigned to output index → Task 4 fill loop. ✓
- Contrast/font-lock deferred to R3 → not in plan. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code. ✓

**Type consistency:** `fill_shape(slide, shape, kind, value, constraints, slot_id=None)` consistent across Tasks 1/4. `_remap_rels(src_part, dest_part, element)` and `drop_base_slides(prs, count)` consistent across Tasks 2/4. `compose`/`compose_dry_run`/`validate_composition`/`ComposeRejected` consistent across Tasks 3/4/5/6. `component_type` (public) defined Task 4 step 1, used same task. `component_id` parsed as `int:int` everywhere. ✓

**Known minor (non-blocking, R3 territory):** filling an *image* placement (`_fill_image`) removes the cloned shape and appends a fresh picture, so an image placement lands last in z-order regardless of its placement position. Acceptable for R2 (decor is cloned verbatim, not image-filled); revisit with the R3 guardrails if z-order of filled images matters.
