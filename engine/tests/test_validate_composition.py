from pptx_mcp.template import load_template
from pptx_mcp.composer import validate_composition


def _ids(tpl):
    from pptx_mcp.catalog import get_catalog
    comps = get_catalog(tpl)["components"]
    title = next(c for c in comps if c.get("slot_id") == "title")
    table = next(c for c in comps if c["type"] == "table")
    return title["component_id"], table["component_id"]


def test_unknown_canvas(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 99, "placements": [{"component_id": cid}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_canvas" for e in errs)


def test_unknown_component(sample_template_dir):
    tpl = load_template(sample_template_dir)
    spec = {"slides": [{"canvas": 0, "placements": [{"component_id": "9:9"}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_component" for e in errs)


def test_wrong_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)  # title is a text component
    spec = {"slides": [{"canvas": 0,
                        "placements": [{"component_id": cid, "content": [["a"]]}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "wrong_type" for e in errs)


def test_bad_bbox(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": cid, "bbox_pct": {"x": -5, "y": 0, "w": 50, "h": 50}}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "bad_bbox" for e in errs)


def test_valid_spec_has_no_errors(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": cid, "content": "Hello",
         "bbox_pct": {"x": 5, "y": 5, "w": 50, "h": 20}}]}]}
    assert validate_composition(spec, tpl) == []


def test_bool_canvas_rejected(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": True, "placements": [{"component_id": cid}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_canvas" for e in errs)


def test_non_int_canvas_rejected(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": None, "placements": [{"component_id": cid}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "unknown_canvas" for e in errs)


def test_bool_bbox_coord_rejected(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cid, _ = _ids(tpl)
    spec = {"slides": [{"canvas": 0, "placements": [
        {"component_id": cid, "bbox_pct": {"x": True, "y": 0, "w": 50, "h": 50}}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "bad_bbox" for e in errs)


def test_list_content_accepted_for_text(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.catalog import get_catalog
    from pptx_mcp.composer import validate_composition
    tpl = load_template(sample_template_dir)
    cid = next(c["component_id"] for c in get_catalog(tpl)["components"]
               if c.get("slot_id") == "body")
    spec = {"slides": [{"canvas": 1, "placements": [
        {"component_id": cid, "content": ["a", "b", "c"]}]}]}
    assert validate_composition(spec, tpl) == []


def test_list_with_non_str_element_rejected(sample_template_dir):
    from pptx_mcp.template import load_template
    from pptx_mcp.catalog import get_catalog
    from pptx_mcp.composer import validate_composition
    tpl = load_template(sample_template_dir)
    cid = next(c["component_id"] for c in get_catalog(tpl)["components"]
               if c.get("slot_id") == "body")
    spec = {"slides": [{"canvas": 1, "placements": [
        {"component_id": cid, "content": ["ok", 5]}]}]}
    errs = validate_composition(spec, tpl)
    assert any(e.code == "wrong_type" for e in errs)
