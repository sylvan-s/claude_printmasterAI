"""
PrintMasterAI — DINOv2-Large + CLIP embeddings for Tate DigitalImage nodes (ACKG Stage 2-4)
Version: EMBED-TATE-1.0

Consumes the `DigitalImage` nodes `resolve_tate_images.py` creates (Stage 1 — existence
check against the *live* tate.org.uk site, not the dead 2014 CSV thumbnailUrl). For each:
  1. Downloads the image once into a local scratch directory (a real temporary store,
     not just an in-memory buffer) so both models run against the same cached bytes
     instead of hitting Tate's CDN twice.
  2. DINOv2-Large image embedding (facebook/dinov2-large, 1024-dim) — same CLS-token
     pooling as embed_images_dinov2.py, just the Large variant per explicit request
     (that script used -small specifically for CPU speed on Roseberys/Forum's ~20k
     images; Tate's volume is smaller and DINOv2-Large was explicitly asked for here).
  3. CLIP image embedding (openai/clip-vit-base-patch32 — decided after benchmarking
     against clip-vit-large-patch14 on 10 real Tate images, 2026-09-04: Large is 11x
     slower per image (590ms vs 54ms, 428M vs 151M params) and would turn the embed
     stage's estimated ~5 minutes into ~4+ hours for the full ~11k-work run, on par
     with or exceeding the scrape stage itself. Base already proved sufficient in the
     pilot — correct zero-shot animal-content retrieval, usable similarity ranking —
     with no concrete need identified for Large's extra retrieval-benchmark quality
     at this project's scale. Revisit only if a specific downstream task needs it;
     the pipeline is idempotent (--force) so upgrading later costs nothing.)
  4. CLIP text embedding of Impression.catalogueDescription (falling back to the
     ConceptualWork title if no description was scraped; never fabricated) — CLIP's
     image and text encoders share one space, so this is what makes "together with
     catalogue descriptions" mean something (cross-modal similarity), not just two
     embeddings stored side by side.
  5. Deletes the cached file after a successful write (default) — keeps disk usage
     bounded and avoids accumulating a standing local archive of copyrighted images
     beyond what's needed to compute embeddings. --keep-cache overrides for debugging.

Field naming: DINOv2 reuses the exact same generic field names
(embedding/embeddingModel/embeddingDim/embeddedAt) the Roseberys/Forum DigitalImage
nodes already use — safe to mix 384-dim and 1024-dim vectors under one property name
since embeddingModel/embeddingDim already travel with every vector and any consumer
must branch on those before comparing. CLIP gets its own field set
(clipImageEmbedding* on DigitalImage, clipTextEmbedding* on Impression) since it's a
genuinely different model/space, not a variant of the same one.

Same isolated-venv/native-arm64 requirement as embed_images_dinov2.py — see that
script's docstring for the exact setup if venv-embeddings doesn't already exist.

Usage:
    python3 embed_tate_images.py --all
    python3 embed_tate_images.py --all --limit 50       # pilot run
    python3 embed_tate_images.py --all --force
    python3 embed_tate_images.py --all --keep-cache      # don't delete downloaded images
"""

import argparse
import json
import os
import shutil
import time
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real ACKG values (self-hosted Oracle Neo4j instance) and export "
            f"them (e.g. `set -a; source .env; set +a`) before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

DINOV2_MODEL_NAME = "facebook/dinov2-large"
DINOV2_DIM = 1024
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"
CLIP_DIM = 512

SCRATCH_DIR = "tmp_tate_images"
USER_AGENT = "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; non-commercial academic research)"

# WHERE must come directly after the primary MATCH, before either OPTIONAL MATCH — a
# WHERE placed immediately after an OPTIONAL MATCH scopes to filtering THAT pattern's
# match, not the overall row set, so a false condition there still returns the row
# (with the optional fields null) instead of excluding it. Found live 2026-09-06 while
# checking bm_embed_images.py's identically-shaped query for the same bug: with this
# query in its original form, `--all` (no `--force`) against the already-fully-embedded
# live Tate set (10,208/10,208 embedded) returned all 10,208 as candidates instead of 0
# — `--force` was effectively always-on, silently re-downloading and re-embedding
# everything on every run rather than the "idempotent, safe to re-run" behavior the
# module docstring assumes.
FETCH_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)<-[:DOCUMENTS]-(src:SourceRecord {institutionName: 'Tate'})
WHERE $force OR img.embedding IS NULL
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(imp)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, imp.id AS impId,
       imp.catalogueDescription AS description, cw.name AS title
ORDER BY imgId
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embedding = row.dinoEmbedding,
    img.embeddingModel = row.dinoModel,
    img.embeddingDim = row.dinoDim,
    img.embeddedAt = row.embeddedAt,
    img.clipImageEmbedding = row.clipImageEmbedding,
    img.clipImageEmbeddingModel = row.clipModel,
    img.clipImageEmbeddingDim = row.clipDim,
    img.clipEmbeddedAt = row.embeddedAt
WITH row
MATCH (imp:Impression {id: row.impId})
FOREACH (_ IN CASE WHEN row.clipTextEmbedding IS NOT NULL THEN [1] ELSE [] END |
    SET imp.clipTextEmbedding = row.clipTextEmbedding,
        imp.clipTextEmbeddingModel = row.clipModel,
        imp.clipTextEmbeddingDim = row.clipDim,
        imp.clipTextSource = row.textSource
)
"""

FAILURE_LOG_PATH = "embed_tate_images_failures.json"


def fetch_candidates(force=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_QUERY, force=force)
            rows = [dict(r) for r in result]
    finally:
        driver.close()
    if limit:
        rows = rows[:limit]
    return rows


def load_models():
    # Imported lazily so --help/arg errors don't pay torch's import cost.
    import torch
    from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

    dino_processor = AutoImageProcessor.from_pretrained(DINOV2_MODEL_NAME)
    dino_model = AutoModel.from_pretrained(DINOV2_MODEL_NAME)
    dino_model.eval()

    clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    clip_model.eval()

    return dino_processor, dino_model, clip_processor, clip_model


def download_to_scratch(url, dest_path, retries=3, backoff_seconds=2.0, timeout=20):
    last_error = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if r.status_code == 200:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return
            last_error = f"HTTP {r.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < retries - 1:
            time.sleep(backoff_seconds * (attempt + 1))
    raise RuntimeError(last_error)


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


def embed_clip_text(processor, model, text):
    import torch
    inputs = processor(text=[text], return_tensors="pt", truncation=True, padding=True)
    with torch.no_grad():
        features = model.get_text_features(**inputs)
    return features.squeeze(0).tolist()


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(WRITE_QUERY, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def run(candidates, chunk_size=25, keep_cache=False):
    from PIL import Image

    os.makedirs(SCRATCH_DIR, exist_ok=True)
    dino_processor, dino_model, clip_processor, clip_model = load_models()

    total = len(candidates)
    start = time.time()
    write_buffer = []
    failures = []
    text_embedded_count = 0

    for i, c in enumerate(candidates):
        dest_path = os.path.join(SCRATCH_DIR, f"{c['imgId']}.jpg")
        try:
            download_to_scratch(c["sourceUrl"], dest_path)
            image = Image.open(dest_path).convert("RGB")

            dino_vec = embed_dinov2(dino_processor, dino_model, image)
            clip_img_vec = embed_clip_image(clip_processor, clip_model, image)

            text = c.get("description") or c.get("title")
            text_source = "description" if c.get("description") else ("title" if c.get("title") else None)
            clip_text_vec = embed_clip_text(clip_processor, clip_model, text) if text else None
            if clip_text_vec:
                text_embedded_count += 1
        except Exception as e:
            failures.append({"imgId": c["imgId"], "url": c["sourceUrl"], "error": str(e)})
            print(f"[SKIP] {c['imgId']}: {e}", flush=True)
            continue
        finally:
            if not keep_cache and os.path.exists(dest_path):
                os.remove(dest_path)

        write_buffer.append({
            "imgId": c["imgId"],
            "impId": c["impId"],
            "dinoEmbedding": dino_vec,
            "dinoModel": DINOV2_MODEL_NAME,
            "dinoDim": DINOV2_DIM,
            "clipImageEmbedding": clip_img_vec,
            "clipTextEmbedding": clip_text_vec,
            "clipModel": CLIP_MODEL_NAME,
            "clipDim": CLIP_DIM,
            "textSource": text_source,
            "embeddedAt": datetime.now(timezone.utc).isoformat(),
        })
        if len(write_buffer) >= chunk_size:
            _write_chunk_with_retry(write_buffer)
            write_buffer = []

        done = i + 1
        if done % 10 == 0 or done == total:
            elapsed = time.time() - start
            print(f"[PROGRESS] {done}/{total} processed ({len(failures)} failed) "
                  f"| elapsed={elapsed:.0f}s | est_remaining={(elapsed / done) * (total - done):.0f}s",
                  flush=True)

    _write_chunk_with_retry(write_buffer)

    if not keep_cache:
        shutil.rmtree(SCRATCH_DIR, ignore_errors=True)

    embedded = total - len(failures)
    print(f"[DONE] embedded={embedded} failed={len(failures)} "
          f"text_embedded={text_embedded_count} elapsed={time.time() - start:.0f}s", flush=True)

    if failures:
        with open(FAILURE_LOG_PATH, "w") as f:
            json.dump(failures, f, indent=2)
        print(f"[DONE] {len(failures)} failures logged to {FAILURE_LOG_PATH}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Embed every qualifying Tate DigitalImage")
    parser.add_argument("--limit", type=int, help="Cap the number of images (for a test run)")
    parser.add_argument("--force", action="store_true",
                         help="Re-embed even if already set (default: skip)")
    parser.add_argument("--keep-cache", action="store_true",
                         help="Don't delete downloaded images from the scratch dir after embedding")
    parser.add_argument("--chunk-size", type=int, default=25, help="Neo4j write batch size")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --limit/--force/--keep-cache)")

    candidates = fetch_candidates(force=args.force, limit=args.limit)
    print(f"Found {len(candidates)} image(s) to embed (force={args.force})", flush=True)
    run(candidates, chunk_size=args.chunk_size, keep_cache=args.keep_cache)
