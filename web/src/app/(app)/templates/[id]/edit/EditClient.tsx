"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { TagEditor } from "@/components/TagEditor";
import type { DraftSlot } from "@/components/SlotPanel";
import { PageTransition } from "@/lib/motion/PageTransition";

export function EditClient({ id, name, slides, previewUrls }:
  { id: string; name: string; slides: any[]; previewUrls: string[] }) {
  const [slots, setSlots] = useState<Record<string, DraftSlot>>({});

  async function onMove(shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    await fetch(`/api/templates/${id}/move-shape`, {
      method: "POST", body: JSON.stringify({ shape_id: shapeId, bbox_pct: bbox }),
    });
  }

  async function save() {
    const slideTypes = slides.map((sl, idx) => ({
      id: `slide_${idx}`, name: `Slide ${idx + 1}`, source_slide_index: idx,
      slots: Object.values(slots).filter((s) =>
        sl.shapes.some((sh: any) => sh.shape_id === s.shape_id) && s.id),
    }));
    await fetch(`/api/templates/${id}`, { method: "PUT", body: JSON.stringify({ name, slideTypes }) });
  }

  return (
    <PageTransition>
      <div className="p-8 space-y-4">
        <h1 className="text-xl font-semibold">{name}</h1>
        <TagEditor slides={slides} previewUrls={previewUrls} value={slots} onChange={setSlots} onMove={onMove} />
        <motion.button whileTap={{ scale: 0.97 }} onClick={save}
          className="bg-black text-white px-4 py-2 rounded">Save template</motion.button>
      </div>
    </PageTransition>
  );
}
