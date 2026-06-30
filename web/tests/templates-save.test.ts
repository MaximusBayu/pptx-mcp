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

  it("persists slide kind, falling back to the draft", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1",
      manifestJson: { draft: { slides: [{ index: 0, kind: "finding", suggested_name: "finding", shapes: [] }] } },
    });
    (prisma.template.update as any).mockResolvedValue({});
    const body = {
      name: "K",
      slideTypes: [{ id: "title", source_slide_index: 0, kind: "", slots: [{ id: "title", name: "T", type: "text", shape_id: 5 }] }],
    };
    const r = await PUT(put(body), ctx);
    expect(r.status).toBe(200);
    const saved = (prisma.template.update as any).mock.calls[0][0].data.manifestJson;
    expect(saved.slide_types[0].kind).toBe("finding");
  });

  it("persists slide repeatable + slot description/example, falling back to draft", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1",
      manifestJson: { draft: { slides: [{
        index: 0, suggested_name: "finding",
        suggested_description: "Finding slide — fill: title.", repeatable: true,
        shapes: [{ shape_id: 5, suggested_description: "Slide title", suggested_example: "Finding F1" }],
      }] } },
    });
    (prisma.template.update as any).mockResolvedValue({});
    const body = {
      name: "Rep",
      slideTypes: [{
        id: "title", source_slide_index: 0,
        // name + slot description left blank -> fall back to draft suggestions
        name: "", description: "",
        slots: [{ id: "title", name: "Title", type: "text", shape_id: 5,
                  description: "", example: "" }],
      }],
    };
    const r = await PUT(put(body), ctx);
    expect(r.status).toBe(200);
    const saved = (prisma.template.update as any).mock.calls[0][0].data.manifestJson;
    const st = saved.slide_types[0];
    expect(st.name).toBe("finding");
    expect(st.repeatable).toBe(true);
    expect(st.slots[0].description).toBe("Slide title");
    expect(st.slots[0].example).toBe("Finding F1");
  });
});

it("applies batched moves and re-renders previews on save", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1" } })) }));
  vi.doMock("@/lib/prisma", () => ({
    prisma: { template: {
      findUnique: vi.fn(async () => ({ id: "t1", ownerId: "u1", basePptxKey: "base.pptx", manifestJson: { draft: { slides: [{ index: 0, shapes: [{ shape_id: 5, bbox_pct: { x: 0, y: 0, w: 10, h: 10 } }] }] } } })),
      update: vi.fn(async () => ({})),
    } },
  }));
  const moveShapes = vi.fn(async () => Buffer.from("PK2"));
  const renderBasePreviews = vi.fn(async () => ({ previews: ["aGk="] }));
  vi.doMock("@/lib/engine", () => ({ moveShapes, renderBasePreviews, EngineError: class extends Error {} }));
  const putObject = vi.fn(async (k: string) => k);
  vi.doMock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")), putObject }));

  const { PUT } = await import("@/app/api/templates/[id]/route");
  const body = {
    name: "T", slideTypes: [],
    moves: [{ slide_index: 0, shape_id: 5, bbox_pct: { x: 50, y: 50, w: 10, h: 10 } }],
  };
  const req = new Request("http://x", { method: "PUT", body: JSON.stringify(body) });
  const res = await PUT(req, { params: Promise.resolve({ id: "t1" }) });
  expect(res.status).toBe(200);
  expect(moveShapes).toHaveBeenCalledOnce();
  expect(renderBasePreviews).toHaveBeenCalledOnce();

  // Confirm the moved bbox was persisted to the DB manifest.
  const { prisma: p } = await import("@/lib/prisma");
  const updateArg = (p.template.update as any).mock.calls[0][0];
  const persistedManifest = updateArg.data.manifestJson;
  expect(persistedManifest.draft.slides[0].shapes[0].bbox_pct).toEqual(
    { x: 50, y: 50, w: 10, h: 10 }
  );
});
