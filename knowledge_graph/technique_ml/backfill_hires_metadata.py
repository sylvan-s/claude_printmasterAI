"""
PrintMasterAI — ADR-0019 Phase 1: record native-resolution facts on DigitalImage nodes.
Version: TECHML-HIRES-BACKFILL-1.0

For every DigitalImage (or a host / labelled-only subset) this fetches the first 64 KB of
the best-resolution URL the host serves, reads the pixel dimensions from the header, and
writes:

  hiresUrl            the URL Phase 2 will fetch (hires.hires_url)
  hiresWidthPixels    }
  hiresHeightPixels   } from the image header — NOT the stored widthPixels/heightPixels,
  hiresBytes          } which on the BM nodes describe the 611px preview
  pxPerMm             long-axis pixels / long-axis catalogue millimetres (upper bound when
                      the photo includes a mount; Phase 2 refines from the localised area)
  pxPerMmBasis        'sheet' | 'plate' | 'image' — which Impression dimension was used
  resolutionTier      'family' (<5 px/mm) | 'process' (5–10) | 'fine' (>=10) | null
  hiresCheckedAt      ISO timestamp; the resume key
  hiresFailed / hiresFailedReason   on a permanent fetch failure

No image bytes are kept (ADR-0002 Amendment 1 Decision 7(b)); 64 KB per image over the
wire, ~0.25 s spacing per host. Resumable: nodes with hiresCheckedAt are skipped unless
--force. ~108k nodes at 4 req/s is ~7.5 h; run labelled-first with --labelled-only.

Usage (from repo root, .env sourced):
    python knowledge_graph/technique_ml/backfill_hires_metadata.py --all [--labelled-only]
        [--host bonhams|roseberys|bm|navigart|tate] [--limit N] [--dry-run] [--force]
"""

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hires import choose_dimensions, fetch_dimensions, hires_url, host_of, px_per_mm, resolution_tier  # noqa: E402

HOST_FILTERS = {
    "bonhams": "bonhams.com",
    "roseberys": "am-s3-bucket-assets",
    "bm": "britishmuseum.org",
    "navigart": "navigart.fr",
    "tate": "tate.org.uk",
}
PER_HOST_SPACING_S = 0.25

FETCH_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)
WHERE img.sourceUrl IS NOT NULL
  AND ($force OR img.hiresCheckedAt IS NULL OR ($retryFailures AND img.hiresFailed = true))
  AND ($hostFilter IS NULL OR img.sourceUrl CONTAINS $hostFilter)
  AND (NOT $labelledOnly OR EXISTS { (imp)-[:USES_TECHNIQUE]->(:Technique) })
RETURN elementId(img) AS id, img.sourceUrl AS sourceUrl,
       imp.sheetDimensions AS sheet, imp.imageDimensions AS image, imp.plateDimensions AS plate
ORDER BY id
"""

WRITE_QUERY = """
UNWIND $rows AS r
MATCH (img:DigitalImage) WHERE elementId(img) = r.id
SET img.hiresUrl = r.hiresUrl,
    img.hiresWidthPixels = r.w, img.hiresHeightPixels = r.h, img.hiresBytes = r.bytes,
    img.pxPerMm = r.pxPerMm, img.pxPerMmBasis = r.basis, img.resolutionTier = r.tier,
    img.hiresCheckedAt = r.at,
    img.hiresFailed = r.failed, img.hiresFailedReason = r.reason
"""


class HostRateLimiter:
    """At most one request per `spacing` seconds per host, across all worker threads."""

    def __init__(self, spacing):
        self.spacing = spacing
        self.lock = threading.Lock()
        self.next_ok = {}

    def wait(self, host):
        with self.lock:
            now = time.time()
            t = max(now, self.next_ok.get(host, 0.0))
            self.next_ok[host] = t + self.spacing
        if t > now:
            time.sleep(t - now)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def process(row, session_http):
    url = hires_url(row["sourceUrl"])
    out = {"id": row["id"], "hiresUrl": url, "w": None, "h": None, "bytes": None,
           "pxPerMm": None, "basis": None, "tier": None, "at": now_iso(), "failed": None, "reason": None}
    try:
        w, h, total = fetch_dimensions(url, session=session_http)
    except RuntimeError as e:
        # A substituted variant that does not exist (BM without a mid_, Roseberys without an
        # xlarge) is not a dead image: fall back to the stored URL and record that as hires.
        if url != row["sourceUrl"] and str(e).startswith("HTTP 4"):
            try:
                w, h, total = fetch_dimensions(row["sourceUrl"], session=session_http)
                url = out["hiresUrl"] = row["sourceUrl"]
            except RuntimeError as e2:
                out["failed"], out["reason"] = True, f"{e}; fallback {e2}"[:200]
                return out
        else:
            out["failed"], out["reason"] = True, str(e)[:200]
            return out
    out["w"], out["h"], out["bytes"] = int(w), int(h), (int(total) if total else None)
    dims, basis = choose_dimensions(row["sheet"], row["image"], row["plate"])
    ppm = px_per_mm(w, h, dims)
    out["pxPerMm"], out["basis"], out["tier"] = (round(ppm, 3) if ppm else None), basis, resolution_tier(ppm)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--labelled-only", action="store_true")
    ap.add_argument("--host", choices=sorted(HOST_FILTERS))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true", help="re-check nodes that already have hiresCheckedAt")
    ap.add_argument("--retry-failures", action="store_true", help="also re-check nodes marked hiresFailed")
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    ap.add_argument("--batch", type=int, default=50)
    ap.add_argument("--workers", type=int, default=6, help="concurrent fetchers; the per-host limiter still caps the rate")
    args = ap.parse_args()
    if not args.all:
        ap.error("pass --all (optionally with --labelled-only/--host/--limit/--dry-run/--force)")

    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    db = os.environ.get("NEO4J_DATABASE", "neo4j")
    with driver.session(database=db) as s:
        rows = [dict(r) for r in s.run(FETCH_QUERY, force=args.force, retryFailures=args.retry_failures,
                                       hostFilter=HOST_FILTERS.get(args.host), labelledOnly=args.labelled_only)]
    if args.limit:
        rows = rows[:args.limit]
    print(f"{len(rows)} image(s) to check (host={args.host or 'all'}, labelled_only={args.labelled_only}, force={args.force})", flush=True)

    # Concurrency: an uncached Bonhams lot takes ~2.5 s because the origin renders
    # `image?src=` on a Cloudflare MISS (measured 2026-09-13; cache HITs take 0.14 s). The
    # wait is server latency, not bandwidth, so a few workers recover the throughput while
    # the per-host limiter keeps the request rate at the ~4 req/s the sequential run used.
    limiter = HostRateLimiter(PER_HOST_SPACING_S)
    local = threading.local()

    def work(row):
        if not hasattr(local, "http"):
            local.http = requests.Session()
        limiter.wait(host_of(hires_url(row["sourceUrl"])) or "?")
        return process(row, local.http)

    pending, done, failed, t0 = [], 0, 0, time.time()
    tiers = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, out in enumerate(pool.map(work, rows, chunksize=1)):
            if out["failed"]:
                failed += 1
            else:
                tiers[out["tier"]] = tiers.get(out["tier"], 0) + 1
            if args.dry_run:
                print(f"  {out['w']}x{out['h']} {out['pxPerMm']} px/mm ({out['basis']}) tier={out['tier']} "
                      f"{out['reason'] or ''} {out['hiresUrl'][:90]}")
            else:
                pending.append(out)
            if not args.dry_run and (len(pending) >= args.batch or i == len(rows) - 1):
                with driver.session(database=db) as s:
                    s.run(WRITE_QUERY, rows=pending)
                done += len(pending)
                pending = []
            if (i + 1) % 200 == 0:
                rate = (i + 1) / (time.time() - t0)
                print(f"  {i + 1}/{len(rows)}  failed={failed}  tiers={tiers}  {rate:.1f} img/s  "
                      f"eta {((len(rows) - i - 1) / max(rate, 1e-6)) / 60:.0f} min", flush=True)
    driver.close()
    print(f"done: {done} written, {failed} failed, tiers={tiers}, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
