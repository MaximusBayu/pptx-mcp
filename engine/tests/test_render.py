import io
import pytest
from pptx import Presentation
from pptx_mcp.template import load_template
from pptx_mcp.render import render, RenderRejected


def _deck():
    return {"slides": [
        {"slide_type": "title", "slots": {"title": "Acme", "subtitle": "Q3"}},
        {"slide_type": "bullet", "slots": {"heading": "Plan", "body": "a\nb"}},
    ]}


def test_render_produces_valid_pptx(sample_template_dir):
    tpl = load_template(sample_template_dir)
    data, warnings = render(_deck(), tpl)
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 2
    texts = [sh.text_frame.text for sh in prs.slides[0].shapes if sh.has_text_frame]
    assert "Acme" in texts


def test_render_rejects_invalid(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # Tables still reject; text overflow is now a non-fatal warning
    bad = {"slides": [{"slide_type": "table", "slots": {"data": [["a"]] * 10}}]}
    with pytest.raises(RenderRejected) as ei:
        render(bad, tpl)
    assert ei.value.errors[0].code == "table_overflow"


def test_render_text_overflow_returns_warnings(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # Text over limit now produces a warning instead of raising
    long_text = "First sentence here. " * 20  # well over max_chars=40
    spec = {"slides": [{"slide_type": "title", "slots": {"title": long_text, "subtitle": ""}}]}
    data, warnings = render(spec, tpl)
    assert isinstance(data, bytes)
    assert any(w["code"] == "text_truncated" for w in warnings)
