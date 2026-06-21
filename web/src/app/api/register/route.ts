import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const { email, password, name } = await req.json().catch(() => ({}));
  if (!email || typeof password !== "string" || password.length < 8) {
    return Response.json({ error: "invalid email or password (min 8 chars)" }, { status: 400 });
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    return Response.json({ error: "email already registered" }, { status: 400 });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, name: name ?? null, passwordHash } });
  return Response.json({ id: user.id, email: user.email }, { status: 201 });
}
