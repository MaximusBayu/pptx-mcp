import { describe, it, expect } from "vitest";
import {
  canvasExtent, toCanvasPct, fromCanvasOffset, clampToExtent, rangeX, rangeY,
  canvasHeightPx,
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

  it("canvasHeightPx honors slide aspect (no-bleed 16:9 -> 16:9 canvas)", () => {
    // No bleed: extent is the slide + 2% margin on each side -> square in %-units.
    const e = canvasExtent([], 2); // range 104 x 104
    // 16:9 slide: height should be width / (16/9), not width (square).
    expect(canvasHeightPx(640, e, 16 / 9)).toBeCloseTo(360, 0);
  });

  it("canvasHeightPx grows for vertical bleed but stays aspect-correct", () => {
    // A shape bleeds to y+h = 131 -> taller extent.
    const e = canvasExtent([{ x: 0, y: 100, w: 10, h: 31 }], 2);
    // rangeY = 133-(-2)=135 ; rangeX = 102-(-2)=104 ; AR 16/9
    const h = canvasHeightPx(640, e, 16 / 9);
    expect(h).toBeCloseTo((640 * rangeY(e)) / (rangeX(e) * (16 / 9)), 3);
    expect(h).toBeGreaterThan(360); // taller than the no-bleed case
  });

  it("canvasHeightPx falls back to 16:9 for a non-positive slideAR", () => {
    const e = canvasExtent([], 2);
    expect(canvasHeightPx(640, e, 0)).toBeCloseTo(canvasHeightPx(640, e, 16 / 9), 5);
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
