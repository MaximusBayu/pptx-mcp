# Agent-Legible Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a saved template self-documenting — mine the template's own text and structure (no LLM) so an agent reads slot examples, slide purpose, and a `repeatable` hint straight from the schema.

**Architecture:** Engine `autodetect` is extended to emit per-shape (`text`, `suggested_example`, `suggested_description`) and per-slide (`kind`, `suggested_name`, `suggested_description`, `repeatable`) annotations. These ride the existing `manifestJson.draft.slides` written at upload, seed the editor, get persisted into `manifestJson.slide_types` by the PUT route (falling back to the suggestions when a field is blank), and surface through `toAgentSchema` plus a new top-level `example_deck_spec`. Validation messages gain concrete numbers/types so an agent can self-correct.

**Tech Stack:** Python (python-pptx) for the engine; Next.js / TypeScript for web; pytest (engine, mcp-server) and vitest (web) for tests.

## Global Constraints

- **No LLM / vision.** Every annotation is deterministic: keywords, structure, and the template's own text. Pure functions over the parsed deck — no I/O, no network.
- **All annotated fields are user-editable.** Suggestions are defaults/fallbacks, never locks.
- **All new manifest fields are optional.** Absence must reproduce today's behavior (back-compat for templates saved before this feature).
- **No auto-routing** (the agent still picks `slide_type` per slide), **no enforced slot enums**, **no rich-text/multi-run slot formatting.**
- `slot.id` stays `slide_<index>`-derived and stable; `name` becomes a human label.
- Slot value types are fixed: text = string, table = `list[list]`, image = URL or `data:` base64 string.

**Run tests from these dirs:**
- Engine: `cd engine && python -m pytest <path> -v`
- Web: `cd web && npx vitest run <path>`
- MCP server: `cd mcp-server && python -m pytest <path> -v`

---

## File Structure

**Engine (Python):**
- `engine/src/pptx_mcp/autodetect.py` — extended with shape- and slide-level annotation helpers (Tasks 1–3).
- `engine/src/pptx_mcp/validate.py` — actionable `SlotError` messages (Task 4).
- `engine/src/pptx_mcp/fit.py` — `assess_table` overflow messages with numbers (Task 4).
- `engine/tests/test_autodetect.py`, `engine/tests/test_validate.py`, `engine/tests/test_fit.py` — tests.

**Web (TypeScript):**
- `web/src/app/api/templates/[id]/route.ts` — PUT persists slide/slot annotations with autodetect fallback (Task 5).
- `web/src/lib/schema.ts` — `toAgentSchema` enriched + `example_deck_spec` (Task 6).
- `web/src/lib/example.ts` — `exampleSlotValue` prefers `slot.example` (Task 6).
- `web/src/components/SlotPanel.tsx`, `web/src/components/TagEditor.tsx`, `web/src/app/(app)/templates/[id]/edit/EditClient.tsx` — editor UI + save payload (Task 7).
- `web/tests/templates-save.test.ts`, `web/tests/schema.test.ts` (new), `web/tests/example.test.ts`, `web/tests/tageditor.test.tsx` — tests.

**MCP (Python):**
- `mcp-server/server.py` — tool docstrings (Task 8).
- `mcp-server/tests/test_proxy.py` — docstring assertions.

---

## Task 1: Engine — per-shape annotations (`text`, `suggested_example`, `suggested_description`)

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py`
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: existing `_shape_text(shape)`, `autodetect(pptx_bytes) -> dict`, `derive_ids`.
- Produces: each `shapes[]` dict in `autodetect()` output gains string keys `"text"`, `"suggested_example"`, `"suggested_description"`. New module functions `slot_description(suggested_id: str) -> str` and `_truncate(text: str, limit: int) -> str`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/test_autodetect.py`:

```python
def test_shapes_have_text_and_example(labeled_deck):
    path, _ = labeled_deck
    out = autodetect(open(path, "rb").read())
    shapes = out["slides"][0]["shapes"]
    titles = [s for s in shapes if s["suggested_id"] == "title"]
    assert titles, "no title candidate detected"
    t = titles[0]
    # the title box text in the fixture is "Quarterly Business Review"
    assert "Quarterly Business Review" in t["text"]
    # example is the box's own text (the biggest agent win), non-empty for a tagged text slot
    assert t["suggested_example"]
    assert t["suggested_example"] in t["text"] or t["text"].startswith(t["suggested_example"].rstrip("…"))
    assert t["suggested_description"] == "Slide title"


def test_slot_description_labels():
    from pptx_mcp.autodetect import slot_description
    assert slot_description("title") == "Slide title"
    assert slot_description("subtitle") == "Subtitle"
    assert slot_description("body") == "Body text"
    assert slot_description("table_1") == "Table data"
    assert slot_description("image_2") == "Image"
    assert slot_description("text_3") == "Text"
    assert slot_description("") == "Text"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_autodetect.py::test_slot_description_labels tests/test_autodetect.py::test_shapes_have_text_and_example -v`
Expected: FAIL — `ImportError: cannot import name 'slot_description'` / `KeyError: 'text'`.

- [ ] **Step 3: Add the helpers**

In `engine/src/pptx_mcp/autodetect.py`, add module-level constants near the top (after the existing constants) and the helper functions (place them after `_shape_text`):

```python
_EXAMPLE_MAX = 200

_DESC_BY_ID = {
    "title": "Slide title",
    "subtitle": "Subtitle",
    "body": "Body text",
}


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def slot_description(suggested_id: str) -> str:
    """A short human label for a slot, derived from its auto-assigned id."""
    if suggested_id in _DESC_BY_ID:
        return _DESC_BY_ID[suggested_id]
    if suggested_id.startswith("table"):
        return "Table data"
    if suggested_id.startswith("image"):
        return "Image"
    return "Text"
```

- [ ] **Step 4: Emit the per-shape fields in `autodetect()`**

In `autodetect()`, inside the `for a in assessments:` loop, after the `mc = ml = mr = mcols = 0` block computes the constraints, build the new fields and add them to the appended dict. Replace the existing `shapes.append({...})` call with:

```python
            shp_obj = shape_by_id[a.shape_id]
            text_val = _truncate(_shape_text(shp_obj), _EXAMPLE_MAX)
            sid = ids.get(a.shape_id, "")
            example = ""
            if a.is_candidate and a.type == "text" and text_val:
                example = _truncate(text_val, mc if mc > 0 else _EXAMPLE_MAX)
            shapes.append({
                "shape_id": a.shape_id, "name": a.name, "type": a.type,
                "bbox_pct": a.bbox_pct, "confidence": a.confidence,
                "is_candidate": a.is_candidate,
                "suggested_id": sid,
                "suggested_max_chars": mc, "suggested_max_lines": ml,
                "suggested_max_rows": mr, "suggested_max_cols": mcols,
                "font_pt": a.font_pt,
                "text": text_val,
                "suggested_example": example,
                "suggested_description": slot_description(sid),
            })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS (all autodetect tests, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): autodetect emits per-shape text, example, description"
```

---

## Task 2: Engine — per-slide `kind`, `suggested_name`, `suggested_description`

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py`
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `autodetect` loop locals (`assessments`, `ids`, `shape_by_id`, slide `index`), `_shape_text`.
- Produces: each `slides[]` dict gains `"kind"`, `"suggested_name"`, `"suggested_description"` (all str). New module functions `slide_kind(text_blob: str, has_table: bool, index: int, num_text: int, has_subtitle: bool) -> str` and `slide_description(kind: str, slot_ids: list[str]) -> str`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/test_autodetect.py`:

```python
def test_slide_kind_rules():
    from pptx_mcp.autodetect import slide_kind
    assert slide_kind("", False, 0, 2, True) == "cover"
    assert slide_kind("Agenda for today", False, 1, 4, False) == "agenda"
    assert slide_kind("Executive Summary", False, 2, 3, False) == "summary"
    assert slide_kind("Severity: CRITICAL CWE-89", False, 3, 3, False) == "finding"
    assert slide_kind("just numbers", True, 4, 1, False) == "data"
    assert slide_kind("Thank you!", False, 5, 1, False) == "closing"
    assert slide_kind("Section One", False, 6, 1, False) == "section"
    assert slide_kind("a paragraph of content here", False, 7, 4, False) == "content"


def test_slide_description_lists_slots_and_repeat_hint():
    from pptx_mcp.autodetect import slide_description
    d = slide_description("finding", ["title", "severity", "description"])
    assert "title" in d and "severity" in d and "description" in d
    assert "Repeat per item" in d
    assert "no slots" in slide_description("content", [])


def test_autodetect_slide_has_kind(labeled_deck):
    path, _ = labeled_deck
    out = autodetect(open(path, "rb").read())
    slide = out["slides"][0]
    assert slide["kind"] in {
        "cover", "agenda", "summary", "finding", "data", "closing", "section", "content"
    }
    assert slide["suggested_name"] == slide["kind"]
    assert slide["suggested_description"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_autodetect.py::test_slide_kind_rules tests/test_autodetect.py::test_slide_description_lists_slots_and_repeat_hint tests/test_autodetect.py::test_autodetect_slide_has_kind -v`
Expected: FAIL — `ImportError: cannot import name 'slide_kind'` / `KeyError: 'kind'`.

- [ ] **Step 3: Add the helpers**

At the top of `engine/src/pptx_mcp/autodetect.py`, add `import re` next to `import io`. Add these module-level regexes and functions (place after `slot_description`):

```python
_AGENDA_RE = re.compile(r"agenda|overview|outline|contents|daftar isi", re.I)
_SUMMARY_RE = re.compile(r"summary|ringkasan|executive", re.I)
_FINDING_RE = re.compile(r"finding|temuan|severity|critical|high|medium|low|cwe|cvss", re.I)
_CLOSING_RE = re.compile(r"thank|terima kasih|questions|q&a", re.I)

_KIND_LABEL = {
    "cover": "Cover slide", "agenda": "Agenda slide", "summary": "Summary slide",
    "finding": "Finding slide", "data": "Data slide", "closing": "Closing slide",
    "section": "Section slide", "content": "Content slide",
}


def slide_kind(text_blob: str, has_table: bool, index: int,
               num_text: int, has_subtitle: bool) -> str:
    """Deterministic slide purpose from its dominant text + shape mix."""
    if index == 0 or (has_subtitle and num_text <= 3):
        return "cover"
    if _AGENDA_RE.search(text_blob):
        return "agenda"
    if _SUMMARY_RE.search(text_blob):
        return "summary"
    if _FINDING_RE.search(text_blob):
        return "finding"
    if has_table:
        return "data"
    if _CLOSING_RE.search(text_blob):
        return "closing"
    if num_text <= 1:
        return "section"
    return "content"


def slide_description(kind: str, slot_ids: list[str]) -> str:
    """A templated sentence: what the slide is + which slots to fill."""
    fill = ", ".join(slot_ids) if slot_ids else "no slots"
    repeat = " Repeat per item." if kind == "finding" else ""
    label = _KIND_LABEL.get(kind, "Content slide")
    return f"{label} — fill: {fill}.{repeat}"
```

Note: `cover` is checked first so slide 0 stays a cover. `data` is checked before `closing`, so a thank-you slide with no table still classifies as `closing` (the test `slide_kind("Thank you!", False, 5, 1, False) == "closing"` exercises the no-table path).

- [ ] **Step 4: Emit the per-slide fields in `autodetect()`**

In `autodetect()`, replace the existing `slides.append({"index": i, "width_emu": sw, "height_emu": sh, "shapes": shapes})` line at the end of the per-slide loop with:

```python
        cand = [a for a in assessments if a.is_candidate]
        text_blob = " ".join(
            _shape_text(shape_by_id[a.shape_id]) for a in cand if a.type == "text"
        )
        has_table = any(a.type == "table" for a in cand)
        num_text = sum(1 for a in cand if a.type == "text")
        has_subtitle = any(ids.get(a.shape_id) == "subtitle" for a in cand)
        slot_ids = [ids[a.shape_id] for a in cand if ids.get(a.shape_id)]
        kind = slide_kind(text_blob, has_table, i, num_text, has_subtitle)
        slides.append({
            "index": i, "width_emu": sw, "height_emu": sh, "shapes": shapes,
            "kind": kind, "suggested_name": kind,
            "suggested_description": slide_description(kind, slot_ids),
        })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): autodetect classifies slide kind, name, description"
```

---

## Task 3: Engine — `repeatable` via structural signature

**Files:**
- Modify: `engine/src/pptx_mcp/autodetect.py`
- Test: `engine/tests/test_autodetect.py`

**Interfaces:**
- Consumes: the `slides` list built in `autodetect()` (each slide dict has `shapes[]` with `is_candidate`, `type`, `bbox_pct`, `suggested_id`).
- Produces: each `slides[]` dict gains `"repeatable": bool`. New module function `slide_signature(slide: dict) -> tuple`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/test_autodetect.py`:

```python
def _finding_like(slide, idx):
    from pptx.util import Inches, Pt
    title = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(8), Inches(1))
    title.text_frame.text = f"Finding F{idx}: SQL Injection"
    title.text_frame.paragraphs[0].runs[0].font.size = Pt(32)
    body = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(4))
    body.text_frame.text = "Severity: HIGH. CWE-89. Remediation steps here."
    body.text_frame.paragraphs[0].runs[0].font.size = Pt(18)


def test_repeatable_marks_structural_twins(tmp_path):
    from pptx import Presentation
    from pptx.util import Inches, Pt
    prs = Presentation()
    blank = prs.slide_layouts[6]
    # two structurally identical finding slides + one unique cover-ish slide
    _finding_like(prs.slides.add_slide(blank), 1)
    _finding_like(prs.slides.add_slide(blank), 2)
    cover = prs.slides.add_slide(blank)
    c = cover.shapes.add_textbox(Inches(2), Inches(3), Inches(6), Inches(1.5))
    c.text_frame.text = "RISEStore VAPT Report"
    c.text_frame.paragraphs[0].runs[0].font.size = Pt(44)
    p = tmp_path / "rep.pptx"
    prs.save(str(p))

    out = autodetect(p.read_bytes())
    slides = out["slides"]
    assert slides[0]["repeatable"] is True
    assert slides[1]["repeatable"] is True
    assert slides[2]["repeatable"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && python -m pytest tests/test_autodetect.py::test_repeatable_marks_structural_twins -v`
Expected: FAIL — `KeyError: 'repeatable'`.

- [ ] **Step 3: Add the signature helper**

Add `from collections import Counter` near the top of `engine/src/pptx_mcp/autodetect.py` (after `from dataclasses import dataclass`). Add this function after `slide_description`:

```python
def slide_signature(slide: dict) -> tuple:
    """A structural fingerprint of a slide's candidate shapes. Two slides with
    the same signature are the same template pattern repeated (e.g. F1-F4
    findings) and are flagged repeatable."""
    cand = [s for s in slide["shapes"] if s.get("is_candidate")]
    parts = tuple(sorted(
        (s["type"], round((s["bbox_pct"]["w"] * s["bbox_pct"]["h"]) / 10))
        for s in cand
    ))
    sids = tuple(sorted({s["suggested_id"] for s in cand if s["suggested_id"]}))
    return (parts, sids)
```

- [ ] **Step 4: Mark repeatable in `autodetect()`**

In `autodetect()`, after the `for i, slide in enumerate(prs.slides):` loop fully builds `slides`, and before `return {"slides": slides}`, insert:

```python
    sigs = [slide_signature(s) for s in slides]
    counts = Counter(sigs)
    for s, sig in zip(slides, sigs):
        s["repeatable"] = counts[sig] >= 2
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_autodetect.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/autodetect.py engine/tests/test_autodetect.py
git commit -m "feat(engine): flag structurally-repeated slides as repeatable"
```

---

## Task 4: Engine — actionable validation messages

**Files:**
- Modify: `engine/src/pptx_mcp/validate.py`, `engine/src/pptx_mcp/fit.py`
- Test: `engine/tests/test_validate.py`, `engine/tests/test_fit.py`

**Interfaces:**
- Consumes: `SlotError(slide_index, slot_id, code, message)`, `assess_table(rows, c) -> (decision, msg)`.
- Produces: unchanged signatures; only message strings change. Codes stay: `wrong_type`, `table_overflow`, `image_invalid`.

Note: text overflow is intentionally non-fatal (shrink at fill time), so the `text_overflow` validation path never fires — leave it untouched. Only `wrong_type`, `table_overflow`, and `image_invalid` are reachable; make those carry numbers/types.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/test_validate.py`:

```python
def test_wrong_type_message_names_the_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "title", "slots": {"title": 123}}]}, tpl)
    e = next(e for e in errs if e.code == "wrong_type")
    assert "text" in e.message and "int" in e.message


def test_table_overflow_message_has_numbers(sample_template_dir):
    tpl = load_template(sample_template_dir)
    rows = [[1, 2]] * 9  # max_rows 5
    errs = validate({"slides": [{"slide_type": "table", "slots": {"data": rows}}]}, tpl)
    e = next(e for e in errs if e.code == "table_overflow")
    assert "5" in e.message and "9" in e.message


def test_image_invalid_message_names_the_type(sample_template_dir):
    tpl = load_template(sample_template_dir)
    errs = validate({"slides": [{"slide_type": "image", "slots": {"photo": 5}}]}, tpl)
    e = next(e for e in errs if e.code == "image_invalid")
    assert "int" in e.message
```

Add to `engine/tests/test_fit.py`:

```python
def test_table_reject_message_has_numbers():
    d, msg = assess_table([[1]] * 9, Constraints(max_rows=5, max_cols=3))
    assert d == "reject"
    assert "5" in msg and "9" in msg
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_validate.py tests/test_fit.py -v`
Expected: FAIL — current messages lack the numbers/type names.

- [ ] **Step 3: Update `_check_value` in `validate.py`**

Replace the three message strings in `engine/src/pptx_mcp/validate.py` `_check_value`:

```python
def _check_value(i: int, slot, value) -> list[SlotError]:
    if slot.type == "text":
        if not isinstance(value, str):
            return [SlotError(i, slot.id, "wrong_type",
                              f"expected text (str), got {type(value).__name__}")]
        decision, msg = assess_text(value, slot.constraints)
        if decision == "reject":
            return [SlotError(i, slot.id, "text_overflow", msg)]
    elif slot.type == "table":
        if not (isinstance(value, list) and all(isinstance(r, list) for r in value)):
            return [SlotError(i, slot.id, "wrong_type",
                              f"expected table (list[list]), got {type(value).__name__}")]
        decision, msg = assess_table(value, slot.constraints)
        if decision == "reject":
            return [SlotError(i, slot.id, "table_overflow", msg)]
    elif slot.type == "image":
        if not value or not isinstance(value, (str, bytes)):
            return [SlotError(i, slot.id, "image_invalid",
                              f"expected image URL or base64 string, got {type(value).__name__}")]
    return []
```

- [ ] **Step 4: Update `assess_table` messages in `fit.py`**

In `engine/src/pptx_mcp/fit.py` `assess_table`, replace the two reject messages:

```python
    if c.max_rows is not None and len(rows) > c.max_rows:
        return "reject", f"max {c.max_rows} rows, got {len(rows)}"
    cols = max((len(r) for r in rows), default=0)
    if c.max_cols is not None and cols > c.max_cols:
        return "reject", f"max {c.max_cols} cols, got {cols}"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_validate.py tests/test_fit.py -v`
Expected: PASS (existing `test_table_reject_rows` still passes — "max 3 rows, got 5" contains "row").

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/validate.py engine/src/pptx_mcp/fit.py engine/tests/test_validate.py engine/tests/test_fit.py
git commit -m "feat(engine): validation errors carry concrete numbers and types"
```

---

## Task 5: Web — PUT persists slide/slot annotations with autodetect fallback

**Files:**
- Modify: `web/src/app/api/templates/[id]/route.ts:27-35`
- Test: `web/tests/templates-save.test.ts`

**Interfaces:**
- Consumes: PUT body `{ name, description, visibility, slideTypes, moves }` where each `slideTypes[]` may now carry `repeatable?: boolean`, `description?: string`, and each slot may carry `description?: string`, `example?: unknown`. Reads `tpl.manifestJson.draft.slides[]` for fallback (`suggested_name`, `suggested_description`, `repeatable`, and per-shape `suggested_description`, `suggested_example`).
- Produces: persisted `manifestJson.slide_types[]` each with `repeatable`, and slots each with `description`, `example`.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("save manifest", ...)` block in `web/tests/templates-save.test.ts`:

```ts
  it("persists slide repeatable + slot description/example, falling back to draft", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1",
      manifestJson: { draft: { slides: [{
        index: 0, suggested_name: "finding",
        suggested_description: "Finding slide — fill: title.", repeatable: true,
        shapes: [{ shape_id: 5, suggested_description: "Slide title", suggested_example: "Finding F1" }],
      }] } },
    });
    (prisma.template.update as any).mockResolvedValue({});
    const body = {
      name: "Rep",
      slideTypes: [{
        id: "title", source_slide_index: 0,
        // name + slot description left blank -> fall back to draft suggestions
        name: "", description: "",
        slots: [{ id: "title", name: "Title", type: "text", shape_id: 5,
                  description: "", example: "" }],
      }],
    };
    const r = await PUT(put(body), ctx);
    expect(r.status).toBe(200);
    const saved = (prisma.template.update as any).mock.calls[0][0].data.manifestJson;
    const st = saved.slide_types[0];
    expect(st.name).toBe("finding");
    expect(st.repeatable).toBe(true);
    expect(st.slots[0].description).toBe("Slide title");
    expect(st.slots[0].example).toBe("Finding F1");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: FAIL — saved slide_type has no `repeatable`/`example`; `st.name` is `"Slide 1"`-style default, not `"finding"`.

- [ ] **Step 3: Update the PUT mapping**

In `web/src/app/api/templates/[id]/route.ts`, replace the `const slide_types = (slideTypes ?? []).map(...)` block (lines ~28-35) with:

```ts
  const draftSlides: any[] = (tpl.manifestJson as any)?.draft?.slides ?? [];
  const draftSlide = (idx: number) => draftSlides.find((s) => s.index === idx);
  const draftShape = (idx: number, shapeId: number) =>
    draftSlide(idx)?.shapes?.find((x: any) => x.shape_id === shapeId);

  const slide_types = (slideTypes ?? []).map((st: any) => {
    const ds = draftSlide(st.source_slide_index);
    return {
      id: st.id,
      name: st.name || ds?.suggested_name || `Slide ${(st.source_slide_index ?? 0) + 1}`,
      description: st.description || ds?.suggested_description || "",
      repeatable: st.repeatable ?? ds?.repeatable ?? false,
      source_slide_index: st.source_slide_index,
      slots: (st.slots ?? []).map((s: any) => {
        const sh = draftShape(st.source_slide_index, s.shape_id);
        return {
          id: s.id, name: s.name, type: s.type, target: { shape_id: s.shape_id },
          required: s.required ?? true, default: s.default ?? null,
          constraints: s.constraints ?? {},
          description: s.description || sh?.suggested_description || "",
          example: (s.example ?? "") !== "" ? s.example : (sh?.suggested_example ?? ""),
        };
      }),
    };
  });
```

(The slot-empty-id validation loop directly below stays unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: PASS (the new test and the two existing save tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/templates/[id]/route.ts web/tests/templates-save.test.ts
git commit -m "feat(web): persist slide repeatable + slot description/example with autodetect fallback"
```

---

## Task 6: Web — enrich `toAgentSchema` + add `example_deck_spec`

**Files:**
- Modify: `web/src/lib/schema.ts`, `web/src/lib/example.ts`
- Test: `web/tests/schema.test.ts` (create), `web/tests/example.test.ts`

**Interfaces:**
- Consumes: `buildExampleDeckSpec(manifestJson)` from `@/lib/example`; manifest `slide_types[]` now carry `repeatable` and slots carry `description`/`example` (Task 5).
- Produces: `toAgentSchema(...)` output gains per-slide `repeatable`, per-slot `description` + `example`, and a top-level `example_deck_spec`. `exampleSlotValue(s)` prefers `s.example`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toAgentSchema } from "@/lib/schema";

const manifest = {
  template: { id: "t1", name: "T", description: "" },
  slide_types: [{
    id: "slide_0", name: "finding", description: "Finding slide", repeatable: true,
    slots: [
      { id: "title", name: "Title", type: "text", constraints: {},
        description: "Slide title", example: "Finding F1: SQLi" },
      { id: "data", name: "Data", type: "table", constraints: {} },
    ],
  }],
};

describe("toAgentSchema enrichment", () => {
  it("surfaces slide repeatable and slot description/example", () => {
    const s = toAgentSchema(manifest, { id: "t1", name: "T", description: "" }) as any;
    expect(s.slide_types[0].repeatable).toBe(true);
    expect(s.slide_types[0].slots[0].description).toBe("Slide title");
    expect(s.slide_types[0].slots[0].example).toBe("Finding F1: SQLi");
  });

  it("includes a non-empty example_deck_spec using slot.example when set", () => {
    const s = toAgentSchema(manifest, { id: "t1", name: "T", description: "" }) as any;
    expect(s.example_deck_spec.slides[0].slide_type).toBe("slide_0");
    expect(s.example_deck_spec.slides[0].slots.title).toBe("Finding F1: SQLi");
    // table slot has no example -> falls back to the type-default list[list]
    expect(Array.isArray(s.example_deck_spec.slides[0].slots.data)).toBe(true);
  });
});
```

Add to `web/tests/example.test.ts` (inside `describe("example deck_spec", ...)`):

```ts
  it("prefers an explicit example over the type default", () => {
    expect(exampleSlotValue({ id: "t", type: "text", example: "Real text" })).toBe("Real text");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run tests/schema.test.ts tests/example.test.ts`
Expected: FAIL — `example_deck_spec` undefined; `repeatable`/`description`/`example` absent; `exampleSlotValue` ignores `example`.

- [ ] **Step 3: Update `exampleSlotValue` in `example.ts`**

In `web/src/lib/example.ts`, change the start of `exampleSlotValue`:

```ts
export function exampleSlotValue(s: any): unknown {
  if (s.example != null && s.example !== "") return s.example;
  if (s.default != null) return s.default;
  if (s.type === "table") {
```

(rest of the function unchanged.)

- [ ] **Step 4: Enrich `toAgentSchema` in `schema.ts`**

Replace `web/src/lib/schema.ts` entirely with:

```ts
import { buildExampleDeckSpec } from "@/lib/example";

export function toAgentSchema(manifestJson: any, meta?: { id: string; name: string; description: string }) {
  return {
    id: meta ? meta.id : manifestJson?.template?.id,
    name: meta ? meta.name : manifestJson?.template?.name,
    description: meta ? meta.description : (manifestJson?.template?.description ?? ""),
    slide_types: (manifestJson?.slide_types ?? []).map((st: any) => ({
      id: st.id, name: st.name, description: st.description ?? "",
      repeatable: st.repeatable ?? false,
      slots: (st.slots ?? []).map((s: any) => ({
        id: s.id, name: s.name, type: s.type,
        required: s.required ?? true, default: s.default ?? null,
        constraints: s.constraints ?? {},
        description: s.description ?? "",
        example: s.example ?? null,
      })),
    })),
    example_deck_spec: buildExampleDeckSpec(manifestJson),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/schema.test.ts tests/example.test.ts tests/mcp-api.test.ts`
Expected: PASS (include `mcp-api.test.ts` to confirm the schema route still serializes).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/schema.ts web/src/lib/example.ts web/tests/schema.test.ts web/tests/example.test.ts
git commit -m "feat(web): schema surfaces repeatable, slot hints, and example_deck_spec"
```

---

## Task 7: Web — editor UI for slide settings + slot hint/example

**Files:**
- Modify: `web/src/components/SlotPanel.tsx`, `web/src/components/TagEditor.tsx`, `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`
- Test: `web/tests/tageditor.test.tsx`

**Interfaces:**
- Consumes: `slides[]` from the edit page; shapes now carry `text?`, `suggested_example?`, `suggested_description?`; slides carry `suggested_name?`, `suggested_description?`, `repeatable?`.
- Produces: `DraftSlot` gains `description?: string` and `example?: string`. `TagEditor` gains an optional `onSlideMeta?: (slideIndex: number, meta: SlideMeta) => void` prop where `type SlideMeta = { name: string; description: string; repeatable: boolean }`. `EditClient` sends per-slide `{ name, description, repeatable }` and per-slot `{ description, example }` in the PUT body.

- [ ] **Step 1: Write the failing test**

Add to `web/tests/tageditor.test.tsx`:

```tsx
import { buildInitialSlots } from "@/components/TagEditor";

it("seeds slot description and example from shape suggestions", () => {
  const slides = [{
    index: 0, width_emu: 12192000, height_emu: 6858000,
    shapes: [{
      shape_id: 5, name: "Title", type: "text",
      bbox_pct: { x: 5, y: 5, w: 80, h: 15 },
      is_candidate: true, suggested_id: "title",
      suggested_description: "Slide title", suggested_example: "Finding F1",
    }],
  }];
  const slots = buildInitialSlots(slides as any);
  const slot = slots["0:5"];
  expect(slot.description).toBe("Slide title");
  expect(slot.example).toBe("Finding F1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: FAIL — `slot.description` / `slot.example` are `undefined` (not seeded).

- [ ] **Step 3: Extend `DraftSlot` and `SlotPanel`**

In `web/src/components/SlotPanel.tsx`, replace the `DraftSlot` type:

```tsx
export type DraftSlot = {
  shape_id: number; slideIndex: number; id: string; name: string;
  type: "text" | "table" | "image"; constraints: Record<string, number | string>;
  description?: string; example?: string;
};
```

Add, immediately after the Type `<label>` block (before the `slot.type === "text"` max-chars block):

```tsx
      <label className="block text-sm">Description (hint for the agent)
        <input aria-label="Slot description" className="w-full border p-1 rounded"
          value={slot.description ?? ""}
          onChange={(e) => onChange({ ...slot, description: e.target.value })} />
      </label>
      <label className="block text-sm">Example value
        <input aria-label="Slot example" className="w-full border p-1 rounded"
          value={slot.example ?? ""}
          onChange={(e) => onChange({ ...slot, example: e.target.value })} />
      </label>
```

- [ ] **Step 4: Seed slot fields + add slide meta in `TagEditor.tsx`**

In `web/src/components/TagEditor.tsx`:

(a) Replace the `Shape` and `Slide` type declarations and export a `SlideMeta` type:

```tsx
type Shape = {
  shape_id: number; name: string; type: string;
  bbox_pct: { x: number; y: number; w: number; h: number };
  confidence?: number; is_candidate?: boolean;
  suggested_id?: string; suggested_max_chars?: number;
  suggested_max_lines?: number;
  suggested_max_rows?: number; suggested_max_cols?: number;
  text?: string; suggested_example?: string; suggested_description?: string;
};
type Slide = {
  index: number; shapes: Shape[]; width_emu?: number; height_emu?: number;
  suggested_name?: string; suggested_description?: string; repeatable?: boolean;
};
export type SlideMeta = { name: string; description: string; repeatable: boolean };
```

(b) In `buildInitialSlots`, seed the two new fields when building each slot:

```tsx
        slots[key] = {
          shape_id: s.shape_id, slideIndex: slide.index,
          id: s.suggested_id ?? "", name: s.name,
          type: (s.type as DraftSlot["type"]) ?? "text", constraints,
          description: s.suggested_description ?? "",
          example: s.suggested_example ?? "",
        };
```

(c) Add `onSlideMeta` to the props destructure and signature:

```tsx
export function TagEditor({
  slides, previewUrls, onChange, onMove, onIssues, onSlideMeta,
}: {
  slides: Slide[];
  previewUrls: string[];
  onChange: (s: Slots) => void;
  onMove?: (slideIndex: number, shapeId: number, bbox: Box) => void;
  onIssues?: (issues: PlacementIssues) => void;
  onSlideMeta?: (slideIndex: number, meta: SlideMeta) => void;
}) {
```

(d) Add slide-meta state seeded from the slides, just after `const [selected, setSelected] = useState<string | null>(null);`:

```tsx
  const [slideMeta, setSlideMeta] = useState<Record<number, SlideMeta>>(() => {
    const m: Record<number, SlideMeta> = {};
    for (const sl of slides) {
      m[sl.index] = {
        name: sl.suggested_name ?? "",
        description: sl.suggested_description ?? "",
        repeatable: sl.repeatable ?? false,
      };
    }
    return m;
  });

  function updateSlideMeta(idx: number, patch: Partial<SlideMeta>) {
    setSlideMeta((m) => {
      const next = { ...(m[idx] ?? { name: "", description: "", repeatable: false }), ...patch };
      onSlideMeta?.(idx, next);
      return { ...m, [idx]: next };
    });
  }
```

(e) Render a Slide-settings card at the top of the sidebar — insert directly inside `<div className="w-72 space-y-3">`, before the Undo/Redo `<div className="flex gap-2">` row:

```tsx
        <div className="border rounded p-3 space-y-2">
          <p className="text-xs font-medium text-neutral-500">Slide settings</p>
          <label className="block text-sm">Name
            <input aria-label="Slide name" className="w-full border p-1 rounded"
              value={slideMeta[slideIdx]?.name ?? ""}
              onChange={(e) => updateSlideMeta(slideIdx, { name: e.target.value })} />
          </label>
          <label className="block text-sm">Description
            <input aria-label="Slide description" className="w-full border p-1 rounded"
              value={slideMeta[slideIdx]?.description ?? ""}
              onChange={(e) => updateSlideMeta(slideIdx, { description: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" aria-label="Repeat per item"
              checked={slideMeta[slideIdx]?.repeatable ?? false}
              onChange={(e) => updateSlideMeta(slideIdx, { repeatable: e.target.checked })} />
            Repeat per item
          </label>
        </div>
```

- [ ] **Step 5: Wire `EditClient` to send the new fields**

In `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`:

(a) Update the import to include `SlideMeta`:

```tsx
import { TagEditor, type PlacementIssues, type SlideMeta } from "@/components/TagEditor";
```

(b) Add slide-meta state near the other `useState` hooks:

```tsx
  const [slideMeta, setSlideMeta] = useState<Record<number, SlideMeta>>({});
  function onSlideMeta(slideIndex: number, meta: SlideMeta) {
    setSlideMeta((m) => ({ ...m, [slideIndex]: meta }));
  }
```

(c) In `save()`, replace the `const slideTypes = slides.map((_sl, idx) => ({ ... }))` builder with:

```tsx
      const slideTypes = slides.map((_sl, idx) => {
        const meta = slideMeta[idx];
        return {
          id: `slide_${idx}`,
          name: meta?.name ?? "",
          description: meta?.description ?? "",
          repeatable: meta?.repeatable ?? false,
          source_slide_index: idx,
          slots: Object.values(slots)
            .filter((s) => s.slideIndex === idx && s.id)
            .map((s) => ({
              id: s.id, name: s.name, type: s.type, shape_id: s.shape_id,
              constraints: s.constraints,
              description: s.description ?? "", example: s.example ?? "",
            })),
        };
      });
```

(d) Pass the callback to `TagEditor`:

```tsx
        <TagEditor
          slides={slides}
          previewUrls={previewUrls}
          onChange={setSlots}
          onMove={onMove}
          onIssues={handleIssues}
          onSlideMeta={onSlideMeta}
        />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/tageditor.test.tsx tests/tageditor-layers.test.tsx tests/tagEditor-multislide.test.ts`
Expected: PASS (new seed test + existing editor tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/SlotPanel.tsx web/src/components/TagEditor.tsx "web/src/app/(app)/templates/[id]/edit/EditClient.tsx" web/tests/tageditor.test.tsx
git commit -m "feat(web): editor slide-settings card + slot hint/example fields"
```

---

## Task 8: MCP — tighten tool docstrings

**Files:**
- Modify: `mcp-server/server.py:44-62`
- Test: `mcp-server/tests/test_proxy.py`

**Interfaces:**
- Consumes: nothing new — only the four `@mcp.tool()` docstrings change.
- Produces: docstrings stating the `list → schema → render` flow, value types (text=str, table=`list[list]`, image=URL/base64), and the repeat rule.

- [ ] **Step 1: Write the failing test**

Add to `mcp-server/tests/test_proxy.py`:

```python
from pathlib import Path


def test_tool_docstrings_explain_flow_and_types():
    src = Path(__file__).resolve().parent.parent / "server.py"
    text = src.read_text(encoding="utf-8")
    # render docstring must teach value types and the repeat rule
    assert "list[list]" in text
    assert "base64" in text
    assert "repeatable" in text
    # the flow is spelled out for the agent
    assert "get_template_schema_tool" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && python -m pytest tests/test_proxy.py::test_tool_docstrings_explain_flow_and_types -v`
Expected: FAIL — current docstrings lack these phrases.

- [ ] **Step 3: Rewrite the four docstrings**

In `mcp-server/server.py`, replace the four tool functions' docstrings:

```python
    @mcp.tool()
    def list_templates_tool() -> list:
        """List templates available to this API key.

        Start here, then call get_template_schema_tool(template_id) to learn a
        template's slots, then render_deck_tool to produce the .pptx.
        """
        return list_templates()

    @mcp.tool()
    def get_template_schema_tool(template_id: str) -> dict:
        """Get a template's slot schema plus a ready-to-edit example_deck_spec.

        Each slide_type lists its slots with id, type, description (hint), and
        example. A slide_type marked "repeatable": true is a pattern meant to be
        reused — to emit it N times, list it once per item in deck_spec.slides.
        Copy example_deck_spec and replace the example values with your content.
        """
        return get_template_schema(template_id)

    @mcp.tool()
    def render_deck_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render a deck; returns {validation, download_url, warnings}.

        deck_spec = {"slides": [{"slide_type": <id>, "slots": {<slot_id>: value}}]}.
        Value types: text = str, table = list[list] of strings, image = an http(s)
        URL or a data:image/...;base64,... string. If validation is non-empty the
        deck was rejected — read each message, fix the listed slots, and retry.
        """
        return render_deck(template_id, deck_spec)

    @mcp.tool()
    def render_preview_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs (same deck_spec as render_deck_tool).

        Use this to eyeball layout before render_deck_tool produces the final file.
        """
        return render_preview(template_id, deck_spec)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-server && python -m pytest tests/test_proxy.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/server.py mcp-server/tests/test_proxy.py
git commit -m "docs(mcp): tool docstrings teach flow, value types, and repeat rule"
```

---

## Self-Review

**Spec coverage:**
- Data model additions (slide `repeatable`, slot `description`/`example`) → Tasks 5, 6 (persist + surface), seeded by Tasks 1–3.
- Engine shape `text`/`suggested_example`/`suggested_description` → Task 1.
- Engine slide `kind`/`suggested_name`/`suggested_description` → Task 2.
- Engine `repeatable` structural signature → Task 3.
- Actionable validation → Task 4.
- PUT persistence (stop hardcoding name/description; accept new fields; fallback) → Task 5.
- Editor slide-settings card + slot description/example → Task 7.
- Schema enrichment + `example_deck_spec` → Task 6.
- MCP docstrings → Task 8.
- Testing section → tests in every task.
- Out-of-scope items (no LLM, no auto-routing, no enums, no rich text) → honored; nothing in the plan adds them.

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `DraftSlot.description?/example?` defined in Task 7 (SlotPanel) and consumed in TagEditor `buildInitialSlots` + EditClient save. `SlideMeta = { name; description; repeatable }` defined/exported in TagEditor, imported by EditClient; `onSlideMeta(slideIndex, meta)` signature matches both sides. Manifest slot fields `description`/`example` written in Task 5 PUT, read in Task 6 `toAgentSchema` + `buildExampleDeckSpec`. Engine field names (`suggested_example`, `suggested_description`, `kind`, `suggested_name`, `repeatable`) match across Tasks 1–3 producers and Task 5/7 consumers.
