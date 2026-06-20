/**
 * Regression test: cross-slide shape_id collision in TagEditor slot keying.
 *
 * RED (before fix): buildInitialSlots keyed by bare shape_id, so slide 1's
 *   shape_id=2 would silently overwrite slide 0's shape_id=2. The slots map
 *   would contain only one entry for key "2", and grouped[0] would be empty
 *   while grouped[1] held the wrong slot.
 * GREEN (after fix): keys are "${slideIndex}:${shapeId}", so both slots survive
 *   and each routes to its correct slide during save grouping.
 */
import { describe, it, expect } from "vitest";
import { buildInitialSlots, slotKey } from "@/components/TagEditor";

const twoSlides = [
  {
    index: 0,
    shapes: [
      {
        shape_id: 2, name: "Title", type: "text",
        bbox_pct: { x: 0, y: 0, w: 50, h: 10 },
        is_candidate: true, suggested_id: "title",
        suggested_max_chars: 80, suggested_max_lines: 2,
      },
    ],
  },
  {
    index: 1,
    shapes: [
      {
        // Same shape_id=2 as slide 0 — classic PPTX cross-slide collision
        shape_id: 2, name: "Body", type: "text",
        bbox_pct: { x: 0, y: 15, w: 90, h: 60 },
        is_candidate: true, suggested_id: "body",
        suggested_max_chars: 400,
      },
    ],
  },
];

describe("buildInitialSlots — multi-slide shape_id collision", () => {
  it("produces two distinct slots when two slides share shape_id=2", () => {
    const slots = buildInitialSlots(twoSlides);
    // Both composite keys must exist
    expect(slots).toHaveProperty(slotKey(0, 2));
    expect(slots).toHaveProperty(slotKey(1, 2));
    // Values must be independent (not overwritten)
    expect(slots[slotKey(0, 2)].id).toBe("title");
    expect(slots[slotKey(1, 2)].id).toBe("body");
  });

  it("records the correct slideIndex on each slot", () => {
    const slots = buildInitialSlots(twoSlides);
    expect(slots[slotKey(0, 2)].slideIndex).toBe(0);
    expect(slots[slotKey(1, 2)].slideIndex).toBe(1);
  });

  it("seeds max_lines from suggested_max_lines (Finding 2)", () => {
    const slots = buildInitialSlots(twoSlides);
    // Slide 0 shape has suggested_max_lines: 2
    expect(slots[slotKey(0, 2)].constraints.max_lines).toBe(2);
    // Slide 1 shape has no suggested_max_lines — key must be absent
    expect(slots[slotKey(1, 2)].constraints.max_lines).toBeUndefined();
  });

  it("save grouping: slots route to the correct slide by slideIndex", () => {
    const slots = buildInitialSlots(twoSlides);
    // Simulate EditClient.save() grouping logic (post-fix)
    const grouped = twoSlides.map((_sl, idx) =>
      Object.values(slots).filter((s) => s.slideIndex === idx && s.id)
    );
    expect(grouped[0]).toHaveLength(1);
    expect(grouped[0][0].id).toBe("title");
    expect(grouped[1]).toHaveLength(1);
    expect(grouped[1][0].id).toBe("body");
  });
});
