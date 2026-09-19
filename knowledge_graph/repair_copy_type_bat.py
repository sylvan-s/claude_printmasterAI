"""
PrintMasterAI — re-derive Impression.copyType after the bare-"bon" BAT fix.
Version: COPY-TYPE-BAT-REPAIR-1.0

See copy_type.py for the bug (the BAT keyword "bon" matched Bonnard, bonnet, Dibond, ribbon...;
353 of 512 BAT impressions were false on 2026-09-16). This script re-runs the copy-type
detector over exactly the text each ingest fed it, and changes copyType wherever COPY-TYPE-1.1
disagrees with the stored value. That moves false BATs to what they should have been, and also
moves lots INTO BAT that the old " bat " rule missed ("annotated 'B.A.T.'").

Detector input, per adapter (must match the ingest's own call):
    bonhams-*, swann-*      Impression.rawMedium (stored verbatim from detail_text / lotDescription)
    roseberys-*, forum-*    CSV edition_note + title, joined on saleId + lotNumber

Safety rule: a row is changed only if its stored copyType equals what the OLD detector returns
for the same input. Anything else (text not recoverable, CSV key ambiguous, a copyType since
edited by hand or by another process) is reported and left alone.

The old value is kept as `copyTypeBeforeRepair`, every changed node gets `copyTypeRepairedAt`,
and the full plan is snapshotted before the first write.

copyType feeds pricing (export_sales.py -> train_price_model.proof_class, and price_attrs.ts
detectCopyType on live lots). After a write: re-export sales, rebuild priors, re-run the blend
calibration, in that order, with the price_attrs.ts change landed.

  python3 knowledge_graph/repair_copy_type_bat.py --dry-run    # report + snapshot, no writes
  python3 knowledge_graph/repair_copy_type_bat.py              # snapshot, apply, verify
  python3 knowledge_graph/repair_copy_type_bat.py --verify     # post-hoc audit only

Requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD (set -a; source knowledge_graph/.env; set +a).
"""

import argparse
import json
import os
from collections import Counter
from datetime import datetime, timezone

import pandas as pd
from neo4j import GraphDatabase

from copy_type import detect_copy_type, legacy_detect_copy_type

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
REPAIR_TAG = "copy-type-bat-1.1"
BATCH = 2000
DATA = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data"
CSVS = {
    "roseberys": [f"{DATA}/all-prints/catalogue.csv", f"{DATA}/A0793/catalogue.csv"],
    "forum": [f"{DATA}/forum/catalogue.csv"],
}
PREFIXES = ("bonhams-", "swann-", "roseberys-", "forum-")

SELECT = """
MATCH (s:SourceRecord)-[:DOCUMENTS]-(imp:Impression)
WHERE any(p IN $prefixes WHERE imp.id STARTS WITH p)
RETURN imp.id AS impressionId, s.id AS sourceId, s.institutionName AS house,
       s.saleId AS saleId, s.lotNumber AS lotNumber,
       (s.hammerPriceGBP IS NOT NULL OR s.priceRealisedGBP IS NOT NULL) AS priced,
       imp.rawMedium AS rawMedium, imp.copyType AS copyType,
       imp.copyTypeBeforeRepair AS before, imp.copyTypeRepairedAt AS repairedAt
"""

# Guarded on the stored value so a concurrent change is never overwritten.
WRITE = """
UNWIND $rows AS row
MATCH (imp:Impression {id: row.impressionId})
WHERE imp.copyType = row.oldCopyType
SET imp.copyTypeBeforeRepair = coalesce(imp.copyTypeBeforeRepair, imp.copyType),
    imp.copyType = row.newCopyType,
    imp.copyTypeRepairedAt = $now,
    imp.copyTypeRepair = $tag
RETURN count(imp) AS n
"""


def load_csv_index():
    index = {}
    for adapter, paths in CSVS.items():
        frames = [pd.read_csv(p, low_memory=False) for p in paths if os.path.exists(p)]
        df = pd.concat(frames, ignore_index=True)
        df = df[df["lot_number"].notna()]
        for rec in df.to_dict("records"):
            key = (adapter, str(rec["sale_code"]), int(rec["lot_number"]))
            index.setdefault(key, []).append((rec.get("edition_note"), rec.get("title")))
    return index


def detector_input(g, index):
    """Returns (texts, problem). texts is the argument tuple the ingest passed."""
    adapter = g["impressionId"].split("-", 1)[0]
    if adapter in ("bonhams", "swann"):
        return (g["rawMedium"],), None
    if g["saleId"] is None or g["lotNumber"] is None:
        return None, "no sale/lot key"
    matches = index.get((adapter, str(g["saleId"]), int(g["lotNumber"])), [])
    if not matches:
        return None, "no CSV row"
    if len(set(map(str, matches))) > 1:
        return None, "ambiguous CSV key"
    return matches[0], None


def plan(graph_rows, index):
    todo, counts, skipped = [], Counter(), Counter()
    for g in graph_rows:
        texts, problem = detector_input(g, index)
        if problem:
            skipped[(g["house"], problem)] += 1
            continue
        old, new = legacy_detect_copy_type(*texts), detect_copy_type(*texts)
        if old == new:
            continue
        if g["copyType"] != old:
            skipped[(g["house"], f"stored {g['copyType']!r} != old detector {old!r}")] += 1
            continue
        counts[(g["house"], old, new, bool(g["priced"]))] += 1
        todo.append({"impressionId": g["impressionId"], "sourceId": g["sourceId"], "house": g["house"],
                     "priced": g["priced"], "oldCopyType": old, "newCopyType": new,
                     "text": " | ".join(str(t) for t in texts if t is not None)[:400]})
    return todo, counts, skipped


def report(graph_rows, todo, counts, skipped):
    print(f"impressions scanned: {len(graph_rows)}")
    print(f"\nchanges: {len(todo)}  ({sum(1 for t in todo if t['priced'])} priced)")
    print(f"  {'house':<26} {'old':<9} {'new':<9} {'priced':<7} n")
    for (house, old, new, priced), n in sorted(counts.items()):
        print(f"  {house:<26} {old:<9} {new:<9} {str(priced):<7} {n}")
    moved_out = Counter(t["newCopyType"] for t in todo if t["oldCopyType"] == "BAT")
    moved_in = Counter(t["oldCopyType"] for t in todo if t["newCopyType"] == "BAT")
    print(f"\n  out of BAT -> {dict(moved_out)}")
    print(f"  into BAT  <- {dict(moved_in)}")
    if skipped:
        print("\nskipped (left unchanged):")
        for (house, why), n in sorted(skipped.items()):
            print(f"  {house:<26} {why:<50} {n}")
    print("\nsample of lots moving INTO BAT (check these by eye):")
    for t in [t for t in todo if t["newCopyType"] == "BAT"][:15]:
        print(f"  {t['sourceId']:<36} {t['text'][:150]}")


def snapshot(todo, path):
    payload = {"version": REPAIR_TAG, "takenAt": datetime.now(timezone.utc).isoformat(),
               "rowCount": len(todo), "properties": ["copyType"], "rows": todo}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"\npre-repair snapshot of {len(todo)} impressions -> {path}")


def apply(session, todo):
    now = datetime.now(timezone.utc).isoformat()
    written = 0
    for i in range(0, len(todo), BATCH):
        written += session.run(WRITE, rows=todo[i:i + BATCH], now=now, tag=REPAIR_TAG).single()["n"]
    print(f"changed copyType on {written}/{len(todo)} Impression(s).")
    return written == len(todo)


def verify(session, index):
    graph_rows = session.run(SELECT, prefixes=list(PREFIXES)).data()
    wrong = Counter()
    checked = 0
    for g in graph_rows:
        texts, problem = detector_input(g, index)
        if problem:
            continue
        checked += 1
        expected = detect_copy_type(*texts)
        if g["copyType"] != expected and g["copyType"] == legacy_detect_copy_type(*texts):
            wrong[g["house"]] += 1
    marked = sum(1 for g in graph_rows if g["repairedAt"] is not None)
    bat = sum(1 for g in graph_rows if g["copyType"] == "BAT")
    print(f"impressions with recoverable detector input : {checked}")
    print(f"  carrying copyTypeRepairedAt               : {marked}")
    print(f"  BAT now                                   : {bat}")
    print(f"  still on the old detector's answer        : {sum(wrong.values())} {dict(wrong)}  (expected 0)")
    return not wrong


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/copy_type_repair_presnapshot_<ts>.json)")
    args = ap.parse_args()

    index = load_csv_index()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                raise SystemExit(0 if verify(session, index) else 1)
            graph_rows = session.run(SELECT, prefixes=list(PREFIXES)).data()
            todo, counts, skipped = plan(graph_rows, index)
            report(graph_rows, todo, counts, skipped)
            if not todo:
                print("\nnothing to do.")
                return
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
            snapshot(todo, args.backup or os.path.join(HERE, f"copy_type_repair_presnapshot_{ts}.json"))
            if args.dry_run:
                print("\n--dry-run: no writes made.")
                return
            ok = apply(session, todo)
            print()
            raise SystemExit(0 if verify(session, index) and ok else 1)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
