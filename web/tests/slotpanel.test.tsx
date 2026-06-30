import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SlotPanel } from "@/components/SlotPanel";

const base = { shape_id: 5, slideIndex: 0, id: "t", name: "T", constraints: {} as Record<string, number | string> };

describe("SlotPanel char estimate", () => {
  it("shows the estimate and Use this sets max_chars for a text slot", () => {
    const onChange = vi.fn();
    render(<SlotPanel slot={{ ...base, type: "text" }} charEstimate={123} onChange={onChange} />);
    expect(screen.getByText(/Fits ~123 chars/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use estimated max chars/i }));
    expect(onChange.mock.calls.at(-1)![0].constraints.max_chars).toBe(123);
  });

  it("shows no estimate for a non-text slot", () => {
    render(<SlotPanel slot={{ ...base, type: "image" }} charEstimate={123} onChange={() => {}} />);
    expect(screen.queryByText(/Fits ~/)).toBeNull();
  });
});
