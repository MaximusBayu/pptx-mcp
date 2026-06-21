# Agent-Legible Templates (heuristic auto-annotate) — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending spec review before plan.

## Goal

Make a saved template self-documenting so an AI agent can (a) pick the right
slide for a piece of information and (b) fill each slot correctly — **without
the user typing hints and without any LLM**. The template's own placeholder
text and structure are mined heuristically to pre-fill editable metadata that
the agent later reads through the schema.

## Background

Today `get_template_schema` returns each `slide_type` as `{id, name, description}`
+ slots `{id, name, type, required, default, constraints}`. But:
- `slide_type.description` is always `""` and `name` is the generic `"Slide N"`
  (the editor can't set them; the PUT route hardcodes them).
- slots have no human **hint** or **example** of what content belongs.
- the schema returns no concrete example to imitate.

So an agent can only guess a slide's purpose from slot ids. The fix mines what
the template already carries.

## Key insight

A template's shapes already contain **representative text** the designer wrote
("Presented by James Porter", "Severity: CRITICAL", agenda items). Surfacing
that text as each slot's **example** is the single biggest agent win, and it is
free. The existing `autodetect` classifier already infers shape type / id /
confidence; we extend it to also infer **slide kind**, **repeatable**, and
**slot examples** — all deterministic, offline, unit-testable.

## Decisions

1. **No LLM.** Annotation is heuristic (keywords + structure + original text).
2. **Annotate at auto-detect time** (engine, during upload). Results land in the
   draft manifest and pre-fill the editor.
3. All annotated fields stay **user-editable** (override / fallback).

## Data model (manifest additions)

```
slide_type: { id, name, description, repeatable: bool, source_slide_index, slots[] }
slot:       { id, name, type, required, default, constraints,
              description: str,   # short "what goes here" hint
              example: <type-appropriate> }   # sample value (often the
                                               # template's own text)
```
`id` stays `slide_<index>` (stable; used in `deck_spec`). `name` becomes a human
label (e.g. `finding`). All new fields are optional; absence = today's behavior.

## Engine — `autodetect` extensions (`engine/src/pptx_mcp/autodetect.py`)

Per shape, add:
- **`text`**: the shape's text content, stripped + truncated (e.g. ≤ 200 chars).
- **`suggested_example`**: for a text candidate, the original `text` truncated to
  `suggested_max_chars`; for table/image candidates, a type-default (table →
  small `list[list]`, image → a sample URL) — the web already has these defaults
  in `example.ts`.
- **`suggested_description`**: a deterministic label from `suggested_id`
  (`title`→"Slide title", `subtitle`→"Subtitle", `body`→"Body text",
  `table_*`→"Table", `image_*`→"Image", else "Text").

Per slide, add:
- **`kind`** + **`suggested_name`**: keyword/structure rules on the slide's
  dominant (largest-area, top-most) text and shape mix:
  - index 0, or title + subtitle and few other shapes → `cover`
  - matches `/agenda|overview|outline|contents|daftar isi/i`, or many small
    numbered items → `agenda`
  - matches `/summary|ringkasan|executive/i` → `summary`
  - matches `/finding|temuan|severity|critical|high|medium|low|cwe|cvss/i` →
    `finding`
  - contains a table → `data`
  - matches `/thank|terima kasih|questions|q&a/i` → `closing`
  - single large title, few shapes → `section`
  - else → `content`
  `suggested_name` = `kind`.
- **`suggested_description`**: a templated sentence from kind + tagged slot ids,
  e.g. `"Finding slide — fill: title, severity, description. Repeat per item."`
- **`repeatable`**: structural-similarity flag. Compute a signature per slide =
  the sorted multiset of `(effective_type, area_bucket)` over candidate shapes
  plus the set of `suggested_id`s. If ≥ 2 slides share a signature, all slides in
  that group get `repeatable = true` (catches the F1–F4 finding pattern). Cover
  / closing / single-instance slides → `false`.

These are pure functions over the parsed deck; no I/O, no network.

## Engine — actionable validation (`engine/src/pptx_mcp/validate.py`)

`SlotError` messages carry numbers so the agent can self-correct:
- `text_overflow` → `"max {max_chars} chars, got {len}"`
- `wrong_type` → `"expected {type}, got {pytype}"`
- `table_overflow` → `"max {max_rows}x{max_cols}, got {r}x{c}"`

(No engine change is needed for repeatability — the engine already renders any
`slide_type` as many times as `deck_spec` lists it; `repeatable` is a hint.)

## Web — persistence (`/api/templates/[id]` PUT + upload flow)

- Upload stores the extended `autodetect` output in `manifestJson.draft.slides`
  (it already stores the draft).
- PUT stops hardcoding `name: "Slide N"`, `description: ""`. It accepts the
  editor-provided `slideTypes[].{name, description, repeatable}` and
  `slots[].{description, example}` and persists them. When a field is blank it
  falls back to the autodetect suggestion, then to today's default.

## Web — editor (`TagEditor` / `SlotPanel` / `EditClient`)

- **Slide settings card** (top of the sidebar, for the current slide): inputs
  for **Name**, **Description**, and a **"Repeat per item"** toggle — seeded
  from `slide.suggested_name / suggested_description / repeatable`.
- **SlotPanel** gains **Description** and **Example** inputs per slot — seeded
  from `shape.suggested_description / suggested_example`.
- `buildInitialSlots` seeds `slot.constraints` (as today) plus `description` and
  `example`. A parallel `buildInitialSlideMeta(slides)` seeds the per-slide
  card state.
- `EditClient.save` sends per-slide `{name, description, repeatable}` and per-slot
  `{description, example}` in the PUT body.

## Web — schema (`web/src/lib/schema.ts`, `example.ts`)

- `toAgentSchema` adds `slide.repeatable`, and slot `description` + `example`.
- Add a top-level **`example_deck_spec`** built from the manifest, using each
  slot's `example` when present, else the `example.ts` type-default. Reuse /
  extend `buildExampleDeckSpec`.

## MCP (`mcp-server/server.py`)

- `get_template_schema_tool` already proxies the schema → it now returns the
  enriched, example-bearing schema automatically.
- Tighten the four tool **docstrings**: the `list → schema → render` flow; value
  types (text=str, table=`list[list]`, image=URL/base64); and "to repeat a
  `repeatable` slide_type, list it once per item in `deck_spec.slides`."

## Testing

Engine (`engine/tests/`):
- `text` populated; `suggested_example` = original text truncated to max_chars.
- slide `kind`: a deck whose slide-0 → `cover`; an "Agenda/Overview" slide →
  `agenda`; a slide with `Severity/CWE` text → `finding`; a slide with a table →
  `data`; a "Thank You" slide → `closing`.
- `repeatable`: two structurally-identical finding slides → both `repeatable`;
  a unique cover → `false`.
- validation: overflow message contains the max and the actual length.

Web (`web/tests/`):
- `toAgentSchema` includes slot `description`/`example`, slide `repeatable`, and
  a non-empty `example_deck_spec` whose values use `slot.example` when set.
- PUT persists `slideTypes[].{name,description,repeatable}` +
  `slots[].{description,example}` (and falls back when blank).
- editor: slide-settings + slot description/example render seeded values and
  flow into the save payload.

## Out of scope

- Any LLM / vision annotation.
- Auto-routing in the engine (the agent still picks `slide_type` per slide).
- Enforced slot enums (hints only).
- Multi-run / rich-text slot formatting.
