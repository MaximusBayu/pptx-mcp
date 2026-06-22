# Table Fit Quality — Region Differentiation + Auto-Size + Per-Cell Fit — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** B (table half) of the fit-quality work. The free-text-card
line-spacing overflow (report images 1–2) is a separate remaining spec.

## Goal

Fix three real-table problems seen in rendered decks:

1. **Text/table confusion** — separate text shapes that sit over a real table's
   region get detected as their own slots; the agent fills both, so big text
   overlaps the table's cells (report image 3). The table should be the single
   component owning that region.
2. **Tight cells get more room first** — before degrading any text, redistribute
   column widths and row heights within the table's fixed footprint so columns/
   rows that need space borrow it from those with slack.
3. **Cell overflow** — `_fill_table` writes cell text with no fitting, so long
   values overflow the cell (report images 3–4). Whatever still does not fit
   after auto-size shrinks then truncates to its own cell box.

Both fixes are engine-side. Tables here are **real PowerPoint tables**
(`GraphicFrame` with `has_table`), confirmed with the user — not grids of text
boxes — so no cluster/grid detection is needed.

## Background

- Detection: `engine/src/pptx_mcp/shapes.py` `_guess_type` returns `"table"` for
  a `GraphicFrame` with `has_table`, else `"image"`/`"text"`. A real table is one
  shape; its cells are internal and never appear as separate slide shapes. So
  per-cell text slots cannot come from a real table — the stray overlapping slots
  are genuinely separate text boxes layered over the table.
- `engine/src/pptx_mcp/autodetect.py` `classify_shape` scores each shape and sets
  `is_candidate = confidence >= TAU`. Table candidates get `suggested_max_rows/
  cols`. There is currently no relationship check between shapes, so a text box
  overlapping a table is scored independently and usually becomes a candidate.
- `engine/src/pptx_mcp/filler.py` `_fill_table` does
  `table.cell(r,c).text = str(val)` with no font fit and returns `None`.
  `_fill_text` already demonstrates the fit pattern: read the first run's font,
  decide shrink, step the font down to a floor, truncate via
  `truncate_to_sentence`, and preserve run styling by writing into the existing
  run and dropping extras.
- `estimate_max_chars(width_emu, height_emu, font_pt) -> (max_chars, lines)`
  lives in `autodetect.py` and is the shared capacity formula
  (`GLYPH_W=0.5`, `LINE_H=1.2`, `EMU_PER_PT=12700`, `DEFAULT_FONT_PT=18`).

## Decisions

1. **Region differentiation in autodetect** — a text candidate whose area is
   substantially inside a table candidate's bbox is demoted, so the table owns
   that region and the overlapping text never becomes a fillable slot.
2. **Per-cell independent fit** (user's choice) — each cell shrinks only as much
   as it needs; cells that already fit keep their original font. No uniform
   table-wide font pass.
3. **Reuse the existing fit formula and shrink pattern** — cell fit mirrors
   `_fill_text` and uses `estimate_max_chars`; no new fitting math.
4. **New uploads only** — differentiation runs in autodetect, which feeds the
   editor draft. Templates already saved keep their persisted `slide_types`;
   re-tagging picks up the new behavior. Back-compatible.
5. **Redistribute within the fixed footprint before shrinking** (user's choice) —
   when a cell overflows, shift column width and row height from slack columns/
   rows to needy ones while keeping the table's overall size constant (no slide-
   layout change, no neighbor collisions). Runs only when at least one cell
   overflows at the base font; a table that already fits is untouched. Per-cell
   font shrink/truncate then handles whatever still overflows.

## Components

### 1. `engine/src/pptx_mcp/autodetect.py` — table-region differentiation

Add a post-classification pass in `autodetect` (after the per-shape
`assessments` are built, before deriving ids / building the `shapes` list, so
demoted shapes are excluded from candidates and id derivation):

- Collect the bboxes (in pct) of all candidates whose `type == "table"`.
- For each candidate whose `type == "text"`, compute the fraction of the text
  box's area that lies inside any table bbox (axis-aligned rectangle
  intersection area ÷ text box area). If that fraction ≥ `TABLE_OVERLAP_TAU =
  0.6`, demote: set `is_candidate = False` and lower `confidence` below `TAU`
  (record the reason "inside table region" — surfaced via confidence only; no new
  field required).
- A title or label that sits *above/beside* a table (little or no overlap) stays
  a candidate.

New module constant: `TABLE_OVERLAP_TAU = 0.6`. New helper:
`_rect_overlap_frac(a: dict, b: dict) -> float` taking two `bbox_pct` dicts
(`x,y,w,h`) and returning intersection-area ÷ area(a). Pure, unit-tested.

Because bbox units differ (x/w are % of width, y/h are % of height), the overlap
is computed in the same pct space for both shapes — consistent, since both come
from the same slide's pct bboxes; the fraction is dimensionless and correct for
"how much of the text box sits within the table rectangle."

This pass must run before `derive_ids` so demoted shapes do not receive ids and
do not appear in `slot_ids` / `text_blob` / candidate counts.

### 2. `engine/src/pptx_mcp/tablefit.py` — column/row redistribution (new)

A pure module that reallocates sizes within a fixed total, used for both axes:

`redistribute(demands: list[float], total: int, min_each: int) -> list[int]`
- Two-pass: (1) give every slot `min_each`; (2) distribute the remaining
  `total - n*min_each` across slots in proportion to `demands`. The returned
  sizes sum **exactly** to `total` (assign any rounding remainder to the
  largest-demand slot).
- `demands` all zero or all equal → even split (equal input stays unchanged).
- `total <= n*min_each` (no room to differentiate) → even split.

Constants: `MIN_COL_FRAC = 0.08`, `MIN_ROW_FRAC = 0.08` — a column/row is never
sized below 8% of the table total. Pure, unit-tested without python-pptx.

`filler` applies the results via `table.columns[c].width = Emu(w)` and
`table.rows[r].height = Emu(h)`. Column total = sum of current column widths; row
total = sum of current row heights — both held constant, so the table footprint
does not change.

### 3. `engine/src/pptx_mcp/filler.py` — auto-size + per-cell fit in `_fill_table`

Change `_fill_table` to auto-size first (only when needed), then fit each cell and
return warnings:

```
def _fill_table(shape, rows) -> list[SlotError]:
    table = shape.table
    warnings = []
    col_w = [table.columns[c].width for c in range(len(table.columns))]
    row_h = [table.rows[r].height for r in range(len(table.rows))]

    # Auto-size only when some provided cell overflows at its base font.
    if _any_cell_overflows(table, rows, col_w, row_h):
        col_w = _resize_columns(rows, col_w)            # width by content demand
        for c, w in enumerate(col_w):
            table.columns[c].width = Emu(w)
        row_h = _resize_rows(table, rows, col_w, row_h)  # demand uses new widths
        for r, h in enumerate(row_h):
            table.rows[r].height = Emu(h)

    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            if r < len(table.rows) and c < len(table.columns):
                w = _fit_cell(table.cell(r, c), str(val), col_w[c], row_h[r])
                warnings.extend(w)
    return warnings
```

Helpers (in `filler.py`, using `estimate_max_chars` and `tablefit.redistribute`):
- `_any_cell_overflows(table, rows, col_w, row_h)` → `True` if any provided cell
  has `len(str(val))` greater than `estimate_max_chars(col_w[c], row_h[r],
  cell_font)[0]` (cell_font = the cell's first-run pt or `_BASE_PT`).
- `_resize_columns(rows, col_w)`: per-column demand = max `len(str(val))` over the
  provided cells in that column; returns
  `redistribute(demands, sum(col_w), int(MIN_COL_FRAC * sum(col_w)))`.
- `_resize_rows(table, rows, col_w, row_h)`: per-row demand = max `lines_needed`
  over the provided cells in that row, where
  `cpl = max(1, chars / lines)` from `estimate_max_chars(col_w[c], row_h[r],
  cell_font)` (i.e. `max_chars // lines`) and
  `lines_needed = ceil(len(str(val)) / cpl)`; returns
  `redistribute(demands, sum(row_h), int(MIN_ROW_FRAC * sum(row_h)))`.

`Emu` is imported from `pptx.util` (alongside the existing `Pt`).

`_fit_cell(cell, value, width_emu, height_emu) -> list[SlotError]`:
- `tf = cell.text_frame`; first paragraph `p0`, first run `r0`; original font pt
  from `r0.font.size.pt` or `_BASE_PT`.
- `capacity, _ = estimate_max_chars(width_emu, height_emu, orig_pt)`.
- If `len(value) <= capacity`: write `value` into `r0` (preserve styling), drop
  extra runs/paragraphs, no shrink, no warning.
- Else: shrink one step (`new_pt = max(_MIN_PT, orig_pt - _SHRINK_STEP)`),
  recompute capacity at `new_pt`
  (`capacity2 = int(capacity * (orig_pt / new_pt))`); if still over, truncate via
  `truncate_to_sentence(value, capacity2)` and append a `text_truncated`
  warning (`slot_id` = the cell, e.g. `f"cell[{r},{c}]"`); set `r0.font.size =
  Pt(new_pt)`.
- Mirror `_fill_text`'s run handling: if `r0` is `None` (empty cell), fall back to
  `cell.text = value` then set font on all runs.

Constants `_BASE_PT`, `_SHRINK_STEP`, `_MIN_PT` already exist in `filler.py`.

`fill_slot` already returns the text branch's warnings; update the table branch
from `_fill_table(...)` (discarded) to `return _fill_table(...)` so cell
truncation warnings propagate to the render response.

### 4. Shared capacity formula

`_fit_cell` imports `estimate_max_chars` from `autodetect.py` — its single
existing definition stays put; `filler.py` adds the import. No formula change, no
move (avoids touching every current caller).

## Data flow

```
Upload -> autodetect:
  classify shapes
  + NEW: demote text candidates inside a table bbox (>=0.6 area)
  -> draft.slides (no overlapping text slots)  -> editor / agent schema

Render -> fill_slot(table) -> _fill_table:
  if any cell overflows at base font:
    redistribute column widths by content demand (footprint fixed)
    redistribute row heights by lines-needed (footprint fixed)
  per cell: estimate capacity from (new col width, new row height, cell font)
            shrink + truncate to fit -> warnings
  -> render response includes text_truncated warnings
```

## Error handling / edges

- Cell value `None`/empty → skipped by `render`'s existing
  `if value is None or value == "": continue` (table slot value is the whole
  rows list, so empty cells inside a provided table are written as `str(val)`;
  `str(None)` is avoided by callers — values come as strings).
- More rows/cols provided than the table has → existing bounds check
  (`r < len(table.rows) and c < len(table.columns)`) keeps ignoring the excess;
  `validate`/`assess_table` already reject over `max_rows`/`max_cols`.
- A text box only marginally overlapping a table (< 0.6) stays a candidate — the
  threshold avoids demoting nearby titles.
- Two overlapping tables: a text box inside either is demoted (fraction taken vs
  any table). Tables themselves are never demoted.
- Merged cells: out of scope; `table.cell(r,c)` on a merged span returns the
  origin cell — fitting still runs without error, exact geometry approximate.
- Single column or single row → its demand list has one entry; `redistribute`
  returns the unchanged total (nothing to borrow from). No-op, safe.
- Row height is a PowerPoint **minimum** that grows to content; redistribution
  sets the minimums within the fixed total, so the rendered table stays within its
  footprint in the common case. Extreme content can still make a row grow past its
  allocation — per-cell shrink/truncate is the backstop.

## Testing

- `engine` (pytest):
  - `_rect_overlap_frac`: fully-contained box → ~1.0; disjoint → 0.0; half-in →
    ~0.5.
  - `redistribute`: higher demand gets more width; every slot ≥ `min_each`; sizes
    sum exactly to `total`; all-equal demands → even split; `total <= n*min_each`
    → even split.
  - `_fill_table` auto-size: a table with one over-long column widens that column
    (and narrows a slack one) and/or heightens the tall row **before** any font
    shrink; a table whose cells all fit is left at its original column/row sizes
    (no resize). Footprint (sum of widths, sum of heights) is unchanged.
  - autodetect differentiation: a slide with a table and a text box overlapping
    it (≥ 0.6) → the text box has `is_candidate False`; a text box above the
    table (no overlap) → stays `is_candidate True`; the table stays a candidate.
  - `_fit_cell`: a long value in a small cell → font reduced and/or value
    truncated with a `text_truncated` warning; a short value → unchanged font, no
    warning, cell text equals the value.
  - `_fill_table` returns the aggregated warnings and `fill_slot` propagates
    them (a render over a table with overflowing cells yields `text_truncated`
    warnings in the response).

## Out of scope

- Grid-of-text-boxes "table" detection (confirmed not needed — real tables).
- Uniform table-wide font (user chose per-cell independent).
- Free-text-card line-spacing overflow (report images 1–2) — separate spec.
- Expanding the table beyond its current footprint into free slide space (user
  chose redistribute-within-footprint only).
- Merged-cell exact geometry; auto-fitting column widths to exact glyph metrics.
- Changing `estimate_max_chars` constants (kept identical across the codebase).
