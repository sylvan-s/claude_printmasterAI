"""
column_means — the training population's average of every pricing-model column, so a lot's
contribution chart can be centred on "the average sold print" (plan docs/plans/2026-09-16-
stage3-blend-valuation.md, phase 5).

For a log-linear model the exact SHAP value of column j is beta_j * (x_j - E[x_j]). The
elasticities and reference levels live in priors/artist_elasticities.json (and the graph's
PricingModelRun); the E[x_j] were never stored. This rebuilds the design matrix exactly as
build_priors.py does (same filters, same features, continuous terms filled with the training
median) and writes, over the TRAINING rows (sale date before the priors' cut):

    baselineLogHammer   mean log hammer GBP: the chart's starting bar, "the average sold print"
    columns             mean of every elasticity column (dummy shares; filled log values)
    meanYearEffect      mean of the pooled sale-year effect over those rows
    houseShares         share of rows per house, for centring the house price level

Read-only. Writes priors/column_means.json, stamped with the priors build it matches.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/column_means.py \
        knowledge_graph/pricing_ml/data/all_sales_with_subject.csv
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_priors import design, CONT, REFS, SUBJECT_FLAGS, XL_AREA_CM2  # noqa: E402
from train_price_model import build_features  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv")
    ap.add_argument("--priors", default=os.path.join(HERE, "priors", "artist_elasticities.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "priors", "column_means.json"))
    ap.add_argument("--size-terms", choices=["both", "bands", "shape-bands", "shape-bands+log", "shape-bands+xl"], default="both",
                    help="must match the priors build (build_priors.py --size-terms)")
    args = ap.parse_args()

    db = json.load(open(args.priors))
    cut, min_year, cols = db["cut"], db["min_year"], db["elasticity_columns"]

    # Mirrors build_priors.main's filtering, feature build and design exactly.
    df = pd.read_csv(args.csv, low_memory=False)
    df = df[df["saleDate"] >= min_year]
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")]
    df = df[df["artist"].notna()].reset_index(drop=True)
    feat = build_features(df)
    if args.size_terms.startswith("shape-bands"):
        # Mirrors build_priors.py: bands cut where the measured price curve bends.
        area = np.exp(feat["area_log"])
        feat["area_band"] = np.select(
            [area.isna(), area < 400, area < 900, area < 1800, area < 7500],
            ["unknown", "<400", "400-900", "900-1800", "1800-7500"], default=">7500")
    feat["area_log_xl"] = (feat["area_log"] - np.log(XL_AREA_CM2)).clip(lower=0).fillna(0.0)
    if args.size_terms in ("bands", "shape-bands", "shape-bands+xl") and "area_log" in CONT:
        CONT.remove("area_log")
    if args.size_terms == "shape-bands+xl" and "area_log_xl" not in CONT:
        CONT.append("area_log_xl")
    if args.size_terms.startswith("shape-bands"):
        REFS["area_band"] = "1800-7500"
    for col, cat in SUBJECT_FLAGS.items():
        feat[col] = (feat["subject"] == cat).astype(float)
    # Continuous terms the build dropped (edition_log under --edition-terms bands) are not columns here.
    for c in [c for c in CONT if c not in cols]:
        CONT.remove(c)
    train = (df["saleDate"] < cut).values
    X = design(feat, columns=cols)
    for c in CONT:
        if c in X:
            X[c] = X[c].fillna(db["continuous_medians"][c])
    Xt = X[train]
    y = np.log(df.loc[train, "hammerGBP"].astype(float))
    years = pd.to_datetime(df.loc[train, "saleDate"]).dt.year.astype(str)
    ye = db["year_effects"]
    year_eff = years.map(lambda yr: ye.get(yr, 0.0))
    houses = df.loc[train, "house"].fillna("unknown").value_counts(normalize=True)

    if int(train.sum()) != int(db["train_rows"]):
        print(f"WARNING: {int(train.sum())} training rows here vs {db['train_rows']} in the priors build — the export differs from the one the priors were built on")

    out = {
        "version": "COLUMN-MEANS-1.0",
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "priorsVersion": db["version"],
        "priorsBuiltAt": db["built_at"],
        "trainRows": int(train.sum()),
        "baselineLogHammer": float(y.mean()),
        "columns": {c: float(Xt[c].mean()) for c in cols},
        "meanYearEffect": float(year_eff.mean()),
        "houseShares": {str(h): float(s) for h, s in houses.items()},
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"{out['trainRows']} training rows; baseline hammer GBP {np.exp(out['baselineLogHammer']):.0f}; mean year effect {out['meanYearEffect']:+.3f}; houses {json.dumps({h: round(s, 3) for h, s in out['houseShares'].items()})}")
    print("signature shares:", {c: round(v, 3) for c, v in out["columns"].items() if c.startswith("signature_")})
    print(f"written {args.out}")


if __name__ == "__main__":
    main()
