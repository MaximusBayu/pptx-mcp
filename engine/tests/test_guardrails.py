from pptx_mcp.guardrails import check_layout, _contrast_ratio, _clamp_rect


def _p(cid, rect, text_color=None, eff_bg=None):
    return {"component_id": cid, "rect": rect,
            "text_color": text_color, "eff_bg": eff_bg}


def test_overlap_warns():
    placed = [
        _p("0:1", {"x": 10, "y": 10, "w": 40, "h": 40}),
        _p("0:2", {"x": 20, "y": 20, "w": 40, "h": 40}),
    ]
    warns, clamps = check_layout(placed)
    assert any(w["code"] == "overlap" for w in warns)


def test_no_overlap_no_warn():
    placed = [
        _p("0:1", {"x": 0, "y": 0, "w": 20, "h": 20}),
        _p("0:2", {"x": 60, "y": 60, "w": 20, "h": 20}),
    ]
    warns, clamps = check_layout(placed)
    assert not any(w["code"] == "overlap" for w in warns)


def test_off_slide_clamped():
    placed = [_p("0:1", {"x": 90, "y": 10, "w": 30, "h": 20})]
    warns, clamps = check_layout(placed)
    assert "0:1" in clamps
    assert clamps["0:1"]["w"] == 10  # 100 - 90
    assert any(w["code"] == "clamped" for w in warns)


def test_low_contrast_warns():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color="FFFFFF", eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert any(w["code"] == "low_contrast" for w in warns)


def test_adequate_contrast_no_warn():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color="000000", eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert not any(w["code"] == "low_contrast" for w in warns)


def test_unresolvable_color_skipped():
    placed = [_p("0:1", {"x": 0, "y": 0, "w": 10, "h": 10},
                text_color=None, eff_bg="FFFFFF")]
    warns, _ = check_layout(placed)
    assert not any(w["code"] == "low_contrast" for w in warns)


def test_contrast_ratio_black_white_is_21():
    assert round(_contrast_ratio("000000", "FFFFFF"), 1) == 21.0


def test_clamp_rect_pulls_into_bounds():
    assert _clamp_rect({"x": -5, "y": 10, "w": 50, "h": 20}) == {
        "x": 0.0, "y": 10, "w": 50, "h": 20}
