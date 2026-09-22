#!/usr/bin/env python3
"""A0793 interest logger, Artsy side.

Roseberys' A0793 is also carried on Artsy (498 of the 533 lots) as
"Roseberys: Prints & Multiples", live bidding 2026-09-23 09:00Z. Artsy exposes a
SECOND, independent interest signal: collectorSignals.auction.lotWatcherCount —
saves by Artsy users, a different audience from Roseberys' own wishlist count.

That field goes NULL the moment the sale closes and Artsy offers no backfill, so
it only exists if snapshotted while bidding is open. Hence this logger.

Each run appends one line to artsy_polls.jsonl:
  {t, lots: [[lot, watchers, bidCount, bidderPositions, highBidPence, minNextPence, sold]]}
and writes artsy_catalogue.json once (static: slug/artist/title/estimates).

Sibling of tests/backtest/output/A0793_interest/interest_logger.mts (the Roseberys-API
side); separate output files, no overlap.
"""
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

SALE = "roseberys-prints-and-multiples-873afb36-bafc-47ef-ae8c-03cbf45f9901"
URL = "https://metaphysics-cdn.artsy.net/v2"
# Script lives in the source tree; its data stays with the rest of the A0793 series.
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
                   "tests", "backtest", "output", "A0793_interest")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

NODE = """node{slug artistNames title isSold
  saleArtwork{lotLabel currency lowEstimate{cents} highEstimate{cents}
    highestBid{cents} minimumNextBid{cents} counts{bidderPositions}}
  collectorSignals{increasedInterest auction{lotWatcherCount bidCount liveBiddingStarted}}}"""


def gq(query, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                URL, data=json.dumps({"query": query}).encode(),
                headers={"Content-Type": "application/json", "User-Agent": UA})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 + 3 * attempt)


def fetch_lots():
    out, after = [], None
    for _ in range(12):
        cursor = f',after:"{after}"' if after else ""
        data = gq('query{sale(id:"%s"){isClosed artworksConnection(first:100%s){'
                  'pageInfo{hasNextPage endCursor}edges{%s}}}}' % (SALE, cursor, NODE))
        sale = (data.get("data") or {}).get("sale")
        if not sale:
            raise RuntimeError(json.dumps(data)[:300])
        conn = sale["artworksConnection"]
        out += [e["node"] for e in conn["edges"]]
        if not conn["pageInfo"]["hasNextPage"]:
            return out, sale["isClosed"]
        after = conn["pageInfo"]["endCursor"]
        time.sleep(0.4)
    return out, sale["isClosed"]


def cents(node, *path):
    for key in path:
        node = (node or {}).get(key)
        if node is None:
            return None
    return node


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    lots, closed = fetch_lots()

    def lot_no(node):
        label = ((node.get("saleArtwork") or {}).get("lotLabel") or "").strip()
        digits = "".join(c for c in label if c.isdigit())
        return int(digits) if digits else 0

    lots.sort(key=lot_no)
    rows = []
    for node in lots:
        sa = node.get("saleArtwork") or {}
        auction = ((node.get("collectorSignals") or {}).get("auction")) or {}
        rows.append([
            (sa.get("lotLabel") or "").strip(),
            auction.get("lotWatcherCount"),
            auction.get("bidCount"),
            (sa.get("counts") or {}).get("bidderPositions"),
            cents(sa, "highestBid", "cents"),
            cents(sa, "minimumNextBid", "cents"),
            1 if node.get("isSold") else 0,
        ])
    with open(os.path.join(DIR, "artsy_polls.jsonl"), "a") as fh:
        fh.write(json.dumps({"t": now, "closed": bool(closed), "lots": rows}) + "\n")

    cat_path = os.path.join(DIR, "artsy_catalogue.json")
    if not os.path.exists(cat_path):
        with open(cat_path, "w") as fh:
            json.dump([{
                "lot": (n.get("saleArtwork") or {}).get("lotLabel"),
                "slug": n.get("slug"), "artist": n.get("artistNames"), "title": n.get("title"),
                "low": cents(n.get("saleArtwork"), "lowEstimate", "cents"),
                "high": cents(n.get("saleArtwork"), "highEstimate", "cents"),
                "currency": (n.get("saleArtwork") or {}).get("currency"),
            } for n in lots], fh, indent=1, ensure_ascii=False)

    watchers = sum(r[1] or 0 for r in rows)
    bids = sum(r[2] or 0 for r in rows)
    blank = sum(1 for r in rows if r[1] is None)
    print(f"{now}: {len(rows)} lots, {watchers} watchers, {bids} bids, "
          f"{blank} lots with no signal, closed={closed}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ} FAILED {exc}", flush=True)
        sys.exit(1)
