import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiKey", () => ({ verifyApiKey: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn() } } }));

import { verifyApiKey } from "@/lib/apiKey";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/mcp/templates/[id]/suggest-layout/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
function req(body: object) {
  return new Request("http://x", { method: "POST", headers: { "x-api-key": "pk_a_b" }, body: JSON.stringify(body) });
}
const manifest = {
  slide_types: [
    { id: "slide_2", name: "finding", kind: "finding", repeatable: true,
      slots: [{ id: "severity", type: "text", description: "Text", example: "CRITICAL" }] },
    { id: "slide_0", name: "cover", kind: "cover", repeatable: false, slots: [] },
  ],
};

describe("mcp suggest-layout", () => {
  it("401 without a valid key", async () => {
    (verifyApiKey as any).mockResolvedValue(null);
    expect((await POST(req({ content: "x" }), ctx)).status).toBe(401);
  });

  it("400 when content is empty", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", manifestJson: manifest });
    expect((await POST(req({ content: "   " }), ctx)).status).toBe(400);
  });

  it("ranks candidates for the owner", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", manifestJson: manifest });
    const r = await POST(req({ content: "Severity CRITICAL CWE-89" }), ctx);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidates[0].slide_type).toBe("slide_2");
  });
});
