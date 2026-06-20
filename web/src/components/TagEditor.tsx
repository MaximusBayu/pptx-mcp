"use client";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";
import { placementIssues, type Box } from "@/lib/placement";
import {
  initHistory, pushState, undo, redo, canUndo, canRedo,
  type History,
} from "@/lib/editorHistory";

type Shape = {
  shape_id: number; name: string; type: string;
  bbox_pct: { x: number; y: number; w: number; h: number };
  confidence?: number; is_candidate?: boolean;
  suggested_id?: string; suggested_max_chars?: number;
  suggested_max_lines?: number;
};
type Slide = { index: number; shapes: Shape[] };
type Slots = Record<string, DraftSlot>;

export type PlacementIssues = { offSlide: string[]; overlapping: [string, string][] };

type EditorState = { slots: Slots; bboxOverrides: Record<number, Box> };

function shapeClass(tagged: boolean, conf: number, reduced: boolean | null): string {
  if (!tagged) return "border border-dashed border-neutral-300/40 bg-transparent";
  if (conf >= 0.75) return "border-2 border-matcha-500 bg-matcha-500/10";
  return `border-2 border-dashed border-amber-500 bg-amber-500/10${reduced ? "" : " animate-pulse"}`;
}

function buildInitialSlots(slides: Slide[]): Slots {
  const slots: Slots = {};
  for (const slide of slides) {
    for (const s of slide.shapes) {
      if (s.is_candidate) {
        slots[s.shape_id] = {
          shape_id: s.shape_id,
          id: s.suggested_id ?? "",
          name: s.name,
          type: (s.type as DraftSlot["type"]) ?? "text",
          constraints: s.suggested_max_chars ? { max_chars: s.suggested_max_chars } : {},
        };
      }
    }
  }
  return slots;
}

export function TagEditor({
  slides, previewUrls, onChange, onMove, onIssues,
}: {
  slides: Slide[];
  previewUrls: string[];
  onChange: (s: Slots) => void;
  onMove?: (shapeId: number, bbox: Box) => void;
  onIssues?: (issues: PlacementIssues) => void;
}) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  // History holds { slots, bboxOverrides }. Initial slots are seeded from candidates.
  const [hist, setHist] = useState<History<EditorState>>(() =>
    initHistory({ slots: buildInitialSlots(slides), bboxOverrides: {} })
  );

  // Keep parent in sync with present slots
  useEffect(() => {
    onChange(hist.present.slots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist.present.slots]);

  const slide = slides[slideIdx];

  function bboxFor(shapeId: number): Box {
    if (hist.present.bboxOverrides[shapeId]) return hist.present.bboxOverrides[shapeId];
    const shape = slides.flatMap((sl) => sl.shapes).find((sh) => sh.shape_id === shapeId);
    return shape?.bbox_pct ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  // Compute placement issues from all tagged slots across all slides
  const issues = useMemo<PlacementIssues>(
    () =>
      placementIssues(
        Object.values(hist.present.slots)
          .filter((s) => s.id)
          .map((s) => ({ id: s.id, box: bboxFor(s.shape_id) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hist.present]
  );

  useEffect(() => {
    onIssues?.(issues);
  }, [issues, onIssues]);

  // Undo/redo keyboard handling
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        setHist((h) => undo(h));
      }
      if (
        e.ctrlKey &&
        (e.key.toLowerCase() === "y" ||
          (e.shiftKey && e.key.toLowerCase() === "z"))
      ) {
        e.preventDefault();
        setHist((h) => redo(h));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function updateSlot(slot: DraftSlot) {
    setHist((h) =>
      pushState(h, {
        ...h.present,
        slots: { ...h.present.slots, [slot.shape_id]: slot },
      })
    );
  }

  function handleDragEnd(shapeId: number, point: { x: number; y: number }) {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || !onMove) return;
    const nx = ((point.x - box.left) / box.width) * 100;
    const ny = ((point.y - box.top) / box.height) * 100;
    const existing = bboxFor(shapeId);
    const newBbox: Box = { ...existing, x: Math.max(0, nx), y: Math.max(0, ny) };
    setHist((h) =>
      pushState(h, {
        ...h.present,
        bboxOverrides: { ...h.present.bboxOverrides, [shapeId]: newBbox },
      })
    );
    onMove(shapeId, newBbox);
  }

  const offSlideIds = new Set(issues.offSlide);

  return (
    <div className="flex gap-6">
      <div ref={containerRef} className="relative w-[640px] aspect-video bg-gray-100">
        {previewUrls[slideIdx] && (
          <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />
        )}
        {slide.shapes.map((s) => {
          const slot = hist.present.slots[s.shape_id];
          const tagged = Boolean(slot?.id);
          const conf = s.confidence ?? (tagged ? 1 : 0);
          const bbox = bboxFor(s.shape_id);
          const isOff = offSlideIds.has(slot?.id ?? "");

          let cls = shapeClass(tagged, conf, reduced);
          if (isOff) cls = "border-2 border-red-500 bg-red-500/10";

          return (
            <motion.button
              key={s.shape_id}
              aria-label={`shape ${s.name}`}
              onClick={() => setSelected(s.shape_id)}
              drag={!!onMove}
              dragMomentum={false}
              onDragEnd={(_e, info) => handleDragEnd(s.shape_id, info.point)}
              whileHover={reduced ? undefined : { scale: 1.02 }}
              animate={
                selected === s.shape_id ? { borderColor: "#2563eb" } : undefined
              }
              className={`absolute ${cls}`}
              style={{
                left: `${bbox.x}%`,
                top: `${bbox.y}%`,
                width: `${bbox.w}%`,
                height: `${bbox.h}%`,
              }}
            />
          );
        })}
      </div>
      <div className="w-72 space-y-3">
        {/* Undo/Redo controls */}
        <div className="flex gap-2">
          <button
            aria-label="Undo"
            disabled={!canUndo(hist)}
            onClick={() => setHist((h) => undo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40"
          >
            ↩ Undo
          </button>
          <button
            aria-label="Redo"
            disabled={!canRedo(hist)}
            onClick={() => setHist((h) => redo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40"
          >
            Redo ↪
          </button>
        </div>
        <div className="flex gap-2">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setSlideIdx(i)}
              className={`px-2 py-1 border rounded ${i === slideIdx ? "bg-black text-white" : ""}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
        {selected != null && (
          <SlotPanel
            slot={
              hist.present.slots[selected] ?? {
                shape_id: selected,
                id: "",
                name: slide.shapes.find((x) => x.shape_id === selected)?.name ?? "",
                type:
                  (slide.shapes.find((x) => x.shape_id === selected)
                    ?.type as DraftSlot["type"]) ?? "text",
                constraints: {},
              }
            }
            onChange={updateSlot}
          />
        )}
      </div>
    </div>
  );
}
