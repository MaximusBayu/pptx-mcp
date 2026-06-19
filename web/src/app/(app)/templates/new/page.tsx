"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function NewTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/templates", { method: "POST", body: fd });
    setBusy(false);
    if (r.ok) router.push(`/templates/${(await r.json()).id}/edit`);
  }
  return (
    <PageTransition>
      <div className="mx-auto max-w-lg p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Upload a .pptx template</h1>
        <motion.label whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
          className="block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer">
          {busy ? "Uploading…" : "Click to choose a .pptx"}
          <input type="file" accept=".pptx" hidden disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </motion.label>
      </div>
    </PageTransition>
  );
}
