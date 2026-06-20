import { describe, it, expect } from "vitest";
import { initHistory, pushState, undo, redo } from "@/lib/editorHistory";

describe("editor history", () => {
  it("push/undo/redo round-trips", () => {
    let h = initHistory({ n: 0 });
    h = pushState(h, { n: 1 });
    h = pushState(h, { n: 2 });
    expect(h.present).toEqual({ n: 2 });
    h = undo(h);
    expect(h.present).toEqual({ n: 1 });
    h = undo(h);
    expect(h.present).toEqual({ n: 0 });
    h = redo(h);
    expect(h.present).toEqual({ n: 1 });
  });

  it("push clears the redo future", () => {
    let h = initHistory(0);
    h = pushState(h, 1);
    h = undo(h);
    h = pushState(h, 5);
    expect(h.future).toEqual([]);
    expect(redo(h).present).toBe(5);
  });

  it("undo/redo at the ends are no-ops", () => {
    let h = initHistory("a");
    expect(undo(h).present).toBe("a");
    expect(redo(h).present).toBe("a");
  });
});
