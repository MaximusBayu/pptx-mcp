"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { cardItem, staggerContainer } from "@/lib/motion/variants";

type T = { id: string; name: string; description: string };

export function DashboardGrid({ templates }: { templates: T[] }) {
  const router = useRouter();

  async function rename(t: T) {
    const name = window.prompt("Rename template", t.name);
    if (!name || name === t.name) return;
    await fetch(`/api/templates/${t.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    router.refresh();
  }

  async function remove(t: T) {
    if (!window.confirm(`Delete "${t.name}"? This cannot be undone.`)) return;
    await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
    router.refresh();
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-12 text-center text-gray-500">
        <p className="mb-3">No templates yet.</p>
        <a href="/templates/new" className="btn-primary">Upload your first .pptx</a>
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="initial" animate="animate"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((t) => (
        <motion.div key={t.id} variants={cardItem}
          whileHover={{ y: -4 }} className="card flex flex-col">
          <a href={`/templates/${t.id}/edit`} className="block flex-1">
            <h3 className="font-semibold">{t.name}</h3>
            <p className="text-sm text-gray-500 line-clamp-2">{t.description}</p>
          </a>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <a href={`/templates/${t.id}/edit`} className="text-gray-600 hover:text-black">Edit</a>
            <a href={`/templates/${t.id}/use`} className="text-gray-600 hover:text-black">Use</a>
            <button onClick={() => rename(t)} className="text-gray-600 hover:text-black">Rename</button>
            <button onClick={() => remove(t)} className="ml-auto text-red-600 hover:text-red-700">Delete</button>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
}
