"""
PrintMasterAI — freshness guard for the price elasticity priors in the graph.

The priors (Artist.priceElasticities etc., written by write_price_priors.py from
pricing_ml/build_priors.py) are DERIVED from the graph's sold auction records and artist
identities, so they go stale on exactly two events: an ingest that adds priced records, and an
artist/work merge that moves records between artists. This check fails when either has
happened since the build the graph carries.

Three signals, any of which fails the check:

  1. MergeEvent.at — the latest merge is later than the run's builtAt.
  2. The latest price-data timestamp on SourceRecord is later than builtAt. SourceRecord has
     NO ingest timestamp of its own (measured 2026-09-13: no *At property is written by any
     ingest), so the proxy is the max over the backfill/repair stamps that follow every priced
     ingest — fxBackfillAt, saleDateBackfillAt, estimateGBPRepairedAt, premiumBasisCorrectedAt.
     An ingest that has not yet been FX-backfilled carries no hammerPriceGBP and is not in the
     export either, so this proxy is exactly the set of rows the build could have seen.
  3. Row count — the number of sold, GBP-priced, dated auction records reachable from an
     Artist right now (the export's own MATCH) differs from the run's sourceRowCount. This is
     the direct signal and catches anything the timestamps miss.

Plus structural invariants: every Artist.priceElasticitiesRun names an existing
PricingModelRun; only ONE run is live on artists and on PRICE_NEIGHBOUR edges; every
elasticity list has the run's column count. No priors at all also fails — the check exists
to be run after the writer, and an empty graph is not a fresh one.

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/check_price_priors_fresh.py          # exits 1 when stale
"""
import os
import sys
from datetime import datetime, timezone

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))


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


# The same MATCH as pricing_ml/export_sales.py, counted. Keep them in step.
EXPORT_COUNT = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)
      -[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
RETURN count(*) AS n
"""

LATEST_MERGE = "MATCH (m:MergeEvent) RETURN max(m.at) AS at"

LATEST_PRICE_DATA = """
MATCH (s:SourceRecord)
WHERE s.fxBackfillAt IS NOT NULL OR s.saleDateBackfillAt IS NOT NULL
   OR s.estimateGBPRepairedAt IS NOT NULL OR s.premiumBasisCorrectedAt IS NOT NULL
RETURN max(s.fxBackfillAt) AS fx, max(s.saleDateBackfillAt) AS sd,
       max(s.estimateGBPRepairedAt) AS est, max(s.premiumBasisCorrectedAt) AS prem
"""

RUNS = "MATCH (r:PricingModelRun) RETURN r.id AS id, r.builtAt AS builtAt, r.sourceRowCount AS sourceRows, size(r.elasticityColumns) AS ncols"

ARTIST_RUNS = """
MATCH (a:Artist) WHERE a.priceElasticitiesRun IS NOT NULL
RETURN a.priceElasticitiesRun AS run, count(*) AS n,
       sum(CASE WHEN a.priceElasticities IS NULL THEN 1 ELSE 0 END) AS noVector,
       collect(DISTINCT size(a.priceElasticities)) AS vectorSizes
"""

EDGE_RUNS = "MATCH (:Artist)-[r:PRICE_NEIGHBOUR]->(:Artist) RETURN r.run AS run, count(*) AS n"


def as_dt(v):
    if v is None:
        return None
    if isinstance(v, str):
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    if hasattr(v, "to_native"):
        d = v.to_native()
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return v


def main():
    load_env()
    uri, user, pw = os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")
    if not all([uri, user, pw]):
        print("NEO4J_* not set — cannot check the live graph")
        sys.exit(2)
    failures = []
    drv = GraphDatabase.driver(uri, auth=(user, pw))
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        runs = {r["id"]: r for r in s.run(RUNS)}
        artist_runs = s.run(ARTIST_RUNS).data()
        edge_runs = s.run(EDGE_RUNS).data()
        latest_merge = as_dt(s.run(LATEST_MERGE).single()["at"])
        pd_row = s.run(LATEST_PRICE_DATA).single()
        latest_price = max((as_dt(v) for v in pd_row.values() if v), default=None)
        rows_now = s.run(EXPORT_COUNT).single()["n"]
    drv.close()

    print(f"PricingModelRun nodes            : {len(runs)}")
    print(f"latest MergeEvent.at             : {latest_merge}")
    print(f"latest SourceRecord price stamp  : {latest_price}")
    print(f"sold priced rows reachable now   : {rows_now}")

    if not artist_runs:
        failures.append("no Artist carries priceElasticitiesRun — the priors have not been written")
    if len(artist_runs) > 1:
        failures.append(f"{len(artist_runs)} different runs are live on artists: {[r['run'] for r in artist_runs]}")
    if len(edge_runs) > 1:
        failures.append(f"{len(edge_runs)} different runs are live on PRICE_NEIGHBOUR edges: {[r['run'] for r in edge_runs]}")
    if edge_runs and artist_runs and {r["run"] for r in edge_runs} != {r["run"] for r in artist_runs}:
        failures.append("PRICE_NEIGHBOUR edges and artist tags are from different runs")

    for ar in artist_runs:
        rid = ar["run"]
        run = runs.get(rid)
        print(f"run on {ar['n']} artist(s)                : {rid}")
        if run is None:
            failures.append(f"run {rid!r} on {ar['n']} artist(s) has no PricingModelRun node")
            continue
        built = as_dt(run["builtAt"])
        print(f"  builtAt {built}  sourceRowCount {run['sourceRows']}")
        if ar["noVector"]:
            failures.append(f"{ar['noVector']} artist(s) tagged {rid!r} have no priceElasticities vector")
        bad_sizes = [n for n in ar["vectorSizes"] if n is not None and n != run["ncols"]]
        if bad_sizes:
            failures.append(f"artists tagged {rid!r} carry elasticity vectors of size {bad_sizes}, run has {run['ncols']} columns")
        if latest_merge and built and latest_merge > built:
            failures.append(f"STALE: run built {built.isoformat()} predates the latest MergeEvent {latest_merge.isoformat()} — rebuild the priors")
        if latest_price and built and latest_price > built:
            failures.append(f"STALE: run built {built.isoformat()} predates the latest SourceRecord price stamp {latest_price.isoformat()} — rebuild the priors")
        if run["sourceRows"] is not None and int(run["sourceRows"]) != int(rows_now):
            failures.append(f"STALE: run was built from {run['sourceRows']} sold priced rows, the graph now has {rows_now} — rebuild the priors")

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"  {f}")
        sys.exit(1)
    print("\nok   price priors are fresh: one live run, built after the latest merge and price-data write, row count matches")


if __name__ == "__main__":
    main()
