import json
from pathlib import Path

from .manifest import ManifestError, parse_manifest, validate_against_pptx
from .models import Template


def load_template(path) -> Template:
    path = Path(path)
    manifest_path = path / "manifest.json"
    pptx_path = path / "base.pptx"
    if not manifest_path.exists():
        raise ManifestError(f"manifest.json not found in {path}")
    if not pptx_path.exists():
        raise ManifestError(f"base.pptx not found in {path}")
    data = json.loads(manifest_path.read_text())
    template = parse_manifest(data, str(pptx_path))
    validate_against_pptx(template)
    return template
