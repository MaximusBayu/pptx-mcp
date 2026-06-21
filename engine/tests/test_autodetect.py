from pptx import Presentation
from pptx_mcp.autodetect import classify_shape, estimate_max_chars, derive_ids, ShapeAssessment, autodetect


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


def test_autodetect_shapes_have_suggestions(labeled_deck):
    path, labels = labeled_deck
    data = open(path, "rb").read()
    out = autodetect(data)
    shapes = {s["shape_id"]: s for s in out["slides"][0]["shapes"]}
    for sid, is_slot in labels.items():
        assert shapes[sid]["is_candidate"] == is_slot
    for s in out["slides"][0]["shapes"]:
        if s["is_candidate"]:
            assert s["suggested_id"]
            assert s["suggested_max_chars"] > 0


def test_table_candidate_gets_max_rows_cols(tmp_path):
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide.shapes.add_table(3, 2, Inches(1), Inches(1), Inches(8), Inches(3))
    p = tmp_path / "tbl.pptx"
    prs.save(str(p))
    det = autodetect(p.read_bytes())
    tables = [s for s in det["slides"][0]["shapes"] if s["type"] == "table"]
    assert tables, "table shape not detected"
    t = tables[0]
    assert t["is_candidate"] is True
    assert t["suggested_max_rows"] == 3
    assert t["suggested_max_cols"] == 2
    # text-only fields stay zero for a table
    assert t["suggested_max_chars"] == 0


def test_shapes_have_text_and_example(labeled_deck):
    path, _ = labeled_deck
    out = autodetect(open(path, "rb").read())
    shapes = out["slides"][0]["shapes"]
    titles = [s for s in shapes if s["suggested_id"] == "title"]
    assert titles, "no title candidate detected"
    t = titles[0]
    # the title box text in the fixture is "Quarterly Business Review"
    assert "Quarterly Business Review" in t["text"]
    # example is the box's own text (the biggest agent win), non-empty for a tagged text slot
    assert t["suggested_example"]
    assert t["suggested_example"] in t["text"] or t["text"].startswith(t["suggested_example"].rstrip("…"))
    assert t["suggested_description"] == "Slide title"


def test_slot_description_labels():
    from pptx_mcp.autodetect import slot_description
    assert slot_description("title") == "Slide title"
    assert slot_description("subtitle") == "Subtitle"
    assert slot_description("body") == "Body text"
    assert slot_description("table_1") == "Table data"
    assert slot_description("image_2") == "Image"
    assert slot_description("text_3") == "Text"
    assert slot_description("") == "Text"
