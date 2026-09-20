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

--year-currency GBP (2026-09-16) fits the sale-year index on sterling-priced sales only. The
house offsets still use every sale. Converted dollar hammers carry the exchange rate's drift,
(sterling averaged $1.58 in 2010-15 and $1.30 in 2017-25), which put a false long-run rise into the all-currency index (docs/research/
print-market-year-index-2026-09-16.md). Every build reports a 90% work-cluster bootstrap band
per year, relative to --band-anchor.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/house_offsets.py \
        --exclude tests/backtest/comps_hammer/{forum,roseberys,bonhams}_n2500_blend_recency.jsonl \
        --year-currency GBP --out knowledge_graph/pricing_ml/blend/house_offsets_gbp_years.json

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
VERSION = "HOUSE-OFFSETS-1.1"

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
                  hammer: s.hammerPriceGBP, currency: s.priceCurrency, signed: signed}) AS sales
WHERE size(sales) >= 2
UNWIND sales AS x
RETURN cw.id AS work, x.house AS house, x.saleId AS saleId, x.lot AS lot, x.date AS date, x.hammer AS hammer, x.signed AS signed, x.currency AS currency
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
    ap.add_argument("--year-currency", default=None,
                    help="fit the year index on sales priced in this currency only (e.g. GBP); house offsets still use every sale")
    ap.add_argument("--band-anchor", type=int, default=2025, help="year the reported year bands are relative to")
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
        rows.append({"work": r["work"], "house": r["house"], "year": int(r["date"][:4]), "hammer": float(r["hammer"]), "signed": r["signed"], "currency": r.get("currency")})
    # A work needs >= 2 sales AFTER the exclusion to say anything.
    per_work = Counter(r["work"] for r in rows)
    rows = [r for r in rows if per_work[r["work"]] >= 2]
    # The year index can come from one currency's sales: converted hammers carry the exchange
    # rate's drift (sterling fell ~18% against the dollar after 2016), which a GBP-only index does not.
    year_rows = rows
    if args.year_currency:
        year_rows = [r for r in rows if r["currency"] == args.year_currency]
        pw = Counter(r["work"] for r in year_rows)
        year_rows = [r for r in year_rows if pw[r["work"]] >= 2]
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
    year_years = sorted({r["year"] for r in year_rows})
    year_houses = sorted({r["house"] for r in year_rows})
    if args.year_currency:
        _, year, *_ = fit(year_rows, year_houses, year_years)

    rng = np.random.default_rng(args.seed)
    works = sorted({r["work"] for r in rows})
    rows_by_work = defaultdict(list)
    for r in rows:
        rows_by_work[r["work"]].append(r)
    draws = defaultdict(list)
    year_draws = defaultdict(list)
    for b in range(args.bootstrap):
        sample = []
        for k, w in enumerate(rng.choice(len(works), size=len(works), replace=True)):
            # Relabel so a work drawn twice gets two fixed effects, as two independent clusters should.
            sample.extend({**r, "work": f"{works[w]}#{k}"} for r in rows_by_work[works[w]])
        h_b, y_b, *_ = fit(sample, houses, years)
        for h, v in h_b.items():
            draws[h].append(v)
        if not args.year_currency:
            for yy, v in y_b.items():
                if args.band_anchor in y_b:
                    year_draws[yy].append(v - y_b[args.band_anchor])
    if args.year_currency:
        # Same work-cluster bootstrap over the year-index rows.
        yw = defaultdict(list)
        for r in year_rows:
            yw[r["work"]].append(r)
        ywl = sorted(yw)
        for b in range(args.bootstrap):
            sample = []
            for k, w in enumerate(rng.choice(len(ywl), size=len(ywl), replace=True)):
                sample.extend({**r, "work": f"{ywl[w]}#{k}"} for r in yw[ywl[w]])
            _, y_b, *_ = fit(sample, year_houses, year_years)
            for yy, v in y_b.items():
                if args.band_anchor in y_b:
                    year_draws[yy].append(v - y_b[args.band_anchor])

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

    year_sales = Counter(r["year"] for r in year_rows)
    year_works = {yy: len({r["work"] for r in year_rows if r["year"] == yy}) for yy in year_years}
    year_bands = {}
    print(f"\nyear index ({args.year_currency or 'all currencies'}; {len(year_rows)} sales) vs {args.band_anchor}, 90% work-cluster bootstrap band:")
    for yy in year_years:
        d = np.array(year_draws[yy])
        pt = year[yy] - year.get(args.band_anchor, 0.0)
        lo, hi_ = (float(np.percentile(d, 5)), float(np.percentile(d, 95))) if len(d) else (pt, pt)
        year_bands[str(yy)] = {"logVsAnchor": pt, "ci90": [lo, hi_], "sales": year_sales[yy], "works": year_works[yy]}
        print(f"  {yy}  x{np.exp(pt):.2f}  [x{np.exp(lo):.2f} - x{np.exp(hi_):.2f}]  sales {year_sales[yy]:5d}  works {year_works[yy]:5d}")

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
        "yearIndexCurrency": args.year_currency or "all",
        "yearBands": {"anchor": args.band_anchor, "bootstrap": args.bootstrap, "years": year_bands},
        "signed": {"true": b_signed, "unknown": b_signed_unknown},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    print(f"\nwritten {args.out}")


if __name__ == "__main__":
    main()
