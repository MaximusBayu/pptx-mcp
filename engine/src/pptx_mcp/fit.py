from .models import Constraints

SHRINK_TOLERANCE = 1.3


def assess_text(value: str | None, c: Constraints) -> tuple[str, str]:
    value = value or ""
    if c.max_lines is not None:
        lines = value.split("\n")
        if len(lines) > c.max_lines:
            return "reject", f"too many lines: {len(lines)}/{c.max_lines}"
    if c.max_chars is not None:
        n = len(value)
        if n > c.max_chars * SHRINK_TOLERANCE:
            return "reject", f"text too long: {n}/{c.max_chars}"
        if n > c.max_chars:
            return "shrink", f"text over limit, shrinking: {n}/{c.max_chars}"
    return "ok", ""


def assess_table(rows: list[list[object]], c: Constraints) -> tuple[str, str]:
    if c.max_rows is not None and len(rows) > c.max_rows:
        return "reject", f"too many rows: {len(rows)}/{c.max_rows}"
    cols = max((len(r) for r in rows), default=0)
    if c.max_cols is not None and cols > c.max_cols:
        return "reject", f"too many cols: {cols}/{c.max_cols}"
    return "ok", ""
