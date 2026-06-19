import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { apiKey: { findUnique: (a: any) => findUnique(a), update: (a: any) => update(a) } } }));

import { generateApiKey, verifyApiKey } from "@/lib/apiKey";

beforeEach(() => { findUnique.mockReset(); update.mockReset(); });

describe("api key", () => {
  it("generates raw with prefix and bcrypt hash", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    expect(raw.startsWith(`pk_${prefix}_`)).toBe(true);
    expect(hash).not.toContain(raw);
  });

  it("verifies a valid key", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    findUnique.mockResolvedValue({ id: "k1", userId: "u1", prefix, hash });
    update.mockResolvedValue({});
    expect(await verifyApiKey(raw)).toBe("u1");
  });

  it("rejects a tampered key", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    findUnique.mockResolvedValue({ id: "k1", userId: "u1", prefix, hash });
    expect(await verifyApiKey(raw.slice(0, -1) + "0")).toBeNull();
  });

  it("rejects unknown prefix", async () => {
    findUnique.mockResolvedValue(null);
    expect(await verifyApiKey("pk_deadbeef_secret")).toBeNull();
  });
});
