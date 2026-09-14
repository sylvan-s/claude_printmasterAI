"""
PrintMasterAI — ADR-0019 Phase 4 (pilot): technique heads over per-tile DINOv3 embeddings.
Version: TECHML-TILEHEAD-1.3

Trains and evaluates, on the Phase 2 shards + manifest, with the same artist-grouped protocol
the existing classifier uses (no artist in both train and test; artist-balanced metrics):

  POOLED    mean ⊕ max over the 16 primary tiles -> MLP            (the Phase 0/0b design)
  MIL       gated attention-MIL over per-tile vectors (Ilse et al. 2018), primary tiles only
  MIL+FINE  the same, with the fine-scale tiles added as extra instances carrying a learned
            scale embedding — the per-scale head ADR-0019 Phase 0b asked for instead of
            concatenation, which was flat because 78% of images have no fine scale

Labels are the manifest's technique lists restricted to --classes (multi-label; etching +
aquatint is a valid pair). Reports per class: artist-balanced F1 (threshold tuned on held-out
training artists) and AP, overall and per native-px/mm bucket, plus a source-institution
probe on the pooled features (must fall from the 0.907 the old features gave).

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/train_tile_head.py \
        --shards knowledge_graph/technique_ml/data/tiles_pilot \
        --manifest knowledge_graph/technique_ml/data/phase2_pilot_intaglio.jsonl \
        --classes Etching,Aquatint,Drypoint,Engraving
"""

import argparse
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import artist_eval_weights  # noqa: E402
from phase0_resolution_probe import group_kfold, weighted_ap, weighted_f1  # noqa: E402

BUCKETS = [(2, 4), (4, 7), (7, 11), (11, 1e9)]


# ---------------------------------------------------------------------------
# data
# ---------------------------------------------------------------------------

def load(shards_dir, manifest_path, classes, restrict=None):
    """restrict: keep only images whose technique set is a subset of this list — e.g.
    restrict=['Etching','Drypoint'] with classes=['Drypoint'] poses pure-etching vs
    etching+drypoint, the question the burr actually answers (ADR-0019 Phase 4 pilot)."""
    rows = {json.loads(l)["imageId"]: json.loads(l) for l in open(manifest_path)}
    if restrict:
        rows = {k: r for k, r in rows.items() if set(r["techniques"]) <= set(restrict)}
    P, F, HF, PS, FS, ids = [], [], [], [], [], []
    meta = {}
    for p in sorted(glob.glob(os.path.join(shards_dir, "tiles_*.npz"))):
        z = np.load(p)
        P.append(z["primary_cls"]); F.append(z["fine_cls"]); HF.append(z["has_fine"])
        PS.append(z["primary_strata"]); FS.append(z["fine_strata"]); ids.extend(z["image_ids"].tolist())
        for l in open(p.replace(".npz", ".meta.jsonl")):
            m = json.loads(l); meta[m["imageId"]] = m
    P, F, HF = np.concatenate(P), np.concatenate(F), np.concatenate(HF)
    PS, FS = np.concatenate(PS), np.concatenate(FS)
    keep = [i for i, iid in enumerate(ids) if iid in rows]
    ids = [ids[i] for i in keep]
    P, F, HF, PS, FS = P[keep], F[keep], HF[keep], PS[keep], FS[keep]
    Y = np.array([[1.0 if c in rows[i]["techniques"] else 0.0 for c in classes] for i in ids], np.float32)
    groups = np.array([rows[i]["artistId"] for i in ids])
    inst = np.array([rows[i]["institution"] or "?" for i in ids])
    native = np.array([meta[i]["nativePxPerMm"] for i in ids], np.float32)
    return {"ids": ids, "P": P, "F": F, "HF": HF, "PS": PS, "FS": FS, "Y": Y, "groups": groups,
            "inst": inst, "native": native}


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------

def make_pooled(d_in, n_out):
    import torch
    return torch.nn.Sequential(torch.nn.Linear(d_in, 256), torch.nn.GELU(), torch.nn.Dropout(0.3),
                               torch.nn.Linear(256, n_out))


class GatedMIL:
    """Gated attention pooling over a bag of tile vectors (+ optional scale embedding)."""

    def __init__(self, d_in, n_out, d_att=128, use_scale=False):
        import torch
        self.use_scale = use_scale
        self.embed = torch.nn.Sequential(torch.nn.Linear(d_in, 256), torch.nn.GELU(), torch.nn.Dropout(0.2))
        self.scale_emb = torch.nn.Embedding(2, 256) if use_scale else None
        self.att_v = torch.nn.Sequential(torch.nn.Linear(256, d_att), torch.nn.Tanh())
        self.att_u = torch.nn.Sequential(torch.nn.Linear(256, d_att), torch.nn.Sigmoid())
        self.att_w = torch.nn.Linear(d_att, 1)
        self.head = torch.nn.Linear(256, n_out)
        mods = [self.embed, self.att_v, self.att_u, self.att_w, self.head] + ([self.scale_emb] if use_scale else [])
        self.module = torch.nn.ModuleList(mods)

    def forward(self, X, mask, scale=None):
        """X [B,T,D], mask [B,T] bool, scale [B,T] long (0 primary / 1 fine)."""
        import torch
        h = self.embed(X)
        if self.use_scale:
            h = h + self.scale_emb(scale)
        a = self.att_w(self.att_v(h) * self.att_u(h)).squeeze(-1)
        a = a.masked_fill(~mask, -1e4)
        a = torch.softmax(a, dim=1)
        z = (a.unsqueeze(-1) * h).sum(1)
        return self.head(z), a


def fit(model_kind, Xtr, Mtr, Str, Ytr, wtr, d_in, epochs, seed, device, lr=5e-4):
    import torch
    torch.manual_seed(seed)
    n_out = Ytr.shape[1]
    if model_kind == "pooled":
        net = make_pooled(d_in, n_out).to(device)
        params = net.parameters()
    else:
        mil = GatedMIL(d_in, n_out, use_scale=(model_kind == "mil_fine"))
        net = mil.module.to(device)
        params = net.parameters()
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=1e-2)
    Yt = torch.from_numpy(Ytr).to(device)
    pos = Yt.mean(0).clamp(min=1e-3)
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=((1 - pos) / pos).clamp(max=10), reduction="none")
    wt = torch.from_numpy(wtr).to(device)
    Xt = torch.from_numpy(Xtr).to(device)
    Mt = torch.from_numpy(Mtr).to(device) if Mtr is not None else None
    St = torch.from_numpy(Str).to(device) if Str is not None else None
    n = len(Xtr)
    bs = 256
    net.train()
    rng = np.random.default_rng(seed)
    for ep in range(epochs):
        perm = torch.from_numpy(rng.permutation(n)).to(device)
        for i in range(0, n, bs):
            idx = perm[i:i + bs]
            opt.zero_grad()
            if model_kind == "pooled":
                logits = net(Xt[idx])
            else:
                logits, _ = mil.forward(Xt[idx], Mt[idx], St[idx] if St is not None else None)
            loss = (loss_fn(logits, Yt[idx]) * wt[idx][:, None]).mean()
            loss.backward()
            opt.step()
    net.eval()

    def predict(X, M=None, S=None):
        out = []
        with torch.no_grad():
            for i in range(0, len(X), 512):
                xb = torch.from_numpy(X[i:i + 512]).to(device)
                if model_kind == "pooled":
                    out.append(torch.sigmoid(net(xb)).cpu().numpy())
                else:
                    mb = torch.from_numpy(M[i:i + 512]).to(device)
                    sb = torch.from_numpy(S[i:i + 512]).to(device) if S is not None else None
                    out.append(torch.sigmoid(mil.forward(xb, mb, sb)[0]).cpu().numpy())
        return np.concatenate(out)
    return predict




def weighted_auroc(y, p, w):
    """Artist-weighted AUROC (weighted Mann-Whitney), prevalence-invariant — the right statistic
    for comparing runs with different class balances. Ties count half."""
    order = np.argsort(p, kind="mergesort")
    y, p, w = y[order], p[order], w[order]
    wp, wn = w * (y == 1), w * (y == 0)
    tot_p, tot_n = wp.sum(), wn.sum()
    if tot_p == 0 or tot_n == 0:
        return float("nan")
    # cumulative negative weight strictly below each score, plus half of ties
    cum_n = np.cumsum(wn)
    below = np.zeros_like(cum_n)
    i = 0
    n = len(p)
    while i < n:
        j = i
        while j + 1 < n and p[j + 1] == p[i]:
            j += 1
        before = cum_n[i - 1] if i > 0 else 0.0
        tie = cum_n[j] - before
        below[i:j + 1] = before + 0.5 * tie
        i = j + 1
    return float((wp * below).sum() / (tot_p * tot_n))


def fold_metrics(Y, oof, groups, folds, thr):
    """Per-fold artist-balanced F1/AP (each fold's held-out artists weighted within the fold)."""
    out = []
    for f in sorted(set(folds.tolist())):
        m = folds == f
        w = artist_eval_weights(groups[m])
        out.append([(float(weighted_f1(Y[m, c], oof[m, c], w, thr[c])), weighted_ap(Y[m, c], oof[m, c], w),
                     weighted_auroc(Y[m, c], oof[m, c], w)) for c in range(Y.shape[1])])
    return np.array(out)   # [folds, classes, 3]  (F1, AP, AUROC)


def bootstrap_artists(Y, oof, groups, thr, n_boot=1000, seed=0):
    """Resample ARTISTS with replacement over the out-of-fold predictions; -> [classes, 2, 3]
    (F1/AP x 5th percentile, median, 95th). Artists, not images, are the unit of replication."""
    rng = np.random.default_rng(seed)
    uniq, inv = np.unique(groups, return_inverse=True)
    by_artist = [np.where(inv == a)[0] for a in range(len(uniq))]
    stats = np.zeros((n_boot, Y.shape[1], 3))
    for b in range(n_boot):
        pick = rng.integers(0, len(uniq), len(uniq))
        idx = np.concatenate([by_artist[a] for a in pick])
        g = np.concatenate([np.full(len(by_artist[a]), i) for i, a in enumerate(pick)])
        w = artist_eval_weights(g)
        for c in range(Y.shape[1]):
            stats[b, c, 0] = weighted_f1(Y[idx, c], oof[idx, c], w, thr[c])
            stats[b, c, 1] = weighted_ap(Y[idx, c], oof[idx, c], w)
            stats[b, c, 2] = weighted_auroc(Y[idx, c], oof[idx, c], w)
    return np.percentile(stats, [5, 50, 95], axis=0).transpose(1, 2, 0)


def fmt_var(name, res, classes):
    parts = []
    for c, cname in enumerate(classes):
        fm, fs = res["fold_mean"][c], res["fold_sd"][c]
        ci = res["bootstrap_5_95"][c]
        parts.append(f"{cname[:4]} F1 {fm[0]:.3f}±{fs[0]:.3f} [{ci[0][0]:.2f}-{ci[0][1]:.2f}]  "
                     f"AP {fm[1]:.3f}±{fs[1]:.3f} [{ci[1][0]:.2f}-{ci[1][1]:.2f}]  "
                     f"AUROC {fm[2]:.3f}±{fs[2]:.3f} [{ci[2][0]:.2f}-{ci[2][1]:.2f}]")
    return f"    {name:9s} folds mean±sd [artist-bootstrap 5–95%]: " + " | ".join(parts)


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

def build_inputs(d, kind):
    """-> X, mask, scale for the given model kind."""
    P = d["P"].astype(np.float32)
    if kind == "pooled":
        return np.concatenate([P.mean(1), P.max(1)], 1), None, None
    pm = d["PS"] >= 0
    if kind == "mil":
        return P, pm, np.zeros(pm.shape, np.int64)
    F = d["F"].astype(np.float32)
    fm = (d["FS"] >= 0) & d["HF"][:, None]
    X = np.concatenate([P, F], 1)
    M = np.concatenate([pm, fm], 1)
    S = np.concatenate([np.zeros(pm.shape, np.int64), np.ones(fm.shape, np.int64)], 1)
    return X, M, S


def standardise(X, fit_mask):
    if X.ndim == 3:
        flat = X[fit_mask].reshape(-1, X.shape[-1])
        mu, sd = flat.mean(0), flat.std(0) + 1e-6
    else:
        mu, sd = X[fit_mask].mean(0), X[fit_mask].std(0) + 1e-6
    return ((X - mu) / sd).astype(np.float32)


def evaluate(d, classes, kinds, k, seed, epochs, device, out_path, lr=5e-4, args_n_boot=1000):
    Y, groups, native = d["Y"], d["groups"], d["native"]
    folds = group_kfold(groups, k, seed)
    n_cls = len(classes)
    results = {"n_images": len(Y), "n_artists": len(set(groups)), "n_fine": int(d["HF"].sum()),
               "positives": {c: int(Y[:, i].sum()) for i, c in enumerate(classes)}, "models": {}}
    print(f"{len(Y)} images, {len(set(groups))} artists, fine-scale {int(d['HF'].sum())}, positives {results['positives']}")
    # class x institution cross-tab: the confound check that the Phase 0 sample never had.
    insts = sorted(set(d["inst"].tolist()))
    print("  class x institution (positives per institution / negatives per institution):")
    xtab = {}
    for c, cname in enumerate(classes):
        row = {i: (int(((d["inst"] == i) & (Y[:, c] == 1)).sum()), int(((d["inst"] == i) & (Y[:, c] == 0)).sum())) for i in insts}
        xtab[cname] = row
        print(f"    {cname[:10]:10s} " + "  ".join(f"{i[:9]}:{p}/{n}" for i, (p, n) in row.items()))
    results["class_by_institution"] = xtab
    for kind in kinds:
        X, M, S = build_inputs(d, kind)
        oof = np.zeros_like(Y)
        thr_used = np.zeros((k, n_cls))
        t0 = time.time()
        for f in range(k):
            tr, te = folds != f, folds == f
            tr_groups = groups[tr]
            val_artists = set(sorted(set(tr_groups))[::6])
            fit_m = tr.copy(); fit_m[tr] = ~np.isin(tr_groups, list(val_artists))
            val_m = tr.copy(); val_m[tr] = np.isin(tr_groups, list(val_artists))
            Z = standardise(X, fit_m)
            predict = fit(kind, Z[fit_m], M[fit_m] if M is not None else None, S[fit_m] if S is not None else None,
                          Y[fit_m], artist_eval_weights(groups[fit_m]).astype(np.float32), Z.shape[-1], epochs, seed + f, device, lr)
            pv = predict(Z[val_m], M[val_m] if M is not None else None, S[val_m] if S is not None else None)
            wv = artist_eval_weights(groups[val_m])
            for c in range(n_cls):
                grid = np.linspace(0.05, 0.95, 19)
                thr_used[f, c] = grid[np.argmax([weighted_f1(Y[val_m, c], pv[:, c], wv, t) for t in grid])]
            oof[te] = predict(Z[te], M[te] if M is not None else None, S[te] if S is not None else None)
            print(f"  [{kind}] fold {f + 1}/{k} done ({time.time() - t0:.0f}s)", flush=True)
        thr = np.median(thr_used, axis=0)
        w = artist_eval_weights(groups)
        res = {"threshold": thr.tolist(), "classes": {}, "by_bucket": {}}
        for c, name in enumerate(classes):
            res["classes"][name] = {"F1": float(weighted_f1(Y[:, c], oof[:, c], w, thr[c])),
                                    "AP": weighted_ap(Y[:, c], oof[:, c], w)}
        print(f"  {kind:9s} " + "  ".join(f"{n[:4]} F1={r['F1']:.3f} AP={r['AP']:.3f}" for n, r in res["classes"].items()))
        fm = fold_metrics(Y, oof, groups, folds, thr)
        bs = bootstrap_artists(Y, oof, groups, thr, n_boot=args_n_boot, seed=seed)
        res["fold_mean"] = fm.mean(0).tolist(); res["fold_sd"] = fm.std(0, ddof=1).tolist()
        res["per_fold"] = fm.tolist()
        res["bootstrap_5_95"] = [[[float(bs[c, m, 0]), float(bs[c, m, 2])] for m in range(3)] for c in range(n_cls)]
        for c, cname in enumerate(classes):
            res["classes"][cname]["AUROC"] = weighted_auroc(Y[:, c], oof[:, c], w)
        print(fmt_var(kind, res, classes), flush=True)
        for lo, hi in BUCKETS:
            m = (native >= lo) & (native < hi)
            if m.sum() >= 30:
                wb = artist_eval_weights(groups[m])
                b = {name: {"F1": float(weighted_f1(Y[m, c], oof[m, c], wb, thr[c])), "AP": weighted_ap(Y[m, c], oof[m, c], wb)}
                     for c, name in enumerate(classes) if Y[m, c].sum() >= 5}
                res["by_bucket"][f"{lo}-{hi if hi < 1e8 else 'inf'}"] = {"n": int(m.sum()), **b}
                print(f"      px/mm [{lo},{hi if hi < 1e8 else 'inf'}) n={int(m.sum()):4d}  " +
                      "  ".join(f"{n[:4]} F1={r['F1']:.3f} AP={r['AP']:.3f}" for n, r in b.items()))
        results["models"][kind] = res

    # source-institution probe on the pooled primary features: can the features tell the photographer?
    Xp, _, _ = build_inputs(d, "pooled")
    inst = d["inst"]
    labels, inv = np.unique(inst, return_inverse=True)
    acc = []
    for f in range(k):
        tr, te = folds != f, folds == f
        Z = standardise(Xp, tr)
        import torch
        torch.manual_seed(seed + f)
        net = make_pooled(Z.shape[1], len(labels)).to(device)
        opt = torch.optim.AdamW(net.parameters(), lr=5e-4, weight_decay=1e-2)
        Xt, yt = torch.from_numpy(Z[tr]).to(device), torch.from_numpy(inv[tr]).to(device)
        for _ in range(epochs):
            opt.zero_grad(); loss = torch.nn.functional.cross_entropy(net(Xt), yt); loss.backward(); opt.step()
        with torch.no_grad():
            pred = net(torch.from_numpy(Z[te]).to(device)).argmax(1).cpu().numpy()
        acc.append(float((pred == inv[te]).mean()))
    majority = float(np.bincount(inv).max() / len(inv))
    results["source_probe"] = {"accuracy": float(np.mean(acc)), "majority_baseline": majority,
                               "institutions": {l: int((inv == i).sum()) for i, l in enumerate(labels)}}
    print(f"  source-institution probe: {np.mean(acc):.3f} (majority {majority:.3f}; old 224px features 0.907)")
    json.dump(results, open(out_path, "w"), indent=2)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--classes", default="Etching,Aquatint,Drypoint,Engraving")
    ap.add_argument("--models", default="pooled,mil,mil_fine")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--n-boot", type=int, default=1000)
    ap.add_argument("--restrict", help="comma-separated: keep only images whose techniques are all in this set")
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--device", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts", "tile_head_pilot.json"))
    args = ap.parse_args()
    import torch
    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    classes = [c.strip() for c in args.classes.split(",")]
    restrict = [c.strip() for c in args.restrict.split(",")] if args.restrict else None
    d = load(args.shards, args.manifest, classes, restrict)
    evaluate(d, classes, [m.strip() for m in args.models.split(",")], args.folds, args.seed, args.epochs, device, args.out, args.lr, args.n_boot)


if __name__ == "__main__":
    main()
