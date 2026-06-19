from pptx_mcp.fit import assess_text, assess_table
from pptx_mcp.models import Constraints


def test_text_ok_within_limit():
    d, _ = assess_text("hello", Constraints(max_chars=10, max_lines=1))
    assert d == "ok"


def test_text_shrink_in_tolerance():
    # max 10, tolerance 1.3 -> up to 13 chars shrinks
    d, _ = assess_text("x" * 12, Constraints(max_chars=10, max_lines=2))
    assert d == "shrink"


def test_text_reject_beyond_tolerance():
    d, msg = assess_text("x" * 20, Constraints(max_chars=10, max_lines=2))
    assert d == "reject"
    assert "20" in msg


def test_text_reject_too_many_lines():
    d, _ = assess_text("a\nb\nc", Constraints(max_chars=100, max_lines=2))
    assert d == "reject"


def test_text_no_constraints_ok():
    d, _ = assess_text("anything", Constraints())
    assert d == "ok"


def test_table_ok():
    d, _ = assess_table([[1, 2], [3, 4]], Constraints(max_rows=3, max_cols=3))
    assert d == "ok"


def test_table_reject_rows():
    d, msg = assess_table([[1]] * 5, Constraints(max_rows=3, max_cols=3))
    assert d == "reject"
    assert "row" in msg.lower()
