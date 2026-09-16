"""
house_offsets — the like-for-like price level of each auction house, from repeat sales.

Plan docs/plans/2026-09-16-stage3-blend-valuation.md, phase 1. The step-8 blend failed its
cross-house gate because every witness carries a house offset nobody measured: Forum sells
below the Bonhams reference the pricing model was fitted on, and a Forum lot's comps are
Bonhams sales. This measures that offset on the SAME work sold at different houses, so it is a
house effect and not a mix effect (Bonhams sells more hand-signed Picasso than Forum does).

Model, on log(hammer GBP at the sale-date rate), over every ConceptualWork with >= 2 dated,
sold, hammer-priced auction records:

    log hammer = work fixed effect + house effect + sale-year effect + signed effect + e

Solved as one sparse least squares (work dummies absorb the work). Bonhams is the reference
house (0), as in build_priors.py REFS. Uncertainty is a work-cluster bootstrap. The residual
SD is the within-work dispersion (tau) a single same-work comp carries.

Only the works that sold at two or more houses identify a house effect; single-house repeat
sales still identify the year and signed terms. Both are reported.

--exclude takes comps_hammer `--blend` jsonl files: every lot in them is dropped from the fit,
so the gate never scores a lot whose own hammer helped set the offset.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/house_offsets.py \
        --exclude tests/backtest/comps_hammer/forum_n2500_blend_recency.jsonl \
                  tests/backtest/comps_hammer/roseberys_n2500_blend_recency.jsonl \
        --out knowledge_graph/pricing_ml/blend/house_offsets.json

Read-only against the graph. Writes one JSON.
"""
import argparse
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np
from neo4j import GraphDatabase
from scipy.sparse import csr_matrix
from scipy.sparse.linalg import lsqr

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE_HOUSE = "Bonhams"
REFERENCE_YEAR = 2020
VERSION = "HOUSE-OFFSETS-1.0"

# The harness's lot-key prefix -> the graph's institutionName.
KEY_HOUSE = {"forum": "Forum Auctions", "roseberys": "Roseberys London", "bonhams": "Bonhams", "skinner": "Skinner"}


def load_env():
    for path in (os.path.join(HERE, "..", ".env"), os.path.join(HERE, "..", "..", ".env")):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


QUERY = """
MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
WITH cw, s, collect(imp.signed)[0] AS signed
WITH cw, collect({house: s.institutionName, saleId: s.saleId, lot: s.lotNumber, date: substring(s.saleDate, 0, 10),
                  hammer: s.hammerPriceGBP, signed: signed}) AS sales
WHERE size(sales) >= 2
UNWIND sales AS x
RETURN cw.id AS work, x.house AS house, x.saleId AS saleId, x.lot AS lot, x.date AS date, x.hammer AS hammer, x.signed AS signed
"""


def excluded_keys(paths):
    keys = set()
    for p in paths or []:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                # Bonhams lots reuse source:"roseberys" in the harness; the blend inputs carry the real house.
                tag = (r.get("blend") or {}).get("inputs", {}).get("house") or r.get("source")
                house = KEY_HOUSE.get(tag)
                if house and r.get("saleId") is not None and r.get("lotNumber") is not None:
                    keys.add((house, str(r["saleId"]), int(r["lotNumber"])))
    return keys


def fit(rows, houses, years):
    """Sparse LSQ. Columns: works | houses (minus reference) | years (minus reference) | signed=true | signed=unknown."""
    works = sorted({r["work"] for r in rows})
    wi = {w: i for i, w in enumerate(works)}
    hcols = [h for h in houses if h != REFERENCE_HOUSE]
    ycols = [y for y in years if y != REFERENCE_YEAR]
    hi = {h: len(works) + i for i, h in enumerate(hcols)}
    yi = {y: len(works) + len(hcols) + i for i, y in enumerate(ycols)}
    sig_true = len(works) + len(hcols) + len(ycols)
    sig_unknown = sig_true + 1
    data, ri, ci, y = [], [], [], []
    for n, r in enumerate(rows):
        cols = [wi[r["work"]]]
        if r["house"] in hi:
            cols.append(hi[r["house"]])
        if r["year"] in yi:
            cols.append(yi[r["year"]])
        if r["signed"] is True:
            cols.append(sig_true)
        elif r["signed"] is None:
            cols.append(sig_unknown)
        for c in cols:
            ri.append(n); ci.append(c); data.append(1.0)
        y.append(np.log(r["hammer"]))
    X = csr_matrix((data, (ri, ci)), shape=(len(rows), sig_unknown + 1))
    y = np.array(y)
    beta = lsqr(X, y, atol=1e-10, btol=1e-10, iter_lim=20000)[0]
    resid = y - X @ beta
    # Degrees of freedom: one work effect per work is spent, so the within-work SD needs that correction.
    dof = max(len(rows) - X.shape[1], 1)
    tau = float(np.sqrt((resid ** 2).sum() / dof))
    house = {REFERENCE_HOUSE: 0.0, **{h: float(beta[hi[h]]) for h in hcols}}
    year = {REFERENCE_YEAR: 0.0, **{yy: float(beta[yi[yy]]) for yy in ycols}}
    return house, year, float(beta[sig_true]), float(beta[sig_unknown]), tau, resid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exclude", nargs="*", default=[])
    ap.add_argument("--out", default=os.path.join(HERE, "blend", "house_offsets.json"))
    ap.add_argument("--bootstrap", type=int, default=200)
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()

    load_env()
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
        raw = [dict(r) for r in session.run(QUERY)]
    driver.close()

    skip = excluded_keys(args.exclude)
    rows, dropped = [], 0
    for r in raw:
        if (r["house"], str(r["saleId"]), int(r["lot"]) if r["lot"] is not None else None) in skip:
            dropped += 1
            continue
        rows.append({"work": r["work"], "house": r["house"], "year": int(r["date"][:4]), "hammer": float(r["hammer"]), "signed": r["signed"]})
    # A work needs >= 2 sales AFTER the exclusion to say anything.
    per_work = Counter(r["work"] for r in rows)
    rows = [r for r in rows if per_work[r["work"]] >= 2]
    houses = sorted({r["house"] for r in rows})
    years = sorted({r["year"] for r in rows})

    by_work = defaultdict(set)
    for r in rows:
        by_work[r["work"]].add(r["house"])
    multi = {w for w, hs in by_work.items() if len(hs) >= 2}
    identifying = Counter(h for w in multi for h in by_work[w])

    print(f"records: {len(raw)} on works with >=2 sales; excluded as gate lots: {dropped}; kept {len(rows)} on {len(per_work) and len({r['work'] for r in rows})} works")
    print(f"works sold at >=2 houses (identify the house effect): {len(multi)}; per house: {dict(identifying)}")

    house, year, b_signed, b_signed_unknown, tau, _ = fit(rows, houses, years)

    rng = np.random.default_rng(args.seed)
    works = sorted({r["work"] for r in rows})
    rows_by_work = defaultdict(list)
    for r in rows:
        rows_by_work[r["work"]].append(r)
    draws = defaultdict(list)
    for b in range(args.bootstrap):
        sample = []
        for k, w in enumerate(rng.choice(len(works), size=len(works), replace=True)):
            # Relabel so a work drawn twice gets two fixed effects, as two independent clusters should.
            sample.extend({**r, "work": f"{works[w]}#{k}"} for r in rows_by_work[works[w]])
        h_b, *_ = fit(sample, houses, years)
        for h, v in h_b.items():
            draws[h].append(v)

    out_houses = {}
    print(f"\nhouse offsets vs {REFERENCE_HOUSE} (log hammer; same work, year and signed held fixed), work-cluster bootstrap x{args.bootstrap}:")
    for h in houses:
        d = np.array(draws[h])
        lo, hi_ = (float(np.percentile(d, 5)), float(np.percentile(d, 95))) if len(d) else (0.0, 0.0)
        se = float(d.std(ddof=1)) if len(d) > 1 else 0.0
        out_houses[h] = {"log": house[h], "multiplier": float(np.exp(house[h])), "se": se, "ci90": [lo, hi_],
                         "identifyingWorks": identifying.get(h, 0), "sales": sum(1 for r in rows if r["house"] == h)}
        print(f"  {h:28s} {house[h]:+.3f}  x{np.exp(house[h]):.2f}  90% CI x{np.exp(lo):.2f}-x{np.exp(hi_):.2f}  se {se:.3f}  works at 2+ houses {identifying.get(h, 0)}  sales {out_houses[h]['sales']}")
    # Pooled fallback for a house with no hammer data: mean of the measured houses, weighted by
    # identifying works, with its spread as the extra sigma the witness must carry.
    measured = [(v["log"], max(v["identifyingWorks"], 1)) for v in out_houses.values()]
    wsum = sum(w for _, w in measured)
    pooled = sum(l * w for l, w in measured) / wsum
    spread = float(np.sqrt(sum(w * (l - pooled) ** 2 for l, w in measured) / wsum))
    print(f"  pooled fallback (unmeasured house): {pooled:+.3f} x{np.exp(pooled):.2f}, between-house SD {spread:.3f}")
    print(f"within-work residual SD (tau): {tau:.3f}; signed=true {b_signed:+.3f} (x{np.exp(b_signed):.2f}), signed unknown {b_signed_unknown:+.3f}")

    result = {
        "version": VERSION,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "referenceHouse": REFERENCE_HOUSE,
        "method": "log hammer = work FE + house + sale year + signed; sparse LSQ over works with >=2 dated sold hammer records; work-cluster bootstrap",
        "records": len(rows), "works": len(works), "multiHouseWorks": len(multi),
        "excludedGateLots": dropped, "excludeFiles": args.exclude,
        "houses": out_houses,
        "pooledFallback": {"log": pooled, "betweenHouseSd": spread},
        "tau": tau,
        "yearEffects": {str(k): v for k, v in sorted(year.items())},
        "signed": {"true": b_signed, "unknown": b_signed_unknown},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    print(f"\nwritten {args.out}")


if __name__ == "__main__":
    main()
