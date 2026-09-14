"""
PrintMasterAI — a hammer-price model for one artist from the lot's own attributes.
Version: PRICING-MODEL-1.0

The question this answers: given what a catalogue says about a print — technique, signature,
condition, catalogue citation, edition size, size — how well can the HAMMER be predicted, and
does that beat the house's estimate (x market drift), which the 2026-09-13 hammer backtest
found to be the best predictor available?

Target is log(hammer GBP at the sale-date rate). Gradient-boosted trees on features parsed
from the export (see FEATURES below). Evaluation is TEMPORAL — train on sales before the cut,
test on sales after — because a random split lets the model see later sales of the same
print when predicting an earlier one, and prices drift.

Three model variants, because the features you asked for split into two kinds:
  attributes  — technique, signature, condition, citation presence/catalogue, edition size,
                dimensions, work year, paper, publisher, sale year, house
  + work prior — plus what THIS work (same ConceptualWork / same citation) hammered for in
                EARLIER sales (leave-future-out target encoding): the same-work comp, as a
                feature the trees can weight against the attributes
  + estimate  — plus the house's own estimate midpoint, to see whether the attributes add
                anything the house had not already priced in

Baselines on the same test rows: artist median (train), same-work prior median where it
exists, and estimate x DRIFT.

Condition is PARSED FROM THE MEDIUM TEXT and is partial: Bonhams writes "in very good
condition aside from light staining, specks of foxing, a 1/4in tear" on a subset of lots and
nothing on the rest. "unknown" is a level of its own, never imputed as "good".

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/train_price_model.py \
        knowledge_graph/pricing_ml/data/picasso_sales.csv --cut 2024-07-01
"""
import argparse
import json
import math
import re
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.linear_model import Ridge

DRIFT = 0.82

# ── feature parsing ──────────────────────────────────────────────────────────

FAMILIES = [
    ("photomechanical", r"giclee|giclée|inkjet|digital|halftone|photogravure|photolith|collotype|offset|c-?print|chromogenic|pigment print|pochoir"),
    ("relief", r"woodcut|wood[\s-]?engrav|linocut|lino[\s-]?cut|linoleum|relief"),
    ("intaglio", r"etch|engrav|drypoint|dry-?point|aquatint|mezzotint|burin|intaglio|soft-?ground|sugar-?lift"),
    ("planographic", r"lithograph|litho|zincograph"),
    ("screen", r"screenprint|screen print|serigraph|silkscreen|stencil"),
]
PROCESSES = ["linocut", "aquatint", "drypoint", "etching", "engraving", "lithograph", "woodcut", "pochoir", "screenprint", "collotype"]


def technique_family(texts):
    blob = " ".join(t for t in texts if isinstance(t, str)).lower()
    for fam, rx in FAMILIES:
        if re.search(rx, blob):
            return fam
    return "unknown"


def primary_process(texts):
    blob = " ".join(t for t in texts if isinstance(t, str)).lower()
    for p in PROCESSES:
        if p in blob:
            return p
    return "other"


def signature_class(signed, text):
    t = (text or "").lower()
    if re.search(r"stamped signature|signature stamp|estate stamp", t):
        return "stamped"
    if re.search(r"signed in the plate|signed in the stone|plate[- ]signed|signed in the block", t):
        return "plate"
    if re.search(r"\bsigned\b", t) and not re.search(r"\bunsigned\b", t):
        return "hand"
    if re.search(r"\binitial(l)?ed\b", t):
        return "initialled"
    if signed is True or str(signed).lower() == "true":
        return "hand"
    return "unsigned"


def proof_class(copy_type, text):
    t = (text or "").lower()
    if re.search(r"artist'?s proof|épreuve d'artiste|epreuve d'artiste|\bE\.?A\.?\b|\bA\.?P\.?\b", text or ""):
        return "artist_proof"
    if re.search(r"hors commerce|\bH\.?C\.?\b", text or ""):
        return "hors_commerce"
    if re.search(r"trial proof|épreuve d'essai|epreuve d'essai|bon à tirer|bon a tirer|\bB\.?A\.?T\.?\b", text or ""):
        return "trial_proof"
    if re.search(r"\d+\s*/\s*\d+", t) or str(copy_type).lower() == "numbered":
        return "numbered"
    if re.search(r"from the edition of|edition of \d", t):
        return "edition_unnumbered"
    return "unknown"


def edition_size(declared, text):
    try:
        if declared not in (None, "") and not (isinstance(declared, float) and math.isnan(declared)) and float(declared) > 0:
            return float(declared)
    except (TypeError, ValueError):
        pass
    t = text or ""
    m = re.search(r"\d+\s*/\s*(\d{1,4})", t)
    if m:
        return float(m.group(1))
    m = re.search(r"edition of (?:approximately |about )?(\d{1,5})", t, re.I)
    if m:
        return float(m.group(1))
    return np.nan


def edition_band(n):
    if n is None or (isinstance(n, float) and math.isnan(n)):
        return "unknown"
    if n <= 30:
        return "<=30"
    if n <= 75:
        return "31-75"
    if n <= 150:
        return "76-150"
    if n <= 300:
        return "151-300"
    return ">300"


DIM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in)?", re.I)


def dims_cm(*values):
    """First parseable 'W x H' in cm from the structured dims, then the medium text."""
    for v in values:
        if not v or (isinstance(v, float) and math.isnan(v)):
            continue
        m = DIM_RE.search(str(v))
        if not m:
            continue
        a, b, unit = float(m.group(1)), float(m.group(2)), (m.group(3) or "cm").lower()
        if unit == "mm":
            a, b = a / 10, b / 10
        elif unit == "in":
            a, b = a * 2.54, b * 2.54
        if 1 < a < 400 and 1 < b < 400:
            return a, b
    return None


def area_band(area):
    if area is None:
        return "unknown"
    for lo, hi, name in [(0, 150, "<150cm2"), (150, 400, "150-400"), (400, 900, "400-900"), (900, 1800, "900-1800"), (1800, 1e9, ">1800")]:
        if lo <= area < hi:
            return name
    return "unknown"


CONDITION_GRADES = [
    ("excellent", r"excellent condition|pristine"),
    ("very_good", r"very good condition"),
    ("good", r"in good condition|good condition"),
    ("fair", r"fair condition|poor condition|condition issues|restor|repair"),
]
DEFECTS = {
    "foxing": r"foxing", "staining": r"stain", "toning": r"toning|toned|discolou?r|yellow", "tear": r"\btear|torn",
    "crease": r"crease|fold", "soiling": r"soil", "fading": r"fad(ed|ing)", "trimmed": r"trimmed|cut down",
    "laid_down": r"laid down|mounted to|adhered", "hinge": r"hinge|tape",
}


def condition_grade(text):
    t = (text or "").lower()
    for g, rx in CONDITION_GRADES:
        if re.search(rx, t):
            return g
    return "unknown"


def defect_flags(text):
    t = (text or "").lower()
    return {f"def_{k}": int(bool(re.search(rx, t))) for k, rx in DEFECTS.items()}


PUBLISHERS = [("vollard", r"vollard"), ("mourlot", r"mourlot"), ("leiris", r"leiris|kahnweiler"), ("crommelynck", r"crommelynck"),
              ("cercle_dart", r"cercle d'art|arn[eé]ra"), ("skira", r"skira"), ("spitzer", r"spitzer"), ("berggruen", r"berggruen"),
              ("marina_picasso", r"marina picasso"), ("verve", r"verve|tériade|teriade")]


def publisher(text):
    t = (text or "").lower()
    for name, rx in PUBLISHERS:
        if re.search(rx, t):
            return name
    return "other"


PAPERS = [("arches", r"arches"), ("rives", r"rives"), ("japan", r"japan|japon"), ("montval", r"montval"), ("van_gelder", r"van gelder"),
          ("richard_de_bas", r"richard de bas"), ("wove", r"\bwove\b"), ("laid", r"\blaid paper|laid,")]


def paper_class(papers, text):
    blob = (" ".join(papers) + " " + (text or "")).lower()
    for name, rx in PAPERS:
        if re.search(rx, blob):
            return name
    return "other"


def citation_catalogue(cits):
    """The best-known catalogue cited: bloch > baer > mourlot > cramer > other > none."""
    blob = " ".join(cits).lower()
    for name in ["bloch", "baer", "mourlot", "cramer", "geiser"]:
        if name in blob:
            return name
    return "other" if cits else "none"


def is_book_or_set(text):
    t = (text or "").lower()
    return int(bool(re.search(r"\bthe book\b|\bvolume\b|set of \d|the complete set|portfolio of|\(vol\)|album", t)))


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for c in ["rawMedium", "copyType", "plateDims", "imageDims", "sheetDims", "sourceTitle"]:
        df[c] = df[c].where(df[c].notna(), None)
    out = pd.DataFrame(index=df.index)
    techs = df["techniques"].apply(json.loads)
    papers = df["papers"].apply(json.loads)
    cits = df["citations"].apply(json.loads)
    out["tech_family"] = [technique_family(t + [m]) for t, m in zip(techs, df["rawMedium"])]
    out["process"] = [primary_process(t + [m]) for t, m in zip(techs, df["rawMedium"])]
    out["signature"] = [signature_class(s, m) for s, m in zip(df["signed"], df["rawMedium"])]
    out["proof"] = [proof_class(c, m) for c, m in zip(df["copyType"], df["rawMedium"])]
    ed = [edition_size(e, m) for e, m in zip(df["editionSize"], df["rawMedium"])]
    out["edition_band"] = [edition_band(e) for e in ed]
    out["edition_log"] = [math.log(e) if e and not math.isnan(e) else np.nan for e in ed]
    d = [dims_cm(p, i, s, m) for p, i, s, m in zip(df["plateDims"], df["imageDims"], df["sheetDims"], df["rawMedium"])]
    out["area_band"] = [area_band(x[0] * x[1] if x else None) for x in d]
    out["area_log"] = [math.log(x[0] * x[1]) if x else np.nan for x in d]
    out["max_side"] = [max(x) if x else np.nan for x in d]
    out["condition"] = df["rawMedium"].apply(condition_grade)
    for k, v in pd.DataFrame([defect_flags(m) for m in df["rawMedium"]], index=df.index).items():
        out[k] = v
    out["n_defects"] = out[[c for c in out.columns if c.startswith("def_")]].sum(axis=1)
    out["catalogue"] = cits.apply(citation_catalogue)
    out["has_citation"] = cits.apply(lambda c: int(len(c) > 0))
    out["publisher"] = df["rawMedium"].apply(publisher)
    out["paper"] = [paper_class(p, m) for p, m in zip(papers, df["rawMedium"])]
    out["book_or_set"] = df["rawMedium"].apply(is_book_or_set)
    wy = pd.to_numeric(df["workYear"], errors="coerce")
    out["work_year"] = wy
    out["work_decade"] = wy.apply(lambda y: f"{int(y) // 10 * 10}s" if pd.notna(y) else "unknown")
    out["posthumous_work"] = wy.apply(lambda y: int(y > 1973) if pd.notna(y) else -1)
    out["sale_year"] = pd.to_datetime(df["saleDate"]).dt.year + pd.to_datetime(df["saleDate"]).dt.dayofyear / 365.0
    out["house"] = df["house"].fillna("unknown")
    if "clipSubject" in df.columns:
        conf = df["clipSubjectConfident"].astype(str)
        out["subject"] = np.where(conf == "True", df["clipSubject"].astype(str), "unclassified")
    else:
        out["subject"] = "unclassified"
    return out


CATEGORICAL = ["tech_family", "process", "signature", "proof", "edition_band", "area_band", "condition", "catalogue",
               "publisher", "paper", "work_decade", "house", "subject"]


def encode(feat: pd.DataFrame, cats=None):
    X = feat.copy()
    cats = cats or {}
    for c in [c for c in CATEGORICAL if c in X.columns]:
        levels = cats.get(c) or sorted(X[c].astype(str).unique().tolist())
        cats[c] = levels
        X[c] = pd.Categorical(X[c].astype(str), categories=levels).codes
        X.loc[X[c] < 0, c] = np.nan
    return X, cats


# ── work prior: leave-future-out target encoding ──────────────────────────────

def add_work_prior(df: pd.DataFrame, feat: pd.DataFrame) -> pd.DataFrame:
    """For each sale, the median log-hammer of EARLIER sales of the same work (by ConceptualWork
    id, or failing that by a shared citation), and how many there were. Only the past is
    visible, so this is exactly the same-work comp a valuer would have had."""
    df = df.copy()
    df["logh"] = np.log(df["hammerGBP"].astype(float))
    df["_cits"] = df["citations"].apply(lambda s: tuple(sorted(c.lower() for c in json.loads(s))))
    order = df.sort_values("saleDate").index
    prior_med, prior_n, prior_basis = {}, {}, {}
    by_work: dict = {}
    by_cit: dict = {}
    for idx in order:
        wid, cits = df.at[idx, "workId"], df.at[idx, "_cits"]
        hist = list(by_work.get(wid, []))
        basis = "work" if hist else None
        if not hist:
            for c in cits:
                hist += by_cit.get(c, [])
            basis = "citation" if hist else None
        prior_med[idx] = float(np.median(hist)) if hist else np.nan
        prior_n[idx] = len(hist)
        prior_basis[idx] = basis or "none"
        by_work.setdefault(wid, []).append(df.at[idx, "logh"])
        for c in cits:
            by_cit.setdefault(c, []).append(df.at[idx, "logh"])
    feat = feat.copy()
    feat["work_prior_log"] = pd.Series(prior_med)
    feat["work_prior_n"] = pd.Series(prior_n)
    feat["work_prior_basis"] = pd.Series(prior_basis)
    return feat


# ── evaluation ────────────────────────────────────────────────────────────────

def score(name, y_true_log, y_pred_log):
    e = np.asarray(y_pred_log) - np.asarray(y_true_log)
    mask = ~np.isnan(e)
    e = e[mask]
    if not len(e):
        return f"  {name:<44} n=0"
    return (f"  {name:<44} n={len(e):4d}  geo={math.exp(e.mean()):5.2f}  MAE(log)={np.abs(e).mean():.3f}  "
            f"±25%: {100 * (np.abs(e) <= math.log(1.25)).mean():3.0f}%  within 2x: {100 * (np.abs(e) <= math.log(2)).mean():3.0f}%")


def fit(X, y, seed=0):
    m = HistGradientBoostingRegressor(max_iter=600, learning_rate=0.04, max_leaf_nodes=15, min_samples_leaf=12,
                                      l2_regularization=0.5, categorical_features=[X.columns.get_loc(c) for c in CATEGORICAL if c in X.columns],
                                      random_state=seed)
    m.fit(X, y)
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv")
    ap.add_argument("--cut", default="2024-07-01", help="temporal split: train < cut <= test")
    ap.add_argument("--min-year", default="2010", help="drop sales before this (market regime)")
    ap.add_argument("--importance", action="store_true", help="permutation importance on the test rows")
    ap.add_argument("--effects", action="store_true", help="log-linear effects table: the multiplier each attribute level carries")
    args = ap.parse_args()

    df = pd.read_csv(args.csv)
    df = df[df["saleDate"] >= args.min_year].reset_index(drop=True)
    df = df[~df["rawMedium"].fillna("").str.lower().str.contains(r"\bthe book\b|the complete set|set of \d|portfolio of|\(vol\)")].reset_index(drop=True)
    y = np.log(df["hammerGBP"].astype(float))
    feat = build_features(df)
    feat = add_work_prior(df, feat)
    feat["work_prior_basis"] = pd.Categorical(feat["work_prior_basis"], categories=["none", "citation", "work"]).codes

    train = df["saleDate"] < args.cut
    test = ~train
    print(f"rows={len(df)} (sales >= {args.min_year}, books/sets dropped)  train={train.sum()} (< {args.cut})  test={test.sum()}")
    print("feature coverage on test rows:")
    for c in ["signature", "proof", "edition_band", "area_band", "condition", "catalogue", "publisher", "paper"]:
        vc = feat.loc[test, c].value_counts()
        print(f"   {c:<12} " + "  ".join(f"{k}={v}" for k, v in vc.items()))
    print(f"   work prior available on {int((feat.loc[test, 'work_prior_n'] > 0).sum())} of {int(test.sum())} test rows")

    ATTR = ["tech_family", "process", "signature", "proof", "edition_band", "edition_log", "area_band", "area_log", "max_side",
            "condition", "n_defects"] + [c for c in feat.columns if c.startswith("def_")] + \
           ["catalogue", "has_citation", "publisher", "paper", "book_or_set", "work_year", "work_decade", "posthumous_work", "sale_year", "house", "subject"]
    PRIOR = ["work_prior_log", "work_prior_n", "work_prior_basis"]
    # Native estimates at the sale-date rate. estimateLowGBP/HighGBP are the hammer in GBP on
    # Bonhams records (API quirk) and must not be used as an estimate.
    fx = df["fxRateToGBP"].astype(float).where(df["fxRateToGBP"].astype(float) > 0)
    est_mid = ((df["estimateLow"].astype(float) + df["estimateHigh"].astype(float)) / 2) / fx
    feat["est_mid_log"] = np.log(est_mid.where(est_mid > 0))

    print("\n── Baselines (test rows) ──")
    print(score("artist median (train)", y[test], np.full(test.sum(), y[train].median())))
    has_prior = test & (feat["work_prior_n"] > 0)
    print(score("same-work prior median (where it exists)", y[has_prior], feat.loc[has_prior, "work_prior_log"]))
    has_est = test & feat["est_mid_log"].notna()
    print(score(f"estimate midpoint x {DRIFT} (where it exists)", y[has_est], feat.loc[has_est, "est_mid_log"] + math.log(DRIFT)))
    print(score("estimate midpoint (raw)", y[has_est], feat.loc[has_est, "est_mid_log"]))

    variants = [
        ("attributes only", ATTR),
        ("attributes + work prior", ATTR + PRIOR),
        ("attributes + work prior + estimate", ATTR + PRIOR + ["est_mid_log"]),
        ("estimate + work prior only (no attributes)", PRIOR + ["est_mid_log", "sale_year"]),
    ]
    results = {}
    print("\n── Models (temporal split, 3 seeds averaged) ──")
    for name, cols in variants:
        Xall, cats = encode(feat[cols])
        preds = []
        for seed in range(3):
            m = fit(Xall[train], y[train], seed)
            preds.append(m.predict(Xall[test]))
        p = np.mean(preds, axis=0)
        results[name] = (cols, p)
        print(score(name, y[test], p))
        if "estimate" in name:
            print(score(f"   … on rows with an estimate", y[has_est], pd.Series(p, index=df.index[test]).loc[has_est]))
        if name == "attributes + work prior":
            print(score(f"   … on rows WITH a work prior", y[has_prior], pd.Series(p, index=df.index[test]).loc[has_prior]))
            print(score(f"   … on rows WITHOUT a work prior", y[test & ~has_prior], pd.Series(p, index=df.index[test]).loc[test & ~has_prior]))
            print(score(f"   … estimate x drift on the same no-prior rows", y[test & ~has_prior & has_est], feat.loc[test & ~has_prior & has_est, "est_mid_log"] + math.log(DRIFT)))

    # drop-one ablation on the attributes model, grouped by the features you asked about
    print("\n── Drop-one ablation (attributes + work prior; MAE(log) on test, higher = feature mattered) ──")
    groups = {
        "technique": ["tech_family", "process"], "signature": ["signature", "proof"], "condition": ["condition", "n_defects"] + [c for c in feat.columns if c.startswith("def_")],
        "citation": ["catalogue", "has_citation"], "edition size": ["edition_band", "edition_log"], "dimensions": ["area_band", "area_log", "max_side"],
        "work prior": PRIOR, "publisher/paper": ["publisher", "paper"], "work year": ["work_year", "work_decade", "posthumous_work"], "sale year/house": ["sale_year", "house"],
        "subject (CLIP)": ["subject"],
    }
    base_cols = ATTR + PRIOR
    Xb, _ = encode(feat[base_cols])
    base_mae = np.abs(np.mean([fit(Xb[train], y[train], s).predict(Xb[test]) for s in range(3)], axis=0) - y[test]).mean()
    print(f"  {'full model':<20} MAE(log)={base_mae:.3f}")
    for g, cols in groups.items():
        keep = [c for c in base_cols if c not in cols]
        Xg, _ = encode(feat[keep])
        mae = np.abs(np.mean([fit(Xg[train], y[train], s).predict(Xg[test]) for s in range(3)], axis=0) - y[test]).mean()
        print(f"  {('- ' + g):<20} MAE(log)={mae:.3f}  ({'+' if mae > base_mae else ''}{mae - base_mae:+.3f})")

    if args.importance:
        cols = ATTR + PRIOR
        Xall, _ = encode(feat[cols])
        m = fit(Xall[train], y[train], 0)
        pi = permutation_importance(m, Xall[test], y[test], n_repeats=8, random_state=0, scoring="neg_mean_absolute_error")
        order = np.argsort(-pi.importances_mean)
        print("\n── Permutation importance (test, MAE increase when shuffled) ──")
        for i in order[:18]:
            print(f"  {cols[i]:<20} {pi.importances_mean[i]:+.3f} ± {pi.importances_std[i]:.3f}")

    if args.effects:
        # Ridge on one-hot attributes + log size/edition, with sale-year and house effects, on ALL
        # rows (this is a description of the corpus, not a forecast). exp(coef) is the
        # multiplier relative to the reference level, holding the other attributes fixed.
        eff_cols = {"signature": "unsigned", "proof": "numbered", "edition_band": "76-150", "area_band": "400-900",
                    "condition": "unknown", "catalogue": "none", "publisher": "other", "paper": "other", "process": "lithograph",
                    "work_decade": "1960s", "house": "Bonhams", "subject": "genre_scene"}
        parts = []
        for c, ref in eff_cols.items():
            d = pd.get_dummies(feat[c].astype(str), prefix=c, dtype=float)
            refcol = f"{c}_{ref}"
            if refcol in d.columns:
                d = d.drop(columns=[refcol])
            parts.append(d)
        yr = pd.get_dummies(pd.to_datetime(df["saleDate"]).dt.year.astype(str), prefix="year", dtype=float).iloc[:, 1:]
        cont = pd.DataFrame({"edition_log": feat["edition_log"].fillna(feat["edition_log"].median()),
                             "area_log": feat["area_log"].fillna(feat["area_log"].median())}, index=feat.index)
        Xe = pd.concat(parts + [yr, cont], axis=1)
        r = Ridge(alpha=2.0).fit(Xe, y)
        coefs = pd.Series(r.coef_, index=Xe.columns)
        print("\n── Effects table (log-linear, all rows; multiplier vs the reference level, other attributes held fixed) ──")
        for c, ref in eff_cols.items():
            rows = coefs[[k for k in coefs.index if k.startswith(c + "_")]]
            if rows.empty:
                continue
            counts = feat[c].astype(str).value_counts()
            print(f"  {c} (reference: {ref}, n={counts.get(ref, 0)})")
            for k, v in rows.sort_values(ascending=False).items():
                lvl = k[len(c) + 1:]
                if counts.get(lvl, 0) < 8:
                    continue
                print(f"     {lvl:<18} x{math.exp(v):5.2f}   (n={counts.get(lvl, 0)})")
        print(f"  edition size: x{math.exp(coefs['edition_log'] * math.log(2)):.2f} per doubling of the edition   "
              f"sheet area: x{math.exp(coefs['area_log'] * math.log(2)):.2f} per doubling of the area")
        yrs = coefs[[k for k in coefs.index if k.startswith("year_")]]
        print("  sale year vs " + str(pd.to_datetime(df["saleDate"]).dt.year.min()) + ": " + "  ".join(f"{k[5:]} x{math.exp(v):.2f}" for k, v in yrs.items()))

    # what the attribute model gets most wrong, for reading
    cols, p = results["attributes + work prior"]
    err = pd.Series(p - y[test].values, index=df.index[test])
    worst = err.abs().sort_values(ascending=False).head(6).index
    print("\n── Largest test errors (attributes + work prior) ──")
    for i in worst:
        print(f"  {df.at[i, 'saleDate']} {df.at[i, 'house'][:8]:<8} hammer £{df.at[i, 'hammerGBP']:>8,.0f} pred £{math.exp(p[list(df.index[test]).index(i)]):>8,.0f}  {str(df.at[i, 'workName'])[:38]:<38} | {feat.at[i, 'signature']}/{feat.at[i, 'edition_band']}/{feat.at[i, 'condition']} | {str(df.at[i, 'rawMedium'])[:90]}")


if __name__ == "__main__":
    main()
