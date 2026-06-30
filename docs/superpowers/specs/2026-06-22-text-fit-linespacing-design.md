# Free-Text Fit — Geometry-Aware Shrink (Spacing → Font → Truncate) — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** B (free-text half) of the fit-quality work. Pairs with the table
spec (`2026-06-22-table-fit-quality-design.md`); both improve render-time fit.

## Goal

Stop free-text blocks (the cards in report images 1–2) from overflowing their
boxes. Render-time text fit must account for **word wrapping and line spacing**
and must apply **always** — not only when a `max_chars`/`max_lines` constraint is
set. When content is too big for the box, degrade gracefully in this order:

1. **Reduce line spacing** toward a presentable floor (never 0).
2. If still overflowing, **shrink the font** step by step toward a floor.
3. If still overflowing at both floors, **truncate** at a sentence/word boundary
   and emit a `text_truncated` warning.

## Background

`engine/src/pptx_mcp/filler.py` `_fill_text` today:

- Calls `assess_text(value, constraints)`, which returns `"shrink"` **only** when
  `max_lines` or `max_chars` is set and exceeded. With no constraint, the result
  is `"ok"` → no shrink → the text overflows the box.
- When it does shrink, it drops the font a single `_SHRINK_STEP` (4 pt) and
  truncates by a char-count capacity scaled from `max_chars`.
- It never sets `word_wrap`, never measures the box height against wrapped lines,
  and never touches line spacing.

`estimate_max_chars` (`autodetect.py`) approximates capacity as a flat
`chars_per_line * lines` product (`GLYPH_W=0.5`, `LINE_H=1.2`,
`EMU_PER_PT=12700`) — no per-paragraph wrapping, no variable spacing. It is used
to *suggest* `max_chars`; it does not govern the actual render fit.

`engine/src/pptx_mcp/textfit.py` already owns text-fitting helpers
(`truncate_to_sentence`). It is the right home for the new fit function.

Root cause: render fit is constraint-gated and spacing-blind, so unconstrained or
long content overflows.

## Decisions

1. **Geometry-aware fit, applied unconditionally** — every text slot is fit to
   its box at render time using wrapped-line estimation.
2. **Degrade order: spacing → font → truncate** (user's choice). Line spacing is
   reduced first (font preserved), then font is shrunk, then text is truncated.
3. **Presentable spacing floor** — line spacing never goes below
   `LINE_SPACING_FLOOR = 0.9`; the largest spacing that fits is chosen.
4. **Reuse existing constants and truncation** — `GLYPH_W`/`EMU_PER_PT`/`LINE_H`
   are imported from `autodetect.py` (single source); `truncate_to_sentence` is
   reused. No new fitting math beyond wrapping/spacing.
5. **Set `word_wrap = True`** on the text frame so text actually wraps in the box
   rather than running off one line.

## Components

### 1. `engine/src/pptx_mcp/textfit.py` — new `fit_text`

```
from dataclasses import dataclass

@dataclass
class FitResult:
    font_pt: float
    line_spacing: float
    value: str
    dropped: str          # "" when nothing was truncated

LINE_SPACING_FLOOR = 0.9
SPACING_STEP = 0.05
FONT_STEP = 4.0           # mirror filler._SHRINK_STEP

def fit_text(value, width_emu, height_emu, base_pt,
             font_floor_pt, base_spacing) -> FitResult
```

Imports `GLYPH_W`, `EMU_PER_PT`, `LINE_H` from `autodetect.py`.

Internal helpers (pure):
- `_chars_per_line(width_emu, font_pt)` =
  `max(1, int(width_emu / (font_pt * EMU_PER_PT * GLYPH_W)))`.
- `_lines_needed(value, cpl)` = `sum(max(1, ceil(len(line) / cpl))
  for line in value.split("\n"))`; `0` for empty `value`.
- `_avail_lines(height_emu, font_pt, spacing)` =
  `max(1, int(height_emu / (font_pt * EMU_PER_PT * spacing)))`.
- `_fits(value, width_emu, height_emu, font_pt, spacing)` =
  `_lines_needed(value, _chars_per_line(width_emu, font_pt))
   <= _avail_lines(height_emu, font_pt, spacing)`.

Algorithm:
1. **Guard:** if `width_emu <= 0` or `height_emu <= 0`, return
   `FitResult(base_pt, base_spacing, value, "")` (cannot measure — leave as-is).
2. **Spacing pass (font = base_pt):** iterate `spacing` from `base_spacing` down
   to `LINE_SPACING_FLOOR` in `SPACING_STEP` decrements; return the **first
   (largest)** spacing where `_fits` is true → `FitResult(base_pt, spacing,
   value, "")`.
3. **Font pass (spacing = LINE_SPACING_FLOOR):** iterate `pt` from
   `base_pt - FONT_STEP` down to `font_floor_pt` in `FONT_STEP` decrements; return
   the first `pt` where `_fits` is true →
   `FitResult(pt, LINE_SPACING_FLOOR, value, "")`.
4. **Truncate (pt = font_floor_pt, spacing = floor):** capacity =
   `_chars_per_line(width_emu, font_floor_pt) * _avail_lines(height_emu,
   font_floor_pt, LINE_SPACING_FLOOR)`; `kept, dropped =
   truncate_to_sentence(value, capacity)`; return `FitResult(font_floor_pt,
   LINE_SPACING_FLOOR, kept, dropped)`.

`base_spacing < LINE_SPACING_FLOOR` (already tight) → the spacing pass yields the
floor immediately; logic still holds.

### 2. `engine/src/pptx_mcp/filler.py` — `_fill_text` uses `fit_text`

Replace the `assess_text`/single-step shrink with:

- `tf = shape.text_frame; tf.word_wrap = True`.
- `p0`, `r0` as today; `orig_pt = r0.font.size.pt if r0 has size else _BASE_PT`.
- `base_spacing`: read `p0.line_spacing`. python-pptx returns `None`, a `float`
  (a multiple), or a `Length` (a fixed distance). Resolve to a multiple:
  - `float`/`int` and `> 0` → use it;
  - `Length` → `length.pt / orig_pt` (clamped to a sane `0.5..3.0`);
  - else → `LINE_H`.
- `floor_pt = slot.constraints.shrink_floor_pt or _MIN_PT`.
- `res = fit_text(value, shape.width or 0, shape.height or 0, orig_pt, floor_pt,
  base_spacing)`.
- `value = res.value`. If `slot.constraints.max_chars` is set and
  `len(value) > max_chars`, additionally `truncate_to_sentence(value, max_chars)`
  (preserve the existing constraint cap) and merge into `dropped`.
- Emit a `text_truncated` warning when anything was dropped (same shape as today).
- Write `value` into `r0` (preserving its font family/bold/italic/color), drop
  extra runs and paragraphs, then set `r0.font.size = Pt(res.font_pt)` and
  `p0.line_spacing = res.line_spacing`.
- Empty-box fallback (`r0 is None`): `tf.text = value`; set font size on every
  run and `line_spacing` on every paragraph.

`assess_text` is left in place (still used by tests / any other caller); it no
longer drives `_fill_text`'s shrink decision.

### 3. Shared constants

`GLYPH_W`, `EMU_PER_PT`, `LINE_H` keep their single definition in `autodetect.py`;
`textfit.py` imports them. No duplication, no value change.

## Data flow

```
render -> fill_slot(text) -> _fill_text:
  word_wrap = True
  base_pt, base_spacing <- run/paragraph
  fit_text:
    1. shrink line spacing (font fixed) until fits, floor 0.9
    2. else shrink font (spacing 0.9) until fits, floor _MIN_PT/shrink_floor_pt
    3. else truncate at boundary + report dropped
  write value, set font size + line spacing, preserve styling
  -> text_truncated warning if anything dropped
```

## Error handling / edges

- Zero/unknown box dims → guard returns input unchanged (no crash, no shrink).
- Empty/`None` value → `render` already skips empty values before `fill_slot`.
- Single very long word (no spaces) → `ceil(len/cpl)` still counts the lines it
  occupies; truncation falls back to word/sentence split (existing helper).
- Newlines in the value → counted per paragraph in `_lines_needed`.
- `base_spacing` already below the floor → spacing pass returns the floor; font
  pass proceeds. No inversion.
- Styling preserved: writing into `r0` keeps the template's font family, weight,
  and color exactly as `_fill_text` does today.

## Testing

- `engine` (pytest), `textfit`:
  - `fit_text` short text in a large box → `font_pt == base`,
    `line_spacing == base`, `dropped == ""`.
  - Mildly long → `font_pt == base` but `line_spacing < base` and `>= 0.9`
    (spacing reduced first).
  - Long → `line_spacing == 0.9` and `font_pt < base` (font reduced after spacing
    floored).
  - Extreme → `font_pt == floor`, `line_spacing == 0.9`, `dropped != ""`.
  - Larger `base_spacing` (e.g. 2.0) needs a smaller font than 1.0 for the same
    text/box (fewer available lines).
  - Zero box dims → returns input unchanged.
- `engine` (pytest), `filler`:
  - Filling an overflowing text shape reduces `p0.line_spacing` and/or
    `r0.font.size`, sets `tf.word_wrap True`, and preserves the run's font name.
  - A `text_truncated` warning is returned when content is dropped; none when it
    fits.

## Out of scope

- `web/src/lib/charfit.ts` (editor "fits ~N chars" estimate) keeps its flat
  product; it remains a rough guide and may diverge slightly from render fit.
  Aligning it is a later, optional change.
- Per-run mixed fonts within one paragraph (fit uses the first run's size).
- Vertical anchoring / autosizing the box (table spec also excludes box growth).
- Changing `GLYPH_W`/`LINE_H`/`EMU_PER_PT` values.
- Real glyph-metric measurement (the 0.5 average-glyph-width approximation
  stays).
