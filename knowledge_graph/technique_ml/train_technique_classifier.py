"""
PrintMasterAI — multi-label printmaking-technique classifier over ACKG DINOv2 embeddings.
Version: TECHML-TRAIN-1.0

Trains a head on the frozen 1024-d DINOv2-Large vectors already on `DigitalImage`
nodes to predict which printing process(es) made an image. Multi-label by design:
13% of labelled impressions carry more than one technique (etching + aquatint is the
classic pair), so this is per-technique sigmoids with a tuned threshold each, never a
softmax over mutually-exclusive classes.

The point of the design is not the head — a linear probe on frozen features is a
deliberately modest model — it's the evaluation protocol around it. See dataset.py
for the two shortcuts this corpus offers and how the splitting, capping and weighting
close them. Concretely, this script reports:

  * macro-F1               — every technique counts equally, so the tail matters.
  * artist-balanced macro-F1 — the headline number. Each *held-out artist* gets one
                             equal vote, so a model that only works on prolific,
                             already-seen hands cannot hide behind volume.
  * per-institution F1     — exposes the source confound directly.
  * a source-leakage probe — how well the same features predict Bonhams/Tate/BM. If
                             that is near-perfect, any single-institution technique's
                             score is partly a photograph-style score, and the report
                             flags those classes rather than quietly banking them.
  * --compare-random-split — trains the identical head on an image-level random split
                             for contrast. The gap between the two is the size of the
                             artist-memorisation shortcut, i.e. how much a
                             conventionally-evaluated version of this model would have
                             overstated itself.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/train_technique_classifier.py
    ... --model linear            # linear probe instead of the 1-hidden-layer MLP
    ... --compare-random-split    # also report the inflated naive-split number
    ... --per-artist-cap 0        # disable capping (ablation)
"""

import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn

from dataset import (
    DEFAULT_MIN_CLASS_COUNT,
    DEFAULT_PER_ARTIST_CAP,
    artist_eval_weights,
    artist_sample_weights,
    build_label_matrix,
    cap_per_artist,
    group_stratified_split,
    load_dataset,
)

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- features & model

def prepare_features(X, train_mask):
    """L2-normalise, then standardise on training statistics only.

    DINOv2 CLS vectors vary a lot in magnitude with image size and crop; the direction
    is the part that carries texture, so normalise first. Standardising afterwards is
    what lets a single learning rate work across all 1024 dimensions.
    """
    Xn = X / np.clip(np.linalg.norm(X, axis=1, keepdims=True), 1e-8, None)
    mean = Xn[train_mask].mean(axis=0, keepdims=True)
    std = np.clip(Xn[train_mask].std(axis=0, keepdims=True), 1e-6, None)
    return ((Xn - mean) / std).astype(np.float32), mean, std


def build_model(kind, in_dim, out_dim, hidden=512, dropout=0.3):
    if kind == "linear":
        return nn.Linear(in_dim, out_dim)
    return nn.Sequential(
        nn.Linear(in_dim, hidden),
        nn.BatchNorm1d(hidden),
        nn.GELU(),
        nn.Dropout(dropout),
        nn.Linear(hidden, out_dim),
    )


# ---------------------------------------------------------------------- metrics

def weighted_prf(y_true, y_pred, weights):
    """Weighted precision/recall/F1 for one binary column."""
    tp = float((weights * y_true * y_pred).sum())
    fp = float((weights * (1 - y_true) * y_pred).sum())
    fn = float((weights * y_true * (1 - y_pred)).sum())
    precision = tp / (tp + fp) if tp + fp > 0 else 0.0
    recall = tp / (tp + fn) if tp + fn > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    return precision, recall, f1


def weighted_average_precision(y_true, scores, weights):
    """Weighted area under the precision-recall curve for one binary column."""
    order = np.argsort(-scores)
    y, w = y_true[order], weights[order]
    total_pos = float((w * y).sum())
    if total_pos <= 0:
        return 0.0
    tp = np.cumsum(w * y)
    seen = np.cumsum(w)
    precision = tp / np.clip(seen, 1e-12, None)
    return float((precision * (w * y)).sum() / total_pos)


def artist_weighted_macro_ap(y_true, probs, groups):
    """Mean average precision across techniques, each artist weighted equally."""
    w = artist_eval_weights(groups)
    return float(np.mean([
        weighted_average_precision(y_true[:, c], probs[:, c], w)
        for c in range(y_true.shape[1])
    ]))


def tune_thresholds(y_true, probs, weights, grid=None):
    """Pick a per-class decision threshold, maximising that class's weighted F1.

    Per-class rather than a single global 0.5: the classes span three orders of
    magnitude in prevalence, and one shared threshold silently trades the entire tail
    away for a better micro-average. Tuned on validation only.
    """
    grid = grid if grid is not None else np.arange(0.05, 0.96, 0.01)
    thresholds = np.full(y_true.shape[1], 0.5, dtype=np.float32)
    for c in range(y_true.shape[1]):
        best_f1, best_t = -1.0, 0.5
        for t in grid:
            _, _, f1 = weighted_prf(y_true[:, c], (probs[:, c] >= t).astype(np.float32), weights)
            if f1 > best_f1:
                best_f1, best_t = f1, float(t)
        thresholds[c] = best_t
    return thresholds


def evaluate(y_true, probs, thresholds, labels, groups, institutions):
    """Full metric bundle for one fold."""
    y_pred = (probs >= thresholds[None, :]).astype(np.float32)
    flat = np.ones(len(y_true), dtype=np.float32)
    artist_w = artist_eval_weights(groups)

    per_class = []
    for c, label in enumerate(labels):
        p, r, f1 = weighted_prf(y_true[:, c], y_pred[:, c], flat)
        ap, ar, af1 = weighted_prf(y_true[:, c], y_pred[:, c], artist_w)
        per_class.append({
            "technique": label,
            "support": int(y_true[:, c].sum()),
            "support_artists": int(len(np.unique(groups[y_true[:, c] > 0]))),
            "precision": round(p, 4),
            "recall": round(r, 4),
            "f1": round(f1, 4),
            "artist_balanced_f1": round(af1, 4),
            "threshold": round(float(thresholds[c]), 3),
        })

    # Average precision is threshold-free, so it says how well the model *ranks*
    # candidates for a technique independently of where the cut was drawn — the more
    # useful number when this feeds a pipeline stage that fuses evidence rather than
    # taking a hard decision.
    for c in range(len(labels)):
        per_class[c]["average_precision"] = round(
            weighted_average_precision(y_true[:, c], probs[:, c], flat), 4)
        per_class[c]["artist_balanced_average_precision"] = round(
            weighted_average_precision(y_true[:, c], probs[:, c], artist_w), 4)

    macro_f1 = float(np.mean([m["f1"] for m in per_class]))
    artist_macro_f1 = float(np.mean([m["artist_balanced_f1"] for m in per_class]))
    tp = float((y_true * y_pred).sum())
    fp = float(((1 - y_true) * y_pred).sum())
    fn = float((y_true * (1 - y_pred)).sum())
    micro_f1 = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
    exact = float(np.mean((y_pred == y_true).all(axis=1)))

    by_institution = {}
    for inst in sorted(set(institutions.tolist())):
        m = institutions == inst
        if m.sum() < 30:
            continue
        present = [c for c in range(len(labels)) if y_true[m, c].sum() >= 5]
        if not present:
            continue
        scores = [weighted_prf(y_true[m, c], y_pred[m, c], np.ones(int(m.sum()), np.float32))[2]
                  for c in present]
        by_institution[inst] = {
            "images": int(m.sum()),
            "scored_techniques": len(present),
            "macro_f1": round(float(np.mean(scores)), 4),
        }

    return {
        "images": int(len(y_true)),
        "artists": int(len(np.unique(groups))),
        "micro_f1": round(micro_f1, 4),
        "macro_f1": round(macro_f1, 4),
        "artist_balanced_macro_f1": round(artist_macro_f1, 4),
        "exact_match_ratio": round(exact, 4),
        "macro_average_precision": round(
            float(np.mean([m["average_precision"] for m in per_class])), 4),
        "artist_balanced_macro_average_precision": round(
            float(np.mean([m["artist_balanced_average_precision"] for m in per_class])), 4),
        "per_class": sorted(per_class, key=lambda r: -r["support"]),
        "by_institution": by_institution,
    }


# --------------------------------------------------------------------- training

def train_head(Xtr, Ytr, Wtr, Xva, Yva, groups_va, args, device):
    """Train to convergence on validation artist-balanced macro-F1, then restore best."""
    torch.manual_seed(args.seed)
    model = build_model(args.model, Xtr.shape[1], Ytr.shape[1], args.hidden, args.dropout).to(device)

    # pos_weight rebalances each technique's own positive/negative ratio inside BCE.
    # Capped so a 200-image class doesn't get a 200x gradient and drown the rest.
    pos = np.clip(Ytr.sum(axis=0), 1.0, None)
    pos_weight = np.clip((len(Ytr) - pos) / pos, 1.0, args.max_pos_weight)
    criterion = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor(pos_weight, dtype=torch.float32, device=device),
        reduction="none",
    )
    optimiser = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    Xtr_t = torch.tensor(Xtr, device=device)
    Ytr_t = torch.tensor(Ytr, device=device)
    Wtr_t = torch.tensor(Wtr, device=device).unsqueeze(1)
    Xva_t = torch.tensor(Xva, device=device)

    best_score, best_state, best_epoch = -1.0, None, -1
    n = len(Xtr_t)
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n, device=device)
        for start in range(0, n, args.batch_size):
            idx = perm[start:start + args.batch_size]
            if len(idx) < 2:
                continue
            optimiser.zero_grad()
            loss = (criterion(model(Xtr_t[idx]), Ytr_t[idx]) * Wtr_t[idx]).mean()
            loss.backward()
            optimiser.step()

        model.eval()
        with torch.no_grad():
            probs_va = torch.sigmoid(model(Xva_t)).cpu().numpy()
        # Selection is threshold-free (artist-weighted macro average precision), not
        # F1 at a fixed 0.5 cut. A rare class's probabilities all sit well under 0.5
        # early in training, so an F1-at-0.5 criterion scores the whole tail as zero
        # and picks whichever epoch happened to suit the head classes. Tuned
        # thresholds can't be used here either — that would fit validation twice.
        score = artist_weighted_macro_ap(Yva, probs_va, groups_va)
        if score > best_score:
            best_score, best_epoch = score, epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        elif epoch - best_epoch >= args.patience:
            break

    model.load_state_dict(best_state)
    model.eval()
    return model, best_epoch, best_score


def probs_for(model, X, device, batch=8192):
    out = []
    with torch.no_grad():
        for start in range(0, len(X), batch):
            chunk = torch.tensor(X[start:start + batch], device=device)
            out.append(torch.sigmoid(model(chunk)).cpu().numpy())
    return np.vstack(out)


def run_experiment(data, Y, labels, fold_ids, args, device, tag, apply_cap=True):
    groups = data["artist_id"]
    train_mask = fold_ids == 0
    if apply_cap and args.per_artist_cap > 0:
        keep = cap_per_artist(Y, groups, fold_ids, cap=args.per_artist_cap, seed=args.seed)
        capped_out = int((train_mask & ~keep).sum())
        train_mask = train_mask & keep
    else:
        capped_out = 0

    X, mean, std = prepare_features(data["X"], train_mask)
    val_mask, test_mask = fold_ids == 1, fold_ids == 2

    weights = artist_sample_weights(groups, alpha=args.artist_weight_alpha)
    model, best_epoch, best_val = train_head(
        X[train_mask], Y[train_mask], weights[train_mask],
        X[val_mask], Y[val_mask], groups[val_mask], args, device,
    )

    probs_va = probs_for(model, X[val_mask], device)
    thresholds = tune_thresholds(Y[val_mask], probs_va, artist_eval_weights(groups[val_mask]))
    probs_te = probs_for(model, X[test_mask], device)

    result = {
        "tag": tag,
        "train_images": int(train_mask.sum()),
        "train_images_dropped_by_cap": capped_out,
        "train_artists": int(len(np.unique(groups[train_mask]))),
        "best_epoch": best_epoch,
        "val_artist_balanced_macro_ap": round(best_val, 4),
        "validation": evaluate(Y[val_mask], probs_va, thresholds, labels,
                               groups[val_mask], data["institution"][val_mask]),
        "test": evaluate(Y[test_mask], probs_te, thresholds, labels,
                         groups[test_mask], data["institution"][test_mask]),
        "secondary_process_probe": secondary_process_probe(
            Y[test_mask], probs_te, labels, groups[test_mask]),
    }
    return result, model, thresholds, mean, std


def secondary_process_probe(Y, probs, labels, groups, base="Etching",
                           secondaries=("Aquatint", "Drypoint")):
    """Can the model see the plate texture, or only the print's overall look?

    Aquatint and drypoint are almost never used alone — they are worked into an
    etched plate, so the finished image looks like an etching and the only cue that
    separates them is fine surface grain (aquatint's resin tone, drypoint's burr).
    Scoring them across the whole test set flatters the model, because most negatives
    are lithographs and screenprints it can reject on other grounds. This restricts
    the question to test images already labelled `base`, where that easy signal is
    gone, and compares average precision against the base rate a coin would achieve.

    A ratio near 1.0 means the embedding carries no usable grain information at all —
    which is the expected outcome if 224px whole-image DINOv2 features are simply too
    coarse to resolve it, and the thing to fix before trying a bigger head.
    """
    if base not in labels:
        return {}
    base_col = labels.index(base)
    mask = Y[:, base_col] > 0
    if mask.sum() < 50:
        return {}
    w = artist_eval_weights(groups[mask])
    out = {"restricted_to": base, "images": int(mask.sum()), "secondaries": {}}
    for name in secondaries:
        if name not in labels:
            continue
        col = labels.index(name)
        y = Y[mask, col]
        if y.sum() < 10:
            continue
        base_rate = float((w * y).sum() / w.sum())
        ap = weighted_average_precision(y, probs[mask, col], w)
        out["secondaries"][name] = {
            "positives": int(y.sum()),
            "base_rate": round(base_rate, 4),
            "average_precision": round(ap, 4),
            "lift_over_chance": round(ap / base_rate, 2) if base_rate > 0 else None,
        }
    return out


def source_leakage_probe(data, fold_ids, args, device):
    """How much of the signal is 'which institution photographed this?'

    Trained and scored the same way as the technique head, on the same features and
    the same artist-grouped folds. A high number doesn't invalidate the model, but it
    does mean any technique that only ever appears from one source is being scored on
    a partly-spurious cue — reported alongside the list of those classes.
    """
    institutions = data["institution"]
    names = sorted(set(institutions.tolist()))
    Y = np.zeros((len(institutions), len(names)), dtype=np.float32)
    for i, inst in enumerate(names):
        Y[institutions == inst, i] = 1.0

    train_mask = fold_ids == 0
    X, _, _ = prepare_features(data["X"], train_mask)
    model, _, _ = train_head(
        X[train_mask], Y[train_mask], np.ones(int(train_mask.sum()), np.float32),
        X[fold_ids == 1], Y[fold_ids == 1], data["artist_id"][fold_ids == 1],
        args, device,
    )
    test_mask = fold_ids == 2
    pred = probs_for(model, X[test_mask], device).argmax(axis=1)
    truth = Y[test_mask].argmax(axis=1)
    return {
        "institutions": names,
        "test_accuracy": round(float((pred == truth).mean()), 4),
        "majority_class_baseline": round(float(np.bincount(truth).max() / len(truth)), 4),
    }


# ------------------------------------------------------------------------- report

def write_markdown_report(report, path):
    r = report
    test = r["grouped_split"]["test"]
    lines = [
        "# Printmaking-technique classifier — evaluation report",
        "",
        f"Generated {r['generated_at']} · model `{r['config']['model']}` on "
        f"{r['dataset']['images']:,} DINOv2-Large embeddings "
        f"({r['dataset']['artists']:,} artists, {len(r['labels'])} techniques)",
        "",
        "## Headline",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| **Artist-balanced macro-F1 (held-out artists)** | **{test['artist_balanced_macro_f1']:.3f}** |",
        f"| Macro-F1 | {test['macro_f1']:.3f} |",
        f"| Micro-F1 | {test['micro_f1']:.3f} |",
        f"| Artist-balanced macro average precision | {test['artist_balanced_macro_average_precision']:.3f} |",
        f"| Exact set match | {test['exact_match_ratio']:.3f} |",
        f"| Test images / artists | {test['images']:,} / {test['artists']:,} |",
        "",
    ]

    if r.get("random_split"):
        rnd = r["random_split"]["test"]["macro_f1"]
        grouped = test["macro_f1"]
        lines += [
            "## How much of that is artist memorisation",
            "",
            f"The same head on a conventional image-level random split scores "
            f"**{rnd:.3f}** macro-F1 against **{grouped:.3f}** on held-out artists — "
            f"a {rnd - grouped:+.3f} gap. That difference is the shortcut: it is what "
            f"the model gains from having seen the same artist (often the same work) "
            f"in training, and it is the number a naively-evaluated version of this "
            f"model would have reported.",
            "",
        ]

    probe = r["source_leakage_probe"]
    lines += [
        "## Source confound",
        "",
        f"An identical head predicts the source institution from the same embeddings "
        f"with **{probe['test_accuracy']:.3f}** accuracy (majority baseline "
        f"{probe['majority_class_baseline']:.3f}). Techniques below that appear from "
        f"only one institution are therefore partly scored on studio style, not process:",
        "",
    ]
    single = r["single_source_techniques"]
    lines += ([f"- `{t}` — {inst} only" for t, inst in single.items()] if single
              else ["- none"])

    lines += ["", "## Per-technique (held-out artists)", "",
              "| Technique | Test images | Test artists | P | R | F1 | Artist-bal. F1 | Artist-bal. AP | Thr. |",
              "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in test["per_class"]:
        flag = " ⚠" if row["technique"] in single else ""
        lines.append(
            f"| {row['technique']}{flag} | {row['support']:,} | {row['support_artists']:,} | "
            f"{row['precision']:.2f} | {row['recall']:.2f} | {row['f1']:.2f} | "
            f"{row['artist_balanced_f1']:.2f} | "
            f"{row['artist_balanced_average_precision']:.2f} | {row['threshold']:.2f} |"
        )

    usable = [row for row in test["per_class"] if row["artist_balanced_f1"] >= 0.40]
    lines += ["", "## What is actually usable", "",
              f"{len(usable)} of {len(test['per_class'])} techniques clear an "
              f"artist-balanced F1 of 0.40 on unseen artists. These are the only "
              f"classes worth acting on downstream; the rest are reported for "
              f"completeness and should be treated as no-signal:", ""]
    lines += ([f"- **{row['technique']}** — F1 {row['artist_balanced_f1']:.2f} "
               f"({row['support']:,} test images, {row['support_artists']} artists)"
               for row in usable] or ["- none"])

    probe2 = r["grouped_split"].get("secondary_process_probe") or {}
    if probe2.get("secondaries"):
        lines += ["", "## Can it see plate texture?", "",
                  f"Restricted to the {probe2['images']:,} test images already labelled "
                  f"{probe2['restricted_to']}, where the only thing separating the "
                  f"classes below is fine surface grain rather than the print's overall "
                  f"look:", "",
                  "| Secondary process | Positives | Base rate | Avg. precision | Lift |",
                  "| --- | ---: | ---: | ---: | ---: |"]
        for name, m in probe2["secondaries"].items():
            lift = f"{m['lift_over_chance']:.2f}x" if m["lift_over_chance"] else "—"
            lines.append(f"| {name} | {m['positives']:,} | {m['base_rate']:.3f} | "
                         f"{m['average_precision']:.3f} | {lift} |")

    lines += ["", "## Per-institution macro-F1 (test fold)", "",
              "| Institution | Test images | Techniques scored | Macro-F1 |",
              "| --- | ---: | ---: | ---: |"]
    for inst, m in sorted(test["by_institution"].items()):
        lines.append(f"| {inst} | {m['images']:,} | {m['scored_techniques']} | {m['macro_f1']:.3f} |")

    dropped = r["dataset"]["dropped_labels"]
    if dropped:
        lines += ["", "## Techniques excluded from the label space", "",
                  f"Below the {r['config']['min_class_count']}-image floor — too few "
                  f"images to split across three folds and still leave a testable "
                  f"number of held-out artists:", "",
                  ", ".join(f"{t} ({c})" for t, c in dropped)]

    lines += ["", "## Configuration", "", "```json",
              json.dumps(r["config"], indent=2), "```", ""]
    with open(path, "w") as fh:
        fh.write("\n".join(lines))


# --------------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default=os.path.join(HERE, "data", "dataset.npz"))
    p.add_argument("--out-dir", default=os.path.join(HERE, "artifacts"))
    p.add_argument("--model", choices=["mlp", "linear"], default="mlp")
    p.add_argument("--min-class-count", type=int, default=DEFAULT_MIN_CLASS_COUNT)
    p.add_argument("--per-artist-cap", type=int, default=DEFAULT_PER_ARTIST_CAP,
                   help="max training images per (artist, technique-set); 0 disables")
    p.add_argument("--artist-weight-alpha", type=float, default=0.5,
                   help="training weight ~ 1/n_artist^alpha; 0 disables")
    p.add_argument("--hidden", type=int, default=512)
    p.add_argument("--dropout", type=float, default=0.3)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--patience", type=int, default=8)
    p.add_argument("--max-pos-weight", type=float, default=20.0)
    p.add_argument("--seed", type=int, default=13)
    p.add_argument("--compare-random-split", action="store_true")
    args = p.parse_args()

    device = torch.device("cpu")
    started = time.time()

    data = load_dataset(args.data)
    Y, labels, keep, dropped_labels = build_label_matrix(
        data["technique_sets"], min_count=args.min_class_count
    )
    for key in ("X", "image_id", "artist_id", "artist_name", "work_id", "institution"):
        data[key] = data[key][keep]
    Y = Y[keep]
    print(f"{len(Y):,} images, {len(labels)} techniques, "
          f"{len(np.unique(data['artist_id'])):,} artists")

    single_source = {}
    for c, label in enumerate(labels):
        insts = set(data["institution"][Y[:, c] > 0].tolist())
        if len(insts) == 1:
            single_source[label] = insts.pop()

    fold_ids = group_stratified_split(Y, data["artist_id"], seed=args.seed)
    print(f"grouped split — train/val/test images: "
          f"{int((fold_ids==0).sum()):,}/{int((fold_ids==1).sum()):,}/{int((fold_ids==2).sum()):,}")

    grouped, model, thresholds, mean, std = run_experiment(
        data, Y, labels, fold_ids, args, device, "artist-grouped"
    )
    print(f"  test artist-balanced macro-F1 "
          f"{grouped['test']['artist_balanced_macro_f1']:.4f} | "
          f"macro-F1 {grouped['test']['macro_f1']:.4f}")

    random_split = None
    if args.compare_random_split:
        rng = np.random.default_rng(args.seed)
        draw = rng.random(len(Y))
        naive = np.where(draw < 0.70, 0, np.where(draw < 0.85, 1, 2)).astype(np.int64)
        random_split, _, _, _, _ = run_experiment(
            data, Y, labels, naive, args, device, "random-image-split", apply_cap=False
        )
        print(f"  random-split macro-F1 {random_split['test']['macro_f1']:.4f} "
              f"(shortcut inflation)")

    probe = source_leakage_probe(data, fold_ids, args, device)
    print(f"  source-leakage probe accuracy {probe['test_accuracy']:.4f}")

    os.makedirs(args.out_dir, exist_ok=True)
    torch.save({
        "state_dict": model.state_dict(),
        "model_kind": args.model,
        "hidden": args.hidden,
        "dropout": args.dropout,
        "labels": labels,
        "thresholds": thresholds,
        "feature_mean": mean,
        "feature_std": std,
        "embedding_model": "facebook/dinov2-large",
        "embedding_dim": int(data["X"].shape[1]),
    }, os.path.join(args.out_dir, "technique_classifier.pt"))

    report = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "runtime_seconds": round(time.time() - started, 1),
        "config": vars(args),
        "dataset": {
            "images": int(len(Y)),
            "artists": int(len(np.unique(data["artist_id"]))),
            "works": int(len(np.unique(data["work_id"]))),
            "multi_technique_images": int((Y.sum(axis=1) > 1).sum()),
            "dropped_labels": dropped_labels,
        },
        "labels": labels,
        "single_source_techniques": single_source,
        "grouped_split": grouped,
        "random_split": random_split,
        "source_leakage_probe": probe,
    }
    with open(os.path.join(args.out_dir, "evaluation.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    write_markdown_report(report, os.path.join(args.out_dir, "EVALUATION.md"))
    print(f"\nWrote {args.out_dir}/technique_classifier.pt, evaluation.json, EVALUATION.md "
          f"({time.time() - started:.0f}s)")


if __name__ == "__main__":
    main()
