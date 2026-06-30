# Clear Unfilled / Surplus Template Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop template sample content (placeholder image, leftover table rows, sample text) from leaking into rendered output when a slot is unfilled or a table is partially filled.

**Architecture:** Add `clear_slot(slide, slot)` to `filler.py`, mirroring `fill_slot`, dispatching by type (text→blank text frame, image→remove shape, table→blank all cells). `_fill_table` blanks all cells before fitting so partially-filled tables drop surplus sample rows. `render.py` routes its empty-value branch to `clear_slot` instead of skipping.

**Tech Stack:** Python, python-pptx (`text_frame.clear()`, element removal, `table.cell`), pytest.

## Global Constraints

- Scope = text + image + table slots (one general clearing mechanism).
- Auto-clear every unfilled known slot; **no** new `nullable` field. "Keep same content every deck" is expressed by `slot.default`.
- Tables: **blank surplus cells** (`cell.text = ""`); never delete rows. Footprint stays fixed (table-fit depends on it).
- `clear_slot` never raises: `find_shape` raises `KeyError` when the shape is absent — catch it and no-op.
- Clearing lives in `filler.py` beside `fill_slot`; `render.py` only routes to it. Validation (`required`+empty → `missing_required_slot`) is unchanged, so only optional/omitted slots reach clearing.
- Filled slots are never cleared (run styling must survive for fitting).

## Reference — current code state (verified)

- `filler.py` imports: `from .assembler import find_shape`, `from .models import Slot, SlotError`, `from pptx.util import Emu, Length, Pt`.
- `find_shape(slide, shape_id)` (in `assembler.py`) **raises `KeyError`** if no shape matches — it does not return `None`.
- `_fill_image` already removes a shape via `shape._element.getparent().remove(shape._element)` — `_clear_image` uses the same idiom.
- `_fill_table(shape, rows: list[list]) -> list[SlotError]` currently: reads `col_w`/`row_h`, auto-sizes on overflow, then fits provided cells. It does **not** blank first.
- `fill_slot` dispatches `text`/`table`/`image` and is the API `clear_slot` mirrors.
- `render.py` empty branch is `if value is None or value == "": continue`.
- Tests: `test_filler.py` mixes fixture-based tests (`sample_template_dir`, `load_template`, `assemble`) and synthetic `Presentation()` tests (e.g. `_deck_with_table`). New unit tests below use synthetic `Presentation()` decks; the render integration test uses the `sample_template_dir` fixture.

---

### Task 1: `clear_slot` + per-type clear helpers in `filler.py`

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (add `clear_slot`, `_clear_text`, `_clear_image`, `_clear_table`, `_blank_all_cells`)
- Test: `engine/tests/test_filler.py` (append)

**Interfaces:**
- Consumes: `find_shape` (raises `KeyError`), `Slot`, python-pptx shape/table APIs.
- Produces:
  - `clear_slot(slide, slot: Slot) -> None`
  - `_blank_all_cells(table) -> None` (also reused by Task 2)
  - `_clear_text(shape)`, `_clear_image(slide, shape)`, `_clear_table(shape)`

- [ ] **Step 1: Write the failing tests**

```python
# Append to engine/tests/test_filler.py
from pptx import Presentation
from pptx.util import Emu
from pptx_mcp.filler import clear_slot
from pptx_mcp.models import Constraints, Slot


def _slot(shape_id, type_):
    return Slot(id=f"{type_}_1", name=type_, type=type_, shape_id=shape_id,
                constraints=Constraints())


def test_clear_slot_text_empties_text_frame():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Emu(914400), Emu(914400), Emu(2000000), Emu(600000))
    tb.text_frame.paragraphs[0].add_run().text = "TEMPLATE SAMPLE"
    clear_slot(slide, _slot(tb.shape_id, "text"))
    assert tb.text_frame.text == ""


def test_clear_slot_image_removes_shape():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Emu(914400), Emu(914400), Emu(1000000), Emu(1000000))
    sid = tb.shape_id
    clear_slot(slide, _slot(sid, "image"))
    assert all(shp.shape_id != sid for shp in slide.shapes)


def test_clear_slot_table_blanks_all_cells():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    gf = slide.shapes.add_table(2, 2, Emu(500000), Emu(500000), Emu(4000000), Emu(1000000))
    table = gf.table
    for r in range(2):
        for c in range(2):
            table.cell(r, c).text = "sample"
    clear_slot(slide, _slot(gf.shape_id, "table"))
    assert all(table.cell(r, c).text == "" for r in range(2) for c in range(2))


def test_clear_slot_missing_shape_is_noop():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    # shape_id 99999 does not exist -> find_shape raises KeyError -> no-op, no raise
    clear_slot(slide, _slot(99999, "text"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_filler.py -k "clear_slot" -v`
Expected: FAIL — `ImportError: cannot import name 'clear_slot' from 'pptx_mcp.filler'`

- [ ] **Step 3: Add the helpers and `clear_slot`**

Add these functions to `filler.py` (place `clear_slot` right after `fill_slot`, and the helpers near `_fill_table`):

```python
def clear_slot(slide, slot: Slot) -> None:
    """Remove the template's sample content for an unfilled slot.

    text  -> empty the text frame
    image -> remove the placeholder/picture shape from the slide
    table -> blank every cell
    A slot whose shape is not on the slide is a silent no-op.
    """
    try:
        shape = find_shape(slide, slot.shape_id)
    except KeyError:
        return
    if slot.type == "text":
        _clear_text(shape)
    elif slot.type == "image":
        _clear_image(slide, shape)
    elif slot.type == "table":
        _clear_table(shape)


def _clear_text(shape) -> None:
    shape.text_frame.clear()


def _clear_image(slide, shape) -> None:
    shape._element.getparent().remove(shape._element)


def _blank_all_cells(table) -> None:
    for r in range(len(table.rows)):
        for c in range(len(table.columns)):
            table.cell(r, c).text = ""


def _clear_table(shape) -> None:
    _blank_all_cells(shape.table)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_filler.py -k "clear_slot" -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(engine): clear_slot blanks text/table and removes image for unfilled slots"
```

---

### Task 2: `_fill_table` blanks all cells before fitting

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (`_fill_table`)
- Test: `engine/tests/test_filler.py` (append)

**Interfaces:**
- Consumes: `_blank_all_cells(table)` from Task 1.
- Produces: `_fill_table` now blanks surplus/sample cells; provided cells overwrite the blanks. Signature unchanged: `_fill_table(shape, rows: list[list]) -> list[SlotError]`.

- [ ] **Step 1: Write the failing test**

```python
# Append to engine/tests/test_filler.py
from pptx_mcp.filler import _fill_table


def test_fill_table_partial_blanks_surplus_template_rows():
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    gf = slide.shapes.add_table(4, 2, Emu(500000), Emu(500000), Emu(4000000), Emu(2000000))
    table = gf.table
    # Template ships 4 sample rows.
    for r in range(4):
        for c in range(2):
            table.cell(r, c).text = f"sample{r}{c}"
    # Deck provides only 2 rows of real data.
    _fill_table(gf, [["A0", "A1"], ["B0", "B1"]])
    assert table.cell(0, 0).text == "A0"
    assert table.cell(1, 1).text == "B1"
    # Surplus template rows 2-3 are now blank, not leftover sample data.
    assert all(table.cell(r, c).text == "" for r in (2, 3) for c in range(2))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_filler.py::test_fill_table_partial_blanks_surplus_template_rows -v`
Expected: FAIL — rows 2-3 still contain `sample20`/`sample21`/… (assert on blank fails)

- [ ] **Step 3: Blank first in `_fill_table`**

Add the blank pass as the first statement of `_fill_table`, immediately after `table = shape.table`:

```python
def _fill_table(shape, rows: list[list]) -> list[SlotError]:
    table = shape.table
    _blank_all_cells(table)          # drop template sample rows before filling
    warnings: list[SlotError] = []
    col_w = [table.columns[c].width for c in range(len(table.columns))]
    row_h = [table.rows[r].height for r in range(len(table.rows))]
    # ... rest unchanged ...
```

Leave the rest of `_fill_table` (overflow check, resize, per-cell fit loop) exactly as-is.

- [ ] **Step 4: Run the test, then the table suite**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_filler.py -k "table or fit_cell or footprint or overflow" -v`
Expected: PASS (the new partial test plus the existing table tests — blanking does not change footprint or fitting behaviour for provided cells)

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(engine): _fill_table blanks template sample cells before filling"
```

---

### Task 3: `render.py` clears empty slots + integration verify

**Files:**
- Modify: `engine/src/pptx_mcp/render.py` (import `clear_slot`; empty branch)
- Test: `engine/tests/test_render.py` (append)

**Interfaces:**
- Consumes: `clear_slot(slide, slot)` from Task 1.
- Produces: an unfilled optional slot is cleared (not skipped) during render.

- [ ] **Step 1: Write the failing test**

First inspect the sample template's slot ids so the test omits an optional slot. Run:
`cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_render.py -q` (to confirm the suite and fixture exist), and read `engine/tests/conftest.py` + an existing `test_render.py` test to copy the deck-spec shape and an optional slot id (one that is NOT `required`). Then add a test of this form (substitute the real `slide_type` and a real optional **text** slot id, plus a sample value the template ships):

```python
# Append to engine/tests/test_render.py
from pptx_mcp.template import load_template
from pptx_mcp.assembler import assemble, find_shape
from pptx_mcp.render import render


def test_render_clears_omitted_optional_text_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # Pick a slide type and an OPTIONAL text slot on it.
    st = tpl.slide_types[0]
    opt = next(s for s in st.slots if s.type == "text" and not s.required)
    # Deck omits `opt` entirely (provides no slots) -> it must be cleared.
    deck = {"slides": [{"slide_type": st.id, "slots": {}}]}
    pptx_bytes, warnings = render(deck, tpl)
    prs = __import__("pptx").Presentation(__import__("io").BytesIO(pptx_bytes))
    shp = find_shape(prs.slides[0], opt.shape_id)
    assert shp.text_frame.text == ""   # template sample text was cleared, not left
```

If the sample template has no optional text slot, instead assert an omitted **image** slot's shape is removed (`all(s.shape_id != opt.shape_id for s in prs.slides[0].shapes)`), picking `opt` as an optional image slot. Use whichever optional slot type the fixture actually provides; do not add new fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_render.py::test_render_clears_omitted_optional_text_slot -v`
Expected: FAIL — the shape still holds the template's sample text (because render currently `continue`s past empty slots)

- [ ] **Step 3: Route empty slots to `clear_slot`**

In `render.py`, add `clear_slot` to the filler import:

```python
from .filler import clear_slot, fill_slot
```

Change the empty branch in the render loop:

```python
            value = provided.get(slot.id, slot.default)
            if value is None or value == "":
                clear_slot(prs.slides[i], slot)
                continue
            for w in fill_slot(prs.slides[i], slot, value):
                w.slide_index = i
                warnings.append(w.to_dict())
```

- [ ] **Step 4: Run the test, then the full engine suite**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_render.py::test_render_clears_omitted_optional_text_slot -v`
Expected: PASS

Then: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest -q`
Expected: PASS (all prior green + the new clearing tests; ≤1 skipped as before). If a pre-existing render test relied on an omitted slot keeping its template content, update it — that was the bug; note the change in the commit.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/render.py engine/tests/test_render.py
git commit -m "feat(engine): render clears unfilled slots instead of leaving template content"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (scope text+image+table) → Task 1 `clear_slot` dispatch.
- Decision 2 (auto-clear, no nullable) → Task 3 routes every empty known slot; no new field added.
- Decision 3 (tables blank, fixed footprint) → Task 1 `_clear_table`/`_blank_all_cells` + Task 2 blank-first; no row deletion.
- Decision 4 (clearing in filler, render routes) → Task 1 in filler, Task 3 in render.
- Decision 5 (filled slots never cleared) → only the empty branch calls `clear_slot`; fill path untouched.
- Component 1 (`clear_slot`+helpers) → Task 1. Component 2 (`_fill_table` blanks first) → Task 2. Component 3 (render routing) → Task 3.
- Testing section → Task 1 (text/image/table/missing-shape unit), Task 2 (partial table), Task 3 (render integration + full suite). Filled-slot styling regression is covered by the existing `_fill_text` tests, which the full suite run in Task 3 re-verifies.

**Placeholder scan:** No TBD/TODO. Task 3's test substitutes a real optional slot id discovered from the fixture (explicit instruction given, not a placeholder).

**Type consistency:** `clear_slot(slide, slot: Slot) -> None`, `_blank_all_cells(table) -> None` used identically in Task 1 (defined, used by `_clear_table`) and Task 2 (used by `_fill_table`). `find_shape` KeyError handling consistent. `_fill_table` signature unchanged.

**Corrected from spec draft:** `find_shape` raises `KeyError` (not `None`) — guard is `try/except KeyError`.
