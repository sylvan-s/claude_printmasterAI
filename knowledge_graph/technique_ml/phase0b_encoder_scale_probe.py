"""
PrintMasterAI — ADR-0019 Phase 0b: which encoder, which pooling, and does a finer tile
scale read the burr?
Version: TECHML-PHASE0B-1.0

Runs on the Phase 0 sample and image cache (same 899 images, same artist-grouped folds) so
the numbers are directly comparable to phase0_results.json. For each encoder it extracts,
per image:

  primary scale   16 tiles of 224 px at ~5.6 px/mm (40 mm per tile)   — every image
  fine scale      16 tiles of 224 px at ~11.2 px/mm (20 mm per tile)  — only where the
                  native image already has >= 11.2 px/mm; never upsampled

and per tile keeps the CLS token, the mean of the patch tokens and the max of the patch
tokens (orderless pooling — texture is local; the CLS token encodes layout).

Feature sets evaluated per encoder, 5-fold artist-grouped CV:
  CLS         mean ⊕ max over tiles of CLS                (= Phase 0's F2 for that encoder)
  PATCH       mean ⊕ max over tiles of per-tile patch-mean
  CLS+PATCH   both
  CLS+FINE    CLS ⊕ fine-scale CLS (zeros + absent flag where the image has no fine scale)
  FINE        fine-scale CLS alone, scored on the fine-scale subset only

CLS and CLS+FINE are also reported per native-px/mm bucket (2–4, 4–7, 7–11, >11). A
monotone rise of drypoint F1 with px/mm means the burr halo is being read; a flat curve
means the model reads macro cues.

Encoders: dinov2 (facebook/dinov2-large), dinov2reg (facebook/dinov2-with-registers-large),
dinov3 (facebook/dinov3-vitl16-pretrain-lvd1689m — gated; skipped with a message unless the
HF token has access). Register tokens are stripped before patch pooling.

Usage (from repo root, .env sourced):
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/phase0b_encoder_scale_probe.py \
        --cache-dir /path/to/phase0/cache --encoders dinov2,dinov2reg,dinov3
Per-encoder tile features are cached as features_0b_<encoder>.npz; a re-run skips them.
"""

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import artist_eval_weights  # noqa: E402
from phase0_resolution_probe import (  # noqa: E402
    CENTRAL_FRACTION, CLASSES, GRID, TILE_PX, class_label, fit_head, group_kfold,
    parse_sheet_mm, weighted_ap, weighted_f1,
)

ENCODERS = {
    "dinov2": "facebook/dinov2-large",
    "dinov2reg": "facebook/dinov2-with-registers-large",
    "dinov3": "facebook/dinov3-vitl16-pretrain-lvd1689m",
}
PRIMARY_TILE_MM = 40.0
FINE_TILE_MM = 20.0
PRIMARY_PX_PER_MM = TILE_PX / PRIMARY_TILE_MM   # 5.6
FINE_PX_PER_MM = TILE_PX / FINE_TILE_MM         # 11.2
N_TILES = GRID * GRID
BUCKETS = [(2, 4), (4, 7), (7, 11), (11, 1e9)]


# ---------------------------------------------------------------------------
# tiles
# ---------------------------------------------------------------------------

def native_px_per_mm(im_size, sheet_mm):
    return max(im_size) / max(sheet_mm)   # sheet assumed to span the long axis (as Phase 0)


def tiles_fit(im_size, sheet_mm, target_px_per_mm):
    """Arithmetic twin of tiles_at: would GRID x GRID tiles fit after resampling? No decode."""
    native = native_px_per_mm(im_size, sheet_mm)
    if native < target_px_per_mm:
        return False
    scale = target_px_per_mm / native
    W, H = max(1, int(im_size[0] * scale)), max(1, int(im_size[1] * scale))
    cw, ch = int(W * CENTRAL_FRACTION), int(H * CENTRAL_FRACTION)
    x0, y0 = (W - cw) // 2, (H - ch) // 2
    first_x, first_y = x0 + int(0.5 * cw / GRID), y0 + int(0.5 * ch / GRID)
    last_x, last_y = x0 + int((GRID - 0.5) * cw / GRID), y0 + int((GRID - 0.5) * ch / GRID)
    return (first_x - TILE_PX // 2 >= 0 and first_y - TILE_PX // 2 >= 0
            and last_x + TILE_PX // 2 <= W and last_y + TILE_PX // 2 <= H)


def tiles_at(im, sheet_mm, target_px_per_mm):
    """GRID x GRID central tiles with the image resampled to target px/mm. None if the native
    image is coarser than the target (never upsample) or the central region is too small."""
    from PIL import Image
    native = native_px_per_mm(im.size, sheet_mm)
    if native < target_px_per_mm:
        return None
    scale = target_px_per_mm / native
    W, H = im.size
    im = im.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    W, H = im.size
    cw, ch = int(W * CENTRAL_FRACTION), int(H * CENTRAL_FRACTION)
    x0, y0 = (W - cw) // 2, (H - ch) // 2
    tiles = []
    for gy in range(GRID):
        for gx in range(GRID):
            cx = x0 + int((gx + 0.5) * cw / GRID)
            cy = y0 + int((gy + 0.5) * ch / GRID)
            box = (cx - TILE_PX // 2, cy - TILE_PX // 2, cx + TILE_PX // 2, cy + TILE_PX // 2)
            if box[0] < 0 or box[1] < 0 or box[2] > W or box[3] > H:
                return None
            tiles.append(np.asarray(im.crop(box)))
    return tiles


# ---------------------------------------------------------------------------
# encoders
# ---------------------------------------------------------------------------

def load_encoder(key, device):
    import torch
    from transformers import AutoImageProcessor, AutoModel
    name = ENCODERS[key]
    proc = AutoImageProcessor.from_pretrained(name)
    model = AutoModel.from_pretrained(name).to(device).eval()
    n_reg = int(getattr(model.config, "num_register_tokens", 0) or 0)
    mean = torch.tensor(proc.image_mean).view(1, 3, 1, 1).to(device)
    std = torch.tensor(proc.image_std).view(1, 3, 1, 1).to(device)
    return {"model": model, "mean": mean, "std": std, "n_reg": n_reg, "name": name}


def encode_tiles(enc, tiles, device):
    """-> (cls [n,D], patch_mean [n,D], patch_max [n,D]) float32."""
    import torch
    x = torch.from_numpy(np.stack(tiles)).permute(0, 3, 1, 2).float().div(255).to(device)
    x = (x - enc["mean"]) / enc["std"]
    with torch.no_grad():
        h = enc["model"](pixel_values=x).last_hidden_state
    cls = h[:, 0, :]
    patches = h[:, 1 + enc["n_reg"]:, :]
    return (cls.float().cpu().numpy(), patches.mean(1).float().cpu().numpy(),
            patches.max(1).values.float().cpu().numpy())


def stage_features(cache_dir, sample, keys, device):
    from PIL import Image
    out_paths = {k: os.path.join(cache_dir, f"features_0b_{k}.npz") for k in keys}
    todo = [k for k in keys if not os.path.exists(out_paths[k])]
    meta_path = os.path.join(cache_dir, "features_0b_meta.json")
    if not todo and os.path.exists(meta_path):
        return {k: np.load(p) for k, p in out_paths.items()}, json.load(open(meta_path))

    encs = {}
    for k in todo:
        try:
            encs[k] = load_encoder(k, device)
            print(f"  loaded {k} ({encs[k]['name']}, registers={encs[k]['n_reg']})")
        except Exception as e:
            print(f"  SKIP {k}: {type(e).__name__}: {str(e)[:120]}")
    keys_run = list(encs)
    if not keys_run:
        raise SystemExit("no encoders available")

    N, D = len(sample), 1024
    store = {k: {s: {p: np.zeros((N, N_TILES, D), np.float16) for p in ("cls", "pmean", "pmax")}
                 for s in ("primary", "fine")} for k in keys_run}
    has_fine = np.zeros(N, bool)
    meta = []
    t0 = time.time()
    for i, r in enumerate(sample):
        im = Image.open(r["path"]).convert("RGB")
        sheet = parse_sheet_mm(r["sheet"])
        native = native_px_per_mm(im.size, sheet)
        prim = tiles_at(im, sheet, PRIMARY_PX_PER_MM)
        if prim is None:
            prim = tiles_at(im, sheet, min(native, PRIMARY_PX_PER_MM))  # coarser natives: use as-is
        fine = tiles_at(im, sheet, FINE_PX_PER_MM)
        has_fine[i] = fine is not None
        for k, enc in encs.items():
            for s, tiles in (("primary", prim), ("fine", fine)):
                if tiles is None:
                    continue
                c, pm, px = encode_tiles(enc, tiles, device)
                store[k][s]["cls"][i], store[k][s]["pmean"][i], store[k][s]["pmax"][i] = c, pm, px
        meta.append({"imageId": r["imageId"], "artistId": r["artistId"], "bucket": r["bucket"],
                     "techs": r["techs"], "nativePxPerMm": float(native), "hasFine": bool(has_fine[i])})
        if (i + 1) % 25 == 0:
            print(f"  features {i + 1}/{N}  fine so far {int(has_fine[:i + 1].sum())}  ({time.time() - t0:.0f}s)", flush=True)

    for k in keys_run:
        np.savez(out_paths[k], **{f"{s}_{p}": store[k][s][p] for s in store[k] for p in store[k][s]},
                 has_fine=has_fine)
    json.dump(meta, open(meta_path, "w"))
    return {k: np.load(p) for k, p in out_paths.items() if os.path.exists(p)}, meta


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

def pool(tiles3d):
    """[N, T, D] -> [N, 2D] mean ⊕ max over tiles."""
    x = tiles3d.astype(np.float32)
    return np.concatenate([x.mean(1), x.max(1)], axis=1)


def cv_oof(X, Y, groups, folds, k, seed):
    oof = np.zeros_like(Y)
    thr_used = np.zeros((k, Y.shape[1]))
    for f in range(k):
        tr, te = folds != f, folds == f
        tr_groups = groups[tr]
        val_artists = set(sorted(set(tr_groups))[::6])
        fit = tr.copy(); fit[tr] = ~np.isin(tr_groups, list(val_artists))
        val = tr.copy(); val[tr] = np.isin(tr_groups, list(val_artists))
        mu, sd = X[fit].mean(0), X[fit].std(0) + 1e-6
        Z = (X - mu) / sd
        predict = fit_head(Z[fit], Y[fit], artist_eval_weights(groups[fit]).astype(np.float32), seed=seed + f)
        pv, wv = predict(Z[val]), artist_eval_weights(groups[val])
        for c in range(Y.shape[1]):
            grid = np.linspace(0.05, 0.95, 19)
            thr_used[f, c] = grid[np.argmax([weighted_f1(Y[val, c], pv[:, c], wv, t) for t in grid])]
        oof[te] = predict(Z[te])
    return oof, np.median(thr_used, axis=0)


def score(Y, oof, thr, groups, mask=None):
    if mask is None:
        mask = np.ones(len(Y), bool)
    w = artist_eval_weights(groups[mask])
    res = {}
    for c, cname in enumerate(CLASSES):
        res[cname] = {"F1": float(weighted_f1(Y[mask, c], oof[mask, c], w, thr[c])),
                      "AP": weighted_ap(Y[mask, c], oof[mask, c], w),
                      "n": int(mask.sum()), "pos": int(Y[mask, c].sum())}
    return res


def fmt(res):
    return "  ".join(f"{c[:3]} F1={r['F1']:.3f} AP={r['AP']:.3f}" for c, r in res.items())


def stage_eval(feats, meta, k, seed, out_path):
    Y = np.array([class_label(m["techs"]) for m in meta], dtype=np.float32)
    groups = np.array([m["artistId"] for m in meta])
    native = np.array([m["nativePxPerMm"] for m in meta])
    has_fine = np.array([m["hasFine"] for m in meta])
    folds = group_kfold(groups, k, seed)
    print(f"  {len(meta)} images, {len(set(groups))} artists, fine-scale subset {int(has_fine.sum())}")
    print("  native px/mm buckets: " + ", ".join(f"[{lo},{hi if hi < 1e8 else 'inf'}) n={int(((native >= lo) & (native < hi)).sum())}" for lo, hi in BUCKETS))

    results = {"n_images": len(meta), "n_fine": int(has_fine.sum()), "encoders": {}}
    for key, F in feats.items():
        prim_cls, prim_pm = pool(F["primary_cls"]), pool(F["primary_pmean"])
        fine_cls = pool(F["fine_cls"]) * has_fine[:, None]
        sets = {
            "CLS": prim_cls,
            "PATCH": prim_pm,
            "CLS+PATCH": np.concatenate([prim_cls, prim_pm], 1),
            "CLS+FINE": np.concatenate([prim_cls, fine_cls, has_fine[:, None].astype(np.float32)], 1),
        }
        enc_res = {}
        print(f"  [{key}]")
        for name, X in sets.items():
            oof, thr = cv_oof(X, Y, groups, folds, k, seed)
            enc_res[name] = score(Y, oof, thr, groups)
            print(f"    {name:10s} " + fmt(enc_res[name]))
            if name in ("CLS", "CLS+FINE"):
                enc_res[name]["by_bucket"] = {}
                for lo, hi in BUCKETS:
                    m = (native >= lo) & (native < hi)
                    if m.sum() >= 20 and Y[m].sum(0).min() >= 5:
                        b = score(Y, oof, thr, groups, m)
                        enc_res[name]["by_bucket"][f"{lo}-{hi if hi < 1e8 else 'inf'}"] = b
                        print(f"      px/mm [{lo},{hi if hi < 1e8 else 'inf'}) n={int(m.sum()):3d}  " + fmt(b))
        # FINE alone, on the fine subset only (its own folds over the subset's artists)
        if has_fine.sum() >= 60:
            sub = has_fine
            oof, thr = cv_oof(fine_cls[sub], Y[sub], groups[sub], group_kfold(groups[sub], k, seed), k, seed)
            enc_res["FINE(subset)"] = score(Y[sub], oof, thr, groups[sub])
            oof2, thr2 = cv_oof(prim_cls[sub], Y[sub], groups[sub], group_kfold(groups[sub], k, seed), k, seed)
            enc_res["CLS(subset)"] = score(Y[sub], oof2, thr2, groups[sub])
            print(f"    {'FINE(sub)':10s} " + fmt(enc_res["FINE(subset)"]) + f"   n={int(sub.sum())}")
            print(f"    {'CLS(sub)':10s} " + fmt(enc_res["CLS(subset)"]) + "   (same subset, primary scale)")
        results["encoders"][key] = enc_res
    json.dump(results, open(out_path, "w"), indent=2)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", required=True, help="the Phase 0 cache dir (sample.json + images/)")
    ap.add_argument("--encoders", default="dinov2,dinov2reg,dinov3")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    import torch
    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    sample = json.load(open(os.path.join(args.cache_dir, "sample.json")))
    img_dir = os.path.join(args.cache_dir, "images")
    for r in sample:
        r["path"] = os.path.join(img_dir, r["imageId"].replace(":", "_"))
    sample = [r for r in sample if os.path.exists(r["path"]) and os.path.getsize(r["path"]) > 0
              and parse_sheet_mm(r["sheet"]) is not None]
    # Drop the images Phase 0 dropped (too small for a primary tile) so folds match.
    keep = []
    from PIL import Image
    for r in sample:
        with Image.open(r["path"]) as im:   # header only — no decode
            sheet = parse_sheet_mm(r["sheet"])
            if tiles_fit(im.size, sheet, min(native_px_per_mm(im.size, sheet), PRIMARY_PX_PER_MM)):
                keep.append(r)
    sample = keep
    keys = [k.strip() for k in args.encoders.split(",") if k.strip() in ENCODERS]
    print(f"[1/2] features for {len(sample)} images, encoders {keys}, device {device}")
    feats, meta = stage_features(args.cache_dir, sample, keys, device)
    print(f"[2/2] {args.folds}-fold artist-grouped CV")
    stage_eval(feats, meta, args.folds, args.seed,
               os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts", "phase0b_results.json"))


if __name__ == "__main__":
    main()
