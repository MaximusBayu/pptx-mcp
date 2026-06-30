// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get() {
        return ({ children, ...rest }: any) => <label {...rest}>{children}</label>;
      },
    }),
  };
});
const uploadTemplate = vi.fn();
vi.mock("@/lib/upload", () => ({ uploadTemplate: (...a: any[]) => uploadTemplate(...a) }));

import NewTemplate from "@/app/(app)/templates/new/page";

beforeEach(() => { push.mockClear(); uploadTemplate.mockReset(); });

function pptx() { return new File([Buffer.from("PK")], "deck.pptx"); }

describe("NewTemplate", () => {
  it("uploads a chosen .pptx and redirects to the editor", async () => {
    uploadTemplate.mockImplementation(async (_f: File, onP: any) => {
      onP({ stage: "uploading", pct: 100 });
      return { id: "t1" };
    });
    const { container } = render(<NewTemplate />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pptx()] } });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/templates/t1/edit"));
    expect(uploadTemplate).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-pptx without uploading", () => {
    const { container } = render(<NewTemplate />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([Buffer.from("x")], "a.png")] } });
    expect(uploadTemplate).not.toHaveBeenCalled();
    expect(screen.getByText(/please choose a \.pptx/i)).toBeTruthy();
  });
});
