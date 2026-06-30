import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { validateDeck } from "@/lib/engine";

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
  const out = await validateDeck(base, tpl.manifestJson, deck_spec);
  return Response.json(out);
}
