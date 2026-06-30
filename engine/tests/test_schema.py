import json
from pptx_mcp.template import load_template
from pptx_mcp.schema import get_schema


def test_schema_shape(sample_template_dir):
    tpl = load_template(sample_template_dir)
    sch = get_schema(tpl)
    assert sch["id"] == "sample"
    types = {t["id"] for t in sch["slide_types"]}
    assert types == {"title", "bullet", "table", "image"}
    title = next(t for t in sch["slide_types"] if t["id"] == "title")
    slot = next(s for s in title["slots"] if s["id"] == "title")
    assert slot["type"] == "text"
    assert slot["constraints"]["max_chars"] == 40


def test_schema_hides_shape_id(sample_template_dir):
    tpl = load_template(sample_template_dir)
    blob = json.dumps(get_schema(tpl))
    assert "shape_id" not in blob
    assert "target" not in blob


def test_schema_includes_geometry_for_text_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    schema = get_schema(tpl)
    # Find any text slot across slide types.
    text_slot = next(
        s for st in schema["slide_types"] for s in st["slots"] if s["type"] == "text"
    )
    g = text_slot["geometry"]
    assert g is not None
    assert g["width_emu"] > 0 and g["height_emu"] > 0
    assert g["font_pt"] is not None
    assert g["capacity_chars"] is not None and g["capacity_chars"] > 0


def test_schema_geometry_null_font_for_non_text_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    schema = get_schema(tpl)
    non_text = [
        s for st in schema["slide_types"] for s in st["slots"] if s["type"] != "text"
    ]
    for s in non_text:
        g = s["geometry"]
        # Non-text slots still report box dims, but font/capacity are null.
        if g is not None:
            assert g["font_pt"] is None
            assert g["capacity_chars"] is None
