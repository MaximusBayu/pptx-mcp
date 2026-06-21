# Template Auto-detect, Fit Validation & UI Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect which template shapes are fillable slots and pre-fill their id/type/max_chars, validate both box placement and content fit, and reskin the web app with a soft-modern matcha design system.

**Architecture:** Geometry + classification live in the Python engine (new `autodetect.py`, exposed via engine-service `POST /autodetect`); the web app calls it at upload time and stores the result as the draft manifest. The editor renders boxes color-coded by confidence with undo/redo and placement validation. Overflow handling moves into the engine fit/fill path (shrink → sentence-cut → report).

**Tech Stack:** Python 3.11+, python-pptx, FastAPI (engine-service), pytest; Next.js 14 App Router, TypeScript, Tailwind, Framer Motion, Vitest/RTL, Playwright.

## Global Constraints

- Engine package import root: `pptx_mcp` (under `engine/src/`); tests run from `engine/` (`pythonpath=["src"]`).
- python-pptx units are EMU; `1 pt = 12700 EMU`, `1 inch = 914400 EMU`.
- Slot field model: `Slot{id,name,type,shape_id,required,default,constraints}`, `Constraints{max_chars,max_lines,shrink_floor_pt,max_rows,max_cols,fit}` (see `engine/src/pptx_mcp/models.py`). Reuse these — do not introduce parallel types.
- bbox is percent-of-slide: `{x,y,w,h}` floats in 0..100 (see `shapes.py`).
- Web tests mock `@/lib/prisma` and `@/lib/auth`; no live DB in unit tests.
- Vitest is scoped to `tests/**/*.test.{ts,tsx}`; Playwright specs live in `web/e2e/`.
- All motion honors `prefers-reduced-motion`. Color is never the only signal.
- Commit messages end with the Co-Authored-By trailer used in this repo.

---

## File Structure

**Engine**
- `engine/src/pptx_mcp/autodetect.py` (new) — classifier + field derivation + per-deck assembly.
- `engine/src/pptx_mcp/textfit.py` (new) — sentence-aware truncation helper.
- `engine/src/pptx_mcp/fit.py` (modify) — text path returns shrink/ok only (reject removed for text).
- `engine/src/pptx_mcp/filler.py` (modify) — apply shrink + sentence-cut, surface dropped tail.
- `engine/src/pptx_mcp/render.py` (modify) — collect non-fatal overflow warnings, return alongside bytes.
- `engine-service/app.py` (modify) — `POST /autodetect`; `/render-deck` returns warnings header.
- `engine/tests/` (new tests) — `test_autodetect.py`, `test_textfit.py`, plus conftest fixture additions.

**Web**
- `web/src/lib/engine.ts` (modify) — `autodetect()` client; `renderDeck` returns `warnings`.
- `web/src/app/api/templates/route.ts` (modify) — call `autodetect` on upload, store draft.
- `web/src/lib/placement.ts` (new) — pure off-slide / overlap geometry checks.
- `web/src/lib/editorHistory.ts` (new) — undo/redo reducer.
- `web/src/components/TagEditor.tsx` (modify) — confidence colors, placement, history wiring.
- `web/src/app/(app)/templates/[id]/edit/EditClient.tsx` (modify) — undo/redo buttons, save gate.
- `web/tailwind.config.ts` (modify), `web/src/app/globals.css` (modify) — matcha tokens.
- Component refit: `web/src/app/(app)/layout.tsx`, `dashboard/DashboardGrid.tsx`, `settings/keys/page.tsx`, others.
- `web/tests/` — `placement.test.ts`, `editorHistory.test.ts`, `templates-upload.test.ts` (extend).
- `web/e2e/autodetect.spec.ts` (new).

---

## PHASE A — Engine

### Task 1: Decoration classifier (confidence score)

**Files:**
- Create: `engine/src/pptx_mcp/autodetect.py`
- Test: `engine/tests/test_autodetect.py`
- Modify: `engine/tests/conftest.py` (add a labeled fixture deck)

**Interfaces:**
- Consumes: python-pptx `Presentation`, `MSO_SHAPE_TYPE`; `shapes._guess_type`, `shapes._pct`.
- Produces:
  - `classify_shape(shape, slide_w, slide_h) -> ShapeAssessment`
  - `@dataclass ShapeAssessment{ shape_id:int, name:str, type:str, bbox_pct:dict, confidence:float, is_candidate:bool, font_pt:float|None }`
  - module constant `TAU = 0.5`

- [ ] **Step 1: Add a labeled fixture deck to conftest**

Add to `engine/tests/conftest.py`:

```python
@pytest.fixture
def labeled_deck(tmp_path):
    """A 1-slide deck with known slots + decoration. Returns (path, labels).
    labels maps shape_id -> True (content slot) / False (decoration)."""
    from pptx import Presentation
    from pptx.util import Inches, Pt
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    labels = {}

    title = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(8), Inches(1.5))
    title.text_frame.text = "Quarterly Business Review"
    title.text_frame.paragraphs[0].runs[0].font.size = Pt(40)
    labels[title.shape_id] = True

    body = slide.shapes.add_textbox(Inches(1), Inches(2.5), Inches(8), Inches(3))
    body.text_frame.text = "Lorem ipsum dolor sit amet, consectetur adipiscing."
    body.text_frame.paragraphs[0].runs[0].font.size = Pt(18)
    labels[body.shape_id] = True

    tiny = slide.shapes.add_textbox(Inches(0.1), Inches(0.1), Inches(0.2), Inches(0.2))
    labels[tiny.shape_id] = False

    line = slide.shapes.add_connector(2, Inches(1), Inches(6.9), Inches(9), Inches(6.9))
    labels[line.shape_id] = False

    p = tmp_path / "labeled.pptx"
    prs.save(str(p))
    return str(p), labels
```

- [ ] **Step 2: Write the failing test**

Create `engine/tests/test_autodetect.py`:

```python
from pptx import Presentation
from pptx_mcp.autodetect import classify_shape


def _assess(path):
    prs = Presentation(path)
    out = {}
    sw, sh = prs.slide_width, prs.slide_height
    for slide in prs.slides:
        for shp in slide.shapes:
            out[shp.shape_id] = classify_shape(shp, sw, sh)
    return out


def test_classifier_separates_slots_from_decoration(labeled_deck):
    path, labels = labeled_deck
    assessed = _assess(path)
    for sid, is_slot in labels.items():
        a = assessed[sid]
        assert a.is_candidate == is_slot, f"shape {sid}: conf={a.confidence}"


def test_confidence_in_range(labeled_deck):
    path, _ = labeled_deck
    for a in _assess(path).values():
        assert 0.0 <= a.confidence <= 1.0
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: FAIL — `ModuleNotFoundError: pptx_mcp.autodetect`.

- [ ] **Step 4: Write minimal implementation**

Create `engine/src/pptx_mcp/autodetect.py`:

```python
from dataclasses import dataclass

from pptx.enum.shapes import MSO_SHAPE_TYPE

from .shapes import _guess_type, _pct

TAU = 0.5

_DECO_TYPES = {MSO_SHAPE_TYPE.FREEFORM, MSO_SHAPE_TYPE.GROUP, MSO_SHAPE_TYPE.LINE}
_MIN_AREA_PCT = 1.0
_MIN_DIM_PCT = 0.5


@dataclass
class ShapeAssessment:
    shape_id: int
    name: str
    type: str
    bbox_pct: dict
    confidence: float
    is_candidate: bool
    font_pt: float | None


def _shape_text(shape) -> str:
    if not getattr(shape, "has_text_frame", False):
        return ""
    return (shape.text_frame.text or "").strip()


def _first_font_pt(shape) -> float | None:
    if not getattr(shape, "has_text_frame", False):
        return None
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            if run.font.size is not None:
                return run.font.size.pt
    return None


def _is_connector(shape) -> bool:
    try:
        return shape.shape_type == MSO_SHAPE_TYPE.LINE
    except Exception:
        return False


def classify_shape(shape, slide_w, slide_h) -> ShapeAssessment:
    left = shape.left or 0
    top = shape.top or 0
    width = shape.width or 0
    height = shape.height or 0
    bbox = {"x": _pct(left, slide_w), "y": _pct(top, slide_h),
            "w": _pct(width, slide_w), "h": _pct(height, slide_h)}

    score = 0.5
    text = _shape_text(shape)
    try:
        stype = shape.shape_type
    except Exception:
        stype = None

    # exclude signals
    if stype in _DECO_TYPES or _is_connector(shape):
        score -= 0.5
    if not getattr(shape, "has_text_frame", False) and _guess_type(shape) == "text":
        score -= 0.3
    if getattr(shape, "has_text_frame", False) and not text:
        score -= 0.25
    area_pct = bbox["w"] * bbox["h"]
    if area_pct < _MIN_AREA_PCT or bbox["w"] < _MIN_DIM_PCT or bbox["h"] < _MIN_DIM_PCT:
        score -= 0.4
    raw_off = (left < 0 or top < 0
               or left + width > slide_w or top + height > slide_h)
    if raw_off:
        score -= 0.4

    # include signals
    if getattr(shape, "is_placeholder", False):
        score += 0.4
    if text and area_pct >= _MIN_AREA_PCT:
        score += 0.3
    if _guess_type(shape) in ("table", "image") and area_pct >= _MIN_AREA_PCT:
        score += 0.2

    confidence = max(0.0, min(1.0, score))
    return ShapeAssessment(
        shape_id=shape.shape_id, name=shape.name or "",
        type=_guess_type(shape), bbox_pct=bbox,
        confidence=round(confidence, 3), is_candidate=confidence >= TAU,
        font_pt=_first_font_pt(shape),
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS (both). If `tiny`/`line` still score ≥ TAU, tune the exclude weights until the labeled fixture passes (this is the start of the §2 tuning loop).

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py engine/tests/conftest.py
git commit -m "feat(engine): decoration classifier with confidence score

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Field auto-derivation (hybrid id, tight max_chars)

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py`
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `ShapeAssessment` from Task 1.
- Produces:
  - `estimate_max_chars(width_emu, height_emu, font_pt) -> tuple[int,int]` returning `(max_chars, max_lines)`
  - `derive_ids(assessments: list[ShapeAssessment]) -> dict[int,str]`
  - constants `GLYPH_W=0.5`, `LINE_H=1.2`, `DEFAULT_FONT_PT=18.0`, `EMU_PER_PT=12700`

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_autodetect.py`:

```python
from pptx_mcp.autodetect import estimate_max_chars, derive_ids, ShapeAssessment


def test_max_chars_scales_with_box_and_font():
    emu = 914400
    big = estimate_max_chars(int(8 * emu), int(1.5 * emu), 40.0)[0]
    small_font = estimate_max_chars(int(8 * emu), int(1.5 * emu), 20.0)[0]
    assert small_font > big
    assert big > 0


def test_max_chars_uses_default_font_when_none():
    emu = 914400
    mc, ml = estimate_max_chars(int(4 * emu), int(2 * emu), None)
    assert mc > 0 and ml >= 1


def _mk(sid, x, y, w, h, conf=0.9, typ="text"):
    return ShapeAssessment(sid, f"TextBox {sid}", typ,
                           {"x": x, "y": y, "w": w, "h": h}, conf, True, 18.0)


def test_derive_ids_hybrid_semantic_then_indexed():
    title = _mk(1, 10, 5, 70, 15)
    subtitle = _mk(2, 10, 22, 50, 6)
    body = _mk(3, 10, 35, 70, 45)
    other = _mk(4, 10, 82, 20, 5)
    ids = derive_ids([title, subtitle, body, other])
    assert ids[1] == "title"
    assert ids[2] == "subtitle"
    assert ids[3] == "body"
    assert ids[4].startswith("text_")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_autodetect.py -k "max_chars or derive_ids" -v`
Expected: FAIL — names not defined.

- [ ] **Step 3: Implement**

Append to `engine/src/pptx_mcp/autodetect.py`:

```python
GLYPH_W = 0.5
LINE_H = 1.2
DEFAULT_FONT_PT = 18.0
EMU_PER_PT = 12700


def estimate_max_chars(width_emu, height_emu, font_pt) -> tuple[int, int]:
    pt = font_pt if font_pt and font_pt > 0 else DEFAULT_FONT_PT
    font_emu = pt * EMU_PER_PT
    chars_per_line = max(1, int(width_emu / (font_emu * GLYPH_W)))
    lines = max(1, int(height_emu / (font_emu * LINE_H)))
    return chars_per_line * lines, lines


def derive_ids(assessments: list[ShapeAssessment]) -> dict[int, str]:
    text = [a for a in assessments if a.type == "text"]
    by_area = sorted(text, key=lambda a: a.bbox_pct["w"] * a.bbox_pct["h"], reverse=True)
    ids: dict[int, str] = {}

    top_sorted = sorted(text, key=lambda a: a.bbox_pct["y"])
    title = top_sorted[0] if top_sorted else None
    if title is not None:
        ids[title.shape_id] = "title"
        below = [a for a in top_sorted[1:] if a.bbox_pct["y"] > title.bbox_pct["y"]]
        if below:
            ids[below[0].shape_id] = "subtitle"
    for a in by_area:
        if a.shape_id not in ids:
            ids[a.shape_id] = "body"
            break

    counters = {"text": 0, "table": 0, "image": 0}
    used = set(ids.values())
    for a in assessments:
        if a.shape_id in ids:
            continue
        base = "image" if a.type == "image" else a.type
        counters[base] = counters.get(base, 0) + 1
        cand = f"{base}_{counters[base]}"
        while cand in used:
            counters[base] += 1
            cand = f"{base}_{counters[base]}"
        ids[a.shape_id] = cand
        used.add(cand)
    return ids
```

- [ ] **Step 4: Run to verify pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): hybrid slot id + tight max_chars derivation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Per-deck assembly + `/autodetect` endpoint + web client

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py`
- Modify: `engine-service/app.py`
- Modify: `web/src/lib/engine.ts`
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `classify_shape`, `estimate_max_chars`, `derive_ids`.
- Produces:
  - `autodetect(pptx_bytes: bytes) -> dict` shaped:
    `{"slides":[{"index":i,"width_emu":W,"height_emu":H,"shapes":[{shape_id,name,type,bbox_pct,confidence,is_candidate,suggested_id,suggested_max_chars,suggested_max_lines,font_pt}]}]}`
  - engine-service `POST /autodetect` (multipart `file`).
  - web `autodetect(pptx: Buffer) -> Promise<AutodetectResult>`.

- [ ] **Step 1: Write the failing test**

Append to `engine/tests/test_autodetect.py`:

```python
from pptx_mcp.autodetect import autodetect


def test_autodetect_shapes_have_suggestions(labeled_deck):
    path, labels = labeled_deck
    data = open(path, "rb").read()
    out = autodetect(data)
    shapes = {s["shape_id"]: s for s in out["slides"][0]["shapes"]}
    for sid, is_slot in labels.items():
        assert shapes[sid]["is_candidate"] == is_slot
    for s in out["slides"][0]["shapes"]:
        if s["is_candidate"]:
            assert s["suggested_id"]
            assert s["suggested_max_chars"] > 0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_autodetect.py::test_autodetect_shapes_have_suggestions -v`
Expected: FAIL — `autodetect` not defined.

- [ ] **Step 3: Implement assembly**

Append to `engine/src/pptx_mcp/autodetect.py`:

```python
import io

from pptx import Presentation


def autodetect(pptx_bytes: bytes) -> dict:
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    slides = []
    for i, slide in enumerate(prs.slides):
        assessments = [classify_shape(shp, sw, sh) for shp in slide.shapes]
        ids = derive_ids([a for a in assessments if a.is_candidate])
        shape_by_id = {shp.shape_id: shp for shp in slide.shapes}
        shapes = []
        for a in assessments:
            mc = ml = 0
            if a.is_candidate and a.type == "text":
                shp = shape_by_id[a.shape_id]
                mc, ml = estimate_max_chars(shp.width or 0, shp.height or 0, a.font_pt)
            shapes.append({
                "shape_id": a.shape_id, "name": a.name, "type": a.type,
                "bbox_pct": a.bbox_pct, "confidence": a.confidence,
                "is_candidate": a.is_candidate,
                "suggested_id": ids.get(a.shape_id, ""),
                "suggested_max_chars": mc, "suggested_max_lines": ml,
                "font_pt": a.font_pt,
            })
        slides.append({"index": i, "width_emu": sw, "height_emu": sh, "shapes": shapes})
    return {"slides": slides}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS.

- [ ] **Step 5: Add the engine-service endpoint**

In `engine-service/app.py`, add import + route:

```python
from pptx_mcp.autodetect import autodetect

@app.post("/autodetect")
async def autodetect_route(file: UploadFile = File(...)):
    return autodetect(await file.read())
```

- [ ] **Step 6: Add the web client**

In `web/src/lib/engine.ts`, append:

```ts
export type AutodetectShape = {
  shape_id: number; name: string; type: string;
  bbox_pct: { x: number; y: number; w: number; h: number };
  confidence: number; is_candidate: boolean;
  suggested_id: string; suggested_max_chars: number;
  suggested_max_lines: number; font_pt: number | null;
};
export type AutodetectResult = {
  slides: { index: number; width_emu: number; height_emu: number; shapes: AutodetectShape[] }[];
};

export async function autodetect(pptx: Buffer): Promise<AutodetectResult> {
  const r = await fetch(`${BASE}/autodetect`, { method: "POST", body: form(pptx) });
  if (!r.ok) throw new EngineError("autodetect failed");
  return r.json();
}
```

- [ ] **Step 7: Verify engine-service imports cleanly**

Run: `cd engine-service && python -c "import app"`
Expected: no error.

- [ ] **Step 8: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py engine-service/app.py web/src/lib/engine.ts
git commit -m "feat(engine): /autodetect endpoint + web client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Sentence-aware truncation helper

**Files:**
- Create: `engine/src/pptx_mcp/textfit.py`
- Test: `engine/tests/test_textfit.py`

**Interfaces:**
- Produces: `truncate_to_sentence(text: str, max_chars: int) -> tuple[str, str]` returning `(kept, dropped)`. Never splits a word; prefers whole sentences; falls back to last whole word.

- [ ] **Step 1: Write the failing tests**

Create `engine/tests/test_textfit.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_textfit.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `engine/src/pptx_mcp/textfit.py`:

```python
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd engine && python -m pytest tests/test_textfit.py -v`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/textfit.py engine/tests/test_textfit.py
git commit -m "feat(engine): sentence-aware truncation helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Hybrid overflow in fill/render (shrink → cut → report)

**Files:**
- Modify: `engine/src/pptx_mcp/fit.py`, `filler.py`, `render.py`
- Modify: `engine-service/app.py`
- Modify: `web/src/lib/engine.ts`, `web/src/app/api/mcp/templates/[id]/render/route.ts`, `web/src/app/api/templates/[id]/render/route.ts`
- Test: extend `engine/tests/test_filler.py` (+ conftest `base_template` if absent)

**Interfaces:**
- Consumes: `truncate_to_sentence` (Task 4).
- Produces:
  - `fill_slot(slide, slot, value) -> list[SlotError]` (now returns non-fatal overflow warnings).
  - `render(deck_spec, template) -> tuple[bytes, list[dict]]`.
  - `/render-deck` returns the pptx with `X-Overflow-Warnings` header (JSON list).
  - web `renderDeck(...)` returns `{ pptx?, validation, warnings }`.

- [ ] **Step 1: Write the failing test for fill warnings**

Add `base_template` to `engine/tests/conftest.py` if it does not exist (1-slide template, one text slot, mirroring existing `_build_pptx`/`_build_manifest` helpers and `load_from_bytes`). Then append to `engine/tests/test_filler.py`:

```python
def test_fill_text_overflow_cuts_and_reports(base_template):
    from pptx import Presentation
    from pptx_mcp.filler import fill_slot
    tpl = base_template
    slot = tpl.slide_types[0].slots[0]
    slot.constraints.max_chars = 10
    prs = Presentation(tpl.pptx_path)
    warnings = fill_slot(prs.slides[0], slot, "First short. Second sentence dropped.")
    assert any(w.code == "text_truncated" for w in warnings)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_filler.py -k overflow -v`
Expected: FAIL — `fill_slot` returns `None`.

- [ ] **Step 3: Simplify `fit.py` text path (shrink/ok only)**

Replace `assess_text` in `engine/src/pptx_mcp/fit.py`:

```python
def assess_text(value: str | None, c: Constraints) -> tuple[str, str]:
    value = value or ""
    if c.max_lines is not None and len(value.split("\n")) > c.max_lines:
        return "shrink", "over line budget"
    if c.max_chars is not None and len(value) > c.max_chars:
        return "shrink", f"text over limit: {len(value)}/{c.max_chars}"
    return "ok", ""
```

Keep `assess_table` and `SHRINK_TOLERANCE` unchanged (tables still reject).

- [ ] **Step 4: Implement shrink + cut + report in `filler.py`**

Replace `_fill_text` and update `fill_slot`:

```python
from .models import Slot, SlotError
from .textfit import truncate_to_sentence

_MIN_PT = 12.0


def fill_slot(slide, slot: Slot, value) -> list[SlotError]:
    shape = find_shape(slide, slot.shape_id)
    if slot.type == "text":
        return _fill_text(shape, slot, value)
    if slot.type == "table":
        _fill_table(shape, value)
    elif slot.type == "image":
        _fill_image(slide, shape, value)
    return []


def _fill_text(shape, slot: Slot, value: str) -> list[SlotError]:
    warnings: list[SlotError] = []
    tf = shape.text_frame
    decision, _ = assess_text(value, slot.constraints)
    if decision == "shrink":
        floor = slot.constraints.shrink_floor_pt or _MIN_PT
        new_pt = max(floor, _BASE_PT - _SHRINK_STEP)
        max_chars = slot.constraints.max_chars
        if max_chars is not None:
            capacity = int(max_chars * (_BASE_PT / new_pt))
            if len(value) > capacity:
                value, dropped = truncate_to_sentence(value, capacity)
                if dropped:
                    warnings.append(SlotError(0, slot.id, "text_truncated",
                                              f"dropped {len(dropped)} chars to fit"))
        tf.text = value
        for para in tf.paragraphs:
            for run in para.runs:
                run.font.size = Pt(new_pt)
    else:
        tf.text = value
    return warnings
```

- [ ] **Step 5: Thread warnings through `render.py`**

```python
def render(deck_spec: dict, template: Template) -> tuple[bytes, list[dict]]:
    errors = validate(deck_spec, template)
    if errors:
        raise RenderRejected(errors)
    slides = deck_spec["slides"]
    order = [template.slide_type(s["slide_type"]).source_slide_index for s in slides]
    prs = assemble(order, template)
    warnings: list[dict] = []
    for i, slide_spec in enumerate(slides):
        st = template.slide_type(slide_spec["slide_type"])
        provided = slide_spec.get("slots", {})
        for slot in st.slots:
            value = provided.get(slot.id, slot.default)
            if value is None or value == "":
                continue
            for w in fill_slot(prs.slides[i], slot, value):
                w.slide_index = i
                warnings.append(w.to_dict())
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), warnings
```

- [ ] **Step 6: Update `app.py` callers of `render`**

`/render-deck`:

```python
        out, warnings = render(json.loads(deck_spec), tpl)
    ...
    return Response(content=out, media_type=_PPTX,
                    headers={"X-Overflow-Warnings": json.dumps(warnings)})
```

`/render-preview`: change `out = render(...)` to `out, _ = render(...)`.

- [ ] **Step 7: Update the web `renderDeck` client**

In `web/src/lib/engine.ts`:

```ts
export async function renderDeck(pptx: Buffer, manifest: unknown, deckSpec: unknown):
  Promise<{ pptx?: Buffer; validation: any[]; warnings: any[] }> {
  const r = await fetch(`${BASE}/render-deck`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (r.status === 422) return { validation: (await r.json()).validation ?? [], warnings: [] };
  if (!r.ok) throw new EngineError("render-deck failed");
  const warnings = JSON.parse(r.headers.get("X-Overflow-Warnings") || "[]");
  return { pptx: Buffer.from(await r.arrayBuffer()), validation: [], warnings };
}
```

- [ ] **Step 8: Surface warnings in both render routes**

In both `render/route.ts` files, add `warnings` to the JSON response:

```ts
  const out = await renderDeck(base, tpl.manifestJson, deck_spec);
  if (!out.pptx) return Response.json({ validation: out.validation ?? [], download_url: null, warnings: [] });
  ...
  return Response.json({ validation: [], download_url: await presignGet(key), warnings: out.warnings });
```

- [ ] **Step 9: Run engine tests (full) and fix existing render unpackers**

Run: `cd engine && python -m pytest -q`
Expected: all pass. Update any test that does `out = render(...)` to `out, _ = render(...)`.

- [ ] **Step 10: Run web unit tests**

Run: `cd web && npx vitest run`
Expected: pass; update `tests/engine.test.ts` / render API tests for the `warnings` field if they assert exact shapes.

- [ ] **Step 11: Commit**

```bash
git add engine/ engine-service/app.py web/src/lib/engine.ts web/src/app/api
git commit -m "feat(engine): hybrid overflow (shrink, sentence-cut, report warnings)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE B — Web editor

### Task 6: Placement geometry checks (off-slide / overlap)

**Files:**
- Create: `web/src/lib/placement.ts`
- Test: `web/tests/placement.test.ts`

**Interfaces:**
- Produces: `type Box`, `isOffSlide(b,eps?)`, `overlaps(a,b)`, `placementIssues(slots) -> {offSlide:string[]; overlapping:[string,string][]}`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/placement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isOffSlide, overlaps, placementIssues } from "@/lib/placement";

describe("placement", () => {
  it("flags boxes crossing an edge", () => {
    expect(isOffSlide({ x: 90, y: 10, w: 20, h: 10 })).toBe(true);
    expect(isOffSlide({ x: 10, y: 10, w: 20, h: 10 })).toBe(false);
    expect(isOffSlide({ x: -1, y: 10, w: 5, h: 5 })).toBe(true);
  });

  it("detects overlap", () => {
    expect(overlaps({ x: 0, y: 0, w: 50, h: 50 }, { x: 25, y: 25, w: 50, h: 50 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(false);
  });

  it("summarizes issues across slots", () => {
    const r = placementIssues([
      { id: "title", box: { x: 90, y: 0, w: 20, h: 10 } },
      { id: "a", box: { x: 0, y: 0, w: 40, h: 40 } },
      { id: "b", box: { x: 20, y: 20, w: 40, h: 40 } },
    ]);
    expect(r.offSlide).toContain("title");
    expect(r.overlapping).toEqual([["a", "b"]]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run tests/placement.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `web/src/lib/placement.ts`:

```ts
export type Box = { x: number; y: number; w: number; h: number };

export function isOffSlide(b: Box, eps = 0.5): boolean {
  return b.x < -eps || b.y < -eps || b.x + b.w > 100 + eps || b.y + b.h > 100 + eps;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function placementIssues(slots: { id: string; box: Box }[]) {
  const offSlide = slots.filter((s) => isOffSlide(s.box)).map((s) => s.id);
  const overlapping: [string, string][] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (overlaps(slots[i].box, slots[j].box)) overlapping.push([slots[i].id, slots[j].id]);
    }
  }
  return { offSlide, overlapping };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run tests/placement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/placement.ts web/tests/placement.test.ts
git commit -m "feat(web): off-slide and overlap placement checks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Undo/redo reducer

**Files:**
- Create: `web/src/lib/editorHistory.ts`
- Test: `web/tests/editorHistory.test.ts`

**Interfaces:**
- Produces: `History<T>`, `initHistory`, `pushState`, `undo`, `redo`, `canUndo`, `canRedo`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/editorHistory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initHistory, pushState, undo, redo } from "@/lib/editorHistory";

describe("editor history", () => {
  it("push/undo/redo round-trips", () => {
    let h = initHistory({ n: 0 });
    h = pushState(h, { n: 1 });
    h = pushState(h, { n: 2 });
    expect(h.present).toEqual({ n: 2 });
    h = undo(h);
    expect(h.present).toEqual({ n: 1 });
    h = undo(h);
    expect(h.present).toEqual({ n: 0 });
    h = redo(h);
    expect(h.present).toEqual({ n: 1 });
  });

  it("push clears the redo future", () => {
    let h = initHistory(0);
    h = pushState(h, 1);
    h = undo(h);
    h = pushState(h, 5);
    expect(h.future).toEqual([]);
    expect(redo(h).present).toBe(5);
  });

  it("undo/redo at the ends are no-ops", () => {
    let h = initHistory("a");
    expect(undo(h).present).toBe("a");
    expect(redo(h).present).toBe("a");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run tests/editorHistory.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `web/src/lib/editorHistory.ts`:

```ts
export type History<T> = { past: T[]; present: T; future: T[] };

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}
export function pushState<T>(h: History<T>, next: T): History<T> {
  return { past: [...h.past, h.present], present: next, future: [] };
}
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}
export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}
export const canUndo = <T>(h: History<T>) => h.past.length > 0;
export const canRedo = <T>(h: History<T>) => h.future.length > 0;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run tests/editorHistory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/editorHistory.ts web/tests/editorHistory.test.ts
git commit -m "feat(web): undo/redo history reducer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Upload stores auto-detected draft

**Files:**
- Modify: `web/src/app/api/templates/route.ts`
- Test: `web/tests/templates-upload.test.ts` (extend)

**Interfaces:**
- Consumes: `autodetect` (Task 3).
- Produces: `manifestJson.draft = { slides: AutodetectResult.slides, previewKeys }` with per-shape `confidence`/`is_candidate`/`suggested_*`.

- [ ] **Step 1: Write the failing test**

Extend `web/tests/templates-upload.test.ts`. Mock `@/lib/engine` so `autodetect` returns a known candidate, and assert `prisma.template.create` got `manifestJson.draft.slides[0].shapes[0].suggested_id === "title"`:

```ts
vi.mock("@/lib/engine", () => ({
  autodetect: vi.fn().mockResolvedValue({
    slides: [{ index: 0, width_emu: 1, height_emu: 1, shapes: [
      { shape_id: 2, name: "TextBox 2", type: "text",
        bbox_pct: { x: 10, y: 5, w: 70, h: 15 }, confidence: 0.9,
        is_candidate: true, suggested_id: "title",
        suggested_max_chars: 40, suggested_max_lines: 2, font_pt: 40 },
    ] }],
  }),
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: [] }),
}));
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run tests/templates-upload.test.ts`
Expected: FAIL — route still calls `extractShapes`.

- [ ] **Step 3: Implement**

In `web/src/app/api/templates/route.ts`:

```ts
import { autodetect, renderBasePreviews } from "@/lib/engine";
...
  const detected = await autodetect(bytes);
  const { previews } = await renderBasePreviews(bytes);
  ...
      manifestJson: { draft: { slides: detected.slides, previewKeys } } as object,
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run tests/templates-upload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/templates/route.ts web/tests/templates-upload.test.ts
git commit -m "feat(web): store auto-detected draft on upload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: TagEditor — confidence colors, pre-fill, placement, undo/redo

**Files:**
- Modify: `web/src/components/TagEditor.tsx`, `web/src/components/SlotPanel.tsx`, `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`
- Verify: existing E2E (`web/e2e/full-flow.spec.ts`) still green; new behavior covered by Task 11 E2E.

**Interfaces:**
- Consumes: `placementIssues` (Task 6), `History`/`pushState`/`undo`/`redo` (Task 7), draft shapes with `confidence`/`is_candidate`/`suggested_*` (Task 8).
- Produces: editor that pre-tags candidates, colors boxes by confidence, blocks save on off-slide, warns on overlap, supports undo/redo.

> Read `SlotPanel.tsx` and `TagEditor.tsx` before editing to match existing prop/field names.

- [ ] **Step 1: Pre-tag candidates and color by confidence**

In `TagEditor.tsx`, on mount, seed `slots` from shapes where `is_candidate`, using `suggested_id`/`type`/`suggested_max_chars`. Add a per-shape visual state:

```tsx
function shapeClass(tagged: boolean, conf: number, reduced: boolean) {
  if (!tagged) return "border border-dashed border-neutral-300/40 bg-transparent";
  if (conf >= 0.75) return "border-2 border-matcha-500 bg-matcha-500/10";
  return `border-2 border-dashed border-amber-500 bg-amber-500/10 ${reduced ? "" : "animate-pulse"}`;
}
```

Apply it to each shape's overlay button (replace the current static `border-2 bg-blue-500/10`).

- [ ] **Step 2: Wire placement validation**

```tsx
import { placementIssues } from "@/lib/placement";
const issues = placementIssues(
  Object.values(slots).filter((s) => s.id).map((s) => ({ id: s.id, box: bboxFor(s.shape_id) })),
);
```

Mark off-slide slot boxes red and surface `issues` to `EditClient` (lift via prop/callback).

- [ ] **Step 3: Wire undo/redo**

Hold `{ slots, bboxOverrides }` in a `History`; each drag/tag/field edit calls `pushState`. Add keyboard handling:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); setHist((h) => undo(h)); }
    if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); setHist((h) => redo(h)); }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

- [ ] **Step 4: Gate save in EditClient**

```tsx
if (issues.offSlide.length > 0) {
  setSaveErr(`Move these slots back on-slide before saving: ${issues.offSlide.join(", ")}`);
  return;
}
if (issues.overlapping.length > 0) {
  setOverlapWarn(`Overlapping slots: ${issues.overlapping.map((p) => p.join("+")).join(", ")}`);
}
```

Add Undo/Redo buttons by "Save template", disabled via `canUndo`/`canRedo`.

- [ ] **Step 5: Regression smoke (stack running)**

Run: `cd web && npx playwright test e2e/full-flow.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TagEditor.tsx web/src/components/SlotPanel.tsx "web/src/app/(app)/templates/[id]/edit/EditClient.tsx"
git commit -m "feat(web): confidence-colored tag editor with placement + undo/redo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE C — Design system

### Task 10: Matcha design tokens

**Files:**
- Modify: `web/tailwind.config.ts`, `web/src/app/globals.css`

**Interfaces:**
- Produces: Tailwind `matcha`/`clay` scales, `.btn-primary`, `.card`; light theme only.

- [ ] **Step 1: Add matcha + clay tokens to Tailwind**

In `web/tailwind.config.ts`, extend `theme.extend`:

```ts
colors: {
  background: "var(--background)",
  foreground: "var(--foreground)",
  matcha: {
    50: "#f3f7ee", 100: "#e6efdc", 200: "#cfe0bd", 300: "#b2cd97",
    400: "#93b771", 500: "#79a155", 600: "#5f8341", 700: "#4a6735",
    800: "#3c532e", 900: "#324528",
  },
  clay: { 400: "#c98a6a", 500: "#b9734f", 600: "#9c5d3d" },
},
borderRadius: { xl: "0.875rem" },
```

- [ ] **Step 2: Set soft-modern base in globals.css**

Replace the `:root`/dark/body block in `web/src/app/globals.css` (drop dark-mode media query — light only):

```css
:root {
  --background: #f6f7f4;
  --foreground: #1f2421;
  --card: #ffffff;
}

body {
  color: var(--foreground);
  background: var(--background);
  font-family: var(--font-geist-sans), Arial, Helvetica, sans-serif;
}

@layer components {
  .btn-primary {
    @apply bg-matcha-600 text-white px-4 py-2 rounded-xl shadow-sm
           hover:bg-matcha-700 focus-visible:outline-none
           focus-visible:ring-2 focus-visible:ring-matcha-300 transition-colors;
  }
  .card {
    @apply bg-[var(--card)] rounded-xl shadow-sm border border-neutral-200/70 p-5;
  }
}
```

- [ ] **Step 3: Verify build compiles**

Run: `cd web && npx next build`
Expected: success; `matcha-600`, `btn-primary`, `card` resolve.

- [ ] **Step 4: Commit**

```bash
git add web/tailwind.config.ts web/src/app/globals.css
git commit -m "feat(web): soft-modern matcha design tokens (light theme)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Refit components to tokens + auto-detect E2E

**Files:**
- Modify: `web/src/app/(app)/layout.tsx`, `dashboard/DashboardGrid.tsx`, `settings/keys/page.tsx`, `templates/new/page.tsx`, `templates/[id]/use/UseClient.tsx`, `templates/[id]/edit/EditClient.tsx`
- Create: `web/e2e/autodetect.spec.ts`

- [ ] **Step 1: Swap raw styles for tokens**

Replace `bg-black text-white px-4 py-2 rounded` primary buttons with `btn-primary`; replace stark `border rounded p-5` card blocks with `card`. Nav background → `bg-[var(--card)]/80`; active links → `text-matcha-700`.

- [ ] **Step 2: Write the auto-detect E2E**

Create `web/e2e/autodetect.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = path.resolve("e2e/fixtures/sample-deck.pptx");

test("upload pre-tags candidate slots", async ({ page }) => {
  const email = `ad_${Date.now()}@test.com`;
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/templates/new");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL("**/templates/**/edit");

  await page.waitForSelector('button[aria-label^="shape"]');
  const prefilled = await page.getByLabel("Slot id").first().inputValue().catch(() => "");
  expect(prefilled.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run full E2E (stack up)**

Run: `cd web && npx playwright test`
Expected: PASS (`full-flow` + `autodetect`).

- [ ] **Step 4: Run all unit suites**

Run: `cd web && npx vitest run` and `cd engine && python -m pytest -q`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "feat(web): refit components to matcha tokens + auto-detect e2e

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 flow → Tasks 3, 8. §2 classifier + investment → Task 1 (fixtures + tuning loop). §3 derivation → Task 2. §4 overflow → Tasks 4, 5. §5 placement + undo/redo → Tasks 6, 7, 9. §6 attention-by-confidence UX → Task 9. §7 testing → per-task + Task 11 E2E. §8 design system → Tasks 10, 11.
- §2 targets (precision/recall ≥ 0.9 across 2–3 real decks) start against the synthetic labeled fixture in Task 1; add real-deck fixtures during the Task 1 tuning loop if the synthetic deck is insufficient.

**Placeholder scan:** No TBD/TODO; every code step shows code; every test step shows assertions.

**Type consistency:** `ShapeAssessment` fields consistent across Tasks 1–3. `render()` returns `tuple[bytes, list[dict]]` from Task 5 with all callers updated (app.py, both web render routes, existing render tests). `fill_slot` returns `list[SlotError]`, consumed in `render`. `History<T>` API consistent (Task 7 → Task 9). `autodetect`/`AutodetectResult` consistent (Tasks 3, 8).

**Known integration risks (for implementer):**
- Existing `engine/tests/test_render.py` and `web` render/engine tests call the old `render`/`renderDeck` shapes — update in Task 5 (steps 9–10).
- `SlotPanel`/`TagEditor` current prop and field names must match the pre-fill in Task 9 — read those files before editing.
