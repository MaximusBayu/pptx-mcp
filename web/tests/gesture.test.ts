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
