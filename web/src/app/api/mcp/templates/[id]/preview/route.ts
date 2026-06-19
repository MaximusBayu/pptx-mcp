import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderPreview } from "@/lib/engine";
import { randomBytes } from "crypto";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const { deck_spec } = body ?? {};
  const base = await getObject(tpl.basePptxKey);
  const out = await renderPreview(base, tpl.manifestJson, deck_spec);
  if (out.validation?.length) return Response.json({ validation: out.validation, previews: [] });
  const urls: string[] = [];
  for (const b64 of out.previews ?? []) {
    const key = `outputs/${id}/preview-${randomBytes(6).toString("hex")}.png`;
    await putObject(key, Buffer.from(b64, "base64"), "image/png");
    urls.push(await presignGet(key));
  }
  return Response.json({ validation: [], previews: urls });
}
