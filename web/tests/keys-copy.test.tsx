// @vitest-environment jsdom
// web/tests/keys-copy.test.tsx
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Keys from "@/app/(app)/settings/keys/page";

vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const motionCache: Record<string, React.ComponentType<any>> = {};
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(actual.motion, {
      get(_t, prop: string) {
        if (!motionCache[prop]) {
          motionCache[prop] = ({ children, onClick, className }: any) => {
            const Tag = prop as keyof JSX.IntrinsicElements;
            return <Tag onClick={onClick} className={className}>{children}</Tag>;
          };
        }
        return motionCache[prop];
      },
    }),
  };
});

const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
  (global as any).fetch = vi.fn(async (url: string, opts?: any) => {
    if (opts?.method === "POST") return { json: async () => ({ raw: "pk_x_y" }) };
    return { json: async () => [] };  // GET list
  });
});
afterEach(() => vi.restoreAllMocks());

describe("keys page copy button", () => {
  it("copies the freshly-minted key to the clipboard", async () => {
    render(<Keys />);
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    const copyBtn = await screen.findByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pk_x_y"));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeTruthy();
  });
});
