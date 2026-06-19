import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagEditor } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [{ shape_id: 5, name: "Title", type: "text",
             bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }],
}];

describe("TagEditor", () => {
  it("renders an overlay box per shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} value={{}} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
  });

  it("selecting a shape lets you set a slot id", () => {
    const onChange = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} value={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    fireEvent.change(screen.getByLabelText("Slot id"), { target: { value: "title" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last["5"].id).toBe("title");
  });
});
