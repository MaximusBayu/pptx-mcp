import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const mintApiKey = vi.fn();
vi.mock("@/lib/apiKey", () => ({ mintApiKey: (id: string) => mintApiKey(id) }));

import { mintKeyForEmail } from "@/../scripts/mint-key";

beforeEach(() => mintApiKey.mockReset());

const dbWith = (user: any) => ({ user: { findUnique: vi.fn(async () => user) } });

describe("mintKeyForEmail", () => {
  it("mints for an existing user", async () => {
    mintApiKey.mockResolvedValue("pk_a_b");
    const db = dbWith({ id: "u1" });
    const out = await mintKeyForEmail(db as any, "a@b.com");
    expect(out).toEqual({ raw: "pk_a_b" });
    expect(mintApiKey).toHaveBeenCalledWith("u1");
  });

  it("returns an error for an unknown user and does not mint", async () => {
    const db = dbWith(null);
    const out = await mintKeyForEmail(db as any, "missing@b.com");
    expect(out).toEqual({ error: "no user with email missing@b.com" });
    expect(mintApiKey).not.toHaveBeenCalled();
  });
});
