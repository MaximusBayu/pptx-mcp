from pptx_mcp.textfit import fit_text, FitResult, LINE_SPACING_FLOOR, truncate_to_sentence


# Box geometry chosen so the fit decisions are deterministic.
# EMU_PER_PT=12700, GLYPH_W=0.5, LINE_H=1.2.
_W = 2_000_000   # ~17 chars/line at 18pt
_H = 450_000     # 1 line at 18pt/1.2 spacing; more as spacing/font shrink


def test_fit_short_text_in_large_box_unchanged():
    res = fit_text("Hello", 10_000_000, 5_000_000, 18.0, 10.0, 1.2)
    assert res.font_pt == 18.0
    assert res.line_spacing == 1.2
    assert res.value == "Hello"
    assert res.dropped == ""


def test_fit_reduces_spacing_first_keeping_font():
    # 30 chars on one line -> 2 wrapped lines; box too short at 1.2 spacing,
    # fits once spacing drops below base (font stays at base).
    res = fit_text("abcdefghij abcdefghij abcdefgh", _W, _H, 18.0, 10.0, 1.2)
    assert res.font_pt == 18.0
    assert LINE_SPACING_FLOOR <= res.line_spacing < 1.2
    assert res.dropped == ""


def test_fit_reduces_font_after_spacing_floored():
    # 60 chars -> needs more lines than fit even at the spacing floor;
    # font shrinks (spacing pinned at the floor).
    res = fit_text("x" * 60, _W, _H, 18.0, 10.0, 1.2)
    assert res.line_spacing == LINE_SPACING_FLOOR
    assert 10.0 <= res.font_pt < 18.0
    assert res.dropped == ""


def test_fit_truncates_at_floor_when_nothing_fits():
    long = ("Sentence one is here. Sentence two follows on. "
            "Sentence three keeps going. " * 6)
    res = fit_text(long, _W, _H, 18.0, 10.0, 1.2)
    assert res.font_pt == 10.0
    assert res.line_spacing == LINE_SPACING_FLOOR
    assert res.dropped != ""
    assert len(res.value) < len(long)


def test_fit_zero_dims_returns_input_unchanged():
    res = fit_text("anything at all", 0, 0, 18.0, 10.0, 1.2)
    assert res == FitResult(18.0, 1.2, "anything at all", "")


def test_keeps_whole_sentences_within_limit():
    t = "One sentence here. Two follows now. Three is extra."
    kept, dropped = truncate_to_sentence(t, 36)
    assert kept == "One sentence here. Two follows now."
    assert dropped == "Three is extra."


def test_never_splits_a_word():
    t = "Supercalifragilistic expialidocious wording"
    kept, dropped = truncate_to_sentence(t, 25)
    assert not kept.endswith(" ")
    assert "expialidoci" not in kept or kept.endswith("expialidocious")


def test_no_truncation_when_within_limit():
    t = "Short enough."
    assert truncate_to_sentence(t, 100) == ("Short enough.", "")


def test_falls_back_to_word_when_no_sentence_fits():
    t = "This single very long sentence has no early period at all"
    kept, dropped = truncate_to_sentence(t, 20)
    assert len(kept) <= 20
    assert dropped
    assert not kept.endswith(" ")


def test_height_for_grows_with_more_text():
    from pptx_mcp.textfit import height_for
    w = 3_000_000
    short = height_for("one line", w, 18.0, 1.0)
    long = height_for("x" * 4000, w, 18.0, 1.0)
    assert long > short > 0


def test_height_for_zero_width_is_zero():
    from pptx_mcp.textfit import height_for
    assert height_for("anything", 0, 18.0, 1.0) == 0
