import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { validateDeck } from "@/lib/engine";

// Owner-only, session-authenticated dry-run validate. Returns {errors, warnings}
// without rendering output. Mirrors /api/mcp/templates/[id]/validate.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const { deck_spec } = body ?? {};
  const base = await getObject(tpl.basePptxKey);
  const out = await validateDeck(base, tpl.manifestJson, deck_spec);
  return Response.json(out);
}
