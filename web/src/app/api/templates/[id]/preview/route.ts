import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderPreview } from "@/lib/engine";
import { randomBytes } from "crypto";

// Owner-only, session-authenticated PNG preview. Mirrors the API-key route at
// /api/mcp/templates/[id]/preview so owners can preview in the browser.
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
