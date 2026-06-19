import json
import pytest
from pptx_mcp.manifest import parse_manifest, validate_against_pptx, ManifestError


def test_parse_builds_template(sample_manifest, sample_template_dir):
    tpl = parse_manifest(sample_manifest, str(sample_template_dir / "base.pptx"))
    assert tpl.id == "sample"
    assert tpl.slide_type("title").slot("title").type == "text"
    assert tpl.slide_type("table").slot("data").constraints.max_rows == 5


def test_parse_rejects_unknown_slot_type(sample_manifest, sample_template_dir):
    sample_manifest["slide_types"][0]["slots"][0]["type"] = "chart"
    with pytest.raises(ManifestError):
        parse_manifest(sample_manifest, str(sample_template_dir / "base.pptx"))


def test_validate_ok(sample_manifest, sample_template_dir):
    tpl = parse_manifest(sample_manifest, str(sample_template_dir / "base.pptx"))
    validate_against_pptx(tpl)  # should not raise


def test_validate_fails_missing_shape(sample_manifest, sample_template_dir):
    sample_manifest["slide_types"][0]["slots"][0]["target"]["shape_id"] = 99999
    tpl = parse_manifest(sample_manifest, str(sample_template_dir / "base.pptx"))
    with pytest.raises(ManifestError):
        validate_against_pptx(tpl)
