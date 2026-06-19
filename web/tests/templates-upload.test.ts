import { describe, it, expect, vi, beforeEach } from "vitest";

// Use Node environment for this test file to properly handle FormData
//@vitest-environment node

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { create: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ putObject: vi.fn().mockResolvedValue("key") }));
vi.mock("@/lib/id", () => ({ createId: vi.fn(() => "id1") }));
vi.mock("@/lib/engine", () => ({
  extractShapes: vi.fn().mockResolvedValue({ slides: [] }),
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: [] }),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractShapes, renderBasePreviews } from "@/lib/engine";
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
});
