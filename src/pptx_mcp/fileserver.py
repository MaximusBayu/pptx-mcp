from fastapi import FastAPI, HTTPException
from fastapi.responses import Response

from .storage import Storage

_MIME = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png",
    ".pdf": "application/pdf",
}


def create_app(storage: Storage) -> FastAPI:
    app = FastAPI()

    @app.get("/files/{token}")
    def get_file(token: str):
        path = storage.path_for(token)
        if path is None or not path.exists():
            raise HTTPException(status_code=404, detail="not found")
        media = _MIME.get(path.suffix, "application/octet-stream")
        return Response(content=path.read_bytes(), media_type=media)

    return app
