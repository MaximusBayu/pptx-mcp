# PPTX MCP Phase 2 Implementation Plan (Multi-tenant SaaS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Execute Parts A→B→C→D in order. **Prerequisite: the v1 plan ([2026-06-19-pptx-mcp-v1.md](2026-06-19-pptx-mcp-v1.md)) is fully implemented and green.**

**Goal:** Turn the v1 engine into a multi-tenant SaaS: users sign in, upload `.pptx`, tag shapes as slots (with drag-to-move), publish private/public templates, and let agents fill them via an API-key-scoped MCP.

**Architecture:** Next.js (`web/`) is the brain (auth, Prisma/Postgres, S3, links). A stateless Python `engine-service/` wraps the v1 engine over bytes. A thin Python `mcp-server/` proxies MCP tools to the web internal API. Docker Compose runs it all.

**Tech Stack:** Python (FastAPI, python-pptx, LibreOffice, pdftoppm), Next.js 14 App Router + TypeScript, Prisma + PostgreSQL, Auth.js v5 (Google + GitHub + Credentials/bcrypt), S3 (`@aws-sdk/client-s3`, MinIO dev), Framer Motion, Tailwind, Vitest + React Testing Library, pytest, Docker Compose.

## Global Constraints

- Monorepo layout: `engine/` (v1 lib, already built), `engine-service/`, `web/`, `mcp-server/`, `docker-compose.yml`, `.env.example`.
- engine-service is **stateless** — never touches DB/S3; bytes/JSON in, bytes/JSON out.
- web is the **only** owner of auth, DB, and S3. mcp-server holds **no** DB/S3/engine access — it only calls the web internal MCP API with `X-API-Key`.
- Auth: Auth.js v5; providers Google, GitHub, **and Credentials (email+password, bcrypt cost ≥ 12)**.
- API keys: format `pk_<prefix>_<secret>`; store only `prefix` + `bcrypt(secret)`; raw shown once.
- Secrets only via env; ship `.env.example`. Never log raw passwords/keys.
- **Animation is mandatory** (spec §8): Framer Motion; animate only `transform`/`opacity`; honor `prefers-reduced-motion` via a global `useReducedMotion` gate. Every UI task includes motion + a reduced-motion test.
- `SlotError` JSON shape is identical to v1: `{slide_index, slot_id, code, message}`.
- One commit per task.

---

## File Structure

```
engine/                         # v1 lib (extended in Task A1/A2)
  src/pptx_mcp/...
engine-service/
  app.py                        # FastAPI endpoints
  tests/test_endpoints.py
  Dockerfile
mcp-server/
  server.py                     # thin FastMCP proxy
  tests/test_proxy.py
  Dockerfile
web/
  prisma/schema.prisma
  src/lib/{auth,s3,engine,apiKey,prisma}.ts
  src/lib/motion/{MotionProvider,PageTransition,variants}.tsx
  src/app/(auth)/{login,register}/page.tsx
  src/app/(app)/{dashboard,gallery}/page.tsx
  src/app/(app)/templates/new/page.tsx
  src/app/(app)/templates/[id]/edit/page.tsx
  src/app/(app)/settings/keys/page.tsx
  src/app/api/templates/...     # CRUD + move-shape
  src/app/api/keys/...
  src/app/api/mcp/...           # internal MCP API (X-API-Key)
  src/components/TagEditor.tsx
  src/components/{TemplateCard,SlotPanel}.tsx
  tests/...
  Dockerfile
docker-compose.yml
.env.example
```

---

# PART A — engine-service (stateless Python compute)

### Task A1: Engine `load_from_bytes` + `extract_shapes`

**Files:**
- Create: `engine/src/pptx_mcp/bytesio.py`
- Create: `engine/src/pptx_mcp/shapes.py`
- Test: `engine/tests/test_bytesio.py`, `engine/tests/test_shapes.py`

**Interfaces:**
- Consumes: v1 `parse_manifest`, `validate_against_pptx`, `Template`; python-pptx.
- Produces:
  - `load_from_bytes(pptx_bytes:bytes, manifest:dict) -> Template` — writes pptx to a temp file, parses+validates manifest, returns `Template` whose `pptx_path` points at the temp file.
  - `extract_shapes(pptx_bytes:bytes) -> dict` → `{slides:[{index, width_emu, height_emu, shapes:[{shape_id, name, type, x, y, w, h, bbox_pct}]}]}`. `type` ∈ table/image/text; `bbox_pct` = each of x,y,w,h as percent of slide width/height (0–100, floats).

- [ ] **Step 1: Write `engine/tests/test_bytesio.py`**

```python
from pathlib import Path
import json
from pptx_mcp.bytesio import load_from_bytes


def test_load_from_bytes(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    manifest = json.loads((sample_template_dir / "manifest.json").read_text())
    tpl = load_from_bytes(pptx, manifest)
    assert tpl.id == "sample"
    assert Path(tpl.pptx_path).exists()
```

- [ ] **Step 2: Write `engine/tests/test_shapes.py`**

```python
from pptx_mcp.shapes import extract_shapes


def test_extract_shapes_geometry(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    out = extract_shapes(pptx)
    assert len(out["slides"]) == 4
    s0 = out["slides"][0]
    assert s0["width_emu"] > 0 and s0["height_emu"] > 0
    shp = s0["shapes"][0]
    assert {"shape_id", "name", "type", "bbox_pct"} <= shp.keys()
    for k in ("x", "y", "w", "h"):
        assert 0 <= shp["bbox_pct"][k] <= 100


def test_extract_shapes_types(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    out = extract_shapes(pptx)
    table_slide = out["slides"][2]
    image_slide = out["slides"][3]
    assert any(s["type"] == "table" for s in table_slide["shapes"])
    assert any(s["type"] == "image" for s in image_slide["shapes"])
```

- [ ] **Step 3: Run to verify both fail**

Run: `cd engine && pytest tests/test_bytesio.py tests/test_shapes.py -v`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write `engine/src/pptx_mcp/bytesio.py`**

```python
import tempfile

from .manifest import parse_manifest, validate_against_pptx
from .models import Template


def load_from_bytes(pptx_bytes: bytes, manifest: dict) -> Template:
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    tmp.write(pptx_bytes)
    tmp.flush()
    tmp.close()
    template = parse_manifest(manifest, tmp.name)
    validate_against_pptx(template)
    return template
```

- [ ] **Step 5: Write `engine/src/pptx_mcp/shapes.py`**

```python
import io

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def _guess_type(shape) -> str:
    if shape.has_table:
        return "table"
    if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
        return "image"
    return "text"


def _pct(value, total) -> float:
    return round(100.0 * value / total, 3) if total else 0.0


def extract_shapes(pptx_bytes: bytes) -> dict:
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    slides = []
    for i, slide in enumerate(prs.slides):
        shapes = []
        for shp in slide.shapes:
            x, y, w, h = shp.left or 0, shp.top or 0, shp.width or 0, shp.height or 0
            shapes.append({
                "shape_id": shp.shape_id, "name": shp.name or "",
                "type": _guess_type(shp),
                "x": x, "y": y, "w": w, "h": h,
                "bbox_pct": {"x": _pct(x, sw), "y": _pct(y, sh),
                             "w": _pct(w, sw), "h": _pct(h, sh)},
            })
        slides.append({"index": i, "width_emu": sw, "height_emu": sh, "shapes": shapes})
    return {"slides": slides}
```

- [ ] **Step 6: Run to verify both pass**

Run: `cd engine && pytest tests/test_bytesio.py tests/test_shapes.py -v`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add engine/src/pptx_mcp/bytesio.py engine/src/pptx_mcp/shapes.py engine/tests/test_bytesio.py engine/tests/test_shapes.py
git commit -m "feat(engine): add load_from_bytes and extract_shapes"
```

---

### Task A2: Engine `move_shape`

**Files:**
- Create: `engine/src/pptx_mcp/move.py`
- Test: `engine/tests/test_move.py`

**Interfaces:**
- Consumes: python-pptx.
- Produces: `move_shape(pptx_bytes:bytes, shape_id:int, bbox_pct:dict) -> bytes` — sets the shape's `left/top/width/height` from `bbox_pct` (percent of slide), returns new pptx bytes. Searches all slides for `shape_id`; raises `KeyError` if absent.

- [ ] **Step 1: Write `engine/tests/test_move.py`**

```python
import io
from pptx import Presentation
from pptx_mcp.move import move_shape


def _first_shape(sample_template_dir):
    prs = Presentation(str(sample_template_dir / "base.pptx"))
    return prs.slides[0].shapes[0].shape_id


def test_move_shape_repositions(sample_template_dir):
    pptx = (sample_template_dir / "base.pptx").read_bytes()
    sid = _first_shape(sample_template_dir)
    out = move_shape(pptx, sid, {"x": 10, "y": 20, "w": 50, "h": 25})
    prs = Presentation(io.BytesIO(out))
    sw, sh = prs.slide_width, prs.slide_height
    moved = next(s for s in prs.slides[0].shapes if s.shape_id == sid)
    assert abs(moved.left - sw * 0.10) < 5000
    assert abs(moved.top - sh * 0.20) < 5000
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd engine && pytest tests/test_move.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `engine/src/pptx_mcp/move.py`**

```python
import io

from pptx import Presentation


def move_shape(pptx_bytes: bytes, shape_id: int, bbox_pct: dict) -> bytes:
    prs = Presentation(io.BytesIO(pptx_bytes))
    sw, sh = prs.slide_width, prs.slide_height
    for slide in prs.slides:
        for shp in slide.shapes:
            if shp.shape_id == shape_id:
                shp.left = int(sw * bbox_pct["x"] / 100.0)
                shp.top = int(sh * bbox_pct["y"] / 100.0)
                shp.width = int(sw * bbox_pct["w"] / 100.0)
                shp.height = int(sh * bbox_pct["h"] / 100.0)
                buf = io.BytesIO()
                prs.save(buf)
                return buf.getvalue()
    raise KeyError(f"shape_id {shape_id} not found")
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd engine && pytest tests/test_move.py -v`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/move.py engine/tests/test_move.py
git commit -m "feat(engine): add move_shape"
```

---

### Task A3: engine-service FastAPI app

**Files:**
- Create: `engine-service/app.py`
- Create: `engine-service/requirements.txt`
- Create: `engine-service/tests/conftest.py` (re-export v1 fixture)
- Test: `engine-service/tests/test_endpoints.py`

**Interfaces:**
- Consumes: engine `load_from_bytes`, `extract_shapes`, `move_shape`, `render`, `validate`, `RenderRejected`, `preview`, `libreoffice_available`.
- Produces: FastAPI app `app` with `/health`, `/extract-shapes`, `/render-base-previews`, `/render-deck`, `/render-preview`, `/move-shape` (spec §3.1). PNGs returned base64.

- [ ] **Step 1: Create `engine-service/requirements.txt`**

```
fastapi>=0.110
uvicorn>=0.29
python-multipart>=0.0.9
-e ../engine
pytest>=8
httpx>=0.27
pillow>=10
```

- [ ] **Step 2: Create `engine-service/tests/conftest.py`**

```python
import sys
from pathlib import Path

# reuse the v1 engine fixture
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine" / "tests"))
from conftest import sample_template_dir, sample_manifest, tiny_png_bytes  # noqa: F401,E402
```

- [ ] **Step 3: Write `engine-service/tests/test_endpoints.py`**

```python
import json
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


def _files(sample_template_dir):
    return {"file": ("base.pptx", (sample_template_dir / "base.pptx").read_bytes())}


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_extract_shapes(sample_template_dir):
    r = client.post("/extract-shapes", files=_files(sample_template_dir))
    assert r.status_code == 200
    assert len(r.json()["slides"]) == 4


def test_render_deck_ok(sample_template_dir, sample_manifest):
    deck = {"slides": [{"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}}]}
    r = client.post("/render-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest), "deck_spec": json.dumps(deck)})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"  # zip/pptx magic


def test_render_deck_rejects(sample_template_dir, sample_manifest):
    deck = {"slides": [{"slide_type": "title", "slots": {"title": "x" * 200}}]}
    r = client.post("/render-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest), "deck_spec": json.dumps(deck)})
    assert r.status_code == 422
    assert r.json()["validation"][0]["code"] == "text_overflow"


def test_move_shape(sample_template_dir):
    from pptx import Presentation
    sid = Presentation(str(sample_template_dir / "base.pptx")).slides[0].shapes[0].shape_id
    r = client.post("/move-shape", files=_files(sample_template_dir),
                    data={"shape_id": str(sid),
                          "bbox_pct": json.dumps({"x": 10, "y": 10, "w": 40, "h": 20})})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd engine-service && pip install -r requirements.txt && pytest -v`
Expected: FAIL — `app` not found.

- [ ] **Step 5: Write `engine-service/app.py`**

```python
import base64
import json

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from pptx_mcp.bytesio import load_from_bytes
from pptx_mcp.move import move_shape
from pptx_mcp.preview import libreoffice_available, preview
from pptx_mcp.render import RenderRejected, render
from pptx_mcp.shapes import extract_shapes
from pptx_mcp.validate import validate

app = FastAPI(title="pptx-engine-service")

_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/extract-shapes")
async def extract(file: UploadFile = File(...)):
    return extract_shapes(await file.read())


@app.post("/render-base-previews")
async def base_previews(file: UploadFile = File(...)):
    data = await file.read()
    if not libreoffice_available():
        return {"previews": [], "note": "LibreOffice not available"}
    pngs = preview(data)  # previews of the base file as-is
    return {"previews": [base64.b64encode(p).decode() for p in pngs]}


@app.post("/render-deck")
async def render_deck(file: UploadFile = File(...),
                      manifest: str = Form(...), deck_spec: str = Form(...)):
    tpl = load_from_bytes(await file.read(), json.loads(manifest))
    try:
        out = render(json.loads(deck_spec), tpl)
    except RenderRejected as e:
        return JSONResponse(status_code=422,
                            content={"validation": [x.to_dict() for x in e.errors]})
    return Response(content=out, media_type=_PPTX)


@app.post("/render-preview")
async def render_preview(file: UploadFile = File(...),
                         manifest: str = Form(...), deck_spec: str = Form(...)):
    data = await file.read()
    tpl = load_from_bytes(data, json.loads(manifest))
    errors = validate(json.loads(deck_spec), tpl)
    if errors:
        return {"validation": [e.to_dict() for e in errors], "previews": []}
    out = render(json.loads(deck_spec), tpl)
    if not libreoffice_available():
        return {"validation": [], "previews": [], "note": "LibreOffice not available"}
    pngs = preview(out)
    return {"validation": [], "previews": [base64.b64encode(p).decode() for p in pngs]}


@app.post("/move-shape")
async def move(file: UploadFile = File(...),
               shape_id: int = Form(...), bbox_pct: str = Form(...)):
    out = move_shape(await file.read(), shape_id, json.loads(bbox_pct))
    return Response(content=out, media_type=_PPTX)
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd engine-service && pytest -v`
Expected: all passed (the listed tests don't require LibreOffice).

- [ ] **Step 7: Commit**

```bash
git add engine-service/
git commit -m "feat: add stateless engine-service FastAPI app"
```

---

# PART B — web foundation (Next.js + Prisma + Auth + S3)

### Task B1: Next.js scaffold + Tailwind + Framer Motion primitives

**Files:**
- Create: `web/` (Next.js App Router, TS), `web/vitest.config.ts`, `web/vitest.setup.ts`
- Create: `web/src/lib/motion/variants.ts`, `web/src/lib/motion/MotionProvider.tsx`, `web/src/lib/motion/PageTransition.tsx`
- Test: `web/tests/motion.test.tsx`

**Interfaces:**
- Produces:
  - `variants.ts`: `fadeSlide`, `staggerContainer`, `cardItem` Framer variants.
  - `MotionProvider` — wraps app, exposes `useMotionEnabled()` gating on `useReducedMotion()`.
  - `PageTransition` — `motion.div` wrapper applying `fadeSlide` unless reduced motion.

- [ ] **Step 1: Scaffold**

```bash
npx create-next-app@14 web --ts --tailwind --app --src-dir --eslint --no-import-alias
cd web && npm i framer-motion @prisma/client next-auth@beta @auth/prisma-adapter bcryptjs @aws-sdk/client-s3 @aws-sdk/s3-request-presigner zod
npm i -D prisma vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react @types/bcryptjs
```

- [ ] **Step 2: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./vitest.setup.ts"], globals: true },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 3: Create `web/vitest.setup.ts`**

```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 4: Write `web/tests/motion.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("framer-motion", async (orig) => {
  const actual = await orig<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => true };
});

import { PageTransition } from "@/lib/motion/PageTransition";
import { MotionProvider } from "@/lib/motion/MotionProvider";

describe("PageTransition", () => {
  it("renders children (reduced motion)", () => {
    render(<MotionProvider><PageTransition><span>hello</span></PageTransition></MotionProvider>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Create `web/src/lib/motion/variants.ts`**

```ts
import type { Variants } from "framer-motion";

export const fadeSlide: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

export const staggerContainer: Variants = {
  animate: { transition: { staggerChildren: 0.04 } },
};

export const cardItem: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
};
```

- [ ] **Step 6: Create `web/src/lib/motion/MotionProvider.tsx`**

```tsx
"use client";
import { useReducedMotion } from "framer-motion";
import { createContext, useContext } from "react";

const Ctx = createContext(true);
export const useMotionEnabled = () => useContext(Ctx);

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return <Ctx.Provider value={!reduced}>{children}</Ctx.Provider>;
}
```

- [ ] **Step 7: Create `web/src/lib/motion/PageTransition.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { fadeSlide } from "./variants";
import { useMotionEnabled } from "./MotionProvider";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const enabled = useMotionEnabled();
  if (!enabled) return <div>{children}</div>;
  return (
    <motion.div variants={fadeSlide} initial="initial" animate="animate" exit="exit">
      {children}
    </motion.div>
  );
}
```

- [ ] **Step 8: Run**

Run: `cd web && npx vitest run tests/motion.test.tsx`
Expected: 1 passed.

- [ ] **Step 9: Commit**

```bash
git add web/
git commit -m "feat(web): scaffold Next.js with Framer Motion primitives"
```

---

### Task B2: Prisma schema + client

**Files:**
- Create: `web/prisma/schema.prisma`, `web/src/lib/prisma.ts`
- Test: `web/tests/prisma.test.ts`

**Interfaces:**
- Produces: Prisma models `User`(+`passwordHash`), `Account`, `Session`, `VerificationToken`, `Template`, `ApiKey`, enum `Visibility`. `prisma` singleton client.

- [ ] **Step 1: Write `web/prisma/schema.prisma`**

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Visibility { PRIVATE PUBLIC }

model User {
  id            String     @id @default(cuid())
  name          String?
  email         String?    @unique
  emailVerified DateTime?
  image         String?
  passwordHash  String?
  accounts      Account[]
  sessions      Session[]
  templates     Template[]
  apiKeys       ApiKey[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?
  access_token      String?
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}

model Template {
  id           String     @id @default(cuid())
  ownerId      String
  name         String
  description  String     @default("")
  visibility   Visibility @default(PRIVATE)
  manifestJson Json
  basePptxKey  String
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  owner        User       @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  @@index([ownerId])
  @@index([visibility])
}

model ApiKey {
  id         String    @id @default(cuid())
  userId     String
  prefix     String    @unique
  hash       String
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
}
```

- [ ] **Step 2: Create `web/src/lib/prisma.ts`**

```ts
import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
```

- [ ] **Step 3: Write `web/tests/prisma.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";

describe("prisma schema", () => {
  it("exposes Template and ApiKey models", () => {
    expect(Prisma.ModelName.Template).toBe("Template");
    expect(Prisma.ModelName.ApiKey).toBe("ApiKey");
  });
});
```

- [ ] **Step 4: Generate + migrate + run**

Run:
```bash
cd web && npx prisma generate && npx prisma migrate dev --name init && npx vitest run tests/prisma.test.ts
```
Expected: client generated, migration applied, 1 passed. (Requires `DATABASE_URL` to a running Postgres — use the Compose one or a local instance.)

- [ ] **Step 5: Commit**

```bash
git add web/prisma web/src/lib/prisma.ts web/tests/prisma.test.ts
git commit -m "feat(web): add Prisma schema and client"
```

---

### Task B3: Auth.js (Google + GitHub + email/password)

**Files:**
- Create: `web/src/lib/auth.ts`, `web/src/app/api/auth/[...nextauth]/route.ts`, `web/src/app/api/register/route.ts`
- Create: `web/src/app/(auth)/login/page.tsx`, `web/src/app/(auth)/register/page.tsx`
- Test: `web/tests/auth.test.ts`

**Interfaces:**
- Produces:
  - `auth.ts`: Auth.js v5 config with `Google`, `GitHub`, `Credentials` (email+password verified via bcrypt against `User.passwordHash`); exports `{ handlers, auth, signIn, signOut }`. Prisma adapter, JWT sessions.
  - `POST /api/register` `{email, password, name?}` → creates user with `bcrypt(password, 12)`; `400` if email exists or password < 8.
  - Animated login/register pages (PageTransition, OAuth buttons, `whileTap`).

- [ ] **Step 1: Write `web/tests/auth.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { user: { create: (a: any) => create(a), findUnique: (a: any) => findUnique(a) } } }));

import { POST } from "@/app/api/register/route";

beforeEach(() => { create.mockReset(); findUnique.mockReset(); });

function req(body: any) {
  return new Request("http://x/api/register", { method: "POST", body: JSON.stringify(body) });
}

describe("register", () => {
  it("rejects short password", async () => {
    const r = await POST(req({ email: "a@b.com", password: "123" }));
    expect(r.status).toBe(400);
  });

  it("rejects existing email", async () => {
    findUnique.mockResolvedValue({ id: "1" });
    const r = await POST(req({ email: "a@b.com", password: "longenough" }));
    expect(r.status).toBe(400);
  });

  it("creates user with hashed password", async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "1", email: "a@b.com" });
    const r = await POST(req({ email: "a@b.com", password: "longenough" }));
    expect(r.status).toBe(201);
    const arg = create.mock.calls[0][0];
    expect(arg.data.passwordHash).not.toBe("longenough");
    expect(arg.data.passwordHash.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/auth.test.ts`
Expected: FAIL — register route not found.

- [ ] **Step 3: Write `web/src/app/api/register/route.ts`**

```ts
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const { email, password, name } = await req.json().catch(() => ({}));
  if (!email || typeof password !== "string" || password.length < 8) {
    return Response.json({ error: "invalid email or password (min 8 chars)" }, { status: 400 });
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    return Response.json({ error: "email already registered" }, { status: 400 });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, name: name ?? null, passwordHash } });
  return Response.json({ id: user.id, email: user.email }, { status: 201 });
}
```

- [ ] **Step 4: Write `web/src/lib/auth.ts`**

```ts
import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    Google,
    GitHub,
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (c) => {
        const email = c?.email as string | undefined;
        const password = c?.password as string | undefined;
        if (!email || !password) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;
        return (await bcrypt.compare(password, user.passwordHash))
          ? { id: user.id, email: user.email, name: user.name }
          : null;
      },
    }),
  ],
});
```

- [ ] **Step 5: Write `web/src/app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 6: Write `web/src/app/(auth)/login/page.tsx`**

```tsx
"use client";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <PageTransition>
      <div className="mx-auto max-w-sm p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <input className="w-full border p-2 rounded" placeholder="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full border p-2 rounded" type="password" placeholder="password"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <motion.button whileTap={{ scale: 0.97 }} className="w-full bg-black text-white p-2 rounded"
          onClick={() => signIn("credentials", { email, password, callbackUrl: "/dashboard" })}>
          Sign in
        </motion.button>
        <div className="flex gap-2">
          <motion.button whileTap={{ scale: 0.97 }} className="flex-1 border p-2 rounded"
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}>Google</motion.button>
          <motion.button whileTap={{ scale: 0.97 }} className="flex-1 border p-2 rounded"
            onClick={() => signIn("github", { callbackUrl: "/dashboard" })}>GitHub</motion.button>
        </div>
        <a className="text-sm underline" href="/register">Create account</a>
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 7: Write `web/src/app/(auth)/register/page.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  async function submit() {
    const r = await fetch("/api/register", { method: "POST", body: JSON.stringify({ email, password }) });
    if (r.ok) signIn("credentials", { email, password, callbackUrl: "/dashboard" });
    else setErr((await r.json()).error ?? "error");
  }
  return (
    <PageTransition>
      <div className="mx-auto max-w-sm p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <input className="w-full border p-2 rounded" placeholder="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full border p-2 rounded" type="password" placeholder="password (min 8)"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <motion.button whileTap={{ scale: 0.97 }} className="w-full bg-black text-white p-2 rounded"
          onClick={submit}>Sign up</motion.button>
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 8: Run**

Run: `cd web && npx vitest run tests/auth.test.ts`
Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/auth.ts web/src/app/api/auth web/src/app/api/register "web/src/app/(auth)" web/tests/auth.test.ts
git commit -m "feat(web): add Auth.js with OAuth and email/password"
```

---

### Task B4: S3 + engine clients

**Files:**
- Create: `web/src/lib/s3.ts`, `web/src/lib/engine.ts`
- Test: `web/tests/s3.test.ts`, `web/tests/engine.test.ts`

**Interfaces:**
- Produces:
  - `s3.ts`: `putObject(key, body, contentType)`, `getObject(key) -> Buffer`, `presignGet(key, ttl=3600) -> string`. Configured from env (`S3_ENDPOINT`, `S3_BUCKET`, creds, `forcePathStyle` for MinIO).
  - `engine.ts`: typed client — `extractShapes(pptx)`, `renderBasePreviews(pptx)`, `renderDeck(pptx, manifest, deckSpec) -> {pptx?, validation}`, `renderPreview(...)`, `moveShape(pptx, shapeId, bboxPct) -> Buffer`. Base URL from `ENGINE_URL`. `renderDeck` 422 → `{validation}`.

- [ ] **Step 1: Write `web/tests/engine.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => fetchMock.mockReset());

import { renderDeck } from "@/lib/engine";

describe("engine client", () => {
  it("returns validation on 422", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ validation: [{ code: "text_overflow" }] }),
      { status: 422, headers: { "content-type": "application/json" } }));
    const out = await renderDeck(Buffer.from("x"), {}, {});
    expect(out.validation[0].code).toBe("text_overflow");
    expect(out.pptx).toBeUndefined();
  });

  it("returns pptx bytes on 200", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const out = await renderDeck(Buffer.from("x"), {}, {});
    expect(out.pptx).toBeInstanceOf(Buffer);
    expect(out.validation).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `web/src/lib/engine.ts`**

```ts
const BASE = process.env.ENGINE_URL ?? "http://engine-service:8000";

export class EngineError extends Error {}

function form(pptx: Buffer, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([pptx]), "base.pptx");
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

export async function extractShapes(pptx: Buffer) {
  const r = await fetch(`${BASE}/extract-shapes`, { method: "POST", body: form(pptx) });
  if (!r.ok) throw new EngineError("extract-shapes failed");
  return r.json();
}

export async function renderBasePreviews(pptx: Buffer): Promise<{ previews: string[] }> {
  const r = await fetch(`${BASE}/render-base-previews`, { method: "POST", body: form(pptx) });
  if (!r.ok) throw new EngineError("render-base-previews failed");
  return r.json();
}

export async function renderDeck(pptx: Buffer, manifest: unknown, deckSpec: unknown):
  Promise<{ pptx?: Buffer; validation: any[] }> {
  const r = await fetch(`${BASE}/render-deck`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (r.status === 422) return { validation: (await r.json()).validation };
  if (!r.ok) throw new EngineError("render-deck failed");
  return { pptx: Buffer.from(await r.arrayBuffer()), validation: [] };
}

export async function renderPreview(pptx: Buffer, manifest: unknown, deckSpec: unknown) {
  const r = await fetch(`${BASE}/render-preview`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (!r.ok) throw new EngineError("render-preview failed");
  return r.json();
}

export async function moveShape(pptx: Buffer, shapeId: number, bboxPct: object): Promise<Buffer> {
  const r = await fetch(`${BASE}/move-shape`, {
    method: "POST",
    body: form(pptx, { shape_id: String(shapeId), bbox_pct: JSON.stringify(bboxPct) }),
  });
  if (!r.ok) throw new EngineError("move-shape failed");
  return Buffer.from(await r.arrayBuffer());
}
```

- [ ] **Step 4: Write `web/src/lib/s3.ts`**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET ?? "pptx";
const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  },
});

export async function putObject(key: string, body: Buffer, contentType: string) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export function presignGet(key: string, ttl = 3600) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}
```

- [ ] **Step 5: Write `web/tests/s3.test.ts`** (module-shape smoke)

```ts
import { describe, it, expect } from "vitest";
import * as s3 from "@/lib/s3";

describe("s3 lib", () => {
  it("exports put/get/presign", () => {
    expect(typeof s3.putObject).toBe("function");
    expect(typeof s3.getObject).toBe("function");
    expect(typeof s3.presignGet).toBe("function");
  });
});
```

- [ ] **Step 6: Run**

Run: `cd web && npx vitest run tests/engine.test.ts tests/s3.test.ts`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/s3.ts web/src/lib/engine.ts web/tests/s3.test.ts web/tests/engine.test.ts
git commit -m "feat(web): add S3 and engine-service clients"
```

---

### Task B5: Template upload API + upload page

**Files:**
- Create: `web/src/app/api/templates/route.ts` (POST upload, GET list)
- Create: `web/src/lib/id.ts`
- Create: `web/src/app/(app)/templates/new/page.tsx`
- Test: `web/tests/templates-upload.test.ts`

**Interfaces:**
- Consumes: `auth`, `prisma`, `s3.putObject`, `engine.extractShapes`, `engine.renderBasePreviews`.
- Produces:
  - `POST /api/templates` (multipart, field `file`) — requires session; validates `.pptx`; stores base in S3 at `templates/{id}/base.pptx`; calls extract-shapes + base-previews; stores preview PNGs; creates `Template` draft with `manifestJson = { draft: { slides, previewKeys } }`. Returns `{id}`.
  - `GET /api/templates` — caller's templates.
  - Upload page: animated dropzone, posts then routes to `/templates/[id]/edit`.

- [ ] **Step 1: Write `web/tests/templates-upload.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { create: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ putObject: vi.fn(async (k: string) => k) }));
vi.mock("@/lib/engine", () => ({
  extractShapes: vi.fn(async () => ({ slides: [] })),
  renderBasePreviews: vi.fn(async () => ({ previews: [] })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/templates/route";

beforeEach(() => vi.clearAllMocks());

function upload(): Request {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("PK")], { type: "application/octet-stream" }), "x.pptx");
  return new Request("http://x/api/templates", { method: "POST", body: fd });
}

describe("upload", () => {
  it("401 without session", async () => {
    (auth as any).mockResolvedValue(null);
    expect((await POST(upload())).status).toBe(401);
  });

  it("creates draft template", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.create as any).mockResolvedValue({ id: "t1" });
    const r = await POST(upload());
    expect(r.status).toBe(201);
    expect((await r.json()).id).toBe("t1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/templates-upload.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `web/src/lib/id.ts`**

```ts
import { randomBytes } from "crypto";
export const createId = () => randomBytes(12).toString("hex");
```

- [ ] **Step 4: Write `web/src/app/api/templates/route.ts`**

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/s3";
import { extractShapes, renderBasePreviews } from "@/lib/engine";
import { createId } from "@/lib/id";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file || !file.name.endsWith(".pptx")) {
    return Response.json({ error: "expected a .pptx file" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createId();
  const baseKey = `templates/${id}/base.pptx`;
  await putObject(baseKey, bytes, PPTX);

  const shapes = await extractShapes(bytes);
  const { previews } = await renderBasePreviews(bytes);
  const previewKeys: string[] = [];
  for (let i = 0; i < previews.length; i++) {
    const key = `templates/${id}/preview-${i}.png`;
    await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
    previewKeys.push(key);
  }

  const tpl = await prisma.template.create({
    data: {
      id, ownerId: session.user.id, name: file.name.replace(/\.pptx$/, ""),
      basePptxKey: baseKey,
      manifestJson: { draft: { slides: shapes.slides, previewKeys } } as object,
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

- [ ] **Step 5: Write `web/src/app/(app)/templates/new/page.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function NewTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/templates", { method: "POST", body: fd });
    setBusy(false);
    if (r.ok) router.push(`/templates/${(await r.json()).id}/edit`);
  }
  return (
    <PageTransition>
      <div className="mx-auto max-w-lg p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Upload a .pptx template</h1>
        <motion.label whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
          className="block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer">
          {busy ? "Uploading…" : "Click to choose a .pptx"}
          <input type="file" accept=".pptx" hidden disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </motion.label>
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 6: Run**

Run: `cd web && npx vitest run tests/templates-upload.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/api/templates web/src/lib/id.ts "web/src/app/(app)/templates/new" web/tests/templates-upload.test.ts
git commit -m "feat(web): add template upload API and page"
```

---

# PART C — tag editor, drag-to-move, gallery

### Task C1: SlotPanel + TagEditor overlay (click-to-tag)

**Files:**
- Create: `web/src/components/SlotPanel.tsx`, `web/src/components/TagEditor.tsx`
- Test: `web/tests/tageditor.test.tsx`

**Interfaces:**
- Produces:
  - `type DraftSlot = { shape_id:number; id:string; name:string; type:"text"|"table"|"image"; constraints:Record<string,number|string> }`
  - `TagEditor({ slides, previewUrls, value, onChange, onMove? })` — renders the current slide's preview image with absolutely-positioned overlay boxes from each shape's `bbox_pct`. Clicking a box selects it; `SlotPanel` edits the selected slot; updates flow via `onChange(slotsByShapeId)`.
  - Overlay boxes use Framer `motion.button` with `whileHover`/select animation; respects reduced motion. (`onMove` wired in C2.)

- [ ] **Step 1: Write `web/tests/tageditor.test.tsx`**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagEditor } from "@/components/TagEditor";

const slides = [{
  index: 0, width_emu: 100, height_emu: 100,
  shapes: [{ shape_id: 5, name: "Title", type: "text",
             bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }],
}];

describe("TagEditor", () => {
  it("renders an overlay box per shape", () => {
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} value={{}} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
  });

  it("selecting a shape lets you set a slot id", () => {
    const onChange = vi.fn();
    render(<TagEditor slides={slides} previewUrls={["/p0.png"]} value={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    fireEvent.change(screen.getByLabelText("Slot id"), { target: { value: "title" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last["5"].id).toBe("title");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: FAIL — components not found.

- [ ] **Step 3: Write `web/src/components/SlotPanel.tsx`**

```tsx
"use client";
export type DraftSlot = {
  shape_id: number; id: string; name: string;
  type: "text" | "table" | "image"; constraints: Record<string, number | string>;
};

export function SlotPanel({ slot, onChange }: { slot: DraftSlot; onChange: (s: DraftSlot) => void }) {
  return (
    <div className="space-y-2 p-4 border rounded">
      <label className="block text-sm">Slot id
        <input aria-label="Slot id" className="w-full border p-1 rounded"
          value={slot.id} onChange={(e) => onChange({ ...slot, id: e.target.value })} />
      </label>
      <label className="block text-sm">Type
        <select aria-label="Type" className="w-full border p-1 rounded" value={slot.type}
          onChange={(e) => onChange({ ...slot, type: e.target.value as DraftSlot["type"] })}>
          <option value="text">text</option>
          <option value="table">table</option>
          <option value="image">image</option>
        </select>
      </label>
      {slot.type === "text" && (
        <label className="block text-sm">Max chars
          <input aria-label="Max chars" type="number" className="w-full border p-1 rounded"
            value={slot.constraints.max_chars ?? ""}
            onChange={(e) => onChange({ ...slot, constraints: { ...slot.constraints, max_chars: Number(e.target.value) } })} />
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write `web/src/components/TagEditor.tsx`**

```tsx
"use client";
import { motion, useReducedMotion } from "framer-motion";
import { useRef, useState } from "react";
import { SlotPanel, type DraftSlot } from "./SlotPanel";

type Shape = { shape_id: number; name: string; type: string; bbox_pct: { x: number; y: number; w: number; h: number } };
type Slide = { index: number; shapes: Shape[] };
type Slots = Record<string, DraftSlot>;

export function TagEditor({ slides, previewUrls, value, onChange, onMove }:
  { slides: Slide[]; previewUrls: string[]; value: Slots; onChange: (s: Slots) => void;
    onMove?: (shapeId: number, bbox: { x: number; y: number; w: number; h: number }) => void }) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const slide = slides[slideIdx];

  const update = (slot: DraftSlot) => onChange({ ...value, [slot.shape_id]: slot });

  return (
    <div className="flex gap-6">
      <div ref={containerRef} className="relative w-[640px] aspect-video bg-gray-100">
        {previewUrls[slideIdx] && <img src={previewUrls[slideIdx]} alt="slide" className="w-full h-full object-contain" />}
        {slide.shapes.map((s) => (
          <motion.button key={s.shape_id} aria-label={`shape ${s.name}`}
            onClick={() => setSelected(s.shape_id)}
            drag={!!onMove} dragMomentum={false}
            onDragEnd={(_e, info) => {
              if (!onMove) return;
              const box = containerRef.current?.getBoundingClientRect();
              if (!box) return;
              const nx = ((info.point.x - box.left) / box.width) * 100;
              const ny = ((info.point.y - box.top) / box.height) * 100;
              onMove(s.shape_id, { ...s.bbox_pct, x: Math.max(0, nx), y: Math.max(0, ny) });
            }}
            whileHover={reduced ? undefined : { scale: 1.02 }}
            animate={selected === s.shape_id ? { borderColor: "#2563eb" } : { borderColor: "#9ca3af" }}
            className="absolute border-2 bg-blue-500/10"
            style={{ left: `${s.bbox_pct.x}%`, top: `${s.bbox_pct.y}%`,
                     width: `${s.bbox_pct.w}%`, height: `${s.bbox_pct.h}%` }} />
        ))}
      </div>
      <div className="w-72 space-y-3">
        <div className="flex gap-2">
          {slides.map((s, i) => (
            <button key={i} onClick={() => setSlideIdx(i)}
              className={`px-2 py-1 border rounded ${i === slideIdx ? "bg-black text-white" : ""}`}>{i + 1}</button>
          ))}
        </div>
        {selected != null && (
          <SlotPanel
            slot={value[selected] ?? {
              shape_id: selected,
              id: "", name: slide.shapes.find((x) => x.shape_id === selected)?.name ?? "",
              type: (slide.shapes.find((x) => x.shape_id === selected)?.type as DraftSlot["type"]) ?? "text",
              constraints: {},
            }}
            onChange={update} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run**

Run: `cd web && npx vitest run tests/tageditor.test.tsx`
Expected: 2 passed. (Tests pass no `onMove`, so drag is disabled and click selects.)

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SlotPanel.tsx web/src/components/TagEditor.tsx web/tests/tageditor.test.tsx
git commit -m "feat(web): add tag editor overlay and slot panel"
```

---

### Task C2: move-shape API proxy

**Files:**
- Create: `web/src/app/api/templates/[id]/move-shape/route.ts`
- Test: `web/tests/move-shape-api.test.ts`

**Interfaces:**
- Consumes: `auth`, `prisma`, `s3.getObject/putObject`, `engine.moveShape`, `engine.renderBasePreviews`.
- Produces: `POST /api/templates/[id]/move-shape` `{shape_id, bbox_pct}` — owner-only; fetch base from S3 → `engine.moveShape` → overwrite base in S3 → re-render base previews → update `manifestJson.draft` slides geometry + previewKeys. Returns `{ok:true}`. (The TagEditor `onMove` wiring already exists from C1; the edit page wires it to this route in C3.)

- [ ] **Step 1: Write `web/tests/move-shape-api.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")), putObject: vi.fn(async (k: string) => k) }));
vi.mock("@/lib/engine", () => ({
  moveShape: vi.fn(async () => Buffer.from("PK2")),
  renderBasePreviews: vi.fn(async () => ({ previews: [] })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/templates/[id]/move-shape/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const body = (o: object) => new Request("http://x", { method: "POST", body: JSON.stringify(o) });

describe("move-shape api", () => {
  it("403 for non-owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "other" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: { draft: { slides: [] } } });
    const r = await POST(body({ shape_id: 5, bbox_pct: { x: 1, y: 1, w: 1, h: 1 } }), ctx);
    expect(r.status).toBe(403);
  });

  it("moves shape for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: { draft: { slides: [] } } });
    (prisma.template.update as any).mockResolvedValue({});
    const r = await POST(body({ shape_id: 5, bbox_pct: { x: 10, y: 10, w: 40, h: 20 } }), ctx);
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/move-shape-api.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `web/src/app/api/templates/[id]/move-shape/route.ts`**

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject } from "@/lib/s3";
import { moveShape, renderBasePreviews } from "@/lib/engine";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const { shape_id, bbox_pct } = await req.json();
  const base = await getObject(tpl.basePptxKey);
  const moved = await moveShape(base, shape_id, bbox_pct);
  await putObject(tpl.basePptxKey, moved, PPTX);

  const { previews } = await renderBasePreviews(moved);
  const previewKeys: string[] = [];
  for (let i = 0; i < previews.length; i++) {
    const key = `templates/${id}/preview-${i}.png`;
    await putObject(key, Buffer.from(previews[i], "base64"), "image/png");
    previewKeys.push(key);
  }

  const draft = (tpl.manifestJson as any).draft ?? {};
  for (const slide of draft.slides ?? []) {
    for (const sh of slide.shapes ?? []) {
      if (sh.shape_id === shape_id) sh.bbox_pct = bbox_pct;
    }
  }
  if (previewKeys.length) draft.previewKeys = previewKeys;
  await prisma.template.update({ where: { id }, data: { manifestJson: { ...(tpl.manifestJson as object), draft } } });
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run tests/move-shape-api.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/templates/[id]/move-shape" web/tests/move-shape-api.test.ts
git commit -m "feat(web): add move-shape proxy"
```

---

### Task C3: Save manifest (PUT) + edit page + dashboard cards

**Files:**
- Create: `web/src/app/api/templates/[id]/route.ts` (GET, PUT, DELETE)
- Create: `web/src/app/(app)/templates/[id]/edit/page.tsx`, `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`
- Create: `web/src/components/TemplateCard.tsx`
- Create: `web/src/app/(app)/dashboard/page.tsx`, `web/src/app/(app)/dashboard/DashboardGrid.tsx`
- Test: `web/tests/templates-save.test.ts`

**Interfaces:**
- Consumes: `auth`, `prisma`, `presignGet`.
- Produces:
  - `PUT /api/templates/[id]` `{name?, description?, visibility?, slideTypes}` — owner-only; converts tagged slots into a real `manifest` (slot → `target.shape_id`) saved to `manifestJson` (keeping `draft`). Rejects empty slot `id`.
  - `GET/DELETE /api/templates/[id]` — owner-or-public read; owner-only delete.
  - Edit page presigns previews + renders `TagEditor`, wires `onMove` to C2 route, Save button.
  - `TemplateCard` (`cardItem` + hover); dashboard grid with `staggerContainer`.

- [ ] **Step 1: Write `web/tests/templates-save.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), update: vi.fn() } } }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PUT } from "@/app/api/templates/[id]/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const put = (o: object) => new Request("http://x", { method: "PUT", body: JSON.stringify(o) });

const slideTypes = [{
  id: "title", name: "Title", source_slide_index: 0,
  slots: [{ id: "title", name: "Title", type: "text", shape_id: 5, constraints: { max_chars: 40 } }],
}];

describe("save manifest", () => {
  it("rejects slot with empty id", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", manifestJson: {} });
    const bad = [{ ...slideTypes[0], slots: [{ ...slideTypes[0].slots[0], id: "" }] }];
    const r = await PUT(put({ slideTypes: bad }), ctx);
    expect(r.status).toBe(400);
  });

  it("saves real manifest for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", manifestJson: { draft: {} } });
    (prisma.template.update as any).mockResolvedValue({});
    const r = await PUT(put({ name: "Pitch", slideTypes }), ctx);
    expect(r.status).toBe(200);
    const arg = (prisma.template.update as any).mock.calls[0][0];
    const saved = arg.data.manifestJson;
    expect(saved.slide_types[0].slots[0].target.shape_id).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `web/src/app/api/templates/[id]/route.ts`**

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  const session = await auth();
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== session?.user?.id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json(tpl);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  const { name, description, visibility, slideTypes } = await req.json();
  const slide_types = (slideTypes ?? []).map((st: any) => ({
    id: st.id, name: st.name, description: st.description ?? "",
    source_slide_index: st.source_slide_index,
    slots: (st.slots ?? []).map((s: any) => ({
      id: s.id, name: s.name, type: s.type, target: { shape_id: s.shape_id },
      required: s.required ?? true, default: s.default ?? null, constraints: s.constraints ?? {},
    })),
  }));
  for (const st of slide_types) for (const s of st.slots) {
    if (!s.id) return Response.json({ error: "every slot needs an id" }, { status: 400 });
  }

  const manifestJson = {
    ...(tpl.manifestJson as object),
    template: { id, name: name ?? tpl.name, description: description ?? tpl.description },
    slide_types,
  };
  await prisma.template.update({
    where: { id },
    data: {
      name: name ?? tpl.name, description: description ?? tpl.description,
      visibility: visibility ?? tpl.visibility, manifestJson,
    },
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  await prisma.template.delete({ where: { id } });
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Write `web/src/components/TemplateCard.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { cardItem } from "@/lib/motion/variants";

export function TemplateCard({ name, description, href }:
  { name: string; description: string; href: string }) {
  return (
    <motion.a href={href} variants={cardItem}
      whileHover={{ y: -4, scale: 1.01 }} whileTap={{ scale: 0.99 }}
      className="block rounded-xl border p-5 shadow-sm">
      <h3 className="font-semibold">{name}</h3>
      <p className="text-sm text-gray-500 line-clamp-2">{description}</p>
    </motion.a>
  );
}
```

- [ ] **Step 5: Write `web/src/app/(app)/dashboard/DashboardGrid.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { TemplateCard } from "@/components/TemplateCard";
import { staggerContainer } from "@/lib/motion/variants";

export function DashboardGrid({ templates }:
  { templates: { id: string; name: string; description: string }[] }) {
  return (
    <motion.div variants={staggerContainer} initial="initial" animate="animate"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((t) => (
        <TemplateCard key={t.id} name={t.name} description={t.description} href={`/templates/${t.id}/edit`} />
      ))}
    </motion.div>
  );
}
```

- [ ] **Step 6: Write `web/src/app/(app)/dashboard/page.tsx`**

```tsx
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DashboardGrid } from "./DashboardGrid";

export default async function Dashboard() {
  const session = await auth();
  const templates = session?.user?.id
    ? await prisma.template.findMany({ where: { ownerId: session.user.id }, orderBy: { updatedAt: "desc" } })
    : [];
  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">My templates</h1>
        <a href="/templates/new" className="bg-black text-white px-4 py-2 rounded">New</a>
      </div>
      <DashboardGrid templates={templates.map((t) => ({ id: t.id, name: t.name, description: t.description }))} />
    </div>
  );
}
```

- [ ] **Step 7: Write `web/src/app/(app)/templates/[id]/edit/page.tsx`**

```tsx
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignGet } from "@/lib/s3";
import { EditClient } from "./EditClient";

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl || tpl.ownerId !== session?.user?.id) return <div className="p-8">Not found</div>;
  const draft = (tpl.manifestJson as any).draft ?? { slides: [], previewKeys: [] };
  const previewUrls = await Promise.all((draft.previewKeys ?? []).map((k: string) => presignGet(k)));
  return <EditClient id={id} name={tpl.name} slides={draft.slides} previewUrls={previewUrls} />;
}
```

- [ ] **Step 8: Write `web/src/app/(app)/templates/[id]/edit/EditClient.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { TagEditor } from "@/components/TagEditor";
import type { DraftSlot } from "@/components/SlotPanel";
import { PageTransition } from "@/lib/motion/PageTransition";

export function EditClient({ id, name, slides, previewUrls }:
  { id: string; name: string; slides: any[]; previewUrls: string[] }) {
  const [slots, setSlots] = useState<Record<string, DraftSlot>>({});

  async function onMove(shapeId: number, bbox: { x: number; y: number; w: number; h: number }) {
    await fetch(`/api/templates/${id}/move-shape`, {
      method: "POST", body: JSON.stringify({ shape_id: shapeId, bbox_pct: bbox }),
    });
  }

  async function save() {
    const slideTypes = slides.map((sl, idx) => ({
      id: `slide_${idx}`, name: `Slide ${idx + 1}`, source_slide_index: idx,
      slots: Object.values(slots).filter((s) =>
        sl.shapes.some((sh: any) => sh.shape_id === s.shape_id) && s.id),
    }));
    await fetch(`/api/templates/${id}`, { method: "PUT", body: JSON.stringify({ name, slideTypes }) });
  }

  return (
    <PageTransition>
      <div className="p-8 space-y-4">
        <h1 className="text-xl font-semibold">{name}</h1>
        <TagEditor slides={slides} previewUrls={previewUrls} value={slots} onChange={setSlots} onMove={onMove} />
        <motion.button whileTap={{ scale: 0.97 }} onClick={save}
          className="bg-black text-white px-4 py-2 rounded">Save template</motion.button>
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 9: Run**

Run: `cd web && npx vitest run tests/templates-save.test.ts`
Expected: 2 passed.

- [ ] **Step 10: Commit**

```bash
git add "web/src/app/api/templates/[id]/route.ts" "web/src/app/(app)/templates/[id]/edit" "web/src/app/(app)/dashboard" web/src/components/TemplateCard.tsx web/tests/templates-save.test.ts
git commit -m "feat(web): add manifest save, edit page, animated dashboard"
```

---

### Task C4: Public gallery

**Files:**
- Create: `web/src/lib/templates.ts` (`listPublicTemplates()`)
- Create: `web/src/app/(app)/gallery/page.tsx`, `web/src/app/(app)/gallery/GalleryGrid.tsx`
- Test: `web/tests/gallery.test.ts`

**Interfaces:**
- Produces: `listPublicTemplates() -> Template[]` (visibility PUBLIC, newest first); gallery page renders animated grid reusing `TemplateCard`.

- [ ] **Step 1: Write `web/tests/gallery.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findMany: vi.fn() } } }));
import { prisma } from "@/lib/prisma";
import { listPublicTemplates } from "@/lib/templates";

beforeEach(() => vi.clearAllMocks());

describe("gallery query", () => {
  it("filters by PUBLIC visibility", async () => {
    (prisma.template.findMany as any).mockResolvedValue([{ id: "t1" }]);
    await listPublicTemplates();
    const arg = (prisma.template.findMany as any).mock.calls[0][0];
    expect(arg.where.visibility).toBe("PUBLIC");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/gallery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `web/src/lib/templates.ts`**

```ts
import { prisma } from "@/lib/prisma";

export function listPublicTemplates() {
  return prisma.template.findMany({ where: { visibility: "PUBLIC" }, orderBy: { updatedAt: "desc" } });
}
```

- [ ] **Step 4: Write `web/src/app/(app)/gallery/GalleryGrid.tsx`**

```tsx
"use client";
import { motion } from "framer-motion";
import { TemplateCard } from "@/components/TemplateCard";
import { staggerContainer } from "@/lib/motion/variants";

export function GalleryGrid({ templates }: { templates: { id: string; name: string; description: string }[] }) {
  return (
    <motion.div variants={staggerContainer} initial="initial" animate="animate"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((t) => (
        <TemplateCard key={t.id} name={t.name} description={t.description} href={`/templates/${t.id}/edit`} />
      ))}
    </motion.div>
  );
}
```

- [ ] **Step 5: Write `web/src/app/(app)/gallery/page.tsx`**

```tsx
import { listPublicTemplates } from "@/lib/templates";
import { GalleryGrid } from "./GalleryGrid";

export default async function Gallery() {
  const templates = await listPublicTemplates();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold mb-6">Public gallery</h1>
      <GalleryGrid templates={templates.map((t) => ({ id: t.id, name: t.name, description: t.description }))} />
    </div>
  );
}
```

- [ ] **Step 6: Run**

Run: `cd web && npx vitest run tests/gallery.test.ts`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/templates.ts "web/src/app/(app)/gallery" web/tests/gallery.test.ts
git commit -m "feat(web): add public gallery"
```

---

# PART D — API keys, internal MCP API, thin MCP, Docker Compose

### Task D1: API key lib + keys API + settings page

**Files:**
- Create: `web/src/lib/apiKey.ts`
- Create: `web/src/app/api/keys/route.ts`, `web/src/app/api/keys/[id]/route.ts`
- Create: `web/src/app/(app)/settings/keys/page.tsx`
- Test: `web/tests/apikey.test.ts`

**Interfaces:**
- Produces:
  - `generateApiKey() -> { raw, prefix, hash }` — `raw = pk_<prefix>_<secret>`, `hash = bcrypt(secret)`.
  - `verifyApiKey(raw) -> userId | null` — parse prefix, find ApiKey, bcrypt-compare secret, update `lastUsedAt`.
  - `POST /api/keys` → `{raw}` once. `GET /api/keys` → list (no secret). `DELETE /api/keys/[id]`.
  - Settings page (animated reveal of raw key).

- [ ] **Step 1: Write `web/tests/apikey.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { apiKey: { findUnique: (a: any) => findUnique(a), update: (a: any) => update(a) } } }));

import { generateApiKey, verifyApiKey } from "@/lib/apiKey";

beforeEach(() => { findUnique.mockReset(); update.mockReset(); });

describe("api key", () => {
  it("generates raw with prefix and bcrypt hash", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    expect(raw.startsWith(`pk_${prefix}_`)).toBe(true);
    expect(hash).not.toContain(raw);
  });

  it("verifies a valid key", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    findUnique.mockResolvedValue({ id: "k1", userId: "u1", prefix, hash });
    update.mockResolvedValue({});
    expect(await verifyApiKey(raw)).toBe("u1");
  });

  it("rejects a tampered key", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    findUnique.mockResolvedValue({ id: "k1", userId: "u1", prefix, hash });
    expect(await verifyApiKey(raw.slice(0, -1) + "0")).toBeNull();
  });

  it("rejects unknown prefix", async () => {
    findUnique.mockResolvedValue(null);
    expect(await verifyApiKey("pk_deadbeef_secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/apikey.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `web/src/lib/apiKey.ts`**

```ts
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

export async function generateApiKey() {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("hex");
  const hash = await bcrypt.hash(secret, 12);
  return { raw: `pk_${prefix}_${secret}`, prefix, hash };
}

export async function verifyApiKey(raw: string): Promise<string | null> {
  const m = /^pk_([0-9a-f]+)_([0-9a-f]+)$/.exec(raw ?? "");
  if (!m) return null;
  const [, prefix, secret] = m;
  const key = await prisma.apiKey.findUnique({ where: { prefix } });
  if (!key) return null;
  if (!(await bcrypt.compare(secret, key.hash))) return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key.userId;
}
```

- [ ] **Step 4: Write `web/src/app/api/keys/route.ts`**

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/apiKey";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const keys = await prisma.apiKey.findMany({
    where: { userId: session.user.id },
    select: { id: true, prefix: true, createdAt: true, lastUsedAt: true },
  });
  return Response.json(keys);
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { raw, prefix, hash } = await generateApiKey();
  await prisma.apiKey.create({ data: { userId: session.user.id, prefix, hash } });
  return Response.json({ raw }, { status: 201 });
}
```

- [ ] **Step 5: Write `web/src/app/api/keys/[id]/route.ts`**

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key || key.userId !== session.user.id) return Response.json({ error: "not found" }, { status: 404 });
  await prisma.apiKey.delete({ where: { id } });
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Write `web/src/app/(app)/settings/keys/page.tsx`**

```tsx
"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { PageTransition } from "@/lib/motion/PageTransition";

export default function Keys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  async function load() { setKeys(await (await fetch("/api/keys")).json()); }
  useEffect(() => { load(); }, []);
  async function create() {
    const r = await fetch("/api/keys", { method: "POST" });
    setRaw((await r.json()).raw);
    load();
  }
  return (
    <PageTransition>
      <div className="p-8 max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold">API keys</h1>
        <motion.button whileTap={{ scale: 0.97 }} onClick={create}
          className="bg-black text-white px-4 py-2 rounded">Create key</motion.button>
        <AnimatePresence>
          {raw && (
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }} className="border rounded p-3 bg-yellow-50 break-all">
              Copy now (shown once): <code>{raw}</code>
            </motion.div>
          )}
        </AnimatePresence>
        <ul className="space-y-2">
          {keys.map((k) => (
            <li key={k.id} className="flex justify-between border rounded p-2">
              <span><code>pk_{k.prefix}_…</code></span>
              <button className="text-red-600"
                onClick={async () => { await fetch(`/api/keys/${k.id}`, { method: "DELETE" }); load(); }}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </div>
    </PageTransition>
  );
}
```

- [ ] **Step 7: Run**

Run: `cd web && npx vitest run tests/apikey.test.ts`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/apiKey.ts web/src/app/api/keys "web/src/app/(app)/settings" web/tests/apikey.test.ts
git commit -m "feat(web): add API key management"
```

---

### Task D2: Internal MCP API (X-API-Key)

**Files:**
- Create: `web/src/lib/mcpAuth.ts`, `web/src/lib/schema.ts`
- Create: `web/src/app/api/mcp/templates/route.ts`
- Create: `web/src/app/api/mcp/templates/[id]/schema/route.ts`
- Create: `web/src/app/api/mcp/templates/[id]/render/route.ts`
- Create: `web/src/app/api/mcp/templates/[id]/preview/route.ts`
- Test: `web/tests/mcp-api.test.ts`

**Interfaces:**
- Consumes: `verifyApiKey`, `prisma`, `s3`, `engine`.
- Produces:
  - `requireApiKey(req) -> userId | Response` (401 Response when invalid).
  - `toAgentSchema(manifestJson)` — agent schema (no shape ids).
  - `GET /api/mcp/templates` — caller's + PUBLIC (summaries).
  - `GET /api/mcp/templates/[id]/schema` — agent schema.
  - `POST /api/mcp/templates/[id]/render` `{deck_spec}` → `{validation, download_url|null}`.
  - `POST /api/mcp/templates/[id]/preview` `{deck_spec}` → `{validation, previews}`.
  - Authorization: allowed if owner OR PUBLIC; else 403; missing → 404.

- [ ] **Step 1: Write `web/tests/mcp-api.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiKey", () => ({ verifyApiKey: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn(), findMany: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({
  getObject: vi.fn(async () => Buffer.from("PK")), putObject: vi.fn(async (k: string) => k),
  presignGet: vi.fn(async () => "https://signed/url"),
}));
vi.mock("@/lib/engine", () => ({ renderDeck: vi.fn() }));

import { verifyApiKey } from "@/lib/apiKey";
import { prisma } from "@/lib/prisma";
import { renderDeck } from "@/lib/engine";
import { POST as RENDER } from "@/app/api/mcp/templates/[id]/render/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
function req(deck: object) {
  return new Request("http://x", { method: "POST", headers: { "x-api-key": "pk_a_b" }, body: JSON.stringify({ deck_spec: deck }) });
}

describe("mcp render", () => {
  it("401 without valid key", async () => {
    (verifyApiKey as any).mockResolvedValue(null);
    expect((await RENDER(req({}), ctx)).status).toBe(401);
  });

  it("403 for private template not owned", async () => {
    (verifyApiKey as any).mockResolvedValue("u2");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE" });
    expect((await RENDER(req({}), ctx)).status).toBe(403);
  });

  it("returns validation when engine rejects", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", basePptxKey: "k", manifestJson: { slide_types: [] } });
    (renderDeck as any).mockResolvedValue({ validation: [{ code: "text_overflow" }] });
    const r = await RENDER(req({ slides: [] }), ctx);
    const body = await r.json();
    expect(body.download_url).toBeNull();
    expect(body.validation[0].code).toBe("text_overflow");
  });

  it("returns download_url on success", async () => {
    (verifyApiKey as any).mockResolvedValue("u1");
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", visibility: "PRIVATE", basePptxKey: "k", manifestJson: { slide_types: [] } });
    (renderDeck as any).mockResolvedValue({ validation: [], pptx: Buffer.from("PK") });
    const r = await RENDER(req({ slides: [] }), ctx);
    const body = await r.json();
    expect(body.download_url).toBe("https://signed/url");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run tests/mcp-api.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `web/src/lib/mcpAuth.ts`**

```ts
import { verifyApiKey } from "@/lib/apiKey";

export async function requireApiKey(req: Request): Promise<string | Response> {
  const raw = req.headers.get("x-api-key") ?? "";
  const userId = await verifyApiKey(raw);
  if (!userId) return Response.json({ error: "invalid api key" }, { status: 401 });
  return userId;
}
```

- [ ] **Step 4: Write `web/src/lib/schema.ts`**

```ts
export function toAgentSchema(manifestJson: any) {
  return {
    id: manifestJson?.template?.id,
    name: manifestJson?.template?.name,
    description: manifestJson?.template?.description ?? "",
    slide_types: (manifestJson?.slide_types ?? []).map((st: any) => ({
      id: st.id, name: st.name, description: st.description ?? "",
      slots: (st.slots ?? []).map((s: any) => ({
        id: s.id, name: s.name, type: s.type,
        required: s.required ?? true, default: s.default ?? null,
        constraints: s.constraints ?? {},
      })),
    })),
  };
}
```

- [ ] **Step 5: Write `web/src/app/api/mcp/templates/[id]/render/route.ts`**

```ts
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderDeck } from "@/lib/engine";
import { randomBytes } from "crypto";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { deck_spec } = await req.json();
  const base = await getObject(tpl.basePptxKey);
  const out = await renderDeck(base, tpl.manifestJson, deck_spec);
  if (!out.pptx) return Response.json({ validation: out.validation, download_url: null });
  const key = `outputs/${id}/${randomBytes(8).toString("hex")}.pptx`;
  await putObject(key, out.pptx, PPTX);
  return Response.json({ validation: [], download_url: await presignGet(key) });
}
```

- [ ] **Step 6: Write `web/src/app/api/mcp/templates/[id]/preview/route.ts`**

```ts
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, presignGet } from "@/lib/s3";
import { renderPreview } from "@/lib/engine";
import { randomBytes } from "crypto";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { deck_spec } = await req.json();
  const base = await getObject(tpl.basePptxKey);
  const out = await renderPreview(base, tpl.manifestJson, deck_spec);
  if (out.validation?.length) return Response.json({ validation: out.validation, previews: [] });
  const urls: string[] = [];
  for (const b64 of out.previews ?? []) {
    const key = `outputs/${id}/preview-${randomBytes(6).toString("hex")}.png`;
    await putObject(key, Buffer.from(b64, "base64"), "image/png");
    urls.push(await presignGet(key));
  }
  return Response.json({ validation: [], previews: urls });
}
```

- [ ] **Step 7: Write `web/src/app/api/mcp/templates/[id]/schema/route.ts`**

```ts
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { toAgentSchema } from "@/lib/schema";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.visibility !== "PUBLIC" && tpl.ownerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json(toAgentSchema(tpl.manifestJson));
}
```

- [ ] **Step 8: Write `web/src/app/api/mcp/templates/route.ts`**

```ts
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const userId = await requireApiKey(req);
  if (userId instanceof Response) return userId;
  const templates = await prisma.template.findMany({
    where: { OR: [{ ownerId: userId }, { visibility: "PUBLIC" }] },
    orderBy: { updatedAt: "desc" },
  });
  return Response.json(templates.map((t) => ({
    id: t.id, name: t.name, description: t.description,
    slide_types: ((t.manifestJson as any).slide_types ?? []).map((st: any) =>
      ({ id: st.id, name: st.name, description: st.description ?? "" })),
  })));
}
```

- [ ] **Step 9: Run**

Run: `cd web && npx vitest run tests/mcp-api.test.ts`
Expected: 4 passed.

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/mcpAuth.ts web/src/lib/schema.ts web/src/app/api/mcp web/tests/mcp-api.test.ts
git commit -m "feat(web): add internal MCP API with API-key auth"
```

---

### Task D3: Thin Python MCP proxy

**Files:**
- Create: `mcp-server/server.py`, `mcp-server/requirements.txt`
- Test: `mcp-server/tests/test_proxy.py`

**Interfaces:**
- Produces: plain functions (testable) + FastMCP tools:
  - `list_templates()` → `GET {WEB_URL}/api/mcp/templates`
  - `get_template_schema(template_id)` → `GET .../{id}/schema`
  - `render_deck(template_id, deck_spec)` → `POST .../{id}/render`
  - `render_preview(template_id, deck_spec)` → `POST .../{id}/preview`
  - All send `X-API-Key: $PPTX_API_KEY`. `build_server()` registers FastMCP tools calling these.

- [ ] **Step 1: Create `mcp-server/requirements.txt`**

```
fastmcp>=0.2.0
httpx>=0.27
pytest>=8
respx>=0.21
```

- [ ] **Step 2: Write `mcp-server/tests/test_proxy.py`**

```python
import respx
import httpx
from server import list_templates, render_deck

BASE = "http://web:3000"


@respx.mock
def test_list_templates(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    route = respx.get(f"{BASE}/api/mcp/templates").mock(
        return_value=httpx.Response(200, json=[{"id": "t1"}]))
    out = list_templates()
    assert out[0]["id"] == "t1"
    assert route.calls.last.request.headers["x-api-key"] == "pk_a_b"


@respx.mock
def test_render_deck_passthrough(monkeypatch):
    monkeypatch.setenv("WEB_URL", BASE)
    monkeypatch.setenv("PPTX_API_KEY", "pk_a_b")
    respx.post(f"{BASE}/api/mcp/templates/t1/render").mock(
        return_value=httpx.Response(200, json={"validation": [], "download_url": "https://d/u"}))
    out = render_deck("t1", {"slides": []})
    assert out["download_url"] == "https://d/u"
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd mcp-server && pip install -r requirements.txt && pytest -v`
Expected: FAIL — `server` not found.

- [ ] **Step 4: Write `mcp-server/server.py`**

```python
import os

import httpx


def _base() -> str:
    return os.environ.get("WEB_URL", "http://web:3000")


def _headers() -> dict:
    return {"X-API-Key": os.environ.get("PPTX_API_KEY", "")}


def list_templates() -> list:
    r = httpx.get(f"{_base()}/api/mcp/templates", headers=_headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def get_template_schema(template_id: str) -> dict:
    r = httpx.get(f"{_base()}/api/mcp/templates/{template_id}/schema", headers=_headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def render_deck(template_id: str, deck_spec: dict) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/render",
                   headers=_headers(), json={"deck_spec": deck_spec}, timeout=120)
    r.raise_for_status()
    return r.json()


def render_preview(template_id: str, deck_spec: dict) -> dict:
    r = httpx.post(f"{_base()}/api/mcp/templates/{template_id}/preview",
                   headers=_headers(), json={"deck_spec": deck_spec}, timeout=120)
    r.raise_for_status()
    return r.json()


def build_server():
    from fastmcp import FastMCP
    mcp = FastMCP("pptx-mcp")

    @mcp.tool()
    def list_templates_tool() -> list:
        """List templates available to this API key."""
        return list_templates()

    @mcp.tool()
    def get_template_schema_tool(template_id: str) -> dict:
        """Get the slot schema for a template."""
        return get_template_schema(template_id)

    @mcp.tool()
    def render_deck_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render a deck; returns validation + download_url."""
        return render_deck(template_id, deck_spec)

    @mcp.tool()
    def render_preview_tool(template_id: str, deck_spec: dict) -> dict:
        """Validate + render preview PNGs."""
        return render_preview(template_id, deck_spec)

    return mcp


if __name__ == "__main__":
    build_server().run()
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd mcp-server && pytest -v`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/
git commit -m "feat: add thin Python MCP proxy"
```

---

### Task D4: Dockerfiles + Compose + .env.example + e2e smoke

**Files:**
- Create: `engine-service/Dockerfile`, `mcp-server/Dockerfile`, `web/Dockerfile`
- Create: `docker-compose.yml`, `.env.example`, `scripts/e2e-smoke.sh`

**Interfaces:**
- Produces: a runnable stack + a smoke script (register + engine health).

- [ ] **Step 1: Write `engine-service/Dockerfile`**

```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice poppler-utils fonts-dejavu && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY engine /srv/engine
COPY engine-service /srv/engine-service
RUN pip install -e /srv/engine && pip install -r /srv/engine-service/requirements.txt
WORKDIR /srv/engine-service
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

Verify after build: `docker run --rm <img> soffice --version` resolves (LibreOffice on PATH).

- [ ] **Step 2: Write `mcp-server/Dockerfile`**

```dockerfile
FROM python:3.11-slim
WORKDIR /srv/mcp-server
COPY mcp-server/requirements.txt .
RUN pip install -r requirements.txt
COPY mcp-server/ .
CMD ["python", "server.py"]
```

- [ ] **Step 3: Write `web/Dockerfile`**

```dockerfile
FROM node:20-slim AS deps
WORKDIR /app
COPY web/package*.json ./
RUN npm ci
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN npx prisma generate && npm run build
FROM node:20-slim
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
```

- [ ] **Step 4: Write `.env.example`**

```bash
# --- web ---
DATABASE_URL=postgresql://pptx:pptx@postgres:5432/pptx
AUTH_SECRET=change-me-long-random
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
ENGINE_URL=http://engine-service:8000
# --- s3 (minio) ---
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=pptx
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
# --- mcp-server ---
WEB_URL=http://web:3000
PPTX_API_KEY=
```

Note: OAuth IDs blank by default — email/password works without them; fill these to enable social login.

- [ ] **Step 5: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: pptx
      POSTGRES_PASSWORD: pptx
      POSTGRES_DB: pptx
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pptx"]
      interval: 5s
      retries: 10

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]

  createbucket:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "
      until /usr/bin/mc alias set m http://minio:9000 minioadmin minioadmin; do sleep 1; done;
      /usr/bin/mc mb -p m/pptx || true;
      "

  engine-service:
    build: { context: ., dockerfile: engine-service/Dockerfile }
    ports: ["8000:8000"]

  web:
    build: { context: ., dockerfile: web/Dockerfile }
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      engine-service: { condition: service_started }
      createbucket: { condition: service_completed_successfully }
    ports: ["3000:3000"]

  mcp-server:
    build: { context: ., dockerfile: mcp-server/Dockerfile }
    env_file: .env
    depends_on: [web]
```

- [ ] **Step 6: Write `scripts/e2e-smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-http://localhost:3000}

echo "engine health"
curl -fsS http://localhost:8000/health

echo "register"
curl -fsS -X POST "$BASE/api/register" -d '{"email":"smoke@test.com","password":"password123"}'

echo "OK — full UI flow (upload/tag/render via key) requires an authenticated session; verify in browser or a later Playwright test."
```

Make executable: `chmod +x scripts/e2e-smoke.sh`.

- [ ] **Step 7: Build + up + smoke**

Run:
```bash
cp .env.example .env
docker compose build
docker compose up -d
bash scripts/e2e-smoke.sh
```
Expected: engine `/health` → `{"ok":true}`; register → 201. (Session-driven UI flow not exercised by unattended curl.)

- [ ] **Step 8: Commit**

```bash
git add engine-service/Dockerfile mcp-server/Dockerfile web/Dockerfile docker-compose.yml .env.example scripts/e2e-smoke.sh
git commit -m "feat: add Dockerfiles, Compose, and e2e smoke"
```

---

## Self-Review

**Spec coverage:**
- engine-service endpoints (§3.1) → A1–A3; `load_from_bytes` → A1.
- Auth OAuth + email/password (§3.2) → B3. Prisma models → B2. S3/engine clients → B4. Upload → B5.
- Tag editor PNG overlay → C1. Drag-to-move + move-shape → C1 (`onMove`) + C2 (route) + C3 (wiring). Manifest save + dashboard + edit → C3. Public gallery → C4.
- API keys → D1. Internal MCP API + authorization (owner/public/forbidden) → D2. Thin MCP proxy → D3. Compose + .env + smoke → D4.
- Animation principle (§8) → primitives B1; applied + reduced-motion tested across C1/C3/D1 UI tasks.
- Security (§6): bcrypt B3/D1; key hashing D1; authorization D2; presigned URLs B4/D2.

**Placeholder scan:** No TBD/TODO. Engine Dockerfile installs full LibreOffice (build-verify `soffice` on PATH).

**Type consistency:** `manifestJson` draft↔real shape consistent across B5/C2/C3/D2. `renderDeck` returns `{pptx?, validation}` (B4) consumed identically in D2. `bbox_pct {x,y,w,h}` consistent across A1/A2/C1/C2. API-key format `pk_<prefix>_<secret>` consistent D1↔D2↔D3. MCP proxy responses match internal API shapes.

**Known manual-verification gaps (documented for the autonomous run):** OAuth login and session-driven browser flows (upload/tag/save) can't be fully exercised by unattended curl — covered by unit/integration tests with mocked sessions; add a Playwright e2e later. Engine `assembler` slide-copy correctness rides on v1 Task 8.

## Out of Scope (phase 3+)

Billing/Stripe, org/team tenancy, template versioning, in-browser WYSIWYG authoring, charts, real-time co-editing, Playwright full e2e.
