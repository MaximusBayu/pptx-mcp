import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderDeck } from "@/lib/engine";
import { randomBytes } from "crypto";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Owner-only, session-authenticated render. Lets the template owner test a
// deck_spec from the browser without minting an API key. Mirrors the
// API-key route at /api/mcp/templates/[id]/render.
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
  const out = await renderDeck(base, tpl.manifestJson, deck_spec);
  if (!out.pptx) return Response.json({ validation: out.validation ?? [], download_url: null });
  const key = `outputs/${id}/${randomBytes(8).toString("hex")}.pptx`;
  await putObject(key, out.pptx, PPTX);
  return Response.json({ validation: [], download_url: await presignGet(key) });
}
