"use client";
import { motion } from "framer-motion";
import { fadeSlide } from "./variants";
import { useMotionEnabled } from "./MotionProvider";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const enabled = useMotionEnabled();
  if (!enabled) return <div>{children}</div>;
  return (
    <motion.div variants={fadeSlide} initial="initial" animate="animate" exit="exit">
      {children}
    </motion.div>
  );
}
