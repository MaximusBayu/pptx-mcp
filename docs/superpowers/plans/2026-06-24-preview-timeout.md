# Preview Timeout Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the preview subprocesses with a timeout so a LibreOffice hang fails fast as a graceful `{previews: [], note: "preview timed out"}` instead of blocking the worker forever.

**Architecture:** Engine-only. `preview()` gains a `timeout=` on both `subprocess.run` calls and converts `subprocess.TimeoutExpired` into a new `PreviewTimeout` exception. The three callers (engine-service `/render-base-previews`, engine-service `/render-preview`, MCP `tool_render_preview`) each catch `PreviewTimeout` and return the same note shape they already return for "LibreOffice not available". No web change — the `note` field already passes through `engine.ts`/the web routes.

**Tech Stack:** Python 3, `subprocess`, FastAPI (engine-service), pytest + `fastapi.testclient`.

## Global Constraints

- Bound BOTH subprocesses: `_SOFFICE_TIMEOUT_S` (default 60, env `PPTX_SOFFICE_TIMEOUT_S`) and `_PDFTOPPM_TIMEOUT_S` (default 30, env `PPTX_PDFTOPPM_TIMEOUT_S`). (spec Decision 4)
- A timeout raises `PreviewTimeout(RuntimeError)` — distinct from the existing "soffice not found" `RuntimeError`. (spec Decision 2)
- Every caller maps `PreviewTimeout` to the existing note shape with the exact string `note: "preview timed out"`, HTTP 200 / no raise. (spec Decision 3)
- The success path stays byte-for-byte unchanged; existing `test_preview.py` (skipped without soffice) stays green.
- No web change, no new response contract, no new network surface.

---

### Task 1: `PreviewTimeout` + subprocess timeouts in `preview.py`

**Files:**
- Modify: `engine/src/pptx_mcp/preview.py` (add `import os`; add `_SOFFICE_TIMEOUT_S`/`_PDFTOPPM_TIMEOUT_S`; add `PreviewTimeout`; add `timeout=` + `try/except TimeoutExpired` in `preview`)
- Test: `engine/tests/test_preview.py`

**Interfaces:**
- Consumes: existing `preview(pptx_bytes) -> list[bytes]`, `libreoffice_available()`, `_SOFFICE`, `_PDFTOPPM`, `_pdftoppm_cmd(...)`.
- Produces: `class PreviewTimeout(RuntimeError)`; `preview()` raises `PreviewTimeout` when either subprocess exceeds its timeout; both `subprocess.run` calls pass a `timeout=` kwarg.

- [ ] **Step 1: Write the failing tests**

Append to `engine/tests/test_preview.py`:

```python
import subprocess
import pptx_mcp.preview as preview_mod
from pptx_mcp.preview import PreviewTimeout


def test_preview_raises_previewtimeout_on_soffice_timeout(monkeypatch):
    # Make libreoffice_available() True without a real binary.
    monkeypatch.setattr(preview_mod, "_SOFFICE", "/usr/bin/soffice")

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr(preview_mod.subprocess, "run", fake_run)
    with pytest.raises(PreviewTimeout):
        preview_mod.preview(b"not-a-real-pptx")


def test_preview_passes_timeout_kwarg_to_subprocess(monkeypatch):
    monkeypatch.setattr(preview_mod, "_SOFFICE", "/usr/bin/soffice")
    calls = []

    def recording_run(*args, **kwargs):
        calls.append(kwargs)
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout"))

    monkeypatch.setattr(preview_mod.subprocess, "run", recording_run)
    with pytest.raises(PreviewTimeout):
        preview_mod.preview(b"x")
    assert calls and "timeout" in calls[0]
    assert calls[0]["timeout"] == preview_mod._SOFFICE_TIMEOUT_S
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_preview.py::test_preview_raises_previewtimeout_on_soffice_timeout tests/test_preview.py::test_preview_passes_timeout_kwarg_to_subprocess -v`
Expected: FAIL — `ImportError: cannot import name 'PreviewTimeout'` (the class does not exist yet).

- [ ] **Step 3: Implement the timeouts and `PreviewTimeout`**

Rewrite `engine/src/pptx_mcp/preview.py` to:

```python
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

_SOFFICE = shutil.which("soffice") or shutil.which("libreoffice")
_PDFTOPPM = shutil.which("pdftoppm")

_SOFFICE_TIMEOUT_S = int(os.environ.get("PPTX_SOFFICE_TIMEOUT_S", "60"))
_PDFTOPPM_TIMEOUT_S = int(os.environ.get("PPTX_PDFTOPPM_TIMEOUT_S", "30"))


class PreviewTimeout(RuntimeError):
    """Raised when a preview subprocess (soffice / pdftoppm) exceeds its timeout."""


def libreoffice_available() -> bool:
    return _SOFFICE is not None


def _pdftoppm_cmd(binary, pdf_path, out_prefix) -> list:
    # -r 100: ~100 DPI is plenty for the small editor canvas; keeps the
    # render fast and the PNGs small (upload-perf spec).
    return [binary, "-png", "-r", "100", str(pdf_path), str(out_prefix)]


def preview(pptx_bytes: bytes) -> list[bytes]:
    if not libreoffice_available():
        raise RuntimeError("LibreOffice (soffice) not found on PATH")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "deck.pptx"
        src.write_bytes(pptx_bytes)
        try:
            subprocess.run(
                [_SOFFICE, "--headless", "--convert-to", "pdf", "--outdir", str(tmp), str(src)],
                check=True, capture_output=True, timeout=_SOFFICE_TIMEOUT_S,
            )
            pdf = tmp / "deck.pdf"
            if _PDFTOPPM is None:
                return [pdf.read_bytes()]  # fallback: single PDF "page"
            subprocess.run(
                _pdftoppm_cmd(_PDFTOPPM, pdf, tmp / "page"),
                check=True, capture_output=True, timeout=_PDFTOPPM_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            raise PreviewTimeout(str(e)) from e
        return [p.read_bytes() for p in sorted(tmp.glob("page*.png"))]
```

(`libreoffice_available` and `_pdftoppm_cmd` keep their existing bodies; the only
logic change is the two `timeout=` kwargs and the `try/except`. The
`return [pdf.read_bytes()]` fallback stays inside the `try` as shown.)

- [ ] **Step 4: Run to verify the new tests pass**

Run: `cd engine && python -m pytest tests/test_preview.py -v`
Expected: PASS — the two new tests pass; the pre-existing `test_libreoffice_available_is_bool`, `test_pdftoppm_cmd_sets_100_dpi`, and (when soffice present) `test_preview_returns_png` stay green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/preview.py engine/tests/test_preview.py
git commit -m "feat(engine): bound preview subprocesses with timeouts; raise PreviewTimeout on hang"
```

---

### Task 2: engine-service preview routes catch `PreviewTimeout`

**Files:**
- Modify: `engine-service/app.py` (import `PreviewTimeout`; wrap `preview(...)` in `/render-base-previews` line ~41 and `/render-preview` line ~97)
- Test: `engine-service/tests/test_endpoints.py`

**Interfaces:**
- Consumes: `PreviewTimeout` from `pptx_mcp.preview` (Task 1); the existing `preview`/`libreoffice_available` module-level imports in `app.py`.
- Produces: `/render-base-previews` returns `{"previews": [], "note": "preview timed out"}` on timeout; `/render-preview` returns `{"validation": [], "previews": [], "note": "preview timed out"}` on timeout; both HTTP 200.

- [ ] **Step 1: Write the failing tests**

Append to `engine-service/tests/test_endpoints.py`:

```python
def test_render_base_previews_timeout_returns_note(sample_template_dir, monkeypatch):
    import app as app_mod
    from pptx_mcp.preview import PreviewTimeout
    monkeypatch.setattr(app_mod, "libreoffice_available", lambda: True)
    def boom(_data):
        raise PreviewTimeout("soffice timed out")
    monkeypatch.setattr(app_mod, "preview", boom)
    r = client.post("/render-base-previews", files=_files(sample_template_dir))
    assert r.status_code == 200
    assert r.json() == {"previews": [], "note": "preview timed out"}


def test_render_preview_timeout_returns_note(sample_template_dir, sample_manifest, monkeypatch):
    import app as app_mod
    from pptx_mcp.preview import PreviewTimeout
    monkeypatch.setattr(app_mod, "libreoffice_available", lambda: True)
    def boom(_data):
        raise PreviewTimeout("soffice timed out")
    monkeypatch.setattr(app_mod, "preview", boom)
    deck = {"slides": [{"slide_type": "title", "slots": {"title": "Hi", "subtitle": "Yo"}}]}
    r = client.post("/render-preview", files=_files(sample_template_dir),
                    data={"manifest": json.dumps(sample_manifest), "deck_spec": json.dumps(deck)})
    assert r.status_code == 200
    assert r.json() == {"validation": [], "previews": [], "note": "preview timed out"}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py::test_render_base_previews_timeout_returns_note tests/test_endpoints.py::test_render_preview_timeout_returns_note -v`
Expected: FAIL — the routes do not catch `PreviewTimeout`, so the exception propagates and `TestClient` re-raises it (the request errors instead of returning the note JSON).

- [ ] **Step 3: Import `PreviewTimeout` and wrap both routes**

In `engine-service/app.py`, add `PreviewTimeout` to the preview import. The line is currently:

```python
from pptx_mcp.preview import libreoffice_available, preview
```

Change it to:

```python
from pptx_mcp.preview import PreviewTimeout, libreoffice_available, preview
```

In `/render-base-previews`, replace lines 41-42:

```python
    pngs = preview(data)  # previews of the base file as-is
    return {"previews": [base64.b64encode(p).decode() for p in pngs]}
```

with:

```python
    try:
        pngs = preview(data)  # previews of the base file as-is
    except PreviewTimeout:
        return {"previews": [], "note": "preview timed out"}
    return {"previews": [base64.b64encode(p).decode() for p in pngs]}
```

In `/render-preview`, replace lines 97-98:

```python
        pngs = preview(out)
        return {"validation": [], "previews": [base64.b64encode(p).decode() for p in pngs]}
```

with:

```python
        try:
            pngs = preview(out)
        except PreviewTimeout:
            return {"validation": [], "previews": [], "note": "preview timed out"}
        return {"validation": [], "previews": [base64.b64encode(p).decode() for p in pngs]}
```

(The `/render-preview` change stays inside the existing `try/finally`; the
`finally` that unlinks the temp `.pptx` still runs on the early return.)

- [ ] **Step 4: Run to verify the new tests pass**

Run: `cd engine-service && python -m pytest tests/test_endpoints.py -v`
Expected: PASS — the two timeout tests pass; the pre-existing endpoint tests stay green.

- [ ] **Step 5: Commit**

```bash
git add engine-service/app.py engine-service/tests/test_endpoints.py
git commit -m "feat(engine-service): preview routes return graceful note on PreviewTimeout"
```

---

### Task 3: MCP `tool_render_preview` catches `PreviewTimeout`

**Files:**
- Modify: `engine/src/pptx_mcp/mcp_server.py` (`tool_render_preview` — import `PreviewTimeout`, wrap the preview loop)
- Test: `engine/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `PreviewTimeout` from `.preview` (Task 1); existing `tool_render_preview(storage, base_url, template_id, deck_spec) -> dict`.
- Produces: `tool_render_preview` returns `{"validation": [], "previews": [], "note": "preview timed out"}` when `preview` raises `PreviewTimeout`, with no exception escaping.

- [ ] **Step 1: Write the failing test**

Append to `engine/tests/test_mcp_server.py` (the file already imports from `pptx_mcp.mcp_server`; this test imports `tool_render_preview` locally inside the test):

```python
def test_tool_render_preview_timeout_returns_note(storage, monkeypatch):
    import pptx_mcp.preview as preview_mod
    from pptx_mcp.preview import PreviewTimeout
    from pptx_mcp.mcp_server import tool_render_preview
    monkeypatch.setattr(preview_mod, "libreoffice_available", lambda: True)
    def boom(_data):
        raise PreviewTimeout("soffice timed out")
    monkeypatch.setattr(preview_mod, "preview", boom)
    out = tool_render_preview(storage, "http://x", "sample", _deck())
    assert out == {"validation": [], "previews": [], "note": "preview timed out"}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd engine && python -m pytest tests/test_mcp_server.py::test_tool_render_preview_timeout_returns_note -v`
Expected: FAIL — `tool_render_preview` does not catch `PreviewTimeout`, so the exception propagates out of the call.

- [ ] **Step 3: Import `PreviewTimeout` and guard the loop**

In `engine/src/pptx_mcp/mcp_server.py`, the `tool_render_preview` function imports its preview deps locally:

```python
    from .preview import libreoffice_available, preview
```

Change that line to add `PreviewTimeout`:

```python
    from .preview import PreviewTimeout, libreoffice_available, preview
```

Then replace the preview loop (currently):

```python
    urls = []
    for png in preview(data):
        token = storage.put_output(png, ".png")
        urls.append(f"{base_url}/files/{token}")
    return {"validation": [], "previews": urls}
```

with:

```python
    urls = []
    try:
        for png in preview(data):
            token = storage.put_output(png, ".png")
            urls.append(f"{base_url}/files/{token}")
    except PreviewTimeout:
        return {"validation": [], "previews": [], "note": "preview timed out"}
    return {"validation": [], "previews": urls}
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd engine && python -m pytest tests/test_mcp_server.py -v`
Expected: PASS — the new timeout test passes; the pre-existing mcp_server tests stay green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pptx_mcp/mcp_server.py engine/tests/test_mcp_server.py
git commit -m "feat(engine): MCP tool_render_preview returns graceful note on PreviewTimeout"
```

---

### Task 4: Whole-suite regression gate

**Files:** none (verification only — no source change, no commit unless a regression surfaces).

**Interfaces:**
- Consumes: the engine and engine-service test suites.
- Produces: confirmation that Tasks 1-3 broke nothing.

- [ ] **Step 1: Run the engine suite**

Run: `cd engine && python -m pytest -q`
Expected: all pass (1 pre-existing skip — `test_preview_returns_png` when soffice absent — is fine).

- [ ] **Step 2: Run the engine-service suite**

Run: `cd engine-service && python -m pytest -q`
Expected: all pass.

- [ ] **Step 3: If anything fails, fix and commit; otherwise report green**

If a regression appears, fix it minimally (consistent with the spec), re-run the affected file, then `git add`/`git commit` with a `fix(engine):` or `fix(engine-service):` message. If both suites are green, no commit is needed — report the pass counts.

---

## Self-Review

**Spec coverage:**
- `PreviewTimeout` + bounded subprocesses → Task 1. ✓
- engine-service `/render-base-previews` + `/render-preview` graceful note → Task 2. ✓
- MCP `tool_render_preview` graceful note → Task 3. ✓
- Env-overridable timeout constants (60/30, `PPTX_SOFFICE_TIMEOUT_S`/`PPTX_PDFTOPPM_TIMEOUT_S`) → Task 1 code + asserted in Task 1 test. ✓
- "No web change" → respected; no task touches `web/`. ✓
- Regression (success path unchanged, existing tests green) → Task 4. ✓

**Placeholder scan:** none — every code step shows full code; every run step shows the exact command and expected result.

**Type consistency:** `PreviewTimeout` spelled identically across preview.py, both engine-service routes, the MCP tool, and all tests. The note string `"preview timed out"` is identical in all three callers and all assertions. Constant names `_SOFFICE_TIMEOUT_S`/`_PDFTOPPM_TIMEOUT_S` and env vars `PPTX_SOFFICE_TIMEOUT_S`/`PPTX_PDFTOPPM_TIMEOUT_S` match the spec. The Task 1 test asserts `calls[0]["timeout"] == preview_mod._SOFFICE_TIMEOUT_S`, consistent with the soffice call being first.
