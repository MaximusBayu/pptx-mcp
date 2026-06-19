from pathlib import Path
import json
from pptx_mcp.bytesio import load_from_bytes


def test_load_from_bytes(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    manifest = json.loads((sample_template_dir / "manifest.json").read_text())
    tpl = load_from_bytes(pptx, manifest)
    assert tpl.id == "sample"
    assert Path(tpl.pptx_path).exists()
