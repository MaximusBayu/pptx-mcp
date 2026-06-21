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
