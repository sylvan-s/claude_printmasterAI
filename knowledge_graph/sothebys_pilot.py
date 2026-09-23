#!/usr/bin/env python3
"""Sotheby's comparables pilot — READ ONLY, no graph writes (ADR-0021).

Answers the questions that gate an ingest, for artists the graph ALREADY holds:

  1. How many Sotheby's lots exist per artist, and how many sold?
  2. What share resolve to an existing ConceptualWork by EXACT title match?
     (ADR-0017 identity, no fuzzy matching — see the two corruption incidents behind that rule.)
  3. How does Sotheby's price level compare with what the graph already holds for that artist?
  4. How often do the six known index defects actually fire?

Source: the Algolia index behind sothebys.com's own site search. There is no public Sotheby's
API; `api.sothebys.com` and `clientapi.sothebys.com` do not resolve. The app id and SEARCH-ONLY
key below are the ones their own pages ship to every visitor.

  PERMISSION: this reads a few hundred rows for a handful of named artists — the scale a person
  could do by hand. Bulk extraction is gated on ADR-0021's consent gate. Do not raise --artists
  into the hundreds to sidestep that.

Usage:
    python3 knowledge_graph/sothebys_pilot.py --artists 8
    python3 knowledge_graph/sothebys_pilot.py --artist "Elisabeth Frink" --artist "Julian Trevelyan"
    python3 knowledge_graph/sothebys_pilot.py --artists 5 --out /tmp/sothebys_pilot.json

Needs NEO4J_* in the environment (set -a; source knowledge_graph/.env; set +a).
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter

from neo4j import GraphDatabase

from resolve_artist_identity import strip_honorifics

ALGOLIA = (
    "https://o28sy4q7wu-dsn.algolia.net/1/indexes/bsp_dotcom_prod_en/query"
    "?x-algolia-application-id=O28SY4Q7WU"
    "&x-algolia-api-key=e732e65c70ebf8b51d4e2f922b536496"
)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
PAGE_SIZE = 100
# Complete books sit under Books & Manuscripts in Paris and under Prints in London/New York —
# filtering on Prints alone loses about half the Picasso Carmen record (ADR-0021).
PRINT_DEPTS = {"Prints", "Books & Manuscripts"}
POLITE_DELAY_S = 0.4


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill it in, and "
            f"export it (e.g. `set -a; source .env; set +a`) before running this script."
        )
    return value


_PUNCT = re.compile(r"[^a-z0-9]+")
_BRACKETED = re.compile(r"\[[^\]]*\]|\([^)]*\)")


# ---------------------------------------------------------------- Sotheby's

def algolia(params):
    req = urllib.request.Request(
        ALGOLIA,
        data=json.dumps({"params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def norm_artist(name):
    """Deterministic rewrite, not a similarity score: honorifics and post-nominals stripped with
    the project's own `strip_honorifics`, then case and accents folded.

    Sotheby's carries one artist under several display forms — Frink appears as
    "Dame Elisabeth Frink, R.A." (83 lots), "ELISABETH FRINK" (13) and "Dame Elisabeth Frink" (2).
    Matching the raw string finds 13 of 98. Same closed rewrite set as the artist-merge rule.
    """
    # Dots first: strip_honorifics only rstrips a trailing dot, so "R.A." survives it as
    # "R.A" and never matches the post-nominal set ("ra"). Sotheby's writes the dotted form on
    # 83 of 98 Frink lots, so skipping this drops three quarters of them. The shared helper has
    # the same blind spot for every dotted post-nominal — flagged, not patched here.
    n = strip_honorifics((name or "").replace(".", ""))
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode()
    return _PUNCT.sub(" ", n.lower()).strip()


def sothebys_lots(artist_name, max_pages=6):
    """Every Sotheby's lot whose artistName is this artist, after honorific normalisation.

    artistName is not a filterable attribute (filters=artistName:"..." returns 0 while the same
    name as free text returns hundreds), so the name goes in the query and the match is applied
    here. Free text alone is not enough: `sorel` returns 90 lots, all Sorel Etrog.
    """
    target = norm_artist(artist_name)
    out, page = [], 0
    while page < max_pages:
        res = algolia(
            f"query={urllib.parse.quote(artist_name)}&hitsPerPage={PAGE_SIZE}"
            f"&page={page}&filters=type:Lot"
        )
        hits = res.get("hits", [])
        out += [h for h in hits if norm_artist(h.get("artistName")) == target]
        if page + 1 >= res.get("nbPages", 0) or not hits:
            break
        page += 1
        time.sleep(POLITE_DELAY_S)
    return out


# ---------------------------------------------------------------- matching

def norm_title(title):
    """Normalise for comparison only — the original string is what would be stored.

    Drops bracketed catalogue references so "Marilyn (F. & S. II.26)" and "Marilyn" compare
    equal; that is a normalisation, not a fuzzy match. Nothing here is a similarity score.
    """
    t = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode().lower()
    t = _BRACKETED.sub(" ", t)
    t = re.sub(r"\b(the|a|an|from|and)\b", " ", t)
    return _PUNCT.sub("", t)


def strip_artist_prefix(heading, artist_name):
    """conciseHeading is usually "Andy Warhol, Marilyn (F. & S. II.26)" — take the title part."""
    h = (heading or "").strip()
    for sep in (f"{artist_name},", f"{artist_name} |", artist_name):
        if h.lower().startswith(sep.lower()):
            return h[len(sep):].strip(" ,|")
    return h


CR_PATTERNS = [
    r"\bF\.?\s*&\s*S\.?\s*[IVX]*\.?\s*\d+[a-zA-Z]?\b",   # Feldman & Schellmann (Warhol)
    r"\bB\.?\s*\d{2,4}\b",                                  # Bloch (Picasso)
    r"\bBa\.?\s*\d{2,4}\b",                                 # Baer
    r"\bC\.?\s*(?:bk\.?)?\s*\d{1,4}\b",                     # Cramer
    r"\bHartley\s*\d{1,4}\b",
    r"\bKemp\s*\d{1,4}\b",
    r"\bLullin\s*\d{1,4}\b",
    r"\bH\.?\s*\d{1,3}-\d{1,3}\b",                          # Hirst H7-2 etc.
]


def catalogue_refs(text):
    refs = set()
    for pat in CR_PATTERNS:
        for m in re.finditer(pat, text or "", re.I):
            refs.add(re.sub(r"\s+", " ", m.group(0)).strip().upper())
    return sorted(refs)


# ---------------------------------------------------------------- graph (read only)

ARTISTS_WITH_PRICED_ROWS = """
MATCH (a:Artist)<-[:ATTRIBUTED_TO]-(s:SourceRecord)
WHERE s.sold = true AND s.priceRealisedGBP > 0
WITH a, count(*) AS pricedRows
WHERE pricedRows >= $minRows
RETURN a.name AS name, pricedRows
ORDER BY pricedRows DESC
LIMIT $limit
"""

ARTIST_PROFILE = """
MATCH (a:Artist {name: $name})
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
WITH a, collect(DISTINCT w.name) AS works
OPTIONAL MATCH (a)<-[:ATTRIBUTED_TO]-(s:SourceRecord)
WHERE s.sold = true AND s.priceRealisedGBP > 0
RETURN works,
       count(s) AS pricedRows,
       collect(s.priceRealisedGBP) AS prices,
       collect(DISTINCT s.institutionName) AS houses
"""


def pct(n, d):
    return round(100.0 * n / d, 1) if d else 0.0


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else round((xs[mid - 1] + xs[mid]) / 2, 2)


def main():
    ap = argparse.ArgumentParser(description="Sotheby's comps pilot (read only)")
    ap.add_argument("--artists", type=int, default=8,
                    help="how many graph artists to probe, by priced-row count (default 8)")
    ap.add_argument("--artist", action="append", default=[],
                    help="probe this artist by name instead (repeatable)")
    ap.add_argument("--min-rows", type=int, default=20,
                    help="only auto-pick artists with at least this many priced rows")
    ap.add_argument("--out", default="tests/backtest/output/sothebys_pilot.json")
    args = ap.parse_args()

    driver = GraphDatabase.driver(
        _require_env("NEO4J_URI"),
        auth=(_require_env("NEO4J_USER"), _require_env("NEO4J_PASSWORD")),
    )
    database = _require_env("NEO4J_DATABASE")

    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "artists": []}
    totals = Counter()

    with driver.session(database=database) as session:
        if args.artist:
            names = args.artist
        else:
            names = [r["name"] for r in session.run(
                ARTISTS_WITH_PRICED_ROWS, minRows=args.min_rows, limit=args.artists)]

        for name in names:
            prof = session.run(ARTIST_PROFILE, name=name).single()
            if prof is None:
                print(f"  {name:28s} NOT IN GRAPH — skipped", flush=True)
                continue
            graph_titles = {norm_title(t): t for t in (prof["works"] or []) if t}
            graph_prices = [p for p in (prof["prices"] or []) if p]

            lots = sothebys_lots(name)
            sold = [l for l in lots if l.get("soldStatus") == "SOLD"]
            priced = [l for l in sold if l.get("salePrice")]
            unsold_with_price = [l for l in lots
                                 if l.get("soldStatus") != "SOLD" and l.get("salePrice")]

            matched, unmatched = [], []
            for l in lots:
                title = strip_artist_prefix(l.get("conciseHeading") or l.get("title") or "", name)
                key = norm_title(title)
                row = {
                    "title": title[:80],
                    "refs": catalogue_refs(l.get("conciseHeading") or ""),
                    "dept": (l.get("departments") or [None])[0],
                    "sold": l.get("soldStatus"),
                    "price": l.get("salePrice"),
                    "ccy": l.get("estimateCurrency"),
                    "sale": l.get("saleNumber"),
                }
                if key and key in graph_titles:
                    row["graphWork"] = graph_titles[key]
                    matched.append(row)
                else:
                    unmatched.append(row)

            print_lots = [r for r in matched + unmatched if (r["dept"] or "") in PRINT_DEPTS]
            print_matched = [r for r in matched if (r["dept"] or "") in PRINT_DEPTS]
            depts = Counter((l.get("departments") or [None])[0] for l in lots)
            ccys = Counter(l.get("estimateCurrency") for l in lots)

            entry = {
                "artist": name,
                "graph": {
                    "works": len(graph_titles),
                    "pricedRows": prof["pricedRows"],
                    "houses": prof["houses"],
                    "medianRealisedGBP": median(graph_prices),
                },
                "sothebys": {
                    "lots": len(lots),
                    "sold": len(sold),
                    "sellThroughPct": pct(len(sold), len(lots)),
                    "withPrice": len(priced),
                    "medianSalePrice": median([l["salePrice"] for l in priced]),
                    "departments": dict(depts),
                    "currencies": dict(ccys),
                },
                "identity": {
                    "exactTitleMatches": len(matched),
                    "matchRatePct": pct(len(matched), len(lots)),
                    # The honest denominator: the graph is a PRINT corpus, so a Frink bronze
                    # having no ConceptualWork is correct, not a miss.
                    "printLots": len(print_lots),
                    "printMatches": len(print_matched),
                    "printMatchRatePct": pct(len(print_matched), len(print_lots)),
                    "withCatalogueRef": sum(1 for r in matched + unmatched if r["refs"]),
                },
                "defects": {
                    "unsoldRowsCarryingAPrice": len(unsold_with_price),
                },
                "sampleMatched": matched[:5],
                "sampleUnmatched": unmatched[:10],
            }
            report["artists"].append(entry)
            totals["lots"] += len(lots)
            totals["sold"] += len(sold)
            totals["matched"] += len(matched)
            totals["unsoldWithPrice"] += len(unsold_with_price)

            print(
                f"  {name[:26]:26s} sothebys {len(lots):5d} lots / {len(sold):5d} sold"
                f" | exact-title match {len(matched):4d} ({entry['identity']['matchRatePct']:4.1f}%)"
                f" | graph has {len(graph_titles):4d} works, {prof['pricedRows']:4d} priced rows",
                flush=True,
            )
            time.sleep(POLITE_DELAY_S)

    driver.close()

    report["totals"] = {
        "lots": totals["lots"],
        "sold": totals["sold"],
        "exactTitleMatches": totals["matched"],
        "matchRatePct": pct(totals["matched"], totals["lots"]),
        "unsoldRowsCarryingAPrice": totals["unsoldWithPrice"],
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=1, ensure_ascii=False)

    t = report["totals"]
    print(f"\nTOTAL {t['lots']} Sotheby's lots, {t['sold']} sold, "
          f"{t['exactTitleMatches']} exact-title matches ({t['matchRatePct']}%), "
          f"{t['unsoldRowsCarryingAPrice']} unsold rows carrying a price")
    print(f"report -> {args.out}")
    print("READ ONLY: nothing was written to the graph.")


if __name__ == "__main__":
    sys.exit(main())
