"""
PrintMasterAI — a database of price-feature elasticities per artist, with priors from similar
artists where an artist's own sales are too few to estimate them.
Version: PRICING-PRIORS-1.0

The transfer test (transfer_test.py) showed the multipliers are artist-specific: a signed
premium of x2.2 for Picasso and x1.5 for Rembrandt, an edition-size effect that INVERTS between
modern masters and contemporary editions. So a single pooled model mis-prices, and a thin
artist's own fit is noise. The answer is the usual one — a hierarchical estimate:

    elasticity_artist = (n_own * own_estimate + kappa * prior) / (n_own + kappa)

where `prior` is a similarity-weighted average of the elasticities of the artist's NEAREST
NEIGHBOURS in a market-descriptor space (price level, period, technique mix, edition sizes,
share signed, nationality, house mix), estimated only from artists with enough sales to be
trusted as donors, and `kappa` is a pseudo-count chosen on held-out later sales. A thin artist
borrows almost everything; a Picasso borrows almost nothing.

What is stored (priors/artist_elasticities.json + neighbours.csv):
  per artist — each elasticity's shrunk value, own value and own support (rows carrying the
  level), the prior it was shrunk toward, the kappa, the neighbours that formed the prior, the
  artist's price level (intercept on deflated log hammer), and the descriptor vector.

Elasticities are read off a log-linear model with reference levels dropped, on log hammer
DEFLATED by pooled sale-year effects, so an artist's fit is about attributes and not about
when their lots happened to sell. Continuous terms are elasticities per doubling.

Evaluation (temporal, sales after --cut): for artists grouped by how many earlier sales they
have, MAE(log) of own-only, prior-only, shrunk (per kappa), the pooled model and the house
estimate. The kappa that minimises MAE over all test rows is the one stored.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/build_priors.py \
        knowledge_graph/pricing_ml/data/all_sales.csv --cut 2024-07-01
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_price_model import build_features  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# Reference levels: the design drops these, so every coefficient is "vs the reference".
REFS = {"signature": "unsigned", "proof": "numbered", "edition_band": "76-150", "area_band": "400-900",
        "process": "lithograph", "house": "Bonhams"}
CONT = ["edition_log", "area_log"]
MIN_LEVEL_ROWS = 3        # an artist's own coefficient for a level is trusted only with this many rows on it
MIN_OWN = 15              # below this many earlier sales an artist gets the prior outright
DONOR_MIN = 100           # neighbours are drawn from artists with at least this many earlier sales
K_NEIGHBOURS = 10
KAPPAS = [0, 10, 30, 60, 120, 300]
ALPHA = 1.0


def design(feat: pd.DataFrame, columns=None):
    parts = []
    for c, ref in REFS.items():
        d = pd.get_dummies(feat[c].astype(str), prefix=c, dtype=float)
        d = d.drop(columns=[f"{c}_{ref}"], errors="ignore")
        parts.append(d)
    cont = pd.DataFrame({c: feat[c] for c in CONT}, index=feat.index)
    X = pd.concat(parts + [cont], axis=1)
    if columns is not None:
        X = X.reindex(columns=columns, fill_value=0.0)
    return X


def level_support(feat_rows: pd.DataFrame, columns):
    """How many rows carry each dummy (continuous terms: rows with a value)."""
    out = {}
    for col in columns:
        if col in CONT:
            out[col] = int(feat_rows[col].notna().sum())
        else:
            c = next(k for k in REFS if col.startswith(k + "_"))
            lvl = col[len(c) + 1:]
            out[col] = int((feat_rows[c].astype(str) == lvl).sum())
    return out


def mae(y, p):
    e = np.asarray(p) - np.asarray(y)
    return float(np.abs(e).mean()), float(100 * (np.abs(e) <= math.log(2)).mean())


def descriptors(df_a: pd.DataFrame, feat_a: pd.DataFrame, ydefl_a: pd.Series) -> dict:
    """Market descriptors of one artist from their earlier sales + graph fields."""
    proc = feat_a["process"].astype(str)
    nat = str(df_a["artistNationality"].mode().iloc[0]) if df_a["artistNationality"].notna().any() else "unknown"
    born = pd.to_numeric(df_a["artistBorn"], errors="coerce").dropna()
    wy = feat_a["work_year"].dropna()
    return {
        "log_price_level": float(ydefl_a.median()),
        "log_price_spread": float(ydefl_a.quantile(0.9) - ydefl_a.quantile(0.1)),
        "share_hand_signed": float((feat_a["signature"] == "hand").mean()),
        "share_unsigned": float((feat_a["signature"] == "unsigned").mean()),
        "median_log_edition": float(feat_a["edition_log"].median()) if feat_a["edition_log"].notna().any() else float("nan"),
        "median_log_area": float(feat_a["area_log"].median()) if feat_a["area_log"].notna().any() else float("nan"),
        "share_intaglio": float(feat_a["tech_family"].eq("intaglio").mean()),
        "share_plano": float(feat_a["tech_family"].eq("planographic").mean()),
        "share_screen": float(feat_a["tech_family"].eq("screen").mean()),
        "share_relief": float(feat_a["tech_family"].eq("relief").mean()),
        "share_photomech": float(feat_a["tech_family"].eq("photomechanical").mean()),
        "share_ap": float((feat_a["proof"] == "artist_proof").mean()),
        "median_work_year": float(wy.median()) if len(wy) else float("nan"),
        "born": float(born.median()) if len(born) else float("nan"),
        "share_bonhams": float((df_a["house"] == "Bonhams").mean()),
        "nat_british": float(bool(__import__("re").search(r"brit|english|scot|welsh", nat.lower()))),
        "nat_american": float("american" in nat.lower()),
        "nat_french": float("french" in nat.lower()),
        "nat_spanish": float("spanish" in nat.lower()),
        "nat_german": float("german" in nat.lower()),
        "nationality": nat,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv")
    ap.add_argument("--cut", default="2024-07-01")
    ap.add_argument("--min-year", default="2010")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "priors"))
    args = ap.parse_args()

    df = pd.read_csv(args.csv, low_memory=False)
    df = df[df["saleDate"] >= args.min_year]
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")]
    df = df[df["artist"].notna()].reset_index(drop=True)
    feat = build_features(df)
    y = np.log(df["hammerGBP"].astype(float))
    train = (df["saleDate"] < args.cut).values
    test = ~train
    fx = df["fxRateToGBP"].astype(float).where(df["fxRateToGBP"].astype(float) > 0)
    est = ((df["estimateLow"].astype(float) + df["estimateHigh"].astype(float)) / 2) / fx
    est_log = np.log(est.where(est > 0))

    # 1. pooled model: artist intercepts + shared slopes + sale-year effects -> deflate by year
    X = design(feat)
    med = {c: float(X.loc[train, c].median()) for c in CONT}
    for c in CONT:
        X[c] = X[c].fillna(med[c])
    years = pd.to_datetime(df["saleDate"]).dt.year
    Y = pd.get_dummies(years.astype(str), prefix="year", dtype=float)
    A = pd.get_dummies(df["artist"], prefix="artist", dtype=float)
    Xp = pd.concat([X, Y, A], axis=1)
    pooled = Ridge(alpha=ALPHA).fit(Xp[train], y[train])
    coefp = pd.Series(pooled.coef_, index=Xp.columns)
    year_eff = {int(k[5:]): float(v) for k, v in coefp.items() if k.startswith("year_")}
    last_train_year = int(years[train].max())
    theta = years.apply(lambda yr: year_eff.get(int(yr), year_eff.get(last_train_year, 0.0)))
    ydefl = y - theta
    cols = list(X.columns)
    n_art = df.loc[train, "artist"].value_counts()
    print(f"rows={len(df)} artists={df['artist'].nunique()}  train={train.sum()} test={test.sum()}  "
          f"artists with >={MIN_OWN} earlier sales: {(n_art >= MIN_OWN).sum()}, donors (>={DONOR_MIN}): {(n_art >= DONOR_MIN).sum()}")

    # 2. own fits per artist on deflated log price (attributes only), with per-level support
    own_beta, own_support, own_n, level = {}, {}, {}, {}
    for a, n in n_art.items():
        m = train & (df["artist"] == a).values
        own_n[a] = int(n)
        if n < MIN_OWN:
            continue
        r = Ridge(alpha=ALPHA).fit(X[m], ydefl[m])
        own_beta[a] = pd.Series(r.coef_, index=cols)
        own_support[a] = level_support(feat[m], cols)

    # 3. descriptors and neighbours (donors only)
    desc = {}
    for a in n_art.index:
        m = train & (df["artist"] == a).values
        if m.sum() >= MIN_OWN:
            desc[a] = descriptors(df[m], feat[m], ydefl[m])
    D = pd.DataFrame(desc).T
    num_cols = [c for c in D.columns if c != "nationality"]
    Dn = D[num_cols].astype(float)
    Dn = (Dn - Dn.mean()) / Dn.std().replace(0, 1)
    Dn = Dn.fillna(0.0)
    weights = pd.Series(1.0, index=num_cols)
    weights[["log_price_level", "median_work_year", "born"]] = 2.0     # market tier and period count double
    donors = [a for a in Dn.index if own_n[a] >= DONOR_MIN]
    neighbours = {}
    for a in Dn.index:
        d = ((Dn.loc[donors] - Dn.loc[a]) ** 2 * weights).sum(axis=1).pow(0.5)
        d = d.drop(index=a, errors="ignore").sort_values()[:K_NEIGHBOURS]
        w = np.exp(-d / (d.median() + 1e-9)) * np.sqrt(pd.Series({b: own_n[b] for b in d.index}))
        neighbours[a] = (w / w.sum()).to_dict()

    # global prior (support-weighted mean over donors) as the last resort
    def prior_for(a):
        nb = neighbours.get(a) or {b: math.sqrt(own_n[b]) for b in donors}
        tot = sum(nb.values())
        nb = {b: w / tot for b, w in nb.items()}
        out = {}
        for col in cols:
            num, den = 0.0, 0.0
            for b, w in nb.items():
                if own_support[b].get(col, 0) >= MIN_LEVEL_ROWS:
                    num += w * own_beta[b][col]
                    den += w
            out[col] = num / den if den > 0 else float("nan")
        return pd.Series(out)
    glob = pd.Series({col: np.average([own_beta[b][col] for b in donors if own_support[b].get(col, 0) >= MIN_LEVEL_ROWS] or [0.0]) for col in cols})
    priors = {a: prior_for(a).fillna(glob) for a in Dn.index}

    # 4. shrink, and evaluate kappa on the test period
    def shrunk(a, kappa):
        pri = priors.get(a, glob)
        if a not in own_beta:
            return pri.copy()
        own, sup, n = own_beta[a], own_support[a], own_n[a]
        out = pri.copy()
        for col in cols:
            if sup.get(col, 0) >= MIN_LEVEL_ROWS:
                out[col] = (n * own[col] + kappa * pri[col]) / (n + kappa)
        return out

    def predict(a, beta, rows):
        m_tr = train & (df["artist"] == a).values
        Xa = X[m_tr]
        intercept = float(np.median(ydefl[m_tr] - Xa.values @ beta.values)) if m_tr.sum() else float(ydefl[train].median())
        return X[rows].values @ beta.values + intercept + theta[rows].values

    bands = [(MIN_OWN, 40), (40, 100), (100, 300), (300, 10 ** 9)]
    print(f"\n── MAE(log) on sales from {args.cut}, by how many EARLIER sales the artist has ──")
    hdr = f"{'earlier sales':<14}{'artists':>8}{'test rows':>10} {'median':>8} {'pooled':>8} {'own':>8} {'prior':>8} " + " ".join(f"k={k:<4}" for k in KAPPAS) + f" {'estimate':>9}"
    print(hdr)
    total = {k: [] for k in KAPPAS}
    total_rows = 0
    for lo, hi in bands:
        arts = [a for a in n_art.index if lo <= own_n[a] < hi and a in priors]
        rows_idx = test & df["artist"].isin(arts).values
        if not rows_idx.sum():
            continue
        yt = y[rows_idx].values
        # per-artist predictions assembled in row order
        def assemble(fn):
            out = pd.Series(np.nan, index=df.index[rows_idx])
            for a in arts:
                r = test & (df["artist"] == a).values
                out.loc[df.index[r]] = fn(a, r)
            return out.values
        p_pool = pooled.predict(Xp[rows_idx])
        p_own = assemble(lambda a, r: predict(a, own_beta[a] if a in own_beta else priors[a], r))
        p_pri = assemble(lambda a, r: predict(a, priors[a], r))
        p_k = {k: assemble(lambda a, r, k=k: predict(a, shrunk(a, k), r)) for k in KAPPAS}
        has_est = est_log[rows_idx].notna().values
        e_est = mae(yt[has_est], est_log[rows_idx].values[has_est])[0] if has_est.sum() >= 10 else float("nan")
        med_pred = assemble(lambda a, r: np.full(r.sum(), y[train & (df["artist"] == a).values].median()))
        label = f"{lo}-{hi}" if hi < 10 ** 9 else f"{lo}+"
        line = f"{label:<14}{len(arts):>8}{int(rows_idx.sum()):>10} {mae(yt, med_pred)[0]:>8.3f} {mae(yt, p_pool)[0]:>8.3f} {mae(yt, p_own)[0]:>8.3f} {mae(yt, p_pri)[0]:>8.3f} "
        line += " ".join(f"{mae(yt, p_k[k])[0]:<6.3f}" for k in KAPPAS) + f" {e_est:>9.3f}"
        print(line)
        for k in KAPPAS:
            total[k].append((mae(yt, p_k[k])[0], int(rows_idx.sum())))
        total_rows += int(rows_idx.sum())
    best_k = min(KAPPAS, key=lambda k: sum(m * n for m, n in total[k]) / max(1, sum(n for _, n in total[k])))
    print(f"\nkappa chosen on all test rows: {best_k}   (" + "  ".join(f"k={k}: {sum(m * n for m, n in total[k]) / max(1, sum(n for _, n in total[k])):.3f}" for k in KAPPAS) + ")")

    # 5. write the priors database
    os.makedirs(args.out_dir, exist_ok=True)
    db = {"version": "PRICING-PRIORS-1.0", "cut": args.cut, "kappa": best_k, "reference_levels": REFS,
          "elasticity_columns": cols, "year_effects": year_eff, "continuous_medians": med, "artists": {}}
    for a in Dn.index:
        b = shrunk(a, best_k)
        m_tr = train & (df["artist"] == a).values
        intercept = float(np.median(ydefl[m_tr] - X[m_tr].values @ b.values))
        db["artists"][a] = {
            "earlier_sales": own_n[a],
            "price_level_log": intercept,
            "elasticities": {col: {"value": float(b[col]), "multiplier": float(math.exp(b[col] * (math.log(2) if col in CONT else 1.0))),
                                    "own": float(own_beta[a][col]) if a in own_beta and own_support[a].get(col, 0) >= MIN_LEVEL_ROWS else None,
                                    "own_support": own_support[a].get(col, 0) if a in own_support else 0,
                                    "prior": float(priors[a][col])} for col in cols},
            "neighbours": neighbours.get(a, {}),
            "descriptors": desc[a],
        }
    with open(os.path.join(args.out_dir, "artist_elasticities.json"), "w") as f:
        json.dump(db, f, indent=1, ensure_ascii=False)
    nb_rows = [(a, b, w) for a, nbs in neighbours.items() for b, w in nbs.items()]
    pd.DataFrame(nb_rows, columns=["artist", "neighbour", "weight"]).to_csv(os.path.join(args.out_dir, "neighbours.csv"), index=False)
    summary = pd.DataFrame({a: {"earlier_sales": own_n[a], "price_level": math.exp(db["artists"][a]["price_level_log"]),
                                **{col: db["artists"][a]["elasticities"][col]["multiplier"] for col in cols}} for a in Dn.index}).T.sort_values("earlier_sales", ascending=False)
    summary.to_csv(os.path.join(args.out_dir, "artist_multipliers.csv"))
    print(f"\nwrote {len(db['artists'])} artists -> {args.out_dir}/artist_elasticities.json, neighbours.csv, artist_multipliers.csv")

    # a few readable examples
    print("\n── Examples: shrunk multipliers (own → prior → stored) ──")
    for a in ["Pablo Picasso", "Banksy", "Rembrandt van Rijn"] + list(summary.index[(summary.earlier_sales >= 20) & (summary.earlier_sales < 40)][:3]):
        if a not in db["artists"]:
            continue
        e = db["artists"][a]["elasticities"]
        nb = sorted(db["artists"][a]["neighbours"].items(), key=lambda kv: -kv[1])[:4]
        def show(col):
            x = e[col]
            own = f"{math.exp(x['own']):.2f}(n={x['own_support']})" if x["own"] is not None else "-"
            return f"{col}: own {own} prior {math.exp(x['prior']):.2f} -> {math.exp(x['value']):.2f}"
        print(f"  {a} (earlier sales {db['artists'][a]['earlier_sales']}; neighbours: {', '.join(f'{b} {w:.2f}' for b, w in nb)})")
        for col in ["signature_hand", "edition_band_>300", "edition_band_<=30", "process_screenprint", "process_etching"]:
            if col in e:
                print("     " + show(col))
        print(f"     area per doubling x{math.exp(e['area_log']['value'] * math.log(2)):.2f}   edition per doubling x{math.exp(e['edition_log']['value'] * math.log(2)):.2f}")


if __name__ == "__main__":
    main()
