import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagEditor, slotKey } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [{ shape_id: 5, name: "Title", type: "text",
             bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }],
}];

describe("TagEditor", () => {
  it("renders an overlay box per shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
  });

  it("clips the slide canvas so off-slide shapes can't overlap controls below", () => {
    // Regression: an off-slide / bleed shape (w+x > 100) was painting and
    // intercepting clicks over the Save button. The canvas must clip overflow.
    const bleed = [{
      index: 0, width_emu: 100, height_emu: 100,
      shapes: [{ shape_id: 7, name: "Freeform 7", type: "image",
                 bbox_pct: { x: -20, y: 80, w: 140, h: 40 } }],
    }];
    render(<TagEditor slides={bleed} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByTestId("slide-canvas").className).toContain("overflow-hidden");
  });

  it("selecting a shape lets you set a slot id", () => {
    const onChange = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    fireEvent.change(screen.getByLabelText("Slot id"), { target: { value: "title" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    // Slot is now keyed by composite "slideIndex:shapeId"
    expect(last[slotKey(0, 5)].id).toBe("title");
  });
});
