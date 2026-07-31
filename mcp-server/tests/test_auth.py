import httpx
import pytest
import respx
from fastmcp.exceptions import ToolError

import server

BASE = "http://web:3000"


def test_stdio_mode_reads_key_from_env(monkeypatch):
    monkeypatch.delenv("MCP_TRANSPORT", raising=False)
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    assert server._api_key() == "pk_env"


def test_http_mode_reads_key_from_request_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    # The env key must be ignored in http mode, so set it to a distinct value.
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {"x-api-key": "pk_header"})
    assert server._api_key() == "pk_header"


def test_http_mode_rejects_missing_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setenv("PPTX_API_KEY", "pk_env")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {})
    with pytest.raises(ToolError) as excinfo:
        server._api_key()
    assert str(excinfo.value) == "missing x-api-key header"


def test_http_mode_rejects_blank_header(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setattr("fastmcp.server.dependencies.get_http_headers",
                        lambda *a, **k: {"x-api-key": "   "})
    with pytest.raises(ToolError):
        server._api_key()


@respx.mock
def test_upstream_401_maps_to_tool_error(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(401, json={"error": "unauthorized"}))
    with pytest.raises(ToolError) as excinfo:
        server.list_templates("pk_bad")
    assert str(excinfo.value) == "invalid or revoked API key"


@respx.mock
def test_upstream_403_maps_to_tool_error(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"}))
    with pytest.raises(ToolError):
        server.list_templates("pk_bad")


@respx.mock
def test_upstream_500_maps_to_tool_error_without_leaking_internal_host(monkeypatch):
    """A non-401/403 upstream failure must not leak internal topology.

    httpx.Response.raise_for_status() embeds the full request URL (e.g.
    http://web:3000/api/mcp/templates) in its message, and that message is
    relayed straight to the remote MCP caller. The status and the relative
    API path are useful to the caller; the internal hostname is not.
    """
    monkeypatch.setenv("WEB_URL", BASE)
    respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(500, text="boom"))
    with pytest.raises(ToolError) as excinfo:
        server.list_templates("pk_ok")
    message = str(excinfo.value)
    assert "500" in message
    assert "/api/mcp/templates" in message
    assert BASE not in message
    assert "web:3000" not in message
