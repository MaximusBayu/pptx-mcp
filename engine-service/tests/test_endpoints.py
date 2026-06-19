import json
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


def _files(sample_template_dir):
    return {"file": ("base.pptx", (sample_template_dir / "base.pptx").read_bytes())}


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_extract_shapes(sample_template_dir):
    r = client.post("/extract-shapes", files=_files(sample_template_dir))
    assert r.status_code == 200
    assert len(r.json()["slides"]) == 4


def test_render_deck_ok(sample_template_dir, sample_manifest):
    deck = {"slides": [{"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}}]}
    r = client.post("/render-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest), "deck_spec": json.dumps(deck)})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"  # zip/pptx magic


def test_render_deck_rejects(sample_template_dir, sample_manifest):
    deck = {"slides": [{"slide_type": "title", "slots": {"title": "x" * 200}}]}
    r = client.post("/render-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest), "deck_spec": json.dumps(deck)})
    assert r.status_code == 422
    assert r.json()["validation"][0]["code"] == "text_overflow"


def test_move_shape(sample_template_dir):
    from pptx import Presentation
    sid = Presentation(str(sample_template_dir / "base.pptx")).slides[0].shapes[0].shape_id
    r = client.post("/move-shape", files=_files(sample_template_dir),
                    data={"shape_id": str(sid),
                          "bbox_pct": json.dumps({"x": 10, "y": 10, "w": 40, "h": 20})})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
