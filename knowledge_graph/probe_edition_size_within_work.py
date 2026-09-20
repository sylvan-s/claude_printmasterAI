"""
PrintMasterAI — is a smaller edition run worth more, WITHIN one work?
Version: EDITION-WITHIN-WORK-PROBE-1.0

Scan only. Writes nothing, changes no model. Run it to reproduce the 2026-09-20 numbers.

THE QUESTION. The pricing model carries edition size as a band, fitted across works, so the
coefficient absorbs whatever else edition size marks in an artist's output. For Elisabeth Frink
it comes out NEGATIVE for small editions (edition_band 31-75, logEffect -0.199) — not because
scarcity is unrewarded but because her small-edition works are the early Canterbury Tales and
Images etchings while the 76-150 band holds the Seabirds and the major screenprints. Her median
hammer by band: <=30 £700, 31-75 £1,000, 76-150 £1,200, 151-300 £1,000, >300 £1,250.

The only way to ask the question without that confound is WITHIN one work: same image, same
artist, two runs of different size.

WHAT IT MEASURES. For each ConceptualWork the audit
(`audit_multi_edition_works.py`) classes as a genuine pair of runs, the median hammer of the
smallest run against the largest, expressed as a log change per DOUBLING of edition size.

THE THREE THINGS THAT MOVE THE ANSWER, in the order they were found:

  1. Nearly-equal sizes. Picasso's Vollard Suite at 250 against 260 divides a real price gap by
     a tiny log-size change and yields an enormous slope. Requiring a ratio >= 1.5 is not
     cosmetic: without it the estimate reads -0.339, with it -0.157.
  2. The audit. Candidates -0.135 against -0.037 for the works it rejects, so the classes it
     excludes were carrying noise.
  3. SIGNATURE, which is most of what is left. The larger run is the unsigned one in 50 of 177
     pairs, and those pairs run -0.445 while pairs with the same signature status run -0.101.
     The model already prices signature separately (+0.64 log for hand-signed on Frink), so an
     edition term fitted without this control would charge the signature discount twice.

THE ANSWER, holding signature constant: **-0.101 per doubling (x0.90), bootstrap 95% CI
[-0.177, -0.002], n=120**. Real in direction, about 10% a doubling, and the interval reaches
zero.

WHAT COULD NOT BE CONTROLLED. Recency. The larger run is usually also the later one, and that
is not separable here: only 2 of 120 pairs say so in their text, and EditionRun.dateRange_year
is set from the WORK's year at ingest, not the run's, so it cannot date a run. Whatever part of
the 10% is "later printing" rather than "bigger printing" is unmeasured.

Usage (source .env first):
    python3 probe_edition_size_within_work.py --scan --audit edition_audit.json
"""

import argparse
import json
import math
import os
import random
import re
import statistics as st
from collections import defaultdict

from neo4j import GraphDatabase

VERSION = "EDITION-WITHIN-WORK-PROBE-1.0"
MIN_RATIO = 1.5
LATER = re.compile(r"\b(printed later|later printing|later edition|reissue|re-issue|restrike|"
                   r"posthumous|second printing|reprint|tirage posth)", re.I)

SALES_QUERY = """
MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)
      <-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sold = true AND s.hammerPriceGBP > 0
  AND er.declaredSize IS NOT NULL AND er.declaredSize > 0
RETURN cw.id AS work, cw.name AS name, er.declaredSize AS size, s.hammerPriceGBP AS price,
       i.signed AS signed, coalesce(i.rawMedium, '') AS medium
"""


def signed_share(records):
    known = [r for r in records if r["signed"] is not None]
    return None if not known else sum(bool(r["signed"]) for r in known) / len(known)


def slope_per_doubling(small, large, small_recs, large_recs):
    ps = st.median([r["price"] for r in small_recs])
    pl = st.median([r["price"] for r in large_recs])
    return (math.log(pl) - math.log(ps)) / (math.log(large) - math.log(small)) * math.log(2)


def bootstrap_median(values, reps=2000, seed=7):
    random.seed(seed)
    boots = sorted(st.median([random.choice(values) for _ in values]) for _ in range(reps))
    return boots[int(0.025 * reps)], boots[int(0.975 * reps) - 1]


def report(label, values):
    if len(values) < 5:
        print(f"  {label:34} n={len(values):4}  (too few to read)")
        return
    lo, hi = bootstrap_median(values)
    print(f"  {label:34} n={len(values):4}  median {st.median(values):+.3f} "
          f"(x{math.exp(st.median(values)):.2f})  95% CI [{lo:+.3f}, {hi:+.3f}]  "
          f"smaller dearer {sum(1 for v in values if v < 0)}/{len(values)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true", help="required — this probe has no write mode")
    ap.add_argument("--audit", help="audit_multi_edition_works.py --json output; without it "
                                    "every multi-size work is used and the estimate is noisier")
    ap.add_argument("--min-ratio", type=float, default=MIN_RATIO)
    args = ap.parse_args()
    if not args.scan:
        ap.error("Provide --scan (this probe has no write mode by design)")
    for var in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
        if not os.environ.get(var):
            raise RuntimeError(f"{var} is not set. Source .env first.")

    verdicts = {}
    if args.audit:
        verdicts = {w["workId"]: w["verdict"] for w in json.load(open(args.audit))}

    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
        rows = session.run(SALES_QUERY).data()
    driver.close()

    by_work = defaultdict(lambda: defaultdict(list))
    for r in rows:
        by_work[r["work"]][int(r["size"])].append(r)

    every, same_sig, less_signed, later_flagged = [], [], [], []
    for work, sizes in by_work.items():
        if verdicts and verdicts.get(work) != "candidate":
            continue
        if len(sizes) < 2:
            continue
        ordered = sorted(sizes)
        small, large = ordered[0], ordered[-1]
        if large / small < args.min_ratio:
            continue
        s_recs, l_recs = sizes[small], sizes[large]
        slope = slope_per_doubling(small, large, s_recs, l_recs)
        every.append(slope)
        a, b = signed_share(s_recs), signed_share(l_recs)
        if a is None or b is None:
            continue
        if a == b:
            same_sig.append(slope)
            if any(LATER.search(r["medium"]) for r in l_recs) and \
               not any(LATER.search(r["medium"]) for r in s_recs):
                later_flagged.append(slope)
        elif b < a:
            less_signed.append(slope)

    print(f"{VERSION} — log price change per doubling of edition size, within one work")
    print(f"(audit filter: {'on' if verdicts else 'OFF'}; minimum size ratio {args.min_ratio})\n")
    report("every candidate pair", every)
    report("larger run LESS signed", less_signed)
    report("same signature status", same_sig)
    print(f"\n  of the same-signature pairs, {len(later_flagged)} say in their text that the "
          f"larger run is a later printing — too few to control for recency, and "
          f"EditionRun.dateRange_year carries the WORK's year, not the run's.")


if __name__ == "__main__":
    main()
