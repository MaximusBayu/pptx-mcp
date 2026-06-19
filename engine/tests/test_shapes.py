from pptx_mcp.shapes import extract_shapes


def test_extract_shapes_geometry(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    out = extract_shapes(pptx)
    assert len(out["slides"]) == 4
    s0 = out["slides"][0]
    assert s0["width_emu"] > 0 and s0["height_emu"] > 0
    shp = s0["shapes"][0]
    assert {"shape_id", "name", "type", "bbox_pct"} <= shp.keys()
    for k in ("x", "y", "w", "h"):
        assert 0 <= shp["bbox_pct"][k] <= 100


def test_extract_shapes_types(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    out = extract_shapes(pptx)
    table_slide = out["slides"][2]
    image_slide = out["slides"][3]
    assert any(s["type"] == "table" for s in table_slide["shapes"])
    assert any(s["type"] == "image" for s in image_slide["shapes"])
