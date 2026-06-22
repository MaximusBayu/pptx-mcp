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


def test_fill_text_sets_word_wrap_and_preserves_styling(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")
    shp = find_shape(prs.slides[0], slot.shape_id)
    before_name = shp.text_frame.paragraphs[0].runs[0].font.name

    fill_slot(prs.slides[0], slot, "A reasonably long heading that should wrap and be fit to its box")

    tf = shp.text_frame
    assert tf.word_wrap is True
    p0 = tf.paragraphs[0]
    # Font name (family) preserved on the surviving run.
    assert p0.runs[0].font.name == before_name
    # Line spacing is resolved to a numeric multiple and never below the floor.
    from pptx_mcp.textfit import LINE_SPACING_FLOOR
    assert isinstance(p0.line_spacing, float)
    assert p0.line_spacing >= LINE_SPACING_FLOOR


def test_fill_text_no_warning_when_it_fits(sample_template_dir):
    tpl = load_template(sample_template_dir)
    prs = assemble([0], tpl)
    slot = tpl.slide_type("title").slot("title")
    warnings = fill_slot(prs.slides[0], slot, "Short")
    assert not any(w.code == "text_truncated" for w in warnings)


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
