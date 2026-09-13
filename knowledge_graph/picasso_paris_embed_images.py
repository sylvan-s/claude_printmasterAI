"""
PrintMasterAI — DINOv2/CLIP embeddings for Musée national Picasso-Paris DigitalImage nodes
Version: PICASSO-PARIS-EMBED-0.1

Same architecture as `bm_embed_images.py`/`embed_tate_images.py`: a pure embedding pass
that reads `DigitalImage.sourceUrl` back out of the graph and never re-opens
`picasso_paris_ingest.py`'s cache. The graph is the handoff between ingest and embed.

**This script operates under a narrower licence than any other embed script here, and it
is written to enforce that rather than to document it.** ADR-0002 *Amendment 1* Decision 7
permits image similarity over this in-copyright museum source on the current
personal-research footing, subject to four conditions. Each one is a mechanism below, not
a promise:

  (a) *Only the derived embedding is retained; source images are cached transiently and
      deleted.* → **There is deliberately no `--keep-cache` flag.** Every sibling script
      here has one; this one must not, because "keep the downloaded copies of 2,111
      in-copyright Picasso images on disk" is exactly the thing Decision 7(a) forbids.
      Teardown is also in a `try/finally` plus an `atexit` hook, not just at the end of
      the happy path the way `bm_embed_images.py` does it — an exception or a Ctrl-C
      mid-run otherwise leaves the whole downloaded set sitting in the scratch dir.
  (b) *No image bytes enter the graph, any export, or any interface.* → only float vectors
      are ever written; `_assert_no_bytes` sanity-checks that before any write.
  (c) *Embeddings are used for retrieval and comparison only.*
  (d) *The result is never displayed to anyone but the operator.*
      → (c) and (d) can't be enforced from inside this script, so instead every node it
      touches is stamped `embeddingBasis` + `embeddingCommercialUse = false`. That makes
      ADR-0002 Amendment 1 **Decision 8 executable**: when this project takes money the
      carve-out lapses automatically, and the vectors that have to go are findable in one
      query rather than by remembering which source they came from —
        MATCH (i:DigitalImage) WHERE i.embeddingCommercialUse = false
        REMOVE i.embedding, i.clipImageEmbedding, i.embeddingBasis, i.embeddingCommercialUse
      A licence that can't be complied with mechanically is a licence that won't be.

Decision 6 (attribution is structural) is enforced as a **precondition**: the fetch query
only returns images carrying both `license` and `rightsReservation`, and the script aborts
loudly if the count of qualifying images doesn't match the count of Picasso-Paris images in
the graph. If a future ingest change drops those properties, this refuses to run rather
than quietly embedding unlabelled in-copyright imagery.

**CLIP *text* embedding is OFF by default here, unlike every other adapter** — opt in with
`--with-text-embedding`. `target.clipTextEmbedding` is a single shared vector space across
91,685 nodes, and 91,487 of those were built from English `description` text. This source's
description field (`Impression.rawMedium`) is French — "Aquatinte, grattoir et pointe sèche
sur quatre cuivres" — and CLIP's text encoder is English-trained. Writing French vectors
into a space that is queried with English would degrade retrieval for every other corpus,
which is the same contamination argument that kept French keywords out of
`crosswalk_matching`'s shared lists (see `picasso_paris_ingest.py` docstring point 1).
The image vectors have no such problem: DINOv2 and CLIP-image don't read the caption.

Pipeline, one pass per image:
  1. Download once into a scratch dir that is `.gitignore`d and unconditionally purged.
  2. DINOv2-Large embedding (facebook/dinov2-large, 1024-dim).
  3. CLIP image embedding (openai/clip-vit-base-patch32, 512-dim).
  4. CLIP text embedding — only with --with-text-embedding, see above.
  5. Delete the downloaded file immediately, before the next iteration.

Image host: `images.navigart.fr`, plain https, no bot wall and a valid TLS chain — neither
the BM's Cloudflare problem nor its missing-intermediate-cert problem applies. The size
token in the URL is a number; `picasso_paris_ingest.py` already wrote 1000 (the ceiling —
2000 returns HTTP 415), so no URL rewriting happens here.

Same isolated-venv/native-arm64 requirement as the other embed scripts — reuses
`venv-embeddings`, see `embed_images_dinov2.py`'s docstring.

Usage:
    venv-embeddings/bin/python3 picasso_paris_embed_images.py --all --limit 5   # smoke test
    venv-embeddings/bin/python3 picasso_paris_embed_images.py --all
    venv-embeddings/bin/python3 picasso_paris_embed_images.py --all --force
"""

import argparse
import atexit
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

INSTITUTION_NAME = "Musée national Picasso-Paris"
SCRATCH_DIR = "tmp_picasso_paris_images"
FAILURE_LOG_PATH = "picasso_paris_embed_images_failures.json"
USER_AGENT = "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; non-commercial academic research)"

# Stamped on every node this script embeds — see module docstring, conditions (c)/(d).
EMBEDDING_BASIS = "ADR-0002 Amendment 1 Decision 7 — non-commercial research only; lapses on any commercial footing"

# WHERE must come directly after the primary MATCH, before any OPTIONAL MATCH — a WHERE
# placed after an OPTIONAL MATCH scopes to filtering THAT pattern, not the row set, so a
# false condition still returns the row with null optionals instead of excluding it. Found
# live 2026-09-06 in bm_embed_images.py and embed_tate_images.py (doc 09 §7.3), where it
# made --force effectively always-on. Same shape, same placement, deliberately.
#
# The license/rightsReservation conditions are Decision 6 as a precondition, not a filter
# for convenience: an image node that lost its rights properties must not be embeddable.
FETCH_CANDIDATES_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord {institutionName: $institutionName})
WHERE ($force OR img.embedding IS NULL)
  AND img.license IS NOT NULL
  AND img.rightsReservation IS NOT NULL
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(target)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, target.id AS targetId,
       coalesce(target.rawMedium, target.description) AS description, cw.name AS title
ORDER BY imgId
"""

# Decision 6 precondition check — counts every Picasso-Paris image regardless of rights
# properties, so a mismatch against the fetch count means some node lost them.
RIGHTS_AUDIT_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord {institutionName: $institutionName})
RETURN count(img) AS total,
       count(CASE WHEN img.license IS NOT NULL AND img.rightsReservation IS NOT NULL THEN 1 END) AS labelled
"""

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
    img.clipEmbeddedAt = row.embeddedAt,
    img.embeddingBasis = row.embeddingBasis,
    img.embeddingCommercialUse = false
WITH row
MATCH (target {id: row.targetId})
FOREACH (_ IN CASE WHEN row.clipTextEmbedding IS NOT NULL THEN [1] ELSE [] END |
    SET target.clipTextEmbedding = row.clipTextEmbedding,
        target.clipTextEmbeddingModel = row.clipModel,
        target.clipTextEmbeddingDim = row.clipDim,
        target.clipTextSource = row.textSource
)
"""


def _purge_scratch():
    """Condition 7(a). Registered with atexit as well as called in a finally, so a crash,
    an unhandled exception or a Ctrl-C still removes the downloaded images."""
    shutil.rmtree(SCRATCH_DIR, ignore_errors=True)


atexit.register(_purge_scratch)


def _session():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def audit_rights():
    driver = _session()
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            return dict(session.run(RIGHTS_AUDIT_QUERY, institutionName=INSTITUTION_NAME).single())
    finally:
        driver.close()


def fetch_candidates(force=False, limit=None):
    driver = _session()
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            rows = [dict(r) for r in session.run(
                FETCH_CANDIDATES_QUERY, force=force, institutionName=INSTITUTION_NAME)]
    finally:
        driver.close()
    return rows[:limit] if limit else rows


def load_models():
    import torch  # noqa: F401 — lazy so --help doesn't pay torch's import cost
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


def _assert_no_bytes(row):
    """Condition 7(b). Cheap, but the condition is worth a mechanism: every value bound for
    the graph must be a float vector or a scalar, never bytes."""
    for key, value in row.items():
        if isinstance(value, (bytes, bytearray, memoryview)):
            raise RuntimeError(f"refusing to write binary data to the graph: {key}")
        if isinstance(value, list) and value and not isinstance(value[0], float):
            raise RuntimeError(f"refusing to write a non-float vector to the graph: {key}")


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    for row in rows:
        _assert_no_bytes(row)
    last_error = None
    for attempt in range(retries):
        driver = _session()
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


def run_embeddings(candidates, chunk_size=10, with_text_embedding=False):
    from PIL import Image

    os.makedirs(SCRATCH_DIR, exist_ok=True)
    dino_processor, dino_model, clip_processor, clip_model = load_models()

    total = len(candidates)
    start = time.time()
    write_buffer, failures, text_embedded_count = [], [], 0

    try:
        for i, c in enumerate(candidates):
            dest_path = os.path.join(SCRATCH_DIR, f"{c['imgId']}.jpg")
            try:
                download_to_scratch(c["sourceUrl"], dest_path)
                image = Image.open(dest_path).convert("RGB")

                dino_vec = embed_dinov2(dino_processor, dino_model, image)
                clip_img_vec = embed_clip_image(clip_processor, clip_model, image)

                clip_text_vec, text_source = None, None
                if with_text_embedding:
                    text = c.get("description") or c.get("title")
                    text_source = "description" if c.get("description") else ("title" if c.get("title") else None)
                    if text:
                        clip_text_vec = embed_clip_text(clip_processor, clip_model, text)
                        text_embedded_count += 1
            except Exception as e:
                failures.append({"imgId": c["imgId"], "url": c["sourceUrl"], "error": str(e)})
                print(f"[SKIP] {c['imgId']}: {e}", flush=True)
                continue
            finally:
                # Condition 7(a) — deleted immediately, not at end of run. The scratch dir
                # never holds more than one in-copyright image at a time.
                if os.path.exists(dest_path):
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
                "embeddingBasis": EMBEDDING_BASIS,
                "embeddedAt": datetime.now(timezone.utc).isoformat(),
            })
            if len(write_buffer) >= chunk_size:
                _write_chunk_with_retry(write_buffer)
                write_buffer = []

            print(f"[PROGRESS] {i + 1}/{total} processed ({len(failures)} failed)", flush=True)

        _write_chunk_with_retry(write_buffer)
    finally:
        _purge_scratch()

    embedded = total - len(failures)
    print(f"[DONE] embedded={embedded} failed={len(failures)} "
          f"text_embedded={text_embedded_count} elapsed={time.time() - start:.0f}s", flush=True)
    print(f"[RIGHTS] {embedded} node(s) stamped embeddingCommercialUse=false", flush=True)

    if failures:
        with open(FAILURE_LOG_PATH, "w") as f:
            json.dump(failures, f, indent=2)
        print(f"[DONE] {len(failures)} failures logged to {FAILURE_LOG_PATH}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Embed all qualifying Picasso-Paris DigitalImage nodes already in the graph")
    parser.add_argument("--limit", type=int, help="Cap the number of images embedded (for a test run)")
    parser.add_argument("--force", action="store_true", help="Re-embed even if already set")
    parser.add_argument("--chunk-size", type=int, default=10, help="Neo4j write batch size")
    parser.add_argument("--with-text-embedding", action="store_true",
                        help="Also write target.clipTextEmbedding. OFF by default: this source's description text is French and CLIP's text encoder is English-trained, and clipTextEmbedding is a single shared space of which 91,487 of 91,685 existing vectors are English — see module docstring")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --limit/--force/--with-text-embedding)")

    # Decision 6 precondition — see module docstring.
    audit = audit_rights()
    if audit["total"] != audit["labelled"]:
        raise SystemExit(
            f"ABORT: {audit['total'] - audit['labelled']} of {audit['total']} Picasso-Paris "
            f"DigitalImage nodes are missing license/rightsReservation. ADR-0002 Amendment 1 "
            f"Decision 6 requires those to be present before any image is embedded. Re-run "
            f"picasso_paris_ingest.py to restore them."
        )
    print(f"[RIGHTS] {audit['labelled']}/{audit['total']} images carry license + rightsReservation", flush=True)

    candidates = fetch_candidates(force=args.force, limit=args.limit)
    print(f"Found {len(candidates)} image(s) to embed (force={args.force}, "
          f"with_text_embedding={args.with_text_embedding})", flush=True)
    run_embeddings(candidates, chunk_size=args.chunk_size, with_text_embedding=args.with_text_embedding)
