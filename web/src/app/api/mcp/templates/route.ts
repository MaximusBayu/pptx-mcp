import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const templates = await prisma.template.findMany({
    where: { OR: [{ ownerId: userId }, { visibility: "PUBLIC" }] },
    orderBy: { updatedAt: "desc" },
  });
  return Response.json(templates.map((t) => ({
    id: t.id, name: t.name, description: t.description,
    slide_types: ((t.manifestJson as any).slide_types ?? []).map((st: any) =>
      ({ id: st.id, name: st.name, description: st.description ?? "" })),
  })));
}
