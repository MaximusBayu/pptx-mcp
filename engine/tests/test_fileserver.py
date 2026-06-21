import pytest
from fastapi.testclient import TestClient
from pptx_mcp.storage import Storage
from pptx_mcp.fileserver import create_app


@pytest.fixture
def client(tmp_path):
    storage = Storage(tmp_path / "tpl", tmp_path / "out")
    app = create_app(storage)
    return TestClient(app), storage


def test_download_ok(client):
    c, storage = client
    token = storage.put_output(b"data", ".pptx")
    r = c.get(f"/files/{token}")
    assert r.status_code == 200
    assert r.content == b"data"


def test_download_unknown(client):
    c, _ = client
    assert c.get("/files/nope").status_code == 404
