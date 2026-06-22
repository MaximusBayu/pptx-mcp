import os

import httpx


def _base() -> str:
    return os.environ.get("WEB_URL", "http://web:3000")


def _headers() -> dict:
    return {"X-API-Key": os.environ.get("PPTX_API_KEY", "")}


def list_templates() -> list:
    r = httpx.get(f"{_base()}/api/mcp/templates", headers=_headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def get_template_schema(template_id: str) -> dict:
    r = httpx.get(f"{_base()}/api/mcp/templates/{template_id}/schema", headers=_headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def render_deck(template_id: str, deck_spec: dict) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/render",
                   headers=_headers(), json={"deck_spec": deck_spec}, timeout=120)
    r.raise_for_status()
    return r.json()


def render_preview(template_id: str, deck_spec: dict) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/preview",
                   headers=_headers(), json={"deck_spec": deck_spec}, timeout=120)
    r.raise_for_status()
    return r.json()


def suggest_layout(template_id: str, content: str, used: dict | None = None) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/suggest-layout",
                   headers=_headers(), json={"content": content, "used": used or {}}, timeout=30)
    r.raise_for_status()
    return r.json()


def build_server():
    from fastmcp import FastMCP
    mcp = FastMCP("pptx-mcp")

    @mcp.tool()
    def list_templates_tool() -> list:
        """List templates available to this API key.

        Start here, then call get_template_schema_tool(template_id) to learn a
        template's slots, then render_deck_tool to produce the .pptx.
        """
        return list_templates()

    @mcp.tool()
    def get_template_schema_tool(template_id: str) -> dict:
        """Get a template's slot schema plus a ready-to-edit example_deck_spec.

        Each slide_type lists its slots with id, type, description (hint), and
        example. A slide_type marked "repeatable": true is a pattern meant to be
        reused — to emit it N times, list it once per item in deck_spec.slides.
        Copy example_deck_spec and replace the example values with your content.
        """
        return get_template_schema(template_id)

    @mcp.tool()
    def render_deck_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render a deck; returns {validation, download_url, warnings}.

        deck_spec = {"slides": [{"slide_type": <id>, "slots": {<slot_id>: value}}]}.
        Value types: text = str, table = list[list] of strings, image = an http(s)
        URL or a data:image/...;base64,... string. If validation is non-empty the
        deck was rejected — read each message, fix the listed slots, and retry.
        """
        return render_deck(template_id, deck_spec)

    @mcp.tool()
    def render_preview_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs (same deck_spec as render_deck_tool).

        Use this to eyeball layout before render_deck_tool produces the final file.
        """
        return render_preview(template_id, deck_spec)

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
        return suggest_layout(template_id, content, used)

    return mcp


if __name__ == "__main__":
    build_server().run()
