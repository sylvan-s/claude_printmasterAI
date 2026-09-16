"""
PrintMasterAI — a database of price-feature elasticities per artist, with priors from similar
artists where an artist's own sales are too few to estimate them.
Version: PRICING-PRIORS-1.2 (default); PRICING-PRIORS-1.3 with --with-citation, which FAILED its gate

1.3 (2026-09-16, opt-in, not adopted) adds `catalogue_cited` (1 iff the lot's catalogue text cites a catalogue
raisonne, i.e. train_price_model's has_citation), per plan docs/plans/2026-09-16-stage3-blend-
valuation.md phase 2. Only presence, not WHICH catalogue: within one artist the catalogue is
nearly constant (Bloch = Picasso), so the identity is an artist proxy the per-artist level
already carries. Citation practice is house-specific (Bonhams cites 51% of lots, Roseberys 8.5%),
which the house columns absorb. Temporal gate (cut 2024-07-01, same export): MAE(log) at the
chosen kappa 0.654 with the column vs 0.652 without. It helped only the 5-15-sale band (0.693 ->
0.688) and hurt 100-300 and 300+ (0.687 -> 0.696). The effect is real descriptively (x1.42 within
Bonhams with artist, year, signature, edition, process and area held fixed; median shrunk artist
x1.15, but x0.91 Miro to x2.47 Rembrandt) and does not carry to later sales, so the production
build stays 1.2 and the chart never shows citation.

1.2 (2026-09-14) adds three CLIP-subject indicator columns: subject_is_abstract,
subject_is_comic_satirical, subject_is_surreal (1 iff DigitalImage.clipSubject is that category
AND clipSubjectConfident, else 0 -- see clip_subject_classifier.py and the README section "Image
subject (CLIP zero-shot)"). Market-wide, subject looked like a big price driver, but a drop-one
ablation and an artist-controlled regression showed it was mostly a proxy for WHICH ARTIST made
the piece (comic_satirical was 36% James Gillray). The one thing that DID survive controlling
for artist identity, on the 7 artists whose own sales span enough subjects to test it (Picasso,
Warhol, Hockney, Moore, Matisse, Piper, Dali): abstract and comic/satirical still carried a
same-artist discount (x0.54, x0.61 vs. a portrait by the same hand); surreal was inconclusive in
that small sample (x1.22, n=23) but included here since it was the third candidate the user
wanted priced in and per-artist shrinkage is exactly the tool for "maybe real, thin data" bets.
The other 7 subject categories (portrait, nude, landscape, animal, still_life, religious_
mythological, genre_scene) are NOT added as elasticity columns: their effect collapsed to ~1.0x
once artist was controlled for, so a market-wide "genre_scene reference" column would mostly
encode which artists happen to shoot street photography, not a printmaking subject effect.

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

Since 1.1 there are three tiers of artist, by how many earlier sales they have:
  >= MIN_OWN (15)   own fit shrunk toward the neighbour prior            basis "shrunk"
  >= MIN_DESC (5)   the neighbour prior outright — the few sales are enough to place the
                    artist in descriptor space (price level, signed share, technique mix,
                    period, nationality) and pick donors, not enough to fit 33 coefficients
                                                                          basis "prior"
  < MIN_DESC        nothing per artist; the READER falls back to a SEGMENT DEFAULT keyed on
                    nationality group x period (segment_defaults in the JSON), the
                    sqrt(n)-weighted mean of the stored elasticities of the artists in that
                    segment. Keys are "<nat>|<period>" with "any" marginals and "any|any" as
                    the global fallback; `segment_key()` defines the grouping and the graph
                    reader (artist_price_profile.ts) mirrors it.
`built_at` stamps the build; write_price_priors.py uses it as the run id and
check_price_priors_fresh.py compares it against the latest ingest/merge in the graph.

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
from datetime import datetime, timezone

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
# Independent 0/1 flags, not a one-hot family with a dropped reference: "is this confidently
# classified as subject X" vs. "everything else" (other confident subjects AND unclassified
# both code to 0). See the 1.2 changelog note above for why only these three.
SUBJECT_FLAGS = {"subject_is_abstract": "abstract", "subject_is_comic_satirical": "comic_satirical", "subject_is_surreal": "surreal"}
BINARY = list(SUBJECT_FLAGS.keys())
MIN_LEVEL_ROWS = 3        # an artist's own coefficient for a level is trusted only with this many rows on it
MIN_OWN = 15              # below this many earlier sales an artist gets the prior outright
MIN_DESC = 5              # below this many earlier sales there is no per-artist entry at all (segment default)
MIN_SEGMENT_ARTISTS = 3   # a segment default needs at least this many artists behind it
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
    binary = pd.DataFrame({c: feat[c] for c in BINARY}, index=feat.index)
    X = pd.concat(parts + [cont, binary], axis=1)
    if columns is not None:
        X = X.reindex(columns=columns, fill_value=0.0)
    return X


def level_support(feat_rows: pd.DataFrame, columns):
    """How many rows carry each dummy (continuous terms: rows with a value; binary flags: rows
    where the flag is 1, i.e. confidently that subject)."""
    out = {}
    for col in columns:
        if col in CONT:
            out[col] = int(feat_rows[col].notna().sum())
        elif col in BINARY:
            out[col] = int(feat_rows[col].sum())
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
        "share_abstract": float(feat_a["subject_is_abstract"].mean()),
        "share_comic_satirical": float(feat_a["subject_is_comic_satirical"].mean()),
        "share_surreal": float(feat_a["subject_is_surreal"].mean()),
        "median_work_year": float(wy.median()) if len(wy) else float("nan"),
        "born": float(born.median()) if len(born) else float("nan"),
        "share_bonhams": float((df_a["house"] == "Bonhams").mean()),
        "nat_british": float(bool(__import__("re").search(r"brit|english|scot|welsh", nat.lower()))),
        "nat_american": float("american" in nat.lower()),
        "nat_french": float(bool(__import__("re").search(r"french|fran[cç]ais", nat.lower()))),   # the graph holds both "French" and "française"
        "nat_spanish": float("spanish" in nat.lower()),
        "nat_german": float("german" in nat.lower()),
        "nationality": nat,
    }


# Checked in this order, first hit wins ("German/American" is american). Mirrored in
# src/appraisal/knowledge_graph/artist_price_profile.ts — change both or neither.
NAT_GROUPS = ["british", "american", "french", "spanish", "german"]


def period_of(born) -> str:
    """Birth-year period. Mirrored in src/appraisal/knowledge_graph/artist_price_profile.ts —
    change both or neither."""
    if born is None or (isinstance(born, float) and math.isnan(born)):
        return "unknown"
    b = int(born)
    if b < 1800:
        return "pre1800"
    if b < 1880:
        return "c19"
    if b < 1930:
        return "modern"
    return "contemporary"


def nat_group_of(desc: dict) -> str:
    for g in NAT_GROUPS:
        if desc.get(f"nat_{g}", 0.0) >= 0.5:
            return g
    return "other"


def segment_key(desc: dict) -> str:
    return f"{nat_group_of(desc)}|{period_of(desc.get('born'))}"


def segment_defaults(entries: dict, cols) -> dict:
    """sqrt(n)-weighted mean of the stored elasticities and price level over the artists in
    each nationality-group x period cell, plus the "any" marginals and the global cell."""
    groups = {}
    for a, e in entries.items():
        nat, per = segment_key(e["descriptors"]).split("|")
        for key in (f"{nat}|{per}", f"{nat}|any", f"any|{per}", "any|any"):
            groups.setdefault(key, []).append((a, e))
    out = {}
    for key, members in groups.items():
        if len(members) < MIN_SEGMENT_ARTISTS:
            continue
        w = np.array([math.sqrt(e["earlier_sales"]) for _, e in members])
        w = w / w.sum()
        out[key] = {
            "artists": len(members),
            "sales": int(sum(e["earlier_sales"] for _, e in members)),
            "price_level_log": float(sum(wi * e["price_level_log"] for wi, (_, e) in zip(w, members))),
            "elasticities": {col: float(sum(wi * e["elasticities"][col]["value"] for wi, (_, e) in zip(w, members))) for col in cols},
        }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv")
    ap.add_argument("--cut", default="2024-07-01")
    ap.add_argument("--min-year", default="2010")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "priors"))
    ap.add_argument("--size-terms", choices=["both", "bands", "shape-bands", "shape-bands+log"], default="both",
                    help="both = area bands + per-doubling area_log (1.2); bands = area bands only (2026-09-16 check: the two are collinear and pulled against each other for thin artists)")
    ap.add_argument("--with-citation", action="store_true", help="add catalogue_cited (PRICING-PRIORS-1.3; failed its gate 2026-09-16) for the ablation")
    args = ap.parse_args()
    if args.with_citation:
        BINARY.append("catalogue_cited")
    if args.size_terms in ("bands", "shape-bands"):
        CONT.remove("area_log")
    if args.size_terms.startswith("shape-bands"):
        # Bands cut where size_shape.py found the price curve bends (2026-09-16): small sheets flat
        # at ~x0.85, a rise to ~42 cm a side, a flat plateau to ~87 cm, then a +45-55% jump.
        REFS["area_band"] = "1800-7500"

    df = pd.read_csv(args.csv, low_memory=False)
    source_rows = int(len(df))          # rows in the export, before any filter: the freshness check compares this to the graph
    df = df[df["saleDate"] >= args.min_year]
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")]
    df = df[df["artist"].notna()].reset_index(drop=True)
    feat = build_features(df)
    if args.size_terms.startswith("shape-bands"):
        area = np.exp(feat["area_log"])
        feat["area_band"] = np.select(
            [area.isna(), area < 400, area < 900, area < 1800, area < 7500],
            ["unknown", "<400", "400-900", "900-1800", "1800-7500"], default=">7500")
    for col, cat in SUBJECT_FLAGS.items():
        feat[col] = (feat["subject"] == cat).astype(float)
    feat["catalogue_cited"] = feat["has_citation"].astype(float)
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
          f"artists with >={MIN_OWN} earlier sales: {(n_art >= MIN_OWN).sum()}, with >={MIN_DESC}: {(n_art >= MIN_DESC).sum()}, "
          f"donors (>={DONOR_MIN}): {(n_art >= DONOR_MIN).sum()}")

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

    # 3. descriptors and neighbours (donors only). Descriptors need only MIN_DESC sales: an
    #    artist with 5 sales can be PLACED (price level, signed share, period) even though their
    #    own coefficients cannot be fitted.
    desc = {}
    for a in n_art.index:
        m = train & (df["artist"] == a).values
        if m.sum() >= MIN_DESC:
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

    bands = [(MIN_DESC, MIN_OWN), (MIN_OWN, 40), (40, 100), (100, 300), (300, 10 ** 9)]
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
    built_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    db = {"version": ("PRICING-PRIORS-1.3" if args.with_citation else "PRICING-PRIORS-1.2") + ("" if args.size_terms == "both" else f"-{args.size_terms}"), "built_at": built_at, "cut": args.cut, "min_year": args.min_year,
          "kappa": best_k, "min_own_sales": MIN_OWN, "min_descriptor_sales": MIN_DESC,
          "source_rows": source_rows, "model_rows": int(len(df)), "train_rows": int(train.sum()),
          "reference_levels": REFS, "elasticity_columns": cols, "year_effects": year_eff, "continuous_medians": med,
          "segment_key": "<nationality group: british|american|french|spanish|german|other>|<period by birth year: pre1800|c19 (1800-1879)|modern (1880-1929)|contemporary (1930+)|unknown>",
          "artists": {}, "segment_defaults": {}}
    for a in Dn.index:
        b = shrunk(a, best_k)
        m_tr = train & (df["artist"] == a).values
        intercept = float(np.median(ydefl[m_tr] - X[m_tr].values @ b.values))
        db["artists"][a] = {
            "earlier_sales": own_n[a],
            "basis": "shrunk" if a in own_beta else "prior",
            "price_level_log": intercept,
            "elasticities": {col: {"value": float(b[col]), "multiplier": float(math.exp(b[col] * (math.log(2) if col in CONT else 1.0))),
                                    "own": float(own_beta[a][col]) if a in own_beta and own_support[a].get(col, 0) >= MIN_LEVEL_ROWS else None,
                                    "own_support": own_support[a].get(col, 0) if a in own_support else 0,
                                    "prior": float(priors[a][col])} for col in cols},
            "neighbours": neighbours.get(a, {}),
            "descriptors": desc[a],
        }
    db["segment_defaults"] = segment_defaults(db["artists"], cols)
    with open(os.path.join(args.out_dir, "artist_elasticities.json"), "w") as f:
        json.dump(db, f, indent=1, ensure_ascii=False)
    nb_rows = [(a, b, w) for a, nbs in neighbours.items() for b, w in nbs.items()]
    pd.DataFrame(nb_rows, columns=["artist", "neighbour", "weight"]).to_csv(os.path.join(args.out_dir, "neighbours.csv"), index=False)
    summary = pd.DataFrame({a: {"earlier_sales": own_n[a], "price_level": math.exp(db["artists"][a]["price_level_log"]),
                                **{col: db["artists"][a]["elasticities"][col]["multiplier"] for col in cols}} for a in Dn.index}).T.sort_values("earlier_sales", ascending=False)
    summary.to_csv(os.path.join(args.out_dir, "artist_multipliers.csv"))
    n_shrunk = sum(1 for e in db["artists"].values() if e["basis"] == "shrunk")
    print(f"\nwrote {len(db['artists'])} artists ({n_shrunk} shrunk own fits, {len(db['artists']) - n_shrunk} prior-only) and "
          f"{len(db['segment_defaults'])} segment defaults -> {args.out_dir}/artist_elasticities.json, neighbours.csv, artist_multipliers.csv")
    print("segment defaults (artists / sales / hand-signed multiplier / edition >300 multiplier):")
    for key, sd in sorted(db["segment_defaults"].items()):
        print(f"  {key:<24} {sd['artists']:>4} {sd['sales']:>7}  x{math.exp(sd['elasticities'].get('signature_hand', 0.0)):.2f}  x{math.exp(sd['elasticities'].get('edition_band_>300', 0.0)):.2f}")

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
        for col in ["signature_hand", "edition_band_>300", "edition_band_<=30", "process_screenprint", "process_etching"] + BINARY:
            if col in e:
                print("     " + show(col))
        per_doubling = lambda col: f"x{math.exp(e[col]['value'] * math.log(2)):.2f}" if col in e else "n/a (no continuous term)"
        print(f"     area per doubling {per_doubling('area_log')}   edition per doubling {per_doubling('edition_log')}")


if __name__ == "__main__":
    main()
