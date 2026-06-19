import base64
import json
import os

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from pptx_mcp.bytesio import load_from_bytes
from pptx_mcp.move import move_shape
from pptx_mcp.preview import libreoffice_available, preview
from pptx_mcp.render import RenderRejected, render
from pptx_mcp.shapes import extract_shapes
from pptx_mcp.validate import validate

app = FastAPI(title="pptx-engine-service")

_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/extract-shapes")
async def extract(file: UploadFile = File(...)):
    return extract_shapes(await file.read())


@app.post("/render-base-previews")
async def base_previews(file: UploadFile = File(...)):
    data = await file.read()
    if not libreoffice_available():
        return {"previews": [], "note": "LibreOffice not available"}
    pngs = preview(data)  # previews of the base file as-is
    return {"previews": [base64.b64encode(p).decode() for p in pngs]}


@app.post("/render-deck")
async def render_deck(file: UploadFile = File(...),
                      manifest: str = Form(...), deck_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        out = render(json.loads(deck_spec), tpl)
    except RenderRejected as e:
        return JSONResponse(status_code=422,
                            content={"validation": [x.to_dict() for x in e.errors]})
    finally:
        # Clean up the temp .pptx written by load_from_bytes to avoid leaking files
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass
    return Response(content=out, media_type=_PPTX)


@app.post("/render-preview")
async def render_preview(file: UploadFile = File(...),
                         manifest: str = Form(...), deck_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        errors = validate(json.loads(deck_spec), tpl)
        if errors:
            return {"validation": [e.to_dict() for e in errors], "previews": []}
        out = render(json.loads(deck_spec), tpl)
        if not libreoffice_available():
            return {"validation": [], "previews": [], "note": "LibreOffice not available"}
        pngs = preview(out)
        return {"validation": [], "previews": [base64.b64encode(p).decode() for p in pngs]}
    finally:
        # Clean up the temp .pptx written by load_from_bytes to avoid leaking files
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass


@app.post("/move-shape")
async def move(file: UploadFile = File(...),
               shape_id: int = Form(...), bbox_pct: str = Form(...)):
    out = move_shape(await file.read(), shape_id, json.loads(bbox_pct))
    return Response(content=out, media_type=_PPTX)
