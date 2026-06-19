import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const authCallbacks = {
  jwt: async ({ token, user }: any) => {
    if (user?.id) token.sub = user.id;
    return token;
  },
  session: async ({ session, token }: any) => {
    if (token.sub && session.user) session.user.id = token.sub;
    return session;
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  callbacks: authCallbacks,
  providers: [
    Google,
    GitHub,
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (c) => {
        const email = c?.email as string | undefined;
        const password = c?.password as string | undefined;
        if (!email || !password) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;
        return (await bcrypt.compare(password, user.passwordHash))
          ? { id: user.id, email: user.email, name: user.name }
          : null;
      },
    }),
  ],
});
