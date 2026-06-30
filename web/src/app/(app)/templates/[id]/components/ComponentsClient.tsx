"use client";

type Comp = {
  component_id: string; source_slide: number; type: string;
  fillable: boolean; slot_id: string | null; name: string; text: string;
  geometry: { bbox_pct: { x: number; y: number; w: number; h: number };
              width_emu: number; height_emu: number };
  style: { font_name: string | null; font_pt: number | null;
           font_color: string | null; fill_color: string | null };
};

function Swatch({ hex }: { hex: string | null }) {
  if (!hex) return null;
  return <span className="inline-block w-3 h-3 rounded-sm border border-gray-300 align-middle"
               style={{ backgroundColor: `#${hex}` }} title={`#${hex}`} />;
}

function Card({ c }: { c: Comp }) {
  const g = c.geometry.bbox_pct;
  const typeLabel = c.type === "other" ? "decor" : c.type;
  return (
    <div className="border border-gray-200 rounded-md p-3 space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-xs">{typeLabel}</span>
        <span className={`px-1.5 py-0.5 rounded text-xs ${c.fillable ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>
          {c.fillable ? `Slot: ${c.slot_id}` : "Decor"}
        </span>
        <span className="font-medium">{c.name || c.component_id}</span>
      </div>
      {c.text && <div className="text-gray-600 line-clamp-2">{c.text}</div>}
      <div className="text-gray-500 text-xs">
        {g.x}/{g.y} · {g.w}×{g.h} (bbox %)
      </div>
      <div className="text-gray-500 text-xs flex items-center gap-2">
        {c.style.font_name && <span>{c.style.font_name} @ {c.style.font_pt ?? "?"}</span>}
        <Swatch hex={c.style.font_color} />
        <Swatch hex={c.style.fill_color} />
      </div>
    </div>
  );
}

export function ComponentsClient({ name, components }: { name: string; components: Comp[] }) {
  const bySlide = new Map<number, Comp[]>();
  for (const c of components) {
    const arr = bySlide.get(c.source_slide) ?? [];
    arr.push(c);
    bySlide.set(c.source_slide, arr);
  }
  const slides = Array.from(bySlide.keys()).sort((a, b) => a - b);
  return (
    <div className="p-8 max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Components — {name}</h1>
      {slides.map((s) => (
        <div key={s} className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-500">Slide {s + 1}</h2>
          <div className="grid gap-2">
            {bySlide.get(s)!.map((c) => <Card key={c.component_id} c={c} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
