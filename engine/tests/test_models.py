from pptx_mcp.models import Constraints, Slot, SlideType, Template, SlotError


def _slot():
    return Slot(id="title", name="Title", type="text", shape_id=5,
                required=True, constraints=Constraints(max_chars=40))


def test_slide_type_lookup():
    st = SlideType(id="t", name="T", description="", source_slide_index=0, slots=[_slot()])
    assert st.slot("title").shape_id == 5
    assert st.slot("missing") is None


def test_template_lookup():
    st = SlideType(id="t", name="T", description="", source_slide_index=0, slots=[_slot()])
    tpl = Template(id="x", name="X", description="", slide_types=[st], pptx_path="b.pptx")
    assert tpl.slide_type("t") is st
    assert tpl.slide_type("none") is None


def test_sloterror_to_dict():
    e = SlotError(slide_index=2, slot_id="title", code="text_overflow", message="too long")
    assert e.to_dict() == {"slide_index": 2, "slot_id": "title",
                           "code": "text_overflow", "message": "too long"}
