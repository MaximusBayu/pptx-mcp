import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { apiKey: { create: (a: any) => create(a) } } }));

import { mintApiKey } from "@/lib/apiKey";

beforeEach(() => create.mockReset());

describe("mintApiKey", () => {
  it("creates a key and returns a raw pk_ string", async () => {
    create.mockResolvedValue({});
    const raw = await mintApiKey("u1");
    expect(raw.startsWith("pk_")).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.userId).toBe("u1");
  });

  it("retries once on a P2002 prefix collision", async () => {
    create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({});
    const raw = await mintApiKey("u1");
    expect(raw.startsWith("pk_")).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
