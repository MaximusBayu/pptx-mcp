"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  async function submit() {
    const r = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (r.ok) signIn("credentials", { email, password, callbackUrl: "/dashboard" });
    else setErr((await r.json()).error ?? "error");
  }
  return (
    <PageTransition>
      <div className="mx-auto max-w-sm p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <input aria-label="Email" className="w-full border p-2 rounded" placeholder="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <input aria-label="Password" className="w-full border p-2 rounded" type="password" placeholder="password (min 8)"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <motion.button whileTap={{ scale: 0.97 }} className="w-full bg-black text-white p-2 rounded"
          onClick={submit}>Sign up</motion.button>
      </div>
    </PageTransition>
  );
}
