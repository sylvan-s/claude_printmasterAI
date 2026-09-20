"""
PrintMasterAI — repair two King & McGaw Artist-identity defects the ULAN audit found, restorably.
Version: KM-ARTIST-REPAIR-1.0

Audit: docs/audits/2026-09-19-km-artist-ulan-audit.md. Two subcommands, each driven by a reviewed plan file.

  split   km_pooled_split_plan_2026-09-19.json   KM-POOL-SPLIT-1.0
      The ingest matches an Artist `coalesce(byUlan, byWiki, byName)`, so a wrong ULAN pooled works by
      different King & McGaw artists onto one node (Eric / Eric Ravilious, J. Howard Miller / John Wilsher,
      After Hans Holbein the Younger / Hans Holbein The Younger). Only the Artist edges are wrong: every
      ConceptualWork id already carries its true artist (`km-cw-john_wilsher-...`). Re-points, per work,
      (Artist)-[:CREATED]->(work) and the SourceRecord's ATTRIBUTED_TO edge (properties kept) to the artist
      the work's own id and the raw catalog name, creating that Artist only if no node has EXACTLY that name.

  merge   km_duplicate_merge_plan_2026-09-19.json   KM-DUP-MERGE-1.0
      Folds a King & McGaw-only node into the node for the same person, using the audited primitive
      (`merge_artists.merge_pair`, ARTIST-MERGE-3.1: all six relationship types, ATTRIBUTED_TO properties kept,
      refuses to delete a node carrying a type it does not transfer). Pairs are exact under the repo's own
      normalisation, or a name recorded on the KM node's verified ULAN record; nothing fuzzy.
      A ULAN moving from the deleted node to the survivor is taken off the deleted node FIRST and set on the
      survivor after, because `artist_ulanurl` is a uniqueness constraint; the survivor's identityConfidence is
      set to the deleted node's tier and its old one kept in `identityConfidencePrior`.

Both keep `hasPosterCatalog` / `posterWorkCount` true to the graph: `candidate_title_merges.py` selects poster
works by `Artist.hasPosterCatalog`, and neither a merge nor an edge move updates it, so it is recomputed on
every touched node from its `km-cw-` works.

DRY RUN IS NOT JUST A CHECK. Without --apply it verifies the plan against the live graph, then executes the whole
change inside a transaction, restores it with the rollback code, compares the touched nodes to how they started,
and rolls the transaction back. So the rollback path is exercised before anything is committed. (A uniqueness
violation that only surfaces at commit cannot be caught this way.)

    python3 repair_km_artist_identity.py split                       # dry run
    python3 repair_km_artist_identity.py split --apply
    python3 repair_km_artist_identity.py split --rollback SNAPSHOT.json
    (same three forms for `merge`)
"""
import argparse
import importlib
import json
import os
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
QUAL = os.path.expanduser("~/PycharmProjects/claude_printmasterAI-artist-merge-qualifier/knowledge_graph")
load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
INGEST_RELS = {"CREATED", "DOCUMENTS", "PRINTED_AS", "SHOWS"}


def load_merge_primitive():
    """merge_artists >= ARTIST-MERGE-3.1. Older copies silently drop ATTRIBUTED_TO.qualifier."""
    for path in (HERE, QUAL):
        if not os.path.exists(os.path.join(path, "merge_artists.py")):
            continue
        for m in ("merge_artists", "find_artist_merge_candidates", "ulan_url"):
            sys.modules.pop(m, None)
        sys.path.insert(0, path)
        try:
            mod = importlib.import_module("merge_artists")
        finally:
            sys.path.remove(path)
        if hasattr(mod, "PROPERTY_COPYING_TYPES") and hasattr(mod, "merge_pair"):
            return mod
    raise SystemExit("needs merge_artists.py >= ARTIST-MERGE-3.1 (branch fix/artist-merge-qualifier)")


# Label-scoped on purpose: an unlabelled MATCH would silently skip the name/id index.
STATE = """
MATCH (a:Artist) WHERE a.name IN $names
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
WITH a, collect(w.id) AS works
OPTIONAL MATCH (sr:SourceRecord)-[r:ATTRIBUTED_TO]->(a)
RETURN a.name AS name, properties(a) AS props, works,
       [x IN collect([sr.id, properties(r)]) WHERE x[0] IS NOT NULL] AS attr
"""

RECOMPUTE = """
UNWIND $names AS n
MATCH (a:Artist {name: n})
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork) WHERE w.id STARTS WITH 'km-cw-'
WITH a, count(w) AS k
SET a.posterWorkCount = CASE WHEN k > 0 THEN k ELSE NULL END,
    a.hasPosterCatalog = CASE WHEN k > 0 THEN true ELSE NULL END
"""


def state(tx, names):
    out = {n: None for n in names}
    for r in tx.run(STATE, names=list(names)):
        out[r["name"]] = {"props": dict(r["props"]), "works": sorted(r["works"]),
                          "attr": sorted([[a[0], dict(a[1])] for a in r["attr"]], key=lambda x: x[0])}
    return out


def same(a, b):
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


# ------------------------------------------------------------------------------------------------ split

WORK_CHECK = """
MATCH (w:ConceptualWork {id: $work})
OPTIONAL MATCH (a:Artist)-[:CREATED]->(w)
OPTIONAL MATCH (w)-[r]-()
WITH w, collect(DISTINCT a.name) AS creators, collect(DISTINCT type(r)) AS rels
OPTIONAL MATCH (m:MergeEvent) WHERE m.mergedFromId = w.id OR m.id ENDS WITH w.id
RETURN creators, rels, count(m) AS mergeEvents
"""

MOVE = """
MATCH (old:Artist {name: $from})-[c:CREATED]->(w:ConceptualWork {id: $work})
MERGE (new:Artist {name: $to}) ON CREATE SET new.identityConfidence = 'unresolved'
MERGE (new)-[:CREATED]->(w)
DELETE c
WITH old, new, w
OPTIONAL MATCH (sr:SourceRecord)-[a:ATTRIBUTED_TO]->(old) WHERE (sr)-[:DOCUMENTS]->(w)
FOREACH (x IN CASE WHEN sr IS NULL THEN [] ELSE [sr] END |
    MERGE (x)-[na:ATTRIBUTED_TO]->(new) SET na += properties(a))
DELETE a
RETURN count(w) AS n
"""


def split_verify_plan(tx, rows):
    problems = []
    for r in rows:
        got = tx.run(WORK_CHECK, work=r["work"]).single()
        if got is None:
            problems.append(f"{r['work']}: no such work")
        elif got["creators"] != [r["from"]]:
            problems.append(f"{r['work']}: created by {got['creators']}, plan says only {r['from']!r}")
        elif set(got["rels"]) - INGEST_RELS or got["mergeEvents"]:
            problems.append(f"{r['work']}: relationships beyond the ingest's own {sorted(set(got['rels']) - INGEST_RELS)} "
                            f"or a MergeEvent ({got['mergeEvents']})")
        elif not r["work"].startswith("km-cw-"):
            problems.append(f"{r['work']}: not a King & McGaw work")
    return problems


def split_apply(tx, rows):
    for r in rows:
        if tx.run(MOVE, **{"from": r["from"], "to": r["to"], "work": r["work"]}).single()["n"] < 1:
            raise RuntimeError(f"move matched nothing: {r}")
    tx.run(RECOMPUTE, names=sorted({n for r in rows for n in (r["from"], r["to"])})).consume()


def split_verify_result(tx, rows):
    for r in rows:
        got = tx.run(WORK_CHECK, work=r["work"]).single()
        if got["creators"] != [r["to"]]:
            raise RuntimeError(f"{r['work']} is created by {got['creators']}, expected {[r['to']]}")
        stray = tx.run("MATCH (sr:SourceRecord)-[:DOCUMENTS]->(:ConceptualWork {id: $w}) "
                       "MATCH (sr)-[:ATTRIBUTED_TO]->(x:Artist) RETURN collect(x.name) AS n", w=r["work"]).single()["n"]
        if stray != [r["to"]]:
            raise RuntimeError(f"{r['work']}: source record attributed to {stray}, expected {[r['to']]}")


def split_restore(tx, before, rows, created):
    for r in rows:
        tx.run(MOVE, **{"from": r["to"], "to": r["from"], "work": r["work"]}).consume()
    for name in created:
        tx.run("MATCH (t:Artist {name: $n}) WHERE NOT (t)-[:CREATED]->() DETACH DELETE t", n=name).consume()
    for name, st in before.items():
        if st is not None:        # counters back to exactly what they were
            p = st["props"]
            tx.run("MATCH (a:Artist {name: $n}) SET a.posterWorkCount = $p, a.hasPosterCatalog = $h",
                   n=name, p=p.get("posterWorkCount"), h=p.get("hasPosterCatalog")).consume()


# ------------------------------------------------------------------------------------------------ merge

def merge_verify_plan(tx, rows):
    problems, dups = [], set()
    for r in rows:
        st = state(tx, [r["canon"], r["dup"]])
        c, d = st[r["canon"]], st[r["dup"]]
        if c is None or d is None:
            problems.append(f"{r['dup']!r} -> {r['canon']!r}: a side is missing"); continue
        cp, dp = c["props"], d["props"]
        if dp.get("ulanUrl") != r["dupUlan"] or cp.get("ulanUrl") != r["canonUlan"]:
            problems.append(f"{r['dup']!r} -> {r['canon']!r}: ulanUrl drifted "
                            f"(dup {dp.get('ulanUrl')!r}, canon {cp.get('ulanUrl')!r})")
        if r["dupUlan"] and r["canonUlan"] and r["dupUlan"] != r["canonUlan"]:
            problems.append(f"{r['dup']!r} -> {r['canon']!r}: two different ULANs, refusing")
        if not d["works"] or any(not w.startswith("km-cw-") for w in d["works"]):
            problems.append(f"{r['dup']!r}: not King & McGaw-only")
        if any(w.startswith("km-cw-") for w in c["works"]) and c["works"] == [w for w in c["works"] if w.startswith("km-cw-")]:
            problems.append(f"{r['canon']!r}: survivor is itself King & McGaw-only")
        if r["dup"] in dups:
            problems.append(f"{r['dup']!r} appears twice")
        dups.add(r["dup"])
    return problems


def make_merge_ops(mod):
    def apply(tx, rows):
        for r in rows:
            if r["dupUlan"] and not r["canonUlan"]:
                tx.run("MATCH (d:Artist {name: $n}) REMOVE d.ulanUrl", n=r["dup"]).consume()
            if mod.merge_pair(tx, r["canon"], r["dup"]) is None:
                raise RuntimeError(f"merge_pair was a no-op for {r}")
            if r["dupUlan"] and not r["canonUlan"]:
                tx.run("MATCH (c:Artist {name: $n}) WHERE c.ulanUrl IS NULL "
                       "SET c.ulanUrl = $u, c.identityConfidencePrior = c.identityConfidence, "
                       "    c.identityConfidence = $conf, c.ulanInheritedFrom = $dup",
                       n=r["canon"], u=r["dupUlan"], conf=r["dupConf"], dup=r["dup"]).consume()
        tx.run(RECOMPUTE, names=sorted({r["canon"] for r in rows})).consume()

    def verify(tx, rows, before):
        for r in rows:
            st = state(tx, [r["canon"], r["dup"]])
            if st[r["dup"]] is not None:
                raise RuntimeError(f"{r['dup']!r} still exists")
            c, b = st[r["canon"]], before[r["canon"]]
            want = sorted(set(b["works"]) | set(before[r["dup"]]["works"]))
            if c["works"] != want:
                raise RuntimeError(f"{r['canon']!r}: works {len(c['works'])} != expected {len(want)}")
            want_ulan = r["dupUlan"] or r["canonUlan"]
            if c["props"].get("ulanUrl") != want_ulan:
                raise RuntimeError(f"{r['canon']!r}: ulanUrl {c['props'].get('ulanUrl')!r}, expected {want_ulan!r}")
            for sid, props in before[r["dup"]]["attr"]:
                mine = [a for a in c["attr"] if a[0] == sid]
                if len(mine) != 1 or mine[0][1] != props:
                    raise RuntimeError(f"{r['canon']!r}: ATTRIBUTED_TO from {sid} lost or changed ({mine} vs {props})")

    def restore(tx, before, rows, created):
        for r in reversed(rows):
            c, d = before[r["canon"]], before[r["dup"]]
            tx.run("MATCH (c:Artist {name: $n}) SET c = $p", n=r["canon"], p=c["props"]).consume()   # frees the ULAN first
            tx.run("CREATE (d:Artist) SET d = $p", p=d["props"]).consume()
            for w in d["works"]:
                tx.run("MATCH (d:Artist {name: $d}), (w:ConceptualWork {id: $w}) MERGE (d)-[:CREATED]->(w)",
                       d=r["dup"], w=w).consume()
                if w not in c["works"]:
                    tx.run("MATCH (:Artist {name: $c})-[e:CREATED]->(:ConceptualWork {id: $w}) DELETE e",
                           c=r["canon"], w=w).consume()
            for sid, props in d["attr"]:
                tx.run("MATCH (:SourceRecord {id: $s})-[e:ATTRIBUTED_TO]->(:Artist {name: $c}) DELETE e",
                       s=sid, c=r["canon"]).consume()
                tx.run("MATCH (s:SourceRecord {id: $s}), (d:Artist {name: $d}) MERGE (s)-[e:ATTRIBUTED_TO]->(d) SET e = $p",
                       s=sid, d=r["dup"], p=props).consume()
    return apply, verify, restore


# ------------------------------------------------------------------------------------------------ driver

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["split", "merge"])
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", metavar="SNAPSHOT")
    args = ap.parse_args()
    plan_file = os.path.join(HERE, {"split": "km_pooled_split_plan_2026-09-19.json",
                                    "merge": "km_duplicate_merge_plan_2026-09-19.json"}[args.kind])
    driver = GraphDatabase.driver(os.getenv("NEO4J_URI"), auth=(os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")))
    mod = load_merge_primitive() if args.kind == "merge" else None
    if args.kind == "merge":
        m_apply, m_verify, m_restore = make_merge_ops(mod)

    with driver.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        if args.rollback:
            snap = json.load(open(args.rollback))
            tx = s.begin_transaction()
            try:
                if args.kind == "split":
                    split_restore(tx, snap["before"], snap["rows"], snap["created"])
                else:
                    m_restore(tx, snap["before"], snap["rows"], None)
                tx.commit()
            except Exception:
                tx.rollback(); raise
            print("rolled back", args.kind, "from", args.rollback)
            return

        plan = json.load(open(plan_file))
        rows = plan["rows"]
        names = sorted({n for r in rows for n in ((r["from"], r["to"]) if args.kind == "split" else (r["canon"], r["dup"]))})
        # 1. verify against the live graph (read-only)
        tx = s.begin_transaction()
        problems = (split_verify_plan if args.kind == "split" else merge_verify_plan)(tx, rows)
        before = state(tx, names)
        tx.rollback()
        created = [] if args.kind == "merge" else sorted({r["to"] for r in rows if before[r["to"]] is None})
        print(f"{args.kind}: {len(rows)} rows | problems {len(problems)}"
              + (f" | will create {created}" if created else ""))
        for p in problems:
            print("   PROBLEM", p)
        if problems:
            raise SystemExit("REFUSED: fix or re-plan")

        def run(tx):
            if args.kind == "split":
                split_apply(tx, rows); split_verify_result(tx, rows)
            else:
                m_apply(tx, rows); m_verify(tx, rows, before)

        def undo(tx):
            if args.kind == "split":
                split_restore(tx, before, rows, created)
            else:
                m_restore(tx, before, rows, created)

        # 2. rehearse: apply, verify, restore, compare, ROLL BACK
        tx = s.begin_transaction()
        try:
            run(tx)
            after = state(tx, names)
            undo(tx)
            back = state(tx, names)
            if not same(back, before):
                bad = [n for n in names if not same(back[n], before[n])]
                raise RuntimeError(f"rehearsal restore does not reproduce the starting state for {bad}")
        finally:
            tx.rollback()
        changed = [n for n in names if not same(after[n], before[n])]
        print(f"rehearsal ok: applied, verified, restored to the exact starting state, rolled back "
              f"({len(changed)} of {len(names)} touched nodes differ after the change)")

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap_path = os.path.join(HERE, f"km_artist_repair_{args.kind}_presnapshot_{ts}.json")
        json.dump({"version": "KM-ARTIST-REPAIR-1.0", "kind": args.kind, "takenAt": ts, "rows": rows,
                   "before": before, "created": created}, open(snap_path, "w"), indent=1, ensure_ascii=False, default=str)
        print("snapshot ->", snap_path)
        if not args.apply:
            print("\n(dry run: nothing committed)")
            return

        # 3. commit. Split is one transaction; merge is one per pair so a refusal leaves earlier pairs intact.
        if args.kind == "split":
            tx = s.begin_transaction()
            try:
                run(tx); tx.commit()
            except Exception:
                tx.rollback(); raise
        else:
            done = 0
            for r in rows:
                one = [r]
                tx = s.begin_transaction()
                try:
                    m_apply(tx, one)
                    m_verify(tx, one, before)
                    tx.commit()
                except Exception as e:
                    tx.rollback()
                    print(f"   FAILED {r['dup']!r} -> {r['canon']!r}: {e}")
                    raise SystemExit(f"stopped after {done} of {len(rows)} pairs; the rest are untouched")
                done += 1
                print(f"   merged {r['dup']!r} -> {r['canon']!r}")
        print(f"applied {len(rows)} {args.kind} rows")


if __name__ == "__main__":
    main()
