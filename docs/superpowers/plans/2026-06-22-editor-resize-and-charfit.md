# Editor Block Resize + Live Char-Fit + Drop-Rebound Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user resize a selected canvas block via 8 handles, see a live "chars that fit" estimate (with one-click "Use this" to set `max_chars`), and eliminate the drag-placement rebound — by switching block move + resize to controlled pointer gestures.

**Architecture:** Two new pure helpers — `charfit.ts` (mirror of the engine's `estimate_max_chars`) and `gesture.ts` (`applyGesture` computing a new bbox from a handle + a pct delta). `TagEditor` replaces framer-motion `drag` with pointer-event gestures driving a live preview box and committing through the existing `onMove` → batched-PUT → `move_shapes` pipeline (which already applies width+height). `SlotPanel` gains a live char readout + "Use this" button.

**Tech Stack:** Next.js / TypeScript / React, framer-motion (being removed from the block interaction), vitest + @testing-library/react.

## Global Constraints

- **No engine or API change.** Resize reuses the existing `moves` pipeline; `move_shapes` already sets width+height from `bbox_pct.w/h`.
- **Pure helpers stay pure** (`charfit.ts`, `gesture.ts`): no React, no DOM, no network.
- **Char estimate mirrors the engine** verbatim: `GLYPH_W=0.5`, `LINE_H=1.2`, `EMU_PER_PT=12700`, `DEFAULT_FONT_PT=18`; `chars_per_line=max(1, floor(width_emu/(font_emu*0.5)))`, `lines=max(1, floor(height_emu/(font_emu*1.2)))`, return product. Comment points at `engine/src/pptx_mcp/autodetect.py`.
- **Min size floor** `MIN_PCT = 2` — a block can't resize below 2% w/h or invert.
- **Drop paints once** — no snap-to-origin, no rebound; block position comes only from committed `left/top` (no residual transform).
- **Estimate never auto-overwrites** `max_chars`; the user clicks "Use this".
- Readout + "Use this" appear only for `type === "text"` slots.

**Run web tests:** `cd web && npx vitest run <path>`

---

## File Structure

- `web/src/lib/charfit.ts` — **create.** `estimateMaxChars(...)` pure.
- `web/src/lib/gesture.ts` — **create.** `Handle` type + `applyGesture(...)` pure.
- `web/src/components/TagEditor.tsx` — **modify.** Replace framer-drag block with pointer-gesture move + 8 resize handles; pass `charEstimate` to SlotPanel.
- `web/src/components/SlotPanel.tsx` — **modify.** `charEstimate?` prop → readout + "Use this".
- Tests: `web/tests/charfit.test.ts` (create), `web/tests/gesture.test.ts` (create), `web/tests/tageditor.test.tsx` (rewrite the move test + add resize test), `web/tests/slotpanel.test.tsx` (create).

---

## Task 1: `charfit.ts` — live char estimate

**Files:**
- Create: `web/src/lib/charfit.ts`
- Test: `web/tests/charfit.test.ts`

**Interfaces:**
- Produces: `estimateMaxChars(wPct: number, hPct: number, slideWemu: number, slideHemu: number, fontPt: number | null | undefined): number` and `export const DEFAULT_FONT_PT = 18`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/charfit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { estimateMaxChars, DEFAULT_FONT_PT } from "@/lib/charfit";

const W = 12192000, H = 6858000; // 16:9 slide EMU

describe("estimateMaxChars", () => {
  it("a wider box fits more chars than a narrow one", () => {
    expect(estimateMaxChars(80, 20, W, H, 18)).toBeGreaterThan(estimateMaxChars(20, 20, W, H, 18));
  });

  it("a bigger font fits fewer chars", () => {
    expect(estimateMaxChars(50, 30, W, H, 36)).toBeLessThan(estimateMaxChars(50, 30, W, H, 18));
  });

  it("falls back to the default font when fontPt is null", () => {
    expect(estimateMaxChars(50, 30, W, H, null)).toBe(estimateMaxChars(50, 30, W, H, DEFAULT_FONT_PT));
  });

  it("never returns below 1 char per line/line count", () => {
    expect(estimateMaxChars(0.1, 0.1, W, H, 18)).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/charfit.test.ts`
Expected: FAIL — `Cannot find module '@/lib/charfit'`.

- [ ] **Step 3: Implement `charfit.ts`**

Create `web/src/lib/charfit.ts`:

```ts
// Mirrors engine/src/pptx_mcp/autodetect.py estimate_max_chars — keep in sync.
// bbox w/h are percent of slide WIDTH / HEIGHT respectively.
const GLYPH_W = 0.5;
const LINE_H = 1.2;
const EMU_PER_PT = 12700;
export const DEFAULT_FONT_PT = 18;

export function estimateMaxChars(
  wPct: number,
  hPct: number,
  slideWemu: number,
  slideHemu: number,
  fontPt: number | null | undefined,
): number {
  const pt = fontPt && fontPt > 0 ? fontPt : DEFAULT_FONT_PT;
  const fontEmu = pt * EMU_PER_PT;
  const widthEmu = (slideWemu * wPct) / 100;
  const heightEmu = (slideHemu * hPct) / 100;
  const charsPerLine = Math.max(1, Math.floor(widthEmu / (fontEmu * GLYPH_W)));
  const lines = Math.max(1, Math.floor(heightEmu / (fontEmu * LINE_H)));
  return charsPerLine * lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/charfit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/charfit.ts web/tests/charfit.test.ts
git commit -m "feat(web): estimateMaxChars mirrors engine fit formula"
```

---

## Task 2: `gesture.ts` — pure resize/move math

**Files:**
- Create: `web/src/lib/gesture.ts`
- Test: `web/tests/gesture.test.ts`

**Interfaces:**
- Consumes: `Box` from `@/lib/placement` (`{ x: number; y: number; w: number; h: number }`).
- Produces: `type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"` and `applyGesture(handle: Handle, start: Box, d: { dx: number; dy: number }, minPct?: number): Box` (minPct default 2).

- [ ] **Step 1: Write the failing test**

Create `web/tests/gesture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyGesture } from "@/lib/gesture";

const start = { x: 10, y: 10, w: 40, h: 20 };

describe("applyGesture", () => {
  it("move translates position, keeps size", () => {
    expect(applyGesture("move", start, { dx: 5, dy: 6 })).toEqual({ x: 15, y: 16, w: 40, h: 20 });
  });

  it("se grows width and height from the anchored top-left", () => {
    expect(applyGesture("se", start, { dx: 10, dy: 8 })).toEqual({ x: 10, y: 10, w: 50, h: 28 });
  });

  it("nw moves the top-left and shrinks size", () => {
    expect(applyGesture("nw", start, { dx: 5, dy: 4 })).toEqual({ x: 15, y: 14, w: 35, h: 16 });
  });

  it("e resizes width only; s resizes height only", () => {
    expect(applyGesture("e", start, { dx: 10, dy: 99 })).toEqual({ x: 10, y: 10, w: 50, h: 20 });
    expect(applyGesture("s", start, { dx: 99, dy: 10 })).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });

  it("enforces the min floor without inverting (se shrink past zero)", () => {
    const r = applyGesture("se", start, { dx: -100, dy: -100 }, 2);
    expect(r.w).toBe(2);
    expect(r.h).toBe(2);
    expect(r.x).toBe(10);
    expect(r.y).toBe(10);
  });

  it("freezes the moving edge at the floor (nw shrink past zero)", () => {
    const r = applyGesture("nw", start, { dx: 100, dy: 100 }, 2);
    expect(r.w).toBe(2);
    expect(r.h).toBe(2);
    expect(r.x).toBe(48); // start.x + start.w - minPct = 10 + 40 - 2
    expect(r.y).toBe(28); // start.y + start.h - minPct = 10 + 20 - 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/gesture.test.ts`
Expected: FAIL — `Cannot find module '@/lib/gesture'`.

- [ ] **Step 3: Implement `gesture.ts`**

Create `web/src/lib/gesture.ts`:

```ts
import type { Box } from "./placement";

export type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Compute a new bbox from a gesture handle + a slide-% delta.
 * "move" translates; resize handles adjust the edges they name. A min floor
 * keeps width/height >= minPct and prevents inversion: when a west/north edge
 * would cross its opposite edge, it freezes at the floor instead of flipping.
 */
export function applyGesture(
  handle: Handle,
  start: Box,
  d: { dx: number; dy: number },
  minPct = 2,
): Box {
  const { dx, dy } = d;
  if (handle === "move") return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };

  let { x, y, w, h } = start;
  if (handle.includes("e")) w = start.w + dx;
  if (handle.includes("w")) { x = start.x + dx; w = start.w - dx; }
  if (handle.includes("s")) h = start.h + dy;
  if (handle.includes("n")) { y = start.y + dy; h = start.h - dy; }

  if (w < minPct) {
    if (handle.includes("w")) x = start.x + start.w - minPct;
    w = minPct;
  }
  if (h < minPct) {
    if (handle.includes("n")) y = start.y + start.h - minPct;
    h = minPct;
  }
  return { x, y, w, h };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/gesture.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/gesture.ts web/tests/gesture.test.ts
git commit -m "feat(web): applyGesture pure move/resize math with min floor"
```

---

## Task 3: TagEditor — pointer-gesture move (rebound fix)

**Files:**
- Modify: `web/src/components/TagEditor.tsx`
- Test: `web/tests/tageditor.test.tsx` (rewrite the move test)

**Interfaces:**
- Consumes: `applyGesture`, `Handle` from `@/lib/gesture`; existing `fromCanvasOffset`, `clampToExtent`, `toCanvasPct`, `bboxFor`, `slotKey`, history helpers.
- Produces: pointer-driven move that calls the existing `onMove(slideIndex, shapeId, bbox)`; a `gesture` state used for the live preview; no framer `drag`/`dragSnapToOrigin` on blocks. (Resize handles are added in Task 4; this task wires the "move" handle only.)

- [ ] **Step 1: Rewrite the failing move test**

In `web/tests/tageditor.test.tsx`, replace the entire `it("drag reports onMove(slideIndex, shapeId, bbox) and fires no fetch", ...)` test (the fiber-walk block) with this pointer-event version:

```tsx
  it("pointer-drag reports onMove(slideIndex, shapeId, bbox), no rebound, no fetch", () => {
    const onMove = vi.fn();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}") as any);
    render(
      <TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={onMove} />
    );
    const canvas = screen.getByTestId("slide-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} } as DOMRect
    );
    const box = screen.getByRole("button", { name: /shape Title/ });
    fireEvent.pointerDown(box, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 64, clientY: 36, pointerId: 1 });
    fireEvent.pointerUp(box, { clientX: 64, clientY: 36, pointerId: 1 });
    expect(onMove).toHaveBeenCalled();
    const [si, sid, bbox] = onMove.mock.calls.at(-1)!;
    expect(si).toBe(0);
    expect(sid).toBe(5);
    expect(bbox.x).toBeGreaterThan(10); // moved right from x=10
    // box position is committed via left/top — no framer transform residue
    expect((box as HTMLElement).style.transform === "" || (box as HTMLElement).style.transform == null).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: FAIL — pointer events don't yet drive `onMove` (current code uses framer `onDragEnd`).

- [ ] **Step 3: Replace framer-drag with pointer gestures**

In `web/src/components/TagEditor.tsx`:

(a) Update imports — drop `motion`/`PanInfo`, keep `useReducedMotion`; add gesture import:

```tsx
"use client";
import { useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";
import { placementIssues, type Box } from "@/lib/placement";
import {
  canvasExtent, toCanvasPct, fromCanvasOffset, clampToExtent, canvasHeightPx,
  type Extent,
} from "@/lib/canvasView";
import { applyGesture, type Handle } from "@/lib/gesture";
import {
  initHistory, pushState, undo, redo, canUndo, canRedo,
  type History,
} from "@/lib/editorHistory";
```

(b) Add the min-floor constant near the top (after the imports):

```tsx
const MIN_PCT = 2;
```

(c) Add gesture state + handlers. Insert right after the existing `function handleDragEnd(...) { ... }` block, then DELETE the old `handleDragEnd` function entirely:

```tsx
  const [gesture, setGesture] = useState<{
    key: string; slideIndex: number; shapeId: number; handle: Handle;
    startBox: Box; startPt: { x: number; y: number }; live: Box; moved: boolean;
  } | null>(null);

  function gestureStart(e: React.PointerEvent, slideIndex: number, shapeId: number, handle: Handle) {
    if (!onMove) return;
    if (handle !== "move") e.stopPropagation();
    const startBox = bboxFor(slideIndex, shapeId);
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* jsdom */ }
    setGesture({
      key: slotKey(slideIndex, shapeId), slideIndex, shapeId, handle,
      startBox, startPt: { x: e.clientX, y: e.clientY }, live: startBox, moved: false,
    });
  }

  function gestureMove(e: React.PointerEvent) {
    if (!gesture) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { dx, dy } = fromCanvasOffset(
      { x: e.clientX - gesture.startPt.x, y: e.clientY - gesture.startPt.y },
      extent, { w: rect.width, h: rect.height }
    );
    const moved = gesture.moved
      || Math.abs(e.clientX - gesture.startPt.x) > 3
      || Math.abs(e.clientY - gesture.startPt.y) > 3;
    const live = clampToExtent(applyGesture(gesture.handle, gesture.startBox, { dx, dy }, MIN_PCT), extent);
    setGesture({ ...gesture, live, moved });
  }

  function gestureEnd() {
    if (!gesture) return;
    if (gesture.moved) {
      const key = gesture.key;
      const committed = gesture.live;
      setHist((h) => pushState(h, {
        ...h.present, bboxOverrides: { ...h.present.bboxOverrides, [key]: committed },
      }));
      onMove?.(gesture.slideIndex, gesture.shapeId, committed);
    }
    setGesture(null);
  }
```

(d) Replace the entire shape-rendering `.map(...)` block (the `{[...slide.shapes].sort(...).map((s) => { ... motion.button ... })}`) with a pointer-driven `div`:

```tsx
        {[...slide.shapes]
          .sort((a, b) =>
            (b.bbox_pct.w * b.bbox_pct.h) - (a.bbox_pct.w * a.bbox_pct.h))
          .map((s) => {
          const key = slotKey(slideIdx, s.shape_id);
          const slot = hist.present.slots[key];
          const tagged = Boolean(slot?.id);
          const conf = s.confidence ?? (tagged ? 1 : 0);
          const liveBox = gesture?.key === key ? gesture.live : bboxFor(slideIdx, s.shape_id);
          const cv = toCanvasPct(liveBox, extent);
          const isOff = offSlideIds.has(slot?.id ?? "");

          let cls = shapeClass(tagged, conf, reduced);
          if (isOff) cls = "border-2 border-red-500 bg-red-500/10";
          const isSel = selected === key;

          return (
            <div
              key={s.shape_id}
              role="button"
              aria-label={`shape ${s.name}`}
              onClick={() => setSelected(key)}
              onPointerDown={(e) => gestureStart(e, slideIdx, s.shape_id, "move")}
              onPointerMove={gestureMove}
              onPointerUp={gestureEnd}
              className={`absolute ${cls} ${isSel ? "outline outline-2 outline-blue-600" : ""}`}
              style={{
                left: `${cv.x}%`, top: `${cv.y}%`, width: `${cv.w}%`, height: `${cv.h}%`,
                touchAction: "none",
              }}
            />
          );
        })}
```

(Resize handles are added inside this `div` in Task 4. `reduced` is still used by `shapeClass`; keep `useReducedMotion`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/tageditor.test.tsx tests/tageditor-layers.test.tsx tests/tagEditor-multislide.test.ts`
Expected: PASS (the rewritten move test + the unchanged selection/render/layers/multislide tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TagEditor.tsx web/tests/tageditor.test.tsx
git commit -m "fix(web): pointer-gesture block move, no drag-placement rebound"
```

---

## Task 4: TagEditor — 8 resize handles

**Files:**
- Modify: `web/src/components/TagEditor.tsx`
- Test: `web/tests/tageditor.test.tsx` (add a resize test)

**Interfaces:**
- Consumes: the Task 3 `gestureStart`/`gestureMove`/`gestureEnd` + `Handle`.
- Produces: 8 handle elements (aria-labels `resize nw|n|ne|e|se|s|sw|w`) rendered inside the selected block, each starting a resize gesture.

- [ ] **Step 1: Write the failing test**

Add to `web/tests/tageditor.test.tsx` (inside `describe("TagEditor", ...)`):

```tsx
  it("resizing the SE handle grows the box and reports onMove", () => {
    const onMove = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={onMove} />);
    const canvas = screen.getByTestId("slide-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} } as DOMRect
    );
    fireEvent.click(screen.getByRole("button", { name: /shape Title/ })); // select -> handles appear
    const se = screen.getByLabelText("resize se");
    fireEvent.pointerDown(se, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(se, { clientX: 64, clientY: 36, pointerId: 1 });
    fireEvent.pointerUp(se, { clientX: 64, clientY: 36, pointerId: 1 });
    expect(onMove).toHaveBeenCalled();
    const [, , bbox] = onMove.mock.calls.at(-1)!;
    expect(bbox.w).toBeGreaterThan(40); // grew from w=40
    expect(bbox.h).toBeGreaterThan(20); // grew from h=20
  });

  it("does not render resize handles until a block is selected", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={() => {}} />);
    expect(screen.queryByLabelText("resize se")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: FAIL — no `resize se` handle exists.

- [ ] **Step 3: Add the handle table + render handles in the selected block**

In `web/src/components/TagEditor.tsx`, add the handle table at module scope (next to `MIN_PCT`):

```tsx
const HANDLES: { h: Handle; style: React.CSSProperties }[] = [
  { h: "nw", style: { left: -4, top: -4, cursor: "nwse-resize" } },
  { h: "n", style: { left: "calc(50% - 4px)", top: -4, cursor: "ns-resize" } },
  { h: "ne", style: { right: -4, top: -4, cursor: "nesw-resize" } },
  { h: "e", style: { right: -4, top: "calc(50% - 4px)", cursor: "ew-resize" } },
  { h: "se", style: { right: -4, bottom: -4, cursor: "nwse-resize" } },
  { h: "s", style: { left: "calc(50% - 4px)", bottom: -4, cursor: "ns-resize" } },
  { h: "sw", style: { left: -4, bottom: -4, cursor: "nesw-resize" } },
  { h: "w", style: { left: -4, top: "calc(50% - 4px)", cursor: "ew-resize" } },
];
```

Then make the block `div` from Task 3 contain children — replace the self-closing block `div` (`... />`) with an open/close form that renders the handles when selected:

```tsx
            <div
              key={s.shape_id}
              role="button"
              aria-label={`shape ${s.name}`}
              onClick={() => setSelected(key)}
              onPointerDown={(e) => gestureStart(e, slideIdx, s.shape_id, "move")}
              onPointerMove={gestureMove}
              onPointerUp={gestureEnd}
              className={`absolute ${cls} ${isSel ? "outline outline-2 outline-blue-600" : ""}`}
              style={{
                left: `${cv.x}%`, top: `${cv.y}%`, width: `${cv.w}%`, height: `${cv.h}%`,
                touchAction: "none",
              }}
            >
              {isSel && onMove && HANDLES.map((hd) => (
                <span
                  key={hd.h}
                  aria-label={`resize ${hd.h}`}
                  onPointerDown={(e) => gestureStart(e, slideIdx, s.shape_id, hd.h)}
                  onPointerMove={gestureMove}
                  onPointerUp={gestureEnd}
                  className="absolute w-2 h-2 bg-blue-600 rounded-sm"
                  style={{ ...hd.style, touchAction: "none" }}
                />
              ))}
            </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: PASS (resize grows the box; handles hidden until selected; earlier tests still green).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TagEditor.tsx web/tests/tageditor.test.tsx
git commit -m "feat(web): 8 resize handles on the selected canvas block"
```

---

## Task 5: SlotPanel live char readout + "Use this"

**Files:**
- Modify: `web/src/components/SlotPanel.tsx`, `web/src/components/TagEditor.tsx`
- Test: `web/tests/slotpanel.test.tsx` (create)

**Interfaces:**
- Consumes: `estimateMaxChars` from `@/lib/charfit` (Task 1); the live bbox + shape `font_pt` + slide dims in TagEditor.
- Produces: `SlotPanel` gains `charEstimate?: number`; TagEditor computes it for the selected text shape and passes it.

- [ ] **Step 1: Write the failing test**

Create `web/tests/slotpanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SlotPanel } from "@/components/SlotPanel";

const base = { shape_id: 5, slideIndex: 0, id: "t", name: "T", constraints: {} as Record<string, number | string> };

describe("SlotPanel char estimate", () => {
  it("shows the estimate and Use this sets max_chars for a text slot", () => {
    const onChange = vi.fn();
    render(<SlotPanel slot={{ ...base, type: "text" }} charEstimate={123} onChange={onChange} />);
    expect(screen.getByText(/Fits ~123 chars/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use estimated max chars/i }));
    expect(onChange.mock.calls.at(-1)![0].constraints.max_chars).toBe(123);
  });

  it("shows no estimate for a non-text slot", () => {
    render(<SlotPanel slot={{ ...base, type: "image" }} charEstimate={123} onChange={() => {}} />);
    expect(screen.queryByText(/Fits ~/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/slotpanel.test.tsx`
Expected: FAIL — `charEstimate` prop / readout not implemented.

- [ ] **Step 3: Add the readout to SlotPanel**

In `web/src/components/SlotPanel.tsx`, change the component signature:

```tsx
export function SlotPanel({ slot, onChange, charEstimate }:
  { slot: DraftSlot; onChange: (s: DraftSlot) => void; charEstimate?: number }) {
```

Then replace the existing `{slot.type === "text" && ( ... )}` Max-chars block with a fragment that also renders the readout:

```tsx
      {slot.type === "text" && (
        <>
          <label className="block text-sm">Max chars
            <input aria-label="Max chars" type="number" className="w-full border p-1 rounded"
              value={slot.constraints.max_chars ?? ""}
              onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: Number(e.target.value) } })} />
          </label>
          {charEstimate != null && (
            <p className="text-xs text-gray-600">
              Fits ~{charEstimate} chars at this size{" "}
              <button type="button" aria-label="Use estimated max chars" className="underline text-blue-600"
                onClick={() => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: charEstimate } })}>
                Use this
              </button>
            </p>
          )}
        </>
      )}
```

- [ ] **Step 4: Compute + pass `charEstimate` from TagEditor**

In `web/src/components/TagEditor.tsx`:

(a) Add `font_pt?: number;` to the `Shape` type (append to its field list).

(b) Add the `estimateMaxChars` import:

```tsx
import { estimateMaxChars } from "@/lib/charfit";
```

(c) Replace the whole `{selected != null && (() => { ... })()}` block at the bottom with this version that computes the estimate from the live bbox and passes it on both render paths:

```tsx
        {selected != null && (() => {
          const [siStr, shStr] = selected.split(":");
          const si = Number(siStr); const shId = Number(shStr);
          const sh = slides[si]?.shapes.find((x) => x.shape_id === shId);
          const liveBox = gesture?.key === selected ? gesture.live : bboxFor(si, shId);
          const selSlot = hist.present.slots[selected];
          const type = (selSlot?.type ?? (sh?.type as DraftSlot["type"]) ?? "text");
          const estimate = type === "text"
            ? estimateMaxChars(
                liveBox.w, liveBox.h,
                slides[si]?.width_emu ?? 12192000, slides[si]?.height_emu ?? 6858000,
                sh?.font_pt,
              )
            : undefined;
          if (!selSlot) {
            return (
              <SlotPanel
                slot={{
                  shape_id: shId, slideIndex: si, id: "", name: sh?.name ?? "",
                  type: (sh?.type as DraftSlot["type"]) ?? "text", constraints: {},
                }}
                charEstimate={estimate}
                onChange={updateSlot}
              />
            );
          }
          return <SlotPanel slot={selSlot} charEstimate={estimate} onChange={updateSlot} />;
        })()}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/slotpanel.test.tsx tests/tageditor.test.tsx`
Expected: PASS (readout + Use this; non-text hides it; editor tests still green).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SlotPanel.tsx web/src/components/TagEditor.tsx web/tests/slotpanel.test.tsx
git commit -m "feat(web): live char-fit readout + Use this in SlotPanel"
```

---

## Self-Review

**Spec coverage:**
- 8-handle resize → Tasks 2 (math) + 4 (handles).
- Live "chars that fit" + "Use this" → Tasks 1 (estimate) + 5 (readout/wiring).
- Drop-rebound fix → Task 3 (pointer gesture replaces framer drag; position from committed left/top only).
- No engine/API change → confirmed; resize flows through existing `onMove`/`move_shapes`.
- Min floor `MIN_PCT=2`, clamp to extent, font fallback, text-only readout → Tasks 2/3/5.
- Testing (charfit, gesture, tageditor move+resize, slotpanel) → every task.
- Out of scope (rotation, aspect-lock, snap guides, multi-select, numeric inputs, engine math) → none added.

**Placeholder scan:** none — every step has complete code + exact commands.

**Type consistency:** `Handle` defined in Task 2, consumed in Tasks 3/4. `applyGesture(handle, start, {dx,dy}, minPct)` signature consistent. `estimateMaxChars(wPct,hPct,slideWemu,slideHemu,fontPt)` defined in Task 1, called in Task 5 with the live box + slide dims + `sh.font_pt`. `gesture` state shape (key/slideIndex/shapeId/handle/startBox/startPt/live/moved) defined in Task 3, read in Tasks 4/5 (`gesture?.key`, `gesture.live`). `SlotPanel` `charEstimate?: number` defined in Task 5 and passed by TagEditor. The block is `role="button"` with `aria-label="shape <name>"` so the existing `getByRole("button", {name:/shape Title/})` queries keep working after the `motion.button`→`div` change.
