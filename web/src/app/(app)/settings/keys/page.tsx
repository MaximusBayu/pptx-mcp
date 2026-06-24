"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Keys() {
  const [keys, setKeys] = useState<{ id: string; prefix: string; createdAt: string; lastUsedAt: string | null }[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function load() { setKeys(await (await fetch("/api/keys")).json()); }
  useEffect(() => { load(); }, []);
  async function create() {
    const r = await fetch("/api/keys", { method: "POST" });
    setRaw((await r.json()).raw);
    load();
  }
  return (
    <PageTransition>
      <div className="p-8 max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold">API keys</h1>
        <motion.button whileTap={{ scale: 0.97 }} onClick={create}
          className="btn-primary">Create key</motion.button>
        <AnimatePresence>
          {raw && (
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }} className="border rounded p-3 bg-yellow-50 break-all space-y-2">
              <div>Copy now (shown once): <code>{raw}</code></div>
              <button className="btn-primary" onClick={async () => {
                await navigator.clipboard.writeText(raw);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}>{copied ? "Copied!" : "Copy"}</button>
            </motion.div>
          )}
        </AnimatePresence>
        <ul className="space-y-2">
          {keys.map((k) => (
            <li key={k.id} className="flex justify-between border rounded p-2">
              <span><code>pk_{k.prefix}_…</code></span>
              <button className="text-red-600"
                onClick={async () => { if (!window.confirm("Revoke this key? This cannot be undone.")) return; await fetch(`/api/keys/${k.id}`, { method: "DELETE" }); load(); }}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </div>
    </PageTransition>
  );
}
