"""
PrintMasterAI — DINOv2 visual embeddings for ACKG DigitalImage nodes
Version: EMBED-DINOV2-1.0

Writes a DINOv2-small embedding onto every Roseberys/Forum Auctions `DigitalImage` node
that doesn't already have one. See doc 08 §7 for the schema addition this populates
(`embedding`/`embeddingModel`/`embeddingDim`/`embeddedAt`) and its explicit non-attribution
caveat — this is a general-purpose visual-similarity signal (composition/palette/texture),
confirmed in a proof-of-concept NOT to distinguish artists' hands by itself. Treat it as one
corroborating evidence type for Stage 2a's fusion logic, not a standalone classifier.

Scope: Roseberys London + Forum Auctions only. Tate has zero working images (dead URLs,
DigitalImage nodes already pruned — doc 09 §4.2/"dead thumbnailUrl values") and Met has zero
DigitalImage nodes at all (never fetched — met_ingest.py's own header comment). Nothing to
embed for either.

Prerequisite fix this depends on: `roseberys_ingest.py`/`forum_ingest.py`'s
`_fix_lot_image_url()` and the one-off graph-wide `sourceUrl` rewrite (2026-08-25, doc 09) —
the CSV's own image URLs 202/WAF-challenge on any non-browser client; the real asset lives
one hop away on a public, unauthenticated S3 bucket under the same UUIDs. If this script
starts seeing widespread download failures again, re-check that finding hasn't rotted the
same way Tate's did.

Dependencies are heavier and more fragile than the rest of this toolkit (torch,
transformers, Pillow with WebP support) — confirmed during the POC that installing them
into a shared conda base environment can trigger real version conflicts (this project's
own anaconda base has an old numpy that broke on a Pillow upgrade). Use an isolated venv —
and build it from the system's native-arm64 Python, not Anaconda's: on this project's own
Apple Silicon Mac, Anaconda's `python3` is an x86_64 build running under Rosetta, which
measured ~2x slower on CPU than native arm64 for this exact workload (0.62s/image vs.
0.316s/image) — a bigger, free win than chasing MPS turned out to be (MPS only measured
~1.16x over native-arm64 CPU for this small a model run unbatched, not worth the setup
complexity here):

    /usr/bin/python3 -m venv knowledge_graph/venv-embeddings
    knowledge_graph/venv-embeddings/bin/pip install -r knowledge_graph/requirements-embeddings.txt
    set -a; source knowledge_graph/.env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/embed_images_dinov2.py --all

(On non-Apple-Silicon hardware, plain `python3 -m venv` is fine — the Rosetta penalty
above is specific to running an x86_64 Python build on an ARM Mac.)

Usage:
    python3 embed_images_dinov2.py --all
    python3 embed_images_dinov2.py --all --institution roseberys
    python3 embed_images_dinov2.py --all --limit 50               # test run
    python3 embed_images_dinov2.py --all --force                  # re-embed even if already set
"""

import argparse
import io
import json
import os
import time
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real AuraDB values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

MODEL_NAME = "facebook/dinov2-small"
EMBEDDING_DIM = 384

INSTITUTION_NAMES = {
    "roseberys": "Roseberys London",
    "forum": "Forum Auctions",
}

FETCH_QUERY = """
MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp:Impression)<-[:SHOWS]-(img:DigitalImage)
WHERE src.institutionName IN $institutionNames
  AND ($force OR img.embedding IS NULL)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl
ORDER BY imgId
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embedding = row.embedding,
    img.embeddingModel = row.embeddingModel,
    img.embeddingDim = row.embeddingDim,
    img.embeddedAt = row.embeddedAt
"""

FAILURE_LOG_PATH = "embed_dinov2_failures.json"


def fetch_candidates(institution_names, force=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_QUERY, institutionNames=institution_names, force=force)
            rows = [dict(r) for r in result]
    finally:
        driver.close()
    if limit:
        rows = rows[:limit]
    return rows


def load_model():
    # Imported lazily so --help / argument errors don't pay torch's import cost, and so
    # this module can be imported (e.g. for fetch_candidates) without torch installed.
    import torch
    from transformers import AutoImageProcessor, AutoModel

    processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME)
    model.eval()
    return processor, model


def embed_image(processor, model, image_bytes):
    import torch
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    inputs = processor(images=img, return_tensors="pt")
    with torch.no_grad():
        outputs = model(**inputs)
    # CLS token pooled output = the embedding representing the whole image — same
    # extraction used in the POC this productionizes.
    return outputs.last_hidden_state[:, 0, :].squeeze(0).tolist()


def download_image(url, retries=3, backoff_seconds=2.0, timeout=20):
    last_error = None
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.content
            last_error = f"HTTP {r.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < retries - 1:
            time.sleep(backoff_seconds * (attempt + 1))
    raise RuntimeError(last_error)


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
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


def run(candidates, chunk_size=100):
    processor, model = load_model()
    total = len(candidates)
    start = time.time()
    write_buffer = []
    failures = []

    for i, c in enumerate(candidates):
        try:
            image_bytes = download_image(c["sourceUrl"])
            vector = embed_image(processor, model, image_bytes)
        except Exception as e:
            failures.append({"imgId": c["imgId"], "url": c["sourceUrl"], "error": str(e)})
            print(f"[SKIP] {c['imgId']}: {e}", flush=True)
            continue

        write_buffer.append({
            "imgId": c["imgId"],
            "embedding": vector,
            "embeddingModel": MODEL_NAME,
            "embeddingDim": EMBEDDING_DIM,
            "embeddedAt": datetime.now(timezone.utc).isoformat(),
        })
        if len(write_buffer) >= chunk_size:
            _write_chunk_with_retry(write_buffer)
            write_buffer = []

        done = i + 1
        if done % 50 == 0 or done == total:
            elapsed = time.time() - start
            print(f"[PROGRESS] {done}/{total} processed ({len(failures)} failed) "
                  f"| elapsed={elapsed:.0f}s | est_remaining={(elapsed / done) * (total - done):.0f}s",
                  flush=True)

    if write_buffer:
        _write_chunk_with_retry(write_buffer)

    embedded = total - len(failures)
    print(f"[DONE] embedded={embedded} failed={len(failures)} elapsed={time.time() - start:.0f}s", flush=True)

    if failures:
        with open(FAILURE_LOG_PATH, "w") as f:
            json.dump(failures, f, indent=2)
        print(f"[DONE] {len(failures)} failures logged to {FAILURE_LOG_PATH} — re-run with "
              f"the same flags later to retry just these (embedding IS NULL still matches them)",
              flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Embed every qualifying DigitalImage")
    parser.add_argument("--institution", choices=["roseberys", "forum", "both"], default="both")
    parser.add_argument("--limit", type=int, help="Cap the number of images (for a test run)")
    parser.add_argument("--force", action="store_true",
                         help="Re-embed even if img.embedding is already set (default: skip)")
    parser.add_argument("--chunk-size", type=int, default=100, help="Neo4j write batch size")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --institution/--limit/--force)")

    names = (list(INSTITUTION_NAMES.values()) if args.institution == "both"
             else [INSTITUTION_NAMES[args.institution]])

    candidates = fetch_candidates(names, force=args.force, limit=args.limit)
    print(f"Found {len(candidates)} image(s) to embed (institution={args.institution}, "
          f"force={args.force})", flush=True)
    run(candidates, chunk_size=args.chunk_size)
