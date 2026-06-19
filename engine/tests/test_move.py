import io
from pptx import Presentation
from pptx_mcp.move import move_shape


def _first_shape(sample_template_dir):
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    return prs.slides[0].shapes[0].shape_id


def test_move_shape_repositions(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    sid = _first_shape(sample_template_dir)
    out = move_shape(pptx, sid, {"x": 10, "y": 20, "w": 50, "h": 25})
    prs = Presentation(io.BytesIO(out))
    sw, sh = prs.slide_width, prs.slide_height
    moved = next(s for s in prs.slides[0].shapes if s.shape_id == sid)
    assert abs(moved.left - sw * 0.10) < 5000
    assert abs(moved.top - sh * 0.20) < 5000
