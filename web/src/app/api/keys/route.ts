import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/apiKey";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const keys = await prisma.apiKey.findMany({
    where: { userId: session.user.id },
    select: { id: true, prefix: true, createdAt: true, lastUsedAt: true },
  });
  return Response.json(keys);
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { raw, prefix, hash } = await generateApiKey();
  await prisma.apiKey.create({ data: { userId: session.user.id, prefix, hash } });
  return Response.json({ raw }, { status: 201 });
}
