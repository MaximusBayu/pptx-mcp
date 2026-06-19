"use client";
import { useReducedMotion } from "framer-motion";
import { createContext, useContext } from "react";

const Ctx = createContext(true);
export const useMotionEnabled = () => useContext(Ctx);

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return <Ctx.Provider value={!reduced}>{children}</Ctx.Provider>;
}
