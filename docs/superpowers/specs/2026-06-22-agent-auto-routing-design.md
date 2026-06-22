# Agent Auto-Routing (`suggest_layout`) — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review before plan.

## Goal

Give an AI agent a tool that ranks which `slide_type` best fits a chunk of
source content — with reasons — so it stops eyeballing the schema to decide
where each piece of information goes. Deterministic scoring, **no LLM
server-side**. The tool advises; the agent still picks and fills.

This builds directly on the agent-legible-templates feature: each saved
`slide_type` already carries `name`, `description`, `repeatable`, and slots with
`description`/`example`. Routing scores content against exactly those signals.

## Background

Today an agent reads `get_template_schema` and decides slide placement by
inspection. That works for a few slides but is error-prone over a real document
(e.g. a VAPT report with a cover, agenda, many findings, a summary). Two
failure modes motivate this feature:

1. **Mis-routing** — the agent puts finding content on the wrong layout.
2. **No variation** — the agent over-uses one high-scoring layout for distinct
   content, producing a monotone deck. (But repetition is *correct* for
   `repeatable` slides — four findings should all reuse the finding layout.)

## Decisions

1. **Locus:** an MCP helper tool backed by a web API endpoint. No engine
   round-trip — scoring is string operations over the manifest JSON, which
   already lives in web's DB.
2. **No LLM.** Deterministic keyword/structure/overlap scoring.
3. **Output:** ranked `slide_type` candidates with score + reason. No slot
   pre-fill (the agent fills slots itself using the schema's slot hints).
4. **Variation-aware but stateless:** an optional `used` tally (supplied by the
   agent, which is building the deck) drives a repetition penalty on
   **non-repeatable** types only; `repeatable` types are never penalized.
5. **Necessity is encoded, not guessed:** every candidate carries the
   `repeatable` flag, and the `reason` affirms reuse for repeatable types and
   cautions for over-used non-repeatable types.

## MCP surface

New tool:

```
suggest_layout_tool(template_id: str, content: str, used: dict | None = None) -> dict
```

- `content` — free text: one logical section the agent wants to place.
- `used` — optional `{slide_type_id: count}` of what the agent has already
  placed in the deck it is building. Omitted/empty → no repetition penalty
  (baseline behavior).

Returns:

```json
{ "candidates": [
  { "slide_type": "slide_2", "name": "finding", "repeatable": true, "score": 0.82,
    "reason": "matches finding keywords (severity, CWE); designed to repeat — 3 already placed, reuse once per item" },
  { "slide_type": "slide_4", "name": "data", "repeatable": false, "score": 0.31,
    "reason": "content looks tabular; slide has a table slot" },
  { "slide_type": "slide_0", "name": "cover", "repeatable": false, "score": 0.08,
    "reason": "already used 1×; covers are one-per-deck — consider a different layout" }
] }
```

Top-3 by descending score. Empty template / no `slide_types` → `{ "candidates": [] }`.

## Data flow

```
agent → suggest_layout_tool (mcp-server, stdio)
      → POST /api/mcp/templates/{id}/suggest-layout  (x-api-key)
      → scoreLayouts(manifestJson, content, used)   (web/src/lib/routing.ts)
      → ranked Candidate[]
```

No engine-service call. The manifest is read from Postgres; scoring is pure
string work.

## Scoring (`web/src/lib/routing.ts`)

`scoreLayouts(manifest, content, used = {}, topN = 3): Candidate[]`

For each `slide_type st`, `score = clamp01(kindScore + overlapScore +
structureScore − repetitionPenalty)`, where:

1. **Kind-family match (`kindScore`)** — run a small keyword-family table
   (the same families autodetect uses: finding / agenda / summary / closing /
   cover / data) against `content`. If a family fires and `st.kind` (or, when
   `kind` is absent on an old manifest, `st.name`) equals that family → strong
   boost (e.g. +0.5). The family table is mirrored in TS from the engine
   regexes; this duplication is small (~5 patterns) and is documented with a
   comment pointing at `engine/src/pptx_mcp/autodetect.py` so the two stay in
   sync.

2. **Token overlap (`overlapScore`)** — lowercase-tokenize `content` and the
   slide's descriptive text (`st.name` + `st.description` + each slot's `id`,
   `description`, `example`). Score = overlap count / a normalizing constant,
   capped (e.g. ≤ 0.3). Catches matches the keyword table misses.

3. **Structural fit (`structureScore`)** — cheap shape heuristics on `content`:
   - looks tabular (≥ 2 lines containing a tab / 2+ spaces / `|`, or many
     digits) → boost slides that have a `table` slot.
   - very short (≤ ~6 words, no sentence punctuation) → boost `cover`/`section`.
   - long / multi-sentence → slight boost to `content`/`finding`.

4. **Repetition penalty (`repetitionPenalty`)** — `used[st.id] || 0` drives a
   penalty **only when `st.repeatable` is false**: `penalty = min(0.4, 0.2 *
   usedCount)`. Repeatable types get `penalty = 0` regardless of count.

`reason` is assembled from whichever signals fired, in priority order, and the
repeatable/used branch chooses affirm vs caution wording (see MCP-surface
examples). Sort by score desc, slice `topN`.

All reads are guarded (`manifest?.slide_types ?? []`, `st.slots ?? []`, etc.) so
old manifests and odd shapes never throw — mirrors `toAgentSchema`.

### Persisting `kind`

The PUT route currently persists `name`/`description`/`repeatable`/slots but not
`kind`. Add `kind` to the persisted `slide_type` (from the editor payload, with
fallback to the draft's `kind`/`suggested_name`, default `""`). This gives
routing a stable kind even when the owner renames a slide. Additive and
optional; absent → routing falls back to `st.name`.

(Engine autodetect already emits `kind`; the editor already seeds the slide
`name` from it. This change only threads `kind` through PUT persistence and the
editor save payload alongside the existing `name`/`description`/`repeatable`.)

## Components (isolation)

- **`web/src/lib/routing.ts`** — `scoreLayouts(...)` (pure, the whole brain) +
  the keyword-family table + a `Candidate` type. Unit-tested in isolation.
- **`web/src/app/api/mcp/templates/[id]/suggest-layout/route.ts`** — POST
  handler: `requireApiKey`, load template, ownership/visibility check (same
  shape as the render route), parse `{ content, used }`, call `scoreLayouts`,
  return `{ candidates }`.
- **`mcp-server/server.py`** — module proxy `suggest_layout(template_id,
  content, used)` (httpx POST, `X-API-Key`) + `suggest_layout_tool` with a
  docstring teaching: pass one section at a time; pass your running `used`
  tally to get variety; `repeatable` candidates are meant to recur.
- **PUT route + editor save** — thread `kind` through (small additive change).

## Error handling

- Missing/empty `content` → 400 `{ error: "content is required" }`.
- Unknown template → 404; not owner and not public → 403 (mirror render route).
- No `slide_types` (e.g. unsaved template) → 200 `{ candidates: [] }`.
- Malformed `used` (not an object) → treated as `{}` (no penalty), never throws.
- `scoreLayouts` never throws on guarded reads.

## Testing

Web (`web/tests/`):
- `routing.test.ts`:
  - finding-flavored content (severity/CWE) ranks the finding slide first.
  - tabular content boosts a slide with a table slot above a prose slide.
  - `used` penalizes a non-repeatable type (cover drops after used=1) but a
    `repeatable` finding slide stays #1 at used=3.
  - empty / `slide_types`-less manifest → `[]`; malformed `used` → no throw.
  - each candidate carries `repeatable` and a non-empty `reason`.
- `suggest-layout-api.test.ts`: 401 without key; 400 on empty content; 200 with
  ranked candidates for a mocked manifest.
- PUT persistence: extend `templates-save.test.ts` to assert `kind` is
  persisted (and falls back to the draft when blank).

MCP (`mcp-server/tests/test_proxy.py`):
- `suggest_layout` proxies to the right URL with `X-API-Key` and returns the
  candidates payload; docstring mentions `used` and `repeatable`.

## Out of scope

- Slot pre-fill / value mapping (ranking only).
- Whole-document segmentation (agent passes one chunk per call).
- Any LLM or vision.
- Persisting suggestions or server-side deck state (the agent owns `used`).
- Re-ranking by aesthetic balance beyond the `used` penalty.
