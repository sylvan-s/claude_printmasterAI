"""
PrintMasterAI — repair Forum EditionRun sizes that are really inch fractions.
Version: FORUM-EDITION-FRACTION-REPAIR-1.0

Forum's extract read the first imperial fraction in "510 x 647mm (20 x 25 3/8in)" as the
edition size, so Forum EditionRuns carry declaredSize 2, 4, 8 or 16 where no edition was
stated. See forum_edition_size.py for the rule and its accepted cost.

For every Forum EditionRun (id `forum-<lotId>-er`) sized 2/4/8/16 with no marker:
  - the catalogue.csv row for that lot says "edition of <size>"  -> CONFIRM: keep the size,
    set editionSizeConfirmed = true
  - it does not                                                  -> CLEAR: declaredSize = null,
    keep the old value in declaredSizeBefore
  - no CSV row, or the CSV size differs from the graph           -> HOLD: untouched, listed
Every written run is stamped editionSizeRepair = VERSION and editionSizeRepairedAt.

Dry run is the DEFAULT. Nothing is written without --apply.

  python3 knowledge_graph/repair_forum_edition_fractions.py            # dry run: report + plan CSV
  python3 knowledge_graph/repair_forum_edition_fractions.py --apply    # write
  python3 knowledge_graph/check_forum_edition_fractions.py             # verify afterwards

After applying: re-export sales, rebuild priors + column means + calibration; that changes
live prices, so it is a separate, deliberate step.
"""

import argparse
import os
import re
import statistics
from collections import Counter
from datetime import datetime, timezone

import pandas as pd
from dotenv import load_dotenv
from neo4j import GraphDatabase

from forum_edition_size import FRACTION_DENOMINATORS, is_fraction_edition

VERSION = "FORUM-EDITION-FRACTION-REPAIR-1.0"
CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/forum/catalogue.csv"
PLAN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forum_edition_fraction_repair_plan.csv")
LOT_ID_RE = re.compile(r"-(\d+)$")

READ = """
MATCH (er:EditionRun)
WHERE er.id STARTS WITH 'forum-' AND er.declaredSize IN $sizes AND er.editionSizeRepair IS NULL
OPTIONAL MATCH (er)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
OPTIONAL MATCH (a:Artist)-[:CREATED]->(:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN er.id AS erId, er.declaredSize AS size, a.name AS artist, i.sourceTitle AS title,
       i.rawMedium AS medium, i.signed AS signed, s.sold AS sold, s.hammerPriceGBP AS hammerGBP,
       s.saleDate AS saleDate, s.listingUrl AS url
"""

WRITE = """
UNWIND $rows AS row
MATCH (er:EditionRun {id: row.erId})
WHERE er.declaredSize = row.size AND er.editionSizeRepair IS NULL
SET er.editionSizeRepair = $version, er.editionSizeRepairedAt = $at
FOREACH (_ IN CASE WHEN row.action = 'confirm' THEN [1] ELSE [] END | SET er.editionSizeConfirmed = true)
FOREACH (_ IN CASE WHEN row.action = 'clear' THEN [1] ELSE [] END |
  SET er.declaredSizeBefore = row.size, er.declaredSize = null)
RETURN count(er) AS n
"""


def csv_index():
    df = pd.read_csv(CSV_PATH, low_memory=False)
    out = {}
    for r in df.itertuples():
        m = LOT_ID_RE.search(str(r.lot_url).rstrip("/"))
        if m:
            out[m.group(1)] = (r.edition_size, r.edition_note)
    return out


def plan_rows(graph_rows, index):
    plan = []
    for g in graph_rows:
        lot_id = g["erId"][len("forum-"):-len("-er")]
        src = index.get(lot_id)
        if src is None:
            action, why = "hold", "no catalogue.csv row for this lot"
        elif pd.isna(src[0]) or int(src[0]) != g["size"]:
            action, why = "hold", f"catalogue.csv edition_size {src[0]} differs from graph {g['size']}"
        elif is_fraction_edition(g["size"], src[1]):
            action, why = "clear", "no 'edition of N' in the note"
        else:
            action, why = "confirm", f"note: {src[1]}"
        plan.append({**g, "lotId": lot_id, "action": action, "reason": why,
                     "editionNote": None if src is None or pd.isna(src[1]) else src[1]})
    return plan


def report(plan):
    df = pd.DataFrame(plan)
    priced = df["sold"].fillna(False).astype(bool) & (df["hammerGBP"].fillna(0) > 0)
    print(f"\nForum EditionRuns sized {sorted(FRACTION_DENOMINATORS)} without a repair marker: {len(df):,}")
    print("\nby action (all / sold with a hammer):")
    for a in ["clear", "confirm", "hold"]:
        print(f"  {a:8s} {int((df.action == a).sum()):6,} / {int(((df.action == a) & priced).sum()):,}")
    print("\nclear, by old size:", dict(Counter(df[df.action == "clear"]["size"])))
    c = df[(df.action == "clear") & priced]
    print("\nclear, sold with a hammer — top artists:")
    for name, n in Counter(c["artist"]).most_common(12):
        print(f"  {n:5d}  {name}")
    tech = c["medium"].fillna("").str.lower().str.extract(
        r"(offset|screenprint|etching|lithograph|woodcut|linocut|aquatint|engraving|pigment|giclee|inkjet)")[0].fillna("other")
    print("\nclear, sold with a hammer — medium:", dict(Counter(tech).most_common()))
    if len(c):
        print(f"\nclear, median hammer £{statistics.median(c['hammerGBP']):,.0f}; "
              f"{int(c['signed'].fillna(False).astype(bool).sum()):,} of {len(c):,} signed")
    for a in ["confirm", "hold"]:
        sub = df[df.action == a]
        if len(sub):
            print(f"\n{a} examples:")
            for r in sub.head(6).itertuples():
                print(f"  {r.erId}  {r.artist} — {r.title}  size {r.size}  ({r.reason})")
    print("\nclear examples:")
    for r in df[df.action == "clear"].sample(min(8, int((df.action == 'clear').sum())), random_state=7).itertuples():
        print(f"  {r.erId}  {r.artist} — {r.title}  size {r.size}  {r.medium}  £{r.hammerGBP or 0:,.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write to the graph (default: dry run)")
    args = ap.parse_args()
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    try:
        with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
            graph_rows = [dict(r) for r in s.run(READ, sizes=sorted(FRACTION_DENOMINATORS))]
            plan = plan_rows(graph_rows, csv_index())
            report(plan)
            pd.DataFrame(plan).to_csv(PLAN_PATH, index=False)
            print(f"\nplan written to {PLAN_PATH}")
            if not args.apply:
                print("\nDRY RUN: no writes made. Re-run with --apply to write.")
                return
            # One row per EditionRun: a run under two artists (forum-153209-er, Braque and Matisse)
            # comes back twice from READ, and a duplicate in one UNWIND batch wrote a null
            # declaredSizeBefore on the 2026-09-17 run (restored by hand to 2).
            rows = list({p["erId"]: {"erId": p["erId"], "size": p["size"], "action": p["action"]}
                         for p in plan if p["action"] != "hold"}.values())
            at = datetime.now(timezone.utc).isoformat()
            n = 0
            for i in range(0, len(rows), 500):
                n += s.run(WRITE, rows=rows[i:i + 500], version=VERSION, at=at).single()["n"]
            print(f"\nAPPLIED: {n:,} of {len(rows):,} EditionRuns written ({VERSION})")
    finally:
        drv.close()


if __name__ == "__main__":
    main()
