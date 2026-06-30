from pptx_mcp.tablefit import redistribute, MIN_COL_FRAC, MIN_ROW_FRAC


def test_sizes_sum_exactly_to_total():
    sizes = redistribute([1.0, 3.0, 6.0], 1000, 80)
    assert sum(sizes) == 1000


def test_every_slot_at_least_min_each():
    sizes = redistribute([0.0, 100.0, 1.0], 900, 80)
    assert all(s >= 80 for s in sizes)


def test_higher_demand_gets_more():
    sizes = redistribute([1.0, 10.0], 1000, 80)
    assert sizes[1] > sizes[0]


def test_all_equal_demands_even_split():
    sizes = redistribute([5.0, 5.0, 5.0], 900, 80)
    assert sizes == [300, 300, 300]


def test_all_zero_demands_even_split():
    sizes = redistribute([0.0, 0.0, 0.0], 900, 80)
    assert sizes == [300, 300, 300]


def test_no_room_to_differentiate_even_split():
    # total <= n*min_each -> even split regardless of demand
    sizes = redistribute([1.0, 99.0], 100, 80)
    assert sum(sizes) == 100
    assert abs(sizes[0] - sizes[1]) <= 1


def test_single_slot_returns_unchanged_total():
    assert redistribute([7.0], 1000, 80) == [1000]


def test_empty_demands():
    assert redistribute([], 1000, 80) == []


def test_fracs_are_constants():
    assert MIN_COL_FRAC == 0.08
    assert MIN_ROW_FRAC == 0.08
