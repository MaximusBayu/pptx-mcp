import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignGet } from "@/lib/s3";
import { EditClient } from "./EditClient";

export const dynamic = "force-dynamic";

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl || tpl.ownerId !== session?.user?.id) return <div className="p-8">Not found</div>;
  const draft = (tpl.manifestJson as any).draft ?? { slides: [], previewKeys: [] };
  const previewUrls = await Promise.all((draft.previewKeys ?? []).map((k: string) => presignGet(k)));
  return <EditClient id={id} name={tpl.name} slides={draft.slides} previewUrls={previewUrls} />;
}
