import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")), putObject: vi.fn(async (k: string) => k) }));
vi.mock("@/lib/engine", () => ({
  moveShape: vi.fn(async () => Buffer.from("PK2")),
  renderBasePreviews: vi.fn(async () => ({ previews: [] })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/templates/[id]/move-shape/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const body = (o: object) => new Request("http://x", { method: "POST", body: JSON.stringify(o) });

describe("move-shape api", () => {
  it("403 for non-owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "other" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: { draft: { slides: [] } } });
    const r = await POST(body({ shape_id: 5, bbox_pct: { x: 1, y: 1, w: 1, h: 1 } }), ctx);
    expect(r.status).toBe(403);
  });

  it("moves shape for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: { draft: { slides: [] } } });
    (prisma.template.update as any).mockResolvedValue({});
    const r = await POST(body({ shape_id: 5, bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }), ctx);
    expect(r.status).toBe(200);
  });
});
