import shutil
import pytest
from pptx_mcp.storage import Storage
from pptx_mcp.mcp_server import (
    tool_list_templates, tool_get_template_schema, tool_render_deck,
)


@pytest.fixture
def storage(sample_template_dir, tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("mcp_server_test")
    templates = tmp_path / "templates"
    templates.mkdir()
    shutil.copytree(sample_template_dir, templates / "sample")
    return Storage(templates, tmp_path / "out")


def _deck():
    return {"slides": [{"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}}]}


def test_list_templates(storage):
    out = tool_list_templates(storage)
    assert out[0]["id"] == "sample"
    assert "slide_types" in out[0]


def test_get_schema(storage):
    sch = tool_get_template_schema(storage, "sample")
    assert sch["id"] == "sample"


def test_render_deck_ok(storage):
    out = tool_render_deck(storage, "http://x", "sample", _deck())
    assert out["validation"] == []
    assert out["download_url"].startswith("http://x/files/")


def test_render_deck_invalid(storage):
    bad = {"slides": [{"slide_type": "title", "slots": {"title": "x" * 200}}]}
    out = tool_render_deck(storage, "http://x", "sample", bad)
    assert out["download_url"] is None
    assert out["validation"][0]["code"] == "text_overflow"
