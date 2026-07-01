from .autodetect import _rect_overlap_frac

OVERLAP_TAU = 0.25
CONTRAST_MIN = 3.0


def _channel(c: float) -> float:
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _luminance(hex6: str) -> float:
    r, g, b = (int(hex6[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def _contrast_ratio(hex_a: str, hex_b: str) -> float:
    la, lb = _luminance(hex_a), _luminance(hex_b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _clamp_rect(r: dict) -> dict:
    x = min(max(r["x"], 0.0), 100.0)
    y = min(max(r["y"], 0.0), 100.0)
    w = min(r["w"], 100.0 - x)
    h = min(r["h"], 100.0 - y)
    return {"x": x, "y": y, "w": w, "h": h}


def _warn(cid, code, message):
    return {"slide_index": 0, "slot_id": cid, "code": code, "message": message}


def check_layout(placed):
    """Pure layout guardrail pass over placed shapes (rects in slide-percent).
    Returns (warnings, clamps). Warnings carry slide_index=0 (compose reassigns
    it); clamps maps component_id -> the corrected rect the caller must apply."""
    warnings = []
    clamps = {}

    for i in range(len(placed)):
        for j in range(i + 1, len(placed)):
            a, b = placed[i]["rect"], placed[j]["rect"]
            frac = max(_rect_overlap_frac(a, b), _rect_overlap_frac(b, a))
            if frac >= OVERLAP_TAU:
                ci, cj = placed[i]["component_id"], placed[j]["component_id"]
                warnings.append(_warn(ci, "overlap",
                                      f"{ci} overlaps {cj} ({round(frac * 100)}%)"))

    for p in placed:
        clamped = _clamp_rect(p["rect"])
        if clamped != p["rect"]:
            clamps[p["component_id"]] = clamped
            warnings.append(_warn(p["component_id"], "clamped",
                                  f"{p['component_id']} clamped into slide bounds"))

    for p in placed:
        tc, bg = p.get("text_color"), p.get("eff_bg")
        if tc and bg:
            ratio = _contrast_ratio(tc, bg)
            if ratio < CONTRAST_MIN:
                warnings.append(_warn(p["component_id"], "low_contrast",
                                      f"{p['component_id']} contrast {round(ratio, 2)} < {CONTRAST_MIN}"))

    return warnings, clamps
