# Upload Performance — Lazy Previews + Staged Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large `.pptx` uploads fast and reliable by moving the LibreOffice preview render out of the upload request — previews render lazily on first editor open, cached to S3, with a staged progress UI in both phases.

**Architecture:** The upload route stores the file + runs autodetect only (no render). A new idempotent `POST /api/templates/[id]/base-previews` endpoint renders + caches previews on first editor open. The browser upload uses `XMLHttpRequest` for a real byte-progress bar; the editor reuses the same progress component while previews render. The engine drops preview DPI to 100 for speed.

**Tech Stack:** Next.js App Router (route handlers + React client components), TypeScript, vitest + @testing-library/react, AWS SDK v3 (MinIO), python-pptx + LibreOffice (engine), pytest.

**Spec:** `docs/superpowers/specs/2026-06-22-upload-perf-lazy-previews-design.md`

## Global Constraints

- `MAX_UPLOAD_BYTES = 100 * 1024 * 1024` (100 MB); over cap → HTTP `413`.
- Preview cache keys: `templates/<id>/preview-<i>.png`.
- Draft manifest fields: `manifestJson.draft.previewKeys: string[]`,
  `manifestJson.draft.previewsStatus: "pending" | "ready"`.
- `previewsPending` is derived as `(draft.previewKeys ?? []).length === 0` — pre-existing templates already have keys, so they behave exactly as today (back-compatible).
- The base-previews endpoint is idempotent: if `previewKeys` already present, return cached presigned URLs without calling the engine.
- Manifest persistence is read-modify-write: spread the existing `manifestJson` and the existing `draft`; never overwrite the whole object (preserves `slide_types` and other keys).
- Engine preview raster: `pdftoppm -r 100`.
- Upload route must NOT call `renderBasePreviews`.
- Owner-only auth on the new endpoint: `401` no session, `404` missing, `403` not owner (mirrors `web/src/app/api/templates/[id]/preview/route.ts`).

---

### Task 1: Engine preview DPI (`-r 100`)

**Files:**
- Modify: `engine/src/pptx_mcp/preview.py:28-31`
- Test: `engine/tests/test_preview.py`

**Interfaces:**
- Produces: `_pdftoppm_cmd(binary: str, pdf_path, out_prefix) -> list[str]` — the pdftoppm argv, including `-r 100`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/test_preview.py`:
```python
from pptx_mcp.preview import _pdftoppm_cmd


def test_pdftoppm_cmd_sets_100_dpi():
    cmd = _pdftoppm_cmd("pdftoppm", "/tmp/deck.pdf", "/tmp/page")
    assert cmd[0] == "pdftoppm"
    assert "-png" in cmd
    assert "-r" in cmd
    assert cmd[cmd.index("-r") + 1] == "100"
    assert str("/tmp/deck.pdf") in cmd
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `engine/`): `pytest tests/test_preview.py::test_pdftoppm_cmd_sets_100_dpi -v`
Expected: FAIL with `ImportError: cannot import name '_pdftoppm_cmd'`.

- [ ] **Step 3: Implement**

In `engine/src/pptx_mcp/preview.py`, add the helper above the `preview` function:
```python
def _pdftoppm_cmd(binary, pdf_path, out_prefix) -> list:
    # -r 100: ~100 DPI is plenty for the small editor canvas; keeps the
    # render fast and the PNGs small (upload-perf spec).
    return [binary, "-png", "-r", "100", str(pdf_path), str(out_prefix)]
```
Replace the existing `pdftoppm` call (currently lines 28-31):
```python
        subprocess.run(
            [_PDFTOPPM, "-png", str(pdf), str(tmp / "page")],
            check=True, capture_output=True,
        )
```
with:
```python
        subprocess.run(
            _pdftoppm_cmd(_PDFTOPPM, pdf, tmp / "page"),
            check=True, capture_output=True,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `engine/`): `pytest tests/test_preview.py -v`
Expected: PASS (the new test passes; `test_libreoffice_available_is_bool` still passes; the LibreOffice render test stays skipped/passing as before).

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/preview.py engine/tests/test_preview.py
git commit -m "perf(engine): render previews at 100 DPI via _pdftoppm_cmd"
```

---

### Task 2: Slim the upload route (no render, size cap, pending status)

**Files:**
- Modify: `web/src/app/api/templates/route.ts`
- Test: `web/tests/templates-upload.test.ts`

**Interfaces:**
- Consumes: `autodetect` from `@/lib/engine`; `putObject` from `@/lib/s3`; `createId` from `@/lib/id`.
- Produces: a template whose `manifestJson.draft` = `{ slides, previewKeys: [], previewsStatus: "pending" }`.

- [ ] **Step 1: Write the failing tests**

Replace the engine mock and add tests in `web/tests/templates-upload.test.ts`. Change the engine mock (it no longer needs `renderBasePreviews` to resolve, but keep it as a spy to assert it is NOT called) and import it:
```ts
vi.mock("@/lib/engine", () => ({
  autodetect: vi.fn().mockResolvedValue({
    slides: [{ index: 0, width_emu: 1, height_emu: 1, shapes: [
      { shape_id: 2, name: "TextBox 2", type: "text",
        bbox_pct: { x: 10, y: 5, w: 70, h: 15 }, confidence: 0.9,
        is_candidate: true, suggested_id: "title",
        suggested_max_chars: 40, suggested_max_lines: 2, font_pt: 40 },
    ] }],
  }),
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: [] }),
}));
```
Update the import line to also pull the spy:
```ts
import { autodetect, renderBasePreviews } from "@/lib/engine";
```
Add these tests inside `describe("upload", ...)`:
```ts
it("stores pending status with empty previewKeys and does NOT render", async () => {
  (auth as any).mockResolvedValue({ user: { id: "u1" } });
  (prisma.template.create as any).mockResolvedValue({ id: "t1" });
  await POST(upload());
  const createCall = (prisma.template.create as any).mock.calls[0][0];
  const draft = (createCall.data.manifestJson as any).draft;
  expect(draft.previewsStatus).toBe("pending");
  expect(draft.previewKeys).toEqual([]);
  expect(renderBasePreviews).not.toHaveBeenCalled();
});

it("413 when the file exceeds the size cap", async () => {
  (auth as any).mockResolvedValue({ user: { id: "u1" } });
  const fd = new FormData();
  const file = new File([Buffer.from("PK")], "big.pptx");
  Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
  fd.append("file", file);
  const req = new Request("http://x/api/templates", { method: "POST", body: fd });
  expect((await POST(req)).status).toBe(413);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/`): `npx vitest run tests/templates-upload.test.ts`
Expected: FAIL — `previewsStatus` undefined / `renderBasePreviews` was called / no 413.

- [ ] **Step 3: Implement**

Replace the `POST` in `web/src/app/api/templates/route.ts` (keep `GET` unchanged). The full file:
```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/s3";
import { autodetect } from "@/lib/engine";
import { createId } from "@/lib/id";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file || !file.name.endsWith(".pptx")) {
    return Response.json({ error: "expected a .pptx file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large (max 100MB)" }, { status: 413 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createId();
  const baseKey = `templates/${id}/base.pptx`;
  await putObject(baseKey, bytes, PPTX);

  let detected;
  try {
    detected = await autodetect(bytes);
  } catch {
    return Response.json({ error: "could not analyze the .pptx" }, { status: 502 });
  }

  const tpl = await prisma.template.create({
    data: {
      id, ownerId: session.user.id, name: file.name.replace(/\.pptx$/, ""),
      basePptxKey: baseKey,
      manifestJson: { draft: { slides: detected.slides, previewKeys: [], previewsStatus: "pending" } } as object,
    },
  });
  return Response.json({ id: tpl.id }, { status: 201 });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const templates = await prisma.template.findMany({
    where: { ownerId: session.user.id }, orderBy: { updatedAt: "desc" },
  });
  return Response.json(templates);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `web/`): `npx vitest run tests/templates-upload.test.ts`
Expected: PASS (all upload tests, including the existing draft tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/templates/route.ts web/tests/templates-upload.test.ts
git commit -m "perf(web): upload stores pending draft + size cap, no blocking render"
```

---

### Task 3: Lazy base-previews endpoint

**Files:**
- Create: `web/src/app/api/templates/[id]/base-previews/route.ts`
- Test: `web/tests/base-previews-api.test.ts`

**Interfaces:**
- Consumes: `getObject`, `putObject`, `presignGet` from `@/lib/s3`; `renderBasePreviews` from `@/lib/engine`; `prisma`; `auth`.
- Produces: `POST` returning `{ status: "ready", previewUrls: string[] }`; persists `draft.previewKeys` + `draft.previewsStatus="ready"`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/base-previews-api.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from("PK")),
  putObject: vi.fn().mockResolvedValue("key"),
  presignGet: vi.fn(async (k: string) => `https://files/${k}`),
}));
vi.mock("@/lib/engine", () => ({
  renderBasePreviews: vi.fn().mockResolvedValue({ previews: ["AAA", "BBB"] }),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { renderBasePreviews } from "@/lib/engine";
import { POST } from "@/app/api/templates/[id]/base-previews/route";

const ctx = { params: Promise.resolve({ id: "t1" }) };
const req = () => new Request("http://x/api/templates/t1/base-previews", { method: "POST" });

beforeEach(() => vi.clearAllMocks());

describe("base-previews", () => {
  it("401 without session", async () => {
    (auth as any).mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 when template missing", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("403 when not owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "other", manifestJson: { draft: {} } });
    expect((await POST(req(), ctx)).status).toBe(403);
  });

  it("returns cached urls without rendering", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { draft: { previewKeys: ["templates/t1/preview-0.png"], previewsStatus: "ready" } },
    });
    const r = await POST(req(), ctx);
    const body = await r.json();
    expect(body.status).toBe("ready");
    expect(body.previewUrls).toEqual(["https://files/templates/t1/preview-0.png"]);
    expect(renderBasePreviews).not.toHaveBeenCalled();
    expect(prisma.template.update).not.toHaveBeenCalled();
  });

  it("renders, caches, persists when no keys", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { draft: { slides: [], previewKeys: [], previewsStatus: "pending" } },
    });
    const r = await POST(req(), ctx);
    const body = await r.json();
    expect(renderBasePreviews).toHaveBeenCalledTimes(1);
    expect(body.previewUrls).toHaveLength(2);
    const updateArg = (prisma.template.update as any).mock.calls[0][0];
    const draft = (updateArg.data.manifestJson as any).draft;
    expect(draft.previewKeys).toEqual(["templates/t1/preview-0.png", "templates/t1/preview-1.png"]);
    expect(draft.previewsStatus).toBe("ready");
  });

  it("502 when render fails, no persist", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({
      id: "t1", ownerId: "u1", basePptxKey: "templates/t1/base.pptx",
      manifestJson: { draft: { previewKeys: [] } },
    });
    (renderBasePreviews as any).mockRejectedValueOnce(new Error("boom"));
    expect((await POST(req(), ctx)).status).toBe(502);
    expect(prisma.template.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/`): `npx vitest run tests/base-previews-api.test.ts`
Expected: FAIL — module `base-previews/route` does not exist.

- [ ] **Step 3: Implement**

Create `web/src/app/api/templates/[id]/base-previews/route.ts`:
```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderBasePreviews } from "@/lib/engine";

// Owner-only lazy render of the base-deck previews. Idempotent: returns cached
// presigned URLs when previews already exist; otherwise renders once, caches to
// S3, and persists the keys. Called by the editor on first open.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const draft = (tpl.manifestJson as any).draft ?? {};
  const existing: string[] = draft.previewKeys ?? [];
  if (existing.length) {
    const previewUrls = await Promise.all(existing.map((k: string) => presignGet(k)));
    return Response.json({ status: "ready", previewUrls });
  }

  let keys: string[];
  try {
    const base = await getObject(tpl.basePptxKey);
    const { previews } = await renderBasePreviews(base);
    keys = [];
    for (let i = 0; i < previews.length; i++) {
      const key = `templates/${id}/preview-${i}.png`;
      await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
      keys.push(key);
    }
  } catch {
    return Response.json({ error: "preview render failed" }, { status: 502 });
  }

  const manifestJson = {
    ...(tpl.manifestJson as object),
    draft: { ...draft, previewKeys: keys, previewsStatus: "ready" },
  };
  await prisma.template.update({ where: { id }, data: { manifestJson } });
  const previewUrls = await Promise.all(keys.map((k) => presignGet(k)));
  return Response.json({ status: "ready", previewUrls });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `web/`): `npx vitest run tests/base-previews-api.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/templates/[id]/base-previews/route.ts" web/tests/base-previews-api.test.ts
git commit -m "feat(web): idempotent lazy base-previews render endpoint"
```

---

### Task 4: `uploadTemplate` XHR helper

**Files:**
- Create: `web/src/lib/upload.ts`
- Test: `web/tests/upload.test.ts`

**Interfaces:**
- Produces: `type UploadProgress = { stage: "uploading" | "analyzing"; pct: number }` and
  `uploadTemplate(file: File, onProgress: (p: UploadProgress) => void): Promise<{ id: string }>`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/upload.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadTemplate } from "@/lib/upload";

class FakeXHR {
  static instance: FakeXHR;
  upload: any = {};
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open = vi.fn();
  send = vi.fn(() => { FakeXHR.instance = this; });
}

beforeEach(() => { (global as any).XMLHttpRequest = FakeXHR as any; });
afterEach(() => { vi.restoreAllMocks(); });

it("reports upload then analyzing progress and resolves the id", async () => {
  const stages: any[] = [];
  const file = new File([Buffer.from("PK")], "x.pptx");
  const p = uploadTemplate(file, (s) => stages.push(s));

  const xhr = FakeXHR.instance;
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
  xhr.upload.onload?.();
  xhr.status = 201;
  xhr.responseText = JSON.stringify({ id: "t1" });
  xhr.onload?.();

  await expect(p).resolves.toEqual({ id: "t1" });
  expect(stages[0]).toEqual({ stage: "uploading", pct: 50 });
  expect(stages.at(-1)).toEqual({ stage: "analyzing", pct: 100 });
});

it("rejects with the server error on non-2xx", async () => {
  const file = new File([Buffer.from("PK")], "x.pptx");
  const p = uploadTemplate(file, () => {});
  const xhr = FakeXHR.instance;
  xhr.status = 413;
  xhr.responseText = JSON.stringify({ error: "file too large (max 100MB)" });
  xhr.onload?.();
  await expect(p).rejects.toThrow(/file too large/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run tests/upload.test.ts`
Expected: FAIL — `@/lib/upload` does not exist.

- [ ] **Step 3: Implement**

Create `web/src/lib/upload.ts`:
```ts
export type UploadProgress = { stage: "uploading" | "analyzing"; pct: number };

// Uploads a template via XHR so the caller gets a real byte-level progress bar
// (fetch has no upload-progress events). Resolves with the new template id.
export function uploadTemplate(
  file: File,
  onProgress: (p: UploadProgress) => void,
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/templates");
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) {
        onProgress({ stage: "uploading", pct: Math.round((e.loaded / e.total) * 100) });
      }
    };
    xhr.upload.onload = () => onProgress({ stage: "analyzing", pct: 100 });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("bad server response")); }
      } else {
        let msg = "upload failed";
        try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `web/`): `npx vitest run tests/upload.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/upload.ts web/tests/upload.test.ts
git commit -m "feat(web): uploadTemplate XHR helper with progress callback"
```

---

### Task 5: `UploadProgress` component

**Files:**
- Create: `web/src/components/UploadProgress.tsx`
- Test: `web/tests/uploadprogress.test.tsx`

**Interfaces:**
- Produces: `UploadProgress({ stage, pct }: { stage: string; pct?: number })` — determinate bar when `pct` is a number, indeterminate animated bar otherwise.

- [ ] **Step 1: Write the failing test**

Create `web/tests/uploadprogress.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { UploadProgress } from "@/components/UploadProgress";

afterEach(cleanup);

describe("UploadProgress", () => {
  it("determinate: shows stage label and a bar at pct width", () => {
    render(<UploadProgress stage="Uploading file… 42%" pct={42} />);
    expect(screen.getByText(/uploading file/i)).toBeTruthy();
    expect((screen.getByTestId("bar-fill") as HTMLElement).style.width).toBe("42%");
  });

  it("indeterminate: shows stage label and an indeterminate bar", () => {
    render(<UploadProgress stage="Rendering previews…" />);
    expect(screen.getByText(/rendering previews/i)).toBeTruthy();
    expect(screen.getByTestId("bar-indeterminate")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run tests/uploadprogress.test.tsx`
Expected: FAIL — `@/components/UploadProgress` does not exist.

- [ ] **Step 3: Implement**

Create `web/src/components/UploadProgress.tsx`:
```tsx
"use client";

// Staged progress indicator shared by the upload page and the editor's lazy
// preview render. Determinate (pct given) for the real byte upload; indeterminate
// for server-side stages whose duration we can't measure.
export function UploadProgress({ stage, pct }: { stage: string; pct?: number }) {
  const determinate = typeof pct === "number";
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <p className="text-sm text-matcha-700">{stage}</p>
      <div className="h-2 w-full overflow-hidden rounded bg-matcha-100">
        {determinate ? (
          <div data-testid="bar-fill" className="h-full bg-matcha-500 transition-all" style={{ width: `${pct}%` }} />
        ) : (
          <div data-testid="bar-indeterminate" className="h-full w-1/3 animate-pulse bg-matcha-400" />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `web/`): `npx vitest run tests/uploadprogress.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/UploadProgress.tsx web/tests/uploadprogress.test.tsx
git commit -m "feat(web): UploadProgress staged progress component"
```

---

### Task 6: Wire the upload page to XHR + progress

**Files:**
- Modify: `web/src/app/(app)/templates/new/page.tsx`
- Test: `web/tests/newtemplate.test.tsx`

**Interfaces:**
- Consumes: `uploadTemplate` (Task 4), `UploadProgress` (Task 5).

Note: this task also supersedes the uncommitted drag-and-drop edit in this file by including the drag handlers in the new version below.

- [ ] **Step 1: Write the failing test**

Create `web/tests/newtemplate.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get() {
        return ({ children, ...rest }: any) => <label {...rest}>{children}</label>;
      },
    }),
  };
});
const uploadTemplate = vi.fn();
vi.mock("@/lib/upload", () => ({ uploadTemplate: (...a: any[]) => uploadTemplate(...a) }));

import NewTemplate from "@/app/(app)/templates/new/page";

beforeEach(() => { push.mockClear(); uploadTemplate.mockReset(); });

function pptx() { return new File([Buffer.from("PK")], "deck.pptx"); }

describe("NewTemplate", () => {
  it("uploads a chosen .pptx and redirects to the editor", async () => {
    uploadTemplate.mockImplementation(async (_f: File, onP: any) => {
      onP({ stage: "uploading", pct: 100 });
      return { id: "t1" };
    });
    const { container } = render(<NewTemplate />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pptx()] } });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/templates/t1/edit"));
    expect(uploadTemplate).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-pptx without uploading", () => {
    const { container } = render(<NewTemplate />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([Buffer.from("x")], "a.png")] } });
    expect(uploadTemplate).not.toHaveBeenCalled();
    expect(screen.getByText(/please choose a \.pptx/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run tests/newtemplate.test.tsx`
Expected: FAIL — page still uses `fetch`; `uploadTemplate` not called / no redirect.

- [ ] **Step 3: Implement**

Replace `web/src/app/(app)/templates/new/page.tsx` entirely:
```tsx
"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";
import { UploadProgress } from "@/components/UploadProgress";
import { uploadTemplate } from "@/lib/upload";

export default function NewTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState("");
  const [pct, setPct] = useState<number | undefined>(undefined);

  async function upload(file: File) {
    setBusy(true);
    setErr("");
    try {
      const { id } = await uploadTemplate(file, (p) => {
        if (p.stage === "uploading") {
          setStage(`Uploading file… ${p.pct}%`);
          setPct(p.pct);
        } else {
          setStage("Analyzing slides…");
          setPct(undefined);
        }
      });
      router.push(`/templates/${id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed. Please try again.");
      setBusy(false);
      setStage("");
      setPct(undefined);
    }
  }

  function pickAndUpload(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pptx")) {
      setErr("Please choose a .pptx file.");
      return;
    }
    upload(file);
  }

  return (
    <PageTransition>
      <div className="mx-auto max-w-lg p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Upload a .pptx template</h1>
        {err && <p className="text-red-600">{err}</p>}
        {busy ? (
          <UploadProgress stage={stage} pct={pct} />
        ) : (
          <motion.label whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pickAndUpload(e.dataTransfer.files?.[0]); }}
            className={`block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer text-matcha-700 transition-colors ${dragging ? "border-matcha-600 bg-matcha-50" : "border-matcha-400 hover:bg-matcha-50"}`}>
            {dragging ? "Drop the .pptx to upload" : "Click or drag a .pptx here"}
            <input type="file" accept=".pptx" hidden
              onChange={(e) => pickAndUpload(e.target.files?.[0])} />
          </motion.label>
        )}
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `web/`): `npx vitest run tests/newtemplate.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/(app)/templates/new/page.tsx" web/tests/newtemplate.test.tsx
git commit -m "feat(web): upload page uses XHR progress + drag-drop"
```

---

### Task 7: Editor lazy preview render + progress + retry

**Files:**
- Modify: `web/src/app/(app)/templates/[id]/edit/page.tsx`
- Modify: `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`
- Test: `web/tests/editclient-previews.test.tsx`

**Interfaces:**
- Consumes: `UploadProgress` (Task 5); the `POST /api/templates/[id]/base-previews` endpoint (Task 3).
- Produces: `EditClient` accepts a new optional prop `previewsPending?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/editclient-previews.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditClient } from "@/app/(app)/templates/[id]/edit/EditClient";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/TagEditor", () => ({
  TagEditor: ({ previewUrls }: { previewUrls: string[] }) => (
    <div data-testid="tag-editor">{(previewUrls ?? []).join(",")}</div>
  ),
}));
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(actual.motion, {
      get(_t, prop: string) {
        return ({ children, onClick, disabled, className }: any) => {
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag onClick={onClick} disabled={disabled} className={className}>{children}</Tag>;
        };
      },
    }),
  };
});

const slides = [{ index: 0, shapes: [], width_emu: 1, height_emu: 1 }];

beforeEach(() => { (global as any).fetch = undefined; });
afterEach(() => vi.restoreAllMocks());

describe("EditClient lazy previews", () => {
  it("renders previews on mount when pending, then shows the editor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ status: "ready", previewUrls: ["u0"] }),
    });
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={[]} previewsPending />);
    expect(screen.getByText(/rendering previews/i)).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByTestId("tag-editor")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1/base-previews", { method: "POST" });
    expect(screen.getByTestId("tag-editor").textContent).toBe("u0");
  });

  it("shows Retry on failure and re-fetches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ready", previewUrls: ["u0"] }) });
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={[]} previewsPending />);
    await vi.waitFor(() => expect(screen.getByText(/preview render failed/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await vi.waitFor(() => expect(screen.getByTestId("tag-editor")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows the editor immediately when previews are not pending", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    render(<EditClient id="t1" name="T" slides={slides} previewUrls={["a"]} previewsPending={false} />);
    expect(screen.getByTestId("tag-editor")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run tests/editclient-previews.test.tsx`
Expected: FAIL — `EditClient` ignores `previewsPending`; no render call / no "Rendering previews".

- [ ] **Step 3: Implement EditClient**

In `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`:

3a. Update imports — change the React import and add `UploadProgress`:
```tsx
import { useCallback, useEffect, useState } from "react";
```
```tsx
import { UploadProgress } from "@/components/UploadProgress";
```

3b. Update the component signature + add preview state/logic. Replace:
```tsx
export function EditClient({ id, name, slides, previewUrls }:
  { id: string; name: string; slides: any[]; previewUrls: string[] }) {
  const router = useRouter();
```
with:
```tsx
export function EditClient({ id, name, slides, previewUrls, previewsPending }:
  { id: string; name: string; slides: any[]; previewUrls: string[]; previewsPending?: boolean }) {
  const router = useRouter();
  const [urls, setUrls] = useState<string[]>(previewUrls);
  const [renderState, setRenderState] = useState<"idle" | "rendering" | "error">(
    previewsPending ? "rendering" : "idle",
  );
  const renderPreviews = useCallback(async () => {
    setRenderState("rendering");
    try {
      const r = await fetch(`/api/templates/${id}/base-previews`, { method: "POST" });
      if (!r.ok) throw new Error("render failed");
      const data = await r.json();
      setUrls(data.previewUrls ?? []);
      setRenderState("idle");
    } catch {
      setRenderState("error");
    }
  }, [id]);
  useEffect(() => {
    if (previewsPending) renderPreviews();
  }, [previewsPending, renderPreviews]);
```

3c. Replace the `<TagEditor .../>` block (currently lines 122-129) with the gated render:
```tsx
        {renderState === "rendering" ? (
          <UploadProgress stage="Rendering previews…" />
        ) : renderState === "error" ? (
          <div className="space-y-2">
            <p className="text-red-600 text-sm">Preview render failed.</p>
            <button onClick={renderPreviews} className="btn-primary">Retry</button>
          </div>
        ) : (
          <TagEditor
            slides={slides}
            previewUrls={urls}
            onChange={setSlots}
            onMove={onMove}
            onIssues={handleIssues}
            onSlideMeta={onSlideMeta}
          />
        )}
```

- [ ] **Step 4: Implement the page prop**

In `web/src/app/(app)/templates/[id]/edit/page.tsx`, replace the final two lines of the function:
```tsx
  const previewUrls = await Promise.all((draft.previewKeys ?? []).map((k: string) => presignGet(k)));
  return <EditClient id={id} name={tpl.name} slides={draft.slides} previewUrls={previewUrls} />;
```
with:
```tsx
  const previewUrls = await Promise.all((draft.previewKeys ?? []).map((k: string) => presignGet(k)));
  const previewsPending = (draft.previewKeys ?? []).length === 0;
  return <EditClient id={id} name={tpl.name} slides={draft.slides} previewUrls={previewUrls} previewsPending={previewsPending} />;
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `web/`): `npx vitest run tests/editclient-previews.test.tsx tests/editclient-save.test.tsx`
Expected: PASS — the new lazy-preview cases AND the existing save test (no regression; `previewsPending` defaults undefined → editor shows immediately).

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/(app)/templates/[id]/edit/EditClient.tsx" "web/src/app/(app)/templates/[id]/edit/page.tsx" web/tests/editclient-previews.test.tsx
git commit -m "feat(web): editor renders previews lazily with progress + retry"
```

---

### Task 8: Full-suite verification + build

**Files:** none (verification only).

- [ ] **Step 1: Run the web unit suite**

Run (from `web/`): `npx prisma generate && npx vitest run`
Expected: PASS — all test files green (new: base-previews-api, upload, uploadprogress, newtemplate, editclient-previews; unchanged: the rest).

- [ ] **Step 2: Typecheck / production build**

Run (from `web/`): `npx tsc --noEmit`
Expected: exit 0 (vitest/esbuild do not typecheck; this catches type errors the suite misses).

- [ ] **Step 3: Run the engine suite**

Run (from `engine/`): `pytest -q`
Expected: PASS (preview DPI test included; LibreOffice render test skipped if soffice absent).

- [ ] **Step 4: Commit (only if any fixup was needed)**

```bash
git add -A
git commit -m "chore: upload-perf suite green (tsc + vitest + pytest)"
```

---

## Out of scope (not in this plan)

- The `PUT /api/templates/[id]` route still renders previews synchronously when a
  save includes `moves` (`route.ts:67-80`). That blocking render on save is a
  separate concern; this plan only fixes the upload + first-open path.
- Background job queue, per-slide render %, resumable/chunked uploads, streaming
  the S3 upload (all out of scope in the spec).
- Engine fit-quality work (table + free-text specs) — separate plans.

## Self-review

- **Spec coverage:** upload route slim + size cap (Task 2) ✓; lazy base-previews
  endpoint, idempotent, persists status (Task 3) ✓; editor lazy render + retry +
  `previewsPending` (Task 7) ✓; upload determinate bar + analyzing stage (Tasks
  4+6) ✓; editor "Rendering previews…" stage (Tasks 5+7) ✓; engine `-r 100`
  (Task 1) ✓; back-compat via `previewKeys.length === 0` (Tasks 3+7) ✓.
- **Type consistency:** `uploadTemplate(file, onProgress) -> Promise<{id}>` and
  `UploadProgress({stage, pct})` are used identically in Tasks 4/5/6/7; the
  endpoint returns `{ status, previewUrls }` consumed verbatim in Task 7;
  `manifestJson.draft.{previewKeys,previewsStatus}` consistent across Tasks 2/3/7.
- **Placeholder scan:** every code/test step contains complete code and exact
  run commands; no TBDs.
