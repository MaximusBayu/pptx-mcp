import pytest
from pptx_mcp.template import load_template
from pptx_mcp.render import render
from pptx_mcp.preview import preview, libreoffice_available


def _deck():
    return {"slides": [{"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}}]}


@pytest.mark.skipif(not libreoffice_available(), reason="LibreOffice not installed")
def test_preview_returns_png(sample_template_dir):
    tpl = load_template(sample_template_dir)
    data = render(_deck(), tpl)
    pngs = preview(data)
    assert len(pngs) >= 1


def test_libreoffice_available_is_bool():
    assert isinstance(libreoffice_available(), bool)
