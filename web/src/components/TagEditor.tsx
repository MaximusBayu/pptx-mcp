"use client";
import { motion, useReducedMotion, type PanInfo } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";
import { placementIssues, type Box } from "@/lib/placement";
import {
  canvasExtent, toCanvasPct, fromCanvasOffset, clampToExtent, canvasHeightPx,
  type Extent,
} from "@/lib/canvasView";
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
type Slide = { index: number; shapes: Shape[]; width_emu?: number; height_emu?: number };
type Slots = Record<string, DraftSlot>;

export type PlacementIssues = { offSlide: string[]; overlapping: [string, string][] };

type EditorState = { slots: Slots; bboxOverrides: Record<string, Box> };

/** Composite key unique across the deck: "${slideIndex}:${shapeId}". */
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
          shape_id: s.shape_id, slideIndex: slide.index,
          id: s.suggested_id ?? "", name: s.name,
          type: (s.type as DraftSlot["type"]) ?? "text", constraints,
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
  onMove?: (slideIndex: number, shapeId: number, bbox: Box) => void;
  onIssues?: (issues: PlacementIssues) => void;
}) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const [hist, setHist] = useState<History<EditorState>>(() =>
    initHistory({ slots: buildInitialSlots(slides), bboxOverrides: {} })
  );

  useEffect(() => {
    onChange(hist.present.slots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist.present.slots]);

  const slide = slides[slideIdx];

  function bboxFor(slideIndex: number, shapeId: number): Box {
    const key = slotKey(slideIndex, shapeId);
    if (hist.present.bboxOverrides[key]) return hist.present.bboxOverrides[key];
    const shape = slides[slideIndex]?.shapes.find((sh) => sh.shape_id === shapeId);
    return shape?.bbox_pct ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  // Extended viewport for the current slide: union of slide + all shapes.
  const extent: Extent = useMemo(
    () => canvasExtent(slide.shapes.map((s) => bboxFor(slideIdx, s.shape_id)), 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slide, slideIdx, hist.present.bboxOverrides]
  );

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

  useEffect(() => { onIssues?.(issues); }, [issues, onIssues]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault(); setHist((h) => undo(h));
      }
      if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault(); setHist((h) => redo(h));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function updateSlot(slot: DraftSlot) {
    const key = slotKey(slot.slideIndex, slot.shape_id);
    setHist((h) => pushState(h, { ...h.present, slots: { ...h.present.slots, [key]: slot } }));
  }

  function handleDragEnd(slideIndex: number, shapeId: number, info: PanInfo) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !onMove) return;
    const { dx, dy } = fromCanvasOffset(
      { x: info.offset.x, y: info.offset.y }, extent, { w: rect.width, h: rect.height }
    );
    const existing = bboxFor(slideIndex, shapeId);
    const moved = clampToExtent({ ...existing, x: existing.x + dx, y: existing.y + dy }, extent);
    const key = slotKey(slideIndex, shapeId);
    setHist((h) => pushState(h, {
      ...h.present, bboxOverrides: { ...h.present.bboxOverrides, [key]: moved },
    }));
    onMove(slideIndex, shapeId, moved);
  }

  const offSlideIds = new Set(issues.offSlide);
  const frame = toCanvasPct({ x: 0, y: 0, w: 100, h: 100 }, extent);
  // Slide aspect ratio (width:height). bbox x/w and y/h are percent of slide
  // width vs height respectively, so the canvas must honor the slide's real
  // aspect or the frame collapses to a square and the preview letterboxes.
  const slideAR = slide.width_emu && slide.height_emu
    ? slide.width_emu / slide.height_emu
    : 16 / 9;

  return (
    <div className="flex gap-6">
      {/* overflow-hidden clips off-canvas shapes so they can't intercept
          clicks over controls below. Canvas aspect follows the extent. */}
      <div
        ref={containerRef}
        data-testid="slide-canvas"
        className="relative w-[640px] bg-gray-100 overflow-hidden"
        style={{ height: `${canvasHeightPx(640, extent, slideAR)}px` }}
      >
        {/* slide reference frame */}
        <div
          data-testid="slide-frame"
          className="absolute border-2 border-neutral-400/70 pointer-events-none"
          style={{ left: `${frame.x}%`, top: `${frame.y}%`, width: `${frame.w}%`, height: `${frame.h}%` }}
        >
          {previewUrls[slideIdx] && (
            <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />
          )}
        </div>

        {[...slide.shapes]
          .sort((a, b) =>
            (b.bbox_pct.w * b.bbox_pct.h) - (a.bbox_pct.w * a.bbox_pct.h))
          .map((s) => {
          const key = slotKey(slideIdx, s.shape_id);
          const slot = hist.present.slots[key];
          const tagged = Boolean(slot?.id);
          const conf = s.confidence ?? (tagged ? 1 : 0);
          const cv = toCanvasPct(bboxFor(slideIdx, s.shape_id), extent);
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
              dragSnapToOrigin
              // Instant snap on drop — the persisted left/top is the final
              // position; no tween animating the box back to origin.
              transition={{ duration: 0 }}
              onDragEnd={(_e, info) => handleDragEnd(slideIdx, s.shape_id, info)}
              whileHover={reduced ? undefined : { scale: 1.02 }}
              animate={selected === key ? { borderColor: "#2563eb" } : undefined}
              className={`absolute ${cls}`}
              style={{ left: `${cv.x}%`, top: `${cv.y}%`, width: `${cv.w}%`, height: `${cv.h}%` }}
            />
          );
        })}
      </div>

      <div className="w-72 space-y-3">
        <div className="flex gap-2">
          <button aria-label="Undo" disabled={!canUndo(hist)}
            onClick={() => setHist((h) => undo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40">↩ Undo</button>
          <button aria-label="Redo" disabled={!canRedo(hist)}
            onClick={() => setHist((h) => redo(h))}
            className="px-2 py-1 border rounded text-sm disabled:opacity-40">Redo ↪</button>
        </div>
        <div className="flex gap-2">
          {slides.map((s, i) => (
            <button key={i} onClick={() => setSlideIdx(i)}
              className={`px-2 py-1 border rounded ${i === slideIdx ? "bg-black text-white" : ""}`}>
              {i + 1}
            </button>
          ))}
        </div>
        <div className="border rounded p-2 space-y-1 max-h-48 overflow-auto">
          <p className="text-xs font-medium text-neutral-500">Layers</p>
          {slide.shapes.map((s) => {
            const key = slotKey(slideIdx, s.shape_id);
            const tagged = Boolean(hist.present.slots[key]?.id);
            return (
              <button
                key={s.shape_id}
                aria-label={`layer ${s.name}`}
                onClick={() => setSelected(key)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm rounded hover:bg-neutral-100 ${selected === key ? "bg-neutral-100" : ""}`}
              >
                <span className={`inline-block w-2 h-2 rounded-full ${tagged ? "bg-matcha-500" : "bg-neutral-300"}`} />
                <span className="truncate">{s.name}</span>
              </button>
            );
          })}
        </div>
        {selected != null && (() => {
          const selSlot = hist.present.slots[selected];
          if (!selSlot) {
            const [siStr, shStr] = selected.split(":");
            const si = Number(siStr); const shId = Number(shStr);
            const sh = slides[si]?.shapes.find((x) => x.shape_id === shId);
            return (
              <SlotPanel
                slot={{
                  shape_id: shId, slideIndex: si, id: "", name: sh?.name ?? "",
                  type: (sh?.type as DraftSlot["type"]) ?? "text", constraints: {},
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
