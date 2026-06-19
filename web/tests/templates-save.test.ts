import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PUT } from "@/app/api/templates/[id]/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const put = (o: object) => new Request("http://x", { method: "PUT", body: JSON.stringify(o) });

const slideTypes = [{
  id: "title", name: "Title", source_slide_index: 0,
  slots: [{ id: "title", name: "Title", type: "text", shape_id: 5, constraints: { max_chars: 40 } }],
}];

describe("save manifest", () => {
  it("rejects slot with empty id", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", manifestJson: {} });
    const bad = [{ ...slideTypes[0], slots: [{ ...slideTypes[0].slots[0], id: "" }] }];
    const r = await PUT(put({ slideTypes: bad }), ctx);
    expect(r.status).toBe(400);
  });

  it("saves real manifest for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", manifestJson: { draft: {} } });
    (prisma.template.update as any).mockResolvedValue({});
    const r = await PUT(put({ name: "Pitch", slideTypes }), ctx);
    expect(r.status).toBe(200);
    const arg = (prisma.template.update as any).mock.calls[0][0];
    const saved = arg.data.manifestJson;
    expect(saved.slide_types[0].slots[0].target.shape_id).toBe(5);
  });
});
