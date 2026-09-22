"""
PrintMasterAI — backfill Artist MergeEvents for merges made before ARTIST-MERGE-3.2.
Version: ARTIST-MERGE-BACKFILL-1.0

WHY. Since 2026-09-22 `merge_artists.merge_pair` records every fold as a MergeEvent, and every
ingest resolves an artist name through those events before it MERGEs (see
`catalogue_matching.resolved_artist_name_cypher`). Merges made BEFORE that have no event, so the
resolver cannot see them and the next load carrying an absorbed spelling still recreates the node.
This reconstructs the missing events from the pre-merge snapshots the merge passes wrote.

WHAT COUNTS AS EVIDENCE THAT A MERGE HAPPENED. A snapshot records what a run PLANNED, and a
planned pair can have been skipped (a cluster already consumed one side) or undone since. So no
event is written from the plan alone: each pair is checked against the LIVE graph.
`MERGE_PAIR` concatenates both nodes' `alternateNames` and appends both names, so a pair that was
really folded leaves exactly one live node carrying BOTH names (itself or in alternateNames),
including after later chained folds, which keep concatenating. That node is the survivor. Then,
for each of the pair's two names that is not the survivor's current name:

  event      no other live node has that name       -> write mergedFromId = name -> survivor
  conflict   another live node has that name        -> NOT written; the merge was undone or the
                                                       alias is polluted, which is A4's triage
  unresolved zero or several live nodes carry both  -> NOT written; reported

Exact name lookups only: no similarity, no normalisation.

SOURCES (each a file a merge pass wrote at --execute time; searched in every worktree):
  ulan_canon_presnapshot_*.json          plannedMerges   rule ulanCanonical
  band_b_presnapshot_*.json              planned         rule by tier (B1/B2/B3/B3b)
  artist_pairs_presnapshot_*.json        pairs           aliasShadowing if evidence == 'alias',
                                                         else humanPairs
  km_artist_repair_merge_presnapshot_*   rows            kmIdentityRepair

NOT COVERED, and said so in the report: merges with no snapshot — the 2026-09-06 case-dedup
(inlined Cypher), the 2026-09-05 Nolan/Moore/Miro manual cleanups, the 2026-09-10 Roseberys 40.

    python3 backfill_artist_merge_events.py             # dry run: report + plan CSV, no writes
    python3 backfill_artist_merge_events.py --apply     # writes the `event` rows
"""
import argparse
import csv
import glob
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase  # noqa: E402

VERSION = "ARTIST-MERGE-BACKFILL-1.0"
SEARCH = os.path.expanduser("~/PycharmProjects/claude_printmasterAI*/knowledge_graph")
BAND_B_RULES = {"B1": "nameNormalised", "B2": "nameNormalisedDateDispute",
                "B3": "nameFuzzyImageCorroborated", "B3b": "nameTypoDatesAgree"}

LIVE = """
MATCH (a:Artist)
RETURN a.name AS name, coalesce(a.alternateNames, []) AS alts
"""
EXISTING = """
MATCH (e:MergeEvent {subject: 'Artist'})-[:MERGED_INTO]->(a:Artist)
RETURN e.mergedFromId AS name, a.name AS target
"""
WRITE = """
UNWIND $rows AS row
MATCH (x:Artist {name: row.survivor})
WHERE NOT EXISTS { MATCH (:MergeEvent {mergedFromId: row.name})-[:MERGED_INTO]->(:Artist) }
  AND NOT EXISTS { MATCH (:Artist {name: row.name}) }
CREATE (ev:MergeEvent {id: row.survivor + ' <- ' + row.name})
SET ev.subject = 'Artist', ev.mergedFromId = row.name, ev.mergedFromName = row.name,
    ev.survivorNameAtMerge = row.survivorAtMerge, ev.rule = row.rule,
    ev.ruleVersion = row.ruleVersion, ev.decidedBy = row.decidedBy, ev.evidence = row.evidence,
    ev.at = datetime(row.at), ev.backfilled = true, ev.backfillSource = row.source,
    ev.backfillVersion = $version, ev.backfilledAt = datetime()
CREATE (ev)-[:MERGED_INTO]->(x)
RETURN count(ev) AS n
"""


def _nan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def find_sources():
    """Every snapshot file once, by basename: worktrees carry copies of the same file."""
    seen = {}
    for d in sorted(glob.glob(SEARCH)):
        for pat in ("ulan_canon_presnapshot_*.json", "band_b_presnapshot_*.json",
                    "artist_pairs_presnapshot_*.json", "km_artist_repair_merge_presnapshot_*.json"):
            for p in glob.glob(os.path.join(d, pat)):
                seen.setdefault(os.path.basename(p), p)
    return [seen[k] for k in sorted(seen)]


def planned_pairs(path):
    """(a, b, survivorAtMerge, rule, decidedBy, ruleVersion, evidence, at) per planned fold.
    `a` is the canon where the source knows it; band-B plans do not (pick_canonical ran live)."""
    name, d = os.path.basename(path), json.load(open(path))
    at = d.get("takenAt")
    out = []
    if name.startswith("ulan_canon"):
        for m in d.get("plannedMerges", []):
            out.append((m["canon"], m["dup"], m.get("keepName") or m["canon"], "ulanCanonical",
                        "rule", "ARTIST-MERGE-3.x ulan-canon",
                        f"same ULAN id {m['uid']} held under two URL forms", at))
    elif name.startswith("band_b"):
        for r in d.get("planned", []):
            tier = str(r.get("tier", ""))
            code = "B3b" if tier.startswith("B3b") else tier[:2]
            ev = (f"splink band B, {tier}; name level {r.get('level') or r.get('name_level')}; "
                  f"match weight {r['match_weight']:.2f}"
                  + ("" if _nan(r.get("dino_max")) else f"; DINOv2 max {r['dino_max']:.3f}"))
            out.append((r["name_l"], r["name_r"], None, BAND_B_RULES.get(code, "nameNormalised"),
                        "rule", "ARTIST-MERGE-3.x band-b", ev, at))
    elif name.startswith("artist_pairs"):
        for r in d.get("pairs", []):
            evid = (r.get("evidence") or "").strip()
            rule = "aliasShadowing" if evid == "alias" else "humanPairs"
            out.append((r["canon"], r["dup"], r.get("keepName") or r["canon"], rule, "human",
                        "ARTIST-MERGE-3.x pairs",
                        evid if evid and evid != "alias" else
                        ("unpriced duplicate of an aliased name (Swann ingest)" if evid == "alias"
                         else "reviewed pairs run; the snapshot records no evidence"), at))
    elif name.startswith("km_artist_repair_merge"):
        for r in d.get("rows", []):
            out.append((r["canon"], r["dup"], r["canon"], "kmIdentityRepair", "human",
                        "KM-DUP-MERGE-1.0", r.get("evidence") or r.get("rule") or "", at))
    return [(*p, name) for p in out]


def resolve(pairs, live, existing):
    """Check every planned pair against the live graph. Returns (rows, counts)."""
    holders = defaultdict(set)          # a name -> live nodes carrying it as name or alias
    for n, alts in live.items():
        holders[n].add(n)
        for a in alts:
            holders[a].add(n)
    rows, best = [], {}
    for a, b, surv_at, rule, by, rv, ev, at, src in pairs:
        both = holders.get(a, set()) & holders.get(b, set())
        if len(both) != 1:
            key = ("unresolved", f"{a} | {b}")
            if key not in best:
                best[key] = {"status": "unresolved", "name": key[1], "survivor": "",
                             "detail": f"{len(both)} live node(s) carry both names; "
                                       f"holders {sorted(holders.get(a, set()))} / "
                                       f"{sorted(holders.get(b, set()))}",
                             "source": src, "rule": rule, "at": at}
            continue
        x = next(iter(both))
        for n in (a, b):
            if n == x:
                continue
            if n in existing:
                status = "exists" if existing[n] == x else "conflict"
                detail = f"already has an event -> {existing[n]}"
            elif n in live:
                status, detail = "conflict", "a separate live Artist carries this name"
            else:
                status, detail = "event", ""
            # the canon's own name is only absorbed by a later rename
            r = ("survivorRenamed" if (surv_at and n == a and a != b and surv_at != a)
                 else rule)
            row = {"status": status, "name": n, "survivor": x, "survivorAtMerge": surv_at or "",
                   "rule": r, "decidedBy": by, "ruleVersion": rv, "evidence": ev,
                   "at": at, "source": src, "detail": detail}
            # the same fold appears in several runs' snapshots: keep the earliest
            key = (status, n)
            if key not in best or (at or "") < (best[key]["at"] or ""):
                best[key] = row
    rows.extend(best.values())
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--out", default=f"artist_merge_event_backfill_plan_"
                                     f"{datetime.now(timezone.utc):%Y-%m-%d}.csv")
    a = ap.parse_args()

    sources = find_sources()
    pairs = [p for s in sources for p in planned_pairs(s)]
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"],
                               auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    db = os.environ.get("NEO4J_DATABASE") or "neo4j"
    with drv.session(database=db) as s:
        live = {r["name"]: r["alts"] for r in s.run(LIVE)}
        existing = {r["name"]: r["target"] for r in s.run(EXISTING)}
    rows = resolve(pairs, live, existing)

    print(f"{len(sources)} snapshot file(s), {len(pairs)} planned fold(s)")
    by_src = Counter(p[-1].split("_presnapshot")[0].split("_2026")[0] for p in pairs)
    for k, v in sorted(by_src.items()):
        print(f"   {k:28s} {v:5d} planned")
    st = Counter(r["status"] for r in rows)
    print(f"\nresolved against the live graph ({len(live):,} Artists, "
          f"{len(existing)} existing Artist events):")
    for k in ("event", "exists", "conflict", "unresolved"):
        print(f"   {k:10s} {st.get(k, 0):5d}")
    ev = [r for r in rows if r["status"] == "event"]
    print("\nevents by rule:")
    for k, v in Counter(r["rule"] for r in ev).most_common():
        print(f"   {k:28s} {v:5d}")
    for k in ("conflict", "unresolved"):
        sample = [r for r in rows if r["status"] == k][:12]
        if sample:
            print(f"\n{k} (first {len(sample)}):")
            for r in sample:
                print(f"   {r['name'][:60]:60s} -> {r['survivor'][:30]:30s} {r['detail'][:160]}")

    cols = ["status", "name", "survivor", "survivorAtMerge", "rule", "decidedBy", "ruleVersion",
            "evidence", "at", "source", "detail"]
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["status"], r["name"])))
    print(f"\nplan -> {a.out}")

    if not a.apply:
        print("\n(dry run — nothing written)")
        drv.close()
        return
    with drv.session(database=db) as s:
        n = s.run(WRITE, rows=ev, version=VERSION).single()["n"]
    print(f"\nwrote {n} of {len(ev)} event(s)")
    drv.close()
    if n != len(ev):
        sys.exit(1)


if __name__ == "__main__":
    main()
