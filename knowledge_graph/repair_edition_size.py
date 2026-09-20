"""
PrintMasterAI — re-derive EditionRun.declaredSize after the EDITION-SIZE-1.1 ingest fix.
Version: EDITION-SIZE-REPAIR-1.0

See edition_size.py for the gap. Through EDITION-SIZE-1.0 the ingest rule serving bonhams_ingest
and swann_ingest could not read "No. 45/250" or the "in pencil" filler, so it either stored no
edition size at all or fell through to an "edition of N" naming a DIFFERENT run mentioned in
parentheses. Measured 2026-09-20 over all 138,740 rawMedium rows: 344 impressions in the houses
that consume this rule, 325 with no size and 19 with a wrong one. Every one of the 19 was
reviewed individually; all were the parenthetical-run failure, several severe —
"numbered in pencil 151/500 (aside from the edition of 3000 with text)" stored as 3000, and
"98/180 (there was also and edition of 10 in Roman numerals)" stored as 10, which put a sold lot
in the <=30 edition band.

This script re-runs size_from_text_ingest over exactly the text the ingest fed it
(Impression.rawMedium, stored verbatim from detail_text / lotDescription) and writes
EditionRun.declaredSize where EDITION-SIZE-1.1 disagrees with the stored value.

Scope: bonhams-* and swann-* impressions only. Those are the two adapters that call this rule.
Roseberys and Forum take their edition size from the TypeScript extract column, not from here,
so their rows are out of scope even where the rule would now read them differently.

Safety rule, as COPY-TYPE-BAT-REPAIR-1.0: a row is changed only if its stored declaredSize
equals what the OLD (1.0) rule returns for the same text. Anything else — a size since edited by
hand, set by a backfill, or sourced from somewhere other than this rule — is reported and left
alone. EditionRun is 1:1 with Impression (verified 2026-09-20: 141,389 runs, all fan-out 1), so
a write cannot reach another record.

The old value is kept as `declaredSizeBeforeRepair`, every changed node gets
`declaredSizeRepairedAt`, and the full plan is snapshotted before the first write.

declaredSize feeds pricing: export_sales.py -> train_price_model.edition_size/edition_band, and
price_attrs.ts editionSizeOf on live lots. After a write: re-export sales, rebuild priors, re-run
the blend calibration, in that order.

  python3 knowledge_graph/repair_edition_size.py --dry-run   # report + plan CSV, no writes
  python3 knowledge_graph/repair_edition_size.py             # snapshot, apply, verify
  python3 knowledge_graph/repair_edition_size.py --verify    # post-hoc audit only

Requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD (set -a; source knowledge_graph/.env; set +a).
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

from neo4j import GraphDatabase

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edition_size import size_from_text_ingest, _EDITION_NUMBER, _INGEST_EDITION_OF_RE  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# The EDITION-SIZE-1.0 rule, verbatim, so the safety check can confirm a stored value is still
# exactly what the old ingest produced before replacing it. Do not "tidy" this to match 1.1.
_OLD_NUMBERED_FRACTION_RE = re.compile(
    r"number(?:ed)?\s+['\"]?[ivxlcdm\d]+\s*/\s*" + _EDITION_NUMBER, re.IGNORECASE)


def legacy_size_from_text_ingest(text):
    for rx in (_OLD_NUMBERED_FRACTION_RE, _INGEST_EDITION_OF_RE):
        m = rx.search(text or "")
        if m:
            return int(m.group(1).replace(",", ""))
    return None


SCAN = """
MATCH (er:EditionRun)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE i.rawMedium IS NOT NULL AND (i.id STARTS WITH 'bonhams-' OR i.id STARTS WITH 'swann-')
RETURN i.id AS impressionId, er.id AS editionRunId, i.rawMedium AS text,
       er.declaredSize AS stored, er.declaredSizeBeforeRepair AS alreadyRepaired,
       s.institutionName AS house, coalesce(s.sold, false) AS sold
"""

WRITE = """
UNWIND $rows AS row
MATCH (er:EditionRun {id: row.editionRunId})
SET er.declaredSizeBeforeRepair = row.stored,
    er.declaredSize             = row.newSize,
    er.declaredSizeRepairedAt   = $ts
RETURN count(er) AS updated
"""

VERIFY = """
MATCH (er:EditionRun)-[:INCLUDES]->(i:Impression)
WHERE er.declaredSizeRepairedAt IS NOT NULL
RETURN i.id AS impressionId, i.rawMedium AS text, er.declaredSize AS stored
"""


def load_env():
    path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    if not os.environ.get("NEO4J_URI"):
        raise RuntimeError("NEO4J_URI is not set. set -a; source knowledge_graph/.env; set +a")


def driver():
    return GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ.get("NEO4J_USERNAME") or os.environ.get("NEO4J_USER"),
              os.environ["NEO4J_PASSWORD"]))


def build_plan(session):
    plan, skipped = [], Counter()
    for r in session.run(SCAN):
        text, stored = r["text"], r["stored"]
        new = size_from_text_ingest(text)
        if new == stored:
            continue
        if r["alreadyRepaired"] is not None:
            skipped["already repaired by a previous run"] += 1
            continue
        if stored != legacy_size_from_text_ingest(text):
            # stored did not come from this rule — a backfill, a hand edit, another process
            skipped["stored value is not what the 1.0 rule produced"] += 1
            continue
        plan.append({"impressionId": r["impressionId"], "editionRunId": r["editionRunId"],
                     "stored": stored, "newSize": new, "house": r["house"],
                     "sold": r["sold"], "text": " ".join(text.split())[:300]})
    return plan, skipped


def report(plan, skipped):
    kinds = Counter("gains a size" if p["stored"] is None else "replaces a size" for p in plan)
    print(f"\nplanned changes: {len(plan)}")
    for k, c in kinds.most_common():
        print(f"  {c:>5}  {k}")
    by_house = Counter(p["house"] for p in plan)
    for h, c in by_house.most_common():
        print(f"  {c:>5}  {h}")
    print(f"  {sum(1 for p in plan if p['sold']):>5}  of which sold")
    if skipped:
        print("\nskipped (left alone):")
        for k, c in skipped.most_common():
            print(f"  {c:>5}  {k}")
    replaces = [p for p in plan if p["stored"] is not None]
    if replaces:
        print(f"\nall {len(replaces)} value REPLACEMENTS (review individually):")
        for i, p in enumerate(sorted(replaces, key=lambda x: x["impressionId"]), 1):
            print(f"{i:3}. {p['impressionId']}  {p['stored']} -> {p['newSize']}  sold={p['sold']}")
            print(f"     {p['text'][:190]}")


def write_plan_csv(plan, path):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["impressionId", "editionRunId", "stored",
                                           "newSize", "house", "sold", "text"])
        w.writeheader()
        w.writerows(plan)
    print(f"\nplan written to {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report + plan CSV, no writes")
    ap.add_argument("--verify", action="store_true", help="post-hoc audit only")
    ap.add_argument("--backup", help="snapshot path (default: edition_size_repair_presnapshot_<ts>.json)")
    args = ap.parse_args()
    load_env()
    ts = datetime.now(timezone.utc).isoformat()

    with driver() as d, d.session() as session:
        if args.verify:
            bad = [r["impressionId"] for r in session.run(VERIFY)
                   if r["stored"] != size_from_text_ingest(r["text"])]
            print(f"verify: {len(bad)} repaired rows disagree with EDITION-SIZE-1.1")
            for b in bad[:20]:
                print("  ", b)
            sys.exit(1 if bad else 0)

        plan, skipped = build_plan(session)
        report(plan, skipped)
        write_plan_csv(plan, os.path.join(HERE, "edition_size_repair_plan.csv"))
        if args.dry_run:
            print("\n--dry-run: nothing written.")
            return
        if not plan:
            print("\nnothing to do.")
            return

        snap = args.backup or os.path.join(
            HERE, f"edition_size_repair_presnapshot_{ts.replace(':', '').replace('-', '')}.json")
        with open(snap, "w") as fh:
            json.dump({"takenAt": ts, "version": "EDITION-SIZE-REPAIR-1.0", "rows": plan}, fh, indent=2)
        print(f"snapshot: {snap}")

        updated = session.run(WRITE, rows=plan, ts=ts).single()["updated"]
        print(f"updated {updated} EditionRun nodes")

        bad = [r["impressionId"] for r in session.run(VERIFY)
               if r["stored"] != size_from_text_ingest(r["text"])]
        print(f"verify: {len(bad)} repaired rows disagree with EDITION-SIZE-1.1")
        sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
