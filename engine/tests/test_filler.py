from pptx.util import Pt
from pptx_mcp.template import load_template
from pptx_mcp.assembler import assemble, find_shape
from pptx_mcp.filler import fill_slot


def test_fill_text(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")
    fill_slot(prs.slides[0], slot, "Hello World")
    shp = find_shape(prs.slides[0], slot.shape_id)
    assert shp.text_frame.text == "Hello World"


def test_fill_text_shrinks_font(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")  # max 40, floor 16
    fill_slot(prs.slides[0], slot, "x" * 45)      # shrink range
    shp = find_shape(prs.slides[0], slot.shape_id)
    size = shp.text_frame.paragraphs[0].runs[0].font.size
    assert size is not None and size < Pt(24)
    assert size >= Pt(16)


def test_fill_table(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([2], tpl)
    slot = tpl.slide_type("table").slot("data")
    fill_slot(prs.slides[0], slot, [["A", "B"], ["1", "2"]])
    shp = find_shape(prs.slides[0], slot.shape_id)
    assert shp.table.cell(0, 0).text == "A"
    assert shp.table.cell(1, 1).text == "2"


def test_fill_image(sample_template_dir, tiny_png_bytes):
    tpl = load_template(sample_template_dir)
    prs = assemble([3], tpl)
    slot = tpl.slide_type("image").slot("photo")
    fill_slot(prs.slides[0], slot, tiny_png_bytes)  # should not raise
    shp = find_shape(prs.slides[0], slot.shape_id)
    assert shp.shape_type == 13  # still a picture


def test_fill_text_overflow_cuts_and_reports(base_template):
    from pptx import Presentation
    from pptx_mcp.filler import fill_slot
    tpl = base_template
    slot = tpl.slide_types[0].slots[0]
    slot.constraints.max_chars = 10
    prs = Presentation(tpl.pptx_path)
    warnings = fill_slot(prs.slides[0], slot, "First short. Second sentence dropped.")
    assert any(w.code == "text_truncated" for w in warnings)
