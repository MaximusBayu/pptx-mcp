# R3 — Recompose Guardrails, Bullet Fill, Box-Grow & Agent Guidance — Design

**Date:** 2026-07-01
**Branch:** Max-dev
**Status:** Approved (design)

Final sub-project of the component-kit recompose initiative (R1 Component
Catalog → R2 composition assembler → **R3 this doc**). R2 gave the agent the
write side (clone any catalog component onto a chosen canvas, fill content).
R3 completes it: make cloned bullet/pointer lists actually fillable, let boxes
grow with their text, add layout guardrails so composed slides don't come out
broken, and tell the agent how to drive it.

Everything here is **additive** and lives on the **compose path only**. The
deck path (`render.py`, `validate.py`, `fill_slot`) stays byte-for-byte
unchanged — the final review asserts those diffs are empty, exactly as R2 did.

---

## Goal

Bundle four capabilities into one spec/plan/SDD cycle:

- **A. Bullet/list fill** — a text component accepts `str` OR `list[str]`; a
  list fills multiple bullet paragraphs preserving the template's bullet style.
  Closes the original complaint (agent "skips pointers"): today
  `_fill_text` deletes every paragraph after the first, collapsing a bullet box
  to one line, and the content model only accepts `str`.
- **B. Box-grow-then-shrink** — an overflowing text box grows its own height
  (its fill/outline decor grows with it) before falling back to font-shrink.
- **C. Guardrails** — overlap warning, off-slide auto-clamp, low-contrast
  warning, runtime fill-exception hardening.
- **D. Agent guidance** — per-component `multiline`/`hint` in the catalog and
  richer `render_composition`/`validate_composition` docstrings.

---

## Module layout & data flow

```
filler.py     A. bullet fill (str|list[str])   B. box-grow-then-shrink
guardrails.py C. overlap / off-slide-clamp / low-contrast  (pure fns)
composer.py   wires: per-placement fill (try/except), collects placed rects,
              calls guardrails per output slide, appends warnings, applies clamps
catalog.py    D. per-component `multiline` + `hint`
mcp_server.py D. enriched render/validate_composition docstrings
```

Approach: **hybrid**. Per-shape text mechanics (A, B) extend `filler.py` next
to the code they change. Layout checks (C: overlap/off-slide/contrast) go in a
new pure-function module `guardrails.py`, unit-testable in isolation, keeping
`compose` lean. Fill-exception hardening + catalog hints stay inline.

`compose`, per output slide:

1. Place each component (clone + `_remap_rels` + geometry) — unchanged from R2.
2. Fill content inside `try/except` → on error, warning `fill_failed`, skip
   that placement (a half-built slide never crashes the whole compose).
3. `_fill_text` may grow the box height (bounded by slide bottom); the placed
   shape's final rect is read back afterward.
4. After all placements: build `placed` list
   `[{component_id, rect(pct), text_color, eff_bg}]` → `guardrails.check_layout`
   → `(warnings, clamps)`; apply each clamp via `_set_geometry`; append warnings
   with `slide_index = out_index`.

---

## A. Bullet/list fill (`filler._fill_text`, `composer.validate_composition`)

`fill_shape`/`_fill_text` signature keeps `value`, now typed `str | list[str]`.

**`str`** → current path exactly. Backward compatible; existing deck/compose
text fills are unaffected.

**`list[str]`** → multi-paragraph:

- Capture `p0 = text_frame.paragraphs[0]`, its `<a:pPr>` (bullet glyph, indent,
  alignment), and `r0 = p0.runs[0]` (font family/size/bold/italic/color).
- For each item: deep-copy `p0`'s `<a:p>` element, set its single run's text to
  the item, keep the cloned `<a:pPr>`. All items use `p0`'s level (level-0).
- Remove the template's surplus sample paragraphs so exactly M item paragraphs
  remain, each carrying the template's bullet style verbatim.
- **Fit** applies to the whole block: total paragraph height vs box height
  drives box-grow (B) then font-shrink. Per-item truncation only when a single
  item overflows the box width; dropped content → warning `text_truncated`.
- **Empty box** (`r0 is None`, nothing to inherit): fall back to plain
  paragraphs, one per item, no bullet glyph.

**Validation** — `composer._CONTENT_OK["text"]` widens to accept `str`, or a
`list` whose every element is `str`. A non-str element → `wrong_type`. (Deck
`validate.py` text check is NOT touched; deck text stays str-only.)

---

## B. Box-grow-then-shrink (`filler._fill_text`)

New optional param `max_bottom_emu: int | None = None` on `fill_shape` /
`_fill_text`. `compose` passes the slide height (EMU); the deck path
(`fill_slot`) passes `None`. **Box-grow is active only when `max_bottom_emu` is
not None → compose-only; deck output is byte-identical.**

Order when text overflows the box at base font (only if `max_bottom_emu` set):

1. **Grow height first.** Compute height needed for the text at base font
   (reuse `fit_text` / `estimate_max_chars` line math). Set `shape.height` up to
   that, capped so `shape.top + shape.height ≤ max_bottom_emu - margin`. Growth
   is downward (top fixed); the box's own fill/outline grow with it.
2. **Then shrink.** If the capped height still overflows, shrink font toward the
   floor (`shrink_floor_pt` or `_MIN_PT`) as today.
3. **Then truncate.** Floor still overflows → `truncate_to_sentence`, warn
   `text_truncated`.

Growth is bounded by the slide bottom only (decision **B-i**). Sibling-overlap
caused by growth is not prevented here; it surfaces as an `overlap` warning from
the guardrail pass. This keeps `filler` decoupled from placement order — it
needs one scalar, not a rect list.

---

## C. `guardrails.py`

Pure functions. No python-pptx mutation inside; the caller (`compose`) applies
the returned clamps.

```python
def check_layout(placed, sw, sh) -> tuple[list[dict], dict]:
    # placed: [{"component_id": str,
    #           "rect": {x,y,w,h} in slide-percent,
    #           "text_color": "RRGGBB"|None,
    #           "eff_bg": "RRGGBB"|None}]
    # returns (warnings, clamps)
    #   warnings: list of {slide_index:0, slot_id, code, message} dicts
    #             (slide_index reassigned by compose to out_index)
    #   clamps:   {component_id: {x,y,w,h}}  rects to re-apply
```

- **Overlap** — pairwise `_rect_overlap_frac` (reused from `autodetect`) between
  placed rects; if either direction ≥ `OVERLAP_TAU` (0.25), one `overlap`
  warning naming the two `component_id`s and the max overlap %. Dedup per pair.
- **Off-slide clamp** — a rect extending past `[0,100]` in x/y or with
  `x+w > 100` / `y+h > 100` is clamped into bounds; emit `clamps[component_id]`
  and one `clamped` warning. `compose` re-applies via `_set_geometry`.
- **Low-contrast** — for each placed text component with **both** `text_color`
  and `eff_bg` resolved to concrete RGB: compute the WCAG relative-luminance
  contrast ratio; `< 3.0` → one `low_contrast` warning naming the
  `component_id` and the ratio. If either color is unresolvable
  (theme/inherited → None), skip silently. Helper `_contrast_ratio(hex_a,
  hex_b)` (pure).

`compose` supplies the colors: `text_color` from the placed shape's first run
(via `catalog._shape_style` logic / `_hex_or_none`), `eff_bg` = the component's
own opaque fill if resolvable, else the canvas background color resolved once
(from the `_copy_background` source `<p:bg>` solid fill, else None).

New warning codes: `overlap`, `clamped`, `low_contrast`, `fill_failed`. All use
the existing `SlotError.to_dict` shape and the existing `warnings` channel.

---

## D. Agent guidance + fill-exception hardening

**Catalog (`catalog.py`).** Each component dict gains two additive keys:

- `multiline: bool` — true when a text component has more than one non-empty
  paragraph OR bullet formatting (`<a:buChar>` / `<a:buAutoNum>` on p0). Signals
  the agent to pass an array.
- `hint: str` — short fill instruction by type:
  - text + multiline → `"bullet list — pass content as an array of strings, one per bullet"`
  - text → `"single text — pass a string"`
  - table → `"pass rows as list[list]"`
  - image → `"pass a URL or base64 string"`
  - other → `"decorative — placed verbatim, no content"`

Existing catalog keys are unchanged; R1/R2 catalog consumers keep working.

**Fill-exception hardening (`composer.compose`).** The per-placement fill call
is wrapped:

```python
try:
    warnings += [w.to_dict()... from fill_shape(...)]
except Exception as e:
    warnings.append(SlotError(out_index, component_id, "fill_failed", str(e)).to_dict())
    continue
```

One bad fill → a `fill_failed` warning; the slide keeps its other placements and
compose still returns bytes. Closes the R2-carried "raw exception with
half-built prs" item.

**Docstrings (`mcp_server.py`).** `render_composition` / `validate_composition`
docstrings expand to cover: the canvas model, optional `bbox_pct`, bullets as an
array, and the meaning of each warning code (`text_truncated`, `overlap`,
`clamped`, `low_contrast`, `fill_failed`, `table_autogrew`).

---

## Error handling

- **Additive guarantee** — `render.py`, `validate.py`, and the deck-side
  `fill_slot` path are unchanged. Box-grow is inert when `max_bottom_emu` is
  None (deck path). The final whole-branch review asserts the deck diffs are
  empty.
- **Guardrails never reject** — overlap, clamp, contrast, and fill errors are
  warnings; `compose` always produces a file (unless R2 structural validation
  already rejected the spec). Structural validation (`unknown_canvas`,
  `unknown_component`, `wrong_type`, `bad_bbox`) is unchanged and still
  rejects first.
- **Color resolution failures** — theme/inherited colors resolve to None and
  simply suppress the contrast check for that component; never an error.

---

## Testing

- **filler** — `str` still single-paragraph; `list[str]` → N bullet paragraphs
  with `<a:pPr>` preserved; empty-box list → plain-paragraph fallback; box-grow
  sets `shape.height`; grow-capped-then-shrink lowers font when slide-bottom
  caps growth; `max_bottom_emu=None` leaves geometry untouched (deck-path
  invariance).
- **guardrails** — overlapping pair → one `overlap` warning; off-slide rect →
  clamp + `clamped`; low-contrast pair → `low_contrast`; adequate-contrast → no
  warning; unresolvable color → skipped silently.
- **composer** — list content end-to-end round-trip (save→reopen, bullets
  survive); `fill_failed` path (monkeypatch fill to raise) still returns bytes +
  warning; clamp actually re-applied to the placed shape's geometry.
- **catalog** — `multiline` true for a bullet box, false for a single-line box;
  `hint` correct per type. Existing catalog assertions still pass.
- **validate** — list content accepted; a list with a non-str element →
  `wrong_type`.
- **mcp** — tools still registered; docstring smoke.

---

## Out of scope (deferred)

- Sibling-collision-bounded growth (B-ii): growth stops only at the slide
  bottom; sibling overlap is reported, not prevented.
- Per-item bullet indent levels: all list items are level-0.
- `cover` image fit and z-order reordering (carried R2 minor).
- Contrast/guardrails on the deck render path: compose-only.
- Cross-layer reject-code parity tests beyond the engine layer (carried R2
  optional).
