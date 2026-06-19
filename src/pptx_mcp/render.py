import io

from .assembler import assemble
from .filler import fill_slot
from .models import SlotError, Template
from .validate import validate


class RenderRejected(Exception):
    def __init__(self, errors: list[SlotError]):
        self.errors = errors
        super().__init__(f"{len(errors)} validation error(s)")


def render(deck_spec: dict, template: Template) -> bytes:
    errors = validate(deck_spec, template)
    if errors:
        raise RenderRejected(errors)

    slides = deck_spec["slides"]
    order = [template.slide_type(s["slide_type"]).source_slide_index for s in slides]
    prs = assemble(order, template)

    for i, slide_spec in enumerate(slides):
        st = template.slide_type(slide_spec["slide_type"])
        provided = slide_spec.get("slots", {})
        for slot in st.slots:
            value = provided.get(slot.id, slot.default)
            if value is None or value == "":
                continue
            fill_slot(prs.slides[i], slot, value)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()
