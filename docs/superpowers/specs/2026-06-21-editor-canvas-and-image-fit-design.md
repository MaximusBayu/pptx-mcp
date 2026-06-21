# Editor Canvas Correctness & Image Contain-Fit — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending spec review before plan.

## Goal

Make the template editor canvas behave correctly: a dragged box lands and
stays where dropped, the editable area extends to hold intentionally bleeding
components (with the slide drawn as a reference frame), and boxes covered by a
larger block stay reachable. Also make agent-supplied images sized correctly
inside their reserved spots. These coupled workstreams share the editor +
engine paths, so they ship in one spec.

## Background

The editor (`web/src/components/TagEditor.tsx`) renders each PPTX shape as an
absolutely-positioned `motion.button` over a slide preview image. Users tag
shapes as slots and may drag a box to reposition the underlying shape. Drag
currently pushes geometry to the engine **live, per drop** via
`POST /api/templates/[id]/move-shape`, which mutates the base `.pptx` and
re-renders previews. Agent rendering fills image slots in
`engine/src/pptx_mcp/filler.py::_fill_image`, which today replaces the shape at
its exact box rect (stretch — distorts).

## Findings (audit, 2026-06-21)

Logic:
- **L1 (High):** `handleDragEnd` uses `info.point` (absolute cursor viewport
  coords) as the box's new top-left, so the box jumps to the grab point.
  Must use `info.offset` (delta since drag start).
- **L2 (High):** framer-motion `drag` leaves a CSS `transform` on the element
  after release; code also sets `left/top` → double-shift. Need
  `dragSnapToOrigin` so framer zeros the transform on release.
- **L3 (High):** `engine/src/pptx_mcp/move.py::move_shape` loops *all* slides
  and moves the *first* shape matching `shape_id`. `onMove` passes only
  `shape_id`, not slide index. Two slides sharing a `shape_id` (common in
  PPTX) → wrong slide's shape moves. The PUT/move route also persists bbox to
  every matching slide.
- **L4 (High):** `onMove` awaits the fetch but ignores `!ok`. A failed move
  leaves the box looking moved while the base pptx is unchanged → on reload it
  reverts.
- **L5 (Medium):** After `/move-shape` overwrites the preview PNG (same key),
  the client keeps the old presigned image; the rendered shape under the
  overlay is stale until full reload.
- **L6 (Medium):** Undo/redo restores the local bbox but never reverts the
  server pptx → overlay desyncs from the deck.

UX:
- **U1:** Every drag triggers a full LibreOffice re-render (slow, no debounce).
- **U2:** Drag has no bounds at all on the upper side; a box can be dragged
  anywhere, including into the surrounding page UI. The drag must be bounded —
  but to the **editable canvas** (which includes intentional bleed area), not
  the slide (see U6).
- **U5:** A large block (often a full-bleed SVG/freeform) painted on top
  covers smaller boxes inside the canvas, so they cannot be clicked/selected.
  This is intra-canvas z-order obstruction — distinct from the `overflow-hidden`
  clip (commit `26ca8f1`) which only stopped leakage *outside* the canvas.
- **U6:** The canvas is exactly the slide rectangle, so shapes that
  intentionally overflow the slide (legitimate bleed design) are clipped and
  the editable area gives no room to grab them. There is no visible slide
  boundary either, so on-slide vs. intentional-bleed is invisible.
- **U3 (deferred):** No resize; no numeric x/y/w/h editing.
- **U4 (deferred):** Deselect doesn't reset the selected border.

Image:
- **I1:** `_fill_image` stretches the agent image to the box rect (distorts).
  `Constraints.fit` ("cover" | "contain") already exists and is parsed from
  the manifest but is unused.

## Decisions

1. **Geometry persistence = batch at Save** (not live per-drag). Drag updates
   local state only; Save applies all moves in one engine pass and one preview
   refresh. This dissolves L4/L5/L6/U1: undo is pure-local (no desync), one
   render (no lag), Save already has try/catch + redirect (no silent failure,
   no in-editor stale preview).
2. **Image fit = contain**, centered. Whole image visible inside the box,
   letterbox gap on the short side, no crop, no distortion. `cover` deferred.
3. **Editable canvas extends to fit overflow.** The canvas viewport is the
   union of the slide rectangle and every shape's bbox, so intentionally
   bleeding components stay reachable. The slide is drawn as a reference frame
   inside it. Off-slide placement is **allowed** (legitimate bleed) — the
   former off-slide *hard block* on Save becomes a soft amber warning.
4. **Reach covered boxes = z-order + layer list.** Paint larger boxes first
   (small boxes on top, always clickable) AND add a sidebar layer list of the
   slide's shapes to select any one even when fully covered.
5. **Scope = moves only.** Resize (U3) and deselect-reset (U4) deferred.

## Architecture

### Editable canvas viewport (fixes U6)

The canvas no longer equals the slide. For each slide, compute the **content
extent** in slide-percent: the union of the slide rectangle `(0,0,100,100)` and
every shape's `bbox_pct`, padded by a small margin (e.g. 2%). Call it
`{ minX, minY, maxX, maxY }` with `rangeX = maxX - minX`, `rangeY = maxY - minY`.

- The canvas element sizes to `rangeX : rangeY` aspect and keeps
  `overflow-hidden` (clips to the extended canvas, so still no leak into page
  UI). It carries `data-testid="slide-canvas"`.
- A **slide frame** (bordered rectangle, non-interactive) is drawn at
  `left = (0 - minX)/rangeX`, `top = (0 - minY)/rangeY`,
  `width = 100/rangeX`, `height = 100/rangeY` — so the user sees on-slide vs.
  intentional bleed.
- The preview image is positioned to fill the slide frame (it represents the
  slide, not the extended area).
- Each shape maps from slide-% to canvas-% via
  `cx = (bbox.x - minX)/rangeX * 100`, `cy = (bbox.y - minY)/rangeY * 100`,
  `cw = bbox.w/rangeX * 100`, `ch = bbox.h/rangeY * 100`.

A pure helper `canvasExtent(slide, overrides, margin)` computes the extent and
`toCanvasPct(bbox, extent)` / `fromCanvasOffset(offsetPx, extent, rectPx)` do
the mappings, so they are unit-testable without the DOM.

### Client drag correctness (fixes L1, L2, U2)

`TagEditor.handleDragEnd(slideIndex, shapeId, info)`:
- Convert `info.offset` (px) to **slide-percent**: `dxSlide = offsetX/rectW *
  rangeX`, `dySlide = offsetY/rectH * rangeY` (rect = canvas
  `getBoundingClientRect()`), so a drag delta maps back through the extent.
- `newX = clamp(existing.x + dxSlide, minX, maxX - existing.w)`;
  `newY = clamp(existing.y + dySlide, minY, maxY - existing.h)`. The clamp is
  to the **editable canvas extent**, not the slide — a box may sit off-slide
  (intentional bleed) but cannot leave the canvas into the page UI.
- Write `bboxOverrides[slideIndex:shapeId] = { ...existing, x: newX, y: newY }`
  through the history reducer.

Shape button gains `dragSnapToOrigin` so framer's transform returns to origin
on release while the persisted `left/top` becomes the single source of truth.

### Reaching covered boxes — z-order + layer list (fixes U5)

- **Z-order:** render the slide's shapes sorted by bbox area **descending**, so
  larger boxes paint first (lower in the stack) and smaller boxes sit on top
  and stay clickable. (Sort a copy for rendering; keep `shape_id` as the React
  key.)
- **Layer list:** a sidebar panel lists every shape on the current slide
  (name + a tag/confidence dot). Clicking a row selects that shape (sets the
  same composite selected key the canvas uses), so a fully-covered shape is
  always reachable. The selected row and the selected canvas box stay in sync.

### Geometry persistence — batch at Save (fixes L4, L5, L6, U1)

- `onMove` prop signature changes to `(slideIndex, shapeId, bbox)`. TagEditor
  records moves locally only — **no per-drag fetch**.
- `EditClient` holds a `moves` map keyed `"${slideIndex}:${shapeId}"`, updated
  via `onMove`. At Save, it sends `moves: Move[]` in the PUT payload, where
  `Move = { slide_index: number; shape_id: number; bbox_pct: Box }`.
- The PUT route `web/src/app/api/templates/[id]/route.ts`, when `moves` is
  non-empty:
  1. `getObject(tpl.basePptxKey)` → base bytes.
  2. `moveShapes(base, moves)` → moved bytes (engine batch).
  3. `putObject(tpl.basePptxKey, moved, PPTX)`.
  4. `renderBasePreviews(moved)` → store `preview-<i>.png`, collect keys.
  5. Persist into `manifestJson.draft`: set each moved shape's `bbox_pct` on
     the **correct slide** (match by slide index + shape_id), and
     `draft.previewKeys`.
  Then perform the existing slot-manifest update. All in one PUT.
- Existing live `/api/templates/[id]/move-shape` route and its test stay
  (back-compat); the editor simply stops calling it.
- **Off-slide is no longer a hard block** (Decision 3). `EditClient.save`
  removes the `issues.offSlide.length > 0` early-return; off-slide tagged slots
  surface as an amber soft warning alongside the overlap warning, and Save
  proceeds. `isOffSlide`/`placementIssues` detection is unchanged (still used
  to drive the warning and the red box treatment). The Save button is no longer
  disabled by `hasOffSlide`.

### Slide-aware move (fixes L3)

`engine/src/pptx_mcp/move.py`:
- Add `move_shapes(pptx_bytes: bytes, moves: list[dict]) -> bytes`. Each move
  is `{slide_index, shape_id, x, y, w, h}` (x/y/w/h in slide-percent). Iterate
  `enumerate(prs.slides)`; for each move, locate the slide by index, then the
  shape by `shape_id` *within that slide*, and set
  `left/top/width/height` from percent × slide dims. Apply all, save once.
  Raise `KeyError` if a move's `(slide_index, shape_id)` is not found.
- Add optional `slide_index: int | None = None` to `move_shape`; when given,
  only that slide is searched (None preserves current first-match behavior for
  back-compat).

`engine-service`: add `POST /move-shapes` (multipart: `file` + `moves` JSON
array) → returns moved `.pptx` bytes (same content-type as `/move-shape`).

`web/src/lib/engine.ts`: add
`moveShapes(pptx: Buffer, moves: Move[]): Promise<Buffer>` posting to
`/move-shapes`.

### Image contain-fit (fixes I1)

`engine/src/pptx_mcp/filler.py::_fill_image`:
- Resolve bytes via existing `load_image_bytes(value)`.
- If `fit` is `None` or `"contain"` (default): read pixel dims with
  `PIL.Image.open(BytesIO(data)).size`; compute the contained rect:
  - `box_ar = box_w / box_h`, `img_ar = iw / ih`.
  - If `img_ar > box_ar`: `new_w = box_w`, `new_h = round(box_w / img_ar)`.
  - Else: `new_h = box_h`, `new_w = round(box_h * img_ar)`.
  - `new_left = box_left + (box_w - new_w) // 2`,
    `new_top = box_top + (box_h - new_h) // 2`.
  - `add_picture(stream, new_left, new_top, new_w, new_h)`.
- Pass `slot.constraints.fit` into `_fill_image` (currently not passed).
- `cover` is deferred; if encountered, fall back to `contain` for now.
- **Fallback:** if box width/height ≤ 0, or PIL cannot read the image, place
  at the original box rect (current behavior) — never crash.
- Promote `pillow` from a dev-only dependency to an engine **runtime**
  dependency in `engine/pyproject.toml`.

## Data structures

```
Move = { slide_index: int, shape_id: int, bbox_pct: { x, y, w, h } }   # web
move (engine) = { slide_index, shape_id, x, y, w, h }                   # percent
```

`bbox_pct` values are slide-percent floats in [0, 100]. EMU conversion:
`left = int(slide_width_emu * x / 100.0)` (and analogously for top/width/
height), matching existing `move.py`.

## Testing

Engine (`engine/tests/`):
- `move_shapes`: two slides share `shape_id=2`; a move targeting
  `slide_index=1` changes slide 1's shape geometry and leaves slide 0's
  unchanged. A batch of two moves applies both.
- `move_shape(slide_index=…)`: targets the correct slide.
- Image contain: wide image into a tall box → `new_w == box_w`,
  `new_h < box_h`, picture centered vertically (top offset > 0). Tall image
  into a wide box → `new_h == box_h`, centered horizontally. Square into
  square → fills exactly. Unreadable image → falls back to box rect, no crash.

Engine-service (`engine-service/`):
- `POST /move-shapes` with a 2-move payload returns a valid `.pptx`.

Web (`web/tests/`):
- `canvasExtent`: with a shape bbox `{x:-10,w:30}` and another `{x:90,w:25}`,
  the extent spans below 0 and above 100 (plus margin); a slide-only set yields
  `~0..100`. `toCanvasPct` maps a slide-% bbox into the extent correctly.
- TagEditor drag: render, mock canvas `getBoundingClientRect`, fire a drag
  with a known `info.offset`; assert the resulting bbox = start + delta mapped
  through the extent and clamped to the canvas extent (off-slide allowed,
  off-canvas not). Assert `onMove` is called with `(slideIndex, shapeId, bbox)`
  and that **no** fetch fires during drag.
- Z-order: given shapes of different areas, the rendered DOM order is
  area-descending (large first), so smaller boxes are later siblings (on top).
- Layer list: clicking a list row for a covered shape selects it (its
  SlotPanel/`onChange` reflects that shape).
- Off-slide save: a tagged off-slide slot produces an amber warning but Save
  still issues the PUT (no hard block).
- EditClient save: with a recorded move, the PUT body contains `moves` with
  the correct `slide_index`.

## Out of scope

- Resize handles and numeric position/size editing (U3).
- Deselect border reset (U4).
- `cover` (crop-to-fill) image fit.
- Removing the now-unused live `/move-shape` web route.
