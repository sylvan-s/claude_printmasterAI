"""
PrintMasterAI — ADR-0019 Phase 4: the two-stage family → process model on tile features,
scored on the SAME held-out artists as the 2026-09-07 model.
Version: TECHML-TWOSTAGE-TILES-1.1

Rebuilds `train_two_stage.py`'s design — Stage A names the process family, Stage B names the
process only where a specialist cleared the escalation gate on validation artists it never
tuned on — over pooled (mean ⊕ max) tile embeddings from the Phase 2 shards, so the numbers
compare directly with the stored-embedding model:

    2026-09-07 model, stored 224 px whole-image DINOv2-L:  flat 21-way 0.275 · family 0.558

The split is not re-drawn. Test = images whose artist is in the 2026-09-07 test fold, val =
its validation fold, train = everything else (its train fold plus the 1,307 artists ingested
since). `artifacts/held_out_artists_2026-09-07.json` carries the artist ids. Labels are the
same 21 techniques (those above 150 images in the old corpus) so the macro-F1 is over the same
label set; techniques outside that set (Giclée, Collotype, ...) are reported separately and
do not enter the headline.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/train_two_stage_tiles.py \
        --shards knowledge_graph/technique_ml/data/tiles_full \
        --manifest knowledge_graph/technique_ml/data/phase2_full.jsonl
"""

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_confusions import FAMILY  # noqa: E402
from dataset import artist_eval_weights, cap_per_artist  # noqa: E402
from train_tile_head import bootstrap_artists, fit, load, weighted_ap, weighted_auroc, weighted_f1  # noqa: E402
from train_two_stage import gate_score, split_validation_by_artist  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MIN_SPECIALIST_POSITIVES = 40


def pooled(P):
    P = P.astype(np.float32)
    nz = ~(P == 0).all(-1)
    mean = np.stack([p[k].mean(0) if k.any() else np.zeros(P.shape[-1], np.float32) for p, k in zip(P, nz)])
    return np.concatenate([mean, P.max(1)], 1)


def tune_thresholds(Y, probs, w):
    grid = np.linspace(0.05, 0.95, 19)
    return np.array([grid[np.argmax([weighted_f1(Y[:, c], probs[:, c], w, t) for t in grid])] for c in range(Y.shape[1])])


def macro_f1(Y, pred_bin, groups):
    w = artist_eval_weights(groups)
    return float(np.mean([weighted_f1(Y[:, c], pred_bin[:, c].astype(np.float32), w, 0.5) for c in range(Y.shape[1])]))



def boot_macro_f1(Y, pred_bin, groups, n_boot=500, seed=13):
    """Artist-bootstrap 5/50/95 of the artist-balanced macro-F1 of hard decisions."""
    rng = np.random.default_rng(seed)
    uniq, inv = np.unique(groups, return_inverse=True)
    by = [np.where(inv == a)[0] for a in range(len(uniq))]
    vals = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(uniq), len(uniq))
        idx = np.concatenate([by[a] for a in pick])
        g = np.concatenate([np.full(len(by[a]), i) for i, a in enumerate(pick)])
        vals.append(macro_f1(Y[idx], pred_bin[idx], g))
    return [float(x) for x in np.percentile(vals, [5, 50, 95])]


def ci(bs, c, m):
    """[lo, hi] from bootstrap_artists output for class c, metric m (0 F1, 1 AP, 2 AUROC)."""
    return [round(float(bs[c, m, 0]), 3), round(float(bs[c, m, 2]), 3)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--held-out", default=os.path.join(HERE, "artifacts", "held_out_artists_2026-09-07.json"))
    ap.add_argument("--escalation-bar", type=float, default=0.45)
    ap.add_argument("--per-artist-cap", type=int, default=40)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--n-boot", type=int, default=500)
    ap.add_argument("--device", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "two_stage_tiles.json"))
    args = ap.parse_args()
    import torch
    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    t0 = time.time()

    held = json.load(open(args.held_out))
    labels = list(held["labels"])
    test_artists, val_artists = set(held["test_artists"]), set(held["val_artists"])
    d = load(args.shards, args.manifest, labels)          # Y over the 21 old labels
    X = pooled(d["P"])
    Y, groups, inst = d["Y"], d["groups"], d["inst"]
    has_label = Y.sum(1) > 0
    X, Y, groups, inst = X[has_label], Y[has_label], groups[has_label], inst[has_label]
    families = sorted(set(FAMILY[l] for l in labels))
    Yf = np.zeros((len(Y), len(families)), np.float32)
    for i, l in enumerate(labels):
        Yf[Y[:, i] > 0, families.index(FAMILY[l])] = 1.0

    fold = np.where(np.isin(groups, list(test_artists)), 2, np.where(np.isin(groups, list(val_artists)), 1, 0))
    train_mask, val_mask, test_mask = fold == 0, fold == 1, fold == 2
    if args.per_artist_cap > 0:
        train_mask = train_mask & cap_per_artist(Y, groups, fold, cap=args.per_artist_cap, seed=args.seed)
    val_tune, val_gate = split_validation_by_artist(groups, val_mask, seed=args.seed)
    print(f"{len(Y):,} labelled images · {len(labels)} techniques · {len(families)} families · "
          f"train {int(train_mask.sum())} ({len(set(groups[train_mask]))} artists) · val {int(val_mask.sum())} · "
          f"test {int(test_mask.sum())} ({len(set(groups[test_mask]))} of the 2026-09-07 test artists)")
    mu, sd = X[train_mask].mean(0), X[train_mask].std(0) + 1e-6
    Z = ((X - mu) / sd).astype(np.float32)
    wtr = artist_eval_weights(groups[train_mask]).astype(np.float32)
    results = {"n_images": int(len(Y)), "n_test": int(test_mask.sum()), "n_test_artists": len(set(groups[test_mask])),
               "labels": labels, "families": families, "class_by_institution": {}}
    for c, l in enumerate(labels):
        results["class_by_institution"][l] = {i: int(((inst == i) & (Y[:, c] == 1)).sum()) for i in sorted(set(inst.tolist()))}

    # ---------------------------------------------------------------- Stage A: family
    print("\nStage A — process family")
    pred_f = fit("pooled", Z[train_mask], None, None, Yf[train_mask], wtr, Z.shape[1], args.epochs, args.seed, device)
    pf_val, pf_gate, pf_test = pred_f(Z[val_tune]), pred_f(Z[val_gate]), pred_f(Z[test_mask])
    thr_f = tune_thresholds(Yf[val_tune], pf_val, artist_eval_weights(groups[val_tune]))
    fam_bin = (pf_test >= thr_f)
    wte = artist_eval_weights(groups[test_mask])
    fam = {}
    for fi, f in enumerate(families):
        fam[f] = {"F1": float(weighted_f1(Yf[test_mask, fi], pf_test[:, fi], wte, thr_f[fi])),
                  "AP": weighted_ap(Yf[test_mask, fi], pf_test[:, fi], wte),
                  "AUROC": weighted_auroc(Yf[test_mask, fi], pf_test[:, fi], wte), "n_test": int(Yf[test_mask, fi].sum())}
        print(f"  {f:<13} n={fam[f]['n_test']:5d}  F1 {fam[f]['F1']:.3f}  AP {fam[f]['AP']:.3f}  AUROC {fam[f]['AUROC']:.3f}")
    fam_macro = float(np.mean([v["F1"] for v in fam.values()]))
    bs_f = bootstrap_artists(Yf[test_mask], pf_test, groups[test_mask], thr_f, args.n_boot, args.seed)
    for fi, f in enumerate(families):
        fam[f]["F1_ci"], fam[f]["AP_ci"], fam[f]["AUROC_ci"] = ci(bs_f, fi, 0), ci(bs_f, fi, 1), ci(bs_f, fi, 2)
        print(f"    {f:<13} F1 [{fam[f]['F1_ci'][0]:.2f}–{fam[f]['F1_ci'][1]:.2f}]  AUROC [{fam[f]['AUROC_ci'][0]:.2f}–{fam[f]['AUROC_ci'][1]:.2f}]")
    fam_macro_ci = boot_macro_f1(Yf[test_mask], fam_bin, groups[test_mask], args.n_boot, args.seed)
    print(f"  artist-balanced family macro-F1 {fam_macro:.4f}  bootstrap 5–95% [{fam_macro_ci[0]:.3f}–{fam_macro_ci[2]:.3f}]   (2026-09-07 stored-embedding model: 0.558)")
    results["stage_a"] = {"per_family": fam, "macro_f1": fam_macro, "macro_f1_ci_5_50_95": fam_macro_ci}

    # ---------------------------------------------------------------- Stage B: specialists + gate
    print("\nStage B — process within family (gate: bootstrap-20th-percentile within-family F1 ≥ "
          f"{args.escalation_bar} on validation artists never used for tuning)")
    tech = {}
    two_stage_pred = np.zeros_like(Y, dtype=bool)
    for fi, f in enumerate(families):
        cols = [i for i, l in enumerate(labels) if FAMILY[l] == f]
        in_f = Yf[:, fi] > 0
        sub_tr, sub_tune, sub_gate, sub_te = train_mask & in_f, val_tune & in_f, val_gate & in_f, test_mask & in_f
        if len(cols) == 1:
            c = cols[0]
            rows = np.nonzero(val_gate)[0]
            point, lower = gate_score(Yf[rows][:, fi], (pf_gate[:, fi] >= thr_f[fi]).astype(np.float32), groups[rows], seed=args.seed)
            emitted = lower >= args.escalation_bar
            if emitted:
                two_stage_pred[:, c] = False
                two_stage_pred[test_mask, c] = fam_bin[:, fi]
            tech[labels[c]] = {"family": f, "gate_point": round(point, 4), "gate_lower": round(lower, 4), "emitted": bool(emitted),
                               "within_family_F1_test": None}
            print(f"  {f:<13} {labels[c]:<26} via Stage A — gate {lower:.2f} ({'emitted' if emitted else 'family only'})")
            continue
        usable = [c for c in cols if Y[sub_tr][:, c].sum() >= MIN_SPECIALIST_POSITIVES]
        if len(usable) < 2 or sub_tr.sum() < 100 or sub_tune.sum() < 30 or sub_gate.sum() < 30:
            for c in cols:
                tech[labels[c]] = {"family": f, "emitted": False, "reason": "too few images to train a specialist"}
            print(f"  {f:<13} too few trainable techniques — family only")
            continue
        Ys = Y[:, usable]
        pred_s = fit("pooled", Z[sub_tr], None, None, Ys[sub_tr], artist_eval_weights(groups[sub_tr]).astype(np.float32),
                     Z.shape[1], args.epochs, args.seed, device)
        ps_tune, ps_gate, ps_te = pred_s(Z[sub_tune]), pred_s(Z[sub_gate]), pred_s(Z[sub_te])
        thr_s = tune_thresholds(Ys[sub_tune], ps_tune, artist_eval_weights(groups[sub_tune]))
        wsg, wst = artist_eval_weights(groups[sub_gate]), artist_eval_weights(groups[sub_te])
        bs_s = bootstrap_artists(Ys[sub_te], ps_te, groups[sub_te], thr_s, args.n_boot, args.seed) if sub_te.sum() >= 20 else None
        for k, c in enumerate(usable):
            point, lower = gate_score(Ys[sub_gate][:, k], (ps_gate[:, k] >= thr_s[k]).astype(np.float32), groups[sub_gate], seed=args.seed)
            emitted = lower >= args.escalation_bar
            f1_te = float(weighted_f1(Ys[sub_te][:, k], ps_te[:, k], wst, thr_s[k]))
            auc_te = weighted_auroc(Ys[sub_te][:, k], ps_te[:, k], wst)
            tech[labels[c]] = {"family": f, "gate_point": round(point, 4), "gate_lower": round(lower, 4), "emitted": bool(emitted),
                               "within_family_F1_test": round(f1_te, 4), "within_family_AUROC_test": round(auc_te, 4),
                               "n_test_in_family": int(Ys[sub_te][:, k].sum()),
                               "F1_ci": ci(bs_s, k, 0) if bs_s is not None else None,
                               "AUROC_ci": ci(bs_s, k, 2) if bs_s is not None else None}
            if emitted:
                # two-stage decision on the whole test set: family said yes AND specialist said yes
                te_rows = np.nonzero(test_mask)[0]
                fam_yes = fam_bin[:, fi]
                spec = np.zeros(len(te_rows), bool)
                spec_idx = np.nonzero(sub_te[test_mask])[0]
                spec[spec_idx] = ps_te[:, k] >= thr_s[k]
                two_stage_pred[te_rows, c] = fam_yes & spec
            t = tech[labels[c]]
            print(f"  {f:<13} {labels[c]:<26} gate {lower:.2f} ({'emitted' if emitted else 'family only'})  "
                  f"within-family test F1 {f1_te:.3f} {t['F1_ci'] or ''} AUROC {auc_te:.3f} {t['AUROC_ci'] or ''} (n={int(Ys[sub_te][:, k].sum())})")
        for c in set(cols) - set(usable):
            tech[labels[c]] = {"family": f, "emitted": False, "reason": f"< {MIN_SPECIALIST_POSITIVES} training positives"}
    flat_two_stage = macro_f1(Y[test_mask], two_stage_pred[test_mask], groups[test_mask])
    flat_two_stage_ci = boot_macro_f1(Y[test_mask], two_stage_pred[test_mask], groups[test_mask], args.n_boot, args.seed)
    emitted = [l for l, v in tech.items() if v.get("emitted")]
    print(f"\n  emitted techniques ({len(emitted)}/{len(labels)}): {emitted}")
    print(f"  flat 21-way artist-balanced macro-F1 of the two-stage decisions (non-emitted = never predicted): {flat_two_stage:.4f} [{flat_two_stage_ci[0]:.3f}–{flat_two_stage_ci[2]:.3f}]")

    # ---------------------------------------------------------------- flat 21-way head, for the 0.275 comparison
    pred_flat = fit("pooled", Z[train_mask], None, None, Y[train_mask], wtr, Z.shape[1], args.epochs, args.seed, device)
    thr_flat = tune_thresholds(Y[val_mask], pred_flat(Z[val_mask]), artist_eval_weights(groups[val_mask]))
    pt = pred_flat(Z[test_mask])
    per = {l: float(weighted_f1(Y[test_mask, c], pt[:, c], wte, thr_flat[c])) for c, l in enumerate(labels)}
    flat_macro = float(np.mean(list(per.values())))
    flat_macro_ci = boot_macro_f1(Y[test_mask], pt >= thr_flat, groups[test_mask], args.n_boot, args.seed)
    print(f"  flat 21-way head, artist-balanced macro-F1 {flat_macro:.4f}  bootstrap 5–95% [{flat_macro_ci[0]:.3f}–{flat_macro_ci[2]:.3f}]   (2026-09-07 stored-embedding model: 0.275)")
    print("  " + "  ".join(f"{l[:12]} {v:.2f}" for l, v in sorted(per.items(), key=lambda kv: -kv[1])))
    results.update({"stage_b": tech, "emitted": emitted, "flat_macro_f1_two_stage": flat_two_stage,
                    "flat_macro_f1_two_stage_ci_5_50_95": flat_two_stage_ci,
                    "flat_head": {"macro_f1": flat_macro, "macro_f1_ci_5_50_95": flat_macro_ci, "per_technique_f1": per},
                    "n_boot": args.n_boot, "elapsed_s": round(time.time() - t0)})
    json.dump(results, open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
