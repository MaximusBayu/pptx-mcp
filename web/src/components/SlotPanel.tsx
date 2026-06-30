"use client";
export type DraftSlot = {
  shape_id: number; slideIndex: number; id: string; name: string;
  type: "text" | "table" | "image"; constraints: Record<string, number | string>;
  description?: string; example?: string;
};

export function SlotPanel({ slot, onChange, charEstimate }:
  { slot: DraftSlot; onChange: (s: DraftSlot) => void; charEstimate?: number }) {
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
      <label className="block text-sm">Description (hint for the agent)
        <input aria-label="Slot description" className="w-full border p-1 rounded"
          value={slot.description ?? ""}
          onChange={(e) => onChange({ ...slot, description: e.target.value })} />
      </label>
      <label className="block text-sm">Example value
        <input aria-label="Slot example" className="w-full border p-1 rounded"
          value={slot.example ?? ""}
          onChange={(e) => onChange({ ...slot, example: e.target.value })} />
      </label>
      {slot.type === "text" && (
        <>
          <label className="block text-sm">Max chars
            <input aria-label="Max chars" type="number" className="w-full border p-1 rounded"
              value={slot.constraints.max_chars ?? ""}
              onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: Number(e.target.value) } })} />
          </label>
          {charEstimate != null && (
            <p className="text-xs text-gray-600">
              Fits ~{charEstimate} chars at this size{" "}
              <button type="button" aria-label="Use estimated max chars" className="underline text-blue-600"
                onClick={() => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: charEstimate } })}>
                Use this
              </button>
            </p>
          )}
        </>
      )}
      {slot.type === "table" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">Max rows
            <input aria-label="Max rows" type="number" className="w-full border p-1 rounded"
              value={slot.constraints.max_rows ?? ""}
              onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_rows: Number(e.target.value) } })} />
          </label>
          <label className="block text-sm">Max cols
            <input aria-label="Max cols" type="number" className="w-full border p-1 rounded"
              value={slot.constraints.max_cols ?? ""}
              onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_cols: Number(e.target.value) } })} />
          </label>
        </div>
      )}
      {slot.type === "image" && (
        <p className="text-xs text-gray-500">
          Image slot — the agent supplies an image URL or base64 data when rendering.
        </p>
      )}
    </div>
  );
}
