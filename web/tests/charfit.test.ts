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
