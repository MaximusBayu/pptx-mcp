import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findMany: vi.fn() } } }));
import { prisma } from "@/lib/prisma";
import { listPublicTemplates } from "@/lib/templates";

beforeEach(() => vi.clearAllMocks());

describe("gallery query", () => {
  it("filters by PUBLIC visibility", async () => {
    (prisma.template.findMany as any).mockResolvedValue([{ id: "t1" }]);
    await listPublicTemplates();
    const arg = (prisma.template.findMany as any).mock.calls[0][0];
    expect(arg.where.visibility).toBe("PUBLIC");
  });
});
