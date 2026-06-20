import { describe, it, expect } from "vitest";
import { isOffSlide, overlaps, placementIssues } from "@/lib/placement";

describe("placement", () => {
  it("flags boxes crossing an edge", () => {
    expect(isOffSlide({ x: 90, y: 10, w: 20, h: 10 })).toBe(true);
    expect(isOffSlide({ x: 10, y: 10, w: 20, h: 10 })).toBe(false);
    expect(isOffSlide({ x: -1, y: 10, w: 5, h: 5 })).toBe(true);
  });

  it("detects overlap", () => {
    expect(overlaps({ x: 0, y: 0, w: 50, h: 50 }, { x: 25, y: 25, w: 50, h: 50 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(false);
  });

  it("summarizes issues across slots", () => {
    const r = placementIssues([
      { id: "title", box: { x: 90, y: 0, w: 20, h: 10 } },
      { id: "a", box: { x: 0, y: 0, w: 40, h: 40 } },
      { id: "b", box: { x: 20, y: 20, w: 40, h: 40 } },
    ]);
    expect(r.offSlide).toContain("title");
    expect(r.overlapping).toEqual([["a", "b"]]);
  });
});
