from dataclasses import asdict

from pptx import Presentation

from .assembler import find_shape
from .autodetect import DEFAULT_FONT_PT, _first_font_pt, estimate_max_chars
from .models import Template


def _slot_dict(slot) -> dict:
    return {
        "id": slot.id, "name": slot.name, "type": slot.type,
        "required": slot.required, "default": slot.default,
        "constraints": {k: v for k, v in asdict(slot.constraints).items() if v is not None},
    }


def _slot_geometry(slide, slot) -> dict | None:
    try:
        shape = find_shape(slide, slot.shape_id)
    except KeyError:
        return None
    w, h = int(shape.width or 0), int(shape.height or 0)
    font_pt = capacity = None
    if slot.type == "text":
        font_pt = _first_font_pt(shape) or DEFAULT_FONT_PT
        capacity, _ = estimate_max_chars(w, h, font_pt)
    return {"width_emu": w, "height_emu": h,
            "font_pt": font_pt, "capacity_chars": capacity}


def get_schema(template: Template) -> dict:
    prs = Presentation(template.pptx_path)
    slide_types = []
    for st in template.slide_types:
        slide = prs.slides[st.source_slide_index]
        slots = [{**_slot_dict(s), "geometry": _slot_geometry(slide, s)} for s in st.slots]
        slide_types.append({
            "id": st.id, "name": st.name, "description": st.description,
            "slots": slots,
        })
    return {
        "id": template.id, "name": template.name, "description": template.description,
        "slide_types": slide_types,
    }
