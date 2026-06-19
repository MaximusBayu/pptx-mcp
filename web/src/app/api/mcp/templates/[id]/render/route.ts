import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderDeck } from "@/lib/engine";
import { randomBytes } from "crypto";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { deck_spec } = await req.json();
  const base = await getObject(tpl.basePptxKey);
  const out = await renderDeck(base, tpl.manifestJson, deck_spec);
  if (!out.pptx) return Response.json({ validation: out.validation, download_url: null });
  const key = `outputs/${id}/${randomBytes(8).toString("hex")}.pptx`;
  await putObject(key, out.pptx, PPTX);
  return Response.json({ validation: [], download_url: await presignGet(key) });
}
