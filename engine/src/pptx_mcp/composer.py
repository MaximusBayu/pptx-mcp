import re

from pptx import Presentation

from .catalog import get_catalog
from .models import SlotError, Template

_CID_RE = re.compile(r"^\d+:\d+$")
# catalog type -> predicate the content value must satisfy
_CONTENT_OK = {
    "text": lambda v: isinstance(v, str),
    "table": lambda v: isinstance(v, list) and all(isinstance(r, list) for r in v),
    "image": lambda v: bool(v) and isinstance(v, (str, bytes)),
}


class ComposeRejected(Exception):
    def __init__(self, errors: list[SlotError]):
        self.errors = errors
        super().__init__(f"{len(errors)} composition error(s)")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _bbox_ok(b) -> bool:
    if not isinstance(b, dict) or not all(k in b for k in ("x", "y", "w", "h")):
        return False
    if not all(_num(b[k]) for k in ("x", "y", "w", "h")):
        return False
    if not (0 <= b["x"] <= 100 and 0 <= b["y"] <= 100):
        return False
    return 0 < b["w"] <= 100 and 0 < b["h"] <= 100


def validate_composition(composition_spec: dict, template: Template) -> list[SlotError]:
    cat = get_catalog(template)
    by_id = {c["component_id"]: c for c in cat["components"]}
    n_slides = len(Presentation(template.pptx_path).slides)

    errors: list[SlotError] = []
    for i, slide in enumerate(composition_spec.get("slides", [])):
        canvas = slide.get("canvas")
        if not isinstance(canvas, int) or isinstance(canvas, bool) or not (0 <= canvas < n_slides):
            errors.append(SlotError(i, None, "unknown_canvas",
                                    f"canvas {canvas!r}; slides 0..{n_slides - 1}"))
        for placement in slide.get("placements", []):
            cid = placement.get("component_id")
            if not isinstance(cid, str) or not _CID_RE.match(cid) or cid not in by_id:
                errors.append(SlotError(i, cid, "unknown_component",
                                        f"no component {cid!r} in template"))
                continue
            ctype = by_id[cid]["type"]
            if "content" in placement and placement["content"] is not None:
                check = _CONTENT_OK.get(ctype)
                if check is None or not check(placement["content"]):
                    errors.append(SlotError(i, cid, "wrong_type",
                                            f"content not valid for {ctype} component"))
            if "bbox_pct" in placement and not _bbox_ok(placement["bbox_pct"]):
                errors.append(SlotError(i, cid, "bad_bbox",
                                        "bbox_pct needs numeric x,y(0-100), w,h(0-100, >0)"))
    return errors
