// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditClient } from "@/app/(app)/templates/[id]/edit/EditClient";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/TagEditor", () => ({
  TagEditor: ({ previewUrls }: { previewUrls: string[] }) => (
    <div data-testid="tag-editor">{(previewUrls ?? []).join(",")}</div>
  ),
}));
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(actual.motion, {
      get(_t, prop: string) {
        return ({ children, onClick, disabled, className }: any) => {
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag onClick={onClick} disabled={disabled} className={className}>{children}</Tag>;
        };
      },
    }),
  };
});

const slides = [{ index: 0, shapes: [], width_emu: 1, height_emu: 1 }];

beforeEach(() => { (global as any).fetch = undefined; });
afterEach(() => vi.restoreAllMocks());

describe("EditClient lazy previews", () => {
  it("renders previews on mount when pending, then shows the editor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ status: "ready", previewUrls: ["u0"] }),
    });
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={[]} previewsPending />);
    expect(screen.getByText(/rendering previews/i)).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByTestId("tag-editor")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1/base-previews", { method: "POST" });
    expect(screen.getByTestId("tag-editor").textContent).toBe("u0");
  });

  it("shows Retry on failure and re-fetches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ready", previewUrls: ["u0"] }) });
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={[]} previewsPending />);
    await vi.waitFor(() => expect(screen.getByText(/preview render failed/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await vi.waitFor(() => expect(screen.getByTestId("tag-editor")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("disables Save while previews are rendering, enables it after", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ status: "ready", previewUrls: ["u0"] }),
    });
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={[]} previewsPending />);
    // During the lazy render, Save must be unreachable so a no-moves save
    // cannot race the base-previews persist and clobber previewKeys.
    expect((screen.getByRole("button", { name: /save template/i }) as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() => expect(screen.getByTestId("tag-editor")).toBeTruthy());
    expect((screen.getByRole("button", { name: /save template/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the editor immediately when previews are not pending", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={["a"]} previewsPending={false} />);
    expect(screen.getByTestId("tag-editor")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
