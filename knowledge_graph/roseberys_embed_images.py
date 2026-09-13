"""
PrintMasterAI — DINOv2 + CLIP embeddings for Roseberys DigitalImage nodes, scoped by sale.

Why a separate script rather than a flag on an existing one:

  embed_images_dinov2.py writes DINOv2 ONLY. Stage 1d scores both measures on independent
  scales (ADR-0015), so an image with no clipImageEmbedding is half-indexed and will never
  contribute a CLIP match.

  bonhams_embed_images.py does write both, but loads the transformer models in-process and
  hardcodes institutionName IN ['Bonhams', 'Skinner'].

This one calls the embedding service the pipeline already runs on 127.0.0.1:8008 — the same
service Stage 1d uses at query time, so an indexed vector and a query vector come from
identical model weights. A mismatch there is silent and produces uniformly poor similarity
rather than an error.

Sale scoping is the point. Roseberys has ~10,365 unembedded images; embedding a single
upcoming catalogue is a 364-image job, and running the institution-wide backfill by accident
would be a very long one. --sale is therefore required unless --all-roseberys is passed.

Local files first: `imgId` encodes the lot ("roseberys-a0793-lot106-image"), which maps onto
the already-downloaded benchmark/data/<sale>/images/RB-<SALE>-106.webp. Falls back to
downloading sourceUrl when a local file is absent, so the script still works for sales whose
images were never fetched.

SELF-MATCH WARNING. Once an upcoming sale is embedded, its lots are in the vector index and
will match THEMSELVES at dino ~1.0. Callers must pass excludeSaleId to
queryImageEmbeddingMatches (see its VECTOR_QUERY) or every lot will confirm its own identity.

Usage:
    set -a; source .env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/roseberys_embed_images.py \
        --sale A0793 [--limit 10] [--force] [--dry-run]
"""

import argparse
import base64
import os
import sys
import time
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase

EMBED_SERVICE_URL = os.environ.get("EMBEDDING_SERVICE_URL", "http://127.0.0.1:8008")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _require_env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(
            f"{name} is not set. Run `set -a; source .env; set +a` before this script."
        )
    return v


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

# WHERE sits directly after the primary MATCH, before the OPTIONAL MATCH. A WHERE placed
# after an OPTIONAL MATCH scopes to that pattern instead, which is the bug already found
# twice in this toolkit (bm_embed_images.py, embed_tate_images.py).
FETCH_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.institutionName = 'Roseberys London'
  AND ($saleId IS NULL OR src.saleId = $saleId)
  AND ($force OR img.embedding IS NULL OR img.clipImageEmbedding IS NULL)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, src.saleId AS saleId, src.lotNumber AS lot
ORDER BY src.lotNumber
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
REMOVE img.embeddingFailed
"""


def fetch_candidates(sale_id, force=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as s:
            rows = [dict(r) for r in s.run(FETCH_QUERY, saleId=sale_id, force=force)]
    finally:
        driver.close()
    return rows[:limit] if limit else rows


def local_path(sale_id, lot):
    """benchmark/data/<SALE>/images/RB-<SALE>-<lot>.webp, if it was already downloaded."""
    if not sale_id or lot is None:
        return None
    p = os.path.join(REPO_ROOT, "benchmark", "data", sale_id, "images", f"RB-{sale_id}-{lot}.webp")
    return p if os.path.exists(p) else None


def image_bytes(row):
    p = local_path(row.get("saleId"), row.get("lot"))
    if p:
        with open(p, "rb") as f:
            return f.read(), "image/webp", "local"
    url = row.get("sourceUrl")
    if not url:
        raise RuntimeError("no local file and no sourceUrl")
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    mime = r.headers.get("content-type", "image/jpeg").split(";")[0]
    return r.content, mime, "download"


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


def write_chunk(rows):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as s:
            s.run(WRITE_QUERY, rows=rows)
    finally:
        driver.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sale", help="Sale code, e.g. A0793")
    ap.add_argument("--all-roseberys", action="store_true",
                    help="Every unembedded Roseberys image (~10k) — deliberately not the default")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true", help="Re-embed even if already set")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--chunk-size", type=int, default=50)
    a = ap.parse_args()
    if not a.sale and not a.all_roseberys:
        ap.error("Provide --sale CODE, or --all-roseberys to run the full backfill")

    try:
        h = requests.get(f"{EMBED_SERVICE_URL}/health", timeout=5).json()
        print(f"[SERVICE] {EMBED_SERVICE_URL} models={h.get('models')}", flush=True)
    except Exception as e:
        print(f"[FATAL] embedding service unreachable at {EMBED_SERVICE_URL}: {e}", file=sys.stderr)
        sys.exit(1)

    rows = fetch_candidates(a.sale, force=a.force, limit=a.limit)
    print(f"[FETCH] {len(rows)} image(s) to embed"
          f"{' for sale ' + a.sale if a.sale else ' across all Roseberys sales'}", flush=True)
    if a.dry_run:
        for r in rows[:8]:
            src = "local" if local_path(r.get("saleId"), r.get("lot")) else "download"
            print(f"  lot {r['lot']}  {r['imgId']}  [{src}]")
        print(f"[DRY RUN] nothing written.")
        return

    pending, ok, failed, t0 = [], 0, [], time.time()
    for i, r in enumerate(rows, 1):
        try:
            raw, mime, origin = image_bytes(r)
            d, c = embed(raw, mime)
            pending.append({
                "imgId": r["imgId"], "now": datetime.now(timezone.utc).isoformat(),
                "dino": d["vector"], "dinoModel": d.get("model"), "dinoDim": d.get("dim") or len(d["vector"]),
                "clip": c["vector"], "clipModel": c.get("model"), "clipDim": c.get("dim") or len(c["vector"]),
            })
            ok += 1
        except Exception as e:
            failed.append({"imgId": r["imgId"], "lot": r.get("lot"), "error": str(e)[:160]})
        if len(pending) >= a.chunk_size:
            write_chunk(pending); pending = []
        if i % 50 == 0:
            el = time.time() - t0
            print(f"[PROGRESS] {i}/{len(rows)} | ok={ok} failed={len(failed)} | "
                  f"{el:.0f}s elapsed, ~{el / i * (len(rows) - i):.0f}s remaining", flush=True)
    if pending:
        write_chunk(pending)

    print(f"[DONE] embedded={ok} failed={len(failed)} in {time.time() - t0:.0f}s", flush=True)
    for f in failed[:10]:
        print(f"  FAIL lot {f['lot']}: {f['error']}", flush=True)


if __name__ == "__main__":
    main()
