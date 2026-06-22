import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagEditor, slotKey, buildInitialSlots } from "@/components/TagEditor";

it("seeds slot description and example from shape suggestions", () => {
  const slides = [{
    index: 0, width_emu: 12192000, height_emu: 6858000,
    shapes: [{
      shape_id: 5, name: "Title", type: "text",
      bbox_pct: { x: 5, y: 5, w: 80, h: 15 },
      is_candidate: true, suggested_id: "title",
      suggested_description: "Slide title", suggested_example: "Finding F1",
    }],
  }];
  const slots = buildInitialSlots(slides as any);
  const slot = slots["0:5"];
  expect(slot.description).toBe("Slide title");
  expect(slot.example).toBe("Finding F1");
});

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [{ shape_id: 5, name: "Title", type: "text",
             bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }],
}];

describe("TagEditor", () => {
  it("renders an overlay box per shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /shape Title/ })).toBeInTheDocument();
  });

  it("clips the slide canvas so off-slide shapes can't overlap controls below", () => {
    const bleed = [{
      index: 0, width_emu: 100, height_emu: 100,
      shapes: [{ shape_id: 7, name: "Freeform 7", type: "image",
                 bbox_pct: { x: -20, y: 80, w: 140, h: 40 } }],
    }];
    render(<TagEditor slides={bleed} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByTestId("slide-canvas").className).toContain("overflow-hidden");
  });

  it("renders a non-interactive slide frame", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} />);
    expect(screen.getByTestId("slide-frame")).toBeInTheDocument();
  });

  it("selecting a shape lets you set a slot id", () => {
    const onChange = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /shape Title/ }));
    fireEvent.change(screen.getByLabelText("Slot id"), { target: { value: "title" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last[slotKey(0, 5)].id).toBe("title");
  });

  it("resizing the SE handle grows the box and reports onMove", () => {
    const onMove = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={onMove} />);
    const canvas = screen.getByTestId("slide-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} } as DOMRect
    );
    fireEvent.click(screen.getByRole("button", { name: /shape Title/ })); // select -> handles appear
    const se = screen.getByLabelText("resize se");
    fireEvent.pointerDown(se, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(se, { clientX: 64, clientY: 36, pointerId: 1 });
    fireEvent.pointerUp(se, { clientX: 64, clientY: 36, pointerId: 1 });
    expect(onMove).toHaveBeenCalled();
    const [, , bbox] = onMove.mock.calls.at(-1)!;
    expect(bbox.w).toBeGreaterThan(40); // grew from w=40
    expect(bbox.h).toBeGreaterThan(20); // grew from h=20
  });

  it("does not render resize handles until a block is selected", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={() => {}} />);
    expect(screen.queryByLabelText("resize se")).toBeNull();
  });

  it("pointer-drag reports onMove(slideIndex, shapeId, bbox), no rebound, no fetch", () => {
    const onMove = vi.fn();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}") as any);
    render(
      <TagEditor slides={slides} previewUrls={["/p0.png"]} onChange={() => {}} onMove={onMove} />
    );
    const canvas = screen.getByTestId("slide-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} } as DOMRect
    );
    const box = screen.getByRole("button", { name: /shape Title/ });
    fireEvent.pointerDown(box, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 64, clientY: 36, pointerId: 1 });
    fireEvent.pointerUp(box, { clientX: 64, clientY: 36, pointerId: 1 });
    expect(onMove).toHaveBeenCalled();
    const [si, sid, bbox] = onMove.mock.calls.at(-1)!;
    expect(si).toBe(0);
    expect(sid).toBe(5);
    expect(bbox.x).toBeGreaterThan(10); // moved right from x=10
    // box position is committed via left/top — no framer transform residue
    expect((box as HTMLElement).style.transform === "" || (box as HTMLElement).style.transform == null).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
