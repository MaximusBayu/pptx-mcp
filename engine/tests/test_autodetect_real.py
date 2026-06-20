"""Classifier quality bar against a real, hand-labeled template.

Spec §2 requires candidate precision/recall >= 0.9 on real decks (not just the
synthetic fixture). Ground truth lives in fixtures/real_deck_labels.json; the
deck itself is committed under 'template example/'. If the deck is absent the
test skips rather than failing, so the suite still runs in stripped checkouts.
"""
import json
from pathlib import Path

import pytest

from pptx_mcp.autodetect import autodetect

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LABELS = Path(__file__).parent / "fixtures" / "real_deck_labels.json"


def _load():
    labels = json.loads(_LABELS.read_text(encoding="utf-8"))
    deck = _REPO_ROOT / labels["deck"]
    if not deck.exists():
        pytest.skip(f"real deck not present: {deck}")
    return labels, autodetect(deck.read_bytes())


def _scores(labels, det):
    gt = {int(k): set(v) for k, v in labels["slots"].items()}
    tp = fp = fn = 0
    for s in det["slides"]:
        if s["index"] not in gt:
            continue
        pos = gt[s["index"]]
        pred = {sh["shape_id"] for sh in s["shapes"] if sh["is_candidate"]}
        tp += len(pred & pos)
        fp += len(pred - pos)
        fn += len(pos - pred)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    return precision, recall


def test_candidate_precision_recall_meet_bar():
    labels, det = _load()
    precision, recall = _scores(labels, det)
    assert precision >= 0.9, f"precision {precision:.3f} below 0.9"
    assert recall >= 0.9, f"recall {recall:.3f} below 0.9"


def test_text_candidates_get_positive_max_chars():
    """Every text candidate on a labeled slide gets a usable char budget."""
    labels, det = _load()
    labeled = {int(k) for k in labels["slots"]}
    for s in det["slides"]:
        if s["index"] not in labeled:
            continue
        for sh in s["shapes"]:
            if sh["is_candidate"] and sh["type"] == "text":
                assert sh["suggested_max_chars"] > 0, f"slide {s['index']} shape {sh['shape_id']}"
