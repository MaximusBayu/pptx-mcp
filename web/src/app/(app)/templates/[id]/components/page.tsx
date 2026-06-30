import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { getCatalog } from "@/lib/engine";
import { ComponentsClient } from "./ComponentsClient";

export const dynamic = "force-dynamic";

export default async function ComponentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl || tpl.ownerId !== session?.user?.id) return <div className="p-8">Not found</div>;
  const base = await getObject(tpl.basePptxKey);
  const catalog = await getCatalog(base, tpl.manifestJson);
  return <ComponentsClient name={tpl.name} components={catalog.components} />;
}
