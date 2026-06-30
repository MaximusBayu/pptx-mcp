"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

type Props = {
  id: string; name: string; schema: any; example: any; slotCount: number;
};

export function UseClient({ id, name, schema, example, slotCount }: Props) {
  const exampleJson = useMemo(() => JSON.stringify(example, null, 2), [example]);
  const [spec, setSpec] = useState(exampleJson);
  const [busy, setBusy] = useState<"" | "preview" | "render">("");
  const [previews, setPreviews] = useState<string[]>([]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [err, setErr] = useState("");

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-host";
  const curl = `curl -X POST ${origin}/api/mcp/templates/${id}/render \\
  -H "x-api-key: pk_..." \\
  -H "content-type: application/json" \\
  -d '${JSON.stringify({ deck_spec: example })}'`;

  async function run(kind: "preview" | "render") {
    setErr(""); setBusy(kind); setPreviews([]); setDownloadUrl("");
    let deck_spec: any;
    try { deck_spec = JSON.parse(spec); }
    catch { setErr("deck_spec is not valid JSON."); setBusy(""); return; }
    try {
      const res = await fetch(`/api/templates/${id}/${kind}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ deck_spec }),
      });
      const body = await res.json();
      if (body.validation?.length) {
        setErr(body.validation.map((v: any) => `${v.slot_id ?? ""}: ${v.message}`).join("\n"));
      } else if (kind === "preview") {
        setPreviews(body.previews ?? []);
      } else if (body.download_url) {
        setDownloadUrl(body.download_url);
      } else {
        setErr("No output produced.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <PageTransition>
      <div className="p-8 max-w-3xl space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Use &ldquo;{name}&rdquo;</h1>
          <a href={`/templates/${id}/components`} className="text-sm text-blue-600 hover:underline">
            Components
          </a>
          <a href="/dashboard" className="text-sm text-gray-500 hover:text-black">&larr; Back to my templates</a>
        </div>

        <section className="space-y-2">
          <h2 className="font-medium">1. Get an API key</h2>
          <p className="text-sm text-gray-600">
            Create a key on the <a href="/settings/keys" className="underline">API keys</a> page. Give it to your agent.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">2. Slots this template exposes ({slotCount})</h2>
          {schema.slide_types.map((st: any) => (
            <div key={st.id} className="text-sm border rounded p-3">
              <div className="font-mono text-gray-900">{st.id}</div>
              <ul className="mt-1 space-y-0.5">
                {st.slots.map((s: any) => (
                  <li key={s.id} className="text-gray-600">
                    <code>{s.id}</code> &middot; {s.type}{s.required ? " · required" : ""}
                  </li>
                ))}
                {st.slots.length === 0 && <li className="text-gray-400">no slots tagged</li>}
              </ul>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">3. Call the render API</h2>
          <pre className="bg-gray-900 text-gray-100 text-xs rounded p-4 overflow-x-auto whitespace-pre-wrap">{curl}</pre>
          <p className="text-sm text-gray-600">Response: <code>{`{ "download_url": "https://…/file.pptx" }`}</code></p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">4. Test it now</h2>
          <p className="text-sm text-gray-600">Edit the deck_spec and render with your session (no key needed here).</p>
          <textarea value={spec} onChange={(e) => setSpec(e.target.value)} spellCheck={false}
            className="w-full h-56 font-mono text-xs border rounded p-3" />
          <div className="flex gap-3">
            <motion.button whileTap={{ scale: 0.97 }} disabled={busy !== ""} onClick={() => run("preview")}
              className="border px-4 py-2 rounded disabled:opacity-50">
              {busy === "preview" ? "Rendering…" : "Preview (PNG)"}
            </motion.button>
            <motion.button whileTap={{ scale: 0.97 }} disabled={busy !== ""} onClick={() => run("render")}
              className="btn-primary disabled:opacity-50">
              {busy === "render" ? "Rendering…" : "Render .pptx"}
            </motion.button>
          </div>

          {err && <pre className="text-red-600 text-sm whitespace-pre-wrap">{err}</pre>}

          <AnimatePresence>
            {downloadUrl && (
              <motion.a initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                href={downloadUrl} className="inline-block text-blue-600 underline">
                Download rendered .pptx
              </motion.a>
            )}
          </AnimatePresence>

          {previews.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-3">
              {previews.map((u, i) => (
                <img key={i} src={u} alt={`slide ${i + 1}`} className="border rounded w-full" />
              ))}
            </motion.div>
          )}
        </section>
      </div>
    </PageTransition>
  );
}
