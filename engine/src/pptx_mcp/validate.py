from .fit import assess_table, assess_text
from .models import SlotError, Template


def validate(deck_spec: dict, template: Template) -> list[SlotError]:
    errors: list[SlotError] = []
    slides = deck_spec.get("slides", [])
    for i, slide in enumerate(slides):
        st = template.slide_type(slide.get("slide_type"))
        if st is None:
            avail = [t.id for t in template.slide_types]
            errors.append(SlotError(i, None, "unknown_slide_type",
                                    f"{slide.get('slide_type')!r}; available: {avail}"))
            continue
        provided = slide.get("slots", {})
        for slot_id in provided:
            if st.slot(slot_id) is None:
                errors.append(SlotError(i, slot_id, "unknown_slot",
                                        f"expected: {[s.id for s in st.slots]}"))
        for slot in st.slots:
            if slot.id not in provided:
                if slot.required and slot.default is None:
                    errors.append(SlotError(i, slot.id, "missing_required_slot",
                                            f"slot {slot.id} is required"))
                continue
            errors.extend(_check_value(i, slot, provided[slot.id]))
    return errors


def _check_value(i: int, slot, value) -> list[SlotError]:
    if slot.type == "text":
        if not isinstance(value, str):
            return [SlotError(i, slot.id, "wrong_type", "expected text (str)")]
        decision, msg = assess_text(value, slot.constraints)
        if decision == "reject":
            return [SlotError(i, slot.id, "text_overflow", msg)]
    elif slot.type == "table":
        if not (isinstance(value, list) and all(isinstance(r, list) for r in value)):
            return [SlotError(i, slot.id, "wrong_type", "expected table (list[list])")]
        decision, msg = assess_table(value, slot.constraints)
        if decision == "reject":
            return [SlotError(i, slot.id, "table_overflow", msg)]
    elif slot.type == "image":
        if not value or not isinstance(value, (str, bytes)):
            return [SlotError(i, slot.id, "image_invalid", "expected image str/bytes")]
    return []
