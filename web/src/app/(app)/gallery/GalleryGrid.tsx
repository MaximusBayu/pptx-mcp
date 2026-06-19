"use client";
import { motion } from "framer-motion";
import { TemplateCard } from "@/components/TemplateCard";
import { staggerContainer } from "@/lib/motion/variants";

export function GalleryGrid({ templates }: { templates: { id: string; name: string; description: string }[] }) {
  return (
    <motion.div variants={staggerContainer} initial="initial" animate="animate"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((t) => (
        <TemplateCard key={t.id} name={t.name} description={t.description} href={`/templates/${t.id}/edit`} />
      ))}
    </motion.div>
  );
}
