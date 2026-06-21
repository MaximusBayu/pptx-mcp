import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TagEditor } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [
    { shape_id: 1, name: "Big", type: "image", bbox_pct: { x: 0, y: 0, w: 100, h: 100 } },
    { shape_id: 2, name: "Small", type: "text", bbox_pct: { x: 40, y: 40, w: 10, h: 10 } },
  ],
}];

describe("TagEditor layers", () => {
  it("paints larger shapes before smaller ones (small on top)", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    const canvas = screen.getByTestId("slide-canvas");
    const boxes = within(canvas).getAllByRole("button");
    // First painted (lower in DOM/stack) is the big one.
    expect(boxes[0].getAttribute("aria-label")).toContain("Big");
    expect(boxes[1].getAttribute("aria-label")).toContain("Small");
  });

  it("layer list selects a covered shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "layer Small" }));
    // Selecting reveals the SlotPanel; its Slot id input is present.
    expect(screen.getByLabelText("Slot id")).toBeInTheDocument();
  });
});
