"""
PrintMasterAI — repair EditionRun sizes truncated at a thousands separator.
Version: EDITION-THOUSANDS-REPAIR-1.0

bonhams_parsing.extract_edition_size (and the price model's own text rule) read "aside from the
edition of 1,000" as an edition of 1: the number pattern stopped at the comma. Found in the
2026-09-17 junk-sales review (Hockney "Pool Made with Paper and Blue Ink for Book", ed. 1,000,
stored as 1). BONHAMS-PARSING-1.2 fixes the parser; this repairs what the old one wrote.

For every EditionRun whose Impression description contains a number with a thousands separator:
  new = bonhams_parsing.extract_edition_size(description)   (numbered n/N first, then "edition of N")
  - FIX  when new differs from declaredSize AND declaredSize is exactly the leading group of a
         separated number in the text ("1,000" -> 1, "12,500" -> 12): the truncation signature.
         declaredSize = new; the old value goes to declaredSizeBeforeThousands.
  - HOLD anything else that disagrees (a real numbering the text also mentions, a typo): listed.
Written runs carry editionThousandsRepair = VERSION and editionThousandsRepairedAt. One row per
EditionRun (a run under two artists comes back twice from a join: see repair_forum_edition_fractions).

Dry run is the DEFAULT. Nothing is written without --apply.

  python3 knowledge_graph/repair_edition_thousands.py            # dry run: report + plan CSV
  python3 knowledge_graph/repair_edition_thousands.py --apply    # write
  python3 knowledge_graph/check_edition_thousands.py             # verify afterwards

After applying: re-export sales, rebuild priors + column means + calibration (changes live prices).
"""

import argparse
import os
import re
from collections import Counter
from datetime import datetime, timezone

import pandas as pd
from dotenv import load_dotenv
from neo4j import GraphDatabase

from bonhams_parsing import extract_edition_size

VERSION = "EDITION-THOUSANDS-REPAIR-1.0"
PLAN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edition_thousands_repair_plan.csv")
SEPARATED = re.compile(r"\b(\d{1,3})(?:,\d{3})+\b")

READ = """
MATCH (er:EditionRun)-[:INCLUDES]->(i:Impression)
WHERE er.declaredSize IS NOT NULL AND er.editionThousandsRepair IS NULL
  AND i.rawMedium =~ '(?s).*\\\\b\\\\d{1,3},\\\\d{3}\\\\b.*'
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
RETURN er.id AS erId, er.declaredSize AS size, i.rawMedium AS text,
       collect(DISTINCT s.institutionName)[0] AS house, collect(DISTINCT s.sold AND s.hammerPriceGBP > 0)[0] AS priced,
       collect(DISTINCT s.hammerPriceGBP)[0] AS hammerGBP, i.sourceTitle AS title
"""

WRITE = """
UNWIND $rows AS row
MATCH (er:EditionRun {id: row.erId})
WHERE er.declaredSize = row.before AND er.editionThousandsRepair IS NULL
SET er.declaredSizeBeforeThousands = row.before, er.declaredSize = row.after,
    er.editionThousandsRepair = $version, er.editionThousandsRepairedAt = $at
RETURN count(er) AS n
"""


def plan_rows(rows):
    seen, plan = set(), []
    for r in rows:
        if r["erId"] in seen:
            continue
        seen.add(r["erId"])
        text = r["text"] or ""
        new = extract_edition_size(text)
        size = int(r["size"])
        leading = {int(m.group(1)) for m in SEPARATED.finditer(text)}
        if new is None or new == size:
            continue                                     # nothing to change
        if size in leading and new >= 1000:
            action, why = "fix", f"stored {size} is the leading group of a separated number; parser now reads {new}"
        else:
            action, why = "hold", f"stored {size}, parser reads {new}, not the truncation signature"
        plan.append({**r, "size": size, "new": new, "action": action, "reason": why})
    return plan


def report(plan):
    df = pd.DataFrame(plan)
    if df.empty:
        print("nothing to repair"); return
    print(f"EditionRuns whose description has a separated number and whose size disagrees with the fixed parser: {len(df)}")
    for a in ["fix", "hold"]:
        sub = df[df.action == a]
        print(f"\n{a.upper()}: {len(sub)} (priced sales {int(sub.priced.fillna(False).astype(bool).sum())}); by house {dict(Counter(sub.house))}")
        if len(sub):
            print("   stored -> parsed:", dict(Counter(zip(sub["size"], sub["new"])).most_common(8)))
            for r in sub.head(8).itertuples():
                i = max(0, (r.text or "").lower().find("edition") - 40)
                print(f"   {r.erId[:44]:44s} {str(r.title)[:34]:34s} {r.size:>5} -> {r.new:<6} ...{(r.text or '')[i:i + 90]!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write to the graph (default: dry run)")
    args = ap.parse_args()
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    try:
        with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
            plan = plan_rows([dict(r) for r in s.run(READ)])
            report(plan)
            pd.DataFrame(plan).drop(columns=["text"], errors="ignore").to_csv(PLAN_PATH, index=False)
            print(f"\nplan written to {PLAN_PATH}")
            if not args.apply:
                print("\nDRY RUN: no writes made. Re-run with --apply to write.")
                return
            rows = [{"erId": p["erId"], "before": p["size"], "after": p["new"]} for p in plan if p["action"] == "fix"]
            at = datetime.now(timezone.utc).isoformat()
            n = sum(s.run(WRITE, rows=rows[i:i + 500], version=VERSION, at=at).single()["n"] for i in range(0, len(rows), 500))
            print(f"\nAPPLIED: {n:,} of {len(rows):,} EditionRuns written ({VERSION})")
    finally:
        drv.close()


if __name__ == "__main__":
    main()
