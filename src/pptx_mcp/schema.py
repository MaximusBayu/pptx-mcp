from dataclasses import asdict

from .models import Template


def _slot_dict(slot) -> dict:
    return {
        "id": slot.id, "name": slot.name, "type": slot.type,
        "required": slot.required, "default": slot.default,
        "constraints": {k: v for k, v in asdict(slot.constraints).items() if v is not None},
    }


def get_schema(template: Template) -> dict:
    return {
        "id": template.id, "name": template.name, "description": template.description,
        "slide_types": [
            {
                "id": st.id, "name": st.name, "description": st.description,
                "slots": [_slot_dict(s) for s in st.slots],
            }
            for st in template.slide_types
        ],
    }
