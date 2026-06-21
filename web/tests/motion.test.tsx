import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("framer-motion", async (orig) => {
  const actual = await orig<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => true };
});

import { PageTransition } from "@/lib/motion/PageTransition";
import { MotionProvider } from "@/lib/motion/MotionProvider";

describe("PageTransition", () => {
  it("renders children (reduced motion)", () => {
    render(<MotionProvider><PageTransition><span>hello</span></PageTransition></MotionProvider>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
