import type { Box } from "./placement";

export type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Compute a new bbox from a gesture handle + a slide-% delta.
 * "move" translates; resize handles adjust the edges they name. A min floor
 * keeps width/height >= minPct and prevents inversion: when a west/north edge
 * would cross its opposite edge, it freezes at the floor instead of flipping.
 */
export function applyGesture(
  handle: Handle,
  start: Box,
  d: { dx: number; dy: number },
  minPct = 2,
): Box {
  const { dx, dy } = d;
  if (handle === "move") return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };

  let { x, y, w, h } = start;
  if (handle.includes("e")) w = start.w + dx;
  if (handle.includes("w")) { x = start.x + dx; w = start.w - dx; }
  if (handle.includes("s")) h = start.h + dy;
  if (handle.includes("n")) { y = start.y + dy; h = start.h - dy; }

  if (w < minPct) {
    if (handle.includes("w")) x = start.x + start.w - minPct;
    w = minPct;
  }
  if (h < minPct) {
    if (handle.includes("n")) y = start.y + start.h - minPct;
    h = minPct;
  }
  return { x, y, w, h };
}
