import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/apiKey";

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
  const userId = session.user.id;

  const count = await prisma.apiKey.count({ where: { userId } });
  if (count >= 20) return Response.json({ error: "key limit reached (max 20)" }, { status: 422 });

  const raw = await mintApiKey(userId);
  return Response.json({ raw }, { status: 201 });
}
