# Agent Auto-Routing (`suggest_layout`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `suggest_layout` MCP tool that ranks which `slide_type` best fits a chunk of source content (with reasons), variation-aware via an optional `used` tally, so an agent stops eyeballing the schema to place content.

**Architecture:** A pure scoring function (`web/src/lib/routing.ts`) reads the saved manifest JSON and a content string, scoring each `slide_type` by kind-keyword match + token overlap + structural fit − a repetition penalty (non-repeatable types only). A web API route (`/api/mcp/templates/[id]/suggest-layout`) wraps it with `x-api-key` auth; an MCP tool proxies to that route. The PUT route additionally persists each slide's `kind` so routing has a stable kind even when the owner renames a slide.

**Tech Stack:** Next.js / TypeScript (web + routing), python `fastmcp`/`httpx` (mcp-server), vitest (web tests), pytest + respx (mcp-server tests).

## Global Constraints

- **No LLM / no network in scoring.** `scoreLayouts` is a pure function over the manifest JSON and the content string — keyword/structure/overlap only.
- **No engine round-trip.** Scoring is string operations in web; the manifest already lives in web's DB.
- **Output is ranking only** — no slot pre-fill, no document segmentation.
- **Variation is `repeatable`-aware:** the `used` repetition penalty applies to **non-repeatable** types only; `repeatable` types are never penalized.
- **Every candidate carries `repeatable`** and a non-empty `reason`; the reason affirms reuse for repeatable types and cautions for over-used non-repeatable types.
- **Guarded reads:** scoring and the route never throw on old/odd manifests (`manifest?.slide_types ?? []`, `st.slots ?? []`), mirroring `toAgentSchema`.
- **`st.description` is excluded** from the token-overlap source (it is a synthesized kind+slot-ids sentence; including it double-counts `kindScore`).

**Run tests:**
- Web: `cd web && npx vitest run <path>`
- MCP server: `cd mcp-server && python -m pytest <path> -v`

---

## File Structure

- `web/src/lib/routing.ts` — **create.** `scoreLayouts(manifest, content, used, topN)` + `Candidate` type + keyword-family table. The whole routing brain. Pure.
- `web/src/app/api/mcp/templates/[id]/suggest-layout/route.ts` — **create.** POST handler: auth + load template + call `scoreLayouts`.
- `web/src/app/api/templates/[id]/route.ts` — **modify.** PUT persists `kind` per slide_type (fallback to draft).
- `web/src/app/(app)/templates/[id]/edit/EditClient.tsx` — **modify.** `save()` includes `kind` in each slide_type payload.
- `mcp-server/server.py` — **modify.** `suggest_layout` proxy + `suggest_layout_tool`.
- Tests: `web/tests/routing.test.ts` (create), `web/tests/suggest-layout-api.test.ts` (create), `web/tests/templates-save.test.ts` (extend), `web/tests/editclient-save.test.tsx` (extend), `mcp-server/tests/test_proxy.py` (extend).

---

## Task 1: Routing brain — `scoreLayouts`

**Files:**
- Create: `web/src/lib/routing.ts`
- Test: `web/tests/routing.test.ts`

**Interfaces:**
- Consumes: a manifest object shaped `{ slide_types: [{ id, name, kind?, repeatable, slots: [{ id, type, description, example }] }] }`.
- Produces: `type Candidate = { slide_type: string; name: string; repeatable: boolean; score: number; reason: string }` and `scoreLayouts(manifest: any, content: string, used?: Record<string, number>, topN?: number): Candidate[]`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/routing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scoreLayouts } from "@/lib/routing";

const manifest = {
  slide_types: [
    { id: "slide_0", name: "cover", kind: "cover", repeatable: false,
      slots: [{ id: "title", type: "text", description: "Slide title", example: "RISEStore VAPT Report" }] },
    { id: "slide_2", name: "finding", kind: "finding", repeatable: true,
      slots: [
        { id: "title", type: "text", description: "Slide title", example: "Finding F1" },
        { id: "severity", type: "text", description: "Text", example: "CRITICAL" },
        { id: "body", type: "text", description: "Body text", example: "SQL injection in login" },
      ] },
    { id: "slide_4", name: "data", kind: "data", repeatable: false,
      slots: [{ id: "table_1", type: "table", description: "Table data", example: "" }] },
  ],
};

describe("scoreLayouts", () => {
  it("ranks the finding slide first for finding-flavored content", () => {
    const out = scoreLayouts(manifest, "Severity: CRITICAL. CWE-89 SQL injection found in login.");
    expect(out[0].slide_type).toBe("slide_2");
    expect(out[0].repeatable).toBe(true);
    expect(out[0].reason.length).toBeGreaterThan(0);
  });

  it("boosts a table slide for tabular content", () => {
    const out = scoreLayouts(manifest, "Region\tRevenue\nEU\t1.2M\nUS\t2.4M");
    expect(out[0].slide_type).toBe("slide_4");
  });

  it("does not penalize a repeatable type as it repeats", () => {
    const c = "Severity: CRITICAL CWE-89 SQL injection";
    const a = scoreLayouts(manifest, c, {});
    const b = scoreLayouts(manifest, c, { slide_2: 3 });
    const fa = a.find((x) => x.slide_type === "slide_2")!;
    const fb = b.find((x) => x.slide_type === "slide_2")!;
    expect(fb.score).toBe(fa.score);
    expect(b[0].slide_type).toBe("slide_2");
    expect(fb.reason).toMatch(/repeat/i);
  });

  it("penalizes a non-repeatable type once used", () => {
    const c = "Quarterly Review";
    const a = scoreLayouts(manifest, c, {});
    const b = scoreLayouts(manifest, c, { slide_0: 2 });
    const ca = a.find((x) => x.slide_type === "slide_0")!;
    const cb = b.find((x) => x.slide_type === "slide_0")!;
    expect(cb.score).toBeLessThan(ca.score);
    expect(cb.reason).toMatch(/already used/i);
  });

  it("every candidate carries repeatable and a reason", () => {
    const out = scoreLayouts(manifest, "anything here");
    for (const c of out) {
      expect(typeof c.repeatable).toBe("boolean");
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns [] for an empty manifest and never throws on a bad used", () => {
    expect(scoreLayouts({}, "x")).toEqual([]);
    expect(scoreLayouts(manifest, "x", null as any)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/routing.test.ts`
Expected: FAIL — `Cannot find module '@/lib/routing'`.

- [ ] **Step 3: Implement `routing.ts`**

Create `web/src/lib/routing.ts`:

```ts
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
    for (const t of contentTokens) if (slideTokens.has(t)) overlap++;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/routing.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/routing.ts web/tests/routing.test.ts
git commit -m "feat(web): deterministic scoreLayouts for content->slide routing"
```

---

## Task 2: Persist `kind` through PUT + editor save

**Files:**
- Modify: `web/src/app/api/templates/[id]/route.ts` (the `slide_types` mapping)
- Modify: `web/src/app/(app)/templates/[id]/edit/EditClient.tsx` (the `save()` slideTypes builder)
- Test: `web/tests/templates-save.test.ts` (extend), `web/tests/editclient-save.test.tsx` (extend)

**Interfaces:**
- Consumes: editor PUT body `slideTypes[]` may now carry `kind?: string`; draft slides carry `kind` and `suggested_name`.
- Produces: persisted `manifestJson.slide_types[].kind` (string). Fallback order: editor `st.kind` → draft `ds.kind` → draft `ds.suggested_name` → `""`.

- [ ] **Step 1: Write the failing tests**

Add to `web/tests/templates-save.test.ts`, inside the `describe("save manifest", ...)` block:

```ts
  it("persists slide kind, falling back to the draft", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1",
      manifestJson: { draft: { slides: [{ index: 0, kind: "finding", suggested_name: "finding", shapes: [] }] } },
    });
    (prisma.template.update as any).mockResolvedValue({});
    const body = {
      name: "K",
      slideTypes: [{ id: "title", source_slide_index: 0, kind: "", slots: [{ id: "title", name: "T", type: "text", shape_id: 5 }] }],
    };
    const r = await PUT(put(body), ctx);
    expect(r.status).toBe(200);
    const saved = (prisma.template.update as any).mock.calls[0][0].data.manifestJson;
    expect(saved.slide_types[0].kind).toBe("finding");
  });
```

Add to `web/tests/editclient-save.test.tsx` — extend the existing no-touch-save assertions so the captured PUT body carries `kind`. In the slide fixture add `kind: "finding"`, and after the existing `repeatable`/`name` assertions add:

```tsx
    expect(capturedBody.slideTypes[0].kind).toBe("finding");
```

(The slide fixture object in that test must include `kind: "finding"` alongside its existing `suggested_name`/`repeatable` fields.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run tests/templates-save.test.ts tests/editclient-save.test.tsx`
Expected: FAIL — saved slide_type has no `kind`; captured body slideType has no `kind`.

- [ ] **Step 3: Persist `kind` in the PUT route**

In `web/src/app/api/templates/[id]/route.ts`, in the `slide_types = (slideTypes ?? []).map((st: any) => { ... })` block, add a `kind` field to the returned object (right after `id`):

```ts
    return {
      id: st.id,
      kind: st.kind || ds?.kind || ds?.suggested_name || "",
      name: st.name || ds?.suggested_name || `Slide ${(st.source_slide_index ?? 0) + 1}`,
      description: st.description || ds?.suggested_description || "",
      repeatable: st.repeatable ?? ds?.repeatable ?? false,
      source_slide_index: st.source_slide_index,
      slots: (st.slots ?? []).map((s: any) => {
        const sh = draftShape(st.source_slide_index, s.shape_id);
        return {
          id: s.id, name: s.name, type: s.type, target: { shape_id: s.shape_id },
          required: s.required ?? true, default: s.default ?? null,
          constraints: s.constraints ?? {},
          description: s.description || sh?.suggested_description || "",
          example: (s.example ?? "") !== "" ? s.example : (sh?.suggested_example ?? ""),
        };
      }),
    };
```

(Only the new `kind:` line is added; the rest of the object is unchanged.)

- [ ] **Step 4: Send `kind` from the editor**

In `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`, in `save()`, the slideTypes builder is `slides.map((_sl, idx) => { const meta = slideMeta[idx]; return { id: ..., name: ..., ... } })`. Add a `kind` field read from the slide prop:

```tsx
      const slideTypes = slides.map((_sl, idx) => {
        const meta = slideMeta[idx];
        return {
          id: `slide_${idx}`,
          kind: (_sl as any)?.kind ?? "",
          name: meta?.name ?? "",
          description: meta?.description ?? "",
          repeatable: meta?.repeatable ?? false,
          source_slide_index: idx,
          slots: Object.values(slots)
            .filter((s) => s.slideIndex === idx && s.id)
            .map((s) => ({
              id: s.id, name: s.name, type: s.type, shape_id: s.shape_id,
              constraints: s.constraints,
              description: s.description ?? "", example: s.example ?? "",
            })),
        };
      });
```

(Only the new `kind:` line is added.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run tests/templates-save.test.ts tests/editclient-save.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/api/templates/[id]/route.ts "web/src/app/(app)/templates/[id]/edit/EditClient.tsx" web/tests/templates-save.test.ts web/tests/editclient-save.test.tsx
git commit -m "feat(web): persist slide kind through PUT + editor save for routing"
```

---

## Task 3: Web API route — `/suggest-layout`

**Files:**
- Create: `web/src/app/api/mcp/templates/[id]/suggest-layout/route.ts`
- Test: `web/tests/suggest-layout-api.test.ts`

**Interfaces:**
- Consumes: `requireApiKey(req)` from `@/lib/mcpAuth`, `prisma`, `scoreLayouts` from `@/lib/routing` (Task 1).
- Produces: `POST(req, ctx)` returning `{ candidates: Candidate[] }` (200), or error JSON (400/401/404/403).

- [ ] **Step 1: Write the failing test**

Create `web/tests/suggest-layout-api.test.ts` (mirrors `tests/mcp-api.test.ts` mocking):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiKey", () => ({ verifyApiKey: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn() } } }));

import { verifyApiKey } from "@/lib/apiKey";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/mcp/templates/[id]/suggest-layout/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
function req(body: object) {
  return new Request("http://x", { method: "POST", headers: { "x-api-key": "pk_a_b" }, body: JSON.stringify(body) });
}
const manifest = {
  slide_types: [
    { id: "slide_2", name: "finding", kind: "finding", repeatable: true,
      slots: [{ id: "severity", type: "text", description: "Text", example: "CRITICAL" }] },
    { id: "slide_0", name: "cover", kind: "cover", repeatable: false, slots: [] },
  ],
};

describe("mcp suggest-layout", () => {
  it("401 without a valid key", async () => {
    (verifyApiKey as any).mockResolvedValue(null);
    expect((await POST(req({ content: "x" }), ctx)).status).toBe(401);
  });

  it("400 when content is empty", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", manifestJson: manifest });
    expect((await POST(req({ content: "   " }), ctx)).status).toBe(400);
  });

  it("ranks candidates for the owner", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", manifestJson: manifest });
    const r = await POST(req({ content: "Severity CRITICAL CWE-89" }), ctx);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidates[0].slide_type).toBe("slide_2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/suggest-layout-api.test.ts`
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Implement the route**

Create `web/src/app/api/mcp/templates/[id]/suggest-layout/route.ts`:

```ts
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { scoreLayouts } from "@/lib/routing";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const content = typeof body?.content === "string" ? body.content : "";
  if (!content.trim()) return Response.json({ error: "content is required" }, { status: 400 });
  const used = body?.used && typeof body.used === "object" ? body.used : {};
  const candidates = scoreLayouts(tpl.manifestJson, content, used);
  return Response.json({ candidates });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/suggest-layout-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/mcp/templates/[id]/suggest-layout/route.ts" web/tests/suggest-layout-api.test.ts
git commit -m "feat(web): /suggest-layout MCP route wraps scoreLayouts"
```

---

## Task 4: MCP tool — `suggest_layout_tool`

**Files:**
- Modify: `mcp-server/server.py`
- Test: `mcp-server/tests/test_proxy.py`

**Interfaces:**
- Consumes: the web route from Task 3 (`POST /api/mcp/templates/{id}/suggest-layout`), the existing `_base()` / `_headers()` helpers.
- Produces: module function `suggest_layout(template_id, content, used=None) -> dict` and the `suggest_layout_tool` registered in `build_server()`.

- [ ] **Step 1: Write the failing tests**

Add to `mcp-server/tests/test_proxy.py`:

```python
@respx.mock
def test_suggest_layout_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    from server import suggest_layout
    route = respx.post(f"{BASE}/api/mcp/templates/t1/suggest-layout").mock(
        return_value=httpx.Response(200, json={"candidates": [{"slide_type": "slide_2", "repeatable": True}]}))
    out = suggest_layout("t1", "Severity CRITICAL", {"slide_2": 1})
    assert out["candidates"][0]["slide_type"] == "slide_2"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"


def test_suggest_layout_docstring_mentions_used_and_repeatable():
    from pathlib import Path
    text = (Path(__file__).resolve().parent.parent / "server.py").read_text(encoding="utf-8")
    assert "suggest_layout_tool" in text
    assert "used" in text and "repeatable" in text
```

(`import respx`, `import httpx`, and `BASE` are already at the top of this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && python -m pytest tests/test_proxy.py -v`
Expected: FAIL — `ImportError: cannot import name 'suggest_layout'`.

- [ ] **Step 3: Add the proxy + tool**

In `mcp-server/server.py`, add the module-level proxy after `render_preview(...)`:

```python
def suggest_layout(template_id: str, content: str, used: dict | None = None) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/suggest-layout",
                   headers=_headers(), json={"content": content, "used": used or {}}, timeout=30)
    r.raise_for_status()
    return r.json()
```

And register the tool inside `build_server()` after `render_preview_tool`:

```python
    @mcp.tool()
    def suggest_layout_tool(template_id: str, content: str, used: dict | None = None) -> dict:
        """Rank which slide_type best fits a chunk of source content.

        Pass ONE logical section at a time as `content`. Returns ranked
        candidates, each with slide_type, name, repeatable, score, and a reason.
        Pass `used` — a {slide_type_id: count} tally of what you have already
        placed — to get variety: non-repeatable layouts are penalized as they
        repeat, while repeatable layouts are exempt (reuse them once per item,
        e.g. one finding slide per finding).
        """
        return suggest_layout(template_id, content, used)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && python -m pytest tests/test_proxy.py -v`
Expected: PASS (existing proxy tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/server.py mcp-server/tests/test_proxy.py
git commit -m "feat(mcp): suggest_layout tool proxies content->slide ranking"
```

---

## Self-Review

**Spec coverage:**
- MCP surface `suggest_layout_tool(template_id, content, used)` → Task 4; output candidates with `repeatable` → Tasks 1 (shape) + 4.
- Data flow MCP → web route → `scoreLayouts` → Tasks 4, 3, 1.
- Scoring (kind-family, token overlap excluding `st.description`, structural fit, repetition penalty repeatable-exempt) → Task 1.
- Persisting `kind` → Task 2.
- Components (routing.ts, route.ts, server.py) → Tasks 1, 3, 4.
- Error handling (400 empty content, 404/403, `[]` no slide_types, malformed `used`, never throws) → Tasks 1 + 3 (tested).
- Testing (routing.test.ts, suggest-layout-api.test.ts, templates-save kind, test_proxy) → all tasks.
- Out of scope (no slot pre-fill, no segmentation, no LLM) → honored; nothing adds them.

**Placeholder scan:** none — every step carries complete code and exact commands.

**Type consistency:** `Candidate` defined in Task 1 and returned by Task 3's route and Task 4's tool. `scoreLayouts(manifest, content, used?, topN?)` signature consistent across Tasks 1 and 3. Persisted `kind` (Task 2) is read by `scoreLayouts` (Task 1, `st.kind || st.name`) — producer/consumer aligned. `used` is `Record<string, number>` in web and `dict` in python, both keyed by `slide_type` id. The FAMILIES regexes match `engine/src/pptx_mcp/autodetect.py` verbatim (agenda/summary/finding/closing); cover/data are handled structurally, as in the engine.
