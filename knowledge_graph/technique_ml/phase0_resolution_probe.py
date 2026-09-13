"""
PrintMasterAI — ADR-0019 Phase 0: does native-resolution tiling recover intaglio grain?
Version: TECHML-PHASE0-1.0

The gate experiment for docs/adr/0019. Samples ~300 images each of Etching-only,
Aquatint (± etching) and Drypoint (± etching) from Bonhams + Roseberys, fetches them at
the best resolution the host serves, and compares four feature sets on the within-intaglio
task with an artist-grouped 5-fold CV:

  F0  stored 224px whole-image DINOv2-L CLS           (the existing classifier's input)
  F1  DINOv2-L at 518px whole-image CLS                (resolution alone)
  F2  224px tiles at a fixed physical scale, mean⊕max  (tiling + physical normalisation)
  F3  F2 ⊕ per-tile texture statistics                 (cheap grain / halftone channel)

Go/no-go: F2 or F3 must beat F1 by >= +0.10 artist-balanced F1 on BOTH aquatint and
drypoint. Everything else in ADR-0019 is conditional on that.

Usage (from repo root, .env sourced):
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/phase0_resolution_probe.py \
        --cache-dir /path/to/scratch --per-class 300
Stages are cached under --cache-dir (sample.json, images/, features_*.npy) so a re-run
skips whatever already finished.
"""

import argparse
import io
import json
import os
import random
import re
import sys
import time

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import artist_eval_weights  # noqa: E402

DINOV2_MODEL_NAME = "facebook/dinov2-large"
USER_AGENT = "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; non-commercial academic research)"

TILE_PX = 224
TILE_MM = 40.0            # one tile spans 40 mm of sheet -> 5.6 px/mm target
TARGET_PX_PER_MM = TILE_PX / TILE_MM
CENTRAL_FRACTION = 0.6    # crop this fraction of each axis around the centre = "print area"
GRID = 4                  # GRID x GRID tiles from the central region
CLASSES = ["Aquatint", "Drypoint"]

QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)-[:USES_TECHNIQUE]->(t:Technique)
WHERE (img.sourceUrl CONTAINS 'bonhams' OR img.sourceUrl CONTAINS 'roseberys')
  AND imp.sheetDimensions IS NOT NULL AND img.embedding IS NOT NULL
MATCH (a:Artist)-[:CREATED]->(:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp)
WITH img, imp, collect(DISTINCT t.name) AS techs, collect(DISTINCT elementId(a))[0] AS artistId
WHERE all(x IN techs WHERE x IN ['Etching','Aquatint','Drypoint'])
RETURN elementId(img) AS imageId, img.sourceUrl AS sourceUrl, techs, artistId,
       imp.sheetDimensions AS sheet
"""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def hires_url(url):
    """ADR-0019 Phase 1 resolver, restricted to the two hosts Phase 0 uses."""
    if "roseberys" in url:
        return url.replace("/lot_images/large/", "/lot_images/xlarge/")
    return url  # Bonhams serves the original at the stored URL


def parse_sheet_mm(s):
    """'45.4x55.2cm' -> (454.0, 552.0) in mm, or None."""
    m = re.match(r"\s*([\d.]+)\s*x\s*([\d.]+)\s*(cm|mm)?", s or "")
    if not m:
        return None
    a, b = float(m.group(1)), float(m.group(2))
    if (m.group(3) or "cm") == "cm":
        a, b = a * 10, b * 10
    if a <= 0 or b <= 0:
        return None
    return a, b


def group_kfold(groups, k, seed):
    rng = random.Random(seed)
    uniq = sorted(set(groups))
    rng.shuffle(uniq)
    fold_of = {g: i % k for i, g in enumerate(uniq)}
    return np.array([fold_of[g] for g in groups])


def class_label(techs):
    """Pure etching -> negatives; aquatint/drypoint sets -> positives (multi-label)."""
    return [1.0 if c in techs else 0.0 for c in CLASSES]


# ---------------------------------------------------------------------------
# stage 1: sample
# ---------------------------------------------------------------------------

def stage_sample(cache_dir, per_class, artist_cap, seed):
    path = os.path.join(cache_dir, "sample.json")
    if os.path.exists(path):
        return json.load(open(path))

    from neo4j import GraphDatabase
    uri, user, pw = os.environ["NEO4J_URI"], os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]
    db = os.environ.get("NEO4J_DATABASE", "neo4j")
    driver = GraphDatabase.driver(uri, auth=(user, pw))
    with driver.session(database=db) as s:
        rows = [dict(r) for r in s.run(QUERY)]
    driver.close()

    rng = random.Random(seed)
    rng.shuffle(rows)
    buckets = {"etching": [], "aquatint": [], "drypoint": []}
    for r in rows:
        t = set(r["techs"])
        if "Aquatint" in t and "Drypoint" in t:
            continue  # ambiguous for a 3-way gate; drop
        key = "aquatint" if "Aquatint" in t else "drypoint" if "Drypoint" in t else "etching"
        buckets[key].append(r)

    sample, seen_per_artist = [], {}
    for key, bucket in buckets.items():
        # Roseberys first so its ~50 usable rows are not crowded out by Bonhams.
        bucket.sort(key=lambda r: 0 if "roseberys" in r["sourceUrl"] else 1)
        taken = 0
        for r in bucket:
            if taken >= per_class:
                break
            if parse_sheet_mm(r["sheet"]) is None:
                continue
            k = (r["artistId"], key)
            if seen_per_artist.get(k, 0) >= artist_cap:
                continue
            seen_per_artist[k] = seen_per_artist.get(k, 0) + 1
            r["bucket"] = key
            sample.append(r)
            taken += 1
        print(f"  {key:9s} {taken} sampled from {len(bucket)} available")
    json.dump(sample, open(path, "w"))
    return sample


# ---------------------------------------------------------------------------
# stage 2: fetch native-resolution files
# ---------------------------------------------------------------------------

def stage_fetch(cache_dir, sample, sleep_s):
    img_dir = os.path.join(cache_dir, "images")
    os.makedirs(img_dir, exist_ok=True)
    ok = 0
    for i, r in enumerate(sample):
        dest = os.path.join(img_dir, r["imageId"].replace(":", "_"))
        r["path"] = dest
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            ok += 1
            continue
        url = hires_url(r["sourceUrl"])
        for attempt in range(3):
            try:
                resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
                if resp.status_code == 200:
                    open(dest, "wb").write(resp.content)
                    ok += 1
                    break
                print(f"  HTTP {resp.status_code} {url}")
            except Exception as e:
                print(f"  {type(e).__name__} {url}")
            time.sleep(2 * (attempt + 1))
        if (i + 1) % 50 == 0:
            print(f"  fetched {i + 1}/{len(sample)}")
        time.sleep(sleep_s)
    print(f"  {ok}/{len(sample)} files on disk")
    return [r for r in sample if os.path.exists(r["path"]) and os.path.getsize(r["path"]) > 0]


# ---------------------------------------------------------------------------
# stage 3: features
# ---------------------------------------------------------------------------

def load_dino(device):
    import torch
    from transformers import AutoImageProcessor, AutoModel
    proc = AutoImageProcessor.from_pretrained(DINOV2_MODEL_NAME)
    model = AutoModel.from_pretrained(DINOV2_MODEL_NAME).to(device).eval()
    mean = torch.tensor(proc.image_mean).view(1, 3, 1, 1).to(device)
    std = torch.tensor(proc.image_std).view(1, 3, 1, 1).to(device)
    return model, mean, std


def cls_batch(model, mean, std, arrays, device):
    """arrays: list of HxWx3 uint8 of identical size -> (n, 1024) float32 CLS."""
    import torch
    x = torch.from_numpy(np.stack(arrays)).permute(0, 3, 1, 2).float().div(255).to(device)
    x = (x - mean) / std
    with torch.no_grad():
        out = model(pixel_values=x).last_hidden_state[:, 0, :]
    return out.float().cpu().numpy()


def texture_stats(gray):
    """Cheap grain / halftone descriptors on one float32 grey tile in [0,1]."""
    lap = (gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4 * gray[1:-1, 1:-1])
    f = np.abs(np.fft.fftshift(np.fft.fft2(gray - gray.mean()))) ** 2
    h, w = f.shape
    yy, xx = np.mgrid[:h, :w]
    rr = np.sqrt((yy - h / 2) ** 2 + (xx - w / 2) ** 2)
    edges = np.linspace(0, rr.max(), 9)
    total = f.sum() + 1e-9
    bands = [f[(rr >= edges[i]) & (rr < edges[i + 1])].sum() / total for i in range(8)]
    return np.array([lap.var(), np.abs(lap).mean(), gray.std()] + bands, dtype=np.float32)


def tiles_for(im, sheet_mm):
    """Central-region tiles at a fixed physical scale. Returns list of HxWx3 uint8 + px/mm used."""
    from PIL import Image
    W, H = im.size
    long_px, long_mm = max(W, H), max(sheet_mm)
    native_px_per_mm = long_px / long_mm            # assumes the sheet spans the long axis
    scale = min(1.0, TARGET_PX_PER_MM / native_px_per_mm)  # never upsample
    if scale < 1.0:
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
                continue
            tiles.append(np.asarray(im.crop(box)))
    return tiles, native_px_per_mm * scale


def stage_features(cache_dir, sample, device):
    from PIL import Image
    paths = {k: os.path.join(cache_dir, f"features_{k}.npy") for k in ("F0", "F1", "F2", "F3", "meta")}
    if all(os.path.exists(p) for p in paths.values()):
        return {k: np.load(p, allow_pickle=(k == "meta")) for k, p in paths.items()}

    # F0 straight from the graph — the stored 224px embedding.
    from neo4j import GraphDatabase
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        emb = {r["id"]: r["e"] for r in s.run(
            "MATCH (i:DigitalImage) WHERE elementId(i) IN $ids RETURN elementId(i) AS id, i.embedding AS e",
            ids=[r["imageId"] for r in sample])}
    driver.close()

    model, mean, std = load_dino(device)
    F0, F1, F2, F3, meta = [], [], [], [], []
    t0 = time.time()
    for i, r in enumerate(sample):
        im = Image.open(r["path"]).convert("RGB")
        sheet = parse_sheet_mm(r["sheet"])
        # F1: 518px whole image (resize short side to 518, centre crop), 37x37 patch grid.
        w518 = im.resize((518, 518), Image.LANCZOS) if min(im.size) < 518 else None
        if w518 is None:
            W, H = im.size
            s = 518 / min(W, H)
            im2 = im.resize((max(518, round(W * s)), max(518, round(H * s))), Image.LANCZOS)
            W, H = im2.size
            w518 = im2.crop(((W - 518) // 2, (H - 518) // 2, (W - 518) // 2 + 518, (H - 518) // 2 + 518))
        f1 = cls_batch(model, mean, std, [np.asarray(w518)], device)[0]

        tiles, px_per_mm = tiles_for(im, sheet)
        if not tiles:
            print(f"  no tiles for {r['imageId']} ({im.size}, {r['sheet']})")
            continue
        tv = cls_batch(model, mean, std, tiles, device)
        f2 = np.concatenate([tv.mean(0), tv.max(0)])
        tex = np.stack([texture_stats(np.asarray(Image.fromarray(t).convert("L"), dtype=np.float32) / 255) for t in tiles])
        f3 = np.concatenate([f2, tex.mean(0), tex.max(0)])

        F0.append(np.asarray(emb[r["imageId"]], dtype=np.float32))
        F1.append(f1); F2.append(f2); F3.append(f3)
        meta.append({**{k: r[k] for k in ("imageId", "artistId", "bucket", "techs", "sourceUrl", "sheet")},
                     "pxPerMm": px_per_mm, "nativeSize": im.size, "nTiles": len(tiles)})
        if (i + 1) % 25 == 0:
            print(f"  features {i + 1}/{len(sample)}  ({time.time() - t0:.0f}s)")

    out = {"F0": np.stack(F0), "F1": np.stack(F1), "F2": np.stack(F2), "F3": np.stack(F3),
           "meta": np.array(meta, dtype=object)}
    for k, p in paths.items():
        np.save(p, out[k], allow_pickle=(k == "meta"))
    return out


# ---------------------------------------------------------------------------
# stage 4: artist-grouped CV
# ---------------------------------------------------------------------------

def fit_head(X, Y, w, epochs=300, seed=0):
    import torch
    torch.manual_seed(seed)
    Xt, Yt, wt = torch.from_numpy(X), torch.from_numpy(Y), torch.from_numpy(w)
    head = torch.nn.Sequential(torch.nn.Linear(X.shape[1], 256), torch.nn.GELU(), torch.nn.Dropout(0.3),
                               torch.nn.Linear(256, Y.shape[1]))
    opt = torch.optim.AdamW(head.parameters(), lr=1e-3, weight_decay=1e-2)
    pos = Yt.mean(0).clamp(min=1e-3)
    pos_weight = ((1 - pos) / pos).clamp(max=10)
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pos_weight, reduction="none")
    head.train()
    for _ in range(epochs):
        opt.zero_grad()
        loss = (loss_fn(head(Xt), Yt) * wt[:, None]).mean()
        loss.backward()
        opt.step()
    head.eval()
    return lambda Z: torch.sigmoid(head(torch.from_numpy(Z))).detach().numpy()


def weighted_f1(y, p, w, thr):
    pred = p >= thr
    tp = (w * (pred & (y == 1))).sum()
    fp = (w * (pred & (y == 0))).sum()
    fn = (w * (~pred & (y == 1))).sum()
    return 2 * tp / (2 * tp + fp + fn + 1e-9)


def weighted_ap(y, p, w):
    order = np.argsort(-p)
    y, w = y[order], w[order]
    tp = np.cumsum(w * y)
    fp = np.cumsum(w * (1 - y))
    prec = tp / (tp + fp + 1e-9)
    rec = tp / (tp[-1] + 1e-9)
    return float(np.sum(np.diff(np.concatenate([[0], rec])) * prec))


def stage_eval(feats, k, seed, out_path):
    meta = feats["meta"]
    Y = np.array([class_label(m["techs"]) for m in meta], dtype=np.float32)
    groups = np.array([m["artistId"] for m in meta])
    folds = group_kfold(groups, k, seed)
    results = {}
    for name in ("F0", "F1", "F2", "F3"):
        X = feats[name].astype(np.float32)
        oof = np.zeros_like(Y)
        thr_used = np.zeros((k, len(CLASSES)))
        for f in range(k):
            tr, te = folds != f, folds == f
            tr_groups = groups[tr]
            val_artists = set(sorted(set(tr_groups))[::6])           # ~1/6 of train artists tune thresholds
            fit = tr.copy(); fit[tr] = ~np.isin(tr_groups, list(val_artists))
            val = tr.copy(); val[tr] = np.isin(tr_groups, list(val_artists))
            mu, sd = X[fit].mean(0), X[fit].std(0) + 1e-6
            Z = (X - mu) / sd
            predict = fit_head(Z[fit], Y[fit], artist_eval_weights(groups[fit]).astype(np.float32), seed=seed + f)
            pv, wv = predict(Z[val]), artist_eval_weights(groups[val])
            for c in range(len(CLASSES)):
                grid = np.linspace(0.05, 0.95, 19)
                thr_used[f, c] = grid[np.argmax([weighted_f1(Y[val, c], pv[:, c], wv, t) for t in grid])]
            oof[te] = predict(Z[te])
        w = artist_eval_weights(groups)
        res = {}
        for c, cname in enumerate(CLASSES):
            thr = float(np.median(thr_used[:, c]))
            res[cname] = {"artist_bal_F1": float(weighted_f1(Y[:, c], oof[:, c], w, thr)),
                          "artist_bal_AP": weighted_ap(Y[:, c], oof[:, c], w),
                          "threshold": thr, "positives": int(Y[:, c].sum())}
        results[name] = res
        print(f"  {name}: " + "  ".join(f"{c} F1={r['artist_bal_F1']:.3f} AP={r['artist_bal_AP']:.3f}" for c, r in res.items()))
    json.dump({"results": results, "n_images": len(meta), "n_artists": len(set(groups)),
               "px_per_mm_median": float(np.median([m["pxPerMm"] for m in meta])),
               "by_bucket": {b: int(sum(m["bucket"] == b for m in meta)) for b in ("etching", "aquatint", "drypoint")}},
              open(out_path, "w"), indent=2)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--per-class", type=int, default=300)
    ap.add_argument("--artist-cap", type=int, default=5)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--sleep", type=float, default=0.5, help="seconds between downloads")
    ap.add_argument("--device", default=None)
    args = ap.parse_args()
    os.makedirs(args.cache_dir, exist_ok=True)

    import torch
    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"[1/4] sampling (per-class {args.per_class}, artist cap {args.artist_cap})")
    sample = stage_sample(args.cache_dir, args.per_class, args.artist_cap, args.seed)
    print(f"[2/4] fetching {len(sample)} native-resolution files")
    sample = stage_fetch(args.cache_dir, sample, args.sleep)
    print(f"[3/4] features on {device}")
    feats = stage_features(args.cache_dir, sample, device)
    print(f"[4/4] {args.folds}-fold artist-grouped CV over {len(feats['meta'])} images")
    stage_eval(feats, args.folds, args.seed, os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts", "phase0_results.json"))


if __name__ == "__main__":
    main()
