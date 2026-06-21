import { describe, it, expect } from "vitest";
import * as s3 from "@/lib/s3";

describe("s3 lib", () => {
  it("exports put/get/presign", () => {
    expect(typeof s3.putObject).toBe("function");
    expect(typeof s3.getObject).toBe("function");
    expect(typeof s3.presignGet).toBe("function");
  });
});
