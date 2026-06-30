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
