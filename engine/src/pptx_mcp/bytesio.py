import tempfile

from .manifest import parse_manifest, validate_against_pptx
from .models import Template


def load_from_bytes(pptx_bytes: bytes, manifest: dict) -> Template:
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    tmp.write(pptx_bytes)
    tmp.flush()
    tmp.close()
    template = parse_manifest(manifest, tmp.name)
    validate_against_pptx(template)
    return template
