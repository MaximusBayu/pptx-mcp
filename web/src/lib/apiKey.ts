import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

export async function generateApiKey() {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("hex");
  const hash = await bcrypt.hash(secret, 12);
  return { raw: `pk_${prefix}_${secret}`, prefix, hash };
}

export async function verifyApiKey(raw: string): Promise<string | null> {
  const m = /^pk_([0-9a-f]+)_([0-9a-f]+)$/.exec(raw ?? "");
  if (!m) return null;
  const [, prefix, secret] = m;
  const key = await prisma.apiKey.findUnique({ where: { prefix } });
  if (!key) return null;
  if (!(await bcrypt.compare(secret, key.hash))) return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key.userId;
}
