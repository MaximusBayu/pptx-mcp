export type Box = { x: number; y: number; w: number; h: number };

export function isOffSlide(b: Box, eps = 0.5): boolean {
  return b.x < -eps || b.y < -eps || b.x + b.w > 100 + eps || b.y + b.h > 100 + eps;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function placementIssues(slots: { id: string; box: Box }[]) {
  const offSlide = slots.filter((s) => isOffSlide(s.box)).map((s) => s.id);
  const overlapping: [string, string][] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (overlaps(slots[i].box, slots[j].box)) overlapping.push([slots[i].id, slots[j].id]);
    }
  }
  return { offSlide, overlapping };
}
