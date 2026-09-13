"""
PrintMasterAI — Artist merge candidates from a SHARED IMAGE, not a shared style.
Version: ARTIST-IMAGE-CANDIDATES-1.0

    python3 find_artist_candidates_by_shared_image.py --out artist_image_candidates.csv

WHAT MAKES THIS DIFFERENT FROM `find_artist_merge_candidates.py`. That one starts from the
NAME — token-subset containment, grouped by surname — and uses DINOv2 cross-similarity between
the two artists' whole image sets as a corroborator, against a per-artist background. It is
asking "do these two names belong to one hand?".

This asks a narrower and much harder-to-fake question: "is this the SAME OBJECT catalogued under
two artist names?" It starts from the image, takes each embedded DigitalImage's nearest
neighbours, and keeps the ones whose works hang off different Artist nodes.

WHY THAT MATTERS. The name-first pass cannot reach a duplicate whose name it rejects up front.
Measured 2026-09-13: James Abbott McNeill Whistler was four nodes (209, 44, 4 and 4 works), and
`James A McNeil Whistler` is both abbreviated AND misspelt, so token-subset fails on
mcneil/mcneill; three of the four carried no ULAN, so the Getty pass could not link them either.
The same Billingsgate etching under three artist names at cosine 0.93-0.97 is what found them.

THE THRESHOLD SEPARATES TWO DIFFERENT PHENOMENA, and is measured rather than chosen. On a
3,000-image sample, cross-artist neighbours split cleanly:

    cosine band     record problem   art-historical quotation
    >= 0.98                      2                          0
    0.95 - 0.98                 21                          0
    0.93 - 0.95                 13                          0
    0.90 - 0.93                  4                          5

Below 0.93 sit Warhol's Coca Cola against Mel Ramos's Lola Cola, and Banksy's Kate Moss against
Warhol's Marilyn — real artists quoting each other, which must never be merged. At and above it
sit records of one object. A quotation reworks the image; a duplicate record is the same
photograph. Hence --min-cos 0.93, and the band below is reported separately, never as a
candidate.

NEO4J'S SCORE IS NOT COSINE. `db.index.vector.queryNodes` returns (1+cos)/2 for a cosine index,
so every threshold here is converted as 2*score-1. Carrying a raw cosine across that boundary is
a mistake this graph has made before.

THIS EMITS A REVIEW FILE AND MERGES NOTHING (ADR-0008). Rows are routed, not decided:
`ulanConflict` is a refusal — two Getty records are two people, whatever the pictures say.
`nonArtistNode` and `collective` are data cleanup, not identity. Only `nameVariant` is a merge
candidate, and it still wants a person to read it before it reaches
`merge_artists.py pairs`.
"""

import argparse
import csv
import os
import re
import statistics
import sys
from collections import defaultdict

from neo4j import GraphDatabase

NEIGHBOURS = """
MATCH (img:DigitalImage) WHERE img.embedding IS NOT NULL
WITH img ORDER BY img.id SKIP $skip LIMIT $limit
MATCH (img)-[:SHOWS]->(:Impression)<-[:INCLUDES]-(:EditionRun)<-[:PRINTED_AS]-(wa:ConceptualWork)
MATCH (aa:Artist)-[:CREATED]->(wa)
CALL db.index.vector.queryNodes('digitalImageDinov2Embedding', $k, img.embedding)
YIELD node AS nb, score
WITH img, wa, aa, nb, 2 * score - 1 AS cos
WHERE nb.id <> img.id AND cos >= $mincos
MATCH (nb)-[:SHOWS]->(:Impression)<-[:INCLUDES]-(:EditionRun)<-[:PRINTED_AS]-(wb:ConceptualWork)
MATCH (ab:Artist)-[:CREATED]->(wb)
WHERE aa.name <> ab.name
RETURN DISTINCT aa.name AS artistA, ab.name AS artistB, cos,
       wa.id AS workA, wb.id AS workB, wa.name AS titleA, wb.name AS titleB
"""

ARTISTS = """
MATCH (a:Artist) WHERE a.name IN $names
RETURN a.name AS name, a.ulanUrl AS ulan, a.dateBorn_year AS born, a.dateDied_year AS died,
       count { (a)-[:CREATED]->(:ConceptualWork) } AS works
"""

# Not artists at all: auction-house bookkeeping that reached the Artist label. 83 such nodes on
# 2026-09-13 ("Lot 106 Administration Charge", "RTO Anna Pugh").
NON_ARTIST = re.compile(r"^(property\b|moved to|amendment|rto\b|the property|lots?\s*\d)"
                        r"|receipt line|collection of|estates?\s+of", re.I)
COLLECTIVE = re.compile(r"various artists|\band others\b|\bet al\b", re.I)
# "X after Y" is a PRINTMAKER working from another artist's design, and it defeats token-subset
# containment by construction: the name literally contains the other artist's name. Found in the
# first run's output, not anticipated — George Townly Stubbs after George Stubbs (the son
# engraving his father), Henri Duchampes after Pablo Picasso, Francis Holl after William Powell
# Frith. The images are near-identical because one IS a print of the other, which is precisely
# why image evidence cannot settle it. These are two people and must never be merged.
AFTER = re.compile(r"\bafter\b", re.I)


def tokens(name):
    return {t for t in re.split(r"[^a-z]+", re.sub(r"\(.*?\)", "", (name or "").lower()))
            if len(t) > 1}


def name_relation(a, b):
    """How the two NAMES relate — evidence, not a verdict."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return "unknown"
    if ta == tb:
        return "sameTokens"
    if ta < tb or tb < ta:
        return "tokenSubset"
    shared = ta & tb
    if shared and (len(shared) >= min(len(ta), len(tb)) - 1):
        # one token differs — a misspelling or an initial. mcneil/mcneill is the case that
        # defeated the name-first pass, so it is named here rather than silently lumped in.
        return "oneTokenDiffers"
    if shared:
        return "partialOverlap"
    return "unrelated"


def route(a, b, ia, ib, relation):
    if NON_ARTIST.search(a) or NON_ARTIST.search(b):
        return "nonArtistNode"
    if COLLECTIVE.search(a) or COLLECTIVE.search(b):
        return "collective"
    if AFTER.search(a) != AFTER.search(b):
        return "afterAttribution"
    ua, ub = ia.get("ulan"), ib.get("ulan")
    if ua and ub and ua != ub:
        return "ulanConflict"          # two Getty records are two people. Never merge.
    if relation in ("sameTokens", "tokenSubset", "oneTokenDiffers"):
        return "nameVariant"
    return "differentNames"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--out", default="artist_image_candidates.csv")
    ap.add_argument("--pairs-out", help="also write the underlying work pairs")
    ap.add_argument("--min-cos", type=float, default=0.93)
    ap.add_argument("--k", type=int, default=6)
    ap.add_argument("--batch", type=int, default=2000)
    ap.add_argument("--limit", type=int, help="stop after this many images (for a sample run)")
    ap.add_argument("--from-pairs", help="skip the scan and re-aggregate an earlier --pairs-out "
                                         "file; the scan is the expensive half, the routing is "
                                         "the half that gets corrected")
    args = ap.parse_args()

    for var in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE"):
        if not os.environ.get(var):
            sys.exit(f"{var} is not set. Source .env first.")
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    rows, seen = [], set()
    if args.from_pairs:
        with open(args.from_pairs, encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        print(f"re-aggregating {len(rows):,} work pairs from {args.from_pairs}", flush=True)
        rows = [r for r in rows if float(r["cos"]) >= args.min_cos]
    try:
        with driver.session(database=os.environ["NEO4J_DATABASE"]) as s:
            if args.from_pairs:
                total = 0
            total = total if args.from_pairs else s.run(
                "MATCH (i:DigitalImage) WHERE i.embedding IS NOT NULL "
                "RETURN count(i) AS n").single()["n"]
            total = min(total, args.limit) if args.limit else total
            print(f"{total:,} embedded images, k={args.k}, cosine >= {args.min_cos}", flush=True)
            for skip in range(0, total, args.batch):
                lim = min(args.batch, total - skip)
                for r in s.run(NEIGHBOURS, skip=skip, limit=lim, k=args.k,
                               mincos=args.min_cos):
                    key = tuple(sorted((r["workA"], r["workB"])))
                    if key in seen:
                        continue
                    seen.add(key)
                    rows.append(dict(r))
                print(f"  {min(skip + lim, total):>7,}/{total:,} images  "
                      f"{len(rows):,} cross-artist work pairs", flush=True)

            names = sorted({n for r in rows for n in (r["artistA"], r["artistB"])})
            info = {}
            for i in range(0, len(names), 4000):
                for r in s.run(ARTISTS, names=names[i:i + 4000]):
                    info[r["name"]] = dict(r)
    finally:
        driver.close()

    by_pair = defaultdict(list)
    for r in rows:
        by_pair[tuple(sorted((r["artistA"], r["artistB"])))].append(r)

    out = []
    for (a, b), rs in by_pair.items():
        ia, ib = info.get(a, {}), info.get(b, {})
        rel = name_relation(a, b)
        cos = sorted(float(x["cos"]) for x in rs)
        ex = max(rs, key=lambda x: float(x["cos"]))
        out.append({
            "route": route(a, b, ia, ib, rel), "artistA": a, "artistB": b,
            "sharedImages": len(rs), "maxCos": round(cos[-1], 4),
            "medianCos": round(statistics.median(cos), 4),
            "worksA": ia.get("works", 0), "worksB": ib.get("works", 0),
            "nameRelation": rel,
            "ulanA": ia.get("ulan") or "", "ulanB": ib.get("ulan") or "",
            "bornA": ia.get("born") or "", "bornB": ib.get("born") or "",
            "diedA": ia.get("died") or "", "diedB": ib.get("died") or "",
            "datesAgree": int(bool(ia.get("born") and ia.get("born") == ib.get("born"))),
            "exampleTitleA": ex["titleA"], "exampleTitleB": ex["titleB"],
            "exampleWorkA": ex["workA"], "exampleWorkB": ex["workB"],
        })
    order = {"nameVariant": 0, "differentNames": 1, "afterAttribution": 2, "collective": 3,
             "nonArtistNode": 4, "ulanConflict": 5}
    out.sort(key=lambda r: (order.get(r["route"], 9), -r["sharedImages"], -r["maxCos"]))
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    if args.pairs_out:
        with open(args.pairs_out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    print(f"\n{len(rows):,} cross-artist work pairs -> {len(out):,} artist pairs -> {args.out}")
    counts = defaultdict(int)
    for r in out:
        counts[r["route"]] += 1
    for k in ("nameVariant", "differentNames", "afterAttribution", "collective",
              "nonArtistNode", "ulanConflict"):
        if counts[k]:
            print(f"  {k:16s} {counts[k]:>5d}")
    print("\nNothing has been merged. Feed reviewed rows to "
          "`merge_artists.py pairs`, which merges nothing on image evidence alone.")


if __name__ == "__main__":
    main()
