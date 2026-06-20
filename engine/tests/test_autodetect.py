from pptx import Presentation
from pptx_mcp.autodetect import classify_shape


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
