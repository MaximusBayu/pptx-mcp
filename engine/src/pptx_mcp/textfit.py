import re

_SENTENCE = re.compile(r"[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$")


def truncate_to_sentence(text: str, max_chars: int) -> tuple[str, str]:
    text = text or ""
    if len(text) <= max_chars:
        return text, ""

    sentences = [m.group(0) for m in _SENTENCE.finditer(text)]
    kept = ""
    for s in sentences:
        if len(kept) + len(s) <= max_chars:
            kept += s
        else:
            break
    kept = kept.rstrip()
    if kept:
        return kept, text[len(kept):].lstrip()

    words = text.split(" ")
    kept = ""
    for w in words:
        nxt = w if not kept else kept + " " + w
        if len(nxt) <= max_chars:
            kept = nxt
        else:
            break
    kept = kept.rstrip()
    return kept, text[len(kept):].lstrip()
