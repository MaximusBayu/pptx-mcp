// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from("PK")),
  putObject: vi.fn().mockResolvedValue("key"),
  presignGet: vi.fn(async (k: string) => `https://files/${k}`),
}));
vi.mock("@/lib/engine", () => ({
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: ["AAA", "BBB"] }),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { renderBasePreviews } from "@/lib/engine";
import { POST } from "@/app/api/templates/[id]/base-previews/route";

const ctx = { params: Promise.resolve({ id: "t1" }) };
const req = () => new Request("http://x/api/templates/t1/base-previews", { method: "POST" });

beforeEach(() => vi.clearAllMocks());

describe("base-previews", () => {
  it("401 without session", async () => {
    (auth as any).mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 when template missing", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("403 when not owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "other", manifestJson: { draft: {} } });
    expect((await POST(req(), ctx)).status).toBe(403);
  });

  it("returns cached urls without rendering", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { draft: { previewKeys: ["templates/t1/preview-0.png"], previewsStatus: "ready" } },
    });
    const r = await POST(req(), ctx);
    const body = await r.json();
    expect(body.status).toBe("ready");
    expect(body.previewUrls).toEqual(["https://files/templates/t1/preview-0.png"]);
    expect(renderBasePreviews).not.toHaveBeenCalled();
    expect(prisma.template.update).not.toHaveBeenCalled();
  });

  it("renders, caches, persists when no keys", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { slide_types: { "0": "title" }, draft: { slides: [], previewKeys: [], previewsStatus: "pending" } },
    });
    const r = await POST(req(), ctx);
    const body = await r.json();
    expect(renderBasePreviews).toHaveBeenCalledTimes(1);
    expect(body.previewUrls).toHaveLength(2);
    const updateArg = (prisma.template.update as any).mock.calls[0][0];
    const draft = (updateArg.data.manifestJson as any).draft;
    expect(draft.previewKeys).toEqual(["templates/t1/preview-0.png", "templates/t1/preview-1.png"]);
    expect(draft.previewsStatus).toBe("ready");
    const manifestJson = (updateArg.data.manifestJson as any);
    expect(manifestJson.slide_types).toEqual({ "0": "title" });
    expect(manifestJson.draft.slides).toEqual([]);
  });

  it("502 when render fails, no persist", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { draft: { previewKeys: [] } },
    });
    (renderBasePreviews as any).mockRejectedValueOnce(new Error("boom"));
    expect((await POST(req(), ctx)).status).toBe(502);
    expect(prisma.template.update).not.toHaveBeenCalled();
  });
});
