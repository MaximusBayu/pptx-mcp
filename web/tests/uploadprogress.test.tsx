// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { UploadProgress } from "@/components/UploadProgress";

afterEach(cleanup);

describe("UploadProgress", () => {
  it("determinate: shows stage label and a bar at pct width", () => {
    render(<UploadProgress stage="Uploading file… 42%" pct={42} />);
    expect(screen.getByText(/uploading file/i)).toBeTruthy();
    expect((screen.getByTestId("bar-fill") as HTMLElement).style.width).toBe("42%");
  });

  it("indeterminate: shows stage label and an indeterminate bar", () => {
    render(<UploadProgress stage="Rendering previews…" />);
    expect(screen.getByText(/rendering previews/i)).toBeTruthy();
    expect(screen.getByTestId("bar-indeterminate")).toBeTruthy();
  });
});
