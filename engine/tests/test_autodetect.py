from pptx import Presentation
from pptx_mcp.autodetect import classify_shape, estimate_max_chars, derive_ids, ShapeAssessment


def _assess(path):
    prs = Presentation(path)
    out = {}
    sw, sh = prs.slide_width, prs.slide_height
    for slide in prs.slides:
        for shp in slide.shapes:
            out[shp.shape_id] = classify_shape(shp, sw, sh)
    return out


def test_classifier_separates_slots_from_decoration(labeled_deck):
    path, labels = labeled_deck
    assessed = _assess(path)
    for sid, is_slot in labels.items():
        a = assessed[sid]
        assert a.is_candidate == is_slot, f"shape {sid}: conf={a.confidence}"


def test_confidence_in_range(labeled_deck):
    path, _ = labeled_deck
    for a in _assess(path).values():
        assert 0.0 <= a.confidence <= 1.0


def test_max_chars_scales_with_box_and_font():
    emu = 914400
    big = estimate_max_chars(int(8 * emu), int(1.5 * emu), 40.0)[0]
    small_font = estimate_max_chars(int(8 * emu), int(1.5 * emu), 20.0)[0]
    assert small_font > big
    assert big > 0


def test_max_chars_uses_default_font_when_none():
    emu = 914400
    mc, ml = estimate_max_chars(int(4 * emu), int(2 * emu), None)
    assert mc > 0 and ml >= 1


def _mk(sid, x, y, w, h, conf=0.9, typ="text"):
    return ShapeAssessment(sid, f"TextBox {sid}", typ,
                           {"x": x, "y": y, "w": w, "h": h}, conf, True, 18.0)


def test_derive_ids_hybrid_semantic_then_indexed():
    title = _mk(1, 10, 5, 70, 15)
    subtitle = _mk(2, 10, 22, 50, 6)
    body = _mk(3, 10, 35, 70, 45)
    other = _mk(4, 10, 82, 20, 5)
    ids = derive_ids([title, subtitle, body, other])
    assert ids[1] == "title"
    assert ids[2] == "subtitle"
    assert ids[3] == "body"
    assert ids[4].startswith("text_")
