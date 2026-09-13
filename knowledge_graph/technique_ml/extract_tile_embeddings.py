"""
PrintMasterAI — ADR-0019 Phase 2: tile embeddings at a fixed physical scale.
Version: TECHML-PHASE2-EXTRACT-1.0

Runs on a rented GPU box (or locally on MPS for smoke tests) from a manifest written by
export_phase2_manifest.py. Needs no graph access — only the manifest, network access to
the image hosts, and HF_TOKEN for the gated DINOv3 checkpoint. Per image:

  1. stream the hires URL (never written to disk; ADR-0002 Amendment 1 Decision 7(b))
  2. localise the print area (tiling.locate_print_area) and refine px/mm: if the catalogue
     dimension is the plate or image, the localised box is the thing measured, so
     box_long_px / dim_long_mm is the better estimate; sheet stays image-long-axis based
  3. cut 16 content-stratified 224 px tiles at 5.6 px/mm (40 mm) — the primary scale —
     and, where the native scale allows (>= 11.2 px/mm), 16 more at 11.2 px/mm (20 mm)
  4. encode every tile with DINOv3 ViT-L/16 (CLS token; Phase 0b selected it) in fp16

Output is shards of 500 images under --out-dir:
  tiles_NNNN.npz   image_ids, primary_cls [n,16,1024] f16, fine_cls [n,16,1024] f16
                   (zeros where absent), has_fine [n], primary_strata / fine_strata [n,16]
                   (index into STRATA_NAMES), primary_px_per_mm / fine_px_per_mm [n]
  tiles_NNNN.meta.jsonl   one line per image: imageId, box, native/used px/mm, tile counts
  failures.jsonl   imageId + reason for anything skipped
Resumable: image ids present in existing shards are skipped. Load into Neo4j afterwards
with load_tile_embeddings.py (pooled vectors on the node; per-tile arrays stay in shards).

    HF_TOKEN=... python extract_tile_embeddings.py --manifest phase2_manifest.jsonl \
        --out-dir tiles/ [--model facebook/dinov3-vitl16-pretrain-lvd1689m] [--limit N]
"""

import argparse
import glob
import io
import json
import os
import queue
import sys
import threading
import time

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hires import USER_AGENT, choose_dimensions  # noqa: E402
from tiling import STRATA, TILE_PX, locate_print_area, stratified_tiles  # noqa: E402

STRATA_NAMES = list(STRATA) + ["fill"]
PRIMARY_PX_PER_MM = 5.6
FINE_PX_PER_MM = 11.2
N_TILES = 16
DIM = 1024
Image.MAX_IMAGE_PIXELS = 60_000_000


# ---------------------------------------------------------------------------
# fetch (prefetch thread)
# ---------------------------------------------------------------------------

def fetch_bytes(url, timeout=90, retries=3):
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if r.status_code == 200:
                return r.content
            last = f"HTTP {r.status_code}"
            if r.status_code in (403, 404, 410):
                break
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(last or "unknown")


def prefetcher(rows, q, n_threads):
    idx = {"i": 0}
    lock = threading.Lock()

    def run():
        while True:
            with lock:
                i = idx["i"]
                idx["i"] += 1
            if i >= len(rows):
                return
            row = rows[i]
            try:
                q.put((row, fetch_bytes(row["hiresUrl"]), None))
            except Exception as e:
                q.put((row, None, str(e)[:200]))

    threads = [threading.Thread(target=run, daemon=True) for _ in range(n_threads)]
    for t in threads:
        t.start()
    return threads


# ---------------------------------------------------------------------------
# encoder
# ---------------------------------------------------------------------------

def load_encoder(name, device):
    import torch
    from transformers import AutoImageProcessor, AutoModel
    proc = AutoImageProcessor.from_pretrained(name)
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModel.from_pretrained(name, dtype=dtype).to(device).eval()
    mean = torch.tensor(proc.image_mean, dtype=dtype).view(1, 3, 1, 1).to(device)
    std = torch.tensor(proc.image_std, dtype=dtype).view(1, 3, 1, 1).to(device)
    return {"model": model, "mean": mean, "std": std, "dtype": dtype, "device": device}


def encode(enc, tiles):
    """list of HxWx3 uint8 -> [n, DIM] float16 CLS."""
    import torch
    x = torch.from_numpy(np.stack(tiles)).permute(0, 3, 1, 2).to(enc["device"]).to(enc["dtype"]).div(255)
    x = (x - enc["mean"]) / enc["std"]
    with torch.no_grad():
        h = enc["model"](pixel_values=x).last_hidden_state[:, 0, :]
    return h.float().cpu().numpy().astype(np.float16)


# ---------------------------------------------------------------------------
# per-image
# ---------------------------------------------------------------------------

def native_scale(im, row, box):
    """px/mm of the native image, refined by the localised box when the catalogue dimension
    describes the plate or image rather than the sheet."""
    dims, basis = choose_dimensions(row.get("sheet"), row.get("image"), row.get("plate"))
    if not dims:
        return None, None
    long_mm = max(dims)
    if basis in ("plate", "image"):
        long_px = max(box[2] - box[0], box[3] - box[1])
    else:
        long_px = max(im.size)
    return long_px / long_mm, basis


def process_image(row, data, enc):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    box, diag = locate_print_area(im)
    native, basis = native_scale(im, row, box)
    if native is None:
        raise RuntimeError("no catalogue dimensions")
    out = {"imageId": row["imageId"], "box": list(box), "localiserFallback": diag["fallback"],
           "nativePxPerMm": round(native, 3), "basis": basis, "imageSize": list(im.size)}
    scales = {"primary": PRIMARY_PX_PER_MM}
    if native >= FINE_PX_PER_MM:
        scales["fine"] = FINE_PX_PER_MM
    res = {}
    for name, target in scales.items():
        tiles = stratified_tiles(im, box, native, target, seed=hash(row["imageId"]) & 0xFFFF)
        if not tiles:
            if name == "primary":
                raise RuntimeError("print area smaller than one tile")
            continue
        vecs = encode(enc, [t["tile"] for t in tiles])
        cls = np.zeros((N_TILES, DIM), np.float16)
        strata = np.full(N_TILES, -1, np.int8)
        cls[:len(tiles)] = vecs[:N_TILES]
        strata[:len(tiles)] = [STRATA_NAMES.index(t["stratum"]) for t in tiles[:N_TILES]]
        res[name] = {"cls": cls, "strata": strata, "px_per_mm": tiles[0]["px_per_mm"], "n": len(tiles)}
        out[f"{name}Tiles"] = len(tiles)
        out[f"{name}PxPerMm"] = round(tiles[0]["px_per_mm"], 3)
    return out, res


# ---------------------------------------------------------------------------
# shards
# ---------------------------------------------------------------------------

class ShardWriter:
    def __init__(self, out_dir, shard_size):
        self.out_dir, self.shard_size = out_dir, shard_size
        os.makedirs(out_dir, exist_ok=True)
        existing = sorted(glob.glob(os.path.join(out_dir, "tiles_*.npz")))
        self.next_idx = (int(os.path.basename(existing[-1])[6:10]) + 1) if existing else 0
        self.buf, self.meta = [], []

    def add(self, meta, res):
        self.buf.append((meta["imageId"], res))
        self.meta.append(meta)
        if len(self.buf) >= self.shard_size:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        n = len(self.buf)
        z = lambda: np.zeros((n, N_TILES, DIM), np.float16)  # noqa: E731
        pk, fk = z(), z()
        ps, fs = np.full((n, N_TILES), -1, np.int8), np.full((n, N_TILES), -1, np.int8)
        pp, fp = np.zeros(n, np.float32), np.zeros(n, np.float32)
        has_fine = np.zeros(n, bool)
        for i, (_, res) in enumerate(self.buf):
            pk[i], ps[i], pp[i] = res["primary"]["cls"], res["primary"]["strata"], res["primary"]["px_per_mm"]
            if "fine" in res:
                fk[i], fs[i], fp[i], has_fine[i] = res["fine"]["cls"], res["fine"]["strata"], res["fine"]["px_per_mm"], True
        base = os.path.join(self.out_dir, f"tiles_{self.next_idx:04d}")
        np.savez(base + ".npz", image_ids=np.array([b[0] for b in self.buf]), primary_cls=pk, fine_cls=fk,
                 has_fine=has_fine, primary_strata=ps, fine_strata=fs, primary_px_per_mm=pp, fine_px_per_mm=fp)
        with open(base + ".meta.jsonl", "w") as f:
            for m in self.meta:
                f.write(json.dumps(m) + "\n")
        print(f"  wrote {base}.npz ({n} images, {int(has_fine.sum())} with fine scale)", flush=True)
        self.next_idx += 1
        self.buf, self.meta = [], []


def already_done(out_dir):
    done = set()
    for p in glob.glob(os.path.join(out_dir, "tiles_*.npz")):
        done.update(np.load(p)["image_ids"].tolist())
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--model", default="facebook/dinov3-vitl16-pretrain-lvd1689m")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--shard-size", type=int, default=500)
    ap.add_argument("--fetch-threads", type=int, default=6)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    import torch
    device = args.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    rows = [json.loads(l) for l in open(args.manifest)]
    done = already_done(args.out_dir)
    rows = [r for r in rows if r["imageId"] not in done]
    if args.limit:
        rows = rows[:args.limit]
    print(f"{len(rows)} images to extract ({len(done)} already in shards), device {device}, model {args.model}", flush=True)
    if not rows:
        return
    enc = load_encoder(args.model, device)
    writer = ShardWriter(args.out_dir, args.shard_size)
    q = queue.Queue(maxsize=args.fetch_threads * 4)
    prefetcher(rows, q, args.fetch_threads)
    fail_log = open(os.path.join(args.out_dir, "failures.jsonl"), "a")
    t0, n_ok, n_fail, n_fine = time.time(), 0, 0, 0
    for i in range(len(rows)):
        row, data, err = q.get()
        if err is None:
            try:
                meta, res = process_image(row, data, enc)
                writer.add(meta, res)
                n_ok += 1
                n_fine += int("fine" in res)
            except Exception as e:
                err = f"{type(e).__name__}: {str(e)[:160]}"
        if err is not None:
            n_fail += 1
            fail_log.write(json.dumps({"imageId": row["imageId"], "hiresUrl": row["hiresUrl"], "reason": err}) + "\n")
            fail_log.flush()
        if (i + 1) % 100 == 0:
            rate = (i + 1) / (time.time() - t0)
            print(f"  {i + 1}/{len(rows)}  ok={n_ok} fine={n_fine} failed={n_fail}  {rate:.2f} img/s  "
                  f"eta {(len(rows) - i - 1) / max(rate, 1e-6) / 60:.0f} min", flush=True)
    writer.flush()
    fail_log.close()
    print(f"done: {n_ok} extracted ({n_fine} with fine scale), {n_fail} failed, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
