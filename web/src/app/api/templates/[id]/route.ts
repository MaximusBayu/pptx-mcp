import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject } from "@/lib/s3";
import { moveShapes, renderBasePreviews } from "@/lib/engine";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  const session = await auth();
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== session?.user?.id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json(tpl);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const { name, description, visibility, slideTypes, moves } = await req.json();

  const draftSlides: any[] = (tpl.manifestJson as any)?.draft?.slides ?? [];
  const draftSlide = (idx: number) => draftSlides.find((s) => s.index === idx);
  const draftShape = (idx: number, shapeId: number) =>
    draftSlide(idx)?.shapes?.find((x: any) => x.shape_id === shapeId);

  const slide_types = (slideTypes ?? []).map((st: any) => {
    const ds = draftSlide(st.source_slide_index);
    return {
      id: st.id,
      name: st.name || ds?.suggested_name || `Slide ${(st.source_slide_index ?? 0) + 1}`,
      description: st.description || ds?.suggested_description || "",
      repeatable: st.repeatable ?? ds?.repeatable ?? false,
      source_slide_index: st.source_slide_index,
      slots: (st.slots ?? []).map((s: any) => {
        const sh = draftShape(st.source_slide_index, s.shape_id);
        return {
          id: s.id, name: s.name, type: s.type, target: { shape_id: s.shape_id },
          required: s.required ?? true, default: s.default ?? null,
          constraints: s.constraints ?? {},
          description: s.description || sh?.suggested_description || "",
          example: (s.example ?? "") !== "" ? s.example : (sh?.suggested_example ?? ""),
        };
      }),
    };
  });
  for (const st of slide_types) for (const s of st.slots) {
    if (!s.id) return Response.json({ error: "every slot needs an id" }, { status: 400 });
  }

  // Carry the existing draft forward; geometry edits update it in place.
  const draft = (tpl.manifestJson as any).draft ?? {};
  if (Array.isArray(moves) && moves.length > 0) {
    try {
      const base = await getObject(tpl.basePptxKey);
      const moved = await moveShapes(base, moves);

      // Render previews BEFORE overwriting the base so a render failure
      // leaves the stored .pptx untouched.
      const { previews } = await renderBasePreviews(moved);

      // All rendering succeeded — now persist the base deck and previews.
      await putObject(tpl.basePptxKey, moved, PPTX);
      if (previews.length) {
        const previewKeys: string[] = [];
        for (let i = 0; i < previews.length; i++) {
          const key = `templates/${id}/preview-${i}.png`;
          await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
          previewKeys.push(key);
        }
        draft.previewKeys = previewKeys;
      }
      for (const mv of moves) {
        const slide = (draft.slides ?? []).find((s: any) => s.index === mv.slide_index);
        const sh = slide?.shapes?.find((x: any) => x.shape_id === mv.shape_id);
        if (sh) sh.bbox_pct = mv.bbox_pct;
      }
    } catch {
      return Response.json({ error: "move/render failed" }, { status: 502 });
    }
  }

  const manifestJson = {
    ...(tpl.manifestJson as object),
    template: { id, name: name ?? tpl.name, description: description ?? tpl.description },
    slide_types,
    draft,
  };
  await prisma.template.update({
    where: { id },
    data: {
      name: name ?? tpl.name, description: description ?? tpl.description,
      visibility: visibility ?? tpl.visibility, manifestJson,
    },
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  await prisma.template.delete({ where: { id } });
  return Response.json({ ok: true });
}
