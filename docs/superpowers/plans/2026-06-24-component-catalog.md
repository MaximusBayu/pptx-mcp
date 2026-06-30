# Component Catalog (Recompose R1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a read-only inventory of every template component (slots, pictures, decor) — with stable id, type, geometry, style, and fillable flag — to the agent over MCP and to a human on a web page.

**Architecture:** A new engine module `catalog.py` computes the catalog from the stored pptx. It is surfaced three ways: an MCP tool (`get_template_components`), an engine-service route (`POST /catalog`), and a server-rendered web page that calls the route via `getCatalog` in `lib/engine.ts`. Additive and read-only — `get_schema`, render, and existing tools/routes are untouched.

**Tech Stack:** Python 3, python-pptx (engine); FastAPI (engine-service); Next.js App Router, React, Tailwind, vitest (web).

## Global Constraints

- Stable component id is exactly `"{slide_index}:{shape_id}"`. (spec Decision 4)
- A shape is `fillable` iff `(source_slide_index, shape_id)` matches a manifest slot; its `slot_id` is that slot's id, else `null`. (spec Background / `get_catalog`)
- Style is **best-effort**: `font_name`, `font_pt`, `font_color`, `fill_color`, each `null` when theme-inherited or unreadable — never raise. (spec Decision 5)
- Full inventory: every shape on every slide, including decor. (spec Decision 1)
- Read-only everywhere: no rendering, no template mutation, no new write surface. (spec Security)
- Web page auth mirrors the Use page: owner-only, else "Not found". (spec Component 5)
- `get_catalog` reads from `template.pptx_path` (like `get_schema`); engine-service `/catalog` uses `load_from_bytes` + temp unlink in `finally` (like `/validate-deck`). (spec Components)

---

### Task 1: engine `catalog.py` + MCP tool

**Files:**
- Create: `engine/src/pptx_mcp/catalog.py`
- Modify: `engine/src/pptx_mcp/mcp_server.py` (import `get_catalog`; add `tool_get_template_components`; register `get_template_components` in `build_server`)
- Test: `engine/tests/test_catalog.py` (new), `engine/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `Template` (`.pptx_path`, `.slide_types[].source_slide_index`, `.slots[].shape_id/.id`); `Storage.load(template_id)`; the MCP wiring pattern (`tool_get_template_schema` → `get_schema(storage.load(id))`).
- Produces: `get_catalog(template) -> dict` with `{"id","name","description","components":[...]}`; `_component_dict(shp, slide_index, sw, sh, slot_id) -> dict`; `_shape_style(shp) -> dict`; `tool_get_template_components(storage, template_id) -> dict`; MCP tool `get_template_components`.

- [ ] **Step 1: Write the failing engine tests**

Create `engine/tests/test_catalog.py`:

```python
from pptx_mcp.template import load_template
from pptx_mcp.catalog import get_catalog, _component_dict, _shape_style


def test_catalog_lists_all_components(sample_template_dir):
    tpl = load_template(sample_template_dir)
    cat = get_catalog(tpl)
    assert cat["id"] == "sample"
    comps = cat["components"]
    assert len(comps) >= 4  # at least one shape per sample slide
    # the title-slide title shape is a fillable slot
    title = next(c for c in comps if c["slot_id"] == "title")
    assert title["fillable"] is True
    assert title["component_id"] == f"{title['source_slide']}:" + title["component_id"].split(":")[1]
    g = title["geometry"]
    assert set(g["bbox_pct"]) == {"x", "y", "w", "h"}
    assert g["width_emu"] > 0 and g["height_emu"] > 0


def test_catalog_marks_types(sample_template_dir):
    tpl = load_template(sample_template_dir)
    comps = get_catalog(tpl)["components"]
    assert any(c["type"] == "table" for c in comps)   # slide 2 table
    assert any(c["type"] == "image" for c in comps)   # slide 3 picture


def test_component_dict_fillable_flag():
    class _Shp:
        shape_id = 7; name = "Box"; left = 0; top = 0; width = 100; height = 50
        shape_type = None; has_table = False; has_text_frame = False
    decor = _component_dict(_Shp(), 1, 1000, 1000, None)
    assert decor["fillable"] is False and decor["slot_id"] is None
    assert decor["component_id"] == "1:7"
    slot = _component_dict(_Shp(), 0, 1000, 1000, "title")
    assert slot["fillable"] is True and slot["slot_id"] == "title"


def test_shape_style_best_effort_no_crash():
    class _NoText:
        has_text_frame = False
        @property
        def fill(self):  # a fill whose fore_color has no rgb
            raise ValueError("no fill")
    style = _shape_style(_NoText())
    assert style == {"font_name": None, "font_pt": None,
                     "font_color": None, "fill_color": None}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pptx_mcp.catalog'`.

- [ ] **Step 3: Create `catalog.py`**

Create `engine/src/pptx_mcp/catalog.py`:

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

_TEXT_SAMPLE_MAX = 200


def _component_type(shp) -> str:
    if getattr(shp, "has_table", False):
        return "table"
    if shp.shape_type == MSO_SHAPE_TYPE.PICTURE:
        return "image"
    if getattr(shp, "has_text_frame", False):
        return "text"
    return "other"


def _pct(value, total) -> float:
    return round(min(100.0, max(0.0, 100.0 * value / total)), 3) if total else 0.0


def _sample_text(shp) -> str:
    if not getattr(shp, "has_text_frame", False):
        return ""
    t = (shp.text_frame.text or "").strip()
    return t[: _TEXT_SAMPLE_MAX - 1] + "…" if len(t) > _TEXT_SAMPLE_MAX else t


def _hex_or_none(color):
    # color.rgb raises (TypeError/AttributeError) for theme/inherited colors.
    try:
        if color is not None and color.type is not None:
            return str(color.rgb)
    except (TypeError, AttributeError):
        pass
    return None


def _shape_style(shp) -> dict:
    style = {"font_name": None, "font_pt": None, "font_color": None, "fill_color": None}
    if getattr(shp, "has_text_frame", False):
        paras = shp.text_frame.paragraphs
        runs = paras[0].runs if paras else []
        if runs:
            f = runs[0].font
            style["font_name"] = f.name
            style["font_pt"] = f.size.pt if f.size is not None else None
            style["font_color"] = _hex_or_none(f.color)
    try:
        fill = shp.fill
        if fill.type is not None:
            style["fill_color"] = _hex_or_none(fill.fore_color)
    except (TypeError, AttributeError, ValueError):
        pass
    return style


def _component_dict(shp, slide_index, sw, sh, slot_id) -> dict:
    x = shp.left or 0
    y = shp.top or 0
    w = shp.width or 0
    h = shp.height or 0
    return {
        "component_id": f"{slide_index}:{shp.shape_id}",
        "source_slide": slide_index,
        "type": _component_type(shp),
        "fillable": slot_id is not None,
        "slot_id": slot_id,
        "name": shp.name or "",
        "geometry": {
            "bbox_pct": {"x": _pct(x, sw), "y": _pct(y, sh),
                         "w": _pct(w, sw), "h": _pct(h, sh)},
            "width_emu": int(w), "height_emu": int(h),
        },
        "style": _shape_style(shp),
        "text": _sample_text(shp),
    }


def get_catalog(template) -> dict:
    prs = Presentation(template.pptx_path)
    sw, sh = prs.slide_width, prs.slide_height
    fillable = {(st.source_slide_index, s.shape_id): s.id
                for st in template.slide_types for s in st.slots}
    components = []
    for i, slide in enumerate(prs.slides):
        for shp in slide.shapes:
            slot_id = fillable.get((i, shp.shape_id))
            components.append(_component_dict(shp, i, sw, sh, slot_id))
    return {"id": template.id, "name": template.name,
            "description": template.description, "components": components}
```

- [ ] **Step 4: Run the catalog tests to verify they pass**

Run: `cd engine && python -m pytest tests/test_catalog.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Write the failing MCP-tool test**

Append to `engine/tests/test_mcp_server.py` (add `tool_get_template_components` to the `pptx_mcp.mcp_server` import at the top of the file):

```python
def test_tool_get_template_components(storage):
    from pptx_mcp.mcp_server import tool_get_template_components
    cat = tool_get_template_components(storage, "sample")
    assert cat["id"] == "sample"
    assert isinstance(cat["components"], list) and cat["components"]
    assert all("component_id" in c and "fillable" in c for c in cat["components"])
```

- [ ] **Step 6: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_mcp_server.py::test_tool_get_template_components -v`
Expected: FAIL — `ImportError: cannot import name 'tool_get_template_components'`.

- [ ] **Step 7: Wire the MCP tool**

In `engine/src/pptx_mcp/mcp_server.py`, add the import near the other engine imports at the top:

```python
from .catalog import get_catalog
```

Add the tool function next to `tool_get_template_schema`:

```python
def tool_get_template_components(storage: Storage, template_id: str) -> dict:
    return get_catalog(storage.load(template_id))
```

Register it inside `build_server`, next to `get_template_schema`:

```python
    @mcp.tool()
    def get_template_components(template_id: str) -> dict:
        """List every reusable component (slots, pictures, decor) in a template,
        with geometry and style — the kit for composing slides."""
        return tool_get_template_components(storage, template_id)
```

- [ ] **Step 8: Run to verify the MCP test passes**

Run: `cd engine && python -m pytest tests/test_mcp_server.py tests/test_catalog.py -v`
Expected: PASS (all).

- [ ] **Step 9: Commit**

```bash
git add engine/src/pptx_mcp/catalog.py engine/src/pptx_mcp/mcp_server.py engine/tests/test_catalog.py engine/tests/test_mcp_server.py
git commit -m "feat(engine): component catalog + get_template_components MCP tool (Recompose R1)"
```

---

### Task 2: engine-service `POST /catalog`

**Files:**
- Modify: `engine-service/app.py` (import `get_catalog`; add the `/catalog` route)
- Test: `engine-service/tests/test_endpoints.py`

**Interfaces:**
- Consumes: `get_catalog` (Task 1); `load_from_bytes(data, manifest)`; the `/validate-deck` route pattern (form `file` + `manifest`, JSON out, temp unlink in `finally`).
- Produces: `POST /catalog` returning `{"id","name","description","components":[...]}` as JSON, HTTP 200.

- [ ] **Step 1: Write the failing test**

Append to `engine-service/tests/test_endpoints.py`:

```python
def test_catalog_endpoint(sample_template_dir, sample_manifest):
    r = client.post("/catalog", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest)})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "sample"
    assert isinstance(body["components"], list) and body["components"]
    assert all("component_id" in c for c in body["components"])
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py::test_catalog_endpoint -v`
Expected: FAIL — 404 (route does not exist yet).

- [ ] **Step 3: Add the route**

In `engine-service/app.py`, add the import alongside the other `pptx_mcp` imports:

```python
from pptx_mcp.catalog import get_catalog
```

Add the route (mirror `/validate-deck`):

```python
@app.post("/catalog")
async def catalog_route(file: UploadFile = File(...), manifest: str = Form(...)):
    data = await file.read()
    tpl = None
    try:
        tpl = load_from_bytes(data, json.loads(manifest))
        result = get_catalog(tpl)
    finally:
        if tpl is not None:
            try:
                os.unlink(tpl.pptx_path)
            except OSError:
                pass
    return JSONResponse(content=result)
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py -v`
Expected: PASS (all endpoint tests, including `test_catalog_endpoint`).

- [ ] **Step 5: Commit**

```bash
git add engine-service/app.py engine-service/tests/test_endpoints.py
git commit -m "feat(engine-service): POST /catalog returns the template component catalog (R1)"
```

---

### Task 3: web `getCatalog` in `lib/engine.ts`

**Files:**
- Modify: `web/src/lib/engine.ts` (add `getCatalog`)
- Test: `web/tests/engine.test.ts`

**Interfaces:**
- Consumes: the existing `form(pptx, extra)` helper and `EngineError`; the `validateDeck` shape (`file` + `manifest`, returns `r.json()`).
- Produces: `getCatalog(pptx, manifest) -> Promise<{ id; name; description; components: any[] }>`.

- [ ] **Step 1: Write the failing test**

Append a case inside the `describe("engine client", ...)` block in `web/tests/engine.test.ts`:

```typescript
  it("getCatalog posts file+manifest and returns components", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ id: "t", name: "T", description: "", components: [{ component_id: "0:5" }] }),
      { status: 200, headers: { "content-type": "application/json" } }));
    const { getCatalog } = await import("@/lib/engine");
    const out = await getCatalog(Buffer.from("x"), {});
    expect(out.components[0].component_id).toBe("0:5");
    expect((fetchMock.mock.calls[0][0] as string)).toContain("/catalog");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run tests/engine.test.ts -t getCatalog`
Expected: FAIL — `getCatalog` is not exported from `@/lib/engine`.

- [ ] **Step 3: Add `getCatalog`**

In `web/src/lib/engine.ts`, add (next to `validateDeck`):

```typescript
export async function getCatalog(pptx: Buffer, manifest: unknown):
  Promise<{ id: string; name: string; description: string; components: any[] }> {
  const r = await fetch(`${BASE}/catalog`, {
    method: "POST",
    body: form(pptx, { manifest: JSON.stringify(manifest) }),
  });
  if (!r.ok) throw new EngineError("catalog failed");
  return r.json();
}
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd web && npx vitest run tests/engine.test.ts`
Expected: PASS (all engine-client tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/engine.ts web/tests/engine.test.ts
git commit -m "feat(web): getCatalog engine client for the component catalog (R1)"
```

---

### Task 4: web components page + `ComponentsClient` + nav link

**Files:**
- Create: `web/src/app/(app)/templates/[id]/components/page.tsx`
- Create: `web/src/app/(app)/templates/[id]/components/ComponentsClient.tsx`
- Modify: `web/src/app/(app)/templates/[id]/use/UseClient.tsx` (add the nav link)
- Test: `web/tests/componentsclient.test.tsx` (new)

**Interfaces:**
- Consumes: `auth`, `prisma`, `getObject` (`@/lib/s3`), `getCatalog` (Task 3); the Use page's auth/owner guard pattern.
- Produces: the server page (owner-only) and `ComponentsClient({ name, components })` display component.

- [ ] **Step 1: Write the failing `ComponentsClient` test**

Create `web/tests/componentsclient.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ComponentsClient } from "@/app/(app)/templates/[id]/components/ComponentsClient";

const comps = [
  { component_id: "0:5", source_slide: 0, type: "text", fillable: true, slot_id: "title",
    name: "Title", text: "Hello",
    geometry: { bbox_pct: { x: 1, y: 1, w: 80, h: 10 }, width_emu: 100, height_emu: 50 },
    style: { font_name: "Arial", font_pt: 32, font_color: "FF0000", fill_color: null } },
  { component_id: "0:9", source_slide: 0, type: "other", fillable: false, slot_id: null,
    name: "Decor Bar", text: "",
    geometry: { bbox_pct: { x: 0, y: 90, w: 100, h: 4 }, width_emu: 10, height_emu: 2 },
    style: { font_name: null, font_pt: null, font_color: null, fill_color: "112233" } },
];

describe("ComponentsClient", () => {
  it("renders fillable slot and decor components", () => {
    render(<ComponentsClient name="Deck" components={comps} />);
    expect(screen.getByText("Slot: title")).toBeInTheDocument();
    expect(screen.getByText("Decor")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Decor Bar")).toBeInTheDocument();
    expect(screen.getByText(/Arial @ 32/)).toBeInTheDocument();
  });

  it("groups by source slide", () => {
    render(<ComponentsClient name="Deck" components={comps} />);
    expect(screen.getByText(/Slide 1/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run tests/componentsclient.test.tsx`
Expected: FAIL — cannot resolve `ComponentsClient` (module does not exist).

- [ ] **Step 3: Create `ComponentsClient.tsx`**

Create `web/src/app/(app)/templates/[id]/components/ComponentsClient.tsx`:

```tsx
"use client";

type Comp = {
  component_id: string; source_slide: number; type: string;
  fillable: boolean; slot_id: string | null; name: string; text: string;
  geometry: { bbox_pct: { x: number; y: number; w: number; h: number };
              width_emu: number; height_emu: number };
  style: { font_name: string | null; font_pt: number | null;
           font_color: string | null; fill_color: string | null };
};

function Swatch({ hex }: { hex: string | null }) {
  if (!hex) return null;
  return <span className="inline-block w-3 h-3 rounded-sm border border-gray-300 align-middle"
               style={{ backgroundColor: `#${hex}` }} title={`#${hex}`} />;
}

function Card({ c }: { c: Comp }) {
  const g = c.geometry.bbox_pct;
  const typeLabel = c.type === "other" ? "decor" : c.type;
  return (
    <div className="border border-gray-200 rounded-md p-3 space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-xs">{typeLabel}</span>
        <span className={`px-1.5 py-0.5 rounded text-xs ${c.fillable ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>
          {c.fillable ? `Slot: ${c.slot_id}` : "Decor"}
        </span>
        <span className="font-medium">{c.name || c.component_id}</span>
      </div>
      {c.text && <div className="text-gray-600 line-clamp-2">{c.text}</div>}
      <div className="text-gray-500 text-xs">
        {g.x}/{g.y} · {g.w}×{g.h} (bbox %)
      </div>
      <div className="text-gray-500 text-xs flex items-center gap-2">
        {c.style.font_name && <span>{c.style.font_name} @ {c.style.font_pt ?? "?"}</span>}
        <Swatch hex={c.style.font_color} />
        <Swatch hex={c.style.fill_color} />
      </div>
    </div>
  );
}

export function ComponentsClient({ name, components }: { name: string; components: Comp[] }) {
  const bySlide = new Map<number, Comp[]>();
  for (const c of components) {
    const arr = bySlide.get(c.source_slide) ?? [];
    arr.push(c);
    bySlide.set(c.source_slide, arr);
  }
  const slides = [...bySlide.keys()].sort((a, b) => a - b);
  return (
    <div className="p-8 max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Components — {name}</h1>
      {slides.map((s) => (
        <div key={s} className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-500">Slide {s + 1}</h2>
          <div className="grid gap-2">
            {bySlide.get(s)!.map((c) => <Card key={c.component_id} c={c} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd web && npx vitest run tests/componentsclient.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 5: Create the server page**

Create `web/src/app/(app)/templates/[id]/components/page.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/s3";
import { getCatalog } from "@/lib/engine";
import { ComponentsClient } from "./ComponentsClient";

export const dynamic = "force-dynamic";

export default async function ComponentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const tpl = await prisma.template.findUnique({ where: { id } });
  if (!tpl || tpl.ownerId !== session?.user?.id) return <div className="p-8">Not found</div>;
  const base = await getObject(tpl.basePptxKey);
  const catalog = await getCatalog(base, tpl.manifestJson);
  return <ComponentsClient name={tpl.name} components={catalog.components} />;
}
```

- [ ] **Step 6: Add the nav link in `UseClient.tsx`**

In `web/src/app/(app)/templates/[id]/use/UseClient.tsx`, the header is:

```tsx
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Use “{name}”</h1>
```

Add a link beside the `<h1>` (inside that flex container, after the `</h1>`):

```tsx
          <a href={`/templates/${id}/components`} className="text-sm text-blue-600 hover:underline">
            Components
          </a>
```

- [ ] **Step 7: Verify the build typechecks**

Run: `cd web && npx tsc --noEmit`
Expected: exit 0 (no type errors). The page and client compile; the nav-link edit is type-clean.

- [ ] **Step 8: Commit**

```bash
git add "web/src/app/(app)/templates/[id]/components/page.tsx" "web/src/app/(app)/templates/[id]/components/ComponentsClient.tsx" "web/src/app/(app)/templates/[id]/use/UseClient.tsx" web/tests/componentsclient.test.tsx
git commit -m "feat(web): component catalog page + nav link (Recompose R1)"
```

---

### Task 5: Whole-stack regression gate

**Files:** none (verification only — no source change, no commit unless a regression surfaces).

**Interfaces:**
- Consumes: the engine, engine-service, and web test suites + the web typecheck.
- Produces: confirmation that Tasks 1-4 broke nothing.

- [ ] **Step 1: Run the engine suite**

Run: `cd engine && python -m pytest -q`
Expected: all pass (1 pre-existing skip is fine).

- [ ] **Step 2: Run the engine-service suite**

Run: `cd engine-service && python -m pytest -q`
Expected: all pass.

- [ ] **Step 3: Run the web suite + typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all vitest pass; tsc exit 0.

- [ ] **Step 4: If anything fails, fix and commit; otherwise report green**

If a regression appears, fix it minimally (consistent with the spec), re-run the affected suite, then `git add`/`git commit` with a `fix(...)` message. If all green, no commit — report the pass counts.

---

## Self-Review

**Spec coverage:**
- `catalog.py` (`get_catalog`, `_component_dict`, `_shape_style`, types/geometry/fillable/style) → Task 1. ✓
- MCP `get_template_components` → Task 1. ✓
- engine-service `POST /catalog` → Task 2. ✓
- web `getCatalog` → Task 3. ✓
- web server page + `ComponentsClient` (badges, geometry, style swatches, grouped by slide) + nav link → Task 4. ✓
- Spec testing list (get_catalog, _component_dict both branches, _shape_style no-crash, types, MCP tool, /catalog endpoint, getCatalog, page guard/render) → covered across Tasks 1-4; whole-stack regression → Task 5. ✓
- Out-of-scope (R2 placement/assembler, R3 guardrails, separate client JSON route, cross-slide dedup, gradient/multi-run style) → respected; no task touches them. ✓

**Placeholder scan:** none — every code step shows full code; every run step shows the exact command and expected result.

**Type consistency:** `get_catalog`/`_component_dict`/`_shape_style` signatures match across Tasks 1-2 and the spec. `component_id` format `"{slide_index}:{shape_id}"` identical in code and tests. The component dict shape (`component_id`, `source_slide`, `type`, `fillable`, `slot_id`, `name`, `geometry.bbox_pct`/`width_emu`/`height_emu`, `style.font_name`/`font_pt`/`font_color`/`fill_color`, `text`) is identical in `_component_dict`, the engine-service JSON, `getCatalog`'s return type, and the `Comp` type in `ComponentsClient`. The web `getCatalog(pptx, manifest)` signature matches its call in `page.tsx`.
