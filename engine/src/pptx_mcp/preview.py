import shutil
import subprocess
import tempfile
from pathlib import Path

_SOFFICE = shutil.which("soffice") or shutil.which("libreoffice")
_PDFTOPPM = shutil.which("pdftoppm")


def libreoffice_available() -> bool:
    return _SOFFICE is not None


def preview(pptx_bytes: bytes) -> list[bytes]:
    if not libreoffice_available():
        raise RuntimeError("LibreOffice (soffice) not found on PATH")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "deck.pptx"
        src.write_bytes(pptx_bytes)
        subprocess.run(
            [_SOFFICE, "--headless", "--convert-to", "pdf", "--outdir", str(tmp), str(src)],
            check=True, capture_output=True,
        )
        pdf = tmp / "deck.pdf"
        if _PDFTOPPM is None:
            return [pdf.read_bytes()]  # fallback: single PDF "page"
        subprocess.run(
            [_PDFTOPPM, "-png", str(pdf), str(tmp / "page")],
            check=True, capture_output=True,
        )
        return [p.read_bytes() for p in sorted(tmp.glob("page*.png"))]
