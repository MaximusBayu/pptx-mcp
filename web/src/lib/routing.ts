// Deterministic content -> slide_type routing. No LLM, no network — pure string
// ops over the saved manifest. The keyword families below mirror
// engine/src/pptx_mcp/autodetect.py (_AGENDA_RE/_SUMMARY_RE/_FINDING_RE/
// _CLOSING_RE); keep them in sync if the engine families change.

export type Candidate = {
  slide_type: string;
  name: string;
  repeatable: boolean;
  score: number;
  reason: string;
};

const FAMILIES: { kind: string; re: RegExp }[] = [
  { kind: "agenda", re: /agenda|overview|outline|contents|daftar isi/i },
  { kind: "summary", re: /summary|ringkasan|executive/i },
  { kind: "finding", re: /finding|temuan|severity|critical|high|medium|low|cwe|cvss/i },
  { kind: "closing", re: /thank|terima kasih|questions|q&a/i },
];

function tokenize(s: string): string[] {
  return (s || "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function looksTabular(content: string): boolean {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const delimited = lines.filter((l) => /\t| {2,}|\|/.test(l)).length;
  if (delimited >= 2) return true;
  const nonSpace = content.replace(/\s/g, "").length;
  const digits = content.match(/\d/g)?.length ?? 0;
  return nonSpace > 0 && digits / nonSpace > 0.3;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function scoreLayouts(
  manifest: any,
  content: string,
  used: Record<string, number> = {},
  topN = 3,
): Candidate[] {
  const slideTypes: any[] = manifest?.slide_types ?? [];
  const safeUsed: Record<string, number> =
    used && typeof used === "object" ? used : {};
  const contentTokens = new Set(tokenize(content));
  const firedKinds = new Set(
    FAMILIES.filter((f) => f.re.test(content)).map((f) => f.kind),
  );
  const wordCount = (content.trim().match(/\S+/g) ?? []).length;
  const tabular = looksTabular(content);
  const longMulti = wordCount > 25;

  const scored: Candidate[] = slideTypes.map((st: any) => {
    const kind = String(st.kind || st.name || "").toLowerCase();
    const repeatable = Boolean(st.repeatable);
    const slots: any[] = st.slots ?? [];
    const reasons: string[] = [];

    // 1. kind-family keyword match
    let kindScore = 0;
    if (firedKinds.has(kind)) {
      kindScore = 0.5;
      reasons.push(`matches ${kind} keywords`);
    }

    // 2. token overlap over name + slot id/description/example (NOT st.description)
    const slideTokens = new Set<string>([
      ...tokenize(st.name),
      ...slots.flatMap((s: any) => [
        ...tokenize(s.id),
        ...tokenize(s.description),
        ...tokenize(typeof s.example === "string" ? s.example : ""),
      ]),
    ]);
    let overlap = 0;
    contentTokens.forEach((t) => { if (slideTokens.has(t)) overlap++; });
    const overlapScore = Math.min(0.3, overlap * 0.05);
    if (overlapScore > 0) reasons.push(`shares terms with ${st.name || st.id}`);

    // 3. structural fit
    let structureScore = 0;
    const hasTable = slots.some((s: any) => s.type === "table");
    if (tabular && hasTable) {
      structureScore += 0.25;
      reasons.push("content looks tabular; slide has a table slot");
    }
    if (wordCount <= 6 && (kind === "cover" || kind === "section")) {
      structureScore += 0.15;
      reasons.push("short content fits a cover/section slide");
    }
    if (longMulti && (kind === "content" || kind === "finding")) {
      structureScore += 0.1;
    }

    // 4. repetition penalty — non-repeatable types only
    const usedCount = Number(safeUsed[st.id]) || 0;
    const penalty = !repeatable && usedCount > 0 ? Math.min(0.4, 0.2 * usedCount) : 0;

    const score = clamp01(kindScore + overlapScore + structureScore - penalty);

    // affirm vs caution
    if (repeatable && usedCount > 0) {
      reasons.push(`designed to repeat — ${usedCount} already placed, reuse once per item`);
    } else if (!repeatable && usedCount > 0) {
      reasons.push(`already used ${usedCount}x; consider a different layout`);
    }

    return {
      slide_type: st.id,
      name: st.name ?? st.id,
      repeatable,
      score: round2(score),
      reason: reasons.length ? reasons.join("; ") : "no strong signal",
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
