# R3 Recompose Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the recompose write side — cloned bullet/pointer lists become fillable with multiple items, overflowing boxes grow before shrinking, layout guardrails warn instead of producing broken slides, and the agent is told how to drive it.

**Architecture:** Hybrid split. Per-shape text mechanics (bullet fill, box-grow) extend `filler.py`. Layout checks (overlap, off-slide clamp, low-contrast) live in a new pure-function module `guardrails.py`. `composer.compose` wires them: passes the slide-bottom bound for growth, wraps each fill in try/except (`fill_failed`), collects placed-shape rects+colors, calls `check_layout`, and applies clamps. Catalog gains per-component `multiline`/`hint`; the two MCP composition tools get richer docstrings.

**Tech Stack:** Python 3, python-pptx, pytest. Engine package `pptx_mcp`.

## Global Constraints

- **Additive, compose-path only.** `render.py`, `validate.py`, and the deck-side `fill_slot` path stay byte-for-byte unchanged. The final review asserts those diffs are empty.
- **Box-grow gated:** active only when `max_bottom_emu` is not None. `compose` passes slide height; `fill_slot` passes nothing → None → growth is inert on the deck path.
- **Guardrails never reject.** Overlap, clamp, contrast, and fill errors are warnings; `compose` always returns a file unless R2 structural validation already rejected the spec.
- **Text content** accepts `str` OR `list[str]` (every element a str); non-str element → `wrong_type`. Deck `validate.py` text check is untouched.
- **New warning codes:** `overlap`, `clamped`, `low_contrast`, `fill_failed`. All use `SlotError.to_dict` shape via the existing `warnings` channel; `compose` sets `slide_index = out_index`.
- **Constants:** `OVERLAP_TAU = 0.25`, `CONTRAST_MIN = 3.0`, `_GROW_MARGIN_EMU = 45720` (~0.05 in).
- **All list items are level-0 bullets** (clone `paragraphs[0]`'s `<a:pPr>`).
- Colors resolving to None (theme/inherited) suppress the contrast check silently — never an error.
- Run engine tests from the `engine/` directory: `cd engine && python -m pytest ...`.

---

## File Structure

- `engine/src/pptx_mcp/textfit.py` — add `height_for(value, width_emu, font_pt, spacing) -> int`.
- `engine/src/pptx_mcp/filler.py` — bullet list fill (`_fill_text_list`, `_set_para_text`), box-grow (`_grow_box`, `_fit_list`), `max_bottom_emu` threading.
- `engine/src/pptx_mcp/guardrails.py` — **new**: `check_layout`, `_contrast_ratio`, `_clamp_rect` (pure).
- `engine/src/pptx_mcp/composer.py` — validation widening; compose wiring (grow arg, `fill_failed`, guardrails, clamps, color helpers).
- `engine/src/pptx_mcp/catalog.py` — `_is_multiline`, `_hint`, two new component keys.
- `engine/src/pptx_mcp/mcp_server.py` — enriched composition docstrings.

---

### Task 1: Bullet/list fill (structural) + validation widening

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (add `_fill_text_list`, `_set_para_text`; dispatch in `_fill_text`)
- Modify: `engine/src/pptx_mcp/composer.py` (`_CONTENT_OK["text"]`)
- Test: `engine/tests/test_filler.py`, `engine/tests/test_validate_composition.py`

**Interfaces:**
- Consumes: `_fill_text(shape, slot, value)`, `fill_shape(slide, shape, kind, value, constraints, slot_id=None)` (existing).
- Produces: `_fill_text_list(shape, slot, items) -> list[SlotError]`; `_set_para_text(p_elem, text) -> None`. `_fill_text` dispatches `list` values to `_fill_text_list`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_filler.py`:

```python
from pptx import Presentation
from pptx.util import Emu
from pptx.oxml.ns import qn
from pptx_mcp.filler import fill_shape
from pptx_mcp.models import Constraints


def _textbox_with_bullet():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Emu(914400), Emu(914400), Emu(4000000), Emu(3000000))
    tb.text_frame.paragraphs[0].add_run().text = "SAMPLE"
    pPr = tb.text_frame.paragraphs[0]._p.get_or_add_pPr()
    pPr.append(pPr.makeelement(qn("a:buChar"), {"char": "•"}))
    return prs, slide, tb


def test_fill_list_creates_one_paragraph_per_item():
    prs, slide, tb = _textbox_with_bullet()
    warns = fill_shape(slide, tb, "text", ["First", "Second", "Third"], Constraints())
    paras = tb.text_frame.paragraphs
    assert len(paras) == 3
    assert [p.text for p in paras] == ["First", "Second", "Third"]
    assert warns == []


def test_fill_list_preserves_bullet_formatting():
    prs, slide, tb = _textbox_with_bullet()
    fill_shape(slide, tb, "text", ["A", "B"], Constraints())
    for p in tb.text_frame.paragraphs:
        pPr = p._p.find(qn("a:pPr"))
        assert pPr is not None and pPr.find(qn("a:buChar")) is not None


def test_fill_list_empty_box_falls_back_to_plain_paragraphs():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Emu(914400), Emu(914400), Emu(4000000), Emu(3000000))
    fill_shape(slide, tb, "text", ["one", "two"], Constraints())
    assert [p.text for p in tb.text_frame.paragraphs] == ["one", "two"]


def test_fill_str_still_single_paragraph():
    prs, slide, tb = _textbox_with_bullet()
    fill_shape(slide, tb, "text", "Just one line", Constraints())
    assert tb.text_frame.text == "Just one line"
    assert len(tb.text_frame.paragraphs) == 1
```

Append to `engine/tests/test_validate_composition.py`:

```python
def test_list_content_accepted_for_text(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.catalog import get_catalog
    from pptx_mcp.composer import validate_composition
    tpl = load_template(sample_template_dir)
    cid = next(c["component_id"] for c in get_catalog(tpl)["components"]
               if c.get("slot_id") == "body")
    spec = {"slides": [{"canvas": 1, "placements": [
        {"component_id": cid, "content": ["a", "b", "c"]}]}]}
    assert validate_composition(spec, tpl) == []


def test_list_with_non_str_element_rejected(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.catalog import get_catalog
    from pptx_mcp.composer import validate_composition
    tpl = load_template(sample_template_dir)
    cid = next(c["component_id"] for c in get_catalog(tpl)["components"]
               if c.get("slot_id") == "body")
    spec = {"slides": [{"canvas": 1, "placements": [
        {"component_id": cid, "content": ["ok", 5]}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "wrong_type" for e in errs)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_filler.py -k "fill_list or fill_str_still" tests/test_validate_composition.py -k "list_content or non_str" -v`
Expected: FAIL (`_fill_text_list` missing / list rejected as `wrong_type`).

- [ ] **Step 3: Widen validation in `composer.py`**

Replace the `"text"` entry of `_CONTENT_OK` (composer.py):

```python
_CONTENT_OK = {
    "text": lambda v: isinstance(v, str)
    or (isinstance(v, list) and all(isinstance(x, str) for x in v)),
    "table": lambda v: isinstance(v, list) and all(isinstance(r, list) for r in v),
    "image": lambda v: bool(v) and isinstance(v, (str, bytes)),
}
```

- [ ] **Step 4: Add list fill to `filler.py`**

Add to the imports (after `from pptx.util import ...`):

```python
from pptx.oxml.ns import qn
```

Add this dispatch as the first lines of `_fill_text` (before `warnings: list[SlotError] = []`):

```python
    if isinstance(value, list):
        return _fill_text_list(shape, slot, value)
```

Add these two functions after `_fill_text`:

```python
def _set_para_text(p_elem, text: str) -> None:
    """Set the text of a cloned <a:p>'s first run and drop any extra runs, so
    the paragraph keeps its <a:pPr> (bullet/indent/alignment) but carries only
    the supplied item text."""
    runs = p_elem.findall(qn("a:r"))
    if not runs:
        return
    first = runs[0]
    t = first.find(qn("a:t"))
    if t is not None:
        t.text = text
    for extra in runs[1:]:
        p_elem.remove(extra)


def _fill_text_list(shape, slot: Slot, items) -> list[SlotError]:
    """Fill a text box with one bullet paragraph per item, cloning the
    template's first paragraph (its <a:pPr>) so bullet glyph/indent survive.
    Empty box (nothing to inherit) -> plain paragraphs, no bullet."""
    tf = shape.text_frame
    tf.word_wrap = True
    items = [str(i) for i in items]
    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    if r0 is None:
        tf.text = "\n".join(items)
        return []
    template_p = copy.deepcopy(p0._p)
    txBody = tf._txBody
    for p in list(tf.paragraphs):
        p._p.getparent().remove(p._p)
    for item in items:
        new_p = copy.deepcopy(template_p)
        _set_para_text(new_p, item)
        txBody.append(new_p)
    return []
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_filler.py -k "fill_list or fill_str_still" tests/test_validate_composition.py -k "list_content or non_str" -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Full engine suite (no regression)**

Run: `cd engine && python -m pytest -q`
Expected: all pass (prior 174 + new).

- [ ] **Step 7: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/src/pptx_mcp/composer.py engine/tests/test_filler.py engine/tests/test_validate_composition.py
git commit -m "feat(filler): bullet/list fill (str|list[str]) + validate list content"
```

---

### Task 2: Box-grow-then-shrink (str + list) via `max_bottom_emu`

**Files:**
- Modify: `engine/src/pptx_mcp/textfit.py` (add `height_for`)
- Modify: `engine/src/pptx_mcp/filler.py` (`_grow_box`, `_fit_list`, `max_bottom_emu` param on `fill_shape`/`_fill_text`/`_fill_text_list`)
- Test: `engine/tests/test_textfit.py`, `engine/tests/test_filler.py`

**Interfaces:**
- Consumes: `_fill_text`, `_fill_text_list`, `fill_shape`, `fill_slot` (from Task 1); `fit_text`, `truncate_to_sentence`, `FONT_STEP` from `textfit`.
- Produces: `textfit.height_for(value, width_emu, font_pt, spacing) -> int`; `filler._grow_box(shape, value, font_pt, spacing, max_bottom_emu) -> None`; `filler._fit_list(items, width, height, orig_pt, floor_pt, spacing) -> tuple[list[str], float, int]`. `fill_shape`/`_fill_text`/`_fill_text_list` gain `max_bottom_emu: int | None = None`. `fill_slot` stays None-passing (deck-path invariance).

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_textfit.py`:

```python
def test_height_for_grows_with_more_text():
    from pptx_mcp.textfit import height_for
    w = 3_000_000
    short = height_for("one line", w, 18.0, 1.0)
    long = height_for("x" * 4000, w, 18.0, 1.0)
    assert long > short > 0


def test_height_for_zero_width_is_zero():
    from pptx_mcp.textfit import height_for
    assert height_for("anything", 0, 18.0, 1.0) == 0
```

Append to `engine/tests/test_filler.py`:

```python
from pptx.util import Inches
from pptx_mcp.filler import fill_slot, _fill_text  # noqa: F811


def _small_box(width_in=4.0, height_in=0.4):
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(width_in), Inches(height_in))
    r = tb.text_frame.paragraphs[0].add_run()
    r.text = "x"
    r.font.size = Pt(24)
    return prs, slide, tb


def test_box_grows_when_bottom_bound_given():
    prs, slide, tb = _small_box()
    h_before = tb.height
    slot = Slot(id="", name="", type="text", shape_id=tb.shape_id, constraints=Constraints())
    _fill_text(tb, slot, "This is a long line of text " * 20, max_bottom_emu=6858000)
    assert tb.height > h_before


def test_deck_path_leaves_height_unchanged():
    prs, slide, tb = _small_box()
    h_before = tb.height
    slot = Slot(id="", name="", type="text", shape_id=tb.shape_id, constraints=Constraints())
    fill_slot(slide, slot, "This is a long line of text " * 20)  # no max_bottom_emu -> None
    assert tb.height == h_before


def test_list_drops_trailing_items_when_capped():
    prs, slide, tb = _small_box(width_in=4.0, height_in=0.5)
    slot = Slot(id="body", name="", type="text", shape_id=tb.shape_id, constraints=Constraints())
    items = [f"Item number {i} with a fair amount of text" for i in range(20)]
    # cap the bottom just below the box so growth cannot fit all items
    warns = _fill_text(tb, slot, items, max_bottom_emu=tb.top + tb.height + 200000)
    assert len(tb.text_frame.paragraphs) < 20
    assert any(w.code == "text_truncated" for w in warns)


def test_list_grows_to_keep_all_items():
    prs, slide, tb = _small_box(width_in=6.0, height_in=0.4)
    slot = Slot(id="body", name="", type="text", shape_id=tb.shape_id, constraints=Constraints())
    items = [f"Point {i}" for i in range(6)]
    warns = _fill_text(tb, slot, items, max_bottom_emu=6858000)
    assert len(tb.text_frame.paragraphs) == 6
    assert not any(w.code == "text_truncated" for w in warns)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_textfit.py -k height_for tests/test_filler.py -k "box_grows or deck_path_leaves or list_drops or list_grows" -v`
Expected: FAIL (`height_for` missing; `_fill_text` rejects `max_bottom_emu`).

- [ ] **Step 3: Add `height_for` to `textfit.py`**

Append to `engine/src/pptx_mcp/textfit.py`:

```python
def height_for(value: str, width_emu: int, font_pt: float, spacing: float) -> int:
    """EMU height needed to render `value` at font_pt/spacing in a box of the
    given width. Newlines start new lines. 0 when width is unknown."""
    if width_emu <= 0:
        return 0
    cpl = _chars_per_line(width_emu, font_pt)
    lines = _lines_needed(value, cpl)
    return int(math.ceil(lines * font_pt * EMU_PER_PT * spacing))
```

- [ ] **Step 4: Add grow/fit and thread `max_bottom_emu` in `filler.py`**

Update the `textfit` import line:

```python
from .textfit import FONT_STEP, fit_text, height_for, truncate_to_sentence
```

Add a constant near the top constants block:

```python
_GROW_MARGIN_EMU = 45720  # ~0.05 in breathing room below a grown box
```

Change `fill_shape` signature and the text branch:

```python
def fill_shape(slide, shape, kind: str, value, constraints: Constraints,
               slot_id: str | None = None, max_bottom_emu: int | None = None) -> list[SlotError]:
    if kind == "text":
        synthetic = Slot(id=slot_id or "", name="", type="text",
                         shape_id=shape.shape_id, constraints=constraints)
        return _fill_text(shape, synthetic, value, max_bottom_emu)
    if kind == "table":
        return _fill_table(shape, value)
    if kind == "image":
        _fill_image(slide, shape, value, constraints.fit)
        return []
    return []
```

(`fill_slot` is unchanged — it calls `fill_shape` without `max_bottom_emu`, so the deck path stays None.)

Add the two helpers (after `_resolve_spacing`):

```python
def _grow_box(shape, value, font_pt: float, spacing: float,
              max_bottom_emu: int | None) -> None:
    """Grow the shape's height downward (top fixed) to hold `value` at
    font_pt/spacing, capped at max_bottom_emu minus a margin. No-op on the deck
    path (max_bottom_emu is None) so deck geometry is never touched."""
    if max_bottom_emu is None:
        return
    w = shape.width or 0
    if w <= 0 or shape.height is None or shape.top is None:
        return
    joined = value if isinstance(value, str) else "\n".join(str(i) for i in value)
    needed = height_for(joined, w, font_pt, spacing)
    cap = max_bottom_emu - shape.top - _GROW_MARGIN_EMU
    target = min(needed, cap)
    if target > shape.height:
        shape.height = int(target)


def _fit_list(items, width, height, orig_pt, floor_pt, spacing):
    """Shrink font (in FONT_STEP steps) until every item fits the box height;
    if the floor still overflows, drop trailing whole items. Returns
    (kept_items, font_pt, dropped_count)."""
    if width <= 0 or height <= 0:
        return items, orig_pt, 0
    joined = "\n".join(items)
    pt = orig_pt
    while pt >= floor_pt:
        if height_for(joined, width, pt, spacing) <= height:
            return items, pt, 0
        pt = round(pt - FONT_STEP, 4)
    pt = floor_pt
    kept = list(items)
    while len(kept) > 1 and height_for("\n".join(kept), width, pt, spacing) > height:
        kept.pop()
    return kept, pt, len(items) - len(kept)
```

Replace `_fill_text_list` (from Task 1) with the fitted, grow-aware version:

```python
def _fill_text_list(shape, slot: Slot, items, max_bottom_emu: int | None = None) -> list[SlotError]:
    tf = shape.text_frame
    tf.word_wrap = True
    items = [str(i) for i in items]
    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    if r0 is None:
        tf.text = "\n".join(items)
        return []
    orig_pt = r0.font.size.pt if r0.font.size is not None else _BASE_PT
    base_spacing = _resolve_spacing(p0, orig_pt)
    floor_pt = slot.constraints.shrink_floor_pt or _MIN_PT
    _grow_box(shape, items, orig_pt, base_spacing, max_bottom_emu)
    kept, font_pt, dropped = _fit_list(items, shape.width or 0, shape.height or 0,
                                       orig_pt, floor_pt, base_spacing)
    template_p = copy.deepcopy(p0._p)
    txBody = tf._txBody
    for p in list(tf.paragraphs):
        p._p.getparent().remove(p._p)
    for item in kept:
        new_p = copy.deepcopy(template_p)
        _set_para_text(new_p, item)
        txBody.append(new_p)
    if font_pt < orig_pt:
        for para in tf.paragraphs:
            for run in para.runs:
                run.font.size = Pt(font_pt)
    warnings: list[SlotError] = []
    if dropped:
        warnings.append(SlotError(0, slot.id, "text_truncated",
                                  f"dropped {dropped} list item(s) to fit"))
    return warnings
```

Change `_fill_text`'s signature and body head — the `list` dispatch now forwards the bound, and `_grow_box` runs before the fit call:

```python
def _fill_text(shape, slot: Slot, value, max_bottom_emu: int | None = None) -> list[SlotError]:
    if isinstance(value, list):
        return _fill_text_list(shape, slot, value, max_bottom_emu)
    warnings: list[SlotError] = []
    tf = shape.text_frame
    tf.word_wrap = True

    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    orig_pt = r0.font.size.pt if (r0 is not None and r0.font.size is not None) else _BASE_PT

    base_spacing = _resolve_spacing(p0, orig_pt)
    floor_pt = slot.constraints.shrink_floor_pt or _MIN_PT
    _grow_box(shape, value, orig_pt, base_spacing, max_bottom_emu)
    res = fit_text(value, shape.width or 0, shape.height or 0, orig_pt, floor_pt, base_spacing)
    value = res.value
    dropped = res.dropped
    # ... remainder of the existing function is UNCHANGED ...
```

(Only two things change in `_fill_text`: the `max_bottom_emu` param + `list` dispatch line, and the single `_grow_box(...)` call inserted immediately before the existing `fit_text(...)` line. Everything below `dropped = res.dropped` stays exactly as it was.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_textfit.py -k height_for tests/test_filler.py -k "box_grows or deck_path_leaves or list_drops or list_grows" -v`
Expected: PASS.

- [ ] **Step 6: Full engine suite**

Run: `cd engine && python -m pytest -q`
Expected: all pass (Task 1 list tests still green under the new list path).

- [ ] **Step 7: Commit**

```bash
git add engine/src/pptx_mcp/textfit.py engine/src/pptx_mcp/filler.py engine/tests/test_textfit.py engine/tests/test_filler.py
git commit -m "feat(filler): box-grow-then-shrink for text + list fit via max_bottom_emu"
```

---

### Task 3: `guardrails.py` — overlap / off-slide clamp / low-contrast

**Files:**
- Create: `engine/src/pptx_mcp/guardrails.py`
- Test: `engine/tests/test_guardrails.py`

**Interfaces:**
- Consumes: `autodetect._rect_overlap_frac(a, b) -> float` (rects are `{x,y,w,h}` percent).
- Produces: `check_layout(placed) -> tuple[list[dict], dict]` where `placed` is a list of `{"component_id": str, "rect": {x,y,w,h}, "text_color": str|None, "eff_bg": str|None}`; returns `(warnings, clamps)` — warnings are `{slide_index, slot_id, code, message}` dicts (compose reassigns `slide_index`); clamps is `{component_id: {x,y,w,h}}`. Also `_contrast_ratio(hex_a, hex_b) -> float`, `_clamp_rect(rect) -> dict`.

- [ ] **Step 1: Write the failing tests**

Create `engine/tests/test_guardrails.py`:

```python
from pptx_mcp.guardrails import check_layout, _contrast_ratio, _clamp_rect


def _p(cid, rect, text_color=None, eff_bg=None):
    return {"component_id": cid, "rect": rect,
            "text_color": text_color, "eff_bg": eff_bg}


def test_overlap_warns():
    placed = [
        _p("0:1", {"x": 10, "y": 10, "w": 40, "h": 40}),
        _p("0:2", {"x": 20, "y": 20, "w": 40, "h": 40}),
    ]
    warns, clamps = check_layout(placed)
    assert any(w["code"] == "overlap" for w in warns)


def test_no_overlap_no_warn():
    placed = [
        _p("0:1", {"x": 0, "y": 0, "w": 20, "h": 20}),
        _p("0:2", {"x": 60, "y": 60, "w": 20, "h": 20}),
    ]
    warns, clamps = check_layout(placed)
    assert not any(w["code"] == "overlap" for w in warns)


def test_off_slide_clamped():
    placed = [_p("0:1", {"x": 90, "y": 10, "w": 30, "h": 20})]
    warns, clamps = check_layout(placed)
    assert "0:1" in clamps
    assert clamps["0:1"]["w"] == 10  # 100 - 90
    assert any(w["code"] == "clamped" for w in warns)


def test_low_contrast_warns():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color="FFFFFF", eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert any(w["code"] == "low_contrast" for w in warns)


def test_adequate_contrast_no_warn():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color="000000", eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert not any(w["code"] == "low_contrast" for w in warns)


def test_unresolvable_color_skipped():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color=None, eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert not any(w["code"] == "low_contrast" for w in warns)


def test_contrast_ratio_black_white_is_21():
    assert round(_contrast_ratio("000000", "FFFFFF"), 1) == 21.0


def test_clamp_rect_pulls_into_bounds():
    assert _clamp_rect({"x": -5, "y": 10, "w": 50, "h": 20}) == {
        "x": 0.0, "y": 10, "w": 50, "h": 20}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_guardrails.py -v`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `guardrails.py`**

```python
from .autodetect import _rect_overlap_frac

OVERLAP_TAU = 0.25
CONTRAST_MIN = 3.0


def _channel(c: float) -> float:
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _luminance(hex6: str) -> float:
    r, g, b = (int(hex6[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def _contrast_ratio(hex_a: str, hex_b: str) -> float:
    la, lb = _luminance(hex_a), _luminance(hex_b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _clamp_rect(r: dict) -> dict:
    x = min(max(r["x"], 0.0), 100.0)
    y = min(max(r["y"], 0.0), 100.0)
    w = min(r["w"], 100.0 - x)
    h = min(r["h"], 100.0 - y)
    return {"x": x, "y": y, "w": w, "h": h}


def _warn(cid, code, message):
    return {"slide_index": 0, "slot_id": cid, "code": code, "message": message}


def check_layout(placed):
    """Pure layout guardrail pass over placed shapes (rects in slide-percent).
    Returns (warnings, clamps). Warnings carry slide_index=0 (compose reassigns
    it); clamps maps component_id -> the corrected rect the caller must apply."""
    warnings = []
    clamps = {}

    for i in range(len(placed)):
        for j in range(i + 1, len(placed)):
            a, b = placed[i]["rect"], placed[j]["rect"]
            frac = max(_rect_overlap_frac(a, b), _rect_overlap_frac(b, a))
            if frac >= OVERLAP_TAU:
                ci, cj = placed[i]["component_id"], placed[j]["component_id"]
                warnings.append(_warn(ci, "overlap",
                                      f"{ci} overlaps {cj} ({round(frac * 100)}%)"))

    for p in placed:
        clamped = _clamp_rect(p["rect"])
        if clamped != p["rect"]:
            clamps[p["component_id"]] = clamped
            warnings.append(_warn(p["component_id"], "clamped",
                                  f"{p['component_id']} clamped into slide bounds"))

    for p in placed:
        tc, bg = p.get("text_color"), p.get("eff_bg")
        if tc and bg:
            ratio = _contrast_ratio(tc, bg)
            if ratio < CONTRAST_MIN:
                warnings.append(_warn(p["component_id"], "low_contrast",
                                      f"{p['component_id']} contrast {round(ratio, 2)} < {CONTRAST_MIN}"))

    return warnings, clamps
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_guardrails.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/guardrails.py engine/tests/test_guardrails.py
git commit -m "feat(guardrails): pure overlap/off-slide-clamp/low-contrast layout checks"
```

---

### Task 4: Wire grow + fill-exception hardening + guardrails into `compose`

**Files:**
- Modify: `engine/src/pptx_mcp/composer.py`
- Test: `engine/tests/test_composer.py`

**Interfaces:**
- Consumes: `fill_shape(..., max_bottom_emu)` (Task 2); `guardrails.check_layout` (Task 3); `catalog._hex_or_none`; existing `_set_geometry`, `_copy_background`, `component_type`, `find_shape`, `_remap_rels`, `SlotError`, `qn`.
- Produces: internal helpers `_rect_pct`, `_text_color`, `_eff_bg`, `_canvas_bg_hex`. `compose` behavior extended: box-grow bound = slide height; per-placement fill wrapped in try/except → `fill_failed`; guardrail warnings appended; clamps applied.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_composer.py`:

```python
def test_list_content_renders_bullets_end_to_end(sample_template_dir):
    tpl = load_template(sample_template_dir)
    comps = get_catalog(tpl)["components"]
    body = next(c for c in comps if c.get("slot_id") == "body")
    spec = {"slides": [{"canvas": 1, "placements": [
        {"component_id": body["component_id"], "content": ["First", "Second", "Third"]}]}]}
    data, _ = compose(spec, tpl)
    prs = _reopen(data)
    body_shapes = [s for s in prs.slides[0].shapes
                   if s.has_text_frame and len(s.text_frame.paragraphs) == 3]
    assert body_shapes, "expected a 3-paragraph bullet box"


def test_fill_failure_becomes_warning_not_crash(sample_template_dir, monkeypatch):
    import pptx_mcp.composer as comp
    tpl = load_template(sample_template_dir)
    c = _components(tpl)

    def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(comp, "fill_shape", boom)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "X"}]}]}
    data, warnings = compose(spec, tpl)
    assert data[:2] == b"PK"
    assert any(w["code"] == "fill_failed" for w in warnings)


def test_off_slide_placement_clamped(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    src = Presentation(str(sample_template_dir / "base.pptx"))
    sw = src.slide_width
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "X",
         "bbox_pct": {"x": 90, "y": 10, "w": 30, "h": 10}}]}]}
    data, warnings = compose(spec, tpl)
    prs = _reopen(data)
    shp = next(s for s in prs.slides[0].shapes if s.has_text_frame)
    assert shp.left + shp.width <= sw + 1  # clamped inside slide
    assert any(w["code"] == "clamped" for w in warnings)


def test_overlapping_placements_warn(sample_template_dir):
    tpl = load_template(sample_template_dir)
    c = _components(tpl)
    box = {"x": 10, "y": 10, "w": 50, "h": 50}
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": c["title"]["component_id"], "content": "A", "bbox_pct": box},
        {"component_id": c["subtitle"]["component_id"], "content": "B", "bbox_pct": box}]}]}
    _data, warnings = compose(spec, tpl)
    assert any(w["code"] == "overlap" for w in warnings)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_composer.py -k "list_content_renders or fill_failure or off_slide or overlapping" -v`
Expected: FAIL (no grow/clamp/guardrail wiring; `fill_failed` never emitted).

- [ ] **Step 3: Update imports in `composer.py`**

```python
from .assembler import drop_base_slides, find_shape, _remap_rels
from .catalog import component_type, get_catalog, _hex_or_none
from .filler import fill_shape
from .guardrails import check_layout
from .models import Constraints, SlotError, Template
```

(`qn` and `copy` are already imported.)

- [ ] **Step 4: Add color/rect helpers to `composer.py`**

Add after `_set_geometry`:

```python
def _rect_pct(shape, sw, sh) -> dict:
    return {"x": 100.0 * (shape.left or 0) / sw, "y": 100.0 * (shape.top or 0) / sh,
            "w": 100.0 * (shape.width or 0) / sw, "h": 100.0 * (shape.height or 0) / sh}


def _text_color(shape):
    if not getattr(shape, "has_text_frame", False):
        return None
    paras = shape.text_frame.paragraphs
    runs = paras[0].runs if paras else []
    return _hex_or_none(runs[0].font.color) if runs else None


def _eff_bg(shape, canvas_bg):
    try:
        fill = shape.fill
        if fill.type is not None:
            c = _hex_or_none(fill.fore_color)
            if c:
                return c
    except (TypeError, AttributeError, ValueError):
        pass
    return canvas_bg


def _canvas_bg_hex(slide):
    csld = slide._element.find(qn("p:cSld"))
    if csld is None:
        return None
    bg = csld.find(qn("p:bg"))
    if bg is None:
        return None
    clr = bg.find(".//" + qn("a:srgbClr"))
    return clr.get("val") if clr is not None else None
```

- [ ] **Step 5: Rewrite the `compose` per-slide loop**

Replace the body of the `for out_index, slide_spec ...` loop in `compose` with:

```python
    for out_index, slide_spec in enumerate(composition_spec["slides"]):
        canvas = base_slides[slide_spec["canvas"]]
        dest = prs.slides.add_slide(canvas.slide_layout)
        _copy_background(canvas, dest)
        canvas_bg = _canvas_bg_hex(canvas)
        for shp in list(dest.shapes):
            shp._element.getparent().remove(shp._element)

        placed_shapes = []  # (component_id, shape)
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
                try:
                    for w in fill_shape(dest, placed, kind, content, constraints,
                                        slot_id=placement["component_id"],
                                        max_bottom_emu=sh):
                        w.slide_index = out_index
                        warnings.append(w.to_dict())
                except Exception as exc:
                    warnings.append(SlotError(out_index, placement["component_id"],
                                              "fill_failed", str(exc)).to_dict())
                    continue
            placed_shapes.append((placement["component_id"], placed))

        gl = [{"component_id": cid, "rect": _rect_pct(shp, sw, sh),
               "text_color": _text_color(shp), "eff_bg": _eff_bg(shp, canvas_bg)}
              for cid, shp in placed_shapes]
        gwarnings, clamps = check_layout(gl)
        for w in gwarnings:
            w["slide_index"] = out_index
            warnings.append(w)
        for cid, shp in placed_shapes:
            if cid in clamps:
                _set_geometry(shp, clamps[cid], sw, sh)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_composer.py -k "list_content_renders or fill_failure or off_slide or overlapping" -v`
Expected: PASS.

- [ ] **Step 7: Full engine suite (guard the additive promise)**

Run: `cd engine && python -m pytest -q`
Expected: all pass — existing composer/render/validate tests unchanged.

- [ ] **Step 8: Commit**

```bash
git add engine/src/pptx_mcp/composer.py engine/tests/test_composer.py
git commit -m "feat(composer): grow bound + fill_failed hardening + layout guardrails"
```

---

### Task 5: Catalog per-component `multiline` + `hint`

**Files:**
- Modify: `engine/src/pptx_mcp/catalog.py`
- Test: `engine/tests/test_catalog.py`

**Interfaces:**
- Consumes: `component_type` (existing).
- Produces: `_is_multiline(shp) -> bool`, `_hint(ctype, multiline) -> str`. Each component dict gains `"multiline": bool` and `"hint": str` (additive).

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_catalog.py`:

```python
def test_multiline_flag_and_hint(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.catalog import get_catalog
    tpl = load_template(sample_template_dir)
    comps = get_catalog(tpl)["components"]
    for c in comps:
        assert "multiline" in c and isinstance(c["multiline"], bool)
        assert "hint" in c and isinstance(c["hint"], str) and c["hint"]
    img = next(c for c in comps if c["type"] == "image")
    assert "URL" in img["hint"] or "base64" in img["hint"]
    table = next(c for c in comps if c["type"] == "table")
    assert "list[list]" in table["hint"]


def test_multiline_true_for_bulleted_text():
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.oxml.ns import qn
    from pptx_mcp.catalog import _is_multiline
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(3))
    r = tb.text_frame.paragraphs[0].add_run()
    r.text = "one"
    r.font.size = Pt(18)
    pPr = tb.text_frame.paragraphs[0]._p.get_or_add_pPr()
    pPr.append(pPr.makeelement(qn("a:buChar"), {"char": "•"}))
    assert _is_multiline(tb) is True


def test_multiline_false_for_single_line():
    from pptx import Presentation
    from pptx.util import Inches
    from pptx_mcp.catalog import _is_multiline
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
    tb.text_frame.paragraphs[0].add_run().text = "just one line"
    assert _is_multiline(tb) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_catalog.py -k "multiline or hint" -v`
Expected: FAIL (`_is_multiline` missing; keys absent).

- [ ] **Step 3: Implement in `catalog.py`**

Add the import at the top:

```python
from pptx.oxml.ns import qn
```

Add the two helpers (after `component_type`):

```python
def _is_multiline(shp) -> bool:
    if not getattr(shp, "has_text_frame", False):
        return False
    paras = shp.text_frame.paragraphs
    if sum(1 for p in paras if (p.text or "").strip()) > 1:
        return True
    p0 = paras[0] if paras else None
    if p0 is not None:
        pPr = p0._p.find(qn("a:pPr"))
        if pPr is not None and (pPr.find(qn("a:buChar")) is not None
                                or pPr.find(qn("a:buAutoNum")) is not None):
            return True
    return False


def _hint(ctype: str, multiline: bool) -> str:
    if ctype == "text":
        return ("bullet list — pass content as an array of strings, one per bullet"
                if multiline else "single text — pass a string")
    if ctype == "table":
        return "pass rows as list[list]"
    if ctype == "image":
        return "pass a URL or base64 string"
    return "decorative — placed verbatim, no content"
```

Update `_component_dict` to compute the type once and add the keys:

```python
def _component_dict(shp, slide_index, sw, sh, slot_id) -> dict:
    x = shp.left or 0
    y = shp.top or 0
    w = shp.width or 0
    h = shp.height or 0
    ctype = component_type(shp)
    multiline = _is_multiline(shp)
    return {
        "component_id": f"{slide_index}:{shp.shape_id}",
        "source_slide": slide_index,
        "type": ctype,
        "multiline": multiline,
        "hint": _hint(ctype, multiline),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_catalog.py -v`
Expected: PASS (new + existing catalog tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/catalog.py engine/tests/test_catalog.py
git commit -m "feat(catalog): per-component multiline flag + fill hint for agents"
```

---

### Task 6: Enrich composition tool docstrings

**Files:**
- Modify: `engine/src/pptx_mcp/mcp_server.py`
- Test: `engine/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: existing `build_server` with `render_composition` / `validate_composition` tools.
- Produces: expanded docstrings covering the canvas model, optional `bbox_pct`, bullets-as-array, and every warning code.

- [ ] **Step 1: Write the failing test**

Append to `engine/tests/test_mcp_server.py`:

```python
def test_composition_tool_docs_cover_bullets_and_codes():
    import inspect
    import pptx_mcp.mcp_server as m
    src = inspect.getsource(m.build_server)
    for token in ["array", "canvas", "overlap", "clamped", "low_contrast", "fill_failed"]:
        assert token in src, f"missing guidance token: {token}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_mcp_server.py -k composition_tool_docs -v`
Expected: FAIL (tokens like `low_contrast` not yet in the docstrings).

- [ ] **Step 3: Replace the two composition docstrings in `build_server`**

```python
    @mcp.tool()
    def render_composition(template_id: str, composition_spec: dict) -> dict:
        """Compose slides from catalog components and render a .pptx.

        composition_spec = {"slides": [{"canvas": <int slide index>,
          "placements": [{"component_id": "<slide>:<shape>",
                          "bbox_pct": {"x","y","w","h"}?,   # optional; omit to keep source geometry
                          "content": <str | [str,...] | [[cell,...],...] | url>?}]}]}

        Pick a canvas base slide (its background/theme is inherited); place any
        component from any slide onto it; fill content. For a bullet/pointer
        list component (catalog `multiline: true`), pass content as an ARRAY of
        strings — one bullet per item, template bullet style preserved.

        Returns {validation, download_url, warnings}. Warning codes:
        text_truncated (text/items dropped to fit), table_autogrew (rows added),
        overlap (two placed shapes overlap), clamped (a placement was pulled
        back inside the slide), low_contrast (text vs background too close to
        read), fill_failed (one placement's fill errored and was skipped)."""
        return tool_render_composition(storage, base_url, template_id, composition_spec)

    @mcp.tool()
    def validate_composition(template_id: str, composition_spec: dict) -> dict:
        """Dry-run a composition_spec (same shape as render_composition): returns
        {errors, warnings} without producing a file. Errors block rendering
        (unknown_canvas, unknown_component, wrong_type, bad_bbox); warnings
        (overlap, clamped, low_contrast, fill_failed, text_truncated,
        table_autogrew) do not. Bullet-list components take an array of
        strings as content."""
        return tool_validate_composition(storage, template_id, composition_spec)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && python -m pytest tests/test_mcp_server.py -v`
Expected: PASS (new + existing mcp tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/mcp_server.py engine/tests/test_mcp_server.py
git commit -m "docs(mcp): richer render/validate_composition tool guidance"
```

---

## Final verification (whole-branch)

- [ ] `cd engine && python -m pytest -q` — full suite green.
- [ ] `git diff <plan-base>..HEAD -- engine/src/pptx_mcp/render.py engine/src/pptx_mcp/validate.py` — **empty** (additive guarantee).
- [ ] Confirm `fill_slot` still passes no `max_bottom_emu` (deck geometry untouched).
- [ ] Dispatch the final whole-branch code review (opus) over `<plan-base>..HEAD`.

---

## Self-Review

**Spec coverage:**
- A. bullet/list fill → Task 1 (structural) + Task 2 (fit); validation widening → Task 1. ✓
- B. box-grow-then-shrink → Task 2 (`_grow_box`, `_fit_list`, `max_bottom_emu`). ✓
- C. guardrails: overlap/clamp/contrast → Task 3 (`guardrails.py`) + Task 4 (wiring); off-slide auto-clamp applied → Task 4; fill-exception hardening → Task 4. ✓
- D. catalog `multiline`/`hint` → Task 5; docstrings → Task 6. ✓
- Additive guarantee / deck invariance → Global Constraints + Task 2 deck-path test + final verification diff check. ✓

**Type consistency:** `check_layout(placed) -> (warnings, clamps)` produced in Task 3, consumed in Task 4. `max_bottom_emu` param name consistent across `fill_shape`/`_fill_text`/`_fill_text_list`/`_grow_box`. `_fit_list` returns `(kept, font_pt, dropped)` consumed in `_fill_text_list`. `height_for` signature identical in Task 2 definition and `_grow_box`/`_fit_list` calls. Warning dicts use `{slide_index, slot_id, code, message}` matching `SlotError.to_dict`. ✓

**Placeholder scan:** every code step carries complete code; no TBD/"similar to". ✓
