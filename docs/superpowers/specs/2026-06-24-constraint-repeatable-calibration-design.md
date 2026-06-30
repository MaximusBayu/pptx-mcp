# Constraint & Repeatable Calibration — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** Theme D of the VAPT-feedback sprint. Addresses feedback #1
(constraint caps reject content the engine could accommodate) and #3 (layouts
meant to be reused are not flagged repeatable unless they have a structural
twin in the template).

## Goal

Stop the engine from being stricter than it is capable, and stop it from hiding
reusable layouts from the agent:

1. **Table row overflow (#1).** A deck whose table has more rows than the
   template grid is rejected outright today. Grow the grid to fit instead, so
   the content renders without data loss. Columns stay capped.
2. **Single-instance repeatable (#3).** A layout that appears once but is
   semantically a per-item pattern (a finding, a content body) is flagged
   `repeatable = false`, so the routing scorer penalises the agent for reusing
   it. Flag such layouts repeatable by their `kind`, not only by twin count.

Both are engine-only. The web app already carries whatever `repeatable` the
engine sets, and already surfaces table warnings.

## Background

- `assess_table(rows, c)` (`fit.py`) returns `("reject", msg)` when
  `len(rows) > c.max_rows` **or** `cols > c.max_cols`. `validate()`
  (`validate.py:42`) turns that into a `table_overflow` `SlotError`, which
  `render()` raises as `RenderRejected` — the whole deck fails.
- `assess_text` was already softened to `"shrink"` (never rejects); tables are
  the remaining hard-reject path.
- `_fill_table(shape, rows)` (`filler.py:225`) writes into the existing
  `table.rows`/`table.columns` and **silently skips** any data row
  `r >= len(table.rows)` or col `c >= len(table.columns)` (`filler.py:148-152`,
  `244`). It does **not** grow the grid. So softening the reject naively would
  drop rows quietly — worse than rejecting.
- `suggested_max_rows`/`suggested_max_cols` are autodetected as the template
  table's actual grid size: `len(shp.table.rows)` / `len(shp.table.columns)`
  (`autodetect.py:284-285`). The cap **is** the grid.
- `_fill_table` already calls `_blank_all_cells(table)` first (drops the
  template's sample rows) and emits per-cell truncation warnings via
  `_fit_cell`. Theme C's `dry_run` surfaces these warnings without a render.
- `repeatable` is computed per slide in `autodetect()`:
  `s["repeatable"] = counts[sig] >= 2` (`autodetect.py:321`), where `sig` is a
  structural fingerprint (`slide_signature`). It flows unchanged through
  `EditClient.tsx` (`repeatable: sl.repeatable ?? false`) → `PUT
  /api/templates/[id]` (`route.ts:41`) → manifest → `schema.ts` (`st.repeatable
  ?? false`) and `routing.ts` (the repetition penalty, `routing.ts:98`).
- `slide_kind(...)` (`autodetect.py:80`) returns one of: `cover`, `agenda`,
  `summary`, `finding`, `data`, `closing`, `section`, `content`.
- `slide_description(kind, slot_ids)` (`autodetect.py:100`) appends
  `" Repeat per item."` only when `kind == "finding"`.

## Decisions

1. **Grow rows, keep columns capped** (user's choice). Rows are the common
   variable-length-list overflow; growing them is a localized XML clone.
   Columns are structurally fixed by the template design — growing a column
   means re-celling every row and redistributing widths (high cost, rare need),
   so a column overflow stays a hard reject.
2. **Clone the last `<a:tr>`** to add a row. The new row inherits the last
   row's height and cell formatting — the right visual default — and
   `_blank_all_cells` (already called) clears the cloned sample text.
3. **Emit a `table_autogrew` warning** when rows are added, so the author (and
   the dry-run validate) sees that the template grid was extended rather than
   silently mutated.
4. **Repeatable by kind OR twin count** (user's choice).
   `REPEATABLE_KINDS = {"finding", "content"}` — the two kinds that are body
   patterns meant to recur. `agenda`, `summary`, `cover`, `closing`, `section`
   are once-per-deck; `data` is excluded conservatively (a single data slide is
   more often a one-off than a per-item pattern). The structural-twin rule is
   kept and OR'd, so existing multi-twin detection is unchanged.
5. **Keep description and flag consistent.** The `slide_description` repeat hint
   widens from `kind == "finding"` to `kind in REPEATABLE_KINDS`, so the human
   sentence matches the machine flag.

## Components

### D1 — Table row growth

**1. `engine/src/pptx_mcp/filler.py` — `_grow_table_rows`**

```
def _grow_table_rows(table, needed: int) -> int:
    """Append rows (cloning the last <a:tr>) until the grid has `needed` rows.
    Returns the number of rows added. No-op if the table has no rows to clone
    or already has enough."""
    have = len(table.rows)
    if have == 0 or needed <= have:
        return 0
    tbl = table._tbl
    last_tr = tbl.tr_lst[-1]
    for _ in range(needed - have):
        tbl.append(copy.deepcopy(last_tr))
    return needed - have
```

Called at the **top of `_fill_table`**, before `_blank_all_cells`:

```
def _fill_table(shape, rows: list[list]) -> list[SlotError]:
    table = shape.table
    warnings: list[SlotError] = []
    added = _grow_table_rows(table, len(rows))
    if added:
        warnings.append(SlotError(0, None, "table_autogrew",
                                  f"added {added} row(s) to fit {len(rows)} rows"))
    _blank_all_cells(table)          # clears cloned sample text too
    ...
```

`import copy` at the top of `filler.py`. The existing `col_w`/`row_h` snapshots
(`filler.py:229-230`) are taken **after** the grow, so the new rows are
included in sizing. The `r < len(table.rows)` guards downstream now always pass
for provided rows (the grid is large enough), but stay as-is for safety. The
`slide_index`/`slot_id` on the warning are placeholders that `render.py:33`
reassigns to the real slide index, exactly like the `_fit_cell` warnings.

**2. `engine/src/pptx_mcp/fit.py` — `assess_table` drops the row reject**

```
def assess_table(rows: list[list[object]], c: Constraints) -> tuple[str, str]:
    cols = max((len(r) for r in rows), default=0)
    if c.max_cols is not None and cols > c.max_cols:
        return "reject", f"max {c.max_cols} cols, got {cols}"
    return "ok", ""
```

The `max_rows` branch is removed — row overflow is no longer a validation
error, because the filler grows the grid. Column overflow is still rejected
(unchanged message/behaviour).

### D2 — Single-instance repeatable

**3. `engine/src/pptx_mcp/autodetect.py` — kind-based repeatable**

Add a module-level constant near the other detection constants:

```
REPEATABLE_KINDS = {"finding", "content"}
```

Change the repeatable assignment (`autodetect.py:321`):

```
for s, sig in zip(slides, sigs):
    s["repeatable"] = counts[sig] >= 2 or s["kind"] in REPEATABLE_KINDS
```

**4. `engine/src/pptx_mcp/autodetect.py` — consistent description hint**

`slide_description` (`autodetect.py:103`):

```
repeat = " Repeat per item." if kind in REPEATABLE_KINDS else ""
```

## Data flow

```
#1  validate(deck) -> assess_table: col-overflow rejects, row-overflow OK
    render(deck) -> _fill_table -> _grow_table_rows(table, len(rows))
                 -> clone last <a:tr> * (needed-have) -> table_autogrew warning
                 -> _blank_all_cells -> size + fit cells -> warnings
                 -> render.py reassigns warning.slide_index

#3  autodetect(prs) -> per slide kind = slide_kind(...)
                    -> repeatable = twins>=2 OR kind in REPEATABLE_KINDS
                    -> slides[].repeatable -> manifest -> schema.ts / routing.ts
```

## Error handling / edges

- **Table with 0 rows:** `_grow_table_rows` returns 0 (nothing to clone); the
  existing skip guards leave the empty table untouched. No crash.
- **More data rows than grid, growth succeeds:** all rows placed; one
  `table_autogrew` warning; no reject.
- **More data columns than grid:** still a `table_overflow` reject at validate;
  the filler is never reached. Unchanged.
- **Cloned row formatting:** inherits the last row (height, fonts, borders);
  `_blank_all_cells` clears its text before fill. Per-cell auto-fit then
  applies as for any other row.
- **Repeatable back-compat:** a layout that was already `repeatable` via twin
  count stays `repeatable` (OR keeps it). Only single-instance `finding`/
  `content` slides flip `false -> true`. `cover`/`agenda`/`summary`/`closing`/
  `section`/`data` single instances stay `false`.

## Security

- No new network surface, no auth change, no new input parsing. `_grow_table_rows`
  operates on the already-loaded template's own XML (a `deepcopy` of an element
  from the same tree); it does not read external data. Row growth is bounded by
  the caller's `len(rows)`, which validation has already shaped.

## Testing

- **engine `_grow_table_rows`:** a 2-row template table grown to 5 rows →
  `len(table.rows) == 5`, returns 3; a 0-row table → returns 0, unchanged;
  `needed <= have` → returns 0.
- **engine `_fill_table`:** rows > grid → all provided values land in the right
  cells, a `table_autogrew` warning is returned, no exception; rows <= grid →
  no `table_autogrew` warning, behaviour unchanged.
- **engine `assess_table`:** row overflow → `("ok", "")`; col overflow →
  `("reject", ...)`; within caps → `("ok", "")`.
- **engine `validate`:** a deck with a row-overflowing table → no
  `table_overflow` error; a col-overflowing table → still one `table_overflow`.
- **engine `autodetect`/repeatable:** a single `content` slide → `repeatable`
  True; a single `finding` slide → True; a single `cover` slide → False;
  two structural twins → both True (twin rule intact).
- **engine `slide_description`:** a `content` kind description ends with
  "Repeat per item."; a `cover` kind does not.
- **Regression:** existing table-fit / clear-content / autodetect suites stay
  green (the grow runs before blank+size; `assess_table` col path unchanged).

## Out of scope

- Growing **columns** (structurally fixed; col overflow stays a reject).
- An upper bound / pagination for very large tables (YAGNI; row count is
  author-shaped, and oversized tables overflow the slide visually, which the
  per-cell fit already shrinks toward).
- An editor toggle for `repeatable` (kind-based default covers the headless
  agent that filed #3; a human override is a separate follow-up).
- Agenda dynamic numbering (#5) and preview timeout (#8) — Theme E.
