import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/s3";
import { extractShapes, renderBasePreviews } from "@/lib/engine";
import { createId } from "@/lib/id";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file || !file.name.endsWith(".pptx")) {
    return Response.json({ error: "expected a .pptx file" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createId();
  const baseKey = `templates/${id}/base.pptx`;
  await putObject(baseKey, bytes, PPTX);

  const shapes = await extractShapes(bytes);
  const { previews } = await renderBasePreviews(bytes);
  const previewKeys: string[] = [];
  for (let i = 0; i < previews.length; i++) {
    const key = `templates/${id}/preview-${i}.png`;
    await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
    previewKeys.push(key);
  }

  const tpl = await prisma.template.create({
    data: {
      id, ownerId: session.user.id, name: file.name.replace(/\.pptx$/, ""),
      basePptxKey: baseKey,
      manifestJson: { draft: { slides: shapes.slides, previewKeys } } as object,
    },
  });
  return Response.json({ id: tpl.id }, { status: 201 });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const templates = await prisma.template.findMany({
    where: { ownerId: session.user.id }, orderBy: { updatedAt: "desc" },
  });
  return Response.json(templates);
}
