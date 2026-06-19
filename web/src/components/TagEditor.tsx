"use client";
import { motion, useReducedMotion } from "framer-motion";
import { useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";

type Shape = { shape_id: number; name: string; type: string; bbox_pct: { x: number; y: number; w: number; h: number } };
type Slide = { index: number; shapes: Shape[] };
type Slots = Record<string, DraftSlot>;

export function TagEditor({ slides, previewUrls, value, onChange, onMove }:
  { slides: Slide[]; previewUrls: string[]; value: Slots; onChange: (s: Slots) => void;
    onMove?: (shapeId: number, bbox: { x: number; y: number; w: number; h: number }) => void }) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const slide = slides[slideIdx];

  const update = (slot: DraftSlot) => onChange({ ...value, [slot.shape_id]: slot });

  return (
    <div className="flex gap-6">
      <div ref={containerRef} className="relative w-[640px] aspect-video bg-gray-100">
        {previewUrls[slideIdx] && <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />}
        {slide.shapes.map((s) => (
          <motion.button key={s.shape_id} aria-label={`shape ${s.name}`}
            onClick={() => setSelected(s.shape_id)}
            drag={!!onMove} dragMomentum={false}
            onDragEnd={(_e, info) => {
              if (!onMove) return;
              const box = containerRef.current?.getBoundingClientRect();
              if (!box) return;
              const nx = ((info.point.x - box.left) / box.width) * 100;
              const ny = ((info.point.y - box.top) / box.height) * 100;
              onMove(s.shape_id, { ...s.bbox_pct, x: Math.max(0, nx), y: Math.max(0, ny) });
            }}
            whileHover={reduced ? undefined : { scale: 1.02 }}
            animate={selected === s.shape_id ? { borderColor: "#2563eb" } : { borderColor: "#9ca3af" }}
            className="absolute border-2 bg-blue-500/10"
            style={{ left: `${s.bbox_pct.x}%`, top: `${s.bbox_pct.y}%`,
                     width: `${s.bbox_pct.w}%`, height: `${s.bbox_pct.h}%` }} />
        ))}
      </div>
      <div className="w-72 space-y-3">
        <div className="flex gap-2">
          {slides.map((s, i) => (
            <button key={i} onClick={() => setSlideIdx(i)}
              className={`px-2 py-1 border rounded ${i === slideIdx ? "bg-black text-white" : ""}`}>{i + 1}</button>
          ))}
        </div>
        {selected != null && (
          <SlotPanel
            slot={value[selected] ?? {
              shape_id: selected,
              id: "", name: slide.shapes.find((x) => x.shape_id === selected)?.name ?? "",
              type: (slide.shapes.find((x) => x.shape_id === selected)?.type as DraftSlot["type"]) ?? "text",
              constraints: {},
            }}
            onChange={update} />
        )}
      </div>
    </div>
  );
}
