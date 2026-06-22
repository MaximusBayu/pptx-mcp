import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/s3";
import { autodetect } from "@/lib/engine";
import { createId } from "@/lib/id";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file || !file.name.endsWith(".pptx")) {
    return Response.json({ error: "expected a .pptx file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large (max 100MB)" }, { status: 413 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createId();
  const baseKey = `templates/${id}/base.pptx`;
  await putObject(baseKey, bytes, PPTX);

  let detected;
  try {
    detected = await autodetect(bytes);
  } catch {
    return Response.json({ error: "could not analyze the .pptx" }, { status: 502 });
  }

  const tpl = await prisma.template.create({
    data: {
      id, ownerId: session.user.id, name: file.name.replace(/\.pptx$/, ""),
      basePptxKey: baseKey,
      manifestJson: { draft: { slides: detected.slides, previewKeys: [], previewsStatus: "pending" } } as object,
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
