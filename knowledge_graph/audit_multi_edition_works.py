"""
PrintMasterAI — audit the ConceptualWorks that carry more than one declared edition size.
Version: MULTI-EDITION-AUDIT-1.0

Scan only. Writes nothing to Neo4j.

WHY. A within-work edition-size term needs works genuinely printed in two RUNS of different
size. `declaredSize` disagreeing across a work's EditionRuns is not that on its own: the same
disagreement is produced by a proof recorded as an edition, by two states of one plate, by a
deluxe issue described inside the trade edition's own catalogue line, and by a parse error.
Measured 2026-09-20 over 712 such works, the size ratio alone cannot tell these apart — the
distinguishing evidence is in the impression's own `rawMedium` text, which is why this audit
reads it instead of thresholding the numbers.

Note also that EditionRun NODES are per-record artefacts (`{objectId}-er`), so 17,221 works
have several while only these 712 have several declared SIZES. Counting runs is not counting
editions, and nothing here should be read as a count of editions.

THE CLASSES, in the order they are tested — first match wins, because the reasons compound
(a proof of a second state is a proof for this purpose):

  implausible_size   a size no edition takes (< 5, or > 25,000), or a size equal to a whole
                     number that is plainly a dimension in the same line.

                     TREAT THIS BUCKET AS A QUEUE, NOT A VERDICT. Checked against the text on
                     2026-09-20, most of its members are not defects: a genuine edition of 3
                     exists, and a large size is usually real ("numbered 65705/69996"). Across
                     the whole graph only 2 EditionRuns held an impossible value (declaredSize
                     0, from the catalogue typos "14/00" and "1/0"), and both were cleared —
                     edition_band() reads 0 as the <=30 band rather than as unknown, so a zero
                     silently priced those as tiny editions.
  proof_or_aside     the smaller run's text says proof / artist's proof / printer's proof /
                     hors commerce / "aside from the edition". An aside is not a second run —
                     but it is not a data defect either: "numbered 23/30 (aside from the
                     edition of 60)" is a real parallel issue, correctly stored. This bucket
                     excludes a work from the within-work estimate; it does not condemn it.
  state_variant      the text names a state ("2nd state", "état"). States belong to ONE work
                     (ADR-0017) and their runs are not comparable as edition sizes.
  one_publication    both sizes appear in a single record's own text ("edition of 950, there
                     were also 50 on Japon"). One publication issued on two papers: real, but
                     the price difference is paper and issue, not scarcity.
  copy_type_conflict the runs differ in copyType (a poster against an original, say), so the
                     comparison is not like for like.
  candidate          none of the above — a genuine pair of runs, usable for the within-work
                     estimate.

Usage (source .env first):
    python3 audit_multi_edition_works.py --scan
    python3 audit_multi_edition_works.py --scan --json audit.json --csv audit.csv
"""

import argparse
import csv
import json
import os
import re
from collections import Counter, defaultdict

from neo4j import GraphDatabase

VERSION = "MULTI-EDITION-AUDIT-1.0"
MIN_PLAUSIBLE = 5
MAX_PLAUSIBLE = 25000

PROOF = re.compile(
    r"\b(artist'?s? proof|printer'?s? proof|proof|epreuve|épreuve|hors commerce|h\.?c\.?|"
    r"bon à tirer|bat|trial|aside from the edition|apart from the edition|outside the edition)\b",
    re.I)
STATE = re.compile(r"\b(\d(?:st|nd|rd|th) state|state [ivx]+|first state|second state|third state|"
                   r"final state|état|etat)\b", re.I)
# "edition of 950 (there were also 50 on Japon)" — one catalogue line naming both runs.
ALSO = re.compile(r"\b(there (?:were|are) also|plus an edition of|aside from|as well as|"
                  r"in addition to)\b", re.I)

WORKS_QUERY = """
MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)
WITH cw, collect(DISTINCT er.declaredSize) AS raw
WITH cw, [x IN raw WHERE x IS NOT NULL] AS sizes
WHERE size(sizes) > 1
MATCH (cw)-[:PRINTED_AS]->(er2:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (s:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (a:Artist)-[:CREATED]->(cw)
RETURN cw.id AS workId, cw.name AS name, a.name AS artist, sizes,
       collect(DISTINCT {size: er2.declaredSize, medium: coalesce(i.rawMedium, ''),
                         copyType: i.copyType, sold: s.sold, price: s.hammerPriceGBP,
                         house: s.institutionName}) AS records
"""


def dimension_numbers(text):
    """Numbers that are plainly measurements in the same line — the shape both edition-parsing
    bugs produced (an inch fraction, a thousands separator read as a size).

    EXACT integers only. Truncating a float to an int made this a false-positive machine: a
    sheet "60.5 x 45cm" flagged a genuine edition of 60, and 18 of the first run's 68
    implausible_size verdicts were nothing but that."""
    out = set()
    for m in re.finditer(r"(\d[\d,.]*)\s*(?:x|×)\s*(\d[\d,.]*)", text or ""):
        for g in m.groups():
            try:
                v = float(g.replace(",", ""))
            except ValueError:
                continue
            if v.is_integer():
                out.add(int(v))
    return out


def classify(work):
    sizes = sorted({int(s) for s in work["sizes"]})
    records = work["records"]
    by_size = defaultdict(list)
    for r in records:
        if r["size"] is not None:
            by_size[int(r["size"])].append(r)
    text_all = " ".join((r["medium"] or "") for r in records)

    bad = [s for s in sizes if s < MIN_PLAUSIBLE or s > MAX_PLAUSIBLE]
    for s in sizes:
        if s not in bad and any(s in dimension_numbers(r["medium"]) for r in by_size.get(s, [])):
            bad.append(s)
    if bad:
        return "implausible_size", f"sizes {sorted(bad)} are not edition sizes"

    smallest = sizes[0]
    small_text = " ".join((r["medium"] or "") for r in by_size.get(smallest, []))
    if PROOF.search(small_text):
        return "proof_or_aside", f"the {smallest} run reads as a proof or an aside"
    if STATE.search(text_all):
        return "state_variant", "the records name a state"
    for r in records:
        t = r["medium"] or ""
        if ALSO.search(t) and sum(1 for s in sizes if str(s) in t) > 1:
            return "one_publication", "one record's text names both runs"
    types = {r["copyType"] for r in records if r["copyType"]}
    if len(types) > 1:
        return "copy_type_conflict", f"copyType differs: {sorted(types)}"
    return "candidate", f"{len(sizes)} runs: {sizes}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true", help="required — this script has no write mode")
    ap.add_argument("--json", dest="out_json")
    ap.add_argument("--csv", dest="out_csv")
    args = ap.parse_args()
    if not args.scan:
        ap.error("Provide --scan (this script has no write mode by design)")
    for var in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
        if not os.environ.get(var):
            raise RuntimeError(f"{var} is not set. Source .env first.")

    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
        works = session.run(WORKS_QUERY).data()
    driver.close()

    tally, out = Counter(), []
    for w in works:
        verdict, why = classify(w)
        tally[verdict] += 1
        priced = defaultdict(list)
        for r in w["records"]:
            if r["sold"] and r["price"] and r["size"] is not None:
                priced[int(r["size"])].append(r["price"])
        out.append({**w, "verdict": verdict, "why": why,
                    "pricedSizes": {k: len(v) for k, v in priced.items()},
                    "usableForEstimate": verdict == "candidate" and len(priced) > 1})

    print(f"{VERSION}: {len(works)} works carry more than one declared edition size\n")
    for verdict, n in tally.most_common():
        print(f"  {verdict:20} {n:4}  ({100 * n / len(works):4.1f}%)")
    usable = [w for w in out if w["usableForEstimate"]]
    solid = [w for w in usable if sum(w["pricedSizes"].values()) >= 4
             and min(w["pricedSizes"].values()) >= 2]
    print(f"\nusable for a within-work estimate (candidate, priced at 2+ sizes): {len(usable)}")
    print(f"  of those, >=2 sales on every priced size: {len(solid)}")
    print("\nexamples of each verdict:")
    seen = set()
    for w in out:
        if w["verdict"] in seen:
            continue
        seen.add(w["verdict"])
        print(f"  [{w['verdict']}] {str(w['artist'])[:22]:24} {w['name'][:40]:42} "
              f"sizes={sorted(int(s) for s in w['sizes'])} — {w['why']}")

    if args.out_json:
        json.dump(out, open(args.out_json, "w"), indent=1, default=str)
        print(f"\nfull results -> {args.out_json}")
    if args.out_csv:
        with open(args.out_csv, "w", newline="") as fh:
            wr = csv.writer(fh)
            wr.writerow(["verdict", "usableForEstimate", "artist", "work", "workId", "sizes",
                         "pricedSizes", "why"])
            for w in out:
                wr.writerow([w["verdict"], w["usableForEstimate"], w["artist"], w["name"],
                             w["workId"], sorted(int(s) for s in w["sizes"]),
                             json.dumps(w["pricedSizes"]), w["why"]])
        print(f"CSV -> {args.out_csv}")


if __name__ == "__main__":
    main()
