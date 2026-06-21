// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Use Node environment for this test file to properly handle FormData

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { create: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ putObject: vi.fn().mockResolvedValue("key") }));
vi.mock("@/lib/id", () => ({ createId: vi.fn(() => "id1") }));
vi.mock("@/lib/engine", () => ({
  autodetect: vi.fn().mockResolvedValue({
    slides: [{ index: 0, width_emu: 1, height_emu: 1, shapes: [
      { shape_id: 2, name: "TextBox 2", type: "text",
        bbox_pct: { x: 10, y: 5, w: 70, h: 15 }, confidence: 0.9,
        is_candidate: true, suggested_id: "title",
        suggested_max_chars: 40, suggested_max_lines: 2, font_pt: 40 },
    ] }],
  }),
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: [] }),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { autodetect } from "@/lib/engine";
import { POST } from "@/app/api/templates/route";

beforeEach(() => vi.clearAllMocks());

function upload(): Request {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("PK")], { type: "application/octet-stream" }), "x.pptx");
  return new Request("http://x/api/templates", { method: "POST", body: fd });
}

describe("upload", () => {
  it("401 without session", async () => {
    (auth as any).mockResolvedValue(null);
    expect((await POST(upload())).status).toBe(401);
  });

  it("creates draft template", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.create as any).mockResolvedValue({ id: "t1" });
    const r = await POST(upload());
    expect(r.status).toBe(201);
    expect((await r.json()).id).toBe("t1");
  });

  it("stores auto-detected draft with suggested_id", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.create as any).mockResolvedValue({ id: "t1" });
    await POST(upload());
    const createCall = (prisma.template.create as any).mock.calls[0][0];
    const draft = (createCall.data.manifestJson as any).draft;
    expect(draft.slides[0].shapes[0].suggested_id).toBe("title");
  });
});
