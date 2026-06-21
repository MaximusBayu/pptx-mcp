import respx
import httpx
from server import list_templates, render_deck

BASE = "http://web:3000"


@respx.mock
def test_list_templates(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    route = respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(200, json=[{"id": "t1"}]))
    out = list_templates()
    assert out[0]["id"] == "t1"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"


@respx.mock
def test_render_deck_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    respx.post(f"{BASE}/api/mcp/templates/t1/render").mock(
        return_value=httpx.Response(200, json={"validation": [], "download_url": "https://d/u"}))
    out = render_deck("t1", {"slides": []})
    assert out["download_url"] == "https://d/u"
