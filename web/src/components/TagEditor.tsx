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
  suggested_max_rows?: number; suggested_max_cols?: number;
};
type Slide = { index: number; shapes: Shape[] };
type Slots = Record<string, DraftSlot>;

export type PlacementIssues = { offSlide: string[]; overlapping: [string, string][] };

type EditorState = { slots: Slots; bboxOverrides: Record<string, Box> };

/** Composite key that is unique across the whole deck: "${slideIndex}:${shapeId}". */
export function slotKey(slideIndex: number, shapeId: number): string {
  return `${slideIndex}:${shapeId}`;
}

function shapeClass(tagged: boolean, conf: number, reduced: boolean | null): string {
  if (!tagged) return "border border-dashed border-neutral-300/40 bg-transparent";
  if (conf >= 0.75) return "border-2 border-matcha-500 bg-matcha-500/10";
  return `border-2 border-dashed border-amber-500 bg-amber-500/10${reduced ? "" : " animate-pulse"}`;
}

export function buildInitialSlots(slides: Slide[]): Slots {
  const slots: Slots = {};
  for (const slide of slides) {
    for (const s of slide.shapes) {
      if (s.is_candidate) {
        const key = slotKey(slide.index, s.shape_id);
        const constraints: Record<string, number | string> = {};
        if (s.suggested_max_chars) constraints.max_chars = s.suggested_max_chars;
        if (s.suggested_max_lines) constraints.max_lines = s.suggested_max_lines;
        if (s.suggested_max_rows) constraints.max_rows = s.suggested_max_rows;
        if (s.suggested_max_cols) constraints.max_cols = s.suggested_max_cols;
        slots[key] = {
          shape_id: s.shape_id,
          slideIndex: slide.index,
          id: s.suggested_id ?? "",
          name: s.name,
          type: (s.type as DraftSlot["type"]) ?? "text",
          constraints,
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
  // Selected key is a composite key "${slideIndex}:${shapeId}"
  const [selected, setSelected] = useState<string | null>(null);

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

  function bboxFor(slideIndex: number, shapeId: number): Box {
    const key = slotKey(slideIndex, shapeId);
    if (hist.present.bboxOverrides[key]) return hist.present.bboxOverrides[key];
    // Only look up within the correct slide to avoid cross-slide collisions.
    const shape = slides[slideIndex]?.shapes.find((sh) => sh.shape_id === shapeId);
    return shape?.bbox_pct ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  // Compute placement issues from all tagged slots across all slides.
  // Each slot contributes its slide-correct bbox; the issue label uses the slot's id string.
  const issues = useMemo<PlacementIssues>(
    () =>
      placementIssues(
        Object.values(hist.present.slots)
          .filter((s) => s.id)
          .map((s) => ({ id: s.id, box: bboxFor(s.slideIndex, s.shape_id) }))
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
    const key = slotKey(slot.slideIndex, slot.shape_id);
    setHist((h) =>
      pushState(h, {
        ...h.present,
        slots: { ...h.present.slots, [key]: slot },
      })
    );
  }

  function handleDragEnd(slideIndex: number, shapeId: number, point: { x: number; y: number }) {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || !onMove) return;
    const nx = ((point.x - box.left) / box.width) * 100;
    const ny = ((point.y - box.top) / box.height) * 100;
    const existing = bboxFor(slideIndex, shapeId);
    const newBbox: Box = { ...existing, x: Math.max(0, nx), y: Math.max(0, ny) };
    const bboxKey = slotKey(slideIndex, shapeId);
    setHist((h) =>
      pushState(h, {
        ...h.present,
        bboxOverrides: { ...h.present.bboxOverrides, [bboxKey]: newBbox },
      })
    );
    onMove(shapeId, newBbox);
  }

  const offSlideIds = new Set(issues.offSlide);

  return (
    <div className="flex gap-6">
      {/* overflow-hidden clips off-slide / bleed shapes to the slide bounds so
          they cannot paint or intercept clicks over controls (e.g. the Save
          button) that sit below this canvas in normal flow. */}
      <div
        ref={containerRef}
        data-testid="slide-canvas"
        className="relative w-[640px] aspect-video bg-gray-100 overflow-hidden"
      >
        {previewUrls[slideIdx] && (
          <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />
        )}
        {slide.shapes.map((s) => {
          const key = slotKey(slideIdx, s.shape_id);
          const slot = hist.present.slots[key];
          const tagged = Boolean(slot?.id);
          const conf = s.confidence ?? (tagged ? 1 : 0);
          const bbox = bboxFor(slideIdx, s.shape_id);
          const isOff = offSlideIds.has(slot?.id ?? "");

          let cls = shapeClass(tagged, conf, reduced);
          if (isOff) cls = "border-2 border-red-500 bg-red-500/10";

          return (
            <motion.button
              key={s.shape_id}
              aria-label={`shape ${s.name}`}
              onClick={() => setSelected(key)}
              drag={!!onMove}
              dragMomentum={false}
              onDragEnd={(_e, info) => handleDragEnd(slideIdx, s.shape_id, info.point)}
              whileHover={reduced ? undefined : { scale: 1.02 }}
              animate={
                selected === key ? { borderColor: "#2563eb" } : undefined
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
        {selected != null && (() => {
          const selSlot = hist.present.slots[selected];
          if (!selSlot) {
            // Shape clicked but no slot entry yet — parse composite key for context
            const [siStr, shStr] = selected.split(":");
            const si = Number(siStr);
            const shId = Number(shStr);
            const sh = slides[si]?.shapes.find((x) => x.shape_id === shId);
            return (
              <SlotPanel
                slot={{
                  shape_id: shId,
                  slideIndex: si,
                  id: "",
                  name: sh?.name ?? "",
                  type: (sh?.type as DraftSlot["type"]) ?? "text",
                  constraints: {},
                }}
                onChange={updateSlot}
              />
            );
          }
          return <SlotPanel slot={selSlot} onChange={updateSlot} />;
        })()}
      </div>
    </div>
  );
}
