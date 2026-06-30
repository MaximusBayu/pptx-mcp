import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ComponentsClient } from "@/app/(app)/templates/[id]/components/ComponentsClient";

const comps = [
  { component_id: "0:5", source_slide: 0, type: "text", fillable: true, slot_id: "title",
    name: "Title", text: "Hello",
    geometry: { bbox_pct: { x: 1, y: 1, w: 80, h: 10 }, width_emu: 100, height_emu: 50 },
    style: { font_name: "Arial", font_pt: 32, font_color: "FF0000", fill_color: null } },
  { component_id: "0:9", source_slide: 0, type: "other", fillable: false, slot_id: null,
    name: "Decor Bar", text: "",
    geometry: { bbox_pct: { x: 0, y: 90, w: 100, h: 4 }, width_emu: 10, height_emu: 2 },
    style: { font_name: null, font_pt: null, font_color: null, fill_color: "112233" } },
];

describe("ComponentsClient", () => {
  it("renders fillable slot and decor components", () => {
    render(<ComponentsClient name="Deck" components={comps} />);
    expect(screen.getByText("Slot: title")).toBeInTheDocument();
    expect(screen.getByText("Decor")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Decor Bar")).toBeInTheDocument();
    expect(screen.getByText(/Arial @ 32/)).toBeInTheDocument();
  });

  it("groups by source slide", () => {
    render(<ComponentsClient name="Deck" components={comps} />);
    expect(screen.getByText(/Slide 1/)).toBeInTheDocument();
  });
});
