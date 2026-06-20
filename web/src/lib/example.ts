// Build an example deck_spec from a template manifest so the "Use this
// template" page can show agents (and owners testing) exactly what to send.
export function buildExampleDeckSpec(manifestJson: any) {
  const slideTypes = manifestJson?.slide_types ?? [];
  return {
    slides: slideTypes.map((st: any) => {
      const slots: Record<string, string> = {};
      for (const s of st.slots ?? []) {
        slots[s.id] = s.default ?? `<${s.type ?? "text"}: ${s.name || s.id}>`;
      }
      return { slide_type: st.id, slots };
    }),
  };
}
