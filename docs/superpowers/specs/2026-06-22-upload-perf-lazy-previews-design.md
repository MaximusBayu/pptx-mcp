# Upload Performance — Lazy Previews + Staged Progress — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** A of two (B = engine fit quality: text overflow + table cells, deferred).

## Goal

Make uploading large `.pptx` templates (observed: 60 MB) fast and reliable. The
upload request must no longer run the slow LibreOffice preview render. Previews
render once, lazily, on first editor open, cached to S3. Both phases show a
staged progress indicator so the user always knows what stage they are in.

## Background

Current upload (`web/src/app/api/templates/route.ts` `POST`) does everything in
one synchronous request:

1. `req.formData()` then `Buffer.from(await file.arrayBuffer())` — buffers the
   whole file twice in the Node heap.
2. `putObject(base.pptx)` to S3/MinIO.
3. `autodetect(bytes)` — POSTs the full file to the engine (parse with
   python-pptx). Reasonably fast.
4. `renderBasePreviews(bytes)` — POSTs the **full file a second time**; the
   engine runs a single `soffice --convert-to pdf` over the whole deck then
   `pdftoppm` to PNGs (`engine/src/pptx_mcp/preview.py`). This is the dominant
   cost and the part that times out / OOMs on big files.
5. N × `putObject` for each preview PNG.

The editor consumes previews from `manifestJson.draft.previewKeys`:
`web/src/app/(app)/templates/[id]/edit/page.tsx` presigns them and passes
`previewUrls` to `EditClient`.

Root cause of "slow / sometimes fails": the upload request blocks on the whole
LibreOffice render of a 60 MB deck, and the file crosses to the engine twice.

## Decisions

1. **Lazy previews** — upload stores the file + runs autodetect only; the render
   happens once on first editor open, cached to S3. (Chosen over a background
   job queue: robust on a single VPS with no extra infra.)
2. **Staged progress UI** — determinate byte-upload bar for the real file
   transfer, then coarse honest stage labels for server-side work. No per-slide
   render % (the soffice render is one subprocess; sub-slide progress would need
   engine streaming — out of scope).
3. **Idempotent base-previews endpoint** — safe to call repeatedly; renders only
   when previews are absent, otherwise returns cached URLs.
4. **No engine architecture change** — `preview.py` stays a single-call render;
   only a resolution flag is added.

## Components

### 1. Upload route — `web/src/app/api/templates/route.ts` (`POST`)

New flow:

1. Auth (unchanged).
2. Read file from `formData()`. Reject non-`.pptx` (unchanged) and reject files
   over a size cap with HTTP `413`.
3. `putObject(base.pptx)`.
4. `autodetect(bytes)`. On failure, return a clear `502`/`422` and **do not**
   create the template.
5. Create the template with:
   ```
   manifestJson: { draft: { slides: detected.slides, previewKeys: [],
                            previewsStatus: "pending" } }
   ```
6. Return `{ id }`.

**No `renderBasePreviews` call.** This removes the second 60 MB engine transfer
and the blocking render.

**Size cap:** `MAX_UPLOAD_BYTES = 100 * 1024 * 1024` (100 MB). Over cap →
`Response.json({ error: "file too large (max 100MB)" }, { status: 413 })`.
Checked via `file.size` before buffering where possible.

### 2. New endpoint — `web/src/app/api/templates/[id]/base-previews/route.ts` (`POST`)

Owner-only (session auth; mirrors the auth shape of
`web/src/app/api/templates/[id]/preview/route.ts`).

Logic:

1. Auth → `401`. Load template → `404` if missing, `403` if not owner.
2. Read `draft = manifestJson.draft`. If `draft.previewKeys?.length`, presign and
   return `{ status: "ready", previewUrls }` (idempotent fast path).
3. Otherwise:
   - `getObject(basePptxKey)`.
   - `renderBasePreviews(base)` (single engine call).
   - For each PNG, `putObject("templates/<id>/preview-<i>.png", ...)`; collect
     keys.
   - Persist into `manifestJson.draft`: `previewKeys`, `previewsStatus:"ready"`.
   - Presign keys, return `{ status: "ready", previewUrls }`.
4. On engine failure, leave `previewsStatus:"pending"` and return `502`
   `{ error: "preview render failed" }` so the editor can offer Retry.

Persistence uses the same `manifestJson` read-modify-write pattern as
`web/src/app/api/templates/[id]/route.ts`, preserving any existing
`slide_types` / other manifest keys (spread, do not overwrite the whole object).

### 3. Editor — `edit/page.tsx` + `EditClient.tsx`

- `edit/page.tsx`: still presigns `draft.previewKeys` (empty array when pending).
  Pass a new prop `previewsPending: boolean = (draft.previewKeys ?? []).length === 0`
  alongside the existing `previewUrls`.
- `EditClient.tsx`: if `previewsPending`, on mount call
  `POST /api/templates/[id]/base-previews`, show the staged progress overlay, and
  on success set local `previewUrls` state from the response and render the
  canvas. On failure show an error with a **Retry** button that re-calls the
  endpoint. Existing behavior (when previews already present) is unchanged.

### 4. Progress UI

**Upload phase — `web/src/app/(app)/templates/new/page.tsx`:**
Replace the `fetch` upload with `XMLHttpRequest` to get a real determinate
progress bar from `xhr.upload.onprogress` (fetch has no upload-progress events).
Stages shown:
- `Uploading file… NN%` (determinate, real bytes).
- `Analyzing slides…` (indeterminate) — from upload-complete until the `{ id }`
  response arrives.
Then `router.push('/templates/<id>/edit')`.

A small `UploadProgress` presentational component renders the current stage label
+ bar (determinate when a 0–100 value is supplied, indeterminate animated bar
otherwise). Drag-drop + click upload (just added) both route through it.

### 5. Editor render-phase progress

Reuse the same staged indicator inside `EditClient`:
- `Rendering previews…` (indeterminate) while the base-previews call is in
  flight.
- On success the overlay clears and the canvas appears (implicit "Ready").
- On failure: `Preview render failed` + Retry.

Stage labels are honest and coarse; only the file byte-upload is determinate.

### 6. Engine — `engine/src/pptx_mcp/preview.py`

Lower raster resolution to speed `pdftoppm` and shrink PNG payloads. Add a fixed
`-r 100` (≈100 DPI; editor canvas is small, full DPI is wasted):
```
[_PDFTOPPM, "-png", "-r", "100", str(pdf), str(tmp / "page")]
```
No signature change; single-call render is unchanged otherwise.

### 7. Limits / infra

- Confirm the engine-service (FastAPI/uvicorn) accepts large multipart bodies
  (Starlette streams uploads to a spooled temp file — no app-level cap to add)
  and that no upstream timeout is shorter than autodetect needs for ~100 MB.
- Confirm the reverse proxy (Caddy, per `DEPLOY.md`) does not cap request body
  size below 100 MB; Caddy has no default body limit, so no change expected —
  noted as a deploy verification item, not a code change.

## Data flow

```
/new upload (XHR, determinate bar)
  -> POST /api/templates
       store base.pptx + autodetect
       template.draft = { slides, previewKeys: [], previewsStatus: "pending" }
     <- { id }
  -> redirect /templates/<id>/edit
       previewsPending == true
       -> POST /api/templates/<id>/base-previews  ("Rendering previews…")
            render (single soffice) -> cache PNGs -> draft.previewKeys, status "ready"
          <- { status: "ready", previewUrls }
       -> canvas renders
  later opens: draft.previewKeys present -> served from cache, no render
```

## Error handling / edges

- Upload over 100 MB → `413` with message; UI shows the error, no template made.
- Non-`.pptx` → `400` (unchanged).
- autodetect failure → no template created; UI shows error.
- base-previews engine failure → status stays `pending`, `502`; editor shows
  Retry; a later open re-attempts.
- Concurrent base-previews calls: the idempotent cached fast path means a second
  call after the first persists returns cached URLs; a race that renders twice is
  harmless (last write wins, same keys overwritten) — acceptable, no locking.
- Templates created before this change already have `previewKeys` populated, so
  `previewsPending` is false and they behave exactly as today (back-compatible).

## Testing

- `web` unit (vitest):
  - Upload route: valid `.pptx` creates a template with `previewsStatus:"pending"`
    and empty `previewKeys`, and **does not** call `renderBasePreviews` (mock the
    engine lib; assert not called). Oversized file → `413`.
  - base-previews route: when `previewKeys` already present → returns cached URLs
    without calling the engine; when absent → calls render once, persists keys +
    `status:"ready"`, returns URLs; engine throw → `502` and status unchanged.
- `web` component (vitest + testing-library):
  - `UploadProgress` renders a determinate bar for a numeric value and an
    indeterminate bar + stage label otherwise.
  - `EditClient`: with `previewsPending` it calls the endpoint and renders the
    canvas on success; on failure shows Retry which re-calls.
- `engine` (pytest): `preview()` invokes `pdftoppm` with `-r 100` (assert the
  command argv contains the flag, via a monkeypatched `subprocess.run`).

## Out of scope

- Background job queue / worker process.
- Engine fit-quality fixes (text overflow, table cell fitting) — sub-project B.
- Per-slide render progress percentage (needs engine streaming).
- Streaming the S3 upload to avoid double-buffering — minor; autodetect needs the
  full bytes anyway. Can revisit if heap pressure shows up.
- Resumable / chunked uploads.
