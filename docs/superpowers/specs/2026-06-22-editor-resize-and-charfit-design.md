# Editor Block Resize + Live Char-Fit + Drop-Rebound Fix — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review before plan.

## Goal

Three cohesive improvements to the template editor canvas:

1. **Resize** a selected block via 8 handles (4 corners + 4 edge midpoints).
2. A **live "chars that fit" readout** that recomputes as the block resizes,
   with a one-click **"Use this"** to set the slot's `max_chars`.
3. **Remove the drag-placement rebound** — on drop a block currently snaps back
   to its origin and then jumps to the new position; it should paint once at the
   final position with no animation.

All three touch the same canvas/editor surface, so they ship as one spec/plan.

## Background

- The editor canvas (`web/src/components/TagEditor.tsx`) renders each shape as a
  draggable `motion.button` positioned by `left/top/width/height` percentages
  derived from `bbox_pct` via `toCanvasPct`, inside an extended viewport
  (`canvasExtent`, the union of the slide + all shape boxes).
- Drag-move already works: `handleDragEnd` converts `info.offset` (px) to pct
  deltas via `fromCanvasOffset`, clamps with `clampToExtent`, pushes to history,
  and calls `onMove(slideIndex, shapeId, bbox)`. On Save, `EditClient` batches
  these into the PUT body; the engine's `move_shapes` applies them and previews
  re-render.
- **`move_shapes` already sets `width` + `height`** from `bbox_pct.w/h`
  (`engine/src/pptx_mcp/move.py`). So resize needs **no engine or API change** —
  only the canvas must start emitting w/h changes through the existing pipeline.
- The engine already estimates capacity: `estimate_max_chars(width_emu,
  height_emu, font_pt)` in `engine/src/pptx_mcp/autodetect.py`
  (`GLYPH_W=0.5`, `LINE_H=1.2`, `EMU_PER_PT=12700`, `DEFAULT_FONT_PT=18`).
  Autodetect already emits per-shape `font_pt`.

## Decisions

1. **8 handles** (corners + edge midpoints), shown only for the selected block.
2. **Live readout + "Use this" button** — the estimate never auto-overwrites a
   hand-typed `max_chars`; the user clicks to apply it.
3. **No engine/API change** — resize reuses the existing `moves` pipeline; the
   char estimate is a TS mirror of the engine formula.
4. **Drop paints once** — eliminate the snap-to-origin rebound entirely.

## Components

### 1. `web/src/lib/charfit.ts` (new, pure)

```
estimateMaxChars(wPct, hPct, slideWemu, slideHemu, fontPt): number
```

Mirrors the engine's `estimate_max_chars`. Converts the bbox percentages to EMU
(`width_emu = slideWemu * wPct / 100`, `height_emu = slideHemu * hPct / 100`),
then applies `chars_per_line = floor(width_emu / (font_emu * 0.5))`,
`lines = floor(height_emu / (font_emu * 1.2))`, returns `chars_per_line * lines`
(both factors floored to ≥ 1, as the engine does). Uses `DEFAULT_FONT_PT = 18`
when `fontPt` is null/≤0. Constants are defined at the top with a comment
pointing at `autodetect.py` so the two stay in sync. Pure and unit-tested.

### 2. `web/src/components/TagEditor.tsx` — resize handles

- When a block is selected, render 8 small absolutely-positioned handles on it
  (NW, N, NE, E, SE, S, SW, W).
- `handleResize(handle, info)` converts the handle's drag `info.offset` (px) to
  pct deltas via the existing `fromCanvasOffset`, then applies them to the
  correct edges per handle:
  - corners move two edges (e.g. NW: `x += dx, y += dy, w -= dx, h -= dy`),
  - edge handles move one axis (e.g. E: `w += dx`; S: `h += dy`; W: `x += dx,
    w -= dx`; N: `y += dy, h -= dy`).
- Enforce a **min size floor** (`MIN_PCT = 2`) on w and h so a block can't
  collapse to zero or invert.
- Clamp the result to the extent (`clampToExtent`), push to history, and call
  `onMove(slideIndex, shapeId, newBbox)` — the same persistence path as move.
- Handle drags **stop propagation** so they don't also trigger the block's
  move-drag.

### 3. `web/src/components/SlotPanel.tsx` — live readout + "Use this"

- For a **text** slot, show "Fits ~N chars at this size" where N is a
  `charEstimate?: number` prop, plus a **Use this** button that calls `onChange`
  with `constraints.max_chars = charEstimate`.
- `TagEditor` computes the estimate for the currently-selected text shape from
  its **live** bbox (current `bboxOverrides` or template `bbox_pct`), the
  shape's `font_pt`, and the slide's `width_emu`/`height_emu`, and passes it to
  `SlotPanel`. The readout updates as the block is resized because the live bbox
  feeds the estimate each render. Shown only for `type === "text"`.

### 4. `web/src/components/TagEditor.tsx` — drop-rebound fix

The rebound comes from `dragSnapToOrigin`: framer animates the drag transform
back to origin while the extended viewport (`canvasExtent`, derived from
`bboxOverrides`) simultaneously reflows into a new coordinate frame, so the box
visibly returns to its old spot and then re-lays-out at the new one.

Fix: commit the move and repaint in a single frame with no tween.
- Remove `dragSnapToOrigin`; on `onDragEnd` (and on resize end) commit the new
  bbox to `bboxOverrides` (which drives `left/top/width/height`) and reset the
  drag transform to 0 imperatively (e.g. via animation controls `set({x:0,
  y:0})` or resetting the motion values) so no transform residue remains.
- Ensure every relevant `transition` is `{ duration: 0 }` and the box position
  comes only from committed `left/top` (never a lingering `x/y` transform).
- Net behavior: exactly one paint at the final position — no snap-to-origin
  frame, no rebound, no animation. (The existing `whileHover` scale on idle
  blocks is unrelated and stays.)

## Data flow

Resize/move handle drag → `TagEditor` updates `bboxOverrides` (live canvas) +
`onMove` → on Save, `EditClient` batches into the PUT body → `move_shapes`
applies x/y/w/h → previews re-render. The char estimate is display-only until
"Use this" writes `max_chars` into the slot, persisted in `slide_types`
constraints exactly as today.

## Error handling / edges

- Min size floor (`MIN_PCT = 2`) prevents zero/inverted boxes.
- Resize clamps to the extended canvas, like move.
- Estimate falls back to `DEFAULT_FONT_PT` when the shape has no `font_pt`.
- Readout + "Use this" appear only for text slots.
- Resize handles render only for the selected block; handle drags never
  propagate to the block move-drag.

## Testing

- `web/tests/charfit.test.ts` — `estimateMaxChars` matches the engine formula
  for a couple of sizes (e.g. a wide box yields more chars than a narrow one;
  a bigger font yields fewer); uses `DEFAULT_FONT_PT` when `fontPt` is null.
- `web/tests/tageditor.test.tsx` (extend) — a resize-handler call changes w/h in
  the expected direction for a given handle, respects the `MIN_PCT` floor, and
  calls `onMove` with the new bbox; after a drop the block has no residual drag
  transform (rebound gone).
- SlotPanel test — for a text slot with a `charEstimate`, the readout renders and
  "Use this" sets `constraints.max_chars` to the estimate.

## Out of scope

- Rotation, aspect-ratio lock, snapping/alignment guides, multi-select resize.
- Changing the engine's fit/shrink math (the estimate only mirrors it).
- Resizing via numeric width/height inputs (handles only).
