import type { Box } from "./placement";

export type Extent = { minX: number; minY: number; maxX: number; maxY: number };

/** Union of the slide rect (0,0,100,100) and every box, padded by margin %. */
export function canvasExtent(boxes: Box[], margin = 2): Extent {
  let minX = 0, minY = 0, maxX = 100, maxY = 100;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

export const rangeX = (e: Extent) => e.maxX - e.minX;
export const rangeY = (e: Extent) => e.maxY - e.minY;

/** Slide-% box -> canvas-% box (position within the extended viewport). */
export function toCanvasPct(b: Box, e: Extent): Box {
  return {
    x: ((b.x - e.minX) / rangeX(e)) * 100,
    y: ((b.y - e.minY) / rangeY(e)) * 100,
    w: (b.w / rangeX(e)) * 100,
    h: (b.h / rangeY(e)) * 100,
  };
}

/**
 * Pixel height of the canvas for a fixed pixel width.
 *
 * bbox x/w are percent of slide WIDTH and y/h are percent of slide HEIGHT —
 * different real units. `slideAR` (= width_emu / height_emu) rescales the
 * vertical axis so the rendered slide frame keeps the slide's true aspect
 * ratio instead of collapsing to a square (which letterboxed the preview and
 * drifted the overlay boxes off the slide content).
 */
export function canvasHeightPx(widthPx: number, e: Extent, slideAR: number): number {
  const ar = slideAR > 0 ? slideAR : 16 / 9;
  return (widthPx * rangeY(e)) / (rangeX(e) * ar);
}

/** Pixel drag delta -> slide-% delta, accounting for the extent zoom. */
export function fromCanvasOffset(
  offsetPx: { x: number; y: number },
  e: Extent,
  rectPx: { w: number; h: number }
): { dx: number; dy: number } {
  return {
    dx: (offsetPx.x / rectPx.w) * rangeX(e),
    dy: (offsetPx.y / rectPx.h) * rangeY(e),
  };
}

/** Keep a box inside the canvas extent (off-slide allowed, off-canvas not). */
export function clampToExtent(b: Box, e: Extent): Box {
  return {
    ...b,
    x: Math.min(Math.max(b.x, e.minX), e.maxX - b.w),
    y: Math.min(Math.max(b.y, e.minY), e.maxY - b.h),
  };
}
