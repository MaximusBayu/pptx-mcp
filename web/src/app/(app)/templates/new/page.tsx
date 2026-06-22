"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";
import { UploadProgress } from "@/components/UploadProgress";
import { uploadTemplate } from "@/lib/upload";

export default function NewTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState("");
  const [pct, setPct] = useState<number | undefined>(undefined);

  async function upload(file: File) {
    setBusy(true);
    setErr("");
    try {
      const { id } = await uploadTemplate(file, (p) => {
        if (p.stage === "uploading") {
          setStage(`Uploading file… ${p.pct}%`);
          setPct(p.pct);
        } else {
          setStage("Analyzing slides…");
          setPct(undefined);
        }
      });
      router.push(`/templates/${id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed. Please try again.");
      setBusy(false);
      setStage("");
      setPct(undefined);
    }
  }

  function pickAndUpload(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pptx")) {
      setErr("Please choose a .pptx file.");
      return;
    }
    upload(file);
  }

  return (
    <PageTransition>
      <div className="mx-auto max-w-lg p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Upload a .pptx template</h1>
        {err && <p className="text-red-600">{err}</p>}
        {busy ? (
          <UploadProgress stage={stage} pct={pct} />
        ) : (
          <motion.label whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pickAndUpload(e.dataTransfer.files?.[0]); }}
            className={`block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer text-matcha-700 transition-colors ${dragging ? "border-matcha-600 bg-matcha-50" : "border-matcha-400 hover:bg-matcha-50"}`}>
            {dragging ? "Drop the .pptx to upload" : "Click or drag a .pptx here"}
            <input type="file" accept=".pptx" hidden
              onChange={(e) => pickAndUpload(e.target.files?.[0])} />
          </motion.label>
        )}
      </div>
    </PageTransition>
  );
}
