// Build an example deck_spec from a template manifest so the "Use this
// template" page can show agents (and owners testing) exactly what to send.
// Each slot's example value must match the type the engine validates:
// text -> string, table -> string[][], image -> a URL/base64 string.
export function exampleSlotValue(s: any): unknown {
  if (s.example != null && s.example !== "") return s.example;
  if (s.default != null) return s.default;
  if (s.type === "table") {
    return [
      ["Column A", "Column B"],
      ["Row 1 A", "Row 1 B"],
      ["Row 2 A", "Row 2 B"],
    ];
  }
  if (s.type === "image") {
    // A sample image URL. The engine ingests http(s) URLs and data: base64.
    return "https://placehold.co/600x400/png";
  }
  return `<${s.type ?? "text"}: ${s.name || s.id}>`;
}

export function buildExampleDeckSpec(manifestJson: any) {
  const slideTypes = manifestJson?.slide_types ?? [];
  return {
    slides: slideTypes.map((st: any) => {
      const slots: Record<string, unknown> = {};
      for (const s of st.slots ?? []) {
        slots[s.id] = exampleSlotValue(s);
      }
      return { slide_type: st.id, slots };
    }),
  };
}
