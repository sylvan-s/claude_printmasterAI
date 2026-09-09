"""
PrintMasterAI — DINOv2/CLIP embeddings for Forum Auctions DigitalImage nodes
Version: FORUM-EMBED-1.0

Same architecture and query shape as `bonhams_embed_images.py` (mirrored deliberately —
that script's design, including the embeddingFailed persistence below, was hardened
across several real incidents; see its own docstring and docs/adr/0013's 2026-09-07
amendment). Forum's own `DigitalImage` nodes already exist (forum_ingest.py's own
LOAD_QUERY creates them whenever a lot has a `primary_image_url`) — this script only
ever queries the graph for un-embedded ones and never touches the Forum JSON export.

Why this exists / current state (confirmed live before writing this, not assumed):
Forum's images were originally embedded on `facebook/dinov2-small` (384-dim, no CLIP) by
`embed_images_dinov2.py`, the shared Roseberys/Forum script from before this graph
standardized on DINOv2-Large + CLIP-Base (see docs/adr/0013 Decision 2 — Forum's old
dinov2-small vectors were deliberately stripped as part of that standardization, on the
understanding they'd be re-embedded on -large; that follow-up hadn't happened until now).
Confirmed live: 10,036 Forum Auctions DigitalImage nodes, 0 embedded.

Image access confirmed before writing this: Forum's lot images live on a public,
unauthenticated S3 bucket (`am-s3-bucket-assets.s3.eu-west-2.amazonaws.com`), not
Forum's own site — same non-browser-client-friendly CDN doc09 §3.1 already documented for
Roseberys, already resolved for Forum by forum_ingest.py's own sourceUrl rewrite before
this script ever sees it. Images are **WebP**, not JPEG — Pillow's WebP support confirmed
present in venv-embeddings (`PIL.features.check("webp")` -> True) before relying on it;
if that ever regresses, re-check `libwebp` is available wherever this venv gets rebuilt.

Pipeline, one pass per image (matches every `SHOWS`-target — an `Impression`; Forum's
own catalogue also includes non-print lots — ceramics, glass, sculpture — going by
`rawMedium` values seen live, e.g. "Stoneware with crystalline glaze"; embedding those is
harmless and consistent with how this graph already treats every catalogued object the
same way, not print-specific):
  1. Download once into a local scratch dir.
  2. DINOv2-Large embedding (facebook/dinov2-large, 1024-dim) — matches the standardized
     index (ADR-0013), not the retired -small model.
  3. CLIP image embedding (openai/clip-vit-base-patch32, 512-dim).
  4. CLIP text embedding of the target Impression's own `rawMedium`, falling back to
     `ConceptualWork.name` (the title) when `rawMedium` is null. `textSource` records
     which one was actually used.
  5. Deletes the downloaded file after a successful write (default; --keep-cache
     overrides).

Same isolated-venv/native-arm64 requirement as every other embedding script here —
reuses the existing `venv-embeddings`.

A failed image is marked `embeddingFailed` on the DigitalImage node itself, not just
logged locally, so a scheduled run (no access to a previous run's local FAILURE_LOG_PATH)
doesn't retry the same permanent failure forever. Use --retry-failures to deliberately
recheck them later.

Usage:
    python3 forum_embed_images.py --all --limit 50     # test run
    python3 forum_embed_images.py --all
    python3 forum_embed_images.py --all --force
    python3 forum_embed_images.py --all --retry-failures --limit 50   # recheck dead URLs
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
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
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

SCRATCH_DIR = "tmp_forum_images"
USER_AGENT = "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; non-commercial academic research)"

WRITE_EMBEDDING_QUERY = """
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
REMOVE img.embeddingFailed, img.embeddingFailedReason, img.embeddingFailedAt
WITH row
MATCH (target {id: row.targetId})
FOREACH (_ IN CASE WHEN row.clipTextEmbedding IS NOT NULL THEN [1] ELSE [] END |
    SET target.clipTextEmbedding = row.clipTextEmbedding,
        target.clipTextEmbeddingModel = row.clipModel,
        target.clipTextEmbeddingDim = row.clipDim,
        target.clipTextSource = row.textSource
)
"""

# Same rationale as bonhams_embed_images.py's identical query (see its own comment,
# docs/adr/0013's 2026-09-07 amendment) — persists a failed attempt onto the node itself,
# not just a local log file, so a scheduled run doesn't retry the same dead URL forever.
WRITE_FAILURE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embeddingFailed = true,
    img.embeddingFailedReason = row.error,
    img.embeddingFailedAt = row.failedAt
"""

FAILURE_LOG_PATH = "forum_embed_images_failures.json"

# WHERE must come directly after the primary MATCH, before the OPTIONAL MATCHes — see
# bonhams_embed_images.py's identical comment for the exact bug this avoids.
#
# embeddingFailed is skipped by default (a prior attempt already recorded a real error —
# most commonly a permanently dead source URL, not a transient blip) unless --retry-failures
# or --force is passed. --force bypasses both the embedding and embeddingFailed checks.
FETCH_CANDIDATES_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.institutionName = 'Forum Auctions'
  AND (
    $force
    OR (img.embedding IS NULL AND ($retryFailures OR coalesce(img.embeddingFailed, false) = false))
  )
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(target)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, target.id AS targetId,
       target.rawMedium AS description, cw.name AS title
ORDER BY imgId
"""


def fetch_candidates(force=False, retry_failures=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_CANDIDATES_QUERY, force=force, retryFailures=retry_failures)
            rows = [dict(r) for r in result]
    finally:
        driver.close()
    if limit:
        rows = rows[:limit]
    return rows


def load_models():
    import torch  # noqa: F401 — imported lazily so --help doesn't pay torch's cost
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


def _write_chunk_with_retry(rows, query=WRITE_EMBEDDING_QUERY, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(query, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def run_embeddings(candidates, chunk_size=25, keep_cache=False):
    from PIL import Image

    os.makedirs(SCRATCH_DIR, exist_ok=True)
    dino_processor, dino_model, clip_processor, clip_model = load_models()

    total = len(candidates)
    start = time.time()
    write_buffer = []
    failure_buffer = []
    failures = []
    text_embedded_count = 0

    for i, c in enumerate(candidates):
        dest_path = os.path.join(SCRATCH_DIR, f"{c['imgId']}.webp")
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
            failure_buffer.append({"imgId": c["imgId"], "error": str(e), "failedAt": datetime.now(timezone.utc).isoformat()})
            print(f"[SKIP] {c['imgId']}: {e}", flush=True)
            if len(failure_buffer) >= chunk_size:
                _write_chunk_with_retry(failure_buffer, query=WRITE_FAILURE_QUERY)
                failure_buffer = []
            continue
        finally:
            if not keep_cache and os.path.exists(dest_path):
                os.remove(dest_path)

        write_buffer.append({
            "imgId": c["imgId"],
            "targetId": c["targetId"],
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
        elapsed = time.time() - start
        print(f"[PROGRESS] {done}/{total} processed ({len(failures)} failed) "
              f"| elapsed={elapsed:.0f}s | est_remaining={(elapsed/done)*(total-done):.0f}s", flush=True)

    _write_chunk_with_retry(write_buffer)
    _write_chunk_with_retry(failure_buffer, query=WRITE_FAILURE_QUERY)

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
    parser.add_argument("--all", action="store_true", help="Embed all qualifying Forum Auctions DigitalImage nodes already in the graph")
    parser.add_argument("--limit", type=int, help="Cap the number of images embedded (for a test run)")
    parser.add_argument("--force", action="store_true", help="Re-embed even if already set")
    parser.add_argument("--retry-failures", action="store_true", help="Include images previously marked embeddingFailed (e.g. to recheck dead URLs later); skipped by default so a persistent failure (a dead source URL) isn't retried on every run forever")
    parser.add_argument("--keep-cache", action="store_true", help="Don't delete downloaded images after embedding")
    parser.add_argument("--chunk-size", type=int, default=25, help="Neo4j write batch size")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --limit/--force/--retry-failures/--keep-cache)")

    candidates = fetch_candidates(force=args.force, retry_failures=args.retry_failures, limit=args.limit)
    print(f"Found {len(candidates)} image(s) to embed (force={args.force}, retry_failures={args.retry_failures})", flush=True)
    run_embeddings(candidates, chunk_size=args.chunk_size, keep_cache=args.keep_cache)
