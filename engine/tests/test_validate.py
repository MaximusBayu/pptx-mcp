from pptx_mcp.template import load_template
from pptx_mcp.validate import validate


def _good_deck():
    return {"slides": [
        {"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}},
        {"slide_type": "bullet", "slots": {"heading": "H", "body": "a\nb"}},
    ]}


def test_valid_deck_no_errors(sample_template_dir):
    tpl = load_template(sample_template_dir)
    assert validate(_good_deck(), tpl) == []


def test_unknown_slide_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "nope", "slots": {}}]}, tpl)
    assert errs[0].code == "unknown_slide_type"


def test_unknown_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "title", "slots": {"title": "x", "bogus": "y"}}]}, tpl)
    assert any(e.code == "unknown_slot" for e in errs)


def test_missing_required(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "title", "slots": {"subtitle": "x"}}]}, tpl)
    assert any(e.code == "missing_required_slot" and e.slot_id == "title" for e in errs)


def test_text_over_limit_not_rejected(sample_template_dir):
    # Text overflow is now non-fatal (shrink+cut at fill time), not a validation error
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "title", "slots": {"title": "x" * 100}}]}, tpl)
    assert not any(e.code == "text_overflow" for e in errs)
    assert errs == []


def test_text_shrink_not_error(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # title max 40, any over-limit text is now a non-fatal shrink+cut
    errs = validate({"slides": [{"slide_type": "title", "slots": {"title": "x" * 45}}]}, tpl)
    assert errs == []


def test_table_overflow_rejects(sample_template_dir):
    tpl = load_template(sample_template_dir)
    rows = [[1, 2]] * 9  # max_rows 5
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    assert any(e.code == "table_overflow" for e in errs)


def test_wrong_type_message_names_the_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "title", "slots": {"title": 123}}]}, tpl)
    e = next(e for e in errs if e.code == "wrong_type")
    assert "text" in e.message and "int" in e.message


def test_table_overflow_message_has_numbers(sample_template_dir):
    tpl = load_template(sample_template_dir)
    rows = [[1, 2]] * 9  # max_rows 5
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    e = next(e for e in errs if e.code == "table_overflow")
    assert "5" in e.message and "9" in e.message


def test_image_invalid_message_names_the_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "image", "slots": {"photo": 5}}]}, tpl)
    e = next(e for e in errs if e.code == "image_invalid")
    assert "int" in e.message
