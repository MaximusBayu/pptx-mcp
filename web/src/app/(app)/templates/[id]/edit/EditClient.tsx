"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { TagEditor, type PlacementIssues } from "@/components/TagEditor";
import type { DraftSlot } from "@/components/SlotPanel";
import { PageTransition } from "@/lib/motion/PageTransition";

type SaveState = "idle" | "saving" | "saved";

export function EditClient({ id, name, slides, previewUrls }:
  { id: string; name: string; slides: any[]; previewUrls: string[] }) {
  const router = useRouter();
  const [slots, setSlots] = useState<Record<string, DraftSlot>>({});
  const [saveErr, setSaveErr] = useState("");
  const [overlapWarn, setOverlapWarn] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [issues, setIssues] = useState<PlacementIssues>({ offSlide: [], overlapping: [] });

  const handleIssues = useCallback((next: PlacementIssues) => setIssues(next), []);

  async function onMove(shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    await fetch(`/api/templates/${id}/move-shape`, {
      method: "POST", body: JSON.stringify({ shape_id: shapeId, bbox_pct: bbox }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async function save() {
    setSaveErr("");
    setOverlapWarn("");

    // Hard-block: any slot off-slide
    if (issues.offSlide.length > 0) {
      setSaveErr(
        `Move these slots back on-slide before saving: ${issues.offSlide.join(", ")}`
      );
      return;
    }

    // Soft warning: overlapping slots — show but still allow save to proceed
    if (issues.overlapping.length > 0) {
      setOverlapWarn(
        `Overlapping slots: ${issues.overlapping.map((p) => p.join("+")).join(", ")}`
      );
    }

    setSaveState("saving");
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
  const hasOffSlide = issues.offSlide.length > 0;

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
        <TagEditor
          slides={slides}
          previewUrls={previewUrls}
          onChange={setSlots}
          onMove={onMove}
          onIssues={handleIssues}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={save}
            disabled={saveState !== "idle" || hasOffSlide}
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
