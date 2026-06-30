# Preview Timeout Robustness — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** Theme E of the VAPT-feedback sprint. Addresses feedback #8
(preview can hang / times out with no useful signal). Feedback #5 (agenda
dynamic numbering) was de-scoped — the agenda number boxes are static
decoration, not slots, so renumbering them is heuristic and low-value; deferred
pending a concrete failing example.

## Goal

Make preview generation fail fast and cleanly when LibreOffice hangs, instead of
blocking the worker forever and dying as an opaque upstream HTTP timeout. Every
preview caller should get the same graceful `{previews: [], note: ...}` signal it
already gets when LibreOffice is absent.

## Background

`preview(pptx_bytes) -> list[bytes]` (`engine/src/pptx_mcp/preview.py`) shells out
twice with **no timeout**:

```
subprocess.run([_SOFFICE, "--headless", "--convert-to", "pdf", ...],
               check=True, capture_output=True)          # can hang forever
...
subprocess.run(_pdftoppm_cmd(...), check=True, capture_output=True)  # can hang
```

If `soffice` hangs (profile lock, font probe, a pathological deck — common in
practice), the call never returns: the engine-service worker is stuck and the
caller's HTTP connection eventually dies with no structured error.

Three callers reach `preview`, and **all three already** have a graceful note
path for "LibreOffice not available":

- `engine-service/app.py` `/render-base-previews` (line 41): `preview(data)`;
  not-available → `{"previews": [], "note": "LibreOffice not available"}`.
- `engine-service/app.py` `/render-preview` (line 97): `preview(out)`;
  not-available → `{"validation": [], "previews": [], "note": "LibreOffice not available"}`.
- `engine/src/pptx_mcp/mcp_server.py` `tool_render_preview` (line 50): loops over
  `preview(data)`; not-available → `{"validation": [], "previews": [], "note": "LibreOffice not available"}`.

The web layer relays the engine-service JSON verbatim (`engine.ts` returns
`r.json()` for `renderBasePreviews`/`renderPreview`; the web preview routes pass
it through), so a `note` field already flows to the editor UI unchanged.

## Decisions

1. **Bound both subprocesses with a timeout and convert a hang into a clean
   exception** rather than a watchdog thread (overkill for a subprocess) or
   letting it surface as a 500 (opaque to the UI/agent). `subprocess.run`
   already kills the child process on `TimeoutExpired`.
2. **A dedicated `PreviewTimeout(RuntimeError)`** so callers can distinguish a
   timeout from other `RuntimeError`s (e.g. the "soffice not found" raise) and
   map it to the existing graceful note shape.
3. **Reuse the existing `{previews: [], note: ...}` shape** with
   `note: "preview timed out"` in all three callers — no new response contract,
   no web change.
4. **Env-overridable timeout constants** with generous defaults:
   `_SOFFICE_TIMEOUT_S` (default 60 — soffice cold start can be 10-20s) and
   `_PDFTOPPM_TIMEOUT_S` (default 30 — pdftoppm is fast). Overridable via
   `PPTX_SOFFICE_TIMEOUT_S` / `PPTX_PDFTOPPM_TIMEOUT_S` for ops tuning.

## Components

### 1. `engine/src/pptx_mcp/preview.py` — timeouts + `PreviewTimeout`

Add `import os`, a `PreviewTimeout` class, the two timeout constants, and a
`timeout=` on each `subprocess.run`, converting `TimeoutExpired`:

```
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
                return [pdf.read_bytes()]
            subprocess.run(
                _pdftoppm_cmd(_PDFTOPPM, pdf, tmp / "page"),
                check=True, capture_output=True, timeout=_PDFTOPPM_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            raise PreviewTimeout(str(e)) from e
        return [p.read_bytes() for p in sorted(tmp.glob("page*.png"))]
```

`libreoffice_available()` and `_pdftoppm_cmd(...)` are unchanged. The `return`
for the PNG read stays inside the `with` (after the `try`), unchanged.

### 2. `engine-service/app.py` — both preview routes catch `PreviewTimeout`

Import `PreviewTimeout` alongside `preview`, and wrap each `preview(...)` call:

`/render-base-previews`:

```
    try:
        pngs = preview(data)
    except PreviewTimeout:
        return {"previews": [], "note": "preview timed out"}
    return {"previews": [base64.b64encode(p).decode() for p in pngs]}
```

`/render-preview` (inside its existing `try/finally` temp-cleanup block):

```
        try:
            pngs = preview(out)
        except PreviewTimeout:
            return {"validation": [], "previews": [], "note": "preview timed out"}
        return {"validation": [], "previews": [base64.b64encode(p).decode() for p in pngs]}
```

The `finally` that unlinks the temp `.pptx` still runs on the timeout return.

### 3. `engine/src/pptx_mcp/mcp_server.py` — `tool_render_preview` catches it

Import `PreviewTimeout` from `.preview` (already imported there), and guard the
preview loop:

```
    if not libreoffice_available():
        return {"validation": [], "previews": [], "note": "LibreOffice not available"}
    urls = []
    try:
        for png in preview(data):
            token = storage.put_output(png, ".png")
            urls.append(f"{base_url}/files/{token}")
    except PreviewTimeout:
        return {"validation": [], "previews": [], "note": "preview timed out"}
    return {"validation": [], "previews": urls}
```

(If the timeout fires mid-loop, any `put_output` PNGs already stored are
harmless orphans in output storage; the caller gets an empty `previews` with the
note. Acceptable — a timed-out preview produces no usable deck preview anyway.)

## Data flow

```
caller -> preview(bytes)
  soffice convert (timeout 60s) -> TimeoutExpired -> raise PreviewTimeout
  pdftoppm (timeout 30s)        -> TimeoutExpired -> raise PreviewTimeout

engine-service /render-base-previews | /render-preview
  except PreviewTimeout -> {previews: [], note: "preview timed out"} (HTTP 200)
  -> web engine.ts r.json() -> web preview route -> editor (shows note)

MCP tool_render_preview
  except PreviewTimeout -> {validation: [], previews: [], note: "preview timed out"}
```

## Error handling / edges

- **soffice hang:** `TimeoutExpired` at 60s → `PreviewTimeout` → graceful note;
  the child soffice process is killed by `subprocess.run`.
- **pdftoppm hang:** same at 30s.
- **soffice missing:** unchanged — `preview` still raises the plain
  `RuntimeError`, but callers gate on `libreoffice_available()` first, so this
  path is not normally reached.
- **Timeout mid-`tool_render_preview` loop:** partial PNGs already stored are
  orphaned (no cleanup added — out of scope); caller still gets `previews: []`
  + note.
- **Back-compat:** the success path is byte-for-byte unchanged; only a hang now
  produces a structured note instead of blocking. Existing
  `test_preview.py` cases (real soffice, when present) are unaffected.

## Security

- No new network surface, no new input, no auth change. The timeouts only bound
  existing local subprocesses; bounding them strictly reduces the
  denial-of-service surface (a malicious deck can no longer pin a worker
  indefinitely).

## Testing

- **engine `preview`:** monkeypatch `pptx_mcp.preview._SOFFICE` to a dummy path
  (so `libreoffice_available()` is True) and `subprocess.run` to raise
  `subprocess.TimeoutExpired(cmd, timeout)` → `preview(b"x")` raises
  `PreviewTimeout`. A second test asserts `subprocess.run` is called with a
  `timeout=` kwarg (capture the call kwargs).
- **engine-service:** monkeypatch the route module's `preview` to raise
  `PreviewTimeout` → `POST /render-base-previews` returns 200 with
  `{"previews": [], "note": "preview timed out"}`; `POST /render-preview`
  (valid deck) returns 200 with `{"validation": [], "previews": [], "note": "preview timed out"}`
  and the temp file is still cleaned up.
- **engine `tool_render_preview`:** monkeypatch `preview` to raise
  `PreviewTimeout` → the tool returns `{"validation": [], "previews": [], "note": "preview timed out"}`
  (no exception escapes).
- **Regression:** existing `test_preview.py` (skipped when soffice is absent)
  stays green; the success path is unchanged.

## Out of scope

- Agenda dynamic numbering (#5) — de-scoped (heuristic, low-value; deferred).
- Cleaning up orphaned output PNGs on a mid-loop MCP timeout.
- Async/threaded preview generation or a job queue (the timeout makes the
  synchronous path safe enough; a queue is a separate scaling concern).
- Aligning the web/Next fetch timeout (Node `fetch` has no default timeout; the
  engine-service now returns a fast structured note, so no upstream change is
  needed).
