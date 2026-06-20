import io

from pptx.util import Pt

from .assembler import find_shape
from .fit import assess_text
from .models import Slot, SlotError
from .textfit import truncate_to_sentence

_BASE_PT = 24.0
_SHRINK_STEP = 4.0
_MIN_PT = 12.0


def fill_slot(slide, slot: Slot, value) -> list[SlotError]:
    shape = find_shape(slide, slot.shape_id)
    if slot.type == "text":
        return _fill_text(shape, slot, value)
    if slot.type == "table":
        _fill_table(shape, value)
    elif slot.type == "image":
        _fill_image(slide, shape, value)
    return []


def _fill_text(shape, slot: Slot, value: str) -> list[SlotError]:
    warnings: list[SlotError] = []
    tf = shape.text_frame
    decision, _ = assess_text(value, slot.constraints)
    if decision == "shrink":
        floor = slot.constraints.shrink_floor_pt or _MIN_PT
        new_pt = max(floor, _BASE_PT - _SHRINK_STEP)
        max_chars = slot.constraints.max_chars
        if max_chars is not None:
            capacity = int(max_chars * (_BASE_PT / new_pt))
            if len(value) > capacity:
                value, dropped = truncate_to_sentence(value, capacity)
                if dropped:
                    warnings.append(SlotError(0, slot.id, "text_truncated",
                                              f"dropped {len(dropped)} chars to fit"))
        tf.text = value
        for para in tf.paragraphs:
            for run in para.runs:
                run.font.size = Pt(new_pt)
    else:
        tf.text = value
    return warnings


def _fill_table(shape, rows: list[list]) -> None:
    table = shape.table
    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            if r < len(table.rows) and c < len(table.columns):
                table.cell(r, c).text = str(val)


def _fill_image(slide, shape, value) -> None:
    if isinstance(value, bytes):
        data = value
    else:
        with open(value, "rb") as fh:
            data = fh.read()
    left, top, width, height = shape.left, shape.top, shape.width, shape.height
    shape._element.getparent().remove(shape._element)
    slide.shapes.add_picture(io.BytesIO(data), left, top, width, height)
