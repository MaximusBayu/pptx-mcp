import sys
import importlib.util
from pathlib import Path

# reuse the v1 engine fixture — import via spec to avoid circular name collision
_engine_tests = Path(__file__).resolve().parents[2] / "engine" / "tests"
_spec = importlib.util.spec_from_file_location(
    "engine_conftest", _engine_tests / "conftest.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

sample_template_dir = _mod.sample_template_dir  # noqa: F401
sample_manifest = _mod.sample_manifest          # noqa: F401
tiny_png_bytes = _mod.tiny_png_bytes            # noqa: F401
