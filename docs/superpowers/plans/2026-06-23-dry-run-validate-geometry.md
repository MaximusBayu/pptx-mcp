# Dry-Run Validate + Geometry in Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give authors (MCP agents + web) a dry-run that returns `{errors, warnings}` without producing output, and expose per-slot geometry (dims, font, capacity) in the template schema.

**Architecture:** One engine `dry_run` reuses `render()` and drops the bytes. It backs an in-process MCP `validate_deck` tool and an engine-service `/validate-deck` route consumed by web `/api/templates/[id]/validate` (+ api-key sibling). Separately, `get_schema` opens the template pptx and adds a `geometry` block to each slot.

**Tech Stack:** Python (python-pptx, FastAPI), TypeScript (Next.js App Router), pytest, vitest.

## Global Constraints

- Dry-run returns `{"errors": [...], "warnings": [...]}` — both lists of dicts. Errors from validation; warnings from the fill (`text_truncated`). Reuse `render()`; discard bytes. No LibreOffice preview.
- Surfaces: MCP `validate_deck` tool **and** engine-service `/validate-deck` + web `/api/templates/[id]/validate` + `/api/mcp/templates/[id]/validate`. Mirror the existing render-deck path at every layer.
- Geometry computed at schema time from the pptx — **no** `Slot` model change, no migration. Fields per slot: `geometry: {width_emu:int, height_emu:int, font_pt:float|null, capacity_chars:int|null}`. `font_pt`/`capacity_chars` are text-only (null for image/table). Missing shape → `geometry: null`.
- Reuse `estimate_max_chars` and `_first_font_pt` from `autodetect.py`; do not reimplement or change the capacity formula.
- `validate`/`render` behaviour unchanged. Schema change is additive (back-compat).

## Reference — current code state (verified)

- `render.py`: `render(deck_spec, template) -> tuple[bytes, list[dict]]`; raises `RenderRejected(errors)` (which holds `.errors: list[SlotError]`) on validation failure. Warnings are already `w.to_dict()` dicts.
- `mcp_server.py`: imports `from .render import RenderRejected, render`; `build_server(storage, base_url)` defines tools with `@mcp.tool()`; `tool_render_deck(storage, base_url, template_id, deck_spec)` is the pattern.
- `engine-service/app.py`: imports `os`, `json`, `JSONResponse`, `Response`, `load_from_bytes`, `render`, `RenderRejected`, `validate`. `/render-deck` reads `file`+`manifest`+`deck_spec` form, `load_from_bytes(data, json.loads(manifest))`, unlinks `tpl.pptx_path` in `finally`.
- `schema.py`: `get_schema(template)` + `_slot_dict(slot)`; currently no pptx access.
- `autodetect.py`: `_first_font_pt(shape) -> float | None`, `estimate_max_chars(w, h, font_pt) -> (max_chars, lines)`, `DEFAULT_FONT_PT = 18.0`. `estimate_max_chars` already falls back to `DEFAULT_FONT_PT` when font_pt is falsy.
- `assembler.py`: `find_shape(slide, shape_id)` **raises `KeyError`** when absent.
- `web/src/lib/engine.ts`: `BASE`, `form(pptx, extra)`, `renderDeck(pptx, manifest, deckSpec)` posts `form(pptx, {manifest: JSON.stringify(...), deck_spec: JSON.stringify(...)})`; 422 → `{validation, warnings:[]}`, else parses bytes + `X-Overflow-Warnings`. `EngineError` is exported.
- Web render routes: `/api/templates/[id]/render` (session: `auth()`, owner check) and `/api/mcp/templates/[id]/render` (`requireApiKey(req)`, public-or-owner check). Both: `getObject(tpl.basePptxKey)` → `renderDeck(base, tpl.manifestJson, deck_spec)`.
- Test files exist: `engine/tests/test_render.py`, `engine/tests/test_mcp_server.py`, `engine/tests/test_schema.py`, `engine-service/tests/test_endpoints.py`, `web/tests/engine.test.ts`, `web/tests/move-shape-api.test.ts` (route-test mock pattern), `web/tests/mcp-api.test.ts` (api-key route pattern).

---

### Task 1: engine `dry_run` + MCP `validate_deck` tool

**Files:**
- Modify: `engine/src/pptx_mcp/render.py` (add `dry_run`)
- Modify: `engine/src/pptx_mcp/mcp_server.py` (add `tool_validate_deck` + `validate_deck` tool)
- Test: `engine/tests/test_render.py`, `engine/tests/test_mcp_server.py` (append)

**Interfaces:**
- Consumes: `render`, `RenderRejected` (already imported in both files).
- Produces:
  - `dry_run(deck_spec: dict, template: Template) -> dict` → `{"errors": list[dict], "warnings": list[dict]}`
  - `tool_validate_deck(storage, template_id, deck_spec) -> dict`
  - MCP tool `validate_deck(template_id, deck_spec) -> dict`

- [ ] **Step 1: Write the failing tests**

For `test_render.py`, reuse the SAME fixtures and deck-spec construction that the existing passing tests in this file use (e.g. `load_template(sample_template_dir)` and a valid `deck_spec`; for the overflow case copy the deck-spec an existing `text_overflow`/`text_truncated` test builds). Add:

```python
# Append to engine/tests/test_render.py
from pptx_mcp.render import dry_run


def test_dry_run_valid_deck_returns_no_errors(sample_template_dir):
    tpl = load_template(sample_template_dir)
    # Reuse a known-valid deck_spec (same shape an existing render test uses).
    deck = {"slides": [{"slide_type": tpl.slide_types[0].id, "slots": {}}]}
    result = dry_run(deck, tpl)
    assert result["errors"] == []
    assert isinstance(result["warnings"], list)


def test_dry_run_invalid_deck_returns_errors(sample_template_dir):
    tpl = load_template(sample_template_dir)
    deck = {"slides": [{"slide_type": "does_not_exist", "slots": {}}]}
    result = dry_run(deck, tpl)
    # An unknown slide_type / missing required slot yields validation errors,
    # no warnings, and never raises.
    assert result["warnings"] == []
```

If `{"slots": {}}` is itself invalid for the chosen slide type (a required slot with no default), pick a slide type whose required slots you fill with sample values so the first test's deck is genuinely valid — match an existing valid render test. The second test must produce at least one validation error: use a slide_type id the template does not define (as above) or omit a required slot.

For `test_mcp_server.py`, mirror the existing tests' storage fixture/setup:

```python
# Append to engine/tests/test_mcp_server.py
from pptx_mcp.mcp_server import tool_validate_deck


def test_tool_validate_deck_returns_errors_and_warnings(<existing storage fixture>):
    # Use the same storage + template_id an existing test_mcp_server test uses.
    result = tool_validate_deck(storage, template_id, {"slides": []})
    assert "errors" in result and "warnings" in result
    assert isinstance(result["errors"], list)
    assert isinstance(result["warnings"], list)
```

Replace `<existing storage fixture>` and `storage`/`template_id` with whatever the existing `test_mcp_server.py` tests already construct (read the file first; copy its fixture).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_render.py -k dry_run tests/test_mcp_server.py -k validate_deck -v`
Expected: FAIL — `ImportError: cannot import name 'dry_run'` / `cannot import name 'tool_validate_deck'`

- [ ] **Step 3: Add `dry_run` to `render.py`**

Append to `engine/src/pptx_mcp/render.py`:

```python
def dry_run(deck_spec: dict, template: Template) -> dict:
    """Validate + fill without producing output; return errors and warnings.

    Reuses render() (which fills every slot) and discards the bytes, so callers
    get the same constraint errors and truncation warnings a real render would,
    without a download or a LibreOffice preview.
    """
    try:
        _bytes, warnings = render(deck_spec, template)
    except RenderRejected as e:
        return {"errors": [err.to_dict() for err in e.errors], "warnings": []}
    return {"errors": [], "warnings": warnings}
```

- [ ] **Step 4: Add the MCP tool to `mcp_server.py`**

Change the render import to include `dry_run`:

```python
from .render import RenderRejected, dry_run, render
```

Add the module-level helper (next to `tool_render_deck`):

```python
def tool_validate_deck(storage: Storage, template_id: str, deck_spec: dict) -> dict:
    return dry_run(deck_spec, storage.load(template_id))
```

Register the tool inside `build_server`, next to `render_deck`:

```python
    @mcp.tool()
    def validate_deck(template_id: str, deck_spec: dict) -> dict:
        """Dry-run validate a deck: returns {errors, warnings} without rendering output."""
        return tool_validate_deck(storage, template_id, deck_spec)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_render.py -k dry_run tests/test_mcp_server.py -k validate_deck -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/src/pptx_mcp/render.py engine/src/pptx_mcp/mcp_server.py engine/tests/test_render.py engine/tests/test_mcp_server.py
git commit -m "feat(engine): dry_run validate (errors+warnings, no output) + validate_deck MCP tool"
```

---

### Task 2: geometry in `get_schema`

**Files:**
- Modify: `engine/src/pptx_mcp/schema.py`
- Test: `engine/tests/test_schema.py` (append)

**Interfaces:**
- Consumes: `find_shape` (raises `KeyError`), `_first_font_pt`, `estimate_max_chars`, `DEFAULT_FONT_PT`, `Presentation`.
- Produces: each slot dict in `get_schema` output gains `"geometry": {width_emu, height_emu, font_pt, capacity_chars} | None`.

- [ ] **Step 1: Write the failing test**

Reuse the fixture the existing `test_schema.py` tests use (`load_template(sample_template_dir)` or equivalent — read the file first and copy its setup). Add:

```python
# Append to engine/tests/test_schema.py
def test_schema_includes_geometry_for_text_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    schema = get_schema(tpl)
    # Find any text slot across slide types.
    text_slot = next(
        s for st in schema["slide_types"] for s in st["slots"] if s["type"] == "text"
    )
    g = text_slot["geometry"]
    assert g is not None
    assert g["width_emu"] > 0 and g["height_emu"] > 0
    assert g["font_pt"] is not None
    assert g["capacity_chars"] is not None and g["capacity_chars"] > 0


def test_schema_geometry_null_font_for_non_text_slot(sample_template_dir):
    tpl = load_template(sample_template_dir)
    schema = get_schema(tpl)
    non_text = [
        s for st in schema["slide_types"] for s in st["slots"] if s["type"] != "text"
    ]
    for s in non_text:
        g = s["geometry"]
        # Non-text slots still report box dims, but font/capacity are null.
        if g is not None:
            assert g["font_pt"] is None
            assert g["capacity_chars"] is None
```

(If the sample template has no non-text slot, the second test's loop is simply empty and passes — that is acceptable; do not fabricate a slot.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_schema.py -k geometry -v`
Expected: FAIL — `KeyError: 'geometry'`

- [ ] **Step 3: Rewrite `schema.py` to add geometry**

Replace the contents of `engine/src/pptx_mcp/schema.py` with:

```python
from dataclasses import asdict

from pptx import Presentation

from .assembler import find_shape
from .autodetect import DEFAULT_FONT_PT, _first_font_pt, estimate_max_chars
from .models import Template


def _slot_dict(slot) -> dict:
    return {
        "id": slot.id, "name": slot.name, "type": slot.type,
        "required": slot.required, "default": slot.default,
        "constraints": {k: v for k, v in asdict(slot.constraints).items() if v is not None},
    }


def _slot_geometry(slide, slot) -> dict | None:
    try:
        shape = find_shape(slide, slot.shape_id)
    except KeyError:
        return None
    w, h = int(shape.width or 0), int(shape.height or 0)
    font_pt = capacity = None
    if slot.type == "text":
        font_pt = _first_font_pt(shape) or DEFAULT_FONT_PT
        capacity, _ = estimate_max_chars(w, h, font_pt)
    return {"width_emu": w, "height_emu": h,
            "font_pt": font_pt, "capacity_chars": capacity}


def get_schema(template: Template) -> dict:
    prs = Presentation(template.pptx_path)
    slide_types = []
    for st in template.slide_types:
        slide = prs.slides[st.source_slide_index]
        slots = [{**_slot_dict(s), "geometry": _slot_geometry(slide, s)} for s in st.slots]
        slide_types.append({
            "id": st.id, "name": st.name, "description": st.description,
            "slots": slots,
        })
    return {
        "id": template.id, "name": template.name, "description": template.description,
        "slide_types": slide_types,
    }
```

- [ ] **Step 4: Run the geometry tests, then the schema suite**

Run: `cd "d:/Project Website/pptx-mcp/engine" && python -m pytest tests/test_schema.py -v`
Expected: PASS (geometry tests + existing schema tests; existing tests that assert on `id/name/type/constraints` still pass — those keys are unchanged, `geometry` is additive)

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/schema.py engine/tests/test_schema.py
git commit -m "feat(engine): get_schema exposes per-slot geometry (dims, font, capacity)"
```

---

### Task 3: engine-service `POST /validate-deck`

**Files:**
- Modify: `engine-service/app.py`
- Test: `engine-service/tests/test_endpoints.py` (append)

**Interfaces:**
- Consumes: engine `dry_run` (Task 1); existing `load_from_bytes`, `os`, `json`, `JSONResponse`.
- Produces: `POST /validate-deck` (form `file`, `manifest`, `deck_spec`) → 200 JSON `{errors, warnings}`.

- [ ] **Step 1: Write the failing test**

Mirror the existing `/render-deck` tests' `_files(...)` helper and `sample_manifest`/deck fixtures in `test_endpoints.py` (read the file first; copy the exact fixture names and deck-spec construction). Add:

```python
# Append to engine-service/tests/test_endpoints.py
def test_validate_deck_ok(sample_template_dir, sample_manifest):
    # Reuse the SAME valid deck_spec the test_render_deck_ok test posts.
    deck_spec = <copy the valid deck_spec from test_render_deck_ok>
    r = client.post("/validate-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest),
                          "deck_spec": json.dumps(deck_spec)})
    assert r.status_code == 200
    body = r.json()
    assert "errors" in body and "warnings" in body
    assert body["errors"] == []


def test_validate_deck_reports_errors(sample_template_dir, sample_manifest):
    # An invalid deck (unknown slide_type) -> 200 with errors in the body.
    r = client.post("/validate-deck", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest),
                          "deck_spec": json.dumps({"slides": [{"slide_type": "nope", "slots": {}}]})})
    assert r.status_code == 200
    assert len(r.json()["errors"]) >= 1
```

Replace `<copy the valid deck_spec from test_render_deck_ok>` with the literal deck spec that test uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/engine-service" && python -m pytest tests/test_endpoints.py -k validate_deck -v`
Expected: FAIL — 404 (route not defined)

- [ ] **Step 3: Add the route**

Add `dry_run` to the render import in `app.py`:

```python
from pptx_mcp.render import RenderRejected, dry_run, render
```

Add the route (place it next to `/render-deck`):

```python
@app.post("/validate-deck")
async def validate_deck_route(file: UploadFile = File(...),
                              manifest: str = Form(...), deck_spec: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        result = dry_run(json.loads(deck_spec), tpl)
    finally:
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass
    return JSONResponse(content=result)
```

- [ ] **Step 4: Run the test, then the endpoint suite**

Run: `cd "d:/Project Website/pptx-mcp/engine-service" && python -m pytest tests/test_endpoints.py -v`
Expected: PASS (new validate-deck tests + existing endpoints)

- [ ] **Step 5: Commit**

```bash
git add engine-service/app.py engine-service/tests/test_endpoints.py
git commit -m "feat(engine-service): POST /validate-deck returns errors+warnings without rendering"
```

---

### Task 4: web `validateDeck` client + validate routes

**Files:**
- Modify: `web/src/lib/engine.ts` (add `validateDeck`)
- Create: `web/src/app/api/templates/[id]/validate/route.ts` (session auth)
- Create: `web/src/app/api/mcp/templates/[id]/validate/route.ts` (api-key auth)
- Test: `web/tests/engine.test.ts` (append), `web/tests/validate-api.test.ts` (create)

**Interfaces:**
- Consumes: engine-service `/validate-deck` (Task 3); `form`, `BASE`, `EngineError` (in `engine.ts`); `auth`/`requireApiKey`, `prisma`, `getObject`.
- Produces: `validateDeck(pptx, manifest, deckSpec) -> Promise<{errors:any[], warnings:any[]}>`; two POST routes returning that JSON.

- [ ] **Step 1: Write the failing tests**

Append to `web/tests/engine.test.ts`:

```typescript
  it("validateDeck returns errors+warnings", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ errors: [{ code: "missing_required_slot" }], warnings: [] }),
      { status: 200, headers: { "content-type": "application/json" } }));
    const { validateDeck } = await import("@/lib/engine");
    const out = await validateDeck(Buffer.from("x"), {}, {});
    expect(out.errors[0].code).toBe("missing_required_slot");
    expect(out.warnings).toEqual([]);
  });
```

Create `web/tests/validate-api.test.ts` (mirror `web/tests/move-shape-api.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { template: { findUnique: vi.fn() } } }));
vi.mock("@/lib/s3", () => ({ getObject: vi.fn(async () => Buffer.from("PK")) }));
vi.mock("@/lib/engine", () => ({
  validateDeck: vi.fn(async () => ({ errors: [], warnings: [{ code: "text_truncated" }] })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/templates/[id]/validate/route";

beforeEach(() => vi.clearAllMocks());
const ctx = { params: Promise.resolve({ id: "t1" }) };
const body = (o: object) => new Request("http://x", { method: "POST", body: JSON.stringify(o) });

describe("validate api (session)", () => {
  it("401 when unauthenticated", async () => {
    (auth as any).mockResolvedValue(null);
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(401);
  });

  it("403 for non-owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "other" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: {} });
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(403);
  });

  it("returns errors+warnings for owner", async () => {
    (auth as any).mockResolvedValue({ user: { id: "u1" } });
    (prisma.template.findUnique as any).mockResolvedValue({ id: "t1", ownerId: "u1", basePptxKey: "k", manifestJson: {} });
    const r = await POST(body({ deck_spec: { slides: [] } }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.warnings[0].code).toBe("text_truncated");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/engine.test.ts tests/validate-api.test.ts`
Expected: FAIL — `validateDeck` not exported / cannot resolve `validate/route`

- [ ] **Step 3: Add `validateDeck` to `engine.ts`**

Append to `web/src/lib/engine.ts`:

```typescript
export async function validateDeck(pptx: Buffer, manifest: unknown, deckSpec: unknown):
  Promise<{ errors: any[]; warnings: any[] }> {
  const r = await fetch(`${BASE}/validate-deck`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest), deck_spec: JSON.stringify(deckSpec) }),
  });
  if (!r.ok) throw new EngineError("validate-deck failed");
  return r.json();
}
```

- [ ] **Step 4: Create the session route**

Create `web/src/app/api/templates/[id]/validate/route.ts`:

```typescript
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { validateDeck } from "@/lib/engine";

// Owner-only, session-authenticated dry-run validate. Returns {errors, warnings}
// without rendering output. Mirrors /api/mcp/templates/[id]/validate.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl) return Response.json({ error: "not found" }, { status: 404 });
  if (tpl.ownerId !== session.user.id) return Response.json({ error: "forbidden" }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const { deck_spec } = body ?? {};
  const base = await getObject(tpl.basePptxKey);
  const out = await validateDeck(base, tpl.manifestJson, deck_spec);
  return Response.json(out);
}
```

- [ ] **Step 5: Create the api-key route**

Create `web/src/app/api/mcp/templates/[id]/validate/route.ts`:

```typescript
import { requireApiKey } from "@/lib/mcpAuth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { validateDeck } from "@/lib/engine";

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
  const { deck_spec } = body ?? {};
  const base = await getObject(tpl.basePptxKey);
  const out = await validateDeck(base, tpl.manifestJson, deck_spec);
  return Response.json(out);
}
```

- [ ] **Step 6: Run the web tests, then tsc + the suite**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/engine.test.ts tests/validate-api.test.ts`
Expected: PASS

Then: `cd "d:/Project Website/pptx-mcp/web" && npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; full vitest suite green.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/engine.ts "web/src/app/api/templates/[id]/validate/route.ts" "web/src/app/api/mcp/templates/[id]/validate/route.ts" web/tests/engine.test.ts web/tests/validate-api.test.ts
git commit -m "feat(web): validateDeck client + /validate routes (session + api-key)"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (errors+warnings dry-fill) → Task 1 `dry_run` reuses `render`.
- Decision 2 (reuse render) → Task 1.
- Decision 3 (MCP tool + web endpoint) → Task 1 (MCP), Task 3 (engine-service), Task 4 (web routes ×2).
- Decision 4 (geometry computed at schema time, no model change) → Task 2.
- Decision 5 (fields width/height/font/capacity, text-only font+capacity) → Task 2 `_slot_geometry`.
- Components 1-6 → Task 1 (1,2), Task 3 (3), Task 4 (4,5), Task 2 (6).
- Testing section → engine (Tasks 1,2), engine-service (Task 3), web (Task 4: client + route incl. 401/403/200).

**Placeholder scan:** The `<existing storage fixture>` / `<copy the valid deck_spec ...>` markers are explicit "copy from the named existing test" instructions for fixture-specific data the implementer must read from the actual test files — not vague TODOs. Every code block that defines production code is complete.

**Type consistency:** `dry_run(dict, Template) -> dict {errors, warnings}` consumed identically by `tool_validate_deck`, engine-service route, and (via `validateDeck`) the web routes. `validateDeck` returns `{errors, warnings}`; routes return it verbatim. `_slot_geometry -> dict|None` with the exact field set in the global constraints. `_first_font_pt`/`estimate_max_chars`/`DEFAULT_FONT_PT` reused, not redefined.

**Corrected from spec draft:** spec referenced a new `_shape_font_pt`; the existing `_first_font_pt(shape)` in `autodetect.py` is reused instead.
