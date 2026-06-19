"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { TagEditor } from "@/components/TagEditor";
import type { DraftSlot } from "@/components/SlotPanel";
import { PageTransition } from "@/lib/motion/PageTransition";

export function EditClient({ id, name, slides, previewUrls }:
  { id: string; name: string; slides: any[]; previewUrls: string[] }) {
  const [slots, setSlots] = useState<Record<string, DraftSlot>>({});
  const [saveErr, setSaveErr] = useState("");

  async function onMove(shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    await fetch(`/api/templates/${id}/move-shape`, {
      method: "POST", body: JSON.stringify({ shape_id: shapeId, bbox_pct: bbox }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async function save() {
    try {
      const slideTypes = slides.map((sl, idx) => ({
        id: `slide_${idx}`, name: `Slide ${idx + 1}`, source_slide_index: idx,
        slots: Object.values(slots).filter((s) =>
          sl.shapes.some((sh: any) => sh.shape_id === s.shape_id) && s.id),
      }));
      const res = await fetch(`/api/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, slideTypes }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setSaveErr(`Failed to save: ${res.statusText}`);
        return;
      }
      setSaveErr("");
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : "Save failed");
    }
  }

  return (
    <PageTransition>
      <div className="p-8 space-y-4">
        <h1 className="text-xl font-semibold">{name}</h1>
        <TagEditor slides={slides} previewUrls={previewUrls} value={slots} onChange={setSlots} onMove={onMove} />
        <div>
          <motion.button whileTap={{ scale: 0.97 }} onClick={save}
            className="bg-black text-white px-4 py-2 rounded">Save template</motion.button>
          {saveErr && <p className="text-red-600 mt-2">{saveErr}</p>}
        </div>
      </div>
    </PageTransition>
  );
}
