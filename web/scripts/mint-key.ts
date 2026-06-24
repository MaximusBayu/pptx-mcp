import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/apiKey";

type Db = { user: { findUnique: (a: { where: { email: string } }) => Promise<{ id: string } | null> } };

export async function mintKeyForEmail(db: Db, email: string):
    Promise<{ raw: string } | { error: string }> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return { error: `no user with email ${email}` };
  return { raw: await mintApiKey(user.id) };
}

async function main() {
  const i = process.argv.indexOf("--email");
  const email = i >= 0 ? process.argv[i + 1] : undefined;
  if (!email) {
    console.error("usage: npm run mcp:key -- --email <email>");
    process.exit(1);
  }
  const result = await mintKeyForEmail(prisma as unknown as Db, email);
  if ("error" in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.raw);
  console.error("API key created. This is shown once — store it now.");
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("mint-key.ts")) {
  void main();
}
