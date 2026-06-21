import { describe, it, expect } from "vitest";
import { exampleSlotValue, buildExampleDeckSpec } from "@/lib/example";

describe("example deck_spec", () => {
  it("emits a string for text slots", () => {
    expect(typeof exampleSlotValue({ id: "title", type: "text" })).toBe("string");
  });

  it("emits string[][] for table slots (engine validates list[list])", () => {
    const v = exampleSlotValue({ id: "data", type: "table" }) as string[][];
    expect(Array.isArray(v)).toBe(true);
    expect(Array.isArray(v[0])).toBe(true);
    expect(typeof v[0][0]).toBe("string");
  });

  it("emits a non-empty string for image slots", () => {
    const v = exampleSlotValue({ id: "photo", type: "image" });
    expect(typeof v).toBe("string");
    expect((v as string).length).toBeGreaterThan(0);
  });

  it("prefers an explicit default when present", () => {
    expect(exampleSlotValue({ id: "x", type: "text", default: "hi" })).toBe("hi");
  });

  it("prefers an explicit example over the type default", () => {
    expect(exampleSlotValue({ id: "t", type: "text", example: "Real text" })).toBe("Real text");
  });

  it("builds a deck_spec keyed by slide_type with all slots filled", () => {
    const manifest = {
      slide_types: [
        { id: "slide_0", slots: [
          { id: "title", type: "text" },
          { id: "grid", type: "table" },
        ] },
      ],
    };
    const deck = buildExampleDeckSpec(manifest) as any;
    expect(deck.slides[0].slide_type).toBe("slide_0");
    expect(typeof deck.slides[0].slots.title).toBe("string");
    expect(Array.isArray(deck.slides[0].slots.grid)).toBe(true);
  });
});
