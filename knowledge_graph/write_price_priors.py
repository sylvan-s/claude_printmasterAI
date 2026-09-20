"""
PrintMasterAI — write the per-artist price elasticity priors into the ACKG.
Version: PRICE-PRIORS-WRITE-1.0

The priors are a DERIVED layer in the graph, not a second database (plan
docs/plans/2026-09-13-attributed-lot-valuation.md, step 6). `pricing_ml/build_priors.py` is the
only thing that computes them and `priors/artist_elasticities.json` is the build artefact; this
script is the ONLY writer of the price* properties and PRICE_NEIGHBOUR edges, and the appraisal
pipeline never writes them. Rebuild cadence: after every bulk ingest or artist-merge pass —
`check_price_priors_fresh.py` fails when the graph has moved on since the build.

What one run writes:

  (:PricingModelRun {id})      one per build: version, cut, kappa, elasticityColumns (list),
                               referenceLevels / yearEffects / continuousMedians / segmentDefaults
                               (JSON strings), rowCount, sourceRowCount, builtAt, writtenAt.
                               The id is "<version>@<built_at>", so re-running the writer on the
                               same JSON is idempotent and a rebuild is a new run. Older run nodes
                               are kept: they are what makes a run reversible by id.
  Artist.priceLevelLog         intercept on deflated log hammer
  Artist.priceElasticities     flat float list in the run's elasticityColumns order
  Artist.priceEarlierSales     sales the build saw before its cut
  Artist.priceElasticitiesRun  the run id — the staleness tag the check script reads
  Artist.priceElasticitiesBasis "shrunk" (own fit shrunk toward the prior) or "prior" (5-14 sales)
  (:Artist)-[:PRICE_NEIGHBOUR {weight, run}]->(:Artist)
                               the donors that formed the artist's prior, for the report

Artists are matched by EXACT name — the JSON keys are the canonical `Artist.name` values the
export read out of the graph — and `artist_name` is a uniqueness constraint. A key that matches
zero nodes (renamed or merged away since the export) or, should the constraint ever be dropped,
more than one, is REPORTED AND SKIPPED, never guessed; a name that resolves wrongly would hang
another artist's multipliers on this one.

Discipline, as in backfill_fx_gbp.py / repair_bonhams_price_realised.py:
  --dry-run   resolve names, take the pre-snapshot, print the plan, write nothing
  (apply)     pre-snapshot of every property and edge this run will touch (JSON, gitignored),
              then batched UNWIND writes, then the verification query
  --verify    the verification query only

On apply, price* properties on artists that the new build no longer covers are REMOVED and
PRICE_NEIGHBOUR edges from older runs are DELETED, so the graph never carries two runs at once
for the reader to mix. Both are in the snapshot.

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/write_price_priors.py --dry-run
    python3 knowledge_graph/write_price_priors.py
    python3 knowledge_graph/write_price_priors.py --verify
"""
import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PRIORS = os.path.join(HERE, "pricing_ml", "priors", "artist_elasticities.json")
WRITER_VERSION = "PRICE-PRIORS-WRITE-1.0"
BATCH = 500
ARTIST_PROPS = ["priceLevelLog", "priceElasticities", "priceEarlierSales", "priceElasticitiesRun", "priceElasticitiesBasis"]


def load_env():
    for path in (os.path.join(HERE, ".env"), os.path.join(HERE, "..", ".env")):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# Label-scoped MATCH: `:Artist` must stay on it or the artist_name index is not used.
RESOLVE = """
UNWIND $names AS name
OPTIONAL MATCH (a:Artist {name: name})
RETURN name, count(a) AS n
"""

SNAPSHOT_ARTISTS = """
MATCH (a:Artist)
WHERE a.name IN $names OR a.priceElasticitiesRun IS NOT NULL
RETURN a.name AS name, a.priceLevelLog AS priceLevelLog, a.priceElasticities AS priceElasticities,
       a.priceEarlierSales AS priceEarlierSales, a.priceElasticitiesRun AS priceElasticitiesRun,
       a.priceElasticitiesBasis AS priceElasticitiesBasis
"""

SNAPSHOT_EDGES = """
MATCH (a:Artist)-[r:PRICE_NEIGHBOUR]->(b:Artist)
RETURN a.name AS fromName, b.name AS toName, r.weight AS weight, r.run AS run
"""

SNAPSHOT_RUNS = """
MATCH (r:PricingModelRun)
RETURN properties(r) AS props
"""

WRITE_RUN = """
MERGE (r:PricingModelRun {id: $id})
SET r.version = $version, r.cut = $cut, r.kappa = $kappa,
    r.elasticityColumns = $columns, r.referenceLevels = $referenceLevels,
    r.yearEffects = $yearEffects, r.continuousMedians = $continuousMedians,
    r.segmentDefaults = $segmentDefaults, r.segmentKey = $segmentKey,
    r.rowCount = $rowCount, r.sourceRowCount = $sourceRowCount, r.artistCount = $artistCount,
    r.minOwnSales = $minOwnSales, r.minDescriptorSales = $minDescriptorSales,
    r.builtAt = $builtAt, r.writtenAt = $writtenAt, r.writer = $writer
RETURN r.id AS id
"""

WRITE_ARTISTS = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name})
SET a.priceLevelLog = row.level,
    a.priceElasticities = row.elasticities,
    a.priceEarlierSales = row.earlierSales,
    a.priceElasticitiesRun = $run,
    a.priceElasticitiesBasis = row.basis
RETURN count(a) AS n
"""

WRITE_EDGES = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.fromName})
MATCH (b:Artist {name: row.toName})
MERGE (a)-[r:PRICE_NEIGHBOUR {run: $run}]->(b)
SET r.weight = row.weight
RETURN count(r) AS n
"""

CLEAR_STALE_ARTISTS = """
MATCH (a:Artist)
WHERE a.priceElasticitiesRun IS NOT NULL AND a.priceElasticitiesRun <> $run
REMOVE a.priceLevelLog, a.priceElasticities, a.priceEarlierSales, a.priceElasticitiesRun, a.priceElasticitiesBasis
RETURN count(a) AS n
"""

DELETE_OLD_EDGES = """
MATCH (:Artist)-[r:PRICE_NEIGHBOUR]->(:Artist)
WHERE r.run IS NULL OR r.run <> $run
DELETE r
RETURN count(r) AS n
"""

VERIFY = """
OPTIONAL MATCH (run:PricingModelRun)
WITH count(run) AS runs, collect(run.id) AS runIds
OPTIONAL MATCH (a:Artist) WHERE a.priceElasticitiesRun IS NOT NULL
WITH runs, runIds, count(a) AS tagged, collect(DISTINCT a.priceElasticitiesRun) AS artistRuns,
     sum(CASE WHEN a.priceElasticitiesBasis = 'shrunk' THEN 1 ELSE 0 END) AS shrunk,
     sum(CASE WHEN a.priceElasticitiesBasis = 'prior' THEN 1 ELSE 0 END) AS priorOnly
OPTIONAL MATCH (:Artist)-[r:PRICE_NEIGHBOUR]->(:Artist)
RETURN runs, runIds, tagged, artistRuns, shrunk, priorOnly, count(r) AS edges, collect(DISTINCT r.run) AS edgeRuns
"""


def run_id(db: dict) -> str:
    if not db.get("built_at"):
        sys.exit("priors JSON has no built_at — rebuild with build_priors.py (PRICING-PRIORS-1.1+) first")
    return f"{db['version']}@{db['built_at']}"


def plan_rows(db: dict):
    cols = db["elasticity_columns"]
    artists, edges, bad = [], [], []
    for name, e in db["artists"].items():
        vec = [float(e["elasticities"][c]["value"]) for c in cols]
        if not all(math.isfinite(v) for v in vec) or not math.isfinite(float(e["price_level_log"])):
            bad.append(name)
            continue
        artists.append({"name": name, "level": float(e["price_level_log"]), "elasticities": vec,
                        "earlierSales": int(e["earlier_sales"]), "basis": e.get("basis", "shrunk")})
        for nb, w in e.get("neighbours", {}).items():
            edges.append({"fromName": name, "toName": nb, "weight": float(w)})
    if bad:
        sys.exit(f"{len(bad)} artist(s) carry a non-finite elasticity or level — the build is broken, not writing: {bad[:5]}")
    return artists, edges


def resolve(session, names):
    """Exact-name resolution. Returns (ok_names, unmatched, ambiguous)."""
    ok, unmatched, ambiguous = [], [], []
    for i in range(0, len(names), BATCH):
        for r in session.run(RESOLVE, names=names[i:i + BATCH]):
            if r["n"] == 1:
                ok.append(r["name"])
            elif r["n"] == 0:
                unmatched.append(r["name"])
            else:
                ambiguous.append((r["name"], r["n"]))
    return ok, unmatched, ambiguous


def snapshot(session, names, path, run):
    artists = session.run(SNAPSHOT_ARTISTS, names=names).data()
    edges = session.run(SNAPSHOT_EDGES).data()
    runs = [r["props"] for r in session.run(SNAPSHOT_RUNS)]
    payload = {
        "version": WRITER_VERSION, "run": run, "takenAt": datetime.now(timezone.utc).isoformat(),
        "artistProperties": ARTIST_PROPS,
        "artists": artists, "priceNeighbourEdges": edges, "pricingModelRuns": runs,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, default=str)
    prev = sum(1 for a in artists if a["priceElasticitiesRun"])
    print(f"pre-write snapshot -> {path}\n  {len(artists)} artist(s) ({prev} already carrying a run tag), "
          f"{len(edges)} PRICE_NEIGHBOUR edge(s), {len(runs)} PricingModelRun node(s)")


def apply(session, db, rid, artists, edges):
    now = datetime.now(timezone.utc).isoformat()
    session.run(WRITE_RUN, id=rid, version=db["version"], cut=db["cut"], kappa=int(db["kappa"]),
                columns=db["elasticity_columns"], referenceLevels=json.dumps(db["reference_levels"]),
                yearEffects=json.dumps(db["year_effects"]), continuousMedians=json.dumps(db["continuous_medians"]),
                segmentDefaults=json.dumps(db.get("segment_defaults", {})), segmentKey=db.get("segment_key", ""),
                rowCount=int(db.get("model_rows", db.get("train_rows", 0))), sourceRowCount=int(db.get("source_rows", 0)),
                artistCount=len(artists), minOwnSales=int(db.get("min_own_sales", 15)),
                minDescriptorSales=int(db.get("min_descriptor_sales", 5)),
                builtAt=db["built_at"], writtenAt=now, writer=WRITER_VERSION).single()
    print(f"PricingModelRun {rid}: merged")
    n_art = 0
    for i in range(0, len(artists), BATCH):
        n_art += session.run(WRITE_ARTISTS, rows=artists[i:i + BATCH], run=rid).single()["n"]
        print(f"  artists written {n_art}/{len(artists)}", end="\r")
    print(f"\nArtist price properties set on {n_art} node(s)")
    n_edge = 0
    for i in range(0, len(edges), BATCH):
        n_edge += session.run(WRITE_EDGES, rows=edges[i:i + BATCH], run=rid).single()["n"]
    print(f"PRICE_NEIGHBOUR edges merged for this run: {n_edge}")
    cleared = session.run(CLEAR_STALE_ARTISTS, run=rid).single()["n"]
    deleted = session.run(DELETE_OLD_EDGES, run=rid).single()["n"]
    print(f"stale artists cleared (older run tag): {cleared}\nolder-run PRICE_NEIGHBOUR edges deleted: {deleted}")
    return n_art, n_edge, cleared, deleted


def verify(session):
    r = session.run(VERIFY).single()
    print("verification:")
    print(f"  PricingModelRun nodes      : {r['runs']}  {r['runIds']}")
    print(f"  Artists carrying a run tag : {r['tagged']}  (shrunk {r['shrunk']}, prior-only {r['priorOnly']})  runs on artists: {r['artistRuns']}")
    print(f"  PRICE_NEIGHBOUR edges      : {r['edges']}  runs on edges: {r['edgeRuns']}")
    if len(r["artistRuns"]) > 1 or len(r["edgeRuns"]) > 1:
        print("  WARNING: more than one run is live on artists or edges — the graph is mixed")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--priors", default=DEFAULT_PRIORS)
    ap.add_argument("--dry-run", action="store_true", help="resolve, snapshot and plan; write nothing")
    ap.add_argument("--verify", action="store_true", help="verification query only")
    ap.add_argument("--snapshot", help="pre-snapshot path (default: knowledge_graph/price_priors_presnapshot_<ts>.json)")
    args = ap.parse_args()
    load_env()
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    try:
        with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
            if args.verify:
                verify(session)
                return
            with open(args.priors, encoding="utf-8") as f:
                db = json.load(f)
            rid = run_id(db)
            artists, edges = plan_rows(db)
            print(f"priors {args.priors}\n  run {rid}\n  {len(artists)} artist(s), {len(edges)} neighbour edge(s), "
                  f"{len(db['elasticity_columns'])} elasticity columns, {len(db.get('segment_defaults', {}))} segment defaults")

            names = [a["name"] for a in artists]
            ok, unmatched, ambiguous = resolve(session, names)
            okset = set(ok)
            if unmatched:
                print(f"\n  {len(unmatched)} JSON artist(s) match NO Artist node — skipped, not guessed "
                      f"(renamed or merged since the export; rebuild after re-exporting):")
                for n in unmatched[:20]:
                    print(f"    {n!r}")
            if ambiguous:
                print(f"\n  {len(ambiguous)} JSON artist(s) match MORE THAN ONE node — skipped, not guessed:")
                for n, c in ambiguous[:20]:
                    print(f"    {n!r} x{c}")
            artists = [a for a in artists if a["name"] in okset]
            dropped_edges = [e for e in edges if e["fromName"] not in okset or e["toName"] not in okset]
            edges = [e for e in edges if e["fromName"] in okset and e["toName"] in okset]
            print(f"\nplan: set price properties on {len(artists)} artist(s); merge {len(edges)} PRICE_NEIGHBOUR edge(s)"
                  + (f" ({len(dropped_edges)} edge(s) dropped for an unresolved end)" if dropped_edges else ""))

            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            path = args.snapshot or os.path.join(HERE, f"price_priors_presnapshot_{ts}.json")
            snapshot(session, [a["name"] for a in artists], path, rid)

            if args.dry_run:
                print("\n--dry-run: no writes made.")
                return
            apply(session, db, rid, artists, edges)
            print()
            verify(session)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
