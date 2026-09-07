"""
PrintMasterAI — is the technique classifier's weakness granularity or signal?
Version: TECHML-CONFUSION-1.0

Tests one specific hypothesis about why 15 of 21 techniques score near zero on
held-out artists: that the label space is too fine, and visually adjacent processes
are being cross-attributed to each other rather than genuinely missed.

The hypothesis is worth taking seriously because rarity clearly isn't the whole
story — Aquatint has more test support than Engraving (680 images / 163 artists vs
274 / 105) yet scores 0.20 against 0.50. Something other than sample count is
separating them.

Three measurements, none of which need new data:

  1. Cross-attribution matrix — when technique i is present and the model wrongly
     fires technique j, which j? If the mass concentrates inside process families
     (etching/aquatint/drypoint/engraving/mezzotint all being intaglio), the label
     space is the problem. If it scatters across unrelated families, the features are.

  2. Family-collapsed retrain — the identical head, identical artist-grouped split,
     with the 21 techniques mapped onto 6 process families. If macro-F1 jumps sharply,
     the model knows *what kind* of print it is and is only failing to name the
     specific process, which is a granularity problem and a usable result in its own
     right. If it barely moves, the features don't carry the signal at any resolution.

  3. Within-family discrimination — restricted to images of a known family, can it
     pick the specific technique? This is the question a granularity fix would have to
     answer, and it isolates the hard part from the easy part.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/analyze_confusions.py
"""

import json
import os
import types

import numpy as np
import torch

from dataset import (
    artist_eval_weights,
    build_label_matrix,
    cap_per_artist,
    group_stratified_split,
    load_dataset,
)
from train_technique_classifier import (
    evaluate,
    prepare_features,
    probs_for,
    train_head,
    tune_thresholds,
    weighted_prf,
)

HERE = os.path.dirname(os.path.abspath(__file__))

# Process families. The grouping is by how the ink gets onto the paper, which is what
# a texture-sensitive feature could plausibly see, not by the art-historical period or
# the market category.
FAMILY = {
    "Etching": "Intaglio",
    "Aquatint": "Intaglio",
    "Drypoint": "Intaglio",
    "Engraving": "Intaglio",
    "Mezzotint": "Intaglio",
    "Photogravure": "Intaglio",
    "Intaglio": "Intaglio",
    "Lithograph": "Planographic",
    "Offset lithograph": "Planographic",
    "Monotype": "Planographic",
    "Woodcut": "Relief",
    "Linocut": "Relief",
    "Wood engraving": "Relief",
    "Letterpress": "Relief",
    "Embossing": "Relief",          # blind/inkless relief — debatable, flagged in output
    "Screenprint / Serigraphy": "Screen",
    "Gelatin silver print": "Photographic",
    "Chromogenic print": "Photographic",
    "Platinum print": "Photographic",
    "Cibachrome print": "Photographic",
    "Collage": "Other",             # not a printing process at all
}


def default_args():
    """Same hyperparameters the shipped model was trained with."""
    return types.SimpleNamespace(
        model="mlp", hidden=512, dropout=0.3, lr=1e-3, weight_decay=1e-4,
        batch_size=256, epochs=60, patience=8, max_pos_weight=20.0, seed=13,
        per_artist_cap=40, artist_weight_alpha=0.5,
    )


def cross_attribution(Y, probs, thresholds, labels, groups):
    """For each true technique, where does the model's false confidence go?

    Rates are artist-weighted so a couple of prolific hands can't define the pattern.
    Read a row as: given this technique is present, how often does the model also
    (wrongly) assert each other technique.
    """
    w = artist_eval_weights(groups)
    pred = (probs >= thresholds[None, :]).astype(np.float32)
    n = len(labels)
    matrix = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        mask = Y[:, i] > 0
        if mask.sum() == 0:
            continue
        wi = w[mask]
        denom = wi.sum()
        for j in range(n):
            if i == j:
                continue
            # false positives only: j asserted where j is genuinely absent
            wrong = pred[mask, j] * (1 - Y[mask, j])
            matrix[i, j] = float((wi * wrong).sum() / denom)
    return matrix


def summarise_cross_attribution(matrix, labels, top=3):
    rows = []
    for i, label in enumerate(labels):
        order = np.argsort(-matrix[i])[:top]
        confusions = [
            {
                "technique": labels[j],
                "rate": round(float(matrix[i, j]), 4),
                "same_family": FAMILY.get(labels[j]) == FAMILY.get(label),
            }
            for j in order if matrix[i, j] > 0.01
        ]
        in_family = sum(matrix[i, j] for j in range(len(labels))
                        if j != i and FAMILY.get(labels[j]) == FAMILY.get(label))
        total = float(matrix[i].sum())
        rows.append({
            "technique": label,
            "family": FAMILY.get(label, "?"),
            "total_false_positive_rate": round(total, 4),
            "share_inside_own_family": round(in_family / total, 3) if total > 0 else None,
            "top_confusions": confusions,
        })
    return rows


def within_family_discrimination(Y, probs, thresholds, labels, groups):
    """Given the family is known, can the model name the specific process?"""
    out = {}
    for family in sorted(set(FAMILY.values())):
        cols = [i for i, l in enumerate(labels) if FAMILY.get(l) == family]
        if len(cols) < 2:
            continue
        mask = Y[:, cols].sum(axis=1) > 0
        if mask.sum() < 50:
            continue
        w = artist_eval_weights(groups[mask])
        scores = []
        for c in cols:
            y = Y[mask, c]
            if y.sum() < 10:
                continue
            _, _, f1 = weighted_prf(
                y, (probs[mask, c] >= thresholds[c]).astype(np.float32), w)
            scores.append({"technique": labels[c], "positives": int(y.sum()),
                           "artist_balanced_f1": round(f1, 4)})
        if scores:
            out[family] = {
                "images": int(mask.sum()),
                "macro_f1_within_family": round(
                    float(np.mean([s["artist_balanced_f1"] for s in scores])), 4),
                "per_technique": scores,
            }
    return out


def main():
    args = default_args()
    device = torch.device("cpu")

    data = load_dataset(os.path.join(HERE, "data", "dataset.npz"))
    Y, labels, keep, _ = build_label_matrix(data["technique_sets"], min_count=150)
    for key in ("X", "image_id", "artist_id", "artist_name", "work_id", "institution"):
        data[key] = data[key][keep]
    Y = Y[keep]
    groups = data["artist_id"]
    fold_ids = group_stratified_split(Y, groups, seed=args.seed)

    # --- fine-grained model (identical to the shipped one) -----------------------
    train_mask = (fold_ids == 0) & cap_per_artist(Y, groups, fold_ids, cap=40, seed=args.seed)
    X, _, _ = prepare_features(data["X"], train_mask)
    val_mask, test_mask = fold_ids == 1, fold_ids == 2
    from dataset import artist_sample_weights
    w_all = artist_sample_weights(groups, alpha=args.artist_weight_alpha)

    print("training fine-grained head (21 techniques)...")
    model, _, _ = train_head(X[train_mask], Y[train_mask], w_all[train_mask],
                             X[val_mask], Y[val_mask], groups[val_mask], args, device)
    probs_va = probs_for(model, X[val_mask], device)
    thresholds = tune_thresholds(Y[val_mask], probs_va, artist_eval_weights(groups[val_mask]))
    probs_te = probs_for(model, X[test_mask], device)
    fine = evaluate(Y[test_mask], probs_te, thresholds, labels,
                    groups[test_mask], data["institution"][test_mask])
    print(f"  artist-balanced macro-F1 {fine['artist_balanced_macro_f1']:.4f}")

    matrix = cross_attribution(Y[test_mask], probs_te, thresholds, labels, groups[test_mask])
    confusions = summarise_cross_attribution(matrix, labels)
    within = within_family_discrimination(Y[test_mask], probs_te, thresholds,
                                          labels, groups[test_mask])

    # --- family-collapsed model --------------------------------------------------
    families = sorted(set(FAMILY[l] for l in labels))
    Yf = np.zeros((len(Y), len(families)), dtype=np.float32)
    for i, label in enumerate(labels):
        Yf[Y[:, i] > 0, families.index(FAMILY[label])] = 1.0

    print(f"training family-collapsed head ({len(families)} families)...")
    model_f, _, _ = train_head(X[train_mask], Yf[train_mask], w_all[train_mask],
                               X[val_mask], Yf[val_mask], groups[val_mask], args, device)
    probs_va_f = probs_for(model_f, X[val_mask], device)
    thr_f = tune_thresholds(Yf[val_mask], probs_va_f, artist_eval_weights(groups[val_mask]))
    probs_te_f = probs_for(model_f, X[test_mask], device)
    coarse = evaluate(Yf[test_mask], probs_te_f, thr_f, families,
                      groups[test_mask], data["institution"][test_mask])
    print(f"  artist-balanced macro-F1 {coarse['artist_balanced_macro_f1']:.4f}")

    report = {
        "fine_grained": {
            "techniques": len(labels),
            "artist_balanced_macro_f1": fine["artist_balanced_macro_f1"],
            "macro_f1": fine["macro_f1"],
        },
        "family_collapsed": {
            "families": families,
            "artist_balanced_macro_f1": coarse["artist_balanced_macro_f1"],
            "macro_f1": coarse["macro_f1"],
            "per_class": coarse["per_class"],
        },
        "cross_attribution": confusions,
        "within_family_discrimination": within,
    }
    path = os.path.join(HERE, "artifacts", "confusion_analysis.json")
    with open(path, "w") as fh:
        json.dump(report, fh, indent=2)

    # --- readable summary --------------------------------------------------------
    print("\n=== family-collapsed per-class (held-out artists) ===")
    for row in coarse["per_class"]:
        print(f"  {row['technique']:<15} F1 {row['artist_balanced_f1']:.3f}  "
              f"({row['support']:,} imgs, {row['support_artists']} artists)")

    print("\n=== within-family discrimination (family known) ===")
    for family, m in within.items():
        print(f"  {family:<15} macro-F1 {m['macro_f1_within_family']:.3f}  "
              f"({m['images']:,} imgs) :: " +
              ", ".join(f"{s['technique']} {s['artist_balanced_f1']:.2f}"
                        for s in m["per_technique"]))

    print("\n=== where false positives go ===")
    for row in sorted(confusions, key=lambda r: -r["total_false_positive_rate"])[:10]:
        share = row["share_inside_own_family"]
        share_s = f"{share:.0%} in-family" if share is not None else "n/a"
        tops = ", ".join(f"{c['technique']} {c['rate']:.2f}"
                         f"{'*' if c['same_family'] else ''}"
                         for c in row["top_confusions"])
        print(f"  {row['technique']:<26} ({row['family']:<12}) FP {row['total_false_positive_rate']:.2f}  "
              f"{share_s:<16} -> {tops}")
    print("\n  (* = same process family)")
    print(f"\nWrote {path}")


if __name__ == "__main__":
    main()
