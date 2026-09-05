"""
PrintMasterAI — DINOv2/CLIP embeddings for British Museum DigitalImage nodes
Version: BM-EMBED-PILOT-0.3

Pure embedding pass — reads `DigitalImage.sourceUrl` straight from the graph, same
architecture as `embed_images_dinov2.py`/`embed_tate_images.py`: the ingest script
(`bm_ingest.py`) creates `DigitalImage` nodes in its own `LOAD_QUERY`/`LOAD_QUERY_MATRIX`
whenever a record's `ogImage` carries a URL, and this script only ever queries the graph
for un-embedded ones. It never touches `bm_ingest.py`'s cache file.

**Corrected 2026-09-06** — an earlier version of this script (and of `bm_ingest.py`)
had this backwards: `bm_ingest.py` didn't write `DigitalImage` at all, and this script
re-opened `bm_ingest.py`'s own JSON cache a second time to create the nodes before
embedding them. That's inconsistent with every other adapter here — `forum_ingest.py`
already creates `DigitalImage` in its main `LOAD_QUERY` when a row has an image URL,
and `embed_images_dinov2.py` only ever reads `sourceUrl` back from Neo4j, never touches
Forum's CSV again. The graph is the handoff between ingest and embed, not a second read
of the source cache. Fixed to match: `bm_ingest.py` now creates `DigitalImage` directly
(see its own docstring for the `og:image`-discovery/`_upsize_og_image_url` details —
doc 09 §7.3), and this script dropped its `create_digital_images()`/`--cache-path`
entirely.

Image *access* facts this still relies on, confirmed before any of this was written:
  1. **The image files are NOT behind Cloudflare**, unlike the catalogue pages — served
     from a separate `media.britishmuseum.org` CDN subdomain, reachable with plain
     `requests`/`curl` (200, no challenge). Same "escape to an unguarded asset host"
     shape as Roseberys/Forum's WAF-blocked-but-not-dead lot-image CDN (doc 09 §3.1).
  2. **`media.britishmuseum.org`'s TLS chain doesn't verify** (`SSLCertVerificationError:
     unable to get local issuer certificate` — a real server-side missing-intermediate-
     cert issue, checked with `curl -v`). BM's own page markup links to this host over
     plain `http://`, not https — this script does the same.

Licensing: `DigitalImage.license`/`.credit` are set by `bm_ingest.py` at node-creation
time (CC BY-NC-SA 4.0, "© The Trustees of the British Museum") — see doc 09 §7 and
[[project_bm_ingest_pilot]] for the licensing decision this operates under. Not
re-verified here.

Pipeline, one pass per image (matches every `SHOWS`-target — `Impression` for a print,
`Matrix` for a plate/block, doc 09 §7.2):
  1. Download once into a local scratch dir.
  2. DINOv2-Large embedding (facebook/dinov2-large, 1024-dim) — same model choice as
     `embed_tate_images.py` (not -small); pilot volume makes the -small/-large speed
     tradeoff that motivated Roseberys/Forum's choice irrelevant here.
  3. CLIP image embedding (openai/clip-vit-base-patch32, 512-dim) — Base, not Large,
     matching `embed_tate_images.py`'s own benchmarked decision.
  4. CLIP text embedding of the target's own description (`Impression.rawMedium` or
     `Matrix.description`, whichever is set), falling back to `ConceptualWork.name` for
     an Impression. Never fabricated.
  5. Deletes the downloaded file after a successful write (default; --keep-cache
     overrides).

Same isolated-venv/native-arm64 requirement as embed_images_dinov2.py/embed_tate_images.py
— reuses the existing `venv-embeddings` if already built, see that script's docstring.

Usage:
    python3 bm_embed_images.py --all
    python3 bm_embed_images.py --all --limit 5     # smoke test
    python3 bm_embed_images.py --all --force
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

SCRATCH_DIR = "tmp_bm_images"
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
WITH row
MATCH (target {id: row.targetId})
FOREACH (_ IN CASE WHEN row.clipTextEmbedding IS NOT NULL THEN [1] ELSE [] END |
    SET target.clipTextEmbedding = row.clipTextEmbedding,
        target.clipTextEmbeddingModel = row.clipModel,
        target.clipTextEmbeddingDim = row.clipDim,
        target.clipTextSource = row.textSource
)
"""

FAILURE_LOG_PATH = "bm_embed_images_failures.json"

# WHERE must come directly after the primary MATCH, before either OPTIONAL MATCH — a
# WHERE placed immediately after an OPTIONAL MATCH scopes to filtering THAT pattern's
# match, not the overall row set, so a false condition there still returns the row (with
# the optional fields null) instead of excluding it. Found live 2026-09-06 (also present,
# fixed, in embed_tate_images.py's identically-shaped query — see doc 09 §7.3): the
# original form (WHERE after both OPTIONAL MATCHes) made --force effectively always-on,
# re-embedding all 31 already-embedded Rembrandt images on a plain re-run instead of
# finding 0 candidates.
FETCH_CANDIDATES_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord {institutionName: 'British Museum'})
WHERE $force OR img.embedding IS NULL
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(target)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, target.id AS targetId,
       coalesce(target.rawMedium, target.description) AS description, cw.name AS title
ORDER BY imgId
"""


def fetch_candidates(force=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_CANDIDATES_QUERY, force=force)
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


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(WRITE_EMBEDDING_QUERY, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def run_embeddings(candidates, chunk_size=10, keep_cache=False):
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
        print(f"[PROGRESS] {done}/{total} processed ({len(failures)} failed)", flush=True)

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
    parser.add_argument("--all", action="store_true", help="Embed all qualifying BM DigitalImage nodes already in the graph")
    parser.add_argument("--limit", type=int, help="Cap the number of images embedded (for a test run)")
    parser.add_argument("--force", action="store_true", help="Re-embed even if already set")
    parser.add_argument("--keep-cache", action="store_true", help="Don't delete downloaded images after embedding")
    parser.add_argument("--chunk-size", type=int, default=10, help="Neo4j write batch size")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --limit/--force/--keep-cache)")

    candidates = fetch_candidates(force=args.force, limit=args.limit)
    print(f"Found {len(candidates)} image(s) to embed (force={args.force})", flush=True)
    run_embeddings(candidates, chunk_size=args.chunk_size, keep_cache=args.keep_cache)
