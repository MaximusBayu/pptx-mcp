# Template auto-detect, fit validation, and UI design system — Design

Date: 2026-06-20
Status: Approved (brainstorming) — ready for implementation plan

## Problem

Tagging templates is tedious: the user clicks every shape and types `id`, `type`,
and `max_chars` by hand. Real templates are noisy — `template example/Black and
white template.pptx` has up to **39 shapes per slide**, most of them decoration
(`Freeform`, `Group`, `AutoShape` dividers, off-slide bleeds) with generic names
(`TextBox 2`). Separately, the product has **no real position validation**: a
human can drag a slot off the slide and nothing stops it, and agent content fit
is only partially enforced.

This design covers three things:
1. **Auto-detect + auto-fill** which shapes are fillable slots and their fields.
2. **Both kinds of position validation** — box placement (human drag) and
   content fit (agent fill).
3. A **web UI design system** so the app is easier on the eyes.

## Decisions (from brainstorming)

- Automation level: **auto-detect candidates + auto-fill fields**; human reviews
  and corrects (does not hand-author from scratch).
- Detection signal: **heuristic, zero designer effort**, backed by a real
  decoration classifier (designers keep building templates as plain text boxes;
  no markers, no required placeholders).
- Classifier bias: **confidence-scored** — pre-tag above a threshold, surface
  per-box confidence so the eye goes to the doubtful ones.
- `id` scheme: **hybrid** — semantic when confident (`title`/`subtitle`/`body`),
  else `text_N` / `table_N` / `image_N`.
- `max_chars`: **tight (true geometric capacity)**.
- Overflow policy: **hybrid** — shrink first, then cut at last full sentence
  (never mid-word), and report what was dropped.
- Placement enforcement: **split** — off-slide = hard block, overlap = soft warn.
- Editor: **undo/redo** for drag/tag/field actions.
- Editor UX anchor: **attention by confidence**.
- App visual direction: **soft modern**, **matcha/pastel-green accent** (color
  theory + WCAG AA), **light theme only for now**.

## Non-goals

- No designer markup convention (`{{title}}`) — rejected in favor of heuristics.
- No reliance on native PowerPoint placeholders — example uses free text boxes.
- No dark mode in this iteration (tokens structured so it can be added later).
- Agents never move shapes; layout is locked by the human at save time.

---

## §1 Architecture & flow

All geometry and classification live in the **engine** (Python; already has
python-pptx, box sizes, font sizes). Web stays the brain (auth, DB, storage) and
the editor only displays + corrects what the engine derived.

1. Upload `.pptx` → web POSTs bytes to engine-service `/autodetect`.
2. Engine returns, per slide per shape:
   `{ shape_id, bbox_pct, type, is_candidate, confidence, suggested_id,
      suggested_max_chars, suggested_max_lines, font_pt }`.
3. Web persists this as the **draft manifest** (candidates above threshold become
   pre-tagged slots, with auto-filled fields).
4. Edit page renders boxes color-coded by confidence; human reviews, corrects,
   saves into the final manifest (existing PUT `/api/templates/[id]`).

New engine module: `engine/src/pptx_mcp/autodetect.py`. New endpoint in
`engine-service/app.py`: `POST /autodetect`. Web calls it during the existing
upload path (`/api/templates` POST), storing the result in `manifestJson.draft`.

---

## §2 Decoration classifier (load-bearing)

This is the component that earns the "no manual fill" promise, so it gets the
most investment and its own test harness.

Per shape, compute a **confidence in [0,1]** that it is a fillable content slot,
from cheap signals already present in the file:

**Exclude (push confidence down):**
- `shape_type` ∈ {Freeform, Group, Connector, Line}
- small pictures (logos / icons / bullets) — see the size split below
- no text frame, or text frame text empty / whitespace only
- degenerate geometry: height ≈ 0 (divider lines), or area below a min % of slide
- off-slide bleed: `x < 0`, `y < 0`, `x + w > 100`, or `y + h > 100`

**Include (push confidence up):**
- native placeholder (Title/Body/…) → strong
- on-slide TextBox or text-bearing AutoShape with real text and adequate area
- large picture → image-slot candidate; small picture → logo/decoration

`is_candidate = confidence ≥ τ` (default τ ≈ 0.5, tunable).

### Investment & quality bar
- **Labeled fixtures:** the example deck plus 2–3 more real templates; every
  shape hand-labeled slot/decoration with expected `id`, `type`, `max_chars`.
- **Targets:** candidate **precision ≥ 0.9** and **recall ≥ 0.9**;
  `max_chars` within **±20%** of hand measurement; sentence-cut never splits a
  word.
- **Tuning loop:** iterate signal weights and τ against the fixtures until the
  targets hold; the classifier test harness reports precision/recall per fixture.

---

## §3 Field auto-derivation

- **type** — `_guess_type` (table / image / text). Already exists in `shapes.py`.
- **id (hybrid)** — semantic when confident:
  - top large text box → `title`
  - smaller text box just below the title → `subtitle`
  - largest body text block → `body`
  - picture → `image` (large) or `logo` (small)
  - otherwise `text_N` / `table_N` / `image_N`
  - dedupe collisions with a numeric suffix.
- **max_chars (tight)** — geometric capacity:
  ```
  chars_per_line ≈ box_width  / (font_pt × avg_glyph_width_factor)
  lines          ≈ box_height / (font_pt × line_height_factor)
  max_chars      ≈ chars_per_line × lines
  ```
  `font_pt` from the box's first sample run; fallback to a default when empty.
  Also derive `max_lines` from height ÷ line height. Factors calibrated against
  the labeled fixtures.

---

## §4 Overflow policy (hybrid) — content fit

Replaces the text path of `fit.py`. Per text slot at render time:

1. **Shrink** font toward a minimum size to fit the whole text.
2. If it still does not fit, **cut at the last full sentence** boundary (never
   mid-word, never mid-sentence).
3. **Report** the dropped tail in the render `validation` array as a non-fatal
   warning (not a hard reject), so loss is never silent.

Tables keep the current `max_rows` / `max_cols` reject behavior. Sentence
splitting uses a conservative boundary detector (`. ! ?` followed by space/end),
with tests guaranteeing no mid-word cut.

---

## §5 Placement validation (split) + undo/redo

Validation applies **only to tagged slots**, never to decoration — so the
template's intentional off-slide bleeds are never flagged.

On human drag (engine recomputes bbox; web validates):
- **Off-slide** (a slot crosses any slide edge) → **hard block**: cannot save;
  the box is flagged red with a message.
- **Overlap** with another slot → **soft warn**: amber message, save allowed
  (text over a banner/image is often intentional).

**Undo/redo:** an editor history stack covering drag-move, tag add, tag remove,
and field edits. Buttons plus `Ctrl+Z` / `Ctrl+Shift+Z`. Implemented as a
reducer with past/present/future stacks; unit-tested independently.

---

## §6 Editor UX — attention by confidence

Visual weight is proportional to how much a box needs review, so the eye lands
on the uncertain ones. Nothing is hard-hidden (density is tamed by suppression).

- **Decoration** (below τ) → barely visible faint outline; still clickable to
  promote to a slot.
- **Confident slot** → quiet matcha, **solid border**; recedes.
- **Doubtful slot** → amber, **dashed border + gentle pulse**; pulls the eye.
- Color is never the only signal (colorblind-safe): solid vs dashed border and
  motion reinforce the matcha/amber distinction.
- Pulse and all motion honor `prefers-reduced-motion` (reduced → stronger static
  amber, no pulse).
- Selecting a box opens a contextual panel with the auto-filled `id` / `type` /
  `max_chars`, all editable. Removing demotes the box back to faint decoration.
- "Re-run auto-detect" re-derives suggestions while preserving manual overrides.

---

## §7 Testing

**Engine (`autodetect.py`, `fit.py`):**
- Classifier on the example deck: assert `TextBox 2` is a candidate; `Freeform 7`,
  `AutoShape` with `h=0`, and tiny shapes are excluded.
- Precision/recall harness across the labeled fixtures meeting §2 targets.
- `max_chars` estimate within ±20% of hand measurement.
- Sentence-cut: never splits a word; reports dropped tail.
- Off-slide detection for slot bboxes.

**Web:**
- Upload persists the draft manifest with pre-tagged candidates + fields.
- Placement: off-slide slot hard-blocks save; overlap warns but allows save.
- Undo/redo reducer: past/present/future transitions for each action type.

**E2E (Playwright):**
- Upload the example deck → pre-tagged slots appear → review → render →
  overflow report present when text exceeds capacity.

---

## §8 Web UI design system (soft modern, matcha)

**Tokens** (Tailwind theme + CSS variables):
- **Matcha accent ramp 50→900** — matcha is a desaturated yellow-green. Pair with
  a **warm-neutral gray** ramp (analogous harmony, low vibration); reserve a muted
  complementary (clay/terracotta) only for rare emphasis.
- Pastel tints (100/200) for backgrounds, hovers, focus rings.
- **Primary buttons use deeper matcha (~600/700)** so white text meets **WCAG AA
  ≥ 4.5:1** — pastel-on-white fails contrast, so the *fill* darkens while the
  *family* stays matcha (color theory ≠ accessibility).

**Surfaces & layout:**
- Warm gray-50 app background, white cards, soft shadow, `rounded-xl`, comfortable
  padding (replaces today's stark hairline boxes).
- Keep Geist; tighter type scale, clear hierarchy, readable line-height.
- Consistent spacing rhythm and generous whitespace.

**Components refit to tokens:** nav, buttons, inputs, cards, banners.

**Accessibility & motion:**
- AA contrast everywhere; `focus-visible` matcha rings.
- Honor `prefers-reduced-motion`.
- Existing Framer Motion language, with shared easing/duration tokens for
  consistency.

**Theme scope:** light only now; tokens structured so dark mode is a later swap.

---

## Affected files (anticipated)

- `engine/src/pptx_mcp/autodetect.py` (new), `fit.py` (overflow rewrite),
  `shapes.py` (reuse), `models.py` (slot/constraint additions).
- `engine/tests/` — classifier harness + fixtures, fit/sentence-cut tests.
- `engine-service/app.py` — `POST /autodetect`.
- `web/src/app/api/templates/route.ts` — call `/autodetect` on upload, store draft.
- `web/src/app/(app)/templates/[id]/edit/` — confidence-colored TagEditor,
  undo/redo, placement validation.
- `web/tailwind.config.*`, `globals.css`, shared UI components — design tokens.
- `web/e2e/` — auto-detect + overflow e2e.
