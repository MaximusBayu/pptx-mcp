"""Pure column/row size redistribution within a fixed total.

Used by the table filler to widen columns / heighten rows that need space,
borrowing from those with slack, while keeping the table's footprint constant.
No python-pptx dependency so it is cheap to unit-test.
"""

MIN_COL_FRAC = 0.08
MIN_ROW_FRAC = 0.08


def _max_index(demands: list[float]) -> int:
    best = 0
    for i in range(1, len(demands)):
        if demands[i] > demands[best]:
            best = i
    return best


def _even_split(total: int, n: int) -> list[int]:
    base = total // n
    sizes = [base] * n
    sizes[0] += total - base * n  # rounding remainder to the first slot
    return sizes


def redistribute(demands: list[float], total: int, min_each: int) -> list[int]:
    """Allocate `total` across len(demands) slots in proportion to demand.

    Every slot gets at least `min_each`; the remainder is split by demand.
    Returned sizes sum exactly to `total`. All-zero or all-equal demands, or
    `total <= n*min_each` (no room to differentiate), produce an even split.
    """
    n = len(demands)
    if n == 0:
        return []
    if total <= n * min_each:
        return _even_split(total, n)
    dsum = sum(demands)
    if dsum <= 0 or len(set(demands)) == 1:
        return _even_split(total, n)
    extra = total - n * min_each
    sizes = [min_each + int(extra * (d / dsum)) for d in demands]
    # Assign the rounding remainder to the largest-demand slot.
    sizes[_max_index(demands)] += total - sum(sizes)
    return sizes
