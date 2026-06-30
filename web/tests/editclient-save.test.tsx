import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditClient } from "@/app/(app)/templates/[id]/edit/EditClient";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Mock PageTransition to avoid motion.div issues in jsdom
vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock TagEditor to avoid its full complexity; it only needs to pass through onSlideMeta
vi.mock("@/components/TagEditor", () => ({
  TagEditor: ({ onSlideMeta }: { onSlideMeta?: (idx: number, meta: any) => void }) => (
    <div data-testid="tag-editor" />
  ),
  // Re-export types that EditClient imports
}));

// Mock framer-motion so motion.button renders as a plain button
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(actual.motion, {
      get(_target, prop: string) {
        // Return a simple passthrough component for any motion.X
        return ({ children, onClick, disabled, className, ...rest }: any) => {
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag onClick={onClick} disabled={disabled} className={className}>{children}</Tag>;
        };
      },
    }),
  };
});

const slides = [
  {
    index: 0,
    shapes: [],
    suggested_name: "finding",
    suggested_description: "Finding slide",
    repeatable: true,
    kind: "finding",
    width_emu: 12192000,
    height_emu: 6858000,
  },
];

describe("EditClient seed from autodetect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let capturedBody: any;

  beforeEach(() => {
    capturedBody = null;
    fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return Promise.resolve({
        ok: true,
        statusText: "OK",
      });
    });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends repeatable=true and name from autodetect on no-touch save", async () => {
    render(
      <EditClient
        id="t1"
        name="T"
        slides={slides}
        previewUrls={[""]}
      />
    );

    const saveBtn = screen.getByRole("button", { name: /save template/i });
    fireEvent.click(saveBtn);

    // Wait for the fetch to be called
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.slideTypes).toHaveLength(1);
    expect(capturedBody.slideTypes[0].repeatable).toBe(true);
    expect(capturedBody.slideTypes[0].name).toBe("finding");
    expect(capturedBody.slideTypes[0].kind).toBe("finding");
  });
});
