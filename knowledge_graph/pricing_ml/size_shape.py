"""
size_shape — what shape does sheet size have on price, once who made the print and what it is
are held fixed? (2026-09-16, user question: is there a U-shape — premiums for miniatures AND for
very large sheets, nothing in the middle — that a straight line in log area cannot show?)

Pooled log-hammer model with artist, sale-year, house, signature, proof, edition-band and process
effects but NO size term; the residuals are then grouped into fine sheet-area bins. Reported as a
multiplier per bin against the bins' overall median, for all sales and for the artists with >= 50
sized sales (so the curve is not an artist-mix effect). Descriptive; training rows only.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/size_shape.py knowledge_graph/pricing_ml/data/all_sales_with_subject.csv
"""
import json, math, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from train_price_model import build_features  # noqa: E402

BINS = [0, 150, 250, 400, 600, 900, 1300, 1800, 2500, 3500, 5000, 7500, 1e9]

def main():
    db = json.load(open(os.path.join(HERE, "priors", "artist_elasticities.json")))
    df = pd.read_csv(sys.argv[1], low_memory=False)
    df = df[df["saleDate"] >= db["min_year"]]
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")]
    df = df[df["artist"].notna()].reset_index(drop=True)
    feat = build_features(df)
    train = (df["saleDate"] < db["cut"]).values
    y = np.log(df["hammerGBP"].astype(float))
    parts = [pd.get_dummies(df["artist"], prefix="a", dtype=float), pd.get_dummies(df["saleDate"].str[:4], prefix="y", dtype=float), pd.get_dummies(df["house"].fillna("?"), prefix="h", dtype=float)]
    for c in ["signature", "proof", "edition_band", "process"]:
        parts.append(pd.get_dummies(feat[c].astype(str), prefix=c, dtype=float))
    X = pd.concat(parts, axis=1)
    m = Ridge(alpha=1.0).fit(X[train], y[train])
    resid = pd.Series(y - m.predict(X), index=df.index)
    area = np.exp(feat["area_log"])
    sized = train & area.notna().values
    per_artist = df.loc[sized, "artist"].value_counts()
    deep = df["artist"].isin(per_artist[per_artist >= 50].index).values & sized
    for label, mask in [("all sized training sales", sized), ("artists with >= 50 sized sales", deep)]:
        r = resid[mask]; a = area[mask]
        b = pd.cut(a, BINS, right=False)
        g = r.groupby(b, observed=True).agg(["median", "count"])
        centre = r.median()
        print(f"\n{label}: {int(mask.sum())} sales, {df.loc[mask, 'artist'].nunique()} artists")
        print(f"  {'sheet area (cm²)':<22}{'~side (cm)':>11}{'sales':>8}{'price vs typical':>18}")
        for iv, row in g.iterrows():
            lo, hi = iv.left, iv.right
            side = f"{math.sqrt(lo):.0f}-{math.sqrt(hi):.0f}" if hi < 1e8 else f"{math.sqrt(lo):.0f}+"
            rng = f"{lo:,.0f}-{hi:,.0f}" if hi < 1e8 else f"{lo:,.0f}+"
            print(f"  {rng:<22}{side:>11}{int(row['count']):>8}{'x' + format(math.exp(row['median'] - centre), '.2f'):>18}")

if __name__ == "__main__":
    main()
