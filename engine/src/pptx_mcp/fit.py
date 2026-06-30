from .models import Constraints

SHRINK_TOLERANCE = 1.3


def assess_text(value: str | None, c: Constraints) -> tuple[str, str]:
    value = value or ""
    if c.max_lines is not None and len(value.split("\n")) > c.max_lines:
        return "shrink", "over line budget"
    if c.max_chars is not None and len(value) > c.max_chars:
        return "shrink", f"text over limit: {len(value)}/{c.max_chars}"
    return "ok", ""


def assess_table(rows: list[list[object]], c: Constraints) -> tuple[str, str]:
    cols = max((len(r) for r in rows), default=0)
    if c.max_cols is not None and cols > c.max_cols:
        return "reject", f"max {c.max_cols} cols, got {cols}"
    return "ok", ""
