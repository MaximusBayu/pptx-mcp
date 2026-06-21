import { buildExampleDeckSpec } from "@/lib/example";

export function toAgentSchema(manifestJson: any, meta?: { id: string; name: string; description: string }) {
  return {
    id: meta ? meta.id : manifestJson?.template?.id,
    name: meta ? meta.name : manifestJson?.template?.name,
    description: meta ? meta.description : (manifestJson?.template?.description ?? ""),
    slide_types: (manifestJson?.slide_types ?? []).map((st: any) => ({
      id: st.id, name: st.name, description: st.description ?? "",
      repeatable: st.repeatable ?? false,
      slots: (st.slots ?? []).map((s: any) => ({
        id: s.id, name: s.name, type: s.type,
        required: s.required ?? true, default: s.default ?? null,
        constraints: s.constraints ?? {},
        description: s.description ?? "",
        example: s.example ?? null,
      })),
    })),
    example_deck_spec: buildExampleDeckSpec(manifestJson),
  };
}
