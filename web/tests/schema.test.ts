import { describe, it, expect } from "vitest";
import { toAgentSchema } from "@/lib/schema";

const manifest = {
  template: { id: "t1", name: "T", description: "" },
  slide_types: [{
    id: "slide_0", name: "finding", description: "Finding slide", repeatable: true,
    slots: [
      { id: "title", name: "Title", type: "text", constraints: {},
        description: "Slide title", example: "Finding F1: SQLi" },
      { id: "data", name: "Data", type: "table", constraints: {} },
    ],
  }],
};

describe("toAgentSchema enrichment", () => {
  it("surfaces slide repeatable and slot description/example", () => {
    const s = toAgentSchema(manifest, { id: "t1", name: "T", description: "" }) as any;
    expect(s.slide_types[0].repeatable).toBe(true);
    expect(s.slide_types[0].slots[0].description).toBe("Slide title");
    expect(s.slide_types[0].slots[0].example).toBe("Finding F1: SQLi");
  });

  it("includes a non-empty example_deck_spec using slot.example when set", () => {
    const s = toAgentSchema(manifest, { id: "t1", name: "T", description: "" }) as any;
    expect(s.example_deck_spec.slides[0].slide_type).toBe("slide_0");
    expect(s.example_deck_spec.slides[0].slots.title).toBe("Finding F1: SQLi");
    // table slot has no example -> falls back to the type-default list[list]
    expect(Array.isArray(s.example_deck_spec.slides[0].slots.data)).toBe(true);
  });
});
