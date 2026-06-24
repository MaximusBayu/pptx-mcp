import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")) }));
vi.mock("@/lib/engine", () => ({
  validateDeck: vi.fn(async () => ({ errors: [], warnings: [{ code: "text_truncated" }] })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/templates/[id]/validate/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const body = (o: object) => new Request("http://x", { method: "POST", body: JSON.stringify(o) });

describe("validate api (session)", () => {
  it("401 when unauthenticated", async () => {
    (auth as any).mockResolvedValue(null);
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(401);
  });

  it("403 for non-owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "other" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: {} });
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(403);
  });

  it("returns errors+warnings for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: {} });
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.warnings[0].code).toBe("text_truncated");
  });
});
