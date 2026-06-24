# Constraint & Repeatable Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the engine rejecting tables it could grow, and stop it hiding single-instance reusable layouts from the agent.

**Architecture:** Engine-only. (1) `_fill_table` grows the table grid by cloning the last `<a:tr>` so over-cap row counts render instead of being rejected; `assess_table` then drops its row reject (keeps the column reject). (2) `autodetect` flags a slide `repeatable` by its `kind` (finding/content) in addition to the existing structural-twin rule. The web app already carries `repeatable` and table warnings unchanged.

**Tech Stack:** Python 3, python-pptx (lxml under the hood), pytest.

## Global Constraints

- Grow **rows only**; columns stay capped — a column overflow remains a hard `table_overflow` reject. (spec Decision 1)
- A new row clones the **last `<a:tr>`** so it inherits that row's height/cell formatting; `_blank_all_cells` (already called in `_fill_table`) clears the cloned sample text. (spec Decision 2)
- Emit a `table_autogrew` warning when rows are added — never grow silently. (spec Decision 3)
- `REPEATABLE_KINDS = {"finding", "content"}` exactly — `agenda`, `summary`, `cover`, `closing`, `section`, `data` are NOT repeatable by kind. (spec Decision 4)
- The structural-twin rule (`counts[sig] >= 2`) is kept and OR'd, never replaced. (spec Decision 4)
- `slide_description`'s repeat hint must use the same `REPEATABLE_KINDS` set as the flag. (spec Decision 5)
- No web changes, no new network surface, no manifest/model schema change.

---

### Task 1: Table row growth in `_fill_table`

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (add `import copy` at top; add `_grow_table_rows`; call it at the top of `_fill_table`)
- Test: `engine/tests/test_filler.py`, `engine/tests/test_render.py`

**Interfaces:**
- Consumes: existing `_fill_table(shape, rows) -> list[SlotError]`, `_blank_all_cells(table)`, `SlotError(slide_index, slot_id, code, message)`, and the `_deck_with_table(rows, cols, col_w, row_h)` test helper in `test_filler.py`.
- Produces: `_grow_table_rows(table, needed: int) -> int` (rows added); a `table_autogrew` warning code emitted by `_fill_table` when it grows the grid.

- [ ] **Step 1: Write the failing unit tests for `_grow_table_rows`**

Append to `engine/tests/test_filler.py` (the `_deck_with_table` helper already exists earlier in the file):

```python
from pptx_mcp.filler import _grow_table_rows


def test_grow_table_rows_adds_until_needed():
    prs, slide, gf, table = _deck_with_table(2, 3)
    added = _grow_table_rows(table, 5)
    assert added == 3
    assert len(table.rows) == 5
    assert len(table.columns) == 3   # columns unchanged


def test_grow_table_rows_noop_when_enough():
    prs, slide, gf, table = _deck_with_table(4, 2)
    assert _grow_table_rows(table, 4) == 0
    assert _grow_table_rows(table, 2) == 0
    assert len(table.rows) == 4
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_filler.py::test_grow_table_rows_adds_until_needed tests/test_filler.py::test_grow_table_rows_noop_when_enough -v`
Expected: FAIL with `ImportError: cannot import name '_grow_table_rows'`.

- [ ] **Step 3: Add `import copy` and `_grow_table_rows`**

At the top of `engine/src/pptx_mcp/filler.py`, add `import copy` to the stdlib import block (alongside `import base64`, `import io`, `import logging`, `import math`):

```python
import base64
import copy
import io
import logging
import math
```

Add this function just above `def _fill_table(` (near line 225):

```python
def _grow_table_rows(table, needed: int) -> int:
    """Append rows (cloning the last <a:tr>) until the grid has `needed` rows.

    Returns the number of rows added. No-op if the table has no rows to clone
    from or already has enough. The clone inherits the last row's height and
    cell formatting; callers blank the cloned sample text before filling.
    """
    have = len(table.rows)
    if have == 0 or needed <= have:
        return 0
    tbl = table._tbl
    last_tr = tbl.tr_lst[-1]
    for _ in range(needed - have):
        tbl.append(copy.deepcopy(last_tr))
    return needed - have
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_filler.py::test_grow_table_rows_adds_until_needed tests/test_filler.py::test_grow_table_rows_noop_when_enough -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Write the failing test for `_fill_table` growth + warning**

Append to `engine/tests/test_filler.py`:

```python
def test_fill_table_grows_grid_for_extra_rows():
    prs, slide, gf, table = _deck_with_table(2, 2)
    warnings = _fill_table(gf, [["A0", "A1"], ["B0", "B1"],
                                ["C0", "C1"], ["D0", "D1"]])
    assert len(table.rows) == 4
    assert table.cell(2, 0).text == "C0"
    assert table.cell(3, 1).text == "D1"
    assert any(w.code == "table_autogrew" for w in warnings)


def test_fill_table_no_grow_warning_when_it_fits():
    prs, slide, gf, table = _deck_with_table(4, 2)
    warnings = _fill_table(gf, [["A0", "A1"], ["B0", "B1"]])
    assert not any(w.code == "table_autogrew" for w in warnings)
```

- [ ] **Step 6: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_filler.py::test_fill_table_grows_grid_for_extra_rows -v`
Expected: FAIL — `table.cell(2, 0)` raises `IndexError` (grid still 2 rows) because `_fill_table` does not yet grow.

- [ ] **Step 7: Wire growth into `_fill_table`**

In `engine/src/pptx_mcp/filler.py`, change the top of `_fill_table`. The current body begins:

```python
def _fill_table(shape, rows: list[list]) -> list[SlotError]:
    table = shape.table
    _blank_all_cells(table)          # drop template sample rows before filling
    warnings: list[SlotError] = []
    col_w = [table.columns[c].width for c in range(len(table.columns))]
    row_h = [table.rows[r].height for r in range(len(table.rows))]
```

Replace those lines with (grow BEFORE blanking and BEFORE the `col_w`/`row_h` snapshots, so the new rows are blanked and sized):

```python
def _fill_table(shape, rows: list[list]) -> list[SlotError]:
    table = shape.table
    warnings: list[SlotError] = []
    added = _grow_table_rows(table, len(rows))
    if added:
        warnings.append(SlotError(0, None, "table_autogrew",
                                  f"added {added} row(s) to fit {len(rows)} rows"))
    _blank_all_cells(table)          # drop template sample rows (incl. clones) before filling
    col_w = [table.columns[c].width for c in range(len(table.columns))]
    row_h = [table.rows[r].height for r in range(len(table.rows))]
```

(The rest of `_fill_table` is unchanged. `warnings` is now created before the grow check; the auto-size block and `_fit_cell` loop that follow keep appending to it.)

- [ ] **Step 8: Run to verify the `_fill_table` tests pass**

Run: `cd engine && python -m pytest tests/test_filler.py -v`
Expected: PASS — all filler tests, including `test_fill_table_grows_grid_for_extra_rows`, `test_fill_table_no_grow_warning_when_it_fits`, and the pre-existing `test_fill_table_partial_blanks_surplus_template_rows`.

- [ ] **Step 9: Commit**

(The render-level integration test belongs in Task 2, where validation is relaxed so it can pass — it is intentionally NOT added here, to avoid committing a red test.)

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(engine): grow table grid (clone last row) to fit over-cap row counts in _fill_table"
```

---

### Task 2: Relax the row reject in `assess_table`

**Files:**
- Modify: `engine/src/pptx_mcp/fit.py:15-21` (`assess_table` — remove the `max_rows` branch)
- Test: `engine/tests/test_fit.py`, `engine/tests/test_validate.py`, `engine/tests/test_render.py`

**Interfaces:**
- Consumes: `assess_table(rows, c) -> tuple[str, str]`, `Constraints(max_rows, max_cols)`. The sample `data` slot caps are `max_rows=5, max_cols=4`; the sample table grid is 2×2 (`engine/tests/conftest.py`). Task 1's `_fill_table` already grows the grid and emits a `table_autogrew` warning; `render()` reassigns each warning's `slide_index`.
- Produces: `assess_table` no longer returns `"reject"` for row overflow; it still returns `"reject"` for column overflow. With the row reject gone, a row-overflow deck now renders end-to-end (Task 1's grow path).

- [ ] **Step 1: Update the `assess_table` unit tests (row no longer rejects; col still does)**

In `engine/tests/test_fit.py`, **replace** `test_table_reject_rows` and `test_table_reject_message_has_numbers` with row-OK + column-reject tests, and keep `test_table_ok`:

```python
def test_table_many_rows_ok():
    # rows over max_rows are no longer a validation reject (filler grows the grid)
    d, _ = assess_table([[1]] * 9, Constraints(max_rows=3, max_cols=3))
    assert d == "ok"


def test_table_reject_cols():
    d, msg = assess_table([[1, 2, 3, 4, 5]], Constraints(max_rows=3, max_cols=3))
    assert d == "reject"
    assert "col" in msg.lower()


def test_table_reject_cols_message_has_numbers():
    d, msg = assess_table([[1, 2, 3, 4, 5]], Constraints(max_rows=5, max_cols=3))
    assert d == "reject"
    assert "3" in msg and "5" in msg
```

- [ ] **Step 2: Run to verify the new col tests fail / the row test passes-by-accident**

Run: `cd engine && python -m pytest tests/test_fit.py -v`
Expected: `test_table_many_rows_ok` FAILS (current code still rejects rows: a 9-row table with `max_rows=3` returns `"reject"` before reaching the col check). `test_table_reject_cols*` PASS (col reject already works).

- [ ] **Step 3: Remove the row reject from `assess_table`**

In `engine/src/pptx_mcp/fit.py`, replace the whole `assess_table` function:

```python
def assess_table(rows: list[list[object]], c: Constraints) -> tuple[str, str]:
    cols = max((len(r) for r in rows), default=0)
    if c.max_cols is not None and cols > c.max_cols:
        return "reject", f"max {c.max_cols} cols, got {cols}"
    return "ok", ""
```

(The `max_rows` branch is deleted. `assess_text` above it is unchanged.)

- [ ] **Step 4: Run the fit tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_fit.py -v`
Expected: PASS (all, including `test_table_many_rows_ok`, `test_table_reject_cols`, `test_table_reject_cols_message_has_numbers`, `test_table_ok`).

- [ ] **Step 5: Migrate the validate-level reject tests from rows to columns**

In `engine/tests/test_validate.py`, **replace** `test_table_overflow_rejects` and `test_table_overflow_message_has_numbers` (both currently feed `[[1, 2]] * 9` row-overflow) with column-overflow versions. The `data` slot is `max_cols=4`:

```python
def test_table_col_overflow_rejects(sample_template_dir):
    tpl = load_template(sample_template_dir)
    rows = [[1, 2, 3, 4, 5]]  # 5 cols > max_cols 4
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    assert any(e.code == "table_overflow" for e in errs)


def test_table_row_overflow_not_rejected(sample_template_dir):
    # rows over max_rows are no longer a validation error (filler grows the grid)
    tpl = load_template(sample_template_dir)
    rows = [[1, 2]] * 9  # 9 > max_rows 5
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    assert not any(e.code == "table_overflow" for e in errs)
    assert errs == []


def test_table_col_overflow_message_has_numbers(sample_template_dir):
    tpl = load_template(sample_template_dir)
    rows = [[1, 2, 3, 4, 5]]  # 5 cols > max_cols 4
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    e = next(e for e in errs if e.code == "table_overflow")
    assert "4" in e.message and "5" in e.message
```

- [ ] **Step 6: Write the render-level integration test (now that validation is relaxed)**

A 6-row deck exceeds both the 2×2 grid and the old `max_rows=5` cap; with the row reject gone, `render` reaches Task 1's grow path. Append to `engine/tests/test_render.py`:

```python
def test_render_grows_table_beyond_row_cap(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.render import render
    tpl = load_template(sample_template_dir)
    rows = [["r%d-c0" % i, "r%d-c1" % i] for i in range(6)]  # 6 > grid 2, > max_rows 5
    data, warnings = render({"slides": [
        {"slide_type": "table", "slots": {"data": rows}},
    ]}, tpl)
    assert isinstance(data, bytes) and len(data) > 0           # rendered, not rejected
    grow = [w for w in warnings if w["code"] == "table_autogrew"]
    assert len(grow) == 1
    assert grow[0]["slide_index"] == 0                         # reassigned by render()
```

- [ ] **Step 7: Run validate + render tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_validate.py tests/test_render.py::test_render_grows_table_beyond_row_cap -v`
Expected: PASS — the new validate tests pass, and `test_render_grows_table_beyond_row_cap` is green (validation no longer rejects the 6-row deck, so `render` reaches `_fill_table` and grows the grid).

- [ ] **Step 8: Commit**

```bash
git add engine/src/pptx_mcp/fit.py engine/tests/test_fit.py engine/tests/test_validate.py engine/tests/test_render.py
git commit -m "feat(engine): assess_table stops rejecting row overflow (grid grows); columns stay capped"
```

---

### Task 3: Kind-based repeatable in `autodetect`

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py` (add `REPEATABLE_KINDS`; update the repeatable assignment ~line 321; update `slide_description` ~line 103)
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `autodetect(pptx_bytes) -> {"slides": [...]}` with per-slide `kind` and `repeatable`; `slide_description(kind, slot_ids) -> str`; `slide_kind(...)`. Reminder from the codebase: `slide_kind` returns `cover` when `index == 0 OR (has_subtitle and num_text <= 3)`, so a slide with a title + one shape below it (which `derive_ids` labels `subtitle`) is `cover` unless it has **4+** text shapes. Test fixtures for `finding`/`content` therefore use 4 textboxes at index > 0.
- Produces: `repeatable` true for single-instance `finding`/`content` slides; `slide_description` appends "Repeat per item." for any `REPEATABLE_KINDS` kind.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_autodetect.py` (the file already imports `autodetect` and uses `_finding_like`):

```python
def _plain_slide(slide, texts):
    from pptx.util import Inches, Pt
    for i, t in enumerate(texts):
        tb = slide.shapes.add_textbox(Inches(1), Inches(0.5 + i * 1.3), Inches(8), Inches(1))
        tb.text_frame.text = t
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(18)


def test_single_content_slide_repeatable_by_kind(tmp_path):
    from pptx import Presentation
    prs = Presentation()
    blank = prs.slide_layouts[6]
    _plain_slide(prs.slides.add_slide(blank), ["Cover Title"])          # idx 0 -> cover
    _plain_slide(prs.slides.add_slide(blank),                            # idx 1 -> content
                 ["Background", "Goals of the project", "Scope notes", "Other detail"])
    p = tmp_path / "content.pptx"
    prs.save(str(p))
    slides = autodetect(p.read_bytes())["slides"]
    assert slides[1]["kind"] == "content"
    assert slides[1]["repeatable"] is True      # single instance, flagged by kind
    assert slides[0]["repeatable"] is False     # cover is not repeatable


def test_single_finding_slide_repeatable_by_kind(tmp_path):
    from pptx import Presentation
    prs = Presentation()
    blank = prs.slide_layouts[6]
    _plain_slide(prs.slides.add_slide(blank), ["Cover Title"])          # idx 0 -> cover
    _plain_slide(prs.slides.add_slide(blank),                            # idx 1 -> finding
                 ["Finding F1", "Severity: HIGH", "CWE-89 details", "Remediation steps"])
    p = tmp_path / "finding.pptx"
    prs.save(str(p))
    slides = autodetect(p.read_bytes())["slides"]
    assert slides[1]["kind"] == "finding"
    assert slides[1]["repeatable"] is True


def test_single_summary_slide_not_repeatable(tmp_path):
    from pptx import Presentation
    prs = Presentation()
    blank = prs.slide_layouts[6]
    _plain_slide(prs.slides.add_slide(blank), ["Cover Title"])          # idx 0 -> cover
    _plain_slide(prs.slides.add_slide(blank),                            # idx 1 -> summary
                 ["Executive Summary", "Point one here", "Point two here", "Point three"])
    p = tmp_path / "summary.pptx"
    prs.save(str(p))
    slides = autodetect(p.read_bytes())["slides"]
    assert slides[1]["kind"] == "summary"
    assert slides[1]["repeatable"] is False     # summary kind is not repeatable


def test_slide_description_repeat_hint_for_content():
    from pptx_mcp.autodetect import slide_description
    assert "Repeat per item" in slide_description("content", ["body"])
    assert "Repeat per item" in slide_description("finding", ["title"])
    assert "Repeat per item" not in slide_description("cover", ["title"])
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_autodetect.py::test_single_content_slide_repeatable_by_kind tests/test_autodetect.py::test_single_finding_slide_repeatable_by_kind tests/test_autodetect.py::test_slide_description_repeat_hint_for_content -v`
Expected: FAIL — `repeatable` is `False` for the single content/finding slides (only twins are flagged today), and `slide_description("content", ...)` lacks "Repeat per item".

- [ ] **Step 3: Add `REPEATABLE_KINDS` and use it in both places**

In `engine/src/pptx_mcp/autodetect.py`, add the constant next to `_KIND_LABEL` (after line 77):

```python
REPEATABLE_KINDS = {"finding", "content"}
```

Change the repeatable assignment (currently `s["repeatable"] = counts[sig] >= 2`, ~line 321):

```python
    for s, sig in zip(slides, sigs):
        s["repeatable"] = counts[sig] >= 2 or s["kind"] in REPEATABLE_KINDS
```

Change the repeat hint in `slide_description` (currently `repeat = " Repeat per item." if kind == "finding" else ""`, ~line 103):

```python
    repeat = " Repeat per item." if kind in REPEATABLE_KINDS else ""
```

- [ ] **Step 4: Run to verify the new tests pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS — the new tests pass, and the pre-existing `test_repeatable_marks_structural_twins` (twin rule) and `test_slide_description_lists_slots_and_repeat_hint` still pass.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): flag single-instance finding/content slides repeatable by kind"
```

---

### Task 4: Whole-engine regression gate

**Files:** none (verification only — no source change, no commit unless a regression surfaces).

**Interfaces:**
- Consumes: the full engine test suite.
- Produces: confirmation that Tasks 1-3 broke nothing across filler, render, fit, validate, autodetect, schema, mcp_server, tablefit, textfit.

- [ ] **Step 1: Run the full engine suite**

Run: `cd engine && python -m pytest -q`
Expected: all pass (1 pre-existing skip is fine). In particular confirm the table-fit suite (`test_filler.py`, `test_tablefit.py`), clear-content cases, and `test_autodetect_real.py` are green — the grow runs before blank+size, and the `assess_table` column path is unchanged.

- [ ] **Step 2: If anything fails, fix and commit; otherwise report green**

If a regression appears, fix it in the smallest way consistent with the spec, re-run the affected file, then `git add`/`git commit` with a `fix(engine):` message. If the suite is green, no commit is needed — report the pass count.

---

## Self-Review

**Spec coverage:**
- #1 table row overflow → Task 1 (grow grid + warning) + Task 2 (drop row reject, keep col reject). ✓
- #3 single-instance repeatable → Task 3 (`REPEATABLE_KINDS`, OR with twin count, consistent description hint). ✓
- Spec testing list (`_grow_table_rows`, `_fill_table`, `assess_table`, `validate`, autodetect repeatable, `slide_description`) → covered across Tasks 1-3; whole-suite regression → Task 4. ✓
- Out-of-scope (no column growth, no large-table cap, no editor toggle, no web change) → respected; no task touches them. ✓

**Placeholder scan:** none — every code step shows full code; every run step shows the exact command and expected result.

**Type consistency:** `_grow_table_rows(table, needed: int) -> int` defined in Task 1, referenced consistently in Tasks 1/4. `table_autogrew` warning code spelled identically in filler code, filler tests, and the render test. `REPEATABLE_KINDS` set spelled identically in the constant, the repeatable assignment, and `slide_description`. Sample-template caps (`max_rows=5, max_cols=4`) and grid (2×2) match `conftest.py`.
