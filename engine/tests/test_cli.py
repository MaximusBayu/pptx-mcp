import json
from pptx_mcp.cli import scaffold_manifest, main


def test_scaffold_has_slide_per_slide(sample_template_dir):
    m = scaffold_manifest(str(sample_template_dir / "base.pptx"))
    assert len(m["slide_types"]) == 4
    # table slide should detect a table slot
    table_st = m["slide_types"][2]
    assert any(s["type"] == "table" for s in table_st["slots"])


def test_main_writes_file(sample_template_dir, tmp_path):
    out = tmp_path / "m.json"
    rc = main(["init-template", str(sample_template_dir / "base.pptx"), "-o", str(out)])
    assert rc == 0
    data = json.loads(out.read_text())
    assert "slide_types" in data
