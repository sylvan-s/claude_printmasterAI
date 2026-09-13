"""
PrintMasterAI — supervised work-identity model over `build_work_identity_dataset.py`'s output.
Version: IDENTITY-MODEL-1.0

Trains and ablates. Writes nothing to the graph and proposes no merges.

THE PROPOSAL. Three image-side approaches have been rejected on measurement (the 2026-09-10
DINOv2 threshold sweep, ADR-0009 Amendment 1's GDS feature-Jaccard, and
`probe_geometric_verification.py`). None tested a LEARNED COMBINATION of weak signals, which is
the standard remedy when each signal is individually poor but their failure modes differ.

THE SPLIT IS GROUPED BY ARTIST, NEVER RANDOM. `project_technique_classifier` measured an
artist-grouped split as worth -0.30 macro-F1 against a random one on this same corpus. A random
split puts one artist's works on both sides and reports a number that will not survive a new
artist.

RESULT, artist-grouped 5-fold over 4,942 rows / 487 artists (gradient boosting; logistic
regression is within 0.01 throughout):

    feature set                              overall  vs cat_conf  vs plate  vs state  non-circ+
    image only (dino + clip)                   0.916        0.915     0.923     0.719      0.862
    image + technique/medium/dims              0.923        0.915     0.952     0.735      0.846
    image + those + catalogue verdict          0.987        0.991     0.978     0.705      0.982
    title only                                 0.907        0.904     0.917     0.916      0.123
    everything                                 0.992        0.994     0.988     0.962      0.923

TWO OF THOSE ROWS ARE LEAKAGE AND THE HEADLINE NUMBERS COME FROM THEM.

  1. `catalogueVerdict` IS THE SAMPLER. `N_catalogue_conflict` is 2,776 of 3,633 negatives and
     that stratum is SELECTED on catalogueVerdict == conflict, so the feature is the label for
     three quarters of the negative class. This one was built in by the dataset design and not
     noticed until the ablation. It is what carries 0.923 -> 0.987.

  2. TITLE IS CIRCULAR ON 91% OF POSITIVES, and worse than useless on the rest. 1,188 of 1,309
     positives have identical normalized titles. On the 121 that do not, `title only` scores
     **0.123** — not uninformative, ACTIVELY ANTI-PREDICTIVE, ranking true pairs below false
     ones. It is what carries 0.923 -> 0.992.

     A correction to this module's first write-up, which claimed exact title "is what merged
     them". That was inference, not measurement: the anchored and image-similarity generators
     corroborate on catalogue base numbers and DINOv2 as well as title, so the 91% figure is
     real but its cause is not established.

  3. THE APPARENT STATE BREAKTHROUGH IS NOT ONE. `everything` scores 0.962 against the state
     class, the first thing in this whole line of work to move it — but the lift comes from
     title (image+other reaches only 0.705), and title separates them by the margin between
     "identical" (positives, median titleRatio 1.000) and "almost identical" (states, 0.964).
     A 0.036 margin fitted over 12 examples is the fragile distinction ADR-0017 was written
     about, not a solution to it.

WHAT IS LEFT AFTER REMOVING BOTH: 0.923, against DINOv2 and CLIP alone at 0.916.

The marginal value of technique, medium and dimensions over the two embeddings is **+0.007**,
consistent with every prior measurement of them: 32 `Technique` nodes graph-wide, `mediumJaccard`
anti-correlated at 0.291 against plate families, and plate-or-image dimensions present on 6% of
positives. The honest state-class figure stays at 0.735.

So a supervised classifier is buildable and it works, and it does not beat the embedding it is
built on by a margin that would justify the dependency. The binding constraint was never the
model.

Usage:
    python3 train_work_identity_model.py work_identity_dataset.csv
"""

import csv
import sys

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

IMAGE = ["dinoMax", "dinoMean", "clipMax", "clipMean"]
TITLE = ["titleRatio", "titleJaccard"]
OTHER = ["techJaccard", "mediumJaccard", "dimMatch", "stateConflict"]
DERIVED = ["dimKnown", "techKnown", "catAgree", "catConflict"]
COLUMNS = IMAGE + TITLE + OTHER + DERIVED

NEGATIVE_STRATA = ("N_catalogue_conflict", "N_plate_family", "N_state")

FEATURE_SETS = {
    "image only (dino + clip)": IMAGE,
    "image + technique/medium/dims": IMAGE + OTHER + ["dimKnown", "techKnown"],
    # catAgree/catConflict are the SAMPLER for three quarters of the negatives — see docstring.
    "image + those + catalogue verdict": IMAGE + OTHER + DERIVED,
    "title only": TITLE,
    "everything": COLUMNS,
}


def load(path):
    rows = [r for r in csv.DictReader(open(path, encoding="utf-8"))
            if r["cls"] != "H_human_triage" and r["workA"]]

    def num(r, c):
        v = r.get(c, "")
        return float(v) if v not in ("", "None") else np.nan

    X, y, groups, cls, circular = [], [], [], [], []
    for r in rows:
        feats = [num(r, c) for c in IMAGE + TITLE + OTHER]
        # A missing dimension is not a disagreement, so the model is told WHETHER it is known
        # rather than having the absence imputed into a value it can read as evidence.
        feats += [float(not np.isnan(num(r, "dimMatch"))),
                  float(not np.isnan(num(r, "techJaccard")))]
        verdict = r.get("catalogueVerdict", "silent")
        feats += [float(verdict == "agree"), float(verdict == "conflict")]
        X.append(feats)
        y.append(int(r["label"]))
        groups.append(r["artist"])
        cls.append(r["cls"])
        circular.append(r.get("circularOnTitle", "0") == "1")
    return (np.array(X, float), np.array(y), np.array(groups),
            np.array(cls), np.array(circular))


def auc(scores, labels):
    a, b = scores[labels == 1], scores[labels == 0]
    if not len(a) or not len(b):
        return float("nan")
    return ((a[:, None] > b[None, :]).sum()
            + 0.5 * (a[:, None] == b[None, :]).sum()) / (len(a) * len(b))


def out_of_fold(X, y, groups, cols, make_model):
    idx = [COLUMNS.index(c) for c in cols]
    Xs = X[:, idx]
    pred = np.zeros(len(y))
    for train, test in GroupKFold(5).split(Xs, y, groups=groups):
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), make_model())
        pipe.fit(Xs[train], y[train])
        pred[test] = pipe.predict_proba(Xs[test])[:, 1]
    return pred


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "work_identity_dataset.csv"
    X, y, groups, cls, circular = load(path)
    print(f"{len(y)} rows  {y.sum()} positive  {len(set(groups))} artists")
    print(f"  positives circular on title: {int((circular & (y == 1)).sum())}/{int(y.sum())}")

    for name, make_model in (
            ("logistic regression", lambda: LogisticRegression(max_iter=3000)),
            ("gradient boosting", lambda: GradientBoostingClassifier(random_state=11))):
        print(f"\n=== {name}, artist-grouped 5-fold ===")
        header = f"{'feature set':36s} {'overall':>8s}"
        header += "".join(f"{n.replace('N_',''):>13s}" for n in NEGATIVE_STRATA)
        print(header + f"{'circ pos':>10s}{'NON-circ pos':>14s}")
        for label, cols in FEATURE_SETS.items():
            pred = out_of_fold(X, y, groups, cols, make_model)
            cells = [f"{auc(pred, y):>8.3f}"]
            for stratum in NEGATIVE_STRATA:
                mask = (y == 1) | (cls == stratum)
                cells.append(f"{auc(pred[mask], y[mask]):>13.3f}")
            for slice_, width in ((circular, 10), (~circular, 14)):
                mask = ((y == 1) & slice_) | (y == 0)
                cells.append(f"{auc(pred[mask], y[mask]):>{width}.3f}")
            print(f"{label:36s} " + "".join(cells))


if __name__ == "__main__":
    main()
