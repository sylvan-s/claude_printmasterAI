"""
PrintMasterAI — do attribute multipliers transfer between artists?
Version: PRICING-TRANSFER-1.0

A log-linear price model, log(hammer) = artist level + Σ attribute effects + sale-year effect,
makes each categorical effect a MULTIPLIER and each log-continuous effect an ELASTICITY. If
those are shared across artists, a new artist needs only a level (a few sales) and borrows the
shape. If they are not — if the signed premium or the edition-size elasticity is Picasso's and
not Hirst's — a pooled model mis-prices both.

This fits the same log-linear model three ways on a set of high-volume artists and scores
each artist's LATER sales (temporal cut):

  own      — the artist's own model, fit on that artist's earlier sales only
  pooled   — one model on every artist's earlier sales, artist intercepts, SHARED slopes
  from X   — slopes fit on ONE donor artist (default Picasso), level re-estimated from the
             target artist's earlier sales: the pure transfer

against the artist median and the house estimate. It also prints the per-artist multipliers
side by side so the heterogeneity can be read directly rather than inferred from the scores.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/transfer_test.py \
        knowledge_graph/pricing_ml/data/top10/*.csv --cut 2024-07-01 --donor "Pablo Picasso"
"""
import argparse
import math
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_price_model import build_features  # noqa: E402

CATS = ["signature", "proof", "edition_band", "area_band", "process", "paper", "publisher", "work_decade", "house"]
CONT = ["edition_log", "area_log"]
ALPHA = 2.0


def design(feat: pd.DataFrame, df: pd.DataFrame, columns=None):
    """One-hot every level (no reference dropped — differences within a column are what we
    read), log continuous terms with the column median imputed, sale-year dummies."""
    parts = [pd.get_dummies(feat[c].astype(str), prefix=c, dtype=float) for c in CATS]
    parts.append(pd.get_dummies(pd.to_datetime(df["saleDate"]).dt.year.astype(str), prefix="year", dtype=float))
    cont = pd.DataFrame({c: feat[c].fillna(feat[c].median()) for c in CONT}, index=feat.index)
    X = pd.concat(parts + [cont], axis=1)
    if columns is not None:
        X = X.reindex(columns=columns, fill_value=0.0)
    return X


def mae(y, p):
    e = np.asarray(p) - np.asarray(y)
    return float(np.abs(e).mean()), float(100 * (np.abs(e) <= math.log(2)).mean()), float(math.exp(e.mean()))


def level_diff(coefs: pd.Series, col: str, a: str, b: str):
    ka, kb = f"{col}_{a}", f"{col}_{b}"
    if ka in coefs.index and kb in coefs.index:
        return math.exp(coefs[ka] - coefs[kb])
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csvs", nargs="+")
    ap.add_argument("--cut", default="2024-07-01")
    ap.add_argument("--min-year", default="2010")
    ap.add_argument("--donor", default="Pablo Picasso")
    args = ap.parse_args()

    df = pd.concat([pd.read_csv(p) for p in args.csvs], ignore_index=True)
    df = df[df["saleDate"] >= args.min_year]
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")].reset_index(drop=True)
    feat = build_features(df)
    y = np.log(df["hammerGBP"].astype(float))
    fx = df["fxRateToGBP"].astype(float).where(df["fxRateToGBP"].astype(float) > 0)
    est = ((df["estimateLow"].astype(float) + df["estimateHigh"].astype(float)) / 2) / fx
    est_log = np.log(est.where(est > 0))
    train = df["saleDate"] < args.cut
    artists = [a for a in df["artist"].unique() if (train & (df["artist"] == a)).sum() >= 80 and (~train & (df["artist"] == a)).sum() >= 20]
    print(f"rows={len(df)}  artists with >=80 train / >=20 test sales: {len(artists)}")

    X = design(feat, df)
    cols = X.columns

    # own-artist models and their multipliers
    own = {}
    for a in artists:
        m = train & (df["artist"] == a)
        own[a] = Ridge(alpha=ALPHA).fit(X[m], y[m])
    # pooled with artist intercepts, shared slopes
    A = pd.get_dummies(df["artist"], prefix="artist", dtype=float)
    Xp = pd.concat([X, A], axis=1)
    pooled = Ridge(alpha=ALPHA).fit(Xp[train], y[train])
    # donor
    donor_m = train & (df["artist"] == args.donor)
    donor = Ridge(alpha=ALPHA).fit(X[donor_m], y[donor_m])

    # ── multipliers side by side ──
    print("\n── Multipliers per artist (own model, earlier sales; ratio of levels within one attribute) ──")
    hdr = f"{'artist':<24}{'n':>6} {'signed/unsigned':>16} {'AP/numbered':>12} {'ed<=30/76-150':>14} {'ed>300/76-150':>14} {'area x2':>9} {'edition x2':>11} {'lino/litho':>11} {'etch/litho':>11} {'screen/litho':>13} {'Rosb/Bonh':>10}"
    print(hdr)
    rows_out = []
    for a in artists:
        c = pd.Series(own[a].coef_, index=cols)
        n = int((train & (df["artist"] == a)).sum())
        vals = [
            level_diff(c, "signature", "hand", "unsigned"), level_diff(c, "proof", "artist_proof", "numbered"),
            level_diff(c, "edition_band", "<=30", "76-150"), level_diff(c, "edition_band", ">300", "76-150"),
            math.exp(c["area_log"] * math.log(2)), math.exp(c["edition_log"] * math.log(2)),
            level_diff(c, "process", "linocut", "lithograph"), level_diff(c, "process", "etching", "lithograph"), level_diff(c, "process", "screenprint", "lithograph"),
            level_diff(c, "house", "Roseberys London", "Bonhams"),
        ]
        rows_out.append((a, n, vals))
        f = lambda v, w: (f"{v:>{w}.2f}" if v is not None else f"{'-':>{w}}")
        print(f"{a[:23]:<24}{n:>6} {f(vals[0],16)} {f(vals[1],12)} {f(vals[2],14)} {f(vals[3],14)} {f(vals[4],9)} {f(vals[5],11)} {f(vals[6],11)} {f(vals[7],11)} {f(vals[8],13)} {f(vals[9],10)}")
    cp = pd.Series(pooled.coef_, index=Xp.columns)
    pv = [level_diff(cp, "signature", "hand", "unsigned"), level_diff(cp, "proof", "artist_proof", "numbered"), level_diff(cp, "edition_band", "<=30", "76-150"), level_diff(cp, "edition_band", ">300", "76-150"),
          math.exp(cp["area_log"] * math.log(2)), math.exp(cp["edition_log"] * math.log(2)), level_diff(cp, "process", "linocut", "lithograph"), level_diff(cp, "process", "etching", "lithograph"), level_diff(cp, "process", "screenprint", "lithograph"), level_diff(cp, "house", "Roseberys London", "Bonhams")]
    f = lambda v, w: (f"{v:>{w}.2f}" if v is not None else f"{'-':>{w}}")
    print(f"{'POOLED (shared)':<24}{int(train.sum()):>6} {f(pv[0],16)} {f(pv[1],12)} {f(pv[2],14)} {f(pv[3],14)} {f(pv[4],9)} {f(pv[5],11)} {f(pv[6],11)} {f(pv[7],11)} {f(pv[8],13)} {f(pv[9],10)}")

    # ── scores on each artist's later sales ──
    print(f"\n── MAE(log) on each artist's sales from {args.cut} (within-2x in brackets) ──")
    print(f"{'artist':<24}{'test':>5} {'median':>14} {'own':>14} {'pooled':>14} {'from ' + args.donor.split()[-1]:>14} {'estimate':>14} {'est x drift':>14}")
    agg = {k: [] for k in ["median", "own", "pooled", "donor", "estimate", "drift"]}
    for a in artists:
        tr = train & (df["artist"] == a)
        te = ~train & (df["artist"] == a)
        yt = y[te]
        p_med = np.full(te.sum(), y[tr].median())
        p_own = own[a].predict(X[te])
        p_pool = pooled.predict(Xp[te])
        # donor slopes + target level: intercept = median residual of the target's earlier sales under the donor slopes
        resid = y[tr] - donor.predict(X[tr])
        p_don = donor.predict(X[te]) + np.median(resid)
        has_est = te & est_log.notna()
        drift = float(np.exp(np.median((y - est_log)[tr & est_log.notna()]))) if (tr & est_log.notna()).sum() >= 20 else 0.82
        res = {"median": mae(yt, p_med), "own": mae(yt, p_own), "pooled": mae(yt, p_pool), "donor": mae(yt, p_don)}
        if has_est.sum() >= 10:
            res["estimate"] = mae(y[has_est], est_log[has_est])
            res["drift"] = mae(y[has_est], est_log[has_est] + math.log(drift))
        for k, v in res.items():
            agg[k].append(v[0])
        cell = lambda k: (f"{res[k][0]:.3f} ({res[k][1]:.0f}%)".rjust(14) if k in res else "-".rjust(14))
        print(f"{a[:23]:<24}{int(te.sum()):>5} {cell('median')} {cell('own')} {cell('pooled')} {cell('donor')} {cell('estimate')} {cell('drift')}   drift={drift:.2f}")
    print(f"{'MEAN over artists':<24}{'':>5} " + " ".join(f"{np.mean(agg[k]):.3f}".rjust(14) for k in ["median", "own", "pooled", "donor", "estimate", "drift"]))

    # ── is the heterogeneity in the slopes, or just the levels? pooled + artist x key-slope interactions ──
    inter = [f"{c}_hand" for c in ["signature"]] + ["edition_log", "area_log"] + [f"edition_band_{b}" for b in ["<=30", ">300"]]
    Xi = Xp.copy()
    for a in artists:
        ind = (df["artist"] == a).astype(float)
        for k in inter:
            if k in X.columns:
                Xi[f"{a}×{k}"] = X[k] * ind
    inter_model = Ridge(alpha=ALPHA).fit(Xi[train], y[train])
    print("\n── Pooled + artist-specific slopes for signature / edition / area (does letting the elasticities vary help?) ──")
    for a in artists:
        te = ~train & (df["artist"] == a)
        pp, pi = mae(y[te], pooled.predict(Xp[te]))[0], mae(y[te], inter_model.predict(Xi[te]))[0]
        print(f"  {a[:23]:<24} pooled {pp:.3f} -> +interactions {pi:.3f} ({pi - pp:+.3f})")


if __name__ == "__main__":
    main()
