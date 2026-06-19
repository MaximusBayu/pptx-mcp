import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  const { name, description, visibility, slideTypes } = await req.json();
  const slide_types = (slideTypes ?? []).map((st: any) => ({
    id: st.id, name: st.name, description: st.description ?? "",
    source_slide_index: st.source_slide_index,
    slots: (st.slots ?? []).map((s: any) => ({
      id: s.id, name: s.name, type: s.type, target: { shape_id: s.shape_id },
      required: s.required ?? true, default: s.default ?? null, constraints: s.constraints ?? {},
    })),
  }));
  for (const st of slide_types) for (const s of st.slots) {
    if (!s.id) return Response.json({ error: "every slot needs an id" }, { status: 400 });
  }

  const manifestJson = {
    ...(tpl.manifestJson as object),
    template: { id, name: name ?? tpl.name, description: description ?? tpl.description },
    slide_types,
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
