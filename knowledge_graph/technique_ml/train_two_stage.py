"""
PrintMasterAI — two-stage technique classifier: process family, then specific process.
Version: TECHML-TWOSTAGE-1.0

The flat 21-way model answers every image at full granularity and is right about a
third of the time. This one answers at the granularity it has actually earned, per
class, which `analyze_confusions.py` showed is a much better fit to what the features
support: collapsing to six process families nearly doubles artist-balanced macro-F1
(0.298 -> 0.558), while naming the specific process stays hard even when the family
is known (intaglio 0.39, relief 0.29 within-family).

So:

  Stage A — a multi-label head over six process families (Intaglio, Planographic,
            Relief, Screen, Photographic, Other). Multi-label because mixed-media
            prints genuinely belong to two.

  Stage B — one specialist head per family, trained only on that family's images,
            naming the process within it.

  Escalation gate — a specific technique is emitted only if that technique cleared a
            within-family F1 bar on *validation*. Everything else returns the family
            and stops. "A relief print, process unspecified" is a true and useful
            answer; "linocut" asserted at 0.20 F1 is neither.

That gate is the whole point, and it is why the headline number here is not
comparable to the flat model's. This system abstains. It is evaluated on what it says
when it speaks (precision) and how often it speaks (coverage), not on a macro-F1 that
silently rewards guessing. The flat model's score is reported alongside on the same
test fold for contrast.

Evaluation is end-to-end: Stage B runs on Stage A's *predicted* family, so a family
error propagates the way it would in production. Training and threshold tuning use
the true family, as usual.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/train_two_stage.py
    ... --escalation-bar 0.55     # stricter: emit fewer specific techniques
"""

import argparse
import json
import os
import time
import types

import numpy as np
import torch

from analyze_confusions import FAMILY
from dataset import (
    artist_eval_weights,
    artist_sample_weights,
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
MIN_SPECIALIST_POSITIVES = 40


def gate_score(y_true, pred, groups, n_boot=200, percentile=20, seed=13):
    """Pessimistic estimate of a technique's within-family F1.

    A point estimate on a few dozen validation positives is mostly noise: the first
    honest run of this gate passed Photogravure at 0.45 and Embossing at 0.53, and
    both then scored 0.01 on test. So the gate uses the lower tail of a bootstrap
    over *artists* (not images — resampling images would treat one artist's twenty
    prints as twenty independent observations and hide exactly the variance we care
    about). A class only clears the bar if it clears it even on an unlucky draw,
    which small, noisy classes cannot do. Returns (point_estimate, lower_bound).
    """
    point = weighted_prf(y_true, pred, artist_eval_weights(groups))[2]
    artists = np.unique(groups)
    if len(artists) < 5 or y_true.sum() < 5:
        return point, 0.0
    rng = np.random.default_rng(seed)
    index = {a: np.nonzero(groups == a)[0] for a in artists}
    scores = []
    for _ in range(n_boot):
        picked = rng.choice(artists, size=len(artists), replace=True)
        rows = np.concatenate([index[a] for a in picked])
        if y_true[rows].sum() < 1:
            continue
        scores.append(weighted_prf(y_true[rows], pred[rows],
                                   artist_eval_weights(groups[rows]))[2])
    if not scores:
        return point, 0.0
    return point, float(np.percentile(scores, percentile))


def split_validation_by_artist(groups, val_mask, seed=13):
    """Halve the validation fold by artist: one half tunes, the other gates.

    Without this the escalation gate is measured at the very threshold that was
    chosen to maximise it, on the same images — which for a technique with a few
    dozen validation positives inflates F1 enormously. The first run of this script
    passed Embossing (true within-family F1 ~0.19) through a 0.45 bar that way. Both
    halves stay artist-disjoint from train and test, so the gate decision is made on
    artists neither the threshold nor the model has seen.
    """
    rng = np.random.default_rng(seed)
    val_rows = np.nonzero(val_mask)[0]
    artists = np.unique(groups[val_rows])
    rng.shuffle(artists)
    half = set(artists[: len(artists) // 2].tolist())
    tune = np.zeros(len(groups), dtype=bool)
    gate = np.zeros(len(groups), dtype=bool)
    for row in val_rows:
        (tune if groups[row] in half else gate)[row] = True
    return tune, gate


def build_family_matrix(Y, labels):
    families = sorted(set(FAMILY[l] for l in labels))
    Yf = np.zeros((len(Y), len(families)), dtype=np.float32)
    for i, label in enumerate(labels):
        Yf[Y[:, i] > 0, families.index(FAMILY[label])] = 1.0
    return Yf, families


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default=os.path.join(HERE, "data", "dataset.npz"))
    p.add_argument("--out-dir", default=os.path.join(HERE, "artifacts"))
    p.add_argument("--min-class-count", type=int, default=150)
    p.add_argument("--per-artist-cap", type=int, default=40)
    p.add_argument("--artist-weight-alpha", type=float, default=0.5)
    p.add_argument("--escalation-bar", type=float, default=0.45,
                   help="validation within-family artist-balanced F1 a technique must "
                        "clear before the system will ever name it")
    p.add_argument("--model", choices=["mlp", "linear"], default="mlp")
    p.add_argument("--hidden", type=int, default=512)
    p.add_argument("--dropout", type=float, default=0.3)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--patience", type=int, default=8)
    p.add_argument("--max-pos-weight", type=float, default=20.0)
    p.add_argument("--seed", type=int, default=13)
    args = p.parse_args()

    device = torch.device("cpu")
    started = time.time()

    data = load_dataset(args.data)
    Y, labels, keep, dropped = build_label_matrix(data["technique_sets"],
                                                  min_count=args.min_class_count)
    for key in ("X", "image_id", "artist_id", "artist_name", "work_id", "institution"):
        data[key] = data[key][keep]
    Y = Y[keep]
    groups = data["artist_id"]
    Yf, families = build_family_matrix(Y, labels)

    # Same seed as the flat model, so both are measured on identical folds.
    fold_ids = group_stratified_split(Y, groups, seed=args.seed)
    train_mask = fold_ids == 0
    if args.per_artist_cap > 0:
        train_mask = train_mask & cap_per_artist(Y, groups, fold_ids,
                                                 cap=args.per_artist_cap, seed=args.seed)
    val_mask, test_mask = fold_ids == 1, fold_ids == 2
    val_tune_mask, val_gate_mask = split_validation_by_artist(groups, val_mask, seed=args.seed)
    X, mean, std = prepare_features(data["X"], train_mask)
    weights = artist_sample_weights(groups, alpha=args.artist_weight_alpha)

    print(f"{len(Y):,} images · {len(labels)} techniques · {len(families)} families")

    # ---------------------------------------------------------------- Stage A
    print("\nStage A — process family")
    fam_model, _, _ = train_head(X[train_mask], Yf[train_mask], weights[train_mask],
                                 X[val_mask], Yf[val_mask], groups[val_mask], args, device)
    fam_probs_va = probs_for(fam_model, X[val_mask], device)
    fam_thresholds = tune_thresholds(Yf[val_mask], fam_probs_va,
                                     artist_eval_weights(groups[val_mask]))
    fam_probs_gate = probs_for(fam_model, X[val_gate_mask], device)
    fam_probs_te = probs_for(fam_model, X[test_mask], device)
    fam_eval = evaluate(Yf[test_mask], fam_probs_te, fam_thresholds, families,
                        groups[test_mask], data["institution"][test_mask])
    print(f"  artist-balanced macro-F1 {fam_eval['artist_balanced_macro_f1']:.4f}")

    # ---------------------------------------------------------------- Stage B
    print("\nStage B — process within family")
    specialists = {}
    for fi, family in enumerate(families):
        cols = [i for i, l in enumerate(labels) if FAMILY[l] == family]
        usable = [c for c in cols if Y[train_mask][:, c].sum() >= MIN_SPECIALIST_POSITIVES]
        if len(cols) == 1:
            # Family and technique are the same statement (Screen -> Screenprint,
            # Other -> Collage), so Stage A has already answered. But it still has to
            # pass the same bar — an automatic pass here is how Collage got emitted at
            # 0.21 on the first run.
            rows = np.nonzero(val_gate_mask)[0]
            point, lower = gate_score(
                Yf[rows][:, fi],
                (fam_probs_gate[:, fi] >= fam_thresholds[fi]).astype(np.float32),
                groups[rows], seed=args.seed)
            passed = lower >= args.escalation_bar
            specialists[family] = {
                "kind": "identity" if passed else "none",
                "technique": labels[cols[0]], "column": cols[0],
                "gate_scores": {labels[cols[0]]: {"point": round(point, 4),
                                                  "lower": round(lower, 4)}},
            }
            print(f"  {family:<14} single technique via Stage A — "
                  f"gate {lower:.2f} ({'emitted' if passed else 'family only'})")
            continue
        if len(usable) < 2:
            specialists[family] = {"kind": "none"}
            print(f"  {family:<14} too few trainable techniques — family only")
            continue

        # Trained only on images of this family, so the specialist never has to
        # re-learn the family boundary Stage A already draws.
        sub_tr = train_mask & (Yf[:, fi] > 0)
        sub_va = val_mask & (Yf[:, fi] > 0)
        sub_tune = val_tune_mask & (Yf[:, fi] > 0)
        sub_gate = val_gate_mask & (Yf[:, fi] > 0)
        if sub_tr.sum() < 100 or sub_tune.sum() < 30 or sub_gate.sum() < 30:
            specialists[family] = {"kind": "none"}
            print(f"  {family:<14} too few images — family only")
            continue

        # Early stopping still uses the whole validation fold — it picks an epoch, not
        # a claim about performance, so it doesn't contaminate the gate.
        model, _, _ = train_head(X[sub_tr], Y[sub_tr][:, usable], weights[sub_tr],
                                 X[sub_va], Y[sub_va][:, usable], groups[sub_va],
                                 args, device)
        probs_tune = probs_for(model, X[sub_tune], device)
        thr = tune_thresholds(Y[sub_tune][:, usable], probs_tune,
                              artist_eval_weights(groups[sub_tune]))

        # The escalation gate: scored on the held-back half of validation, at the
        # threshold chosen on the other half. This asks the production question —
        # given we know it's an intaglio print, can we name the process well enough
        # to be worth saying out loud — without marking its own homework.
        probs_gate = probs_for(model, X[sub_gate], device)
        w_gate = artist_eval_weights(groups[sub_gate])
        earned, gate_scores = [], {}
        for k, c in enumerate(usable):
            if Y[sub_gate][:, c].sum() < 10:
                gate_scores[labels[c]] = None   # too few to judge; not emitted
                continue
            point, lower = gate_score(
                Y[sub_gate][:, c],
                (probs_gate[:, k] >= thr[k]).astype(np.float32),
                groups[sub_gate], seed=args.seed)
            gate_scores[labels[c]] = {"point": round(point, 4), "lower": round(lower, 4)}
            if lower >= args.escalation_bar:
                earned.append(k)
        specialists[family] = {
            "kind": "model", "model": model, "columns": usable, "thresholds": thr,
            "earned": earned, "gate_scores": gate_scores,
            "earned_techniques": [labels[usable[k]] for k in earned],
        }
        print(f"  {family:<14} {len(usable)} techniques, "
              f"{len(earned)} clear the {args.escalation_bar:.2f} bar: "
              f"{', '.join(labels[usable[k]] for k in earned) or '(none)'}")

    # ------------------------------------------------- end-to-end on the test fold
    # Stage B runs on Stage A's *predicted* family, so family errors propagate.
    fam_pred = (fam_probs_te >= fam_thresholds[None, :]).astype(np.float32)
    n_test = int(test_mask.sum())
    tech_pred = np.zeros((n_test, len(labels)), dtype=np.float32)
    for fi, family in enumerate(families):
        spec = specialists[family]
        rows = np.nonzero(fam_pred[:, fi] > 0)[0]
        if len(rows) == 0 or spec["kind"] == "none":
            continue
        if spec["kind"] == "identity":
            tech_pred[rows, spec["column"]] = 1.0
            continue
        probs = probs_for(spec["model"], X[test_mask][rows], device)
        for k in spec["earned"]:
            tech_pred[rows[probs[:, k] >= spec["thresholds"][k]], spec["columns"][k]] = 1.0

    Y_te = Y[test_mask]
    groups_te = groups[test_mask]
    w_te = artist_eval_weights(groups_te)
    emitted = sorted({labels[c] for f in families
                      for c in (specialists[f].get("columns", []) or [])
                      if specialists[f]["kind"] == "model"
                      and specialists[f]["columns"].index(c) in specialists[f]["earned"]}
                     | {specialists[f]["technique"] for f in families
                        if specialists[f]["kind"] == "identity"})

    per_technique = []
    for name in emitted:
        c = labels.index(name)
        p_, r_, f1_ = weighted_prf(Y_te[:, c], tech_pred[:, c], w_te)
        per_technique.append({
            "technique": name, "support": int(Y_te[:, c].sum()),
            "precision": round(p_, 4), "recall": round(r_, 4),
            "artist_balanced_f1": round(f1_, 4),
        })

    answered = tech_pred.sum(axis=1) > 0
    correct_when_answered = float(
        (w_te[answered] * ((tech_pred[answered] * Y_te[answered]).sum(axis=1) > 0)).sum()
        / w_te[answered].sum()) if answered.sum() else 0.0

    # Flat 21-way model on the identical fold, for contrast.
    print("\nFlat 21-way baseline on the same fold")
    flat_model, _, _ = train_head(X[train_mask], Y[train_mask], weights[train_mask],
                                  X[val_mask], Y[val_mask], groups[val_mask], args, device)
    flat_va = probs_for(flat_model, X[val_mask], device)
    flat_thr = tune_thresholds(Y[val_mask], flat_va, artist_eval_weights(groups[val_mask]))
    flat_eval = evaluate(Y_te, probs_for(flat_model, X[test_mask], device), flat_thr,
                         labels, groups_te, data["institution"][test_mask])
    flat_by_name = {r["technique"]: r for r in flat_eval["per_class"]}
    print(f"  artist-balanced macro-F1 {flat_eval['artist_balanced_macro_f1']:.4f}")

    report = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {k: v for k, v in vars(args).items()},
        "families": families,
        "stage_a_family": {
            "artist_balanced_macro_f1": fam_eval["artist_balanced_macro_f1"],
            "per_class": fam_eval["per_class"],
        },
        "stage_b_gates": {f: specialists[f].get("gate_scores", {}) for f in families},
        "emitted_techniques": emitted,
        "end_to_end": {
            "test_images": n_test,
            "coverage": round(float(answered.mean()), 4),
            "correct_when_answered": round(correct_when_answered, 4),
            "per_technique": sorted(per_technique, key=lambda r: -r["support"]),
        },
        "flat_baseline": {
            "artist_balanced_macro_f1": flat_eval["artist_balanced_macro_f1"],
            "per_class": flat_eval["per_class"],
        },
    }

    os.makedirs(args.out_dir, exist_ok=True)
    torch.save({
        "family_model": fam_model.state_dict(), "families": families,
        "family_thresholds": fam_thresholds,
        "specialists": {
            f: {"state_dict": s["model"].state_dict(), "columns": s["columns"],
                "thresholds": s["thresholds"], "earned": s["earned"]}
            for f, s in specialists.items() if s["kind"] == "model"
        },
        "identity_families": {f: s for f, s in specialists.items() if s["kind"] == "identity"},
        "labels": labels, "label_family": FAMILY,
        "model_kind": args.model, "hidden": args.hidden, "dropout": args.dropout,
        "feature_mean": mean, "feature_std": std,
        "embedding_model": "facebook/dinov2-large",
    }, os.path.join(args.out_dir, "two_stage_classifier.pt"))
    with open(os.path.join(args.out_dir, "two_stage_evaluation.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    write_report(report, os.path.join(args.out_dir, "TWO_STAGE_EVALUATION.md"),
                 flat_by_name)

    print(f"\nEnd-to-end: names a technique for {report['end_to_end']['coverage']:.0%} "
          f"of test images; when it does, {correct_when_answered:.0%} of those calls "
          f"hit a true technique.")
    print(f"Wrote {args.out_dir}/two_stage_classifier.pt, two_stage_evaluation.json, "
          f"TWO_STAGE_EVALUATION.md ({time.time() - started:.0f}s)")


def write_report(r, path, flat_by_name):
    e2e = r["end_to_end"]
    lines = [
        "# Two-stage technique classifier — evaluation",
        "",
        f"Generated {r['generated_at']}. Stage A names the process family; Stage B "
        f"names the process within it, but only for techniques that cleared a "
        f"{r['config']['escalation_bar']:.2f} within-family F1 bar on validation. "
        f"Everything else returns the family and stops.",
        "",
        "All numbers are on held-out **artists**, and Stage B runs on Stage A's "
        "*predicted* family, so family errors propagate as they would in production.",
        "",
        "## Stage A — process family",
        "",
        f"Artist-balanced macro-F1 **{r['stage_a_family']['artist_balanced_macro_f1']:.3f}** "
        f"(flat 21-way model, same fold: {r['flat_baseline']['artist_balanced_macro_f1']:.3f})",
        "",
        "| Family | Test images | Test artists | P | R | Artist-bal. F1 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in r["stage_a_family"]["per_class"]:
        lines.append(f"| {row['technique']} | {row['support']:,} | {row['support_artists']:,} | "
                     f"{row['precision']:.2f} | {row['recall']:.2f} | "
                     f"{row['artist_balanced_f1']:.2f} |")

    lines += ["", "## Stage B — the escalation gate", "",
              "Within-family F1 on the held-back half of validation, at a threshold "
              "chosen on the other half. The bracketed figure is the 20th-percentile "
              "bootstrap over artists, and it is what the bar is applied to — a class "
              "must clear it even on an unlucky draw. The rest are reachable only as "
              "a family.", "",
              "| Family | Technique | Val. F1, point (bootstrap lower) | Emitted? |",
              "| --- | --- | ---: | :---: |"]
    for family, scores in r["stage_b_gates"].items():
        for tech, score in sorted(
                scores.items(),
                key=lambda kv: -(kv[1]["lower"] if isinstance(kv[1], dict) else -1)):
            mark = "yes" if tech in r["emitted_techniques"] else "—"
            score_s = (f"{score['point']:.2f} ({score['lower']:.2f})"
                       if isinstance(score, dict) else "too few to judge")
            lines.append(f"| {family} | {tech} | {score_s} | {mark} |")

    lines += ["", "## End-to-end", "",
              f"- Names a specific technique for **{e2e['coverage']:.0%}** of test images",
              f"- When it names one, **{e2e['correct_when_answered']:.0%}** of those "
              f"calls hit a technique the print genuinely uses",
              f"- The other {1 - e2e['coverage']:.0%} return a family only",
              "",
              "| Technique | Test images | P | R | Artist-bal. F1 | Flat model F1 |",
              "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for row in e2e["per_technique"]:
        flat = flat_by_name.get(row["technique"], {}).get("artist_balanced_f1")
        flat_s = f"{flat:.2f}" if flat is not None else "—"
        lines.append(f"| {row['technique']} | {row['support']:,} | {row['precision']:.2f} | "
                     f"{row['recall']:.2f} | {row['artist_balanced_f1']:.2f} | {flat_s} |")

    lines += ["", "## How to read this against the flat model", "",
              "The flat model's macro-F1 averages over 21 techniques it always answers, "
              "including ones it gets right 10% of the time. This one abstains, so its "
              "macro-F1 is not comparable — coverage and precision-when-answering are "
              "the honest pair. The per-technique table above puts both side by side "
              "for the techniques this system is willing to name.", ""]
    with open(path, "w") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    main()
