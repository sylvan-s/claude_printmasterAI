"""
PrintMasterAI — Tate image existence check / resolution (ACKG Stage 1)
Version: RESOLVE-TATE-1.0

Checks whether a live, working thumbnail image exists for each Tate `ConceptualWork`
(via its `Impression`), using the *current* tate.org.uk artwork page rather than the
frozen 2014 `thumbnailUrl` column from the `tategallery/collection` CSV — that column
is confirmed 100% dead (see doc 09 §4.2 "Known deliberate exclusion — dead
thumbnailUrl values", which deleted all 8,942 DigitalImage nodes it produced).

Live re-check (2026-09-04, this script's own design session): tate.org.uk artwork
pages ARE live and DO expose a working image via an `og:image` meta tag on a
different CDN path (`media.tate.org.uk/art/images/work/...`) than the dead 2014 one.
robots.txt allows `/art/artworks/` (only `/search` and two `*-custom.xml` files are
disallowed); `media.tate.org.uk` has no robots.txt at all. Confirmed on one sample
work (T05274) before writing this script — this run is what checks it at scale.

Does NOT download images or compute embeddings — that's embed_tate_images.py, which
consumes the DigitalImage nodes this script creates. Kept as two separate scripts so
the (slow, one-HTTP-request-per-work) discovery pass can be resumed/retried
independently of the (slow, model-inference) embedding pass — same reasoning as
Roseberys/Forum's ingest-then-embed split.

Writes, per Tate Impression checked:
    Impression.tateImageStatus     "found" | "not_found" | "error"
    Impression.tateImageCheckedAt  ISO timestamp
    Impression.catalogueDescription  scraped page description text, or null
And when status is "found", also creates:
    (DigitalImage {id, sourceUrl, imageType})-[:SHOWS]->(Impression)

Idempotent/resumable: only considers Impressions where tateImageStatus IS NULL,
unless --force. Safe to run in batches across multiple sessions.

Licensing note: Tate's site content (unlike the CC0 tategallery/collection metadata
CSV) is copyrighted ("(c) The Board of Trustees of the Tate Gallery"). This script
only extracts small metadata (an image URL, a short description) for research use,
not bulk reproduction — see the pipeline design discussion for the fuller licensing
rationale. Sends an identifying User-Agent naming the request's non-commercial
research purpose.

Usage:
    python3 resolve_tate_images.py --limit 50            # pilot / test run
    python3 resolve_tate_images.py --all                 # full 11k+ run
    python3 resolve_tate_images.py --all --force          # re-check already-checked works
"""

import argparse
import html
import os
import random
import re
import time
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real ACKG values (now the self-hosted Oracle Neo4j instance, not "
            f"Aura — see project memory), and export them (e.g. `set -a; source .env; "
            f"set +a`) before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

USER_AGENT = (
    "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; "
    "non-commercial academic research; single-request-per-page, rate-limited)"
)

OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', re.IGNORECASE
)
OG_DESC_RE = re.compile(
    r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', re.IGNORECASE
)
META_DESC_RE = re.compile(
    r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', re.IGNORECASE
)

FETCH_CANDIDATES_QUERY = """
MATCH (src:SourceRecord {institutionName: 'Tate'})-[:DOCUMENTS]->(imp:Impression)
WHERE src.listingUrl IS NOT NULL
  AND ($force OR imp.tateImageStatus IS NULL)
RETURN src.id AS srcId, src.accessionNumber AS accession, src.listingUrl AS listingUrl,
       imp.id AS impId
"""

WRITE_FOUND_QUERY = """
UNWIND $rows AS row
MATCH (imp:Impression {id: row.impId})
SET imp.tateImageStatus = 'found',
    imp.tateImageCheckedAt = row.checkedAt,
    imp.catalogueDescription = row.description
MERGE (img:DigitalImage {id: row.impId + '-img'})
SET img.sourceUrl = row.imageUrl,
    img.imageType = 'thumbnail'
MERGE (img)-[:SHOWS]->(imp)
"""

WRITE_MISS_QUERY = """
UNWIND $rows AS row
MATCH (imp:Impression {id: row.impId})
SET imp.tateImageStatus = row.status,
    imp.tateImageCheckedAt = row.checkedAt
"""

FAILURE_LOG_PATH = "resolve_tate_images_failures.json"


def fetch_candidates(force=False, limit=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_CANDIDATES_QUERY, force=force)
            rows = [dict(r) for r in result]
    finally:
        driver.close()
    if limit:
        random.shuffle(rows)
        rows = rows[:limit]
    return rows


def resolve_one(listing_url, timeout=15):
    """Returns (image_url_or_None, description_or_None). Raises on request failure."""
    url = listing_url.replace("http://", "https://", 1)
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}")

    body = resp.text
    img_match = OG_IMAGE_RE.search(body)
    image_url = html.unescape(img_match.group(1)) if img_match else None

    desc_match = OG_DESC_RE.search(body) or META_DESC_RE.search(body)
    description = html.unescape(desc_match.group(1)).strip() if desc_match else None
    # Tate's generic site-description meta tag is not per-work text — filter it out
    # rather than store it as if it were a real catalogue description.
    if description and description.lower().startswith("tate is a family of four galleries"):
        description = None

    return image_url, description


def _write_chunk_with_retry(query, rows, retries=4, backoff_seconds=5.0):
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


def run(candidates, chunk_size=25, delay_seconds=0.6):
    total = len(candidates)
    start = time.time()
    found_buffer, miss_buffer = [], []
    failures = []
    found_count = not_found_count = error_count = 0

    for i, c in enumerate(candidates):
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            image_url, description = resolve_one(c["listingUrl"])
        except Exception as e:
            error_count += 1
            failures.append({"impId": c["impId"], "url": c["listingUrl"], "error": str(e)})
            miss_buffer.append({"impId": c["impId"], "status": "error", "checkedAt": checked_at})
            print(f"[ERROR] {c['accession']}: {e}", flush=True)
        else:
            if image_url:
                found_count += 1
                found_buffer.append({
                    "impId": c["impId"],
                    "imageUrl": image_url,
                    "description": description,
                    "checkedAt": checked_at,
                })
                print(f"[FOUND] {c['accession']}: {image_url}"
                      f"{' | desc' if description else ''}", flush=True)
            else:
                not_found_count += 1
                miss_buffer.append({"impId": c["impId"], "status": "not_found", "checkedAt": checked_at})
                print(f"[MISS] {c['accession']}: no og:image on page", flush=True)

        if len(found_buffer) >= chunk_size:
            _write_chunk_with_retry(WRITE_FOUND_QUERY, found_buffer)
            found_buffer = []
        if len(miss_buffer) >= chunk_size:
            _write_chunk_with_retry(WRITE_MISS_QUERY, miss_buffer)
            miss_buffer = []

        time.sleep(delay_seconds)

        done = i + 1
        if done % 10 == 0 or done == total:
            elapsed = time.time() - start
            print(f"[PROGRESS] {done}/{total} | found={found_count} not_found={not_found_count} "
                  f"error={error_count} | elapsed={elapsed:.0f}s "
                  f"est_remaining={(elapsed / done) * (total - done):.0f}s", flush=True)

    _write_chunk_with_retry(WRITE_FOUND_QUERY, found_buffer)
    _write_chunk_with_retry(WRITE_MISS_QUERY, miss_buffer)

    print(f"[DONE] total={total} found={found_count} ({found_count/total*100:.0f}%) "
          f"not_found={not_found_count} error={error_count} elapsed={time.time()-start:.0f}s",
          flush=True)

    if failures:
        import json
        with open(FAILURE_LOG_PATH, "w") as f:
            json.dump(failures, f, indent=2)
        print(f"[DONE] {len(failures)} request failures logged to {FAILURE_LOG_PATH} "
              f"— re-run with --force on just these later to retry", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Check every unresolved Tate work")
    parser.add_argument("--limit", type=int, help="Random sample size (e.g. for a pilot run)")
    parser.add_argument("--force", action="store_true",
                         help="Re-check even if tateImageStatus is already set")
    parser.add_argument("--delay", type=float, default=0.6,
                         help="Seconds to sleep between requests (politeness rate limit)")
    args = parser.parse_args()

    if not args.all and not args.limit:
        parser.error("Provide --all or --limit N")

    candidates = fetch_candidates(force=args.force, limit=args.limit)
    print(f"Found {len(candidates)} Tate work(s) to check (force={args.force})", flush=True)
    run(candidates, delay_seconds=args.delay)
