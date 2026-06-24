import io

from .assembler import assemble
from .filler import clear_slot, fill_slot
from .models import SlotError, Template
from .validate import validate


class RenderRejected(Exception):
    def __init__(self, errors: list[SlotError]):
        self.errors = errors
        super().__init__(f"{len(errors)} validation error(s)")


def render(deck_spec: dict, template: Template) -> tuple[bytes, list[dict]]:
    errors = validate(deck_spec, template)
    if errors:
        raise RenderRejected(errors)

    slides = deck_spec["slides"]
    order = [template.slide_type(s["slide_type"]).source_slide_index for s in slides]
    prs = assemble(order, template)

    warnings: list[dict] = []
    for i, slide_spec in enumerate(slides):
        st = template.slide_type(slide_spec["slide_type"])
        provided = slide_spec.get("slots", {})
        for slot in st.slots:
            value = provided.get(slot.id, slot.default)
            if value is None or value == "":
                clear_slot(prs.slides[i], slot)
                continue
            for w in fill_slot(prs.slides[i], slot, value):
                w.slide_index = i
                warnings.append(w.to_dict())

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), warnings


def dry_run(deck_spec: dict, template: Template) -> dict:
    """Validate + fill without producing output; return errors and warnings.

    Reuses render() (which fills every slot) and discards the bytes, so callers
    get the same constraint errors and truncation warnings a real render would,
    without a download or a LibreOffice preview.
    """
    try:
        _bytes, warnings = render(deck_spec, template)
    except RenderRejected as e:
        return {"errors": [err.to_dict() for err in e.errors], "warnings": []}
    return {"errors": [], "warnings": warnings}
