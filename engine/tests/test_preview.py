import pytest
from pptx_mcp.template import load_template
from pptx_mcp.render import render
from pptx_mcp.preview import preview, libreoffice_available, _pdftoppm_cmd


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


def test_pdftoppm_cmd_sets_100_dpi():
    cmd = _pdftoppm_cmd("pdftoppm", "/tmp/deck.pdf", "/tmp/page")
    assert cmd[0] == "pdftoppm"
    assert "-png" in cmd
    assert "-r" in cmd
    assert cmd[cmd.index("-r") + 1] == "100"
    assert str("/tmp/deck.pdf") in cmd
