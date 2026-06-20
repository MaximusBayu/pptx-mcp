from dataclasses import dataclass

from pptx.enum.shapes import MSO_SHAPE_TYPE

from .shapes import _guess_type, _pct

TAU = 0.5
GLYPH_W = 0.5
LINE_H = 1.2
DEFAULT_FONT_PT = 18.0
EMU_PER_PT = 12700

_DECO_TYPES = {MSO_SHAPE_TYPE.FREEFORM, MSO_SHAPE_TYPE.GROUP, MSO_SHAPE_TYPE.LINE}
_MIN_AREA_PCT = 1.0
_MIN_DIM_PCT = 0.5


@dataclass
class ShapeAssessment:
    shape_id: int
    name: str
    type: str
    bbox_pct: dict
    confidence: float
    is_candidate: bool
    font_pt: float | None


def _shape_text(shape) -> str:
    if not getattr(shape, "has_text_frame", False):
        return ""
    return (shape.text_frame.text or "").strip()


def _first_font_pt(shape) -> float | None:
    if not getattr(shape, "has_text_frame", False):
        return None
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            if run.font.size is not None:
                return run.font.size.pt
    return None


def classify_shape(shape, slide_w, slide_h) -> ShapeAssessment:
    left = shape.left or 0
    top = shape.top or 0
    width = shape.width or 0
    height = shape.height or 0
    bbox = {"x": _pct(left, slide_w), "y": _pct(top, slide_h),
            "w": _pct(width, slide_w), "h": _pct(height, slide_h)}

    score = 0.5
    text = _shape_text(shape)
    try:
        stype = shape.shape_type
    except Exception:
        stype = None

    # exclude signals
    if stype in _DECO_TYPES:
        score -= 0.5
    if not getattr(shape, "has_text_frame", False) and _guess_type(shape) == "text":
        score -= 0.3
    if getattr(shape, "has_text_frame", False) and not text:
        score -= 0.25
    area_pct = bbox["w"] * bbox["h"]
    if area_pct < _MIN_AREA_PCT or bbox["w"] < _MIN_DIM_PCT or bbox["h"] < _MIN_DIM_PCT:
        score -= 0.4
    raw_off = (left < 0 or top < 0
               or left + width > slide_w or top + height > slide_h)
    if raw_off:
        score -= 0.4

    # include signals
    if getattr(shape, "is_placeholder", False):
        score += 0.4
    if text and area_pct >= _MIN_AREA_PCT:
        score += 0.3
    if _guess_type(shape) in ("table", "image") and area_pct >= _MIN_AREA_PCT:
        score += 0.2

    confidence = max(0.0, min(1.0, score))
    return ShapeAssessment(
        shape_id=shape.shape_id, name=shape.name or "",
        type=_guess_type(shape), bbox_pct=bbox,
        confidence=round(confidence, 3), is_candidate=confidence >= TAU,
        font_pt=_first_font_pt(shape),
    )


def estimate_max_chars(width_emu, height_emu, font_pt) -> tuple[int, int]:
    pt = font_pt if font_pt and font_pt > 0 else DEFAULT_FONT_PT
    font_emu = pt * EMU_PER_PT
    chars_per_line = max(1, int(width_emu / (font_emu * GLYPH_W)))
    lines = max(1, int(height_emu / (font_emu * LINE_H)))
    return chars_per_line * lines, lines


def derive_ids(assessments: list[ShapeAssessment]) -> dict[int, str]:
    text = [a for a in assessments if a.type == "text"]
    by_area = sorted(text, key=lambda a: a.bbox_pct["w"] * a.bbox_pct["h"], reverse=True)
    ids: dict[int, str] = {}

    top_sorted = sorted(text, key=lambda a: a.bbox_pct["y"])
    title = top_sorted[0] if top_sorted else None
    if title is not None:
        ids[title.shape_id] = "title"
        below = [a for a in top_sorted[1:] if a.bbox_pct["y"] > title.bbox_pct["y"]]
        if below:
            ids[below[0].shape_id] = "subtitle"
    for a in by_area:
        if a.shape_id not in ids:
            ids[a.shape_id] = "body"
            break

    counters = {"text": 0, "table": 0, "image": 0}
    used = set(ids.values())
    for a in assessments:
        if a.shape_id in ids:
            continue
        base = "image" if a.type == "image" else a.type
        counters[base] = counters.get(base, 0) + 1
        cand = f"{base}_{counters[base]}"
        while cand in used:
            counters[base] += 1
            cand = f"{base}_{counters[base]}"
        ids[a.shape_id] = cand
        used.add(cand)
    return ids
