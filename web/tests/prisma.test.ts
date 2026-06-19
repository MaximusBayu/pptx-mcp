import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";

describe("prisma schema", () => {
  it("exposes Template and ApiKey models", () => {
    expect(Prisma.ModelName.Template).toBe("Template");
    expect(Prisma.ModelName.ApiKey).toBe("ApiKey");
  });
});
