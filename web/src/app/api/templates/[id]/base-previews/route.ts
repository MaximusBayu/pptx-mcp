import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderBasePreviews } from "@/lib/engine";

// Owner-only lazy render of the base-deck previews. Idempotent: returns cached
// presigned URLs when previews already exist; otherwise renders once, caches to
// S3, and persists the keys. Called by the editor on first open.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const draft = (tpl.manifestJson as any).draft ?? {};
  const existing: string[] = draft.previewKeys ?? [];
  if (existing.length) {
    const previewUrls = await Promise.all(existing.map((k: string) => presignGet(k)));
    return Response.json({ status: "ready", previewUrls });
  }

  let keys: string[];
  try {
    const base = await getObject(tpl.basePptxKey);
    const { previews } = await renderBasePreviews(base);
    keys = [];
    for (let i = 0; i < previews.length; i++) {
      const key = `templates/${id}/preview-${i}.png`;
      await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
      keys.push(key);
    }
  } catch {
    return Response.json({ error: "preview render failed" }, { status: 502 });
  }

  const manifestJson = {
    ...(tpl.manifestJson as object),
    draft: { ...draft, previewKeys: keys, previewsStatus: "ready" },
  };
  await prisma.template.update({ where: { id }, data: { manifestJson } });
  const previewUrls = await Promise.all(keys.map((k) => presignGet(k)));
  return Response.json({ status: "ready", previewUrls });
}
