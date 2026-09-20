"""
PrintMasterAI — DINOv2 + CLIP image embeddings for Swann Auction Galleries DigitalImage nodes
Version: SWANN-EMBED-1.0

Pure embedding pass, same architecture as `roseberys_embed_images.py`: `swann_ingest.py`
already creates one `DigitalImage` per lot with a `photoUrl` in its own `LOAD_QUERY`
(confirmed live before writing this — 14,073 Swann `DigitalImage` nodes already in the
graph after the full catalogue load, 0 embedded), so this script only ever queries the
graph for un-embedded ones. It never touches benchmark/data/swann/catalogue.json again.

Calls the embedding service the pipeline already runs on 127.0.0.1:8008 (confirmed live
before writing this — dinov2-large + clip-vit-base-patch32) rather than loading the
transformer models in-process the way `bonhams_embed_images.py` does — same reasoning
roseberys_embed_images.py's own docstring already gives: an indexed vector and a Stage 1d
query-time vector then come from identical model weights, not just the same model NAMES.

No local-file fast path, unlike Roseberys: Swann's pull (benchmark/src/swann/pull.ts)
only ever captured remote `image.invaluable.com/housePhotos/...` URLs, no bulk image
download step was run for this source, so every image here is a fresh download.

Scale is the real difference from Roseberys' own script (a few hundred to ~10k images
per run, usually one sale at a time): 14,073 images in one institution-wide backfill,
closer to Bonhams' 51,963 than to a single Roseberys sale. So failure handling follows
Bonhams' pattern instead of Roseberys' — a failed download/embed is persisted onto the
DigitalImage node itself (`embeddingFailed`/`embeddingFailedReason`/`embeddingFailedAt`),
not just an in-memory list printed at the end, so a permanently-dead source URL isn't
retried on every future incremental run forever (see bonhams_embed_images.py's own
docstring for the exact incident this pattern was built to prevent). --retry-failures
deliberately rechecks them.

DINO+CLIP IMAGE embeddings only, matching the scope roseberys_embed_images.py covers —
no CLIP TEXT embedding of the title/description here (that is a separate Bonhams-only
addition, out of scope of what was asked for this source).

Usage:
    set -a; source .env; set +a
    python3 knowledge_graph/swann_embed_images.py --all --limit 50     # test run
    python3 knowledge_graph/swann_embed_images.py --all
    python3 knowledge_graph/swann_embed_images.py --all --force
    python3 knowledge_graph/swann_embed_images.py --all --retry-failures --limit 50
"""

import argparse
import base64
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase

EMBED_SERVICE_URL = os.environ.get("EMBEDDING_SERVICE_URL", "http://127.0.0.1:8008")
INSTITUTION_NAME = "Swann Auction Galleries"


def _require_env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} is not set. Run `set -a; source .env; set +a` before this script.")
    return v


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

# WHERE sits directly after the primary MATCH — a WHERE placed after an OPTIONAL MATCH
# scopes to filtering that pattern instead, the exact bug already found twice elsewhere
# in this toolkit (bm_embed_images.py, embed_tate_images.py, flagged again in both
# roseberys_embed_images.py and bonhams_embed_images.py's own docstrings). There is no
# OPTIONAL MATCH here at all, so the risk doesn't currently apply, but the WHERE stays in
# this position on principle, matching every sibling script's own convention.
#
# embeddingFailed is skipped by default (a prior attempt already recorded a real error,
# most commonly a dead source URL) unless --retry-failures or --force is passed — same
# convention as bonhams_embed_images.py.
FETCH_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.institutionName = $institutionName
  AND (
    $force
    OR (img.embedding IS NULL AND ($retryFailures OR coalesce(img.embeddingFailed, false) = false))
  )
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, src.saleId AS saleId, src.lotNumber AS lot
ORDER BY imgId
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embedding = row.dino,
    img.embeddingModel = row.dinoModel,
    img.embeddingDim = row.dinoDim,
    img.embeddedAt = row.now,
    img.clipImageEmbedding = row.clip,
    img.clipImageEmbeddingModel = row.clipModel,
    img.clipImageEmbeddingDim = row.clipDim,
    img.clipEmbeddedAt = row.now
REMOVE img.embeddingFailed, img.embeddingFailedReason, img.embeddingFailedAt
"""

WRITE_FAILURE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embeddingFailed = true,
    img.embeddingFailedReason = row.error,
    img.embeddingFailedAt = row.failedAt
"""


def fetch_candidates(force=False, retry_failures=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as s:
            rows = [dict(r) for r in s.run(
                FETCH_QUERY, institutionName=INSTITUTION_NAME, force=force, retryFailures=retry_failures,
            )]
    finally:
        driver.close()
    return rows[:limit] if limit else rows


def image_bytes(row):
    url = row.get("sourceUrl")
    if not url:
        raise RuntimeError("no sourceUrl")
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    mime = r.headers.get("content-type", "image/jpeg").split(";")[0]
    return r.content, mime


def embed(raw, mime):
    r = requests.post(
        f"{EMBED_SERVICE_URL}/embed",
        json={"imageBase64": base64.b64encode(raw).decode("ascii"), "mimeType": mime},
        timeout=60,
    )
    r.raise_for_status()
    j = r.json()
    d, c = j.get("dinov2"), j.get("clip")
    if not d or not d.get("vector"):
        raise RuntimeError("service returned no dinov2 vector")
    if not c or not c.get("vector"):
        raise RuntimeError("service returned no clip vector")
    return d, c


def _write_chunk_with_retry(rows, query=WRITE_QUERY, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as s:
                s.run(query, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="Every unembedded Swann DigitalImage (~14k)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true", help="Re-embed even if already set")
    ap.add_argument("--retry-failures", action="store_true",
                     help="Include images previously marked embeddingFailed (e.g. to recheck dead URLs)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--chunk-size", type=int, default=50)
    ap.add_argument("--workers", type=int, default=8, help="Concurrent download+embed workers")
    a = ap.parse_args()
    if not a.all:
        ap.error("Provide --all (optionally with --limit/--force/--retry-failures)")

    try:
        h = requests.get(f"{EMBED_SERVICE_URL}/health", timeout=5).json()
        print(f"[SERVICE] {EMBED_SERVICE_URL} models={h.get('models')}", flush=True)
    except Exception as e:
        print(f"[FATAL] embedding service unreachable at {EMBED_SERVICE_URL}: {e}", file=sys.stderr)
        sys.exit(1)

    rows = fetch_candidates(force=a.force, retry_failures=a.retry_failures, limit=a.limit)
    print(f"[FETCH] {len(rows)} image(s) to embed for {INSTITUTION_NAME}", flush=True)
    if a.dry_run:
        for r in rows[:8]:
            print(f"  sale {r['saleId']} lot {r['lot']}  {r['imgId']}")
        print("[DRY RUN] nothing written.")
        return

    # Download + embed-service-call is pure I/O wait from this process's point of view
    # (confirmed by profiling before writing this: ~0.6s download + ~0.5s service round
    # trip per image, sequentially ~1.1s/image — 14,073 images at that rate is ~4.3h). A
    # thread pool overlaps those waits; a live burst test against the actual service
    # (8 concurrent workers, 12 requests) measured ~0.34s/image, ~3x — the service itself
    # handles concurrent requests fine, this isn't relying on an untested assumption.
    # Neo4j writes stay strictly on the main thread as results complete, same
    # chunk-then-write pattern as every sequential sibling script; only the per-image
    # download+embed work is parallelized.
    def _fetch_and_embed(row):
        raw, mime = image_bytes(row)
        d, c = embed(raw, mime)
        return row, d, c

    pending, failure_pending, ok, failed, t0 = [], [], 0, [], time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as executor:
        futures = {executor.submit(_fetch_and_embed, r): r for r in rows}
        for i, future in enumerate(as_completed(futures), 1):
            r = futures[future]
            try:
                r, d, c = future.result()
                pending.append({
                    "imgId": r["imgId"], "now": datetime.now(timezone.utc).isoformat(),
                    "dino": d["vector"], "dinoModel": d.get("model"), "dinoDim": d.get("dim") or len(d["vector"]),
                    "clip": c["vector"], "clipModel": c.get("model"), "clipDim": c.get("dim") or len(c["vector"]),
                })
                ok += 1
            except Exception as e:
                err = str(e)[:200]
                failed.append({"imgId": r["imgId"], "saleId": r.get("saleId"), "lot": r.get("lot"), "error": err})
                failure_pending.append({
                    "imgId": r["imgId"], "error": err,
                    "failedAt": datetime.now(timezone.utc).isoformat(),
                })
            if len(pending) >= a.chunk_size:
                _write_chunk_with_retry(pending); pending = []
            if len(failure_pending) >= a.chunk_size:
                _write_chunk_with_retry(failure_pending, query=WRITE_FAILURE_QUERY); failure_pending = []
            if i % 200 == 0 or i == len(rows):
                el = time.time() - t0
                print(f"[PROGRESS] {i}/{len(rows)} | ok={ok} failed={len(failed)} | "
                      f"{el:.0f}s elapsed, ~{el / i * (len(rows) - i):.0f}s remaining", flush=True)
    _write_chunk_with_retry(pending)
    _write_chunk_with_retry(failure_pending, query=WRITE_FAILURE_QUERY)

    print(f"[DONE] embedded={ok} failed={len(failed)} in {time.time() - t0:.0f}s", flush=True)
    for f in failed[:10]:
        print(f"  FAIL sale {f['saleId']} lot {f['lot']}: {f['error']}", flush=True)


if __name__ == "__main__":
    main()
