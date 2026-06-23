# Clear Unfilled / Surplus Template Content — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** Theme A of the VAPT-feedback sprint. Addresses feedback items
#2 (table filler leaves leftover rows) and #4 (mandatory image placeholders),
generalised to text slots that share the same root cause.

## Goal

Stop the template's **sample content** from leaking into rendered output when a
slot is unfilled or a table is only partially filled. Today a template ships
with example data baked into its shapes (placeholder picture, sample table rows,
sample heading text); the renderer only overwrites the shapes it fills, so any
slot left empty shows the template's example instead of nothing.

Three symptoms, one cause:

1. **Leftover table rows (#2).** `_fill_table` writes only the provided rows/
   cols. A table with fewer rows than the template keeps the template's surplus
   sample rows visible beneath the new data.
2. **Mandatory image placeholders (#4).** A slide's image slot is a placeholder/
   picture shape in the base PPTX. If the deck omits that slot, the gray
   placeholder remains on every slide of a text-only report.
3. **Leftover sample text (generalisation).** An unfilled text slot keeps the
   template's example heading/body text.

## Background

- `render(deck_spec, template)` in `engine/src/pptx_mcp/render.py`:
  ```
  for slot in st.slots:
      value = provided.get(slot.id, slot.default)
      if value is None or value == "":
          continue          # <-- unfilled slot: template sample content stays
      for w in fill_slot(prs.slides[i], slot, value): ...
  ```
  The `continue` is the bug: an empty slot is skipped, never cleared.
- `validate(deck_spec, template)` runs first and rejects a render when a
  `required` slot is empty and has no `default` (`missing_required_slot`). So
  only **optional / omitted** slots ever reach the empty branch — clearing them
  is safe and never erases content the author was forced to supply.
- `Slot` has `default: object = None`. An author who wants the same content on
  every deck sets `default`; omission therefore unambiguously means "nothing
  here", which is exactly what we clear.
- `fill_slot(slide, slot, value)` already dispatches by `slot.type`
  (`text`/`table`/`image`) and uses `find_shape(slide, slot.shape_id)`.
- `_fill_table(shape, rows)` (post table-fit work) blanks nothing first; it
  auto-sizes on overflow then writes the provided cells via `_fit_cell`.

## Decisions

1. **Scope = text + image + table** (user's choice). One general clearing
   mechanism covers all three, killing the whole class of ghost-content bugs,
   not just the two reported.
2. **Auto-clear all unfilled known slots; no new `nullable` field** (user's
   choice). Any schema slot that resolves to empty is cleared. "Keep the same
   content every deck" is expressed with `slot.default`, not by omission. This
   avoids the per-slot flag the feedback itself called friction.
3. **Tables: blank surplus cells, do not delete rows** (user's choice). Empty
   the text of every cell not written by the provided data; rows physically
   remain. Keeps the table's **fixed footprint**, which the table-fit
   redistribution work depends on. Row deletion (raw `<a:tr>` XML) is out of
   scope.
4. **Clearing lives in `filler.py`, mirroring `fill_slot`** (Option 1). A new
   `clear_slot(slide, slot)` dispatches by type; `render.py` routes the empty
   branch to it. Clearing logic sits beside filling logic, is unit-testable in
   isolation, and keeps `render.py` free of shape-manipulation detail.
5. **Filled slots are never cleared.** `_fit_cell`/`_fill_text` read run styling
   (font family, size, bold) to drive fitting; a blanket "reset slide" pre-pass
   was rejected because it would strip that styling and double the work.

## Components

### 1. `engine/src/pptx_mcp/filler.py` — `clear_slot` + per-type helpers

```
def clear_slot(slide, slot: Slot) -> None:
    try:
        shape = find_shape(slide, slot.shape_id)
    except KeyError:
        return  # slot's shape not on this slide -> nothing to clear
    if slot.type == "text":
        _clear_text(shape)
    elif slot.type == "image":
        _clear_image(slide, shape)
    elif slot.type == "table":
        _clear_table(shape)
```

Note: `find_shape(slide, shape_id)` **raises `KeyError`** when no shape matches
(it does not return `None`), so the guard is a `try/except KeyError`, not a
`None` check. `fill_slot` calls `find_shape` unguarded today; clearing adds the
guard because an omitted slot is a normal, expected case.

- `_clear_text(shape)` → `shape.text_frame.clear()`. python-pptx `clear()`
  removes all paragraphs except the first and empties it, so the template's
  sample text disappears and an empty text frame remains.
- `_clear_image(slide, shape)` → remove the shape element from the slide:
  `shape._element.getparent().remove(shape._element)`. The placeholder/picture
  is gone — no gray box, no empty outline.
- `_clear_table(shape)` → `for cell in every (r,c): cell.text = ""`. Blanks all
  sample data; the table keeps its rows and footprint.

`clear_slot` never raises: `find_shape`'s `KeyError` (slot's `shape_id` not
present on the assembled slide) is caught and turned into a silent no-op.

### 2. `engine/src/pptx_mcp/filler.py` — `_fill_table` blanks first

`_fill_table` gains a blank-all-cells pass **before** the overflow/auto-size/fit
logic:

```
def _fill_table(shape, rows):
    table = shape.table
    _blank_all_cells(table)          # NEW: clear template sample rows first
    warnings = []
    col_w = [...]; row_h = [...]
    if _any_cell_overflows(...): ...  # unchanged
    for r, row in enumerate(rows): ... # unchanged: fit provided cells
    return warnings
```

`_blank_all_cells(table)` sets `cell.text = ""` for every cell. Cells the
provided data writes are then overwritten by `_fit_cell`; cells outside the
provided extent stay blank. `_clear_table(shape)` reuses the same loop
(extract a shared `_blank_all_cells(table)` helper used by both).

This is what fixes the *partial*-table case (#2): a 4-row template table given
2 rows of data shows rows 1-2 filled and rows 3-4 empty.

### 3. `engine/src/pptx_mcp/render.py` — route empty slots to `clear_slot`

```
value = provided.get(slot.id, slot.default)
if value is None or value == "":
    clear_slot(prs.slides[i], slot)   # was: continue
    continue
```

Import `clear_slot` alongside the existing `fill_slot` import. No change to
validation, ordering, or warning collection.

## Data flow

```
render -> validate (unchanged; required+empty already rejected)
       -> assemble
       -> per slot:
            value empty? -> clear_slot(slide, slot)   [text blank | image removed | table cells blank]
            else         -> fill_slot(slide, slot, value)

_fill_table(shape, rows):
   blank ALL cells (removes template sample rows)
   if any provided cell overflows: redistribute col/row within fixed footprint
   fit each provided cell -> text_truncated warnings
```

## Error handling / edges

- **Missing shape:** `find_shape` raises `KeyError`; `clear_slot` catches it and
  no-ops. A deck referencing a slot whose shape was dropped does not crash.
- **Required slot empty:** never reaches clearing — `validate` rejects the
  render first (`missing_required_slot`). Unchanged.
- **Image already absent / non-picture shape:** removal is generic element
  detach, so any shape type the slot points at is removed cleanly.
- **Table given more rows/cols than the template:** existing bounds check
  (`r < len(table.rows) and c < len(table.columns)`) still ignores the excess;
  blank-first does not change that.
- **Filled slot:** untouched by clearing; run styling preserved for fit. No
  regression to `_fill_text` / `_fit_cell`.
- **`text_frame.clear()` on an already-empty frame:** harmless no-op.

## Testing

`engine` (pytest):

- `clear_slot` text: a textbox carrying sample text, slot omitted from the deck
  → rendered shape's text frame is empty.
- `clear_slot` image: a slide whose image slot is a placeholder/picture, slot
  omitted → that `shape_id` is absent from the slide's shapes after render
  (shape removed, no placeholder).
- `clear_slot` table (full omit): table slot omitted → every cell text is "".
- `_fill_table` partial: template table with 4 sample rows, deck provides 2 rows
  → rows 1-2 hold the new data, rows 3-4 cells are empty; footprint (sum of col
  widths, sum of row heights) unchanged.
- Regression: a filled text slot keeps its font family / size / bold (existing
  `_fill_text` styling tests still pass).
- Render integration: a deck that omits an optional image slot renders with no
  placeholder shape on that slide and produces no warning for it.

## Out of scope

- Deleting surplus table rows / shrinking the table footprint (blank-only;
  footprint stays fixed for table-fit).
- A `Slot.nullable` field (auto-clear of all unfilled slots replaces it).
- Agenda static numbering (#5) — separate.
- Constraint-cap relaxation (#1) — Theme D.
- The validate-only endpoint (#6/#9) and geometry-in-schema (#7) — Theme C.
