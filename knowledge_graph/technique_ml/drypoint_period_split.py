"""
PrintMasterAI — ADR-0019 Phase 4: drypoint by period and by label type.
Version: TECHML-DRYPOINT-PERIOD-1.0

The research note predicts an irreducible drypoint error before steel-facing (1857): burr
wears off in a dozen to thirty impressions, so a pre-1860 "drypoint" impression may carry no
burr at all, while post-1860 editions keep it. And most auction drypoint labels are accents on
etchings. This scores the hierarchical drypoint head (etching-only vs etching+drypoint, tile
features, artist-grouped 5-fold) on its out-of-fold predictions split by
ConceptualWork.dateCreated_year (< 1860 / >= 1860 / undated) and by label type (pure drypoint /
etching+drypoint), with artist bootstraps; then trains on post-1860 works only to see whether
the pre-1860 lots were hurting.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/drypoint_period_split.py \
        --shards knowledge_graph/technique_ml/data/tiles_full --manifest knowledge_graph/technique_ml/data/phase2_full.jsonl \
        --years knowledge_graph/technique_ml/data/work_years.json
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import artist_eval_weights  # noqa: E402
from phase0_resolution_probe import group_kfold, weighted_ap, weighted_f1  # noqa: E402
from train_tile_head import bootstrap_artists, fit, load, weighted_auroc  # noqa: E402
from train_two_stage_tiles import pooled  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def cv_oof(X, Y, groups, k, seed, device, train_mask=None):
    folds = group_kfold(groups, k, seed)
    oof = np.full_like(Y, np.nan)
    thr_used = []
    for f in range(k):
        tr, te = folds != f, folds == f
        if train_mask is not None:
            tr = tr & train_mask
        trg = groups[tr]
        val_artists = set(sorted(set(trg))[::6])
        fit_m = tr.copy(); fit_m[tr] = ~np.isin(trg, list(val_artists))
        val_m = tr.copy(); val_m[tr] = np.isin(trg, list(val_artists))
        mu, sd = X[fit_m].mean(0), X[fit_m].std(0) + 1e-6
        Z = ((X - mu) / sd).astype(np.float32)
        pred = fit("pooled", Z[fit_m], None, None, Y[fit_m], artist_eval_weights(groups[fit_m]).astype(np.float32), Z.shape[1], 40, seed + f, device)
        pv, wv = pred(Z[val_m]), artist_eval_weights(groups[val_m])
        grid = np.linspace(0.05, 0.95, 19)
        thr_used.append(grid[np.argmax([weighted_f1(Y[val_m, 0], pv[:, 0], wv, t) for t in grid])])
        oof[te] = pred(Z[te])
    return oof, float(np.median(thr_used))


def score(Y, oof, groups, thr, mask, n_boot, seed):
    m = mask & np.isfinite(oof[:, 0])
    if m.sum() < 20 or Y[m, 0].sum() < 5 or (Y[m, 0] == 0).sum() < 5:
        return None
    w = artist_eval_weights(groups[m])
    bs = bootstrap_artists(Y[m], oof[m], groups[m], np.array([thr]), n_boot, seed)
    return {"n": int(m.sum()), "pos": int(Y[m, 0].sum()), "artists": len(set(groups[m])),
            "F1": float(weighted_f1(Y[m, 0], oof[m, 0], w, thr)), "F1_ci": [float(bs[0, 0, 0]), float(bs[0, 0, 2])],
            "AP": weighted_ap(Y[m, 0], oof[m, 0], w),
            "AUROC": weighted_auroc(Y[m, 0], oof[m, 0], w), "AUROC_ci": [float(bs[0, 2, 0]), float(bs[0, 2, 2])]}


def fmt(name, r):
    if r is None:
        return f"  {name:34s} (too few)"
    return (f"  {name:34s} n={r['n']:5d} pos={r['pos']:4d} artists={r['artists']:4d}  F1 {r['F1']:.3f} [{r['F1_ci'][0]:.2f}–{r['F1_ci'][1]:.2f}]  "
            f"AUROC {r['AUROC']:.3f} [{r['AUROC_ci'][0]:.2f}–{r['AUROC_ci'][1]:.2f}]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--years", required=True)
    ap.add_argument("--n-boot", type=int, default=500)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "drypoint_period_split.json"))
    args = ap.parse_args()
    import torch
    device = "mps" if torch.backends.mps.is_available() else "cpu"

    d = load(args.shards, args.manifest, ["Drypoint"], restrict=["Etching", "Drypoint"])
    rows = {json.loads(l)["imageId"]: json.loads(l) for l in open(args.manifest)}
    years = json.load(open(args.years))
    X, Y, groups = pooled(d["P"]), d["Y"], d["groups"]
    yr = np.array([years.get(rows[i]["workId"], {}).get("year", -1) for i in d["ids"]])
    pure = np.array([set(rows[i]["techniques"]) == {"Drypoint"} for i in d["ids"]])
    combined = np.array([set(rows[i]["techniques"]) == {"Etching", "Drypoint"} for i in d["ids"]])
    neg = Y[:, 0] == 0
    pre, post, undated = (yr >= 0) & (yr < 1860), yr >= 1860, yr < 0
    print(f"{len(Y)} etching/drypoint images, {len(set(groups))} artists; drypoint positives {int(Y[:,0].sum())} "
          f"(pure {int(pure.sum())}, etching+drypoint {int(combined.sum())}); pre-1860 {int(pre.sum())}, post-1860 {int(post.sum())}, undated {int(undated.sum())}")

    out = {}
    print("\nTrained on all periods, scored out-of-fold by subset:")
    oof, thr = cv_oof(X, Y, groups, 5, args.seed, device)
    subsets = {"all": np.ones(len(Y), bool), "pre-1860": pre, "post-1860": post, "undated": undated,
               "pure drypoint vs etching-only": pure | neg, "etching+drypoint vs etching-only": combined | neg,
               "post-1860 pure vs etching-only": (pure | neg) & post, "post-1860 combined vs etching-only": (combined | neg) & post}
    out["train_all"] = {}
    for name, m in subsets.items():
        r = score(Y, oof, groups, thr, m, args.n_boot, args.seed)
        out["train_all"][name] = r
        print(fmt(name, r))

    print("\nTrained on post-1860 works only, scored out-of-fold on post-1860:")
    oof2, thr2 = cv_oof(X, Y, groups, 5, args.seed, device, train_mask=post)
    out["train_post_only"] = {}
    for name, m in {"post-1860": post, "post-1860 pure vs etching-only": (pure | neg) & post,
                    "post-1860 combined vs etching-only": (combined | neg) & post}.items():
        r = score(Y, oof2, groups, thr2, m, args.n_boot, args.seed)
        out["train_post_only"][name] = r
        print(fmt(name, r))
    json.dump(out, open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
