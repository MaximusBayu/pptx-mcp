# Table Fit Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop text boxes overlapping real PowerPoint tables from becoming fillable slots, and make table cells auto-size (redistribute within a fixed footprint) then per-cell shrink/truncate so cell content stops overflowing.

**Architecture:** Two engine-side changes. (1) `autodetect` gets a post-classification pass that demotes any text candidate sitting ≥60% inside a table candidate's bbox, so the table owns that region. (2) `_fill_table` auto-sizes columns/rows by content demand within the table's fixed footprint (pure `tablefit.redistribute`), then fits each cell with the same shrink-then-truncate pattern `_fill_text` uses, returning `text_truncated` warnings that `fill_slot` now propagates.

**Tech Stack:** Python, python-pptx (`GraphicFrame`/`has_table`, `pptx.util.Emu/Pt/Length`), pytest. No new dependencies.

## Global Constraints

- Tables are **real PowerPoint tables** (`GraphicFrame` with `has_table`) — no grid-of-text-boxes detection.
- `TABLE_OVERLAP_TAU = 0.6` (text-in-table demotion threshold).
- `MIN_COL_FRAC = 0.08`, `MIN_ROW_FRAC = 0.08` (a column/row is never sized below 8% of the table total).
- `redistribute(demands, total, min_each)` returns sizes summing **exactly** to `total`; all-zero or all-equal demands → even split; `total <= n*min_each` → even split.
- Reuse the existing `estimate_max_chars(width_emu, height_emu, font_pt) -> (max_chars, lines)` from `autodetect.py`. Do **not** change its constants (`GLYPH_W=0.5`, `LINE_H=1.2`, `EMU_PER_PT=12700`, `DEFAULT_FONT_PT=18.0`) and do **not** move it.
- New uploads only; back-compatible — differentiation feeds the editor draft, persisted `slide_types` unchanged until re-tag.
- Table footprint is held constant: column total = sum of current column widths; row total = sum of current row heights.
- Existing filler constants: `_BASE_PT = 24.0`, `_MIN_PT = 12.0`. Note: `_SHRINK_STEP` was removed from `filler.py` in a prior cleanup; this plan adds a table-local `_CELL_SHRINK_PT = 4.0`.

---

### Task 1: `tablefit.py` — pure size redistribution

**Files:**
- Create: `engine/src/pptx_mcp/tablefit.py`
- Test: `engine/tests/test_tablefit.py`

**Interfaces:**
- Consumes: nothing (pure module, no python-pptx).
- Produces:
  - `MIN_COL_FRAC = 0.08`, `MIN_ROW_FRAC = 0.08`
  - `redistribute(demands: list[float], total: int, min_each: int) -> list[int]`

- [ ] **Step 1: Write the failing tests**

```python
# engine/tests/test_tablefit.py
from pptx_mcp.tablefit import redistribute, MIN_COL_FRAC, MIN_ROW_FRAC


def test_sizes_sum_exactly_to_total():
    sizes = redistribute([1.0, 3.0, 6.0], 1000, 80)
    assert sum(sizes) == 1000


def test_every_slot_at_least_min_each():
    sizes = redistribute([0.0, 100.0, 1.0], 900, 80)
    assert all(s >= 80 for s in sizes)


def test_higher_demand_gets_more():
    sizes = redistribute([1.0, 10.0], 1000, 80)
    assert sizes[1] > sizes[0]


def test_all_equal_demands_even_split():
    sizes = redistribute([5.0, 5.0, 5.0], 900, 80)
    assert sizes == [300, 300, 300]


def test_all_zero_demands_even_split():
    sizes = redistribute([0.0, 0.0, 0.0], 900, 80)
    assert sizes == [300, 300, 300]


def test_no_room_to_differentiate_even_split():
    # total <= n*min_each -> even split regardless of demand
    sizes = redistribute([1.0, 99.0], 100, 80)
    assert sum(sizes) == 100
    assert abs(sizes[0] - sizes[1]) <= 1


def test_single_slot_returns_unchanged_total():
    assert redistribute([7.0], 1000, 80) == [1000]


def test_empty_demands():
    assert redistribute([], 1000, 80) == []


def test_fracs_are_constants():
    assert MIN_COL_FRAC == 0.08
    assert MIN_ROW_FRAC == 0.08
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_tablefit.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pptx_mcp.tablefit'`

- [ ] **Step 3: Write the implementation**

```python
# engine/src/pptx_mcp/tablefit.py
"""Pure column/row size redistribution within a fixed total.

Used by the table filler to widen columns / heighten rows that need space,
borrowing from those with slack, while keeping the table's footprint constant.
No python-pptx dependency so it is cheap to unit-test.
"""

MIN_COL_FRAC = 0.08
MIN_ROW_FRAC = 0.08


def _max_index(demands: list[float]) -> int:
    best = 0
    for i in range(1, len(demands)):
        if demands[i] > demands[best]:
            best = i
    return best


def _even_split(total: int, n: int) -> list[int]:
    base = total // n
    sizes = [base] * n
    sizes[0] += total - base * n  # rounding remainder to the first slot
    return sizes


def redistribute(demands: list[float], total: int, min_each: int) -> list[int]:
    """Allocate `total` across len(demands) slots in proportion to demand.

    Every slot gets at least `min_each`; the remainder is split by demand.
    Returned sizes sum exactly to `total`. All-zero or all-equal demands, or
    `total <= n*min_each` (no room to differentiate), produce an even split.
    """
    n = len(demands)
    if n == 0:
        return []
    if total <= n * min_each:
        return _even_split(total, n)
    dsum = sum(demands)
    if dsum <= 0 or len(set(demands)) == 1:
        return _even_split(total, n)
    extra = total - n * min_each
    sizes = [min_each + int(extra * (d / dsum)) for d in demands]
    # Assign the rounding remainder to the largest-demand slot.
    sizes[_max_index(demands)] += total - sum(sizes)
    return sizes
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_tablefit.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/tablefit.py engine/tests/test_tablefit.py
git commit -m "feat(engine): tablefit.redistribute — pure size reallocation within fixed total"
```

---

### Task 2: `autodetect.py` — demote text inside a table region

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py` (add constant + 2 functions; call the pass inside `autodetect`)
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `ShapeAssessment` (mutable dataclass: `shape_id, name, type, bbox_pct, confidence, is_candidate, font_pt`), `TAU = 0.5`, `classify_shape`, `derive_ids`.
- Produces:
  - `TABLE_OVERLAP_TAU = 0.6`
  - `_rect_overlap_frac(a: dict, b: dict) -> float` — intersection area ÷ area(a), both `bbox_pct` dicts with keys `x,y,w,h`.
  - `_demote_text_in_tables(assessments: list[ShapeAssessment]) -> None` — mutates in place.

**Note on bbox units:** `bbox_pct` x/w are % of slide width, y/h are % of slide height — different scales — but both shapes on a slide share that same scaling, so the overlap fraction (intersection ÷ text-box area, all in the same mixed-pct space) is the dimensionless "how much of the text box sits inside the table rectangle". Correct as specified.

- [ ] **Step 1: Write the failing tests**

```python
# Append to engine/tests/test_autodetect.py
from pptx_mcp.autodetect import (
    _rect_overlap_frac, _demote_text_in_tables, ShapeAssessment, TABLE_OVERLAP_TAU,
)


def _assess(shape_id, type_, bbox, is_candidate=True, confidence=0.9):
    return ShapeAssessment(
        shape_id=shape_id, name=f"s{shape_id}", type=type_, bbox_pct=bbox,
        confidence=confidence, is_candidate=is_candidate, font_pt=18.0,
    )


def test_rect_overlap_fully_contained():
    a = {"x": 10, "y": 10, "w": 10, "h": 10}   # inside b
    b = {"x": 0, "y": 0, "w": 100, "h": 100}
    assert _rect_overlap_frac(a, b) == 1.0


def test_rect_overlap_disjoint():
    a = {"x": 0, "y": 0, "w": 10, "h": 10}
    b = {"x": 50, "y": 50, "w": 10, "h": 10}
    assert _rect_overlap_frac(a, b) == 0.0


def test_rect_overlap_half_in():
    a = {"x": 0, "y": 0, "w": 10, "h": 10}      # area 100
    b = {"x": 5, "y": 0, "w": 100, "h": 10}     # covers right half of a
    assert abs(_rect_overlap_frac(a, b) - 0.5) < 1e-9


def test_rect_overlap_zero_area_text():
    a = {"x": 0, "y": 0, "w": 0, "h": 10}
    b = {"x": 0, "y": 0, "w": 100, "h": 100}
    assert _rect_overlap_frac(a, b) == 0.0


def test_demote_text_inside_table():
    table = _assess(1, "table", {"x": 0, "y": 0, "w": 80, "h": 80})
    inside = _assess(2, "text", {"x": 10, "y": 10, "w": 20, "h": 20})
    assessments = [table, inside]
    _demote_text_in_tables(assessments)
    assert inside.is_candidate is False
    assert inside.confidence < TABLE_OVERLAP_TAU  # also below TAU=0.5
    assert table.is_candidate is True  # table never demoted


def test_text_beside_table_stays_candidate():
    table = _assess(1, "table", {"x": 0, "y": 40, "w": 80, "h": 50})
    title = _assess(2, "text", {"x": 0, "y": 0, "w": 80, "h": 20})  # above, no overlap
    _demote_text_in_tables([table, title])
    assert title.is_candidate is True


def test_no_tables_no_change():
    a = _assess(1, "text", {"x": 0, "y": 0, "w": 50, "h": 50})
    _demote_text_in_tables([a])
    assert a.is_candidate is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_autodetect.py -k "overlap or demote or beside or no_tables" -v`
Expected: FAIL — `ImportError: cannot import name '_rect_overlap_frac'`

- [ ] **Step 3: Add the constant and helpers**

Add `TABLE_OVERLAP_TAU = 0.6` next to the other module constants (after `EMU_PER_PT = 12700` on line 16):

```python
TABLE_OVERLAP_TAU = 0.6
```

Add these two functions at module level, just above `def autodetect`:

```python
def _rect_overlap_frac(a: dict, b: dict) -> float:
    """Fraction of rect a's area that lies inside rect b.

    a, b are bbox_pct dicts (x, y, w, h). Axis-aligned intersection area
    divided by area(a); 0.0 when a has no area or the rects are disjoint.
    """
    area_a = a["w"] * a["h"]
    if area_a <= 0:
        return 0.0
    ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    return (ix * iy) / area_a


def _demote_text_in_tables(assessments: list["ShapeAssessment"]) -> None:
    """Demote any text candidate that sits >= TABLE_OVERLAP_TAU inside a table
    candidate's bbox, so the table owns that region and the overlapping text
    never becomes a fillable slot. Mutates assessments in place; tables are
    never demoted. A title/label beside or above a table (little overlap) stays.
    """
    tables = [a.bbox_pct for a in assessments if a.is_candidate and a.type == "table"]
    if not tables:
        return
    for a in assessments:
        if not (a.is_candidate and a.type == "text"):
            continue
        if any(_rect_overlap_frac(a.bbox_pct, t) >= TABLE_OVERLAP_TAU for t in tables):
            a.is_candidate = False
            a.confidence = round(min(a.confidence, TAU - 0.001), 3)
```

- [ ] **Step 4: Call the pass inside `autodetect`**

In `def autodetect`, between building `assessments` and `derive_ids` (currently lines 239-240):

```python
        assessments = [classify_shape(shp, sw, sh) for shp in slide.shapes]
        _demote_text_in_tables(assessments)
        ids = derive_ids([a for a in assessments if a.is_candidate])
```

This runs before `derive_ids`, so demoted shapes get no id and are excluded from `slot_ids` / `text_blob` / candidate counts (they appear in the `shapes` list with `is_candidate: False`, like any other non-candidate).

- [ ] **Step 5: Run the new tests, then the autodetect suite**

Run: `cd engine && python -m pytest tests/test_autodetect.py tests/test_autodetect_real.py -v`
Expected: PASS (new tests pass; existing autodetect tests still pass)

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): demote text candidates overlapping a table region in autodetect"
```

---

### Task 3: `filler.py` — auto-size + per-cell fit in `_fill_table`

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (imports, new constant, `fill_slot` table branch, rewrite `_fill_table`, add helpers)
- Test: `engine/tests/test_filler.py`

**Interfaces:**
- Consumes: `tablefit.redistribute`, `tablefit.MIN_COL_FRAC`, `tablefit.MIN_ROW_FRAC`; `autodetect.estimate_max_chars`; `textfit.truncate_to_sentence` (already imported); `pptx.util.Emu/Pt`; `models.SlotError`; existing `_BASE_PT = 24.0`, `_MIN_PT = 12.0`.
- Produces (table side of the filler):
  - `_CELL_SHRINK_PT = 4.0`
  - `_cell_font_pt(cell) -> float`
  - `_any_cell_overflows(table, rows, col_w, row_h) -> bool`
  - `_resize_columns(table, rows, col_w) -> list[int]`
  - `_resize_rows(table, rows, col_w, row_h) -> list[int]`
  - `_fit_cell(cell, value, width_emu, height_emu, slot_id) -> list[SlotError]`
  - `_fill_table(shape, rows) -> list[SlotError]` (was `-> None`)
  - `fill_slot` table branch now returns `_fill_table(...)`.

**Reference — current state of the pieces being changed:**
- Imports (lines 1-12): `import base64/io/logging/urllib.request`; `from pptx.util import Length, Pt`; `from .autodetect import LINE_H`; `from .textfit import fit_text, truncate_to_sentence`.
- Constants (lines 14-16): `_BASE_PT = 24.0`, `_MIN_PT = 12.0`, `_IMG_MAX_BYTES = ...` (no `_SHRINK_STEP` — removed earlier).
- `fill_slot` (lines 45-53): table branch is `_fill_table(shape, value)` (result discarded).
- `_fill_table` (lines 114-119): `table.cell(r,c).text = str(val)` with no fit, returns `None`.

- [ ] **Step 1: Write the failing tests**

```python
# Append to engine/tests/test_filler.py
import math

from pptx import Presentation
from pptx.util import Emu, Pt

from pptx_mcp.filler import (
    fill_slot, _fill_table, _any_cell_overflows, _fit_cell,
)
from pptx_mcp.models import Constraints, Slot


def _deck_with_table(rows, cols, col_w=1_000_000, row_h=400_000):
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    gf = slide.shapes.add_table(rows, cols, Emu(500_000), Emu(500_000),
                                Emu(col_w * cols), Emu(row_h * rows))
    table = gf.table
    for c in range(cols):
        table.columns[c].width = Emu(col_w)
    for r in range(rows):
        table.rows[r].height = Emu(row_h)
    return prs, slide, gf, table


def _table_slot(shape_id):
    return Slot(id="table_1", name="Table", type="table", shape_id=shape_id,
                constraints=Constraints())


def test_short_cells_no_resize_no_warning():
    prs, slide, gf, table = _deck_with_table(2, 2)
    before_w = [table.columns[c].width for c in range(2)]
    warnings = _fill_table(gf, [["a", "b"], ["c", "d"]])
    after_w = [table.columns[c].width for c in range(2)]
    assert after_w == before_w          # no overflow -> no resize
    assert warnings == []
    assert table.cell(0, 0).text == "a"


def test_footprint_constant_after_resize():
    prs, slide, gf, table = _deck_with_table(2, 2)
    total_w_before = sum(table.columns[c].width for c in range(2))
    total_h_before = sum(table.rows[r].height for r in range(2))
    long = "x" * 4000
    _fill_table(gf, [[long, "b"], ["c", "d"]])
    total_w_after = sum(table.columns[c].width for c in range(2))
    total_h_after = sum(table.rows[r].height for r in range(2))
    assert total_w_after == total_w_before
    assert total_h_after == total_h_before


def test_overflowing_column_widened_over_slack():
    prs, slide, gf, table = _deck_with_table(1, 2)
    _fill_table(gf, [["x" * 4000, "b"]])
    assert table.columns[0].width > table.columns[1].width


def test_long_cell_truncated_with_warning():
    prs, slide, gf, table = _deck_with_table(1, 1, col_w=300_000, row_h=200_000)
    warnings = _fill_table(gf, [["y" * 5000]])
    assert any(w.code == "text_truncated" for w in warnings)


def test_fill_slot_propagates_table_warnings():
    prs, slide, gf, table = _deck_with_table(1, 1, col_w=300_000, row_h=200_000)
    warnings = fill_slot(slide, _table_slot(gf.shape_id), [["y" * 5000]])
    assert any(w.code == "text_truncated" for w in warnings)


def test_fit_cell_short_value_unchanged_font():
    prs, slide, gf, table = _deck_with_table(1, 1)
    cell = table.cell(0, 0)
    cell.text_frame.paragraphs[0].add_run().text = "old"
    cell.text_frame.paragraphs[0].runs[0].font.size = Pt(18)
    warnings = _fit_cell(cell, "hi", Emu(1_000_000), Emu(400_000), "cell[0,0]")
    assert warnings == []
    assert cell.text == "hi"
    assert cell.text_frame.paragraphs[0].runs[0].font.size == Pt(18)
```

`SlotError` is `SlotError(slide_index: int, slot_id: str | None, code: str, message: str)` (confirmed in `engine/src/pptx_mcp/models.py`); the assertions check `.code == "text_truncated"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_filler.py -k "table or fit_cell or footprint or overflow" -v`
Expected: FAIL — `ImportError: cannot import name '_any_cell_overflows'` (and `_fill_table` returns `None`).

- [ ] **Step 3: Update imports and add the constant**

Change the import line `from pptx.util import Length, Pt` to add `Emu`:

```python
from pptx.util import Emu, Length, Pt
```

Change `from .autodetect import LINE_H` to also import the capacity formula:

```python
from .autodetect import LINE_H, estimate_max_chars
```

Add the tablefit import next to the textfit import:

```python
from .tablefit import MIN_COL_FRAC, MIN_ROW_FRAC, redistribute
```

Add `import math` in the top import block (alongside `import base64/io/logging/urllib.request`).

Add the table-local shrink step beside `_MIN_PT = 12.0`:

```python
_CELL_SHRINK_PT = 4.0
```

- [ ] **Step 4: Make `fill_slot`'s table branch return warnings**

Replace the table branch in `fill_slot` (currently lines 49-52):

```python
    if slot.type == "table":
        return _fill_table(shape, value)
    if slot.type == "image":
        _fill_image(slide, shape, value, slot.constraints.fit)
    return []
```

- [ ] **Step 5: Rewrite `_fill_table` and add the helpers**

Replace the existing `_fill_table` (lines 114-119) with:

```python
def _cell_font_pt(cell) -> float:
    tf = cell.text_frame
    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    if r0 is not None and r0.font.size is not None:
        return r0.font.size.pt
    return _BASE_PT


def _any_cell_overflows(table, rows, col_w, row_h) -> bool:
    for r, row in enumerate(rows):
        if r >= len(table.rows):
            continue
        for c, val in enumerate(row):
            if c >= len(table.columns):
                continue
            cap, _ = estimate_max_chars(col_w[c], row_h[r], _cell_font_pt(table.cell(r, c)))
            if len(str(val)) > cap:
                return True
    return False


def _resize_columns(table, rows, col_w) -> list[int]:
    ncols = len(col_w)
    demands = [0.0] * ncols
    for row in rows:
        for c, val in enumerate(row):
            if c < ncols:
                demands[c] = max(demands[c], float(len(str(val))))
    total = sum(col_w)
    return redistribute(demands, total, int(MIN_COL_FRAC * total))


def _resize_rows(table, rows, col_w, row_h) -> list[int]:
    nrows = len(row_h)
    demands = [0.0] * nrows
    for r, row in enumerate(rows):
        if r >= nrows:
            continue
        for c, val in enumerate(row):
            if c >= len(col_w):
                continue
            cap, lines = estimate_max_chars(col_w[c], row_h[r], _cell_font_pt(table.cell(r, c)))
            cpl = max(1, cap // lines)  # chars per line at the cell's font
            lines_needed = math.ceil(len(str(val)) / cpl)
            demands[r] = max(demands[r], float(lines_needed))
    total = sum(row_h)
    return redistribute(demands, total, int(MIN_ROW_FRAC * total))


def _fit_cell(cell, value, width_emu, height_emu, slot_id) -> list[SlotError]:
    warnings: list[SlotError] = []
    tf = cell.text_frame
    tf.word_wrap = True
    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    orig_pt = r0.font.size.pt if (r0 is not None and r0.font.size is not None) else _BASE_PT

    capacity, _ = estimate_max_chars(width_emu, height_emu, orig_pt)
    new_pt = orig_pt
    if len(value) > capacity:
        new_pt = max(_MIN_PT, orig_pt - _CELL_SHRINK_PT)
        capacity2 = int(capacity * (orig_pt / new_pt))
        if len(value) > capacity2:
            value, dropped = truncate_to_sentence(value, capacity2)
            if dropped:
                warnings.append(SlotError(0, slot_id, "text_truncated",
                                          f"dropped {len(dropped)} chars to fit cell"))

    if r0 is not None:
        r0.text = value
        for extra_run in p0.runs[1:]:
            extra_run._r.getparent().remove(extra_run._r)
        for extra_para in tf.paragraphs[1:]:
            extra_para._p.getparent().remove(extra_para._p)
        r0.font.size = Pt(new_pt)
    else:
        cell.text = value
        for para in tf.paragraphs:
            for run in para.runs:
                run.font.size = Pt(new_pt)
    return warnings


def _fill_table(shape, rows: list[list]) -> list[SlotError]:
    table = shape.table
    warnings: list[SlotError] = []
    col_w = [table.columns[c].width for c in range(len(table.columns))]
    row_h = [table.rows[r].height for r in range(len(table.rows))]

    # Auto-size only when some provided cell overflows at its base font, so a
    # table that already fits keeps its original column/row sizes.
    if _any_cell_overflows(table, rows, col_w, row_h):
        col_w = _resize_columns(table, rows, col_w)
        for c, w in enumerate(col_w):
            table.columns[c].width = Emu(w)
        row_h = _resize_rows(table, rows, col_w, row_h)  # demand uses new widths
        for r, h in enumerate(row_h):
            table.rows[r].height = Emu(h)

    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            if r < len(table.rows) and c < len(table.columns):
                warnings.extend(_fit_cell(table.cell(r, c), str(val),
                                          col_w[c], row_h[r], f"cell[{r},{c}]"))
    return warnings
```

- [ ] **Step 6: Run the filler tests, then the text-format tests**

Run: `cd engine && python -m pytest tests/test_filler.py tests/test_text_format.py -v`
Expected: PASS (new table tests pass; existing `_fill_text` tests untouched and still pass)

- [ ] **Step 7: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(engine): table auto-size + per-cell fit with truncation warnings in _fill_table"
```

---

### Task 4: Full engine suite + render integration verify

**Files:**
- No source changes expected. If a pre-existing test breaks, fix it in this task and note why.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green engine suite; confirmation that table truncation warnings reach the render response.

- [ ] **Step 1: Run the whole engine suite**

Run: `cd engine && python -m pytest -q`
Expected: PASS (all prior green + the new tablefit/autodetect/filler tests; ≤1 skipped as before).

- [ ] **Step 2: Confirm render-path propagation**

Run: `cd engine && python -m pytest tests/test_render.py -v`
Expected: PASS. `render` already aggregates `fill_slot`'s returned warnings (the text branch); the table branch now joins it. If a render test asserts a table fill produced no warnings, update it to reflect that overflowing table cells now emit `text_truncated`.

- [ ] **Step 3: Commit (only if a test was adjusted)**

```bash
git add -A
git commit -m "test(engine): align render/table tests with cell-fit warnings"
```

If no test needed changing, skip this commit — Task 4 is a verification gate.

---

## Self-Review

**Spec coverage:**
- Decision 1 (region differentiation) → Task 2.
- Decision 2 (per-cell independent fit) → Task 3 `_fit_cell` (shrinks only the overflowing cell).
- Decision 3 (reuse `estimate_max_chars` + shrink pattern) → Task 3 imports it; mirrors `_fill_text`.
- Decision 4 (new uploads only) → Task 2 runs in `autodetect`; no persisted-data migration.
- Decision 5 (redistribute within fixed footprint before shrinking) → Task 1 + Task 3 `_fill_table` (footprint held; resize only on overflow).
- Component 1 (autodetect pass before `derive_ids`) → Task 2 Step 4.
- Component 2 (`tablefit.redistribute`) → Task 1.
- Component 3 (`_fill_table` auto-size + `_fit_cell`, `fill_slot` returns warnings) → Task 3.
- Component 4 (shared formula, no move) → Task 3 imports, no relocation.
- Testing section → covered across Tasks 1-3 plus the Task 4 gate.

**Placeholder scan:** No TBD/TODO; all steps carry real code and exact commands.

**Type consistency:** `redistribute(list[float], int, int) -> list[int]` consumed by `_resize_columns/_resize_rows` which feed `Emu(int)`. `estimate_max_chars(width, height, font) -> (max_chars, lines)` used consistently. `_fit_cell(..., slot_id) -> list[SlotError]`; `_fill_table -> list[SlotError]`; `fill_slot` returns it. `_rect_overlap_frac(dict, dict) -> float`; `_demote_text_in_tables(list[ShapeAssessment]) -> None`.

**Stale-spec corrections applied:** spec §178 claims `_SHRINK_STEP` exists in `filler.py` — it was removed in a prior cleanup, so this plan introduces `_CELL_SHRINK_PT = 4.0` instead. `estimate_max_chars` and its constants confirmed present in `autodetect.py`.
