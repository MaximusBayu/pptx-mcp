import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.DATABASE_URL ??
  (process.env.NODE_ENV === "production"
    ? (() => { throw new Error("DATABASE_URL is required in production"); })()
    : "postgresql://localhost:5432/pptx");

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl,
  },
});
