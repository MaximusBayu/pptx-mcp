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


def build_server():
    from fastmcp import FastMCP
    mcp = FastMCP("pptx-mcp")

    @mcp.tool()
    def list_templates_tool() -> list:
        """List templates available to this API key."""
        return list_templates()

    @mcp.tool()
    def get_template_schema_tool(template_id: str) -> dict:
        """Get the slot schema for a template."""
        return get_template_schema(template_id)

    @mcp.tool()
    def render_deck_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render a deck; returns validation + download_url."""
        return render_deck(template_id, deck_spec)

    @mcp.tool()
    def render_preview_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs."""
        return render_preview(template_id, deck_spec)

    return mcp


if __name__ == "__main__":
    build_server().run()
