import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { user: { create: (a: any) => create(a), findUnique: (a: any) => findUnique(a) } } }));

import { POST } from "@/app/api/register/route";

beforeEach(() => { create.mockReset(); findUnique.mockReset(); });

function req(body: any) {
  return new Request("http://x/api/register", { method: "POST", body: JSON.stringify(body) });
}

describe("register", () => {
  it("rejects short password", async () => {
    const r = await POST(req({ email: "a@b.com", password: "123" }));
    expect(r.status).toBe(400);
  });

  it("rejects existing email", async () => {
    findUnique.mockResolvedValue({ id: "1" });
    const r = await POST(req({ email: "a@b.com", password: "longenough" }));
    expect(r.status).toBe(400);
  });

  it("creates user with hashed password", async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "1", email: "a@b.com" });
    const r = await POST(req({ email: "a@b.com", password: "longenough" }));
    expect(r.status).toBe(201);
    const arg = create.mock.calls[0][0];
    expect(arg.data.passwordHash).not.toBe("longenough");
    expect(arg.data.passwordHash.length).toBeGreaterThan(20);
    expect(arg.data.passwordHash.startsWith("$2b$12$")).toBe(true);
  });
});
