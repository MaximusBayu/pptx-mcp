from .render import RenderRejected, render
from .schema import get_schema
from .storage import Storage
from .validate import validate


def tool_list_templates(storage: Storage) -> list[dict]:
    out = []
    for tid in storage.list_template_ids():
        tpl = storage.load(tid)
        out.append({
            "id": tpl.id, "name": tpl.name, "description": tpl.description,
            "slide_types": [{"id": st.id, "name": st.name, "description": st.description}
                            for st in tpl.slide_types],
        })
    return out


def tool_get_template_schema(storage: Storage, template_id: str) -> dict:
    return get_schema(storage.load(template_id))


def tool_render_deck(storage: Storage, base_url: str, template_id: str, deck_spec: dict) -> dict:
    tpl = storage.load(template_id)
    try:
        data = render(deck_spec, tpl)
    except RenderRejected as e:
        return {"validation": [err.to_dict() for err in e.errors], "download_url": None}
    token = storage.put_output(data, ".pptx")
    return {"validation": [], "download_url": f"{base_url}/files/{token}"}


def tool_render_preview(storage: Storage, base_url: str, template_id: str, deck_spec: dict) -> dict:
    from .preview import libreoffice_available, preview
    tpl = storage.load(template_id)
    errors = validate(deck_spec, tpl)
    if errors:
        return {"validation": [e.to_dict() for e in errors], "previews": []}
    try:
        data = render(deck_spec, tpl)
    except RenderRejected as e:
        return {"validation": [err.to_dict() for err in e.errors], "previews": []}
    if not libreoffice_available():
        return {"validation": [], "previews": [], "note": "LibreOffice not available"}
    urls = []
    for png in preview(data):
        token = storage.put_output(png, ".png")
        urls.append(f"{base_url}/files/{token}")
    return {"validation": [], "previews": urls}


def build_server(storage: Storage, base_url: str):
    from fastmcp import FastMCP
    mcp = FastMCP("pptx-mcp")

    @mcp.tool()
    def list_templates() -> list[dict]:
        """List available templates and their slide types."""
        return tool_list_templates(storage)

    @mcp.tool()
    def get_template_schema(template_id: str) -> dict:
        """Get full slot schema for a template."""
        return tool_get_template_schema(storage, template_id)

    @mcp.tool()
    def render_deck(template_id: str, deck_spec: dict) -> dict:
        """Validate and render a deck; returns validation + download_url."""
        return tool_render_deck(storage, base_url, template_id, deck_spec)

    @mcp.tool()
    def render_preview(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs; returns validation + preview urls."""
        return tool_render_preview(storage, base_url, template_id, deck_spec)

    return mcp
