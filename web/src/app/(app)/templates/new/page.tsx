"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function NewTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function upload(file: File) {
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/templates", { method: "POST", body: fd });
      if (r.ok) {
        router.push(`/templates/${(await r.json()).id}/edit`);
      } else {
        setErr("Upload failed. Please try again.");
      }
    } catch (e) {
      setErr("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageTransition>
      <div className="mx-auto max-w-lg p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Upload a .pptx template</h1>
        {err && <p className="text-red-600">{err}</p>}
        <motion.label whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
          className="block border-2 border-dashed border-matcha-400 rounded-xl p-10 text-center cursor-pointer text-matcha-700 hover:bg-matcha-50 transition-colors">
          {busy ? "Uploading…" : "Click to choose a .pptx"}
          <input type="file" accept=".pptx" hidden disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </motion.label>
      </div>
    </PageTransition>
  );
}
