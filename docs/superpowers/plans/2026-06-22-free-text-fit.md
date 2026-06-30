# Free-Text Fit — Geometry-Aware Shrink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop free-text blocks from overflowing their boxes by fitting every text slot to its box at render time — reducing line spacing first, then font, then truncating — applied unconditionally (not only when a `max_chars`/`max_lines` constraint is set).

**Architecture:** A new pure function `fit_text` in `engine/src/pptx_mcp/textfit.py` measures wrapped-line capacity against the box and returns a `FitResult(font_pt, line_spacing, value, dropped)`. `engine/src/pptx_mcp/filler.py` `_fill_text` calls it on every text slot, sets `word_wrap=True`, resolves the paragraph's base line spacing, applies the result, and preserves the template's run styling. The existing `max_chars` cap is preserved as an additional truncation after the geometric fit.

**Tech Stack:** Python, python-pptx, pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-22-text-fit-linespacing-design.md`

## Global Constraints

- Degrade order: **spacing → font → truncate** (reduce line spacing first, then font, then truncate at a sentence/word boundary).
- `LINE_SPACING_FLOOR = 0.9` — line spacing never goes below this; the largest spacing that fits is chosen.
- `SPACING_STEP = 0.05`; `FONT_STEP = 4.0` (mirrors `filler._SHRINK_STEP`).
- Fit is applied **unconditionally** to every text slot, regardless of constraints.
- Reuse `GLYPH_W = 0.5`, `EMU_PER_PT = 12700`, `LINE_H = 1.2` by importing them from `autodetect.py` (single source — do NOT redefine).
- Reuse `truncate_to_sentence` from `textfit.py` for the truncate step.
- Set `text_frame.word_wrap = True` on every filled text frame.
- Existing template run styling (font family, bold/italic, color) must be preserved — write into the existing first run, exactly as `_fill_text` does today.
- The existing `max_chars` constraint cap still applies: after the geometric fit, if `max_chars` is set and the value still exceeds it, truncate to `max_chars` and merge into the dropped text.
- `assess_text` stays in `fit.py` (other callers/tests use it); it no longer drives `_fill_text`.

---

### Task 1: `fit_text` geometry-aware fitter in `textfit.py`

**Files:**
- Modify: `engine/src/pptx_mcp/textfit.py` (add `FitResult`, constants, helpers, `fit_text`; keep `truncate_to_sentence`)
- Test: `engine/tests/test_textfit.py` (add cases; keep the existing four)

**Interfaces:**
- Consumes: `GLYPH_W`, `EMU_PER_PT`, `LINE_H` from `engine/src/pptx_mcp/autodetect.py`; `truncate_to_sentence` (same module).
- Produces:
  - `@dataclass FitResult: font_pt: float; line_spacing: float; value: str; dropped: str`
  - `LINE_SPACING_FLOOR = 0.9`, `SPACING_STEP = 0.05`, `FONT_STEP = 4.0`
  - `fit_text(value: str, width_emu: int, height_emu: int, base_pt: float, font_floor_pt: float, base_spacing: float) -> FitResult`

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/test_textfit.py` (keep the existing `truncate_to_sentence` tests; add the import line and these tests):
```python
from pptx_mcp.textfit import fit_text, FitResult, LINE_SPACING_FLOOR


# Box geometry chosen so the fit decisions are deterministic.
# EMU_PER_PT=12700, GLYPH_W=0.5, LINE_H=1.2.
_W = 2_000_000   # ~17 chars/line at 18pt
_H = 450_000     # 1 line at 18pt/1.2 spacing; more as spacing/font shrink


def test_fit_short_text_in_large_box_unchanged():
    res = fit_text("Hello", 10_000_000, 5_000_000, 18.0, 10.0, 1.2)
    assert res.font_pt == 18.0
    assert res.line_spacing == 1.2
    assert res.value == "Hello"
    assert res.dropped == ""


def test_fit_reduces_spacing_first_keeping_font():
    # 30 chars on one line -> 2 wrapped lines; box too short at 1.2 spacing,
    # fits once spacing drops below base (font stays at base).
    res = fit_text("abcdefghij abcdefghij abcdefgh", _W, _H, 18.0, 10.0, 1.2)
    assert res.font_pt == 18.0
    assert LINE_SPACING_FLOOR <= res.line_spacing < 1.2
    assert res.dropped == ""


def test_fit_reduces_font_after_spacing_floored():
    # 60 chars -> needs more lines than fit even at the spacing floor;
    # font shrinks (spacing pinned at the floor).
    res = fit_text("x" * 60, _W, _H, 18.0, 10.0, 1.2)
    assert res.line_spacing == LINE_SPACING_FLOOR
    assert 10.0 <= res.font_pt < 18.0
    assert res.dropped == ""


def test_fit_truncates_at_floor_when_nothing_fits():
    long = ("Sentence one is here. Sentence two follows on. "
            "Sentence three keeps going. " * 6)
    res = fit_text(long, _W, _H, 18.0, 10.0, 1.2)
    assert res.font_pt == 10.0
    assert res.line_spacing == LINE_SPACING_FLOOR
    assert res.dropped != ""
    assert len(res.value) < len(long)


def test_fit_zero_dims_returns_input_unchanged():
    res = fit_text("anything at all", 0, 0, 18.0, 10.0, 1.2)
    assert res == FitResult(18.0, 1.2, "anything at all", "")
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `engine/`): `python -m pytest tests/test_textfit.py -v`
Expected: FAIL with `ImportError: cannot import name 'fit_text'` (the existing four `truncate_to_sentence` tests are collected but the import error aborts the module).

- [ ] **Step 3: Implement**

In `engine/src/pptx_mcp/textfit.py`, add at the top (keep the existing `import re`, `_SENTENCE`, and `truncate_to_sentence`):
```python
import math
from dataclasses import dataclass

from .autodetect import EMU_PER_PT, GLYPH_W, LINE_H

LINE_SPACING_FLOOR = 0.9
SPACING_STEP = 0.05
FONT_STEP = 4.0


@dataclass
class FitResult:
    font_pt: float
    line_spacing: float
    value: str
    dropped: str  # "" when nothing was truncated


def _chars_per_line(width_emu, font_pt) -> int:
    return max(1, int(width_emu / (font_pt * EMU_PER_PT * GLYPH_W)))


def _lines_needed(value, cpl) -> int:
    if not value:
        return 0
    return sum(max(1, math.ceil(len(line) / cpl)) for line in value.split("\n"))


def _avail_lines(height_emu, font_pt, spacing) -> int:
    return max(1, int(height_emu / (font_pt * EMU_PER_PT * spacing)))


def _fits(value, width_emu, height_emu, font_pt, spacing) -> bool:
    cpl = _chars_per_line(width_emu, font_pt)
    return _lines_needed(value, cpl) <= _avail_lines(height_emu, font_pt, spacing)


def fit_text(value, width_emu, height_emu, base_pt,
             font_floor_pt, base_spacing) -> FitResult:
    # Cannot measure an unknown box — leave the text as-is.
    if width_emu <= 0 or height_emu <= 0:
        return FitResult(base_pt, base_spacing, value, "")

    # 1. Spacing pass at base font: take the largest spacing in
    #    [LINE_SPACING_FLOOR, base_spacing] that fits.
    spacing = base_spacing
    while spacing >= LINE_SPACING_FLOOR:
        if _fits(value, width_emu, height_emu, base_pt, spacing):
            return FitResult(base_pt, round(spacing, 4), value, "")
        spacing = round(spacing - SPACING_STEP, 4)
    # Stepping may overshoot the floor (or base may start below it) — try the
    # floor explicitly so it is never skipped.
    if _fits(value, width_emu, height_emu, base_pt, LINE_SPACING_FLOOR):
        return FitResult(base_pt, LINE_SPACING_FLOOR, value, "")

    # 2. Font pass at the spacing floor.
    pt = round(base_pt - FONT_STEP, 4)
    while pt >= font_floor_pt:
        if _fits(value, width_emu, height_emu, pt, LINE_SPACING_FLOOR):
            return FitResult(pt, LINE_SPACING_FLOOR, value, "")
        pt = round(pt - FONT_STEP, 4)

    # 3. Truncate at floor font + floor spacing.
    capacity = (_chars_per_line(width_emu, font_floor_pt)
                * _avail_lines(height_emu, font_floor_pt, LINE_SPACING_FLOOR))
    kept, dropped = truncate_to_sentence(value, capacity)
    return FitResult(font_floor_pt, LINE_SPACING_FLOOR, kept, dropped)
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `engine/`): `python -m pytest tests/test_textfit.py -v`
Expected: PASS (the five new `fit_text` tests plus the four existing `truncate_to_sentence` tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/textfit.py engine/tests/test_textfit.py
git commit -m "feat(engine): geometry-aware fit_text (spacing then font then truncate)"
```

---

### Task 2: `_fill_text` uses `fit_text`

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py` (imports + `_fill_text`; add `_resolve_spacing`)
- Test: `engine/tests/test_filler.py` (replace `test_fill_text_shrinks_font`; add two; keep the rest)

**Interfaces:**
- Consumes: `fit_text` and `truncate_to_sentence` from `.textfit`; `LINE_H` from `.autodetect`; `Pt`, `Length` from `pptx.util`.
- Produces: no new public symbols; `_fill_text` behavior is geometry-driven.

- [ ] **Step 1: Write the failing tests**

In `engine/tests/test_filler.py`, **replace** `test_fill_text_shrinks_font` (the whole function, lines ~16-24) with the two tests below, and keep every other test unchanged:
```python
def test_fill_text_sets_word_wrap_and_preserves_styling(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")
    shp = find_shape(prs.slides[0], slot.shape_id)
    before_name = shp.text_frame.paragraphs[0].runs[0].font.name

    fill_slot(prs.slides[0], slot, "A reasonably long heading that should wrap and be fit to its box")

    tf = shp.text_frame
    assert tf.word_wrap is True
    p0 = tf.paragraphs[0]
    # Font name (family) preserved on the surviving run.
    assert p0.runs[0].font.name == before_name
    # Line spacing is resolved to a numeric multiple and never below the floor.
    from pptx_mcp.textfit import LINE_SPACING_FLOOR
    assert isinstance(p0.line_spacing, float)
    assert p0.line_spacing >= LINE_SPACING_FLOOR


def test_fill_text_no_warning_when_it_fits(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")
    warnings = fill_slot(prs.slides[0], slot, "Short")
    assert not any(w.code == "text_truncated" for w in warnings)
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `engine/`): `python -m pytest tests/test_filler.py -v`
Expected: FAIL — `test_fill_text_sets_word_wrap_and_preserves_styling` fails because the current `_fill_text` never sets `word_wrap` (it stays `None`/falsy) and never writes `line_spacing` (so `p0.line_spacing` is `None`, not a `float`).

- [ ] **Step 3: Implement**

In `engine/src/pptx_mcp/filler.py`:

3a. Replace the import block (lines 1-16) so it pulls `Length`, `fit_text`, and `LINE_H`, and drops the now-unused `assess_text`:
```python
import base64
import io
import logging
import urllib.request

from PIL import Image
from pptx.util import Length, Pt

from .assembler import find_shape
from .autodetect import LINE_H
from .models import Slot, SlotError
from .textfit import fit_text, truncate_to_sentence

_BASE_PT = 24.0
_SHRINK_STEP = 4.0
_MIN_PT = 12.0
_IMG_MAX_BYTES = 20 * 1024 * 1024
```

3b. Add the spacing resolver above `_fill_text`:
```python
def _resolve_spacing(p0, orig_pt) -> float:
    # python-pptx line_spacing is None, a float multiple, or a Length (fixed
    # distance). Resolve to a multiple. Length subclasses int, so check it first.
    ls = p0.line_spacing if p0 is not None else None
    if isinstance(ls, Length):
        return max(0.5, min(3.0, ls.pt / orig_pt))
    if isinstance(ls, (int, float)) and ls > 0:
        return float(ls)
    return LINE_H
```

3c. Replace the whole `_fill_text` function (lines ~57-99) with:
```python
def _fill_text(shape, slot: Slot, value: str) -> list[SlotError]:
    warnings: list[SlotError] = []
    tf = shape.text_frame
    tf.word_wrap = True

    # Preserve the template's styling: keep the first paragraph (its alignment)
    # and write into its first run (its font family, size, bold/italic, color).
    p0 = tf.paragraphs[0] if tf.paragraphs else None
    r0 = p0.runs[0] if (p0 is not None and p0.runs) else None
    orig_pt = r0.font.size.pt if (r0 is not None and r0.font.size is not None) else _BASE_PT

    base_spacing = _resolve_spacing(p0, orig_pt)
    floor_pt = slot.constraints.shrink_floor_pt or _MIN_PT
    res = fit_text(value, shape.width or 0, shape.height or 0, orig_pt, floor_pt, base_spacing)
    value = res.value
    dropped = res.dropped

    # Preserve the existing hard max_chars cap on top of the geometric fit.
    max_chars = slot.constraints.max_chars
    if max_chars is not None and len(value) > max_chars:
        value, extra = truncate_to_sentence(value, max_chars)
        dropped = (dropped + extra) if dropped else extra

    if dropped:
        warnings.append(SlotError(0, slot.id, "text_truncated",
                                  f"dropped {len(dropped)} chars to fit"))

    if r0 is not None:
        # Write into the existing run; drop extra runs and paragraphs so the
        # template's formatting on r0/p0 is what remains.
        r0.text = value
        for extra_run in p0.runs[1:]:
            extra_run._r.getparent().remove(extra_run._r)
        for extra_para in tf.paragraphs[1:]:
            extra_para._p.getparent().remove(extra_para._p)
        r0.font.size = Pt(res.font_pt)
        p0.line_spacing = res.line_spacing
    else:
        # No run to inherit from (empty box) — fall back to plain text.
        tf.text = value
        for para in tf.paragraphs:
            para.line_spacing = res.line_spacing
            for run in para.runs:
                run.font.size = Pt(res.font_pt)
    return warnings
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `engine/`): `python -m pytest tests/test_filler.py -v`
Expected: PASS — the two new text tests pass; `test_fill_text` (short text unchanged), `test_fill_table`, `test_fill_image`, and `test_fill_text_overflow_cuts_and_reports` still pass (the `max_chars=10` overflow test still yields a `text_truncated` warning because the cap truncation runs after the fit).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/tests/test_filler.py
git commit -m "feat(engine): fit every text slot to its box (word_wrap, spacing, font)"
```

---

### Task 3: Full engine-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole engine suite**

Run (from `engine/`): `python -m pytest -q`
Expected: PASS — all engine tests green (the LibreOffice render test stays skipped if `soffice` is absent). In particular confirm no regression in `test_filler.py`, `test_textfit.py`, `test_fit.py` (still tests `assess_text` independently), `test_render.py`, and `test_text_format.py`.

- [ ] **Step 2: Commit (only if a fixup was needed)**

```bash
git add -A
git commit -m "chore(engine): free-text fit suite green"
```

---

## Out of scope (not in this plan)

- `web/src/lib/charfit.ts` (editor "fits ~N chars" estimate) keeps its flat product; aligning it to render fit is a later, optional change.
- Per-run mixed fonts within one paragraph (fit uses the first run's size).
- Vertical anchoring / autosizing the box.
- Table cell fitting and table-vs-text overlap demotion — the separate table-fit spec/plan.
- Changing `GLYPH_W` / `LINE_H` / `EMU_PER_PT` values or using real glyph metrics.

## Self-review

- **Spec coverage:** geometry-aware fit applied unconditionally (Task 2 calls `fit_text` for every text slot) ✓; degrade order spacing→font→truncate (Task 1 `fit_text` algorithm) ✓; presentable spacing floor `0.9` (Task 1 `LINE_SPACING_FLOOR`) ✓; reuse `GLYPH_W`/`EMU_PER_PT`/`LINE_H` via import (Task 1 import from `autodetect`) ✓; reuse `truncate_to_sentence` (Task 1 step 3) ✓; `word_wrap=True` (Task 2 `_fill_text`) ✓; line-spacing resolution of None/float/Length (Task 2 `_resolve_spacing`) ✓; max_chars cap preserved (Task 2) ✓; `text_truncated` warning when dropped, none when fits (Task 2 tests) ✓; styling preserved by writing into `r0` (Task 2) ✓; zero/unknown dims guard (Task 1 `fit_text` + test) ✓; `assess_text` left in `fit.py` (untouched; only its unused import is removed from `filler.py`) ✓.
- **Type consistency:** `fit_text(value, width_emu, height_emu, base_pt, font_floor_pt, base_spacing) -> FitResult` defined in Task 1 and called with exactly those positional args in Task 2; `FitResult.{font_pt, line_spacing, value, dropped}` read in Task 2 match the dataclass; `LINE_SPACING_FLOOR` imported in both the Task 1 and Task 2 tests with the same value `0.9`.
- **Placeholder scan:** every code/test step contains complete code and exact run commands; no TBDs.
