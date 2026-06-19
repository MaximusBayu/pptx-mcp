from pptx_mcp.template import load_template
from pptx_mcp.assembler import assemble, find_shape


def test_assemble_order_and_count(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # build: title(0), bullet(1), title(0) again -> 3 slides
    prs = assemble([0, 1, 0], tpl)
    assert len(prs.slides) == 3


def test_assembled_slides_keep_shapes(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([2, 3], tpl)  # table slide, image slide
    table_slide = prs.slides[0]
    image_slide = prs.slides[1]
    assert any(s.has_table for s in table_slide.shapes)
    assert any(s.shape_type == 13 for s in image_slide.shapes)  # 13 = PICTURE


def test_find_shape_by_id(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    title_slot = tpl.slide_type("title").slot("title")
    shp = find_shape(prs.slides[0], title_slot.shape_id)
    assert shp.shape_id == title_slot.shape_id
