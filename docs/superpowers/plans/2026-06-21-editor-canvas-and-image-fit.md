# Editor Canvas Correctness & Image Contain-Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a dragged editor box land and stay where dropped, let the canvas extend to hold intentionally-bleeding shapes (with a slide reference frame), make covered boxes reachable, and size agent images correctly (contain) inside their reserved spots.

**Architecture:** Geometry edits are batched and applied once at Save (not live per-drag). The engine gains a slide-aware batch move. The editor renders shapes in an extended canvas viewport computed from the union of the slide and all shape bboxes, fixes framer-motion drag math, paints large boxes under small ones, and adds a layer list. The render engine fills image slots with an aspect-preserving "contain" fit.

**Tech Stack:** Python 3.11 / python-pptx / Pillow / FastAPI (engine + engine-service); Next.js 14 / React 18 / framer-motion / TypeScript / vitest + @testing-library/react (web); pytest (engine).

## Global Constraints

- Units: bbox values are slide-percent floats in `[0,100]`; EMU conversion is `int(slide_dim_emu * pct / 100.0)` (matches existing `move.py`). 1pt = 12700 EMU.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- vitest only collects `web/tests/**/*.test.{ts,tsx}`; Playwright specs live in `web/e2e/` and must not be imported by vitest.
- Engine tests live in `engine/tests/`; service tests in `engine-service/tests/`.
- Off-slide placement is **allowed** (intentional bleed). Off-slide tagged slots are a **soft amber warning**, never a hard block.
- The editable-canvas clamp is to the **canvas extent**, not the slide.
- Image fit: `None`/`"contain"` → contain; `"cover"` falls back to contain (deferred). Never crash on bad image/box — fall back to the box rect.
- `engine/src/pptx_mcp/move.py` `move_shape` must stay backward-compatible (existing tests call `move_shape(bytes, shape_id, bbox)`).
- The `Move` shape is identical on the web and engine sides: `{ slide_index, shape_id, bbox_pct: { x, y, w, h } }` (pass-through, no translation layer).

---

### Task 1: Engine slide-aware batch move

**Files:**
- Modify: `engine/src/pptx_mcp/move.py`
- Test: `engine/tests/test_move.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `move_shapes(pptx_bytes: bytes, moves: list[dict]) -> bytes` where each move is `{"slide_index": int, "shape_id": int, "bbox_pct": {"x","y","w","h"}}`. Raises `KeyError` if `slide_index` is out of range or the `shape_id` is absent on that slide.
  - `move_shape(pptx_bytes: bytes, shape_id: int, bbox_pct: dict, slide_index: int | None = None) -> bytes` (added optional `slide_index`; `None` keeps current first-match behavior).

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_move.py`:

```python
def _two_slide_deck() -> bytes:
    """Two blank slides, each with one textbox. On a blank layout the first
    added shape gets shape_id=2 on both slides -> the cross-slide collision we
    must handle."""
    prs = Presentation()
    blank = prs.slide_layouts[6]
    for _ in range(2):
        s = prs.slides.add_slide(blank)
        s.shapes.add_textbox(0, 0, 914400, 914400)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def test_move_shapes_targets_correct_slide():
    from pptx_mcp.move import move_shapes
    data = _two_slide_deck()
    prs = Presentation(io.BytesIO(data))
    sid1 = prs.slides[1].shapes[0].shape_id
    out = move_shapes(data, [
        {"slide_index": 1, "shape_id": sid1,
         "bbox_pct": {"x": 50, "y": 50, "w": 20, "h": 10}},
    ])
    prs2 = Presentation(io.BytesIO(out))
    sw, sh = prs2.slide_width, prs2.slide_height
    s1 = prs2.slides[1].shapes[0]
    assert abs(s1.left - sw * 0.50) < 5000
    assert abs(s1.top - sh * 0.50) < 5000
    # Slide 0's same-id shape is untouched (still at origin).
    assert prs2.slides[0].shapes[0].left == 0


def test_move_shapes_applies_batch():
    from pptx_mcp.move import move_shapes
    data = _two_slide_deck()
    prs = Presentation(io.BytesIO(data))
    sid0 = prs.slides[0].shapes[0].shape_id
    sid1 = prs.slides[1].shapes[0].shape_id
    out = move_shapes(data, [
        {"slide_index": 0, "shape_id": sid0, "bbox_pct": {"x": 10, "y": 10, "w": 30, "h": 15}},
        {"slide_index": 1, "shape_id": sid1, "bbox_pct": {"x": 60, "y": 20, "w": 30, "h": 15}},
    ])
    prs2 = Presentation(io.BytesIO(out))
    sw = prs2.slide_width
    assert abs(prs2.slides[0].shapes[0].left - sw * 0.10) < 5000
    assert abs(prs2.slides[1].shapes[0].left - sw * 0.60) < 5000


def test_move_shapes_unknown_raises():
    import pytest
    from pptx_mcp.move import move_shapes
    data = _two_slide_deck()
    with pytest.raises(KeyError):
        move_shapes(data, [{"slide_index": 5, "shape_id": 2,
                            "bbox_pct": {"x": 1, "y": 1, "w": 1, "h": 1}}])


def test_move_shape_slide_index_scopes_search():
    data = _two_slide_deck()
    prs = Presentation(io.BytesIO(data))
    sid = prs.slides[1].shapes[0].shape_id
    out = move_shape(data, sid, {"x": 40, "y": 0, "w": 20, "h": 10}, slide_index=1)
    prs2 = Presentation(io.BytesIO(out))
    sw = prs2.slide_width
    assert abs(prs2.slides[1].shapes[0].left - sw * 0.40) < 5000
    assert prs2.slides[0].shapes[0].left == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && python -m pytest tests/test_move.py -v`
Expected: FAIL — `move_shapes` not defined; `move_shape() got an unexpected keyword argument 'slide_index'`.

- [ ] **Step 3: Implement**

Replace the body of `engine/src/pptx_mcp/move.py` with:

```python
import io

from pptx import Presentation


def move_shape(pptx_bytes: bytes, shape_id: int, bbox_pct: dict,
               slide_index: int | None = None) -> bytes:
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    for i, slide in enumerate(prs.slides):
        if slide_index is not None and i != slide_index:
            continue
        for shp in slide.shapes:
            if shp.shape_id == shape_id:
                shp.left = int(sw * bbox_pct["x"] / 100.0)
                shp.top = int(sh * bbox_pct["y"] / 100.0)
                shp.width = int(sw * bbox_pct["w"] / 100.0)
                shp.height = int(sh * bbox_pct["h"] / 100.0)
                buf = io.BytesIO()
                prs.save(buf)
                return buf.getvalue()
    raise KeyError(f"shape_id {shape_id} not found")


def move_shapes(pptx_bytes: bytes, moves: list[dict]) -> bytes:
    """Apply many moves in one pass. Each move is
    {slide_index, shape_id, bbox_pct:{x,y,w,h}} with bbox in slide-percent."""
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    slides = list(prs.slides)
    for m in moves:
        si = m["slide_index"]
        if not (0 <= si < len(slides)):
            raise KeyError(f"slide_index {si} out of range")
        shp = next((s for s in slides[si].shapes if s.shape_id == m["shape_id"]), None)
        if shp is None:
            raise KeyError(f"shape_id {m['shape_id']} not found on slide {si}")
        b = m["bbox_pct"]
        shp.left = int(sw * b["x"] / 100.0)
        shp.top = int(sh * b["y"] / 100.0)
        shp.width = int(sw * b["w"] / 100.0)
        shp.height = int(sh * b["h"] / 100.0)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_move.py -v`
Expected: PASS (all move tests, including the pre-existing `test_move_shape_repositions`).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/move.py engine/tests/test_move.py
git commit -m "feat(engine): slide-aware move_shape + batch move_shapes"
```

---

### Task 2: engine-service `/move-shapes` route + web `moveShapes` client

**Files:**
- Modify: `engine-service/app.py`
- Modify: `web/src/lib/engine.ts`
- Test: `engine-service/tests/test_endpoints.py`
- Test: `web/tests/engine.test.ts`

**Interfaces:**
- Consumes: `move_shapes` (Task 1).
- Produces:
  - `POST /move-shapes` (multipart `file` + `moves` JSON array) → `.pptx` bytes.
  - Web `moveShapes(pptx: Buffer, moves: Move[]): Promise<Buffer>` and exported `type Move = { slide_index: number; shape_id: number; bbox_pct: { x: number; y: number; w: number; h: number } }`.

- [ ] **Step 1: Write the failing service test**

Append to `engine-service/tests/test_endpoints.py`:

```python
def test_move_shapes_endpoint():
    import io
    from pptx import Presentation

    def _two_slide_deck() -> bytes:
        prs = Presentation()
        blank = prs.slide_layouts[6]
        for _ in range(2):
            s = prs.slides.add_slide(blank)
            s.shapes.add_textbox(0, 0, 914400, 914400)
        buf = io.BytesIO()
        prs.save(buf)
        return buf.getvalue()

    data = _two_slide_deck()
    sid = Presentation(io.BytesIO(data)).slides[1].shapes[0].shape_id
    moves = [{"slide_index": 1, "shape_id": sid,
              "bbox_pct": {"x": 50, "y": 50, "w": 20, "h": 10}}]
    r = client.post("/move-shapes",
                    files={"file": ("d.pptx", data)},
                    data={"moves": json.dumps(moves)})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py::test_move_shapes_endpoint -v`
Expected: FAIL — 404/405 (route not defined).

- [ ] **Step 3: Implement the route**

In `engine-service/app.py`, change the import line:

```python
from pptx_mcp.move import move_shape, move_shapes
```

and add after the existing `/move-shape` route:

```python
@app.post("/move-shapes")
async def move_many(file: UploadFile = File(...), moves: str = Form(...)):
    out = move_shapes(await file.read(), json.loads(moves))
    return Response(content=out, media_type=_PPTX)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing web client test**

Append to `web/tests/engine.test.ts` (follow the file's existing fetch-mock style; if the file mocks `global.fetch`, reuse that). Add:

```ts
it("moveShapes posts moves and returns bytes", async () => {
  const spy = vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(new Uint8Array([0x50, 0x4b]), { status: 200 }) as any
  );
  const { moveShapes } = await import("@/lib/engine");
  const out = await moveShapes(Buffer.from("PK"), [
    { slide_index: 1, shape_id: 5, bbox_pct: { x: 10, y: 10, w: 20, h: 10 } },
  ]);
  expect(out).toBeInstanceOf(Buffer);
  const url = (spy.mock.calls[0][0] as string);
  expect(url).toContain("/move-shapes");
  spy.mockRestore();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd web && npx vitest run tests/engine.test.ts`
Expected: FAIL — `moveShapes` is not exported.

- [ ] **Step 7: Implement the client**

In `web/src/lib/engine.ts`, add near the other exports:

```ts
export type Move = {
  slide_index: number;
  shape_id: number;
  bbox_pct: { x: number; y: number; w: number; h: number };
};

export async function moveShapes(pptx: Buffer, moves: Move[]): Promise<Buffer> {
  const r = await fetch(`${BASE}/move-shapes`, {
    method: "POST",
    body: form(pptx, { moves: JSON.stringify(moves) }),
  });
  if (!r.ok) throw new EngineError("move-shapes failed");
  return Buffer.from(await r.arrayBuffer());
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd web && npx vitest run tests/engine.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add engine-service/app.py engine-service/tests/test_endpoints.py web/src/lib/engine.ts web/tests/engine.test.ts
git commit -m "feat: /move-shapes endpoint + moveShapes client"
```

---

### Task 3: Canvas viewport helpers (pure module)

**Files:**
- Create: `web/src/lib/canvasView.ts`
- Test: `web/tests/canvasView.test.ts`

**Interfaces:**
- Consumes: `type Box` from `@/lib/placement`.
- Produces:
  - `type Extent = { minX: number; minY: number; maxX: number; maxY: number }`
  - `canvasExtent(boxes: Box[], margin?: number): Extent` (default margin 2)
  - `rangeX(e): number`, `rangeY(e): number`
  - `toCanvasPct(b: Box, e: Extent): Box`
  - `fromCanvasOffset(offsetPx: {x:number;y:number}, e: Extent, rectPx: {w:number;h:number}): {dx:number; dy:number}`
  - `clampToExtent(b: Box, e: Extent): Box`

- [ ] **Step 1: Write the failing test**

Create `web/tests/canvasView.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  canvasExtent, toCanvasPct, fromCanvasOffset, clampToExtent, rangeX, rangeY,
} from "@/lib/canvasView";

describe("canvasView", () => {
  it("slide-only set yields ~0..100 plus margin", () => {
    const e = canvasExtent([], 2);
    expect(e).toEqual({ minX: -2, minY: -2, maxX: 102, maxY: 102 });
    expect(rangeX(e)).toBe(104);
    expect(rangeY(e)).toBe(104);
  });

  it("extends below 0 and above 100 for bleed shapes", () => {
    const e = canvasExtent(
      [{ x: -10, y: 5, w: 30, h: 10 }, { x: 90, y: 0, w: 25, h: 10 }], 0
    );
    expect(e.minX).toBe(-10);
    expect(e.maxX).toBe(115); // 90 + 25
    expect(e.minY).toBe(0);
    expect(e.maxY).toBe(100);
  });

  it("toCanvasPct maps a slide box into the extent", () => {
    const e = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    expect(toCanvasPct({ x: 100, y: 0, w: 50, h: 50 }, e)).toEqual({
      x: 50, y: 0, w: 25, h: 50,
    });
  });

  it("fromCanvasOffset converts px delta to slide-% delta via extent", () => {
    const e = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const { dx, dy } = fromCanvasOffset({ x: 320, y: 50 }, e, { w: 640, h: 360 });
    expect(dx).toBeCloseTo(100); // half the width * rangeX(200)
    expect(dy).toBeCloseTo(13.888, 2);
  });

  it("clampToExtent allows off-slide but not off-canvas", () => {
    const e = { minX: -10, minY: -10, maxX: 110, maxY: 110 };
    // off-slide negative is allowed (>= minX)
    expect(clampToExtent({ x: -5, y: 0, w: 20, h: 10 }, e).x).toBe(-5);
    // beyond canvas is pulled back so x+w <= maxX
    expect(clampToExtent({ x: 200, y: 0, w: 20, h: 10 }, e).x).toBe(90);
    expect(clampToExtent({ x: -100, y: 0, w: 20, h: 10 }, e).x).toBe(-10);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run tests/canvasView.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web/src/lib/canvasView.ts`:

```ts
import type { Box } from "./placement";

export type Extent = { minX: number; minY: number; maxX: number; maxY: number };

/** Union of the slide rect (0,0,100,100) and every box, padded by margin %. */
export function canvasExtent(boxes: Box[], margin = 2): Extent {
  let minX = 0, minY = 0, maxX = 100, maxY = 100;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

export const rangeX = (e: Extent) => e.maxX - e.minX;
export const rangeY = (e: Extent) => e.maxY - e.minY;

/** Slide-% box -> canvas-% box (position within the extended viewport). */
export function toCanvasPct(b: Box, e: Extent): Box {
  return {
    x: ((b.x - e.minX) / rangeX(e)) * 100,
    y: ((b.y - e.minY) / rangeY(e)) * 100,
    w: (b.w / rangeX(e)) * 100,
    h: (b.h / rangeY(e)) * 100,
  };
}

/** Pixel drag delta -> slide-% delta, accounting for the extent zoom. */
export function fromCanvasOffset(
  offsetPx: { x: number; y: number },
  e: Extent,
  rectPx: { w: number; h: number }
): { dx: number; dy: number } {
  return {
    dx: (offsetPx.x / rectPx.w) * rangeX(e),
    dy: (offsetPx.y / rectPx.h) * rangeY(e),
  };
}

/** Keep a box inside the canvas extent (off-slide allowed, off-canvas not). */
export function clampToExtent(b: Box, e: Extent): Box {
  return {
    ...b,
    x: Math.min(Math.max(b.x, e.minX), e.maxX - b.w),
    y: Math.min(Math.max(b.y, e.minY), e.maxY - b.h),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run tests/canvasView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/canvasView.ts web/tests/canvasView.test.ts
git commit -m "feat(web): canvas extent + coordinate-mapping helpers"
```

---

### Task 4: TagEditor extended viewport + drag correctness

**Files:**
- Modify: `web/src/components/TagEditor.tsx`
- Modify: `web/src/app/(app)/templates/[id]/edit/EditClient.tsx` (onMove signature + record moves locally; remove live fetch)
- Test: `web/tests/tageditor.test.tsx`

**Interfaces:**
- Consumes: `canvasExtent`, `toCanvasPct`, `fromCanvasOffset`, `clampToExtent`, `rangeX`, `rangeY` (Task 3); `type Move` (Task 2).
- Produces: `TagEditor` prop `onMove?: (slideIndex: number, shapeId: number, bbox: Box) => void`. EditClient records moves into a `moves` map (consumed by Task 6). Drag updates local overrides only; no fetch on drag.

> Note: this task changes only drag math, the viewport, and the `onMove` signature. Z-order and the layer list come in Task 5; the Save payload + route come in Task 6. Between Task 4 and Task 6, recorded moves are held in state but not yet sent — that is expected and compiles.

- [ ] **Step 1: Write the failing test**

Replace `web/tests/tageditor.test.tsx` with:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagEditor, slotKey } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [{ shape_id: 5, name: "Title", type: "text",
             bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }],
}];

describe("TagEditor", () => {
  it("renders an overlay box per shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
  });

  it("clips the slide canvas so off-slide shapes can't overlap controls below", () => {
    const bleed = [{
      index: 0, width_emu: 100, height_emu: 100,
      shapes: [{ shape_id: 7, name: "Freeform 7", type: "image",
                 bbox_pct: { x: -20, y: 80, w: 140, h: 40 } }],
    }];
    render(<TagEditor slides={bleed} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByTestId("slide-canvas").className).toContain("overflow-hidden");
  });

  it("renders a non-interactive slide frame", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByTestId("slide-frame")).toBeInTheDocument();
  });

  it("selecting a shape lets you set a slot id", () => {
    const onChange = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    fireEvent.change(screen.getByLabelText("Slot id"), { target: { value: "title" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last[slotKey(0, 5)].id).toBe("title");
  });

  it("drag reports onMove(slideIndex, shapeId, bbox) and fires no fetch", () => {
    const onMove = vi.fn();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}") as any);
    render(
      <TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={onMove} />
    );
    const canvas = screen.getByTestId("slide-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} } as DOMRect
    );
    const box = screen.getByRole("button", { name: /Title/ });
    // framer-motion drag: pointer down on the box, move, up.
    fireEvent.pointerDown(box, { clientX: 0, clientY: 0, buttons: 1 });
    fireEvent.pointerMove(box, { clientX: 64, clientY: 36, buttons: 1 });
    fireEvent.pointerUp(box, { clientX: 64, clientY: 36 });
    expect(onMove).toHaveBeenCalled();
    const [si, sid, bbox] = onMove.mock.calls.at(-1)!;
    expect(si).toBe(0);
    expect(sid).toBe(5);
    expect(bbox.x).toBeGreaterThan(10); // moved right from x=10
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: FAIL — no `slide-frame` testid; drag `onMove` arity/behavior mismatch.

> If framer-motion's `onDragEnd` does not fire under jsdom from synthetic pointer events, keep the assertions intact and drive the drag through the gesture framer recognizes (pointer events with `buttons: 1` and a sufficient move distance). Do **not** weaken the assertions (no fetch; correct arity; moved right). The implementation in Step 3 is correct against a real browser drag.

- [ ] **Step 3: Implement**

Replace `web/src/components/TagEditor.tsx` with:

```tsx
"use client";
import { motion, useReducedMotion, type PanInfo } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";
import { placementIssues, type Box } from "@/lib/placement";
import {
  canvasExtent, toCanvasPct, fromCanvasOffset, clampToExtent, rangeX, rangeY,
  type Extent,
} from "@/lib/canvasView";
import {
  initHistory, pushState, undo, redo, canUndo, canRedo,
  type History,
} from "@/lib/editorHistory";

type Shape = {
  shape_id: number; name: string; type: string;
  bbox_pct: { x: number; y: number; w: number; h: number };
  confidence?: number; is_candidate?: boolean;
  suggested_id?: string; suggested_max_chars?: number;
  suggested_max_lines?: number;
  suggested_max_rows?: number; suggested_max_cols?: number;
};
type Slide = { index: number; shapes: Shape[] };
type Slots = Record<string, DraftSlot>;

export type PlacementIssues = { offSlide: string[]; overlapping: [string, string][] };

type EditorState = { slots: Slots; bboxOverrides: Record<string, Box> };

/** Composite key unique across the deck: "${slideIndex}:${shapeId}". */
export function slotKey(slideIndex: number, shapeId: number): string {
  return `${slideIndex}:${shapeId}`;
}

function shapeClass(tagged: boolean, conf: number, reduced: boolean | null): string {
  if (!tagged) return "border border-dashed border-neutral-300/40 bg-transparent";
  if (conf >= 0.75) return "border-2 border-matcha-500 bg-matcha-500/10";
  return `border-2 border-dashed border-amber-500 bg-amber-500/10${reduced ? "" : " animate-pulse"}`;
}

export function buildInitialSlots(slides: Slide[]): Slots {
  const slots: Slots = {};
  for (const slide of slides) {
    for (const s of slide.shapes) {
      if (s.is_candidate) {
        const key = slotKey(slide.index, s.shape_id);
        const constraints: Record<string, number | string> = {};
        if (s.suggested_max_chars) constraints.max_chars = s.suggested_max_chars;
        if (s.suggested_max_lines) constraints.max_lines = s.suggested_max_lines;
        if (s.suggested_max_rows) constraints.max_rows = s.suggested_max_rows;
        if (s.suggested_max_cols) constraints.max_cols = s.suggested_max_cols;
        slots[key] = {
          shape_id: s.shape_id, slideIndex: slide.index,
          id: s.suggested_id ?? "", name: s.name,
          type: (s.type as DraftSlot["type"]) ?? "text", constraints,
        };
      }
    }
  }
  return slots;
}

export function TagEditor({
  slides, previewUrls, onChange, onMove, onIssues,
}: {
  slides: Slide[];
  previewUrls: string[];
  onChange: (s: Slots) => void;
  onMove?: (slideIndex: number, shapeId: number, bbox: Box) => void;
  onIssues?: (issues: PlacementIssues) => void;
}) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const [hist, setHist] = useState<History<EditorState>>(() =>
    initHistory({ slots: buildInitialSlots(slides), bboxOverrides: {} })
  );

  useEffect(() => {
    onChange(hist.present.slots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist.present.slots]);

  const slide = slides[slideIdx];

  function bboxFor(slideIndex: number, shapeId: number): Box {
    const key = slotKey(slideIndex, shapeId);
    if (hist.present.bboxOverrides[key]) return hist.present.bboxOverrides[key];
    const shape = slides[slideIndex]?.shapes.find((sh) => sh.shape_id === shapeId);
    return shape?.bbox_pct ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  // Extended viewport for the current slide: union of slide + all shapes.
  const extent: Extent = useMemo(
    () => canvasExtent(slide.shapes.map((s) => bboxFor(slideIdx, s.shape_id)), 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slide, slideIdx, hist.present.bboxOverrides]
  );

  const issues = useMemo<PlacementIssues>(
    () =>
      placementIssues(
        Object.values(hist.present.slots)
          .filter((s) => s.id)
          .map((s) => ({ id: s.id, box: bboxFor(s.slideIndex, s.shape_id) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hist.present]
  );

  useEffect(() => { onIssues?.(issues); }, [issues, onIssues]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault(); setHist((h) => undo(h));
      }
      if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault(); setHist((h) => redo(h));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function updateSlot(slot: DraftSlot) {
    const key = slotKey(slot.slideIndex, slot.shape_id);
    setHist((h) => pushState(h, { ...h.present, slots: { ...h.present.slots, [key]: slot } }));
  }

  function handleDragEnd(slideIndex: number, shapeId: number, info: PanInfo) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !onMove) return;
    const { dx, dy } = fromCanvasOffset(
      { x: info.offset.x, y: info.offset.y }, extent, { w: rect.width, h: rect.height }
    );
    const existing = bboxFor(slideIndex, shapeId);
    const moved = clampToExtent({ ...existing, x: existing.x + dx, y: existing.y + dy }, extent);
    const key = slotKey(slideIndex, shapeId);
    setHist((h) => pushState(h, {
      ...h.present, bboxOverrides: { ...h.present.bboxOverrides, [key]: moved },
    }));
    onMove(slideIndex, shapeId, moved);
  }

  const offSlideIds = new Set(issues.offSlide);
  const frame = toCanvasPct({ x: 0, y: 0, w: 100, h: 100 }, extent);

  return (
    <div className="flex gap-6">
      {/* overflow-hidden clips off-canvas shapes so they can't intercept
          clicks over controls below. Canvas aspect follows the extent. */}
      <div
        ref={containerRef}
        data-testid="slide-canvas"
        className="relative w-[640px] bg-gray-100 overflow-hidden"
        style={{ height: `${(640 * rangeY(extent)) / rangeX(extent)}px` }}
      >
        {/* slide reference frame */}
        <div
          data-testid="slide-frame"
          className="absolute border-2 border-neutral-400/70 pointer-events-none"
          style={{ left: `${frame.x}%`, top: `${frame.y}%`, width: `${frame.w}%`, height: `${frame.h}%` }}
        >
          {previewUrls[slideIdx] && (
            <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />
          )}
        </div>

        {slide.shapes.map((s) => {
          const key = slotKey(slideIdx, s.shape_id);
          const slot = hist.present.slots[key];
          const tagged = Boolean(slot?.id);
          const conf = s.confidence ?? (tagged ? 1 : 0);
          const cv = toCanvasPct(bboxFor(slideIdx, s.shape_id), extent);
          const isOff = offSlideIds.has(slot?.id ?? "");

          let cls = shapeClass(tagged, conf, reduced);
          if (isOff) cls = "border-2 border-red-500 bg-red-500/10";

          return (
            <motion.button
              key={s.shape_id}
              aria-label={`shape ${s.name}`}
              onClick={() => setSelected(key)}
              drag={!!onMove}
              dragMomentum={false}
              dragSnapToOrigin
              onDragEnd={(_e, info) => handleDragEnd(slideIdx, s.shape_id, info)}
              whileHover={reduced ? undefined : { scale: 1.02 }}
              animate={selected === key ? { borderColor: "#2563eb" } : undefined}
              className={`absolute ${cls}`}
              style={{ left: `${cv.x}%`, top: `${cv.y}%`, width: `${cv.w}%`, height: `${cv.h}%` }}
            />
          );
        })}
      </div>

      <div className="w-72 space-y-3">
        <div className="flex gap-2">
          <button aria-label="Undo" disabled={!canUndo(hist)}
            onClick={() => setHist((h) => undo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40">↩ Undo</button>
          <button aria-label="Redo" disabled={!canRedo(hist)}
            onClick={() => setHist((h) => redo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40">Redo ↪</button>
        </div>
        <div className="flex gap-2">
          {slides.map((s, i) => (
            <button key={i} onClick={() => setSlideIdx(i)}
              className={`px-2 py-1 border rounded ${i === slideIdx ? "bg-black text-white" : ""}`}>
              {i + 1}
            </button>
          ))}
        </div>
        {selected != null && (() => {
          const selSlot = hist.present.slots[selected];
          if (!selSlot) {
            const [siStr, shStr] = selected.split(":");
            const si = Number(siStr); const shId = Number(shStr);
            const sh = slides[si]?.shapes.find((x) => x.shape_id === shId);
            return (
              <SlotPanel
                slot={{
                  shape_id: shId, slideIndex: si, id: "", name: sh?.name ?? "",
                  type: (sh?.type as DraftSlot["type"]) ?? "text", constraints: {},
                }}
                onChange={updateSlot}
              />
            );
          }
          return <SlotPanel slot={selSlot} onChange={updateSlot} />;
        })()}
      </div>
    </div>
  );
}
```

Update `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`:

Replace the existing `async function onMove(...)` block (currently at `web/src/app/(app)/templates/[id]/edit/EditClient.tsx:22-27`) with local recording:

```tsx
  const [moves, setMoves] = useState<Record<string, { slide_index: number; shape_id: number; bbox_pct: { x: number; y: number; w: number; h: number } }>>({});

  function onMove(slideIndex: number, shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    setMoves((m) => ({ ...m, [`${slideIndex}:${shapeId}`]: { slide_index: slideIndex, shape_id: shapeId, bbox_pct: bbox } }));
  }
```

(Keep `<TagEditor ... onMove={onMove} />`. `moves` is consumed in Task 6.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run tests/tageditor.test.tsx tests/tagEditor-multislide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TagEditor.tsx "web/src/app/(app)/templates/[id]/edit/EditClient.tsx" web/tests/tageditor.test.tsx
git commit -m "feat(web): extended canvas viewport + correct drag (offset+snap+clamp)"
```

---

### Task 5: Z-order + layer list

**Files:**
- Modify: `web/src/components/TagEditor.tsx`
- Test: `web/tests/tageditor-layers.test.tsx`

**Interfaces:**
- Consumes: TagEditor from Task 4.
- Produces: shapes render area-descending (large first); a layer-list panel with one `button` per shape (`aria-label={`layer ${name}`}`) that selects the shape.

- [ ] **Step 1: Write the failing test**

Create `web/tests/tageditor-layers.test.tsx`:

```tsx
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TagEditor } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [
    { shape_id: 1, name: "Big", type: "image", bbox_pct: { x: 0, y: 0, w: 100, h: 100 } },
    { shape_id: 2, name: "Small", type: "text", bbox_pct: { x: 40, y: 40, w: 10, h: 10 } },
  ],
}];

describe("TagEditor layers", () => {
  it("paints larger shapes before smaller ones (small on top)", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    const canvas = screen.getByTestId("slide-canvas");
    const boxes = within(canvas).getAllByRole("button");
    // First painted (lower in DOM/stack) is the big one.
    expect(boxes[0].getAttribute("aria-label")).toContain("Big");
    expect(boxes[1].getAttribute("aria-label")).toContain("Small");
  });

  it("layer list selects a covered shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "layer Small" }));
    // Selecting reveals the SlotPanel; its Slot id input is present.
    expect(screen.getByLabelText("Slot id")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run tests/tageditor-layers.test.tsx`
Expected: FAIL — no `layer Small` button; paint order is document order, not area order.

- [ ] **Step 3: Implement**

In `web/src/components/TagEditor.tsx`, render shapes in area-descending order. Replace the canvas map opener `{slide.shapes.map((s) => {` with a sorted copy:

```tsx
        {[...slide.shapes]
          .sort((a, b) =>
            (b.bbox_pct.w * b.bbox_pct.h) - (a.bbox_pct.w * a.bbox_pct.h))
          .map((s) => {
```

(the map body is unchanged).

Add a layer list in the sidebar: insert it after the slide-number `<div className="flex gap-2"> ... </div>` and before the `{selected != null && ...}` block:

```tsx
        <div className="border rounded p-2 space-y-1 max-h-48 overflow-auto">
          <p className="text-xs font-medium text-neutral-500">Layers</p>
          {slide.shapes.map((s) => {
            const key = slotKey(slideIdx, s.shape_id);
            const tagged = Boolean(hist.present.slots[key]?.id);
            return (
              <button
                key={s.shape_id}
                aria-label={`layer ${s.name}`}
                onClick={() => setSelected(key)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm rounded hover:bg-neutral-100 ${selected === key ? "bg-neutral-100" : ""}`}
              >
                <span className={`inline-block w-2 h-2 rounded-full ${tagged ? "bg-matcha-500" : "bg-neutral-300"}`} />
                <span className="truncate">{s.name}</span>
              </button>
            );
          })}
        </div>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run tests/tageditor-layers.test.tsx tests/tageditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TagEditor.tsx web/tests/tageditor-layers.test.tsx
git commit -m "feat(web): area z-order + layer list to reach covered boxes"
```

---

### Task 6: Save batching + off-slide soft-warn

**Files:**
- Modify: `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`
- Modify: `web/src/app/api/templates/[id]/route.ts`
- Test: `web/tests/templates-save.test.ts`

**Interfaces:**
- Consumes: `moves` state (Task 4); `moveShapes` (Task 2); `getObject/putObject` (`@/lib/s3`), `renderBasePreviews` (`@/lib/engine`).
- Produces: PUT body may include `moves: Move[]`; the route applies them, re-renders previews once, and persists `draft.slides[*].bbox_pct` (slide-correct) + `draft.previewKeys`.

- [ ] **Step 1: Write the failing test**

Append to `web/tests/templates-save.test.ts` (match its existing mock setup). Add:

```ts
it("applies batched moves and re-renders previews on save", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1" } })) }));
  vi.doMock("@/lib/prisma", () => ({
    prisma: { template: {
      findUnique: vi.fn(async () => ({ id: "t1", ownerId: "u1", basePptxKey: "base.pptx", manifestJson: { draft: { slides: [{ index: 0, shapes: [{ shape_id: 5, bbox_pct: { x: 0, y: 0, w: 10, h: 10 } }] }] } } })),
      update: vi.fn(async () => ({})),
    } },
  }));
  const moveShapes = vi.fn(async () => Buffer.from("PK2"));
  const renderBasePreviews = vi.fn(async () => ({ previews: ["aGk="] }));
  vi.doMock("@/lib/engine", () => ({ moveShapes, renderBasePreviews, EngineError: class extends Error {} }));
  const putObject = vi.fn(async (k: string) => k);
  vi.doMock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")), putObject }));

  const { PUT } = await import("@/app/api/templates/[id]/route");
  const body = {
    name: "T", slideTypes: [],
    moves: [{ slide_index: 0, shape_id: 5, bbox_pct: { x: 50, y: 50, w: 10, h: 10 } }],
  };
  const req = new Request("http://x", { method: "PUT", body: JSON.stringify(body) });
  const res = await PUT(req, { params: Promise.resolve({ id: "t1" }) });
  expect(res.status).toBe(200);
  expect(moveShapes).toHaveBeenCalledOnce();
  expect(renderBasePreviews).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: FAIL — `moveShapes`/`renderBasePreviews` never called (route ignores `moves`).

- [ ] **Step 3: Implement the route**

In `web/src/app/api/templates/[id]/route.ts`, add imports at top (below the existing imports):

```ts
import { getObject, putObject } from "@/lib/s3";
import { moveShapes, renderBasePreviews } from "@/lib/engine";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
```

In `PUT`, change the destructure line to include `moves`:

```ts
  const { name, description, visibility, slideTypes, moves } = await req.json();
```

Immediately after the `slide_types` mapping + the slot-id validation loop (before building `manifestJson`), insert the batch block:

```ts
  // Carry the existing draft forward; geometry edits update it in place.
  const draft = (tpl.manifestJson as any).draft ?? {};
  if (Array.isArray(moves) && moves.length > 0) {
    const base = await getObject(tpl.basePptxKey);
    const moved = await moveShapes(base, moves);
    await putObject(tpl.basePptxKey, moved, PPTX);

    const { previews } = await renderBasePreviews(moved);
    if (previews.length) {
      const previewKeys: string[] = [];
      for (let i = 0; i < previews.length; i++) {
        const key = `templates/${id}/preview-${i}.png`;
        await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
        previewKeys.push(key);
      }
      draft.previewKeys = previewKeys;
    }
    for (const mv of moves) {
      const slide = (draft.slides ?? []).find((s: any) => s.index === mv.slide_index);
      const sh = slide?.shapes?.find((x: any) => x.shape_id === mv.shape_id);
      if (sh) sh.bbox_pct = mv.bbox_pct;
    }
  }
```

Then add `draft` to the persisted manifest object:

```ts
  const manifestJson = {
    ...(tpl.manifestJson as object),
    template: { id, name: name ?? tpl.name, description: description ?? tpl.description },
    slide_types,
    draft,
  };
```

- [ ] **Step 4: Wire EditClient.save to send moves and downgrade off-slide**

In `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`:

(a) Delete the off-slide hard-block in `save()`:

```tsx
    // Hard-block: any slot off-slide
    if (issues.offSlide.length > 0) {
      setSaveErr(
        `Move these slots back on-slide before saving: ${issues.offSlide.join(", ")}`
      );
      return;
    }
```

(b) Replace the overlap-warning block with a combined soft warning:

```tsx
    const warnings: string[] = [];
    if (issues.offSlide.length > 0)
      warnings.push(`Off-slide (intentional bleed?): ${issues.offSlide.join(", ")}`);
    if (issues.overlapping.length > 0)
      warnings.push(`Overlapping: ${issues.overlapping.map((p) => p.join("+")).join(", ")}`);
    if (warnings.length) setOverlapWarn(warnings.join(" · "));
```

(c) Include `moves` in the PUT body:

```tsx
      const res = await fetch(`/api/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, slideTypes, moves: Object.values(moves) }),
        headers: { "Content-Type": "application/json" },
      });
```

(d) Drop `hasOffSlide` from the Save button `disabled` and delete the `const hasOffSlide = ...` line:

```tsx
            disabled={saveState !== "idle"}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/api/templates/[id]/route.ts" "web/src/app/(app)/templates/[id]/edit/EditClient.tsx" web/tests/templates-save.test.ts
git commit -m "feat(web): batch geometry at save; off-slide is a soft warning"
```

---

### Task 7: Image contain-fit

**Files:**
- Modify: `engine/src/pptx_mcp/filler.py`
- Modify: `engine/pyproject.toml` (Pillow → runtime dep)
- Test: `engine/tests/test_image_fit.py`

**Interfaces:**
- Consumes: existing `load_image_bytes`; `Slot.constraints.fit`.
- Produces: `_fill_image(slide, shape, value, fit: str | None = None)` placing the image with aspect-preserving contain (centered); `fill_slot` passes `slot.constraints.fit`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_image_fit.py`:

```python
import io

from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Emu

from pptx_mcp.filler import _fill_image


def _img(w, h) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 120, 90)).save(buf, format="PNG")
    return buf.getvalue()


def _deck_with_box(box_w_emu, box_h_emu):
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    shape = slide.shapes.add_textbox(Emu(914400), Emu(914400), Emu(box_w_emu), Emu(box_h_emu))
    return prs, slide, shape


def _only_picture(slide):
    return next(s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE)


def test_contain_wide_image_in_tall_box_centers_vertically():
    # box 1x2 (tall), image 4x1 (wide) -> fills width, shrinks height, centered top.
    prs, slide, shape = _deck_with_box(914400, 1828800)
    box_left, box_top, box_w, box_h = shape.left, shape.top, shape.width, shape.height
    _fill_image(slide, shape, _img(400, 100), "contain")
    pic = _only_picture(slide)
    assert pic.width == box_w
    assert pic.height < box_h
    assert pic.left == box_left
    assert pic.top > box_top  # centered down


def test_contain_tall_image_in_wide_box_centers_horizontally():
    prs, slide, shape = _deck_with_box(1828800, 914400)
    box_left, box_top, box_w, box_h = shape.left, shape.top, shape.width, shape.height
    _fill_image(slide, shape, _img(100, 400), "contain")
    pic = _only_picture(slide)
    assert pic.height == box_h
    assert pic.width < box_w
    assert pic.top == box_top
    assert pic.left > box_left


def test_square_image_in_square_box_fills():
    prs, slide, shape = _deck_with_box(914400, 914400)
    box_w, box_h = shape.width, shape.height
    _fill_image(slide, shape, _img(200, 200), "contain")
    pic = _only_picture(slide)
    assert abs(pic.width - box_w) < 2
    assert abs(pic.height - box_h) < 2


def test_unreadable_image_falls_back_to_box_rect():
    prs, slide, shape = _deck_with_box(914400, 914400)
    box_left, box_top, box_w, box_h = shape.left, shape.top, shape.width, shape.height
    _fill_image(slide, shape, b"not-an-image", "contain")
    pic = _only_picture(slide)
    assert (pic.left, pic.top, pic.width, pic.height) == (box_left, box_top, box_w, box_h)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd engine && python -m pytest tests/test_image_fit.py -v`
Expected: FAIL — `_fill_image()` takes 3 positional args, not 4 (no `fit`); no centering math.

- [ ] **Step 3: Implement**

In `engine/src/pptx_mcp/filler.py`, add the Pillow import with the other imports:

```python
from PIL import Image
```

Replace `_fill_image` with:

```python
def _fill_image(slide, shape, value, fit: str | None = None) -> None:
    data = load_image_bytes(value)
    left, top, width, height = shape.left, shape.top, shape.width, shape.height
    shape._element.getparent().remove(shape._element)

    new_left, new_top, new_w, new_h = left, top, width, height
    # "contain" (default): scale to fit inside the box, preserve aspect, center.
    # "cover" is deferred -> treated as contain for now.
    if width and height:
        try:
            iw, ih = Image.open(io.BytesIO(data)).size
        except Exception:
            iw = ih = 0
        if iw > 0 and ih > 0:
            box_ar = width / height
            img_ar = iw / ih
            if img_ar > box_ar:
                new_w = width
                new_h = round(width / img_ar)
            else:
                new_h = height
                new_w = round(height * img_ar)
            new_left = left + (width - new_w) // 2
            new_top = top + (height - new_h) // 2

    slide.shapes.add_picture(io.BytesIO(data), new_left, new_top, new_w, new_h)
```

Update the `fill_slot` dispatch (currently `_fill_image(slide, shape, value)`):

```python
    elif slot.type == "image":
        _fill_image(slide, shape, value, slot.constraints.fit)
```

- [ ] **Step 4: Promote Pillow to a runtime dependency**

In `engine/pyproject.toml`, add `"pillow>=10"` to `[project] dependencies`:

```toml
dependencies = [
    "python-pptx>=0.6.23",
    "fastmcp>=0.2.0",
    "fastapi>=0.110",
    "uvicorn>=0.29",
    "pillow>=10",
]
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd engine && python -m pytest tests/test_image_fit.py tests/test_image_ingest.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/filler.py engine/pyproject.toml engine/tests/test_image_fit.py
git commit -m "feat(engine): contain-fit image slots (aspect-preserving, centered)"
```

---

## Final verification (after all tasks)

- [ ] Engine: `cd engine && python -m pytest -q` — all pass (1 LibreOffice-gated skip allowed).
- [ ] Service: `cd engine-service && python -m pytest -q` — all pass.
- [ ] Web: `cd web && npx vitest run` — all pass.
- [ ] Web build: `cd web && npx next build` — compiles.
- [ ] Rebuild engine-service + web containers; spot-check the editor: drag a box → it stays; a full-bleed shape shows beyond the slide frame inside an extended canvas; clicking a small box over a big one selects the small one; the layer list selects a covered shape; Save returns to dashboard; an agent image renders centered without distortion.
```