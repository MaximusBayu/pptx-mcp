import { prisma } from "@/lib/prisma";

export function listPublicTemplates() {
  return prisma.template.findMany({ where: { visibility: "PUBLIC" }, orderBy: { updatedAt: "desc" } });
}
