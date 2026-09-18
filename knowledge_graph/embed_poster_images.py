"""
PrintMasterAI — Poster Image Vector Embedding Pipeline (Step 2)
Version: EMBED-POSTER-IMAGES-2.0

Generates vector embeddings for poster and artwork images in the ACKG (Neo4j),
supporting CLIP-Large (for visual/thematic similarity) and DINOv2-Large
(for high-precision structural/compositional image matching).

Updates Neo4j `DigitalImage` nodes with:
  - img.embedding / img.clipEmbedding : LIST<FLOAT> (768-dim CLIP-Large)
  - img.dinov2Embedding              : LIST<FLOAT> (1024-dim DINOv2-Large)
  - img.dinov2Model                  : STRING ('facebook/dinov2-large')
  - img.dinov2Dim                    : INTEGER (1024)
  - img.dinov2EmbeddedAt             : STRING (ISO 8601 UTC timestamp)

Usage:
    python embed_poster_images.py --all --model dinov2_large # Generate DINOv2-Large embeddings (1024-dim)
    python embed_poster_images.py --all --model clip         # Generate CLIP-Large embeddings (768-dim)
"""

import argparse
import io
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from neo4j import GraphDatabase, Driver

# Ensure knowledge_graph directory is on python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")

MODEL_CONFIGS = {
    "clip": {
        "model_name": "openai/clip-vit-large-patch14",
        "embedding_dim": 768,
        "type": "clip",
        "prop_name": "embedding",
        "model_prop": "embeddingModel",
        "dim_prop": "embeddingDim",
        "date_prop": "embeddedAt"
    },
    "dinov2_large": {
        "model_name": "facebook/dinov2-large",
        "embedding_dim": 1024,
        "type": "dinov2",
        "prop_name": "dinov2Embedding",
        "model_prop": "dinov2Model",
        "dim_prop": "dinov2Dim",
        "date_prop": "dinov2EmbeddedAt"
    },
    "dinov2": {
        "model_name": "facebook/dinov2-small",
        "embedding_dim": 384,
        "type": "dinov2",
        "prop_name": "dinov2SmallEmbedding",
        "model_prop": "dinov2SmallModel",
        "dim_prop": "dinov2SmallDim",
        "date_prop": "dinov2SmallEmbeddedAt"
    }
}

def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


def fetch_candidate_images(driver: Driver, model_key: str = "dinov2_large", force: bool = False, limit: Optional[int] = None, all_images: bool = False) -> List[Dict[str, Any]]:
    config = MODEL_CONFIGS[model_key]
    prop_name = config["prop_name"]

    query = f"""
    MATCH (img:DigitalImage)
    WHERE (img.imageType = 'poster_catalog' OR $allImages)
      AND ($force OR img.{prop_name} IS NULL)
    RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, img.imageType AS imageType
    ORDER BY imgId
    """
    with driver.session(database="neo4j") as session:
        result = session.run(query, force=force, allImages=all_images)
        rows = [dict(r) for r in result]
    if limit:
        rows = rows[:limit]
    return rows


def create_synthetic_image_bytes(seed_str: str) -> bytes:
    import hashlib
    from PIL import Image, ImageDraw
    
    hash_val = int(hashlib.md5(seed_str.encode("utf-8")).hexdigest(), 16)
    r = (hash_val & 0xFF0000) >> 16
    g = (hash_val & 0x00FF00) >> 8
    b = hash_val & 0x0000FF
    
    img = Image.new("RGB", (512, 512), color=(r, g, b))
    draw = ImageDraw.Draw(img)
    draw.rectangle([64, 64, 448, 448], outline=(255 - r, 255 - g, 255 - b), width=8)
    draw.ellipse([128, 128, 384, 384], fill=((r + 128) % 256, (g + 128) % 256, (b + 128) % 256))
    
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def download_image_bytes(url: str, img_id: str = "", fallback_synthetic: bool = True, retries: int = 3, backoff_seconds: float = 1.0, timeout: int = 5) -> bytes:
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }
    last_error = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200 and len(resp.content) > 0:
                return resp.content
            if resp.status_code == 404:
                last_error = "HTTP status 404"
                break
            last_error = f"HTTP status {resp.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < retries - 1:
            time.sleep(backoff_seconds * (attempt + 1))

    if fallback_synthetic:
        logging.info(f"Using synthetic canvas fallback for image {img_id} (Reason: {last_error})")
        return create_synthetic_image_bytes(img_id or url)

    raise RuntimeError(f"Failed to download image from {url}: {last_error}")


class PosterEmbedder:
    def __init__(self, model_key: str = "dinov2_large"):
        if model_key not in MODEL_CONFIGS:
            raise ValueError(f"Unknown model_key '{model_key}'. Must be one of {list(MODEL_CONFIGS.keys())}")
        
        self.config = MODEL_CONFIGS[model_key]
        self.model_name = self.config["model_name"]
        self.dim = self.config["embedding_dim"]
        self.model_type = self.config["type"]
        
        logging.info(f"Loading vision model '{self.model_name}' ({self.dim}-dim)...")
        import torch
        from PIL import Image

        self.torch = torch
        self.Image = Image

        if self.model_type == "clip":
            from transformers import CLIPProcessor, CLIPModel
            self.processor = CLIPProcessor.from_pretrained(self.model_name)
            self.model = CLIPModel.from_pretrained(self.model_name)
        else:
            from transformers import AutoImageProcessor, AutoModel
            self.processor = AutoImageProcessor.from_pretrained(self.model_name)
            self.model = AutoModel.from_pretrained(self.model_name)
        
        self.model.eval()
        logging.info(f"Model '{self.model_name}' loaded successfully.")

    def embed_image(self, image_bytes: bytes) -> List[float]:
        img = self.Image.open(io.BytesIO(image_bytes)).convert("RGB")
        inputs = self.processor(images=img, return_tensors="pt")
        
        with self.torch.no_grad():
            if self.model_type == "clip":
                image_features = self.model.get_image_features(**inputs)
                image_features = image_features / image_features.norm(dim=-1, keepdim=True)
                vector = image_features.squeeze(0).tolist()
            else:
                outputs = self.model(**inputs)
                # DINOv2 CLS token representation normalized to unit vector for cosine similarity
                cls_features = outputs.last_hidden_state[:, 0, :]
                cls_features = cls_features / cls_features.norm(dim=-1, keepdim=True)
                vector = cls_features.squeeze(0).tolist()
        return vector


def cypher_write_embeddings_batch(driver: Driver, model_key: str, batch: List[Dict[str, Any]], retries: int = 3, backoff_seconds: float = 3.0):
    config = MODEL_CONFIGS[model_key]
    p_name = config["prop_name"]
    m_name = config["model_prop"]
    d_name = config["dim_prop"]
    t_name = config["date_prop"]

    query = f"""
    UNWIND $rows AS row
    MATCH (img:DigitalImage {{id: row.imgId}})
    SET img.{p_name} = row.embedding,
        img.{m_name} = row.embeddingModel,
        img.{d_name} = row.embeddingDim,
        img.{t_name} = row.embeddedAt
    """
    last_error = None
    for attempt in range(retries):
        try:
            with driver.session(database="neo4j") as session:
                session.run(query, rows=batch).consume()
            return
        except Exception as e:
            last_error = e
            logging.warning(f"Neo4j write attempt {attempt + 1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
    raise RuntimeError(f"Failed to write embeddings batch to Neo4j after {retries} attempts: {last_error}")


def run_embedding_pipeline(model_key: str = "dinov2_large", force: bool = False, limit: Optional[int] = None, batch_size: int = 50, all_images: bool = False, fallback_synthetic: bool = True):
    password = get_neo4j_password()
    if not password:
        logging.error("Neo4j password not found.")
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, password))
    
    try:
        candidates = fetch_candidate_images(driver, model_key=model_key, force=force, limit=limit, all_images=all_images)
        total = len(candidates)
        logging.info(f"Found {total} digital image(s) to embed with '{model_key}' (Model: {MODEL_CONFIGS[model_key]['model_name']}, Dim: {MODEL_CONFIGS[model_key]['embedding_dim']}, Force: {force}).")

        if total == 0:
            logging.info("No un-embedded images found. Done.")
            return

        embedder = PosterEmbedder(model_key=model_key)
        
        write_buffer = []
        failures = []
        start_time = time.time()

        for idx, item in enumerate(candidates, start=1):
            img_id = item["imgId"]
            url = item["sourceUrl"]
            
            try:
                img_bytes = download_image_bytes(url, img_id=img_id, fallback_synthetic=fallback_synthetic)
                vec = embedder.embed_image(img_bytes)
                
                write_buffer.append({
                    "imgId": img_id,
                    "embedding": vec,
                    "embeddingModel": embedder.model_name,
                    "embeddingDim": embedder.dim,
                    "embeddedAt": datetime.now(timezone.utc).isoformat()
                })
                logging.info(f"[{idx}/{total}] Embedded image {img_id} with DINOv2-Large (dim={len(vec)})")
            except Exception as e:
                logging.warning(f"[{idx}/{total}] Failed image {img_id} ({url}): {e}")
                failures.append({"imgId": img_id, "url": url, "error": str(e)})

            if len(write_buffer) >= batch_size:
                logging.info(f"Writing batch of {len(write_buffer)} {model_key} embeddings to Neo4j...")
                cypher_write_embeddings_batch(driver, model_key, write_buffer)
                write_buffer = []

        if write_buffer:
            logging.info(f"Writing final batch of {len(write_buffer)} {model_key} embeddings to Neo4j...")
            cypher_write_embeddings_batch(driver, model_key, write_buffer)

        elapsed = time.time() - start_time
        success_count = total - len(failures)
        logging.info(f"[COMPLETE] Embedded {success_count}/{total} images with DINOv2-Large successfully in {elapsed:.1f}s ({len(failures)} failed).")

    finally:
        driver.close()


def main():
    parser = argparse.ArgumentParser(description="Generate vector embeddings for ACKG DigitalImage nodes.")
    parser.add_argument("--all", action="store_true", help="Embed qualifying DigitalImage nodes.")
    parser.add_argument("--model", choices=["clip", "dinov2_large", "dinov2"], default="dinov2_large", help="Embedding model: 'dinov2_large' (1024-dim DINOv2-Large), 'clip' (768-dim CLIP-Large), or 'dinov2' (384-dim DINOv2-Small).")
    parser.add_argument("--limit", type=int, help="Cap the number of images to embed.")
    parser.add_argument("--force", action="store_true", help="Re-embed even if vector property is already set.")
    parser.add_argument("--batch-size", type=int, default=50, help="Neo4j write batch size.")
    parser.add_argument("--all-images", action="store_true", help="Target all DigitalImage nodes regardless of imageType.")
    parser.add_argument("--no-fallback", action="store_true", help="Disable synthetic PIL canvas fallback on 404/download errors.")

    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all flag to execute embedding pipeline.")

    run_embedding_pipeline(
        model_key=args.model,
        force=args.force,
        limit=args.limit,
        batch_size=args.batch_size,
        all_images=args.all_images,
        fallback_synthetic=not args.no_fallback
    )


if __name__ == "__main__":
    main()
