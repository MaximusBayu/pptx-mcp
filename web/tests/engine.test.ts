import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => fetchMock.mockReset());

import { renderDeck } from "@/lib/engine";

describe("engine client", () => {
  it("returns validation on 422", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ validation: [{ code: "text_overflow" }] }),
      { status: 422, headers: { "content-type": "application/json" } }));
    const out = await renderDeck(Buffer.from("x"), {}, {});
    expect(out.validation[0].code).toBe("text_overflow");
    expect(out.pptx).toBeUndefined();
  });

  it("returns pptx bytes on 200", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const out = await renderDeck(Buffer.from("x"), {}, {});
    expect(out.pptx).toBeInstanceOf(Buffer);
    expect(out.validation).toEqual([]);
  });

  it("moveShapes posts moves and returns bytes", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b]), { status: 200 }) as any
    );
    const { moveShapes } = await import("@/lib/engine");
    const out = await moveShapes(Buffer.from("PK"), [
      { slide_index: 1, shape_id: 5, bbox_pct: { x: 10, y: 10, w: 20, h: 10 } },
    ]);
    expect(out).toBeInstanceOf(Buffer);
    const url = (spy.mock.calls[0][0] as string);
    expect(url).toContain("/move-shapes");
    spy.mockRestore();
  });
});
