export function toAgentSchema(manifestJson: any) {
  return {
    id: manifestJson?.template?.id,
    name: manifestJson?.template?.name,
    description: manifestJson?.template?.description ?? "",
    slide_types: (manifestJson?.slide_types ?? []).map((st: any) => ({
      id: st.id, name: st.name, description: st.description ?? "",
      slots: (st.slots ?? []).map((s: any) => ({
        id: s.id, name: s.name, type: s.type,
        required: s.required ?? true, default: s.default ?? null,
        constraints: s.constraints ?? {},
      })),
    })),
  };
}
