"""
PrintMasterAI — Musée national Picasso-Paris catalogue fetch (Navigart 3 API)
Version: PICASSO-PARIS-FETCH-0.1

Pulls the museum's print catalogue to a local JSON cache. Deliberately split from
`picasso_paris_ingest.py` for the same reason `met_ingest.py` reads MetObjects.csv and
`bm_ingest.py` reads a captured JSON file rather than fetching live: an ingest that
re-fetches on every run can't be re-run against identical input while a mapping bug is
being fixed, and it puts avoidable repeat load on someone else's server.

Unlike the British Museum (doc 09 §7), there is no bot wall here and no browser-driven
capture step. `api.navigart.fr` is the documented, unauthenticated REST API the museum's
own public site consumes (`api.navigart.fr/getting_started.html`); vault `16` is
Picasso-Paris. The whole print catalogue is 23 requests.

Rights, carried here so it's visible at the point of collection rather than only in the
loader — see the survey note §9 for the full position:

  - Picasso is in copyright until end-2043. Records carry `© Succession Picasso`.
  - `museepicassoparis.fr/robots.txt` sets `Content-Signal: ai-train=no, use=reference`,
    an express Article 4 EU DSM reservation of text-and-data-mining rights. The API host
    itself reserves nothing, but this project treats the museum's own reservation as the
    operative intent rather than routing around an opt-out on a hostname technicality.
  - This fetch therefore takes METADATA ONLY. It does not download images. The record's
    image URL is captured so the graph can cite it; nothing pulls the bytes. Adding an
    image-download pass is a separate decision with an ADR-0002 amendment attached to
    it, not a flag on this script.

Usage:
    python knowledge_graph/picasso_paris_fetch.py                 # all prints (Estampe)
    python knowledge_graph/picasso_paris_fetch.py --domain Dessin # another domain
    python knowledge_graph/picasso_paris_fetch.py --limit 200     # small sample
"""

import argparse
import json
import os
import time
import urllib.parse
import urllib.request

API_BASE = "https://api.navigart.fr/16/artworks"
USER_AGENT = "PrintMasterAI/0.1 (research; contact via repository)"
PAGE_SIZE = 100
SLEEP_SECONDS = 0.4

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "benchmark", "data", "picasso_paris",
)


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_domain(domain="Estampe", limit=None):
    """Returns the `ua` payloads (artwork + medias + authors) for one `tree_domain_all`
    value. Paginated with from/size per the API docs; `filteredCount` is checked against
    what actually came back so a silent short read shows up as a mismatch, not as a
    quietly smaller ingest."""
    records, expected = [], None
    for start in range(0, 100_000, PAGE_SIZE):
        qs = urllib.parse.urlencode({
            "size": PAGE_SIZE,
            "from": start,
            "filters": f"tree_domain_all:{domain}",
        })
        page = _get(f"{API_BASE}?{qs}")
        if expected is None:
            expected = page.get("filteredCount")
            print(f"[FETCH] domain={domain} filteredCount={expected}", flush=True)
        results = page.get("results") or []
        if not results:
            break
        records.extend(r["_source"]["ua"] for r in results)
        print(f"[FETCH] {len(records)}/{expected}", flush=True)
        if limit and len(records) >= limit:
            records = records[:limit]
            break
        time.sleep(SLEEP_SECONDS)

    if not limit and expected is not None and len(records) != expected:
        print(f"[WARN] fetched {len(records)} but API reported {expected} — short read, "
              f"do not ingest this cache without checking why", flush=True)
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", default="Estampe", help="tree_domain_all value")
    parser.add_argument("--limit", type=int, help="Cap the number of records")
    args = parser.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)
    out = os.path.join(CACHE_DIR, f"{args.domain.lower()}.json")
    recs = fetch_domain(args.domain, args.limit)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(recs, f, ensure_ascii=False)
    print(f"[DONE] {len(recs)} records -> {out}", flush=True)
