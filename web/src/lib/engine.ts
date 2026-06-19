const BASE = process.env.ENGINE_URL ?? "http://engine-service:8000";

export class EngineError extends Error {}

function form(pptx: Buffer, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pptx)]), "base.pptx");
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

export async function extractShapes(pptx: Buffer) {
  const r = await fetch(`${BASE}/extract-shapes`, { method: "POST", body: form(pptx) });
  if (!r.ok) throw new EngineError("extract-shapes failed");
  return r.json();
}

export async function renderBasePreviews(pptx: Buffer): Promise<{ previews: string[] }> {
  const r = await fetch(`${BASE}/render-base-previews`, { method: "POST", body: form(pptx) });
  if (!r.ok) throw new EngineError("render-base-previews failed");
  return r.json();
}

export async function renderDeck(pptx: Buffer, manifest: unknown, deckSpec: unknown):
  Promise<{ pptx?: Buffer; validation: any[] }> {
  const r = await fetch(`${BASE}/render-deck`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (r.status === 422) return { validation: (await r.json()).validation };
  if (!r.ok) throw new EngineError("render-deck failed");
  return { pptx: Buffer.from(await r.arrayBuffer()), validation: [] };
}

export async function renderPreview(pptx: Buffer, manifest: unknown, deckSpec: unknown) {
  const r = await fetch(`${BASE}/render-preview`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (!r.ok) throw new EngineError("render-preview failed");
  return r.json();
}

export async function moveShape(pptx: Buffer, shapeId: number, bboxPct: object): Promise<Buffer> {
  const r = await fetch(`${BASE}/move-shape`, {
    method: "POST",
    body: form(pptx, { shape_id: String(shapeId), bbox_pct: JSON.stringify(bboxPct) }),
  });
  if (!r.ok) throw new EngineError("move-shape failed");
  return Buffer.from(await r.arrayBuffer());
}
