"use client";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import { useState } from "react";
import Link from "next/link";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <PageTransition>
      <div className="mx-auto max-w-sm p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <input aria-label="Email" className="w-full border p-2 rounded" placeholder="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <input aria-label="Password" className="w-full border p-2 rounded" type="password" placeholder="password"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <motion.button whileTap={{ scale: 0.97 }} className="w-full bg-black text-white p-2 rounded"
          onClick={() => signIn("credentials", { email, password, callbackUrl: "/dashboard" })}>
          Sign in
        </motion.button>
        <div className="flex gap-2">
          <motion.button whileTap={{ scale: 0.97 }} className="flex-1 border p-2 rounded"
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}>Google</motion.button>
          <motion.button whileTap={{ scale: 0.97 }} className="flex-1 border p-2 rounded"
            onClick={() => signIn("github", { callbackUrl: "/dashboard" })}>GitHub</motion.button>
        </div>
        <Link className="text-sm underline" href="/register">Create account</Link>
      </div>
    </PageTransition>
  );
}
