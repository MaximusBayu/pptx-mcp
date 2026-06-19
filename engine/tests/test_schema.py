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
