import os

import httpx
from fastmcp.exceptions import ToolError


def _base() -> str:
    return os.environ.get("WEB_URL", "http://web:3000")


def _transport() -> str:
    # `or "stdio"` also covers MCP_TRANSPORT being set but empty, which a
    # compose file or a shell prefix can easily produce; a bare .get() would
    # return "" there and fail the transport check.
    return (os.environ.get("MCP_TRANSPORT") or "stdio").strip().lower()


def _api_key() -> str:
    """Resolve the caller's API key for the active transport.

    Over HTTP the key belongs to the caller and arrives per request; falling
    back to PPTX_API_KEY there would serve anonymous callers under the
    operator's key. Over stdio the client launched this process, so the
    environment is the only channel available.
    """
    if _transport() == "stdio":
        return os.environ.get("PPTX_API_KEY", "")
    from fastmcp.server.dependencies import get_http_headers
    key = get_http_headers().get("x-api-key", "").strip()
    if not key:
        raise ToolError("missing x-api-key header")
    return key


def _request(method: str, path: str, api_key: str, **kw):
    r = httpx.request(method, f"{_base()}{path}",
                      headers={"X-API-Key": api_key}, **kw)
    if r.status_code in (401, 403):
        raise ToolError("invalid or revoked API key")
    r.raise_for_status()
    return r.json()


def list_templates(api_key: str) -> list:
    return _request("GET", "/api/mcp/templates", api_key, timeout=30)


def get_template_schema(template_id: str, api_key: str) -> dict:
    return _request("GET", f"/api/mcp/templates/{template_id}/schema",
                    api_key, timeout=30)


def render_deck(template_id: str, deck_spec: dict, api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/render",
                    api_key, json={"deck_spec": deck_spec}, timeout=120)


def render_preview(template_id: str, deck_spec: dict, api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/preview",
                    api_key, json={"deck_spec": deck_spec}, timeout=120)


def suggest_layout(template_id: str, content: str, used: dict | None,
                   api_key: str) -> dict:
    return _request("POST", f"/api/mcp/templates/{template_id}/suggest-layout",
                    api_key, json={"content": content, "used": used or {}},
                    timeout=30)


def build_server():
    from fastmcp import FastMCP
    mcp = FastMCP("pptx-mcp")

    @mcp.tool()
    def list_templates_tool() -> list:
        """List templates available to this API key.

        Start here, then call get_template_schema_tool(template_id) to learn a
        template's slots, then render_deck_tool to produce the .pptx.
        """
        return list_templates(_api_key())

    @mcp.tool()
    def get_template_schema_tool(template_id: str) -> dict:
        """Get a template's slot schema plus a ready-to-edit example_deck_spec.

        Each slide_type lists its slots with id, type, description (hint), and
        example. A slide_type marked "repeatable": true is a pattern meant to be
        reused — to emit it N times, list it once per item in deck_spec.slides.
        Copy example_deck_spec and replace the example values with your content.
        """
        return get_template_schema(template_id, _api_key())

    @mcp.tool()
    def render_deck_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render a deck; returns {validation, download_url, warnings}.

        deck_spec = {"slides": [{"slide_type": <id>, "slots": {<slot_id>: value}}]}.
        Value types: text = str, table = list[list] of strings, image = an http(s)
        URL or a data:image/...;base64,... string. If validation is non-empty the
        deck was rejected — read each message, fix the listed slots, and retry.
        """
        return render_deck(template_id, deck_spec, _api_key())

    @mcp.tool()
    def render_preview_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs (same deck_spec as render_deck_tool).

        Use this to eyeball layout before render_deck_tool produces the final file.
        """
        return render_preview(template_id, deck_spec, _api_key())

    @mcp.tool()
    def suggest_layout_tool(template_id: str, content: str, used: dict | None = None) -> dict:
        """Rank which slide_type best fits a chunk of source content.

        Pass ONE logical section at a time as `content`. Returns ranked
        candidates, each with slide_type, name, repeatable, score, and a reason.
        Pass `used` — a {slide_type_id: count} tally of what you have already
        placed — to get variety: non-repeatable layouts are penalized as they
        repeat, while repeatable layouts are exempt (reuse them once per item,
        e.g. one finding slide per finding).
        """
        return suggest_layout(template_id, content, used, _api_key())

    return mcp


if __name__ == "__main__":
    build_server().run()
