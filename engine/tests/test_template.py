import pytest
from pptx_mcp.template import load_template
from pptx_mcp.manifest import ManifestError


def test_load_template_ok(sample_template_dir):
    tpl = load_template(sample_template_dir)
    assert tpl.id == "sample"
    assert len(tpl.slide_types) == 4


def test_load_template_missing_dir(tmp_path):
    with pytest.raises(ManifestError):
        load_template(tmp_path / "nope")
