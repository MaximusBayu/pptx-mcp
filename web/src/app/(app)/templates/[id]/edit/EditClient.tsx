"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TagEditor, type PlacementIssues, type SlideMeta } from "@/components/TagEditor";
import { UploadProgress } from "@/components/UploadProgress";
import type { DraftSlot } from "@/components/SlotPanel";
import { PageTransition } from "@/lib/motion/PageTransition";

type SaveState = "idle" | "saving" | "saved";

export function EditClient({ id, name, slides, previewUrls, previewsPending }:
  { id: string; name: string; slides: any[]; previewUrls: string[]; previewsPending?: boolean }) {
  const router = useRouter();
  const [urls, setUrls] = useState<string[]>(previewUrls);
  const [renderState, setRenderState] = useState<"idle" | "rendering" | "error">(
    previewsPending ? "rendering" : "idle",
  );
  const renderPreviews = useCallback(async () => {
    setRenderState("rendering");
    try {
      const r = await fetch(`/api/templates/${id}/base-previews`, { method: "POST" });
      if (!r.ok) throw new Error("render failed");
      const data = await r.json();
      setUrls(data.previewUrls ?? []);
      setRenderState("idle");
    } catch {
      setRenderState("error");
    }
  }, [id]);
  useEffect(() => {
    if (previewsPending) renderPreviews();
  }, [previewsPending, renderPreviews]);
  const [slots, setSlots] = useState<Record<string, DraftSlot>>({});
  const [saveErr, setSaveErr] = useState("");
  const [overlapWarn, setOverlapWarn] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [issues, setIssues] = useState<PlacementIssues>({ offSlide: [], overlapping: [] });

  const handleIssues = useCallback((next: PlacementIssues) => setIssues(next), []);

  const [slideMeta, setSlideMeta] = useState<Record<number, SlideMeta>>(() => {
    const m: Record<number, SlideMeta> = {};
    for (const sl of slides) {
      m[sl.index] = {
        name: sl.suggested_name ?? "",
        description: sl.suggested_description ?? "",
        repeatable: sl.repeatable ?? false,
      };
    }
    return m;
  });
  function onSlideMeta(slideIndex: number, meta: SlideMeta) {
    setSlideMeta((m) => ({ ...m, [slideIndex]: meta }));
  }

  const [moves, setMoves] = useState<Record<string, { slide_index: number; shape_id: number; bbox_pct: { x: number; y: number; w: number; h: number } }>>({});

  function onMove(slideIndex: number, shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    setMoves((m) => ({ ...m, [`${slideIndex}:${shapeId}`]: { slide_index: slideIndex, shape_id: shapeId, bbox_pct: bbox } }));
  }

  async function save() {
    setSaveErr("");
    setOverlapWarn("");

    // Off-slide is a soft heads-up (bleed is often intentional). Overlap is not
    // warned: layered slide designs overlap by nature, so it was pure noise.
    // De-dupe ids and cap the list so a dense deck can't spam a wall of text.
    const offIds = Array.from(new Set(issues.offSlide));
    if (offIds.length > 0) {
      const shown = offIds.slice(0, 8).join(", ");
      const more = offIds.length > 8 ? ` +${offIds.length - 8} more` : "";
      setOverlapWarn(`Off-slide (intentional bleed?): ${shown}${more}`);
    }

    setSaveState("saving");
    try {
      const slideTypes = slides.map((_sl, idx) => {
        const meta = slideMeta[idx];
        return {
          id: `slide_${idx}`,
          kind: (_sl as any)?.kind ?? "",
          name: meta?.name ?? "",
          description: meta?.description ?? "",
          repeatable: meta?.repeatable ?? false,
          source_slide_index: idx,
          slots: Object.values(slots)
            .filter((s) => s.slideIndex === idx && s.id)
            .map((s) => ({
              id: s.id, name: s.name, type: s.type, shape_id: s.shape_id,
              constraints: s.constraints,
              description: s.description ?? "", example: s.example ?? "",
            })),
        };
      });
      const res = await fetch(`/api/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, slideTypes, moves: Object.values(moves) }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setSaveErr(`Failed to save: ${res.statusText}`);
        setSaveState("idle");
        return;
      }
      // Show "Saved" briefly, then return to the dashboard.
      setSaveState("saved");
      setTimeout(() => router.push("/dashboard"), 900);
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : "Save failed");
      setSaveState("idle");
    }
  }

  const taggedCount = Object.values(slots).filter((s) => s.id).length;

  return (
    <PageTransition>
      <div className="p-8 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{name}</h1>
          <div className="flex items-center gap-4 text-sm">
            <a href={`/templates/${id}/use`} className="text-gray-500 hover:text-black">Use / integrate →</a>
            <a href="/dashboard" className="text-gray-500 hover:text-black">← Back to my templates</a>
          </div>
        </div>
        <div className="rounded-lg border bg-blue-50 text-sm text-gray-700 p-4 space-y-1">
          <p className="font-medium text-gray-900">Tag the parts an agent should fill</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Click a highlighted box on the slide to select a shape.</li>
            <li>Give it a <strong>Slot id</strong> (e.g. <code>title</code>, <code>body</code>) — this is the name the agent fills.</li>
            <li>Optionally drag a box to reposition it. Untagged shapes keep their template default.</li>
            <li>Click <strong>Save template</strong> when done.</li>
          </ol>
          <p className="text-gray-500">
            {taggedCount === 0
              ? "No slots tagged yet — an agent won't be able to fill anything until you tag at least one."
              : `${taggedCount} slot${taggedCount === 1 ? "" : "s"} tagged.`}
          </p>
        </div>
        {renderState === "rendering" ? (
          <UploadProgress stage="Rendering previews…" />
        ) : renderState === "error" ? (
          <div className="space-y-2">
            <p className="text-red-600 text-sm">Preview render failed.</p>
            <button onClick={renderPreviews} className="btn-primary">Retry</button>
          </div>
        ) : (
          <TagEditor
            slides={slides}
            previewUrls={urls}
            onChange={setSlots}
            onMove={onMove}
            onIssues={handleIssues}
            onSlideMeta={onSlideMeta}
          />
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={save}
            disabled={saveState !== "idle" || renderState === "rendering"}
            className="btn-primary disabled:opacity-50"
          >
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save template"}
          </motion.button>
          <AnimatePresence>
            {saveState === "saved" && (
              <motion.span
                initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="text-green-600 text-sm">
                Template saved — returning to your templates…
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {saveErr && <p className="text-red-600 text-sm">{saveErr}</p>}
        {overlapWarn && <p className="text-amber-600 text-sm">{overlapWarn}</p>}
      </div>
    </PageTransition>
  );
}
