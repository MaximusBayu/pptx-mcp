"use client";
export type DraftSlot = {
  shape_id: number; id: string; name: string;
  type: "text" | "table" | "image"; constraints: Record<string, number | string>;
};

export function SlotPanel({ slot, onChange }: { slot: DraftSlot; onChange: (s: DraftSlot) => void }) {
  return (
    <div className="space-y-2 p-4 border rounded">
      <label className="block text-sm">Slot id
        <input aria-label="Slot id" className="w-full border p-1 rounded"
          value={slot.id} onChange={(e) => onChange({ ...slot, id: e.target.value })} />
      </label>
      <label className="block text-sm">Type
        <select aria-label="Type" className="w-full border p-1 rounded" value={slot.type}
          onChange={(e) => onChange({ ...slot, type: e.target.value as DraftSlot["type"] })}>
          <option value="text">text</option>
          <option value="table">table</option>
          <option value="image">image</option>
        </select>
      </label>
      {slot.type === "text" && (
        <label className="block text-sm">Max chars
          <input aria-label="Max chars" type="number" className="w-full border p-1 rounded"
            value={slot.constraints.max_chars ?? ""}
            onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: Number(e.target.value) } })} />
        </label>
      )}
    </div>
  );
}
