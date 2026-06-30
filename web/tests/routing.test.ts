import { describe, it, expect } from "vitest";
import { scoreLayouts } from "@/lib/routing";

const manifest = {
  slide_types: [
    { id: "slide_0", name: "cover", kind: "cover", repeatable: false,
      slots: [{ id: "title", type: "text", description: "Slide title", example: "RISEStore VAPT Report" }] },
    { id: "slide_2", name: "finding", kind: "finding", repeatable: true,
      slots: [
        { id: "title", type: "text", description: "Slide title", example: "Finding F1" },
        { id: "severity", type: "text", description: "Text", example: "CRITICAL" },
        { id: "body", type: "text", description: "Body text", example: "SQL injection in login" },
      ] },
    { id: "slide_4", name: "data", kind: "data", repeatable: false,
      slots: [{ id: "table_1", type: "table", description: "Table data", example: "" }] },
  ],
};

describe("scoreLayouts", () => {
  it("ranks the finding slide first for finding-flavored content", () => {
    const out = scoreLayouts(manifest, "Severity: CRITICAL. CWE-89 SQL injection found in login.");
    expect(out[0].slide_type).toBe("slide_2");
    expect(out[0].repeatable).toBe(true);
    expect(out[0].reason.length).toBeGreaterThan(0);
  });

  it("boosts a table slide for tabular content", () => {
    const out = scoreLayouts(manifest, "Region\tRevenue\nEU\t1.2M\nUS\t2.4M");
    expect(out[0].slide_type).toBe("slide_4");
  });

  it("does not penalize a repeatable type as it repeats", () => {
    const c = "Severity: CRITICAL CWE-89 SQL injection";
    const a = scoreLayouts(manifest, c, {});
    const b = scoreLayouts(manifest, c, { slide_2: 3 });
    const fa = a.find((x) => x.slide_type === "slide_2")!;
    const fb = b.find((x) => x.slide_type === "slide_2")!;
    expect(fb.score).toBe(fa.score);
    expect(b[0].slide_type).toBe("slide_2");
    expect(fb.reason).toMatch(/repeat/i);
  });

  it("penalizes a non-repeatable type once used", () => {
    const c = "Quarterly Review";
    const a = scoreLayouts(manifest, c, {});
    const b = scoreLayouts(manifest, c, { slide_0: 2 });
    const ca = a.find((x) => x.slide_type === "slide_0")!;
    const cb = b.find((x) => x.slide_type === "slide_0")!;
    expect(cb.score).toBeLessThan(ca.score);
    expect(cb.reason).toMatch(/already used/i);
  });

  it("every candidate carries repeatable and a reason", () => {
    const out = scoreLayouts(manifest, "anything here");
    for (const c of out) {
      expect(typeof c.repeatable).toBe("boolean");
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns [] for an empty manifest and never throws on a bad used", () => {
    expect(scoreLayouts({}, "x")).toEqual([]);
    expect(scoreLayouts(manifest, "x", null as any)).toHaveLength(3);
  });
});
