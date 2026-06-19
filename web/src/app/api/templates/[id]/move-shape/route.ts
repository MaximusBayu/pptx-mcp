import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject } from "@/lib/s3";
import { moveShape, renderBasePreviews } from "@/lib/engine";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const { shape_id, bbox_pct } = await req.json();
  const base = await getObject(tpl.basePptxKey);
  const moved = await moveShape(base, shape_id, bbox_pct);
  await putObject(tpl.basePptxKey, moved, PPTX);

  const { previews } = await renderBasePreviews(moved);
  const previewKeys: string[] = [];
  for (let i = 0; i < previews.length; i++) {
    const key = `templates/${id}/preview-${i}.png`;
    await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
    previewKeys.push(key);
  }

  const draft = (tpl.manifestJson as any).draft ?? {};
  for (const slide of draft.slides ?? []) {
    for (const sh of slide.shapes ?? []) {
      if (sh.shape_id === shape_id) sh.bbox_pct = bbox_pct;
    }
  }
  if (previewKeys.length) draft.previewKeys = previewKeys;
  await prisma.template.update({ where: { id }, data: { manifestJson: { ...(tpl.manifestJson as object), draft } } });
  return Response.json({ ok: true });
}
