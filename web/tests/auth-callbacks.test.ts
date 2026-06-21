import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn() }));
vi.mock("next-auth/providers/google", () => ({ default: {} }));
vi.mock("next-auth/providers/github", () => ({ default: {} }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn(() => ({})) }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn() } }));

import { authCallbacks } from "@/lib/auth";

describe("authCallbacks", () => {
  describe("jwt callback", () => {
    it("copies user.id into token.sub when user is present", async () => {
      const token = {};
      const result = await authCallbacks.jwt({ token, user: { id: "u1" } });
      expect(result.sub).toBe("u1");
    });

    it("leaves token unchanged when user is absent", async () => {
      const token = { sub: "existing" };
      const result = await authCallbacks.jwt({ token, user: undefined });
      expect(result.sub).toBe("existing");
    });
  });

  describe("session callback", () => {
    it("copies token.sub into session.user.id", async () => {
      const session = { user: {} };
      const result = await authCallbacks.session({ session, token: { sub: "u1" } });
      expect(result.user.id).toBe("u1");
    });

    it("leaves session unchanged when token.sub is absent", async () => {
      const session = { user: { id: undefined } };
      const result = await authCallbacks.session({ session, token: {} });
      expect(result.user.id).toBeUndefined();
    });
  });
});
