import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildExampleDeckSpec } from "@/lib/example";
import { toAgentSchema } from "@/lib/schema";
import { UseClient } from "./UseClient";

export const dynamic = "force-dynamic";

export default async function UsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl || tpl.ownerId !== session?.user?.id) return <div className="p-8">Not found</div>;

  const schema = toAgentSchema(tpl.manifestJson, { id: tpl.id, name: tpl.name, description: tpl.description });
  const example = buildExampleDeckSpec(tpl.manifestJson);
  const slotCount = schema.slide_types.reduce((n: number, st: any) => n + st.slots.length, 0);

  return <UseClient id={id} name={tpl.name} schema={schema} example={example} slotCount={slotCount} />;
}
