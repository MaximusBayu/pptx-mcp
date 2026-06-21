import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiKey", () => ({ verifyApiKey: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), findMany: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({
  getObject: vi.fn(async () => Buffer.from("PK")), putObject: vi.fn(async (k: string) => k),
  presignGet: vi.fn(async () => "https://signed/url"),
}));
vi.mock("@/lib/engine", () => ({ renderDeck: vi.fn() }));

import { verifyApiKey } from "@/lib/apiKey";
import { prisma } from "@/lib/prisma";
import { renderDeck } from "@/lib/engine";
import { POST as RENDER } from "@/app/api/mcp/templates/[id]/render/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
function req(deck: object) {
  return new Request("http://x", { method: "POST", headers: { "x-api-key": "pk_a_b" }, body: JSON.stringify({ deck_spec: deck }) });
}

describe("mcp render", () => {
  it("401 without valid key", async () => {
    (verifyApiKey as any).mockResolvedValue(null);
    expect((await RENDER(req({}), ctx)).status).toBe(401);
  });

  it("403 for private template not owned", async () => {
    (verifyApiKey as any).mockResolvedValue("u2");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE" });
    expect((await RENDER(req({}), ctx)).status).toBe(403);
  });

  it("returns validation when engine rejects", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", basePptxKey: "k", manifestJson: { slide_types: [] } });
    (renderDeck as any).mockResolvedValue({ validation: [{ code: "text_overflow" }] });
    const r = await RENDER(req({ slides: [] }), ctx);
    const body = await r.json();
    expect(body.download_url).toBeNull();
    expect(body.validation[0].code).toBe("text_overflow");
  });

  it("returns download_url on success", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", basePptxKey: "k", manifestJson: { slide_types: [] } });
    (renderDeck as any).mockResolvedValue({ validation: [], pptx: Buffer.from("PK") });
    const r = await RENDER(req({ slides: [] }), ctx);
    const body = await r.json();
    expect(body.download_url).toBe("https://signed/url");
  });
});
