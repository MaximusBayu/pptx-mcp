import math
import re
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


_SENTENCE = re.compile(r"[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$")


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


def truncate_to_sentence(text: str, max_chars: int) -> tuple[str, str]:
    text = text or ""
    if len(text) <= max_chars:
        return text, ""

    sentences = [m.group(0) for m in _SENTENCE.finditer(text)]
    kept = ""
    for s in sentences:
        if len(kept) + len(s) <= max_chars:
            kept += s
        else:
            break
    kept = kept.rstrip()
    if kept:
        return kept, text[len(kept):].lstrip()

    words = text.split(" ")
    kept = ""
    for w in words:
        nxt = w if not kept else kept + " " + w
        if len(nxt) <= max_chars:
            kept = nxt
        else:
            break
    kept = kept.rstrip()
    return kept, text[len(kept):].lstrip()


def height_for(value: str, width_emu: int, font_pt: float, spacing: float) -> int:
    """EMU height needed to render `value` at font_pt/spacing in a box of the
    given width. Newlines start new lines. 0 when width is unknown."""
    if width_emu <= 0:
        return 0
    cpl = _chars_per_line(width_emu, font_pt)
    lines = _lines_needed(value, cpl)
    return int(math.ceil(lines * font_pt * EMU_PER_PT * spacing))
