import respx
import httpx
from pathlib import Path
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


def test_tool_docstrings_explain_flow_and_types():
    src = Path(__file__).resolve().parent.parent / "server.py"
    text = src.read_text(encoding="utf-8")
    # render docstring must teach value types and the repeat rule
    assert "list[list]" in text
    assert "base64" in text
    assert "repeatable" in text
    # the flow is spelled out for the agent
    assert "get_template_schema_tool" in text


@respx.mock
def test_suggest_layout_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    from server import suggest_layout
    route = respx.post(f"{BASE}/api/mcp/templates/t1/suggest-layout").mock(
        return_value=httpx.Response(200, json={"candidates": [{"slide_type": "slide_2", "repeatable": True}]}))
    out = suggest_layout("t1", "Severity CRITICAL", {"slide_2": 1})
    assert out["candidates"][0]["slide_type"] == "slide_2"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"


def test_suggest_layout_docstring_mentions_used_and_repeatable():
    from pathlib import Path
    text = (Path(__file__).resolve().parent.parent / "server.py").read_text(encoding="utf-8")
    assert "suggest_layout_tool" in text
    assert "used" in text and "repeatable" in text
