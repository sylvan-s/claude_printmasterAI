"""Is D_T_DINO_FLOOR the right number, and should it be per-artist? Measure, don't argue.

Stage 2a gates work identity — "is this the same PRINT?" — on one global constant whose own
comment admits it is unfitted: five lots, 0.010 between the lowest same-work match and the
highest different-work one. This reproduces the measurement that replaced it, and re-running
it is how you check the replacement still holds after an ingest.

WHAT IS MEASURED
  positive       two embedded impressions of the SAME ConceptualWork
  hard negative  two embedded impressions of DIFFERENT works by the SAME artist

Every feature is impression-level. Anything read off the ConceptualWork node would LEAK: a
positive pair is two impressions of one node, so its title and year are identical by
construction and would separate perfectly while measuring nothing.

Scoring uses vector.similarity.cosine server-side — the same (1+cos)/2 scale
db.index.vector.queryNodes returns, so a number here means what Stage 1d means by it.

TWO THINGS THAT WOULD OTHERWISE FLATTER THE RESULT, BOTH CONTROLLED
  1. Artist leakage. Cross-validation is grouped by ARTIST. Without that, a model scores
     itself on artists it trained on and reports a number that says nothing about the next
     lot, whose artist it has never seen.
  2. Label contamination. ~30% of ConceptualWork nodes were variant-titled duplicates, so a
     "hard negative" is sometimes one print split across two nodes — a positive wearing a
     negative label, which DEPRESSES measured separation. A sensitivity pass drops negatives
     whose titles normalise identically and reports both, so the reader sees the size of it.

Calibration is isotonic, fitted INSIDE each fold on a held-out slice of that fold's training
ARTISTS. Fitting it on the test fold would have the calibration curve grade its own homework.
The first version of this analysis used class_weight="balanced" and produced a good ranker
whose stated 0.9 was really 0.71; weighting is off here for that reason.

Usage:
    set -a; source .env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/analyse_dino_threshold.py \
        [--artists 400] [--csv out.csv]
"""
import argparse, os, re, sys
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold, GroupShuffleSplit
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression

GLOBAL_FLOOR = 0.88  # D_T_DINO_FLOOR in src/appraisal/two_pass_attribution.ts

ARTISTS_Q = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(imp) WHERE img.embedding IS NOT NULL
WITH a, cw, count(DISTINCT img) AS imgs WHERE imgs >= 2
WITH a, count(DISTINCT cw) AS works WHERE works >= 3
RETURN a.name AS artist ORDER BY works DESC LIMIT $lim
"""

PAIRS_Q = """
MATCH (a:Artist) WHERE a.name = $artist
WITH a
MATCH (a)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(imp) WHERE img.embedding IS NOT NULL
WITH cw, collect({img: img, imp: imp})[..6] AS items
WITH collect({cw: cw, items: items}) AS works WHERE size(works) >= 3
WITH works[..12] AS works
UNWIND range(0, size(works)-1) AS i
UNWIND range(i, size(works)-1) AS j
WITH works[i] AS W1, works[j] AS W2, i, j
UNWIND W1.items AS it1
UNWIND W2.items AS it2
WITH W1, W2, it1, it2, i, j
WHERE (i = j AND elementId(it1.img) < elementId(it2.img)) OR (i < j AND elementId(it1.img) <> elementId(it2.img))
WITH W1, W2, it1, it2, (i = j) AS samePrint, rand() AS r
ORDER BY r
WITH collect({W1: W1, W2: W2, it1: it1, it2: it2, samePrint: samePrint})[..120] AS pairs
UNWIND pairs AS p
RETURN p.samePrint AS samePrint, p.W1.cw.name AS titleA, p.W2.cw.name AS titleB,
       vector.similarity.cosine(p.it1.img.embedding, p.it2.img.embedding) AS dino,
       CASE WHEN p.it1.img.clipImageEmbedding IS NOT NULL AND p.it2.img.clipImageEmbedding IS NOT NULL
            THEN vector.similarity.cosine(p.it1.img.clipImageEmbedding, p.it2.img.clipImageEmbedding) END AS clip,
       p.it1.imp.sheetDimensions AS sheetA, p.it2.imp.sheetDimensions AS sheetB,
       p.it1.imp.plateDimensions AS plateA, p.it2.imp.plateDimensions AS plateB,
       p.it1.imp.imageDimensions AS imgDimA, p.it2.imp.imageDimensions AS imgDimB,
       p.it1.imp.rawMedium AS medA, p.it2.imp.rawMedium AS medB
"""

DIM = re.compile(r"([\d.]+)\s*x\s*([\d.]+)\s*cm", re.I)
FEATURES = ["dino", "dinoPct", "clip", "dimDiff", "dimMissing", "medMatch", "medMissing"]


def _dims(s):
    m = DIM.search(s) if s else None
    if not m:
        return None
    try:
        w, h = float(m.group(1)), float(m.group(2))
    except ValueError:
        return None
    return (min(w, h), max(w, h)) if w > 0 and h > 0 else None


def dim_diff(a, b):
    """Largest relative disagreement across the two axes, orientation-insensitive."""
    da, db = _dims(a), _dims(b)
    if not da or not db:
        return None
    return max(abs(da[0] - db[0]) / max(da[0], db[0]), abs(da[1] - db[1]) / max(da[1], db[1]))


def title_key(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def load(limit):
    for v in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
        if not os.environ.get(v):
            raise RuntimeError(f"{v} is not set. Run `set -a; source .env; set +a` first.")
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    rows = []
    try:
        with drv.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
            artists = [r["artist"] for r in s.run(ARTISTS_Q, lim=limit)]
            print(f"[data] {len(artists)} artists with >=3 multi-image works", flush=True)
            for n, art in enumerate(artists, 1):
                for r in s.run(PAIRS_Q, artist=art):
                    d = dict(r)
                    d["artist"] = art
                    rows.append(d)
                if n % 100 == 0:
                    print(f"  {n}/{len(artists)} artists, {len(rows)} pairs", flush=True)
    finally:
        drv.close()
    return rows


def featurise(rows):
    X, y, g = [], [], []
    for r in rows:
        if r["dino"] is None:
            continue
        dd = dim_diff(r["sheetA"], r["sheetB"]) or dim_diff(r["plateA"], r["plateB"]) or dim_diff(r["imgDimA"], r["imgDimB"])
        med = None
        if r["medA"] and r["medB"]:
            med = 1.0 if r["medA"].strip().lower() == r["medB"].strip().lower() else 0.0
        X.append({"dino": float(r["dino"]), "clip": float(r["clip"]) if r["clip"] is not None else None,
                  "dimDiff": dd, "medMatch": med, "artist": r["artist"],
                  "sameTitleKey": title_key(r["titleA"]) == title_key(r["titleB"])})
        y.append(1 if r["samePrint"] else 0)
        g.append(r["artist"])
    return X, np.array(y), np.array(g)


def add_percentile(X, y):
    """Leave-one-out percentile within the artist's own DIFFERENT-work distribution.

    Pairs whose titles normalise identically are EXCLUDED from the background. They are one
    print on two nodes, not two works, and they score ~1.0 — on Peter Blake, 26 such pairs in
    780 moved his 1%-FPR point from 0.735 to 0.983. A background built from them measures the
    graph's duplication, not the artist's visual variety.
    """
    bg = defaultdict(list)
    for xi, yi in zip(X, y):
        if yi == 0 and not xi["sameTitleKey"]:
            bg[xi["artist"]].append(xi["dino"])
    for a in bg:
        bg[a] = np.sort(np.array(bg[a]))
    for xi, yi in zip(X, y):
        b = bg.get(xi["artist"])
        if b is None or len(b) < 8:
            xi["dinoPct"] = None
            continue
        in_bg = yi == 0 and not xi["sameTitleKey"]
        n = len(b) - (1 if in_bg else 0)
        k = np.searchsorted(b, xi["dino"], side="left") - (1 if in_bg else 0)
        xi["dinoPct"] = max(0.0, min(1.0, k / n)) if n > 0 else None
    return bg


def vec(x):
    return [x["dino"],
            x["dinoPct"] if x["dinoPct"] is not None else 0.5,
            x["clip"] if x["clip"] is not None else 0.75,
            x["dimDiff"] if x["dimDiff"] is not None else 0.0,
            1.0 if x["dimDiff"] is None else 0.0,
            x["medMatch"] if x["medMatch"] is not None else 0.0,
            1.0 if x["medMatch"] is None else 0.0]


def calibrated_oof(X, y, g):
    M = np.array([vec(x) for x in X])
    Ms = (M - M.mean(0)) / (M.std(0) + 1e-9)
    oof, coefs = np.zeros(len(y)), []
    for tr, te in GroupKFold(n_splits=5).split(Ms, y, groups=g):
        gi, ci = next(GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=0).split(Ms[tr], y[tr], groups=g[tr]))
        lr = LogisticRegression(max_iter=3000).fit(Ms[tr][gi], y[tr][gi])
        coefs.append(lr.coef_[0])
        iso = IsotonicRegression(out_of_bounds="clip").fit(lr.predict_proba(Ms[tr][ci])[:, 1], y[tr][ci])
        oof[te] = iso.predict(lr.predict_proba(Ms[te])[:, 1])
    return oof, np.mean(coefs, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--artists", type=int, default=400)
    ap.add_argument("--csv")
    a = ap.parse_args()

    X, y, g = featurise(load(a.artists))
    bg = add_percentile(X, y)
    print(f"\n{len(y)} pairs | {y.sum()} same-print ({100*y.mean():.1f}%) | {len(set(g))} artists")

    print("\n(a) PER-ARTIST NORMALISATION")
    # Reported on BOTH evaluation sets, because they disagree and the disagreement is the
    # finding. On the unfiltered set the percentile looks WORSE than raw dino — it scores
    # duplicate-node pairs as matches, which they are, while the label says otherwise. Those
    # pairs are mislabelled positives, so the penalty is for being right. The filtered set is
    # the honest comparison.
    has = np.array([x["dinoPct"] is not None for x in X])
    clean = np.array([not (yi == 0 and xi["sameTitleKey"]) for xi, yi in zip(X, y)])
    for label, m in (("unfiltered  ", has), ("dup-filtered", has & clean)):
        raw, nrm, yk = (np.array([x["dino"] for x in X])[m],
                        np.array([x["dinoPct"] for x in X])[m], y[m])
        print(f"    [{label}] raw dino          AUC {roc_auc_score(yk, raw):.4f}   AP {average_precision_score(yk, raw):.4f}")
        print(f"    [{label}] per-artist pctile AUC {roc_auc_score(yk, nrm):.4f}   AP {average_precision_score(yk, nrm):.4f}")
    per = [(art, float(np.quantile(b, 0.99))) for art, b in bg.items() if len(b) >= 30]
    if per:
        t = np.array([p[1] for p in per])
        print(f"    1%-FPR threshold across {len(per)} artists: min {t.min():.3f} median {np.median(t):.3f} max {t.max():.3f}")
        print(f"    against the global {GLOBAL_FLOOR}: {(t > GLOBAL_FLOOR).sum()}/{len(t)} artists need a HIGHER floor")

    print("\n(b) CALIBRATED P(same print) — logistic + isotonic, GroupKFold by artist")
    for label, mask in (("all pairs", np.ones(len(y), bool)),
                        ("contamination-filtered", np.array([not (yi == 0 and xi["sameTitleKey"]) for xi, yi in zip(X, y)]))):
        Xm = [x for x, m in zip(X, mask) if m]
        oof, C = calibrated_oof(Xm, y[mask], g[mask])
        ym = y[mask]
        print(f"\n  [{label}] {len(ym)} pairs | AUC {roc_auc_score(ym, oof):.4f}  "
              f"AP {average_precision_score(ym, oof):.4f}  Brier {brier_score_loss(ym, oof):.4f}")
        print("    coefficients: " + "  ".join(f"{n}{c:+.2f}" for n, c in sorted(zip(FEATURES, C), key=lambda t: -abs(t[1]))))
        print(f"    {'P>=':<7}{'precision':>10}{'recall':>9}{'kept':>8}")
        for p in (0.5, 0.8, 0.9, 0.95, 0.99):
            s = oof >= p
            if s.sum():
                print(f"    {p:<7.2f}{ym[s].mean():>10.3f}{ym[s].sum()/ym.sum():>9.3f}{s.sum():>8}")
        print("    calibration:", "  ".join(
            f"[{lo:.1f}-{hi:.1f}] said {oof[(oof>=lo)&(oof<hi)].mean():.2f} was {ym[(oof>=lo)&(oof<hi)].mean():.2f}"
            for lo, hi in [(.3,.5),(.5,.7),(.7,.9),(.9,1.01)] if ((oof>=lo)&(oof<hi)).sum() >= 20))

    if a.csv:
        import csv as _csv
        with open(a.csv, "w", newline="") as f:
            w = _csv.writer(f)
            w.writerow(["artist", "samePrint"] + FEATURES)
            for xi, yi in zip(X, y):
                w.writerow([xi["artist"], yi] + vec(xi))
        print(f"\n[csv] {a.csv}")


if __name__ == "__main__":
    main()
