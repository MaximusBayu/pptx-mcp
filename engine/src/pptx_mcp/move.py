import io

from pptx import Presentation


def move_shape(pptx_bytes: bytes, shape_id: int, bbox_pct: dict) -> bytes:
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    for slide in prs.slides:
        for shp in slide.shapes:
            if shp.shape_id == shape_id:
                shp.left = int(sw * bbox_pct["x"] / 100.0)
                shp.top = int(sh * bbox_pct["y"] / 100.0)
                shp.width = int(sw * bbox_pct["w"] / 100.0)
                shp.height = int(sh * bbox_pct["h"] / 100.0)
                buf = io.BytesIO()
                prs.save(buf)
                return buf.getvalue()
    raise KeyError(f"shape_id {shape_id} not found")
