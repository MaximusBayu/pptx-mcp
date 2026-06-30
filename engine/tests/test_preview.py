import subprocess
import pytest
import pptx_mcp.preview as preview_mod
from pptx_mcp.template import load_template
from pptx_mcp.render import render
from pptx_mcp.preview import preview, libreoffice_available, _pdftoppm_cmd, PreviewTimeout


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


def test_preview_raises_previewtimeout_on_soffice_timeout(monkeypatch):
    # Make libreoffice_available() True without a real binary.
    monkeypatch.setattr(preview_mod, "_SOFFICE", "/usr/bin/soffice")

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr(preview_mod.subprocess, "run", fake_run)
    with pytest.raises(PreviewTimeout):
        preview_mod.preview(b"not-a-real-pptx")


def test_preview_passes_timeout_kwarg_to_subprocess(monkeypatch):
    monkeypatch.setattr(preview_mod, "_SOFFICE", "/usr/bin/soffice")
    calls = []

    def recording_run(*args, **kwargs):
        calls.append(kwargs)
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr(preview_mod.subprocess, "run", recording_run)
    with pytest.raises(PreviewTimeout):
        preview_mod.preview(b"x")
    assert calls and "timeout" in calls[0]
    assert calls[0]["timeout"] == preview_mod._SOFFICE_TIMEOUT_S
