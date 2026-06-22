import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { scoreLayouts } from "@/lib/routing";

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
  const content = typeof body?.content === "string" ? body.content : "";
  if (!content.trim()) return Response.json({ error: "content is required" }, { status: 400 });
  const used = body?.used && typeof body.used === "object" ? body.used : {};
  const candidates = scoreLayouts(tpl.manifestJson, content, used);
  return Response.json({ candidates });
}
