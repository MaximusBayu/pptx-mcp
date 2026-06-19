import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DashboardGrid } from "./DashboardGrid";

export default async function Dashboard() {
  const session = await auth();
  const templates = session?.user?.id
    ? await prisma.template.findMany({ where: { ownerId: session.user.id }, orderBy: { updatedAt: "desc" } })
    : [];
  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">My templates</h1>
        <a href="/templates/new" className="bg-black text-white px-4 py-2 rounded">New</a>
      </div>
      <DashboardGrid templates={templates.map((t) => ({ id: t.id, name: t.name, description: t.description }))} />
    </div>
  );
}
