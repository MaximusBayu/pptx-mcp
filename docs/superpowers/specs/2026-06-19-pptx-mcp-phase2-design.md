# Technical Spec — PPTX MCP Phase 2 (Multi-tenant SaaS)

**Date:** 2026-06-19
**Status:** Draft (approved design)
**Scope:** Phase 2 — website (auth, per-user template libraries, upload, tag editor with drag-to-move, public gallery), API-key-scoped multi-tenant MCP, stateless Python engine service, Docker Compose. Builds on v1 engine.
**Companions:** [PRD](2026-06-19-pptx-mcp-prd.md), [v1 spec](2026-06-19-pptx-mcp-design.md).

## 1. Overview

Phase 2 turns the v1 engine into a multi-tenant product. Users sign in, upload professionally-designed `.pptx` files, tag shapes as named slots (and drag to reposition) on a visual editor, and publish templates (private or public gallery). AI agents authenticate with a per-user API key and fill those templates through the MCP, getting a download link.

**Architecture principle:** Next.js is the brain (single source of truth for auth, DB, storage, links). The Python engine is stateless compute. The MCP is a thin proxy. This avoids duplicating DB models across languages.

```
                         ┌──────────────── web (Next.js) ───────────────┐
 browser ──────────────▶ │ auth · Prisma/Postgres · S3 · pages · API    │
                         │            │                    ▲             │
 agent ──MCP──▶ mcp-server (thin) ────┘ internal API       │            │
                         └───────────────────┬─────────────┘            │
                                             ▼ (bytes + manifest)        │
                                   engine-service (Python, stateless) ───┘
                                   python-pptx + LibreOffice
```

## 2. Locked Decisions (assumptions for the autonomous run)

| Area | Decision |
|------|----------|
| Component wiring | web=brain; engine-service stateless compute; MCP=thin proxy to web internal API |
| Auth | Auth.js v5: **OAuth (Google + GitHub) AND email+password (Credentials, bcrypt)** |
| DB / ORM | PostgreSQL + Prisma |
| File storage | S3-compatible (MinIO dev, S3/R2 prod); manifests (small JSON) in Postgres |
| Tag editor | Slide PNG + clickable bounding-box overlay (geometry as % of slide) |
| Drag-to-move | Included; `/move-shape` engine endpoint rewrites shape geometry in `base.pptx` |
| Billing | None |
| Visibility | Private per user + optional public gallery |
| MCP auth | Per-user API key (generated in Settings; sent as header) |
| Deploy | Docker Compose: postgres, minio, engine-service, mcp-server, web (LibreOffice in engine image) |
| Animation | Framer Motion + documented motion principle (see §8), mandatory in UI tasks |

## 3. Components

### 3.1 engine-service (Python FastAPI, stateless)
Reuses v1 engine modules. Requires one v1 addition: `load_from_bytes(pptx_bytes:bytes, manifest:dict) -> Template` (engine works without disk). Endpoints (take `multipart`/JSON, return JSON or bytes):

- `POST /extract-shapes` (pptx bytes) → `{slides:[{index, width_emu, height_emu, shapes:[{shape_id, name, type, x, y, w, h, bbox_pct:{x,y,w,h}}]}]}`. `type` guessed (table/picture/text). Powers the tag editor overlay.
- `POST /render-base-previews` (pptx bytes) → `{previews:[png_base64...]}` — one PNG per slide (LibreOffice). The tag editor background images.
- `POST /render-deck` (pptx bytes + manifest + deck_spec) → pptx bytes, or `422` with `{validation:[SlotError...]}`.
- `POST /render-preview` (pptx bytes + manifest + deck_spec) → `{validation:[...], previews:[png_base64...]}`.
- `POST /move-shape` (pptx bytes + shape_id + bbox_pct) → updated pptx bytes (shape repositioned).
- `GET /health` → `{ok:true}`.

Stateless: never reads/writes DB or S3. web passes bytes, gets bytes/JSON.

### 3.2 web (Next.js App Router, TypeScript)
Owns everything stateful.

**Prisma models:**
- `User`, `Account`, `Session`, `VerificationToken` — Auth.js standard, plus `User.passwordHash String?` for Credentials.
- `Template { id, ownerId, name, description, visibility: PRIVATE|PUBLIC, manifestJson Json, basePptxKey String, createdAt, updatedAt }`
- `ApiKey { id, userId, prefix String, hash String, lastUsedAt, createdAt }` (raw key shown once; only hash stored)

**Server modules:**
- `lib/s3.ts` — put/get/presign (MinIO/S3).
- `lib/engine.ts` — typed client for engine-service endpoints.
- `lib/auth.ts` — Auth.js config (Google, GitHub, Credentials+bcrypt).
- `lib/apiKey.ts` — generate/verify keys (prefix + bcrypt hash).

**Pages (all animated, §8):**
- `/login`, `/register` (email+password + OAuth buttons)
- `/dashboard` — my templates (cards, stagger-in)
- `/templates/new` — upload `.pptx`
- `/templates/[id]/edit` — **tag editor** (PNG overlay, click-to-tag, drag-to-move, constraints panel)
- `/gallery` — public templates
- `/settings/keys` — API key management

**API routes:**
- `POST /api/templates` (upload) — store pptx in S3, call `/extract-shapes` + `/render-base-previews`, create Template draft.
- `PUT /api/templates/[id]` — save manifest JSON, name, description, visibility.
- `POST /api/templates/[id]/move-shape` — proxy to engine `/move-shape`, persist updated pptx to S3.
- `GET /api/templates`, `GET /api/templates/[id]`, `DELETE /api/templates/[id]`.
- API keys: `POST /api/keys`, `GET /api/keys`, `DELETE /api/keys/[id]`.
- **Internal MCP API** (auth via `X-API-Key`, not session):
  - `GET /api/mcp/templates` → list caller's + public templates (summaries)
  - `GET /api/mcp/templates/[id]/schema` → agent-facing schema
  - `POST /api/mcp/templates/[id]/render` → `{deck_spec}` → `{validation, download_url|null}`
  - `POST /api/mcp/templates/[id]/preview` → `{deck_spec}` → `{validation, previews}`

### 3.3 mcp-server (Python, thin proxy)
FastMCP tools that call the web internal MCP API with the configured `X-API-Key`. No engine/DB/S3 access of its own.
- `list_templates()` → `GET /api/mcp/templates`
- `get_template_schema(template_id)` → `GET .../schema`
- `render_deck(template_id, deck_spec)` → `POST .../render`
- `render_preview(template_id, deck_spec)` → `POST .../preview`

### 3.4 Infra — Docker Compose
Services: `postgres`, `minio` (+ bucket init), `engine-service` (LibreOffice + poppler), `web`, `mcp-server`. `.env.example` documents all secrets. Compose defaults let the agent run end-to-end locally.

## 4. Key Data Flows

**Upload → tag:** browser uploads `.pptx` → `POST /api/templates` → S3 put + engine `/extract-shapes` + `/render-base-previews` → Template draft (PNG keys + shape geometry cached in `manifestJson.draft`) → redirect to `/templates/[id]/edit`.

**Tag + drag:** editor shows slide PNG with absolutely-positioned overlay boxes (from `bbox_pct`). Click a box → assign `slot.id/name/type/constraints`. Drag a box → `POST .../move-shape` → engine returns updated pptx → S3 overwrite + new previews → overlay refreshes. **Save** → `PUT /api/templates/[id]` persists `manifestJson` (the real manifest) + visibility.

**Agent render:** agent → MCP `render_deck` → `POST /api/mcp/templates/[id]/render` (X-API-Key) → web verifies key → loads `manifestJson` + `base.pptx` from S3 → engine `/render-deck` → store output in S3 → presigned URL → MCP returns to agent.

## 5. Error Handling

- Engine validation errors flow back as `SlotError` dicts (same shape as v1): `{slide_index, slot_id, code, message}`.
- API-key auth failures → `401`. Unknown/forbidden template → `404`/`403` (never leak others' templates).
- Upload of non-pptx / corrupt file → `400` with message.
- engine-service unreachable → web returns `502` with a clear message; UI shows a retry toast.

## 6. Security

- Passwords: bcrypt (cost ≥ 12). Never log raw passwords or keys.
- API keys: format `pk_<prefix>_<secret>`; store only `prefix` + bcrypt(`secret`). Show raw once on creation.
- Internal MCP API authorizes the resolved user against the template's `ownerId`/`visibility`.
- Presigned download URLs short-lived (default 1h).
- S3 buckets private; downloads only via presign.

## 7. Testing

- **engine-service:** per-endpoint tests reusing v1 fixtures (bytes in → assert JSON/bytes out); `/move-shape` repositions; `/extract-shapes` returns sane `bbox_pct` (0–100).
- **web (unit/integration):** Prisma against a test Postgres; API routes with mocked S3 + mocked engine client; Auth.js Credentials login/register; API-key generate/verify; internal MCP API authorization (owner vs public vs forbidden). Session-mocked for OAuth-gated routes.
- **web (component):** tag editor overlay positions boxes from `bbox_pct`; drag updates state; reduced-motion disables animation.
- **mcp-server:** thin proxy functions hit a mocked web API; assert request shape + response passthrough.
- **e2e (smoke, Compose up):** register → upload sample pptx → tag → save → create API key → MCP render → download non-empty pptx.

## 8. Animation Principle (cross-cutting, mandatory)

Smooth motion is a product requirement, not decoration. Every UI task MUST apply it.

- **Library:** Framer Motion.
- **Route/page transitions:** fade+slide (≤250ms, ease-out) via a shared layout wrapper.
- **Lists/cards:** staggered entrance (`staggerChildren` ~40ms); dashboard/gallery cards animate in.
- **Modals/drawers/toasts:** scale+fade enter/exit with `AnimatePresence`.
- **Tag editor:** overlay boxes animate on select (border/scale); drag uses Framer `drag` with spring feedback; newly added slot animates in.
- **Interaction feedback:** buttons/cards hover+tap micro-interactions (`whileHover`/`whileTap`).
- **Performance:** animate only `transform`/`opacity` (60fps); no layout-thrashing properties.
- **Accessibility:** honor `prefers-reduced-motion` — a `useReducedMotion` gate disables/reduces all non-essential motion globally.

## 9. Out of Scope (phase 3+)

Billing/Stripe, org/team tenancy, template versioning, in-browser full WYSIWYG slide authoring, charts, real-time co-editing.
