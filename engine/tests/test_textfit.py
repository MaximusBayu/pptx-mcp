from pptx_mcp.textfit import truncate_to_sentence


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
