from pptx import Presentation


def test_fixture_builds_four_slides(sample_template_dir):
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    assert len(prs.slides) == 4


def test_fixture_manifest_has_four_slide_types(sample_manifest):
    assert len(sample_manifest["slide_types"]) == 4
    assert {st["id"] for st in sample_manifest["slide_types"]} == {"title", "bullet", "table", "image"}
