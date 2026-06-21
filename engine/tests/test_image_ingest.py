import base64
import io

import pytest
from PIL import Image

from pptx_mcp.filler import load_image_bytes


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 120, 90)).save(buf, format="PNG")
    return buf.getvalue()


def test_bytes_pass_through():
    raw = _png_bytes()
    assert load_image_bytes(raw) == raw


def test_data_url_base64_decodes():
    raw = _png_bytes()
    data_url = "data:image/png;base64," + base64.b64encode(raw).decode()
    assert load_image_bytes(data_url) == raw


def test_file_path_reads(tmp_path):
    raw = _png_bytes()
    p = tmp_path / "x.png"
    p.write_bytes(raw)
    assert load_image_bytes(str(p)) == raw


def test_http_url_fetches(monkeypatch):
    raw = _png_bytes()

    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self, n=-1):
            return raw

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: _Resp())
    assert load_image_bytes("https://example.com/p.png") == raw


def test_rejects_empty_and_nonstr():
    with pytest.raises(ValueError):
        load_image_bytes("")
    with pytest.raises(ValueError):
        load_image_bytes(123)
