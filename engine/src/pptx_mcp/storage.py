import secrets
from pathlib import Path

from .models import Template
from .template import load_template


class Storage:
    def __init__(self, templates_dir, output_dir):
        self.templates_dir = Path(templates_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._tokens: dict[str, Path] = {}

    def list_template_ids(self) -> list[str]:
        if not self.templates_dir.exists():
            return []
        return sorted(
            p.name for p in self.templates_dir.iterdir()
            if p.is_dir() and (p / "manifest.json").exists()
        )

    def load(self, template_id: str) -> Template:
        # NOTE: template_id is trusted here (comes from list_template_ids); the phase-2 web layer MUST guard against path traversal before calling this.
        return load_template(self.templates_dir / template_id)

    def put_output(self, data: bytes, suffix: str) -> str:
        token = secrets.token_urlsafe(16)
        path = self.output_dir / f"{token}{suffix}"
        path.write_bytes(data)
        self._tokens[token] = path
        return token

    def path_for(self, token: str):
        return self._tokens.get(token)
