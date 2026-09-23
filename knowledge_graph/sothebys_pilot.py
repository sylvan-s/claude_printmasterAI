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
import bisect
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
    # The local dot-stripping workaround this pilot carried is gone: ARTIST-IDENTITY-RESOLVER-1.1
    # fixed the blind spot in the shared helper itself. Pre-stripping dots here would now be
    # actively wrong — it flattens leading initials onto honorifics ("D.R. Wakefield" -> "Wakefield"),
    # which is exactly the regression the helper's positional guard exists to prevent.
    n = strip_honorifics(name)
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


# Graph titles that are placeholders, not titles: the ingest names an untitled lot after its
# own sale reference. Matching on these pairs unrelated objects, so they are excluded from
# identity entirely rather than merely deprioritised.
PLACEHOLDER_TITLE = re.compile(r"^untitled\s*\(a\d+\s*lot\s*\d+\)$|^untitled$|^\W*$", re.I)


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

# Per-work prices for the SAME works, so matched titles can be compared like for like
# rather than artist-median against artist-median (which compares different objects).
WORK_PRICES = """
MATCH (a:Artist {name: $name})-[:CREATED]->(w:ConceptualWork)
      -[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sold = true AND s.priceRealisedGBP > 0
RETURN w.name AS work, collect(s.priceRealisedGBP) AS prices
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


# ---------------------------------------------------------------- FX (ADR-0016 basis)

_FX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fx_gbp_ecb.json")
with open(_FX_PATH) as _fh:
    _FX = json.load(_fh)["rates"]
_FX_DAYS = sorted(_FX)


def to_gbp(amount, currency, epoch_ms):
    """Native -> GBP at the SALE DATE, nearest preceding ECB publication day (ADR-0016).

    HKD is pegged to the USD (7.75-7.85 band) and is not in the ECB set, so it routes via USD
    at 7.8 — accurate to about 0.6%. Currencies with no rate return None rather than a guess.
    """
    if amount is None or not currency:
        return None
    if currency == "GBP":
        return float(amount)
    if not epoch_ms:
        return None
    day = time.strftime("%Y-%m-%d", time.gmtime(epoch_ms / 1000))
    i = bisect.bisect_right(_FX_DAYS, day) - 1
    if i < 0:
        return None
    rates = _FX[_FX_DAYS[i]]
    if currency == "HKD":
        usd = rates.get("USD")
        return round(float(amount) / (usd * 7.8), 2) if usd else None
    rate = rates.get(currency)
    return round(float(amount) / rate, 2) if rate else None


def pct(n, d):
    return round(100.0 * n / d, 1) if d else 0.0


def quartiles(xs):
    xs = sorted(x for x in xs if x is not None)
    if len(xs) < 4:
        return [None, None]
    return [round(xs[len(xs) // 4], 2), round(xs[(3 * len(xs)) // 4], 2)]


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

    all_ratios = []
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
            work_prices = {r["work"]: r["prices"] for r in session.run(WORK_PRICES, name=name)}
            if prof is None:
                print(f"  {name:28s} NOT IN GRAPH — skipped", flush=True)
                continue
            graph_titles = {norm_title(t): t for t in (prof["works"] or [])
                            if t and not PLACEHOLDER_TITLE.match(t.strip())}
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
                    "gbp": to_gbp(l.get("salePrice"), l.get("estimateCurrency"), l.get("endDate")),
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

            # Like-for-like: only works present on BOTH sides, compared per work.
            # Print departments only. A Sotheby's PAINTING sharing a title with a print is not a
            # comparable: "Self portrait" paired a £14.8m canvas against a £312 print before this
            # filter. Title equality alone cannot tell a unique work from an edition.
            paired = []
            for r in matched:
                if r["sold"] != "SOLD" or r["gbp"] is None:
                    continue
                if (r["dept"] or "") not in PRINT_DEPTS:
                    continue
                graph_for_work = [p for p in work_prices.get(r["graphWork"], []) if p]
                if not graph_for_work:
                    continue
                paired.append({
                    "work": r["graphWork"][:60],
                    "sothebysGBP": r["gbp"],
                    "graphMedianGBP": median(graph_for_work),
                    "graphSales": len(graph_for_work),
                    "ratio": round(r["gbp"] / median(graph_for_work), 2),
                })

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
                "matchedPrices": {
                    "pairedWorks": len({p["work"] for p in paired}),
                    "pairedLots": len(paired),
                    "sothebysMedianGBP": median([p["sothebysGBP"] for p in paired]),
                    "graphMedianGBP": median([p["graphMedianGBP"] for p in paired]),
                    "medianRatio": median([p["ratio"] for p in paired]),
                    "ratioQuartiles": quartiles([p["ratio"] for p in paired]),
                    # Pairs where the graph side rests on more than one sale: a single graph
                    # sale can be a poster of the same image, which title equality cannot see.
                    "pairsWithMultiGraphSales": sum(1 for p in paired if p["graphSales"] >= 2),
                    "medianRatioMultiGraphSales": median(
                        [p["ratio"] for p in paired if p["graphSales"] >= 2]),
                    "sothebysDearerPct": pct(sum(1 for p in paired if p["ratio"] > 1), len(paired)),
                    "top": sorted(paired, key=lambda p: -p["ratio"])[:4],
                    "bottom": sorted(paired, key=lambda p: p["ratio"])[:4],
                },
                "sampleMatched": matched[:5],
                "sampleUnmatched": unmatched[:10],
            }
            report["artists"].append(entry)
            totals["lots"] += len(lots)
            totals["sold"] += len(sold)
            totals["matched"] += len(matched)
            totals["unsoldWithPrice"] += len(unsold_with_price)
            totals["pairedLots"] += len(paired)
            all_ratios.extend(p["ratio"] for p in paired)

            print(
                f"  {name[:26]:26s} sothebys {len(lots):5d} lots / {len(sold):5d} sold"
                f" | exact-title match {len(matched):4d} ({entry['identity']['matchRatePct']:4.1f}%)"
                f" | paired {len(paired):4d} lots, median ratio "
                f"{entry['matchedPrices']['medianRatio'] if paired else '-'}",
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
        "pairedLots": totals["pairedLots"],
        "medianRatioAcrossPairedLots": median(all_ratios),
        "ratioQuartiles": quartiles(all_ratios),
        "sothebysDearerPct": pct(sum(1 for r in all_ratios if r > 1), len(all_ratios)),
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
