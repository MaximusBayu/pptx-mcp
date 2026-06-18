# PRD — Template-Driven PPTX MCP

**Date:** 2026-06-19
**Status:** Draft (approved design)
**Owner:** tahubulat696969@gmail.com

## 1. Problem

AI agents that build PowerPoint decks programmatically produce ugly, inconsistent, off-brand output. Layout, spacing, fonts, and alignment are wrong because the agent makes thousands of low-level decisions it is bad at. We want decks that always look professionally designed regardless of which agent fills them.

## 2. Solution

Separate **design** from **content**:

- Humans (designers/users) build slide designs in real PowerPoint and register them as **templates** with named, typed **slots**.
- An **MCP server** lets any AI agent discover those templates, read their slot schema, and supply only **content** (text, tables, images) into named slots.
- The agent never touches layout, position, fonts, or color. The template owns all design.

Output is a finished `.pptx` delivered via a short-lived download link.

## 3. Goals

- Agent-produced decks are visually indistinguishable from the human-designed template.
- Agents fill decks through a small, predictable tool surface — no low-level pptx manipulation.
- Templates are reusable across unlimited decks; one design powers many.
- Overflow (too much content for a slot) is caught and corrected, never silently broken.

## 4. Non-Goals (v1)

- No in-browser deck authoring / WYSIWYG PowerPoint clone.
- No charts (text, tables, images only).
- No multi-tenant SaaS, auth, or accounts in v1 (deferred to phase 2).
- No agent control over layout, theme, or design.

## 5. Users

- **Template authors** — design slides in PowerPoint, register them as templates with slots. (v1: via CLI; phase 2: via website.)
- **AI agents** — consume templates through MCP, supply content, get a deck.
- **End users** — receive the finished `.pptx` download link from their agent.

Target deployment: **multi-user SaaS** (phase 2+). v1 proves the engine + MCP loop single-user.

## 6. Core User Story

> As an AI agent, I list available templates, read a chosen template's slot schema, build a `deck_spec` (ordered slides, each a slide type with its slots filled), preview thumbnails to check fit, then render a final `.pptx` and hand the user a download link.

## 7. Key Concepts

- **Template** — a designed slide kit + machine contract. Owns all design.
- **Slide type** — one reusable designed slide (title, agenda, bullet, table, image…) with named slots.
- **Slot** — a named, typed content hole (`text` | `table` | `image`) with constraints.
- **deck_spec** — the agent's content payload: an ordered list of slides, each `{slide_type, slots}`.
- **Slide kit** — agent picks slide types, orders them, repeats freely. Deck length/structure is flexible.

## 8. Requirements

### Functional
- F1. Agent can list templates with summaries.
- F2. Agent can fetch a template's full slot schema (slide types, slots, types, constraints).
- F3. Agent can render a preview (validation report + per-slide PNG links) without committing a final file.
- F4. Agent can render a final deck → validated `.pptx` → short-lived download link.
- F5. Slots support text/rich text, tables, and images.
- F6. Agent assembles arbitrary-length decks by picking/ordering/repeating slide types.
- F7. Template authors register templates from a `.pptx` via a CLI that scaffolds `manifest.json`.

### Quality / Constraints
- Q1. **Overflow:** validate against per-slot constraints; auto-shrink text within a floor; reject (with structured errors) when content cannot fit cleanly.
- Q2. Final deck visual fidelity matches the source template design.
- Q3. Agent errors are structured and actionable (`{slide_index, slot_id, reason}`) so the agent can self-correct and retry.
- Q4. Tool surface is minimal and stateless (one-shot render + optional preview).

## 9. Success Metrics

- A deck filled by an agent passes "looks professionally designed" eyeball review without manual fixes.
- Agent completes list → schema → render loop with zero low-level pptx knowledge.
- Overflow never produces overlapping/clipped text in delivered decks.

## 10. Phasing

- **v1 (this spec):** Python render engine + MCP server + CLI template-registration helper. Templates on local disk. File delivery via small HTTP token-link server.
- **Phase 2:** Next.js full-stack website — auth, per-user template libraries, `.pptx` upload, click-to-tag slot editor (produces `manifest.json`), light refine (move/restyle/defaults), API-key auth scoping MCP per user, Postgres + object storage.

## 11. Risks

- python-pptx has no native slide-copy; assembling a kit requires XML/relationship deep-copy. (Highest risk.)
- LibreOffice headless dependency for preview PNGs.
- Shape-targeting stability between authoring and render (pinned in manifest).
- Auto-shrink fidelity at small font sizes.
