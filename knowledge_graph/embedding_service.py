"""
Local inference microservice for Stage 1d (docs/adr/0013-stage1d-image-embedding-evidence.md).

Loads DINOv2-Large + CLIP once at startup and serves embeddings for a single
submission image over localhost HTTP, so the TypeScript pipeline (Node) can get a
query vector at request time without shelling out to Python per call. The model
loading and embedding-extraction logic (load_models/embed_dinov2/embed_clip_image)
is copied — not imported — from bm_embed_images.py: that module calls
_require_env() for four NEO4J_* vars at import time, which would make this
service refuse to start over unrelated env vars it has no use for. Zero Neo4j
coupling here; this process only ever talks to whatever calls it over HTTP.

Run (see knowledge_graph/README.md "Running the embedding service"):
    knowledge_graph/venv-embeddings/bin/uvicorn embedding_service:app \
        --app-dir knowledge_graph --host 127.0.0.1 --port 8008

Binds 127.0.0.1 only — there is no auth layer, so this must never be reachable
off-box.
"""

import base64
import io
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel

DINOV2_MODEL_NAME = "facebook/dinov2-large"
DINOV2_DIM = 1024
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"
CLIP_DIM = 512


def load_models():
    import torch  # noqa: F401 — imported lazily so a bare import of this module stays cheap
    from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

    dino_processor = AutoImageProcessor.from_pretrained(DINOV2_MODEL_NAME)
    dino_model = AutoModel.from_pretrained(DINOV2_MODEL_NAME)
    dino_model.eval()

    clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    clip_model.eval()

    return dino_processor, dino_model, clip_processor, clip_model


def embed_dinov2(processor, model, image):
    import torch
    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        outputs = model(**inputs)
    return outputs.last_hidden_state[:, 0, :].squeeze(0).tolist()


def embed_clip_image(processor, model, image):
    import torch
    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        features = model.get_image_features(**inputs)
    return features.squeeze(0).tolist()


_models: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    dino_processor, dino_model, clip_processor, clip_model = load_models()
    _models["dino_processor"] = dino_processor
    _models["dino_model"] = dino_model
    _models["clip_processor"] = clip_processor
    _models["clip_model"] = clip_model
    yield
    _models.clear()


app = FastAPI(lifespan=lifespan)


class EmbedRequest(BaseModel):
    imageBase64: str
    mimeType: Optional[str] = None  # informational only — Image.open sniffs format from bytes


@app.get("/health")
def health():
    if not _models:
        return JSONResponse(status_code=503, content={"status": "loading"})
    return {"status": "ok", "models": {"dinov2": DINOV2_MODEL_NAME, "clip": CLIP_MODEL_NAME}}


@app.post("/embed")
def embed(req: EmbedRequest):
    try:
        raw = base64.b64decode(req.imageBase64)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not decode imageBase64: {e}")

    if not _models:
        raise HTTPException(status_code=503, detail="models still loading")

    dinov2_vector = embed_dinov2(_models["dino_processor"], _models["dino_model"], image)
    clip_vector = embed_clip_image(_models["clip_processor"], _models["clip_model"], image)

    return {
        "dinov2": {"model": DINOV2_MODEL_NAME, "dim": DINOV2_DIM, "vector": dinov2_vector},
        "clip": {"model": CLIP_MODEL_NAME, "dim": CLIP_DIM, "vector": clip_vector},
    }
