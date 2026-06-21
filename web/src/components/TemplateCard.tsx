"use client";
import { motion } from "framer-motion";
import { cardItem } from "@/lib/motion/variants";

export function TemplateCard({ name, description, href }:
  { name: string; description: string; href: string }) {
  return (
    <motion.a href={href} variants={cardItem}
      whileHover={{ y: -4, scale: 1.01 }} whileTap={{ scale: 0.99 }}
      className="block rounded-xl border p-5 shadow-sm">
      <h3 className="font-semibold">{name}</h3>
      <p className="text-sm text-gray-500 line-clamp-2">{description}</p>
    </motion.a>
  );
}
