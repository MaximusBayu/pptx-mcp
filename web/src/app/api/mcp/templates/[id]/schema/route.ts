import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { toAgentSchema } from "@/lib/schema";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json(toAgentSchema(tpl.manifestJson, { id: tpl.id, name: tpl.name, description: tpl.description }));
}
