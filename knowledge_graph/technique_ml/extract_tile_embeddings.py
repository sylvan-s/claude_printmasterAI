"""
PrintMasterAI — ADR-0019 Phase 2: tile embeddings at a fixed physical scale.
Version: TECHML-PHASE2-EXTRACT-1.4

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

Steps 1–3 are pure-Python/PIL and GIL-bound (the first pod run pinned one core at 100%
with the GPU at 4%), so they run in a process pool; only step 4 runs in the main process.

Output is shards of 500 images under --out-dir:
  tiles_NNNN.npz   image_ids, primary_cls [n,16,1024] f32, fine_cls [n,16,1024] f32
                   (zeros where absent), has_fine [n], primary_strata / fine_strata [n,16]
                   (index into STRATA_NAMES), primary_px_per_mm / fine_px_per_mm [n]
  tiles_NNNN.meta.jsonl   one line per image: imageId, box, native/used px/mm, tile counts
  failures.jsonl   imageId + reason for anything skipped
Resumable: image ids present in existing shards are skipped. Load into Neo4j afterwards
with load_tile_embeddings.py (pooled vectors on the node; per-tile arrays stay in shards).

    HF_TOKEN=... python extract_tile_embeddings.py --manifest phase2_manifest.jsonl \
        --out-dir tiles/ [--workers 16] [--model facebook/dinov3-vitl16-pretrain-lvd1689m] [--limit N]
"""

import argparse
import glob
import io
import json
import multiprocessing
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hires import USER_AGENT, choose_dimensions  # noqa: E402
from tiling import STRATA, locate_print_area, stratified_tiles  # noqa: E402

STRATA_NAMES = list(STRATA) + ["fill"]
PRIMARY_PX_PER_MM = 5.6
FINE_PX_PER_MM = 11.2
N_TILES = 16
DIM = 1024
Image.MAX_IMAGE_PIXELS = 60_000_000


# ---------------------------------------------------------------------------
# worker side: fetch + localise + tiles (no torch, no model)
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


def prepare(row):
    """-> (row, meta, {scale: {"tiles": [n,224,224,3] uint8, "strata": [n] int8, "px_per_mm"}}, None)
    or (row, None, None, error)."""
    try:
        data = fetch_bytes(row["hiresUrl"])
        im = Image.open(io.BytesIO(data)).convert("RGB")
        box, diag = locate_print_area(im)
        native, basis = native_scale(im, row, box)
        if native is None:
            raise RuntimeError("no catalogue dimensions")
        meta = {"imageId": row["imageId"], "box": list(box), "localiserFallback": diag["fallback"],
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
            tiles = tiles[:N_TILES]
            res[name] = {"tiles": np.stack([t["tile"] for t in tiles]),
                         "strata": np.array([STRATA_NAMES.index(t["stratum"]) for t in tiles], np.int8),
                         "px_per_mm": float(tiles[0]["px_per_mm"])}
            meta[f"{name}Tiles"] = len(tiles)
            meta[f"{name}PxPerMm"] = round(tiles[0]["px_per_mm"], 3)
        return row, meta, res, None
    except Exception as e:
        return row, None, None, f"{type(e).__name__}: {str(e)[:160]}"


# ---------------------------------------------------------------------------
# main side: encoder + shards
# ---------------------------------------------------------------------------

def load_encoder(name, device):
    import torch
    from transformers import AutoImageProcessor, AutoModel
    proc = AutoImageProcessor.from_pretrained(name)
    # fp32 everywhere: DINOv3 ViT-L in fp16 on CUDA returned NaN for every CLS vector on the
    # first pilot run (65,412/65,412 tiles). The GPU is nowhere near the bottleneck, so fp32
    # costs nothing that matters. Shards are stored fp32 for the same reason.
    dtype = torch.float32
    model = AutoModel.from_pretrained(name, dtype=dtype).to(device).eval()
    mean = torch.tensor(proc.image_mean, dtype=dtype).view(1, 3, 1, 1).to(device)
    std = torch.tensor(proc.image_std, dtype=dtype).view(1, 3, 1, 1).to(device)
    return {"model": model, "mean": mean, "std": std, "dtype": dtype, "device": device}


def encode(enc, tiles):
    """[n,224,224,3] uint8 -> [n, DIM] float32 CLS. Raises if any value is non-finite."""
    import torch
    x = torch.from_numpy(tiles).permute(0, 3, 1, 2).to(enc["device"]).to(enc["dtype"]).div(255)
    x = (x - enc["mean"]) / enc["std"]
    with torch.no_grad():
        h = enc["model"](pixel_values=x).last_hidden_state[:, 0, :]
    out = h.float().cpu().numpy().astype(np.float32)
    if not np.isfinite(out).all():
        raise RuntimeError(f"non-finite embedding ({int((~np.isfinite(out)).sum())} values) — encoder dtype/overflow problem")
    return out


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
        pk, fk = np.zeros((n, N_TILES, DIM), np.float32), np.zeros((n, N_TILES, DIM), np.float32)
        ps, fs = np.full((n, N_TILES), -1, np.int8), np.full((n, N_TILES), -1, np.int8)
        pp, fp = np.zeros(n, np.float32), np.zeros(n, np.float32)
        has_fine = np.zeros(n, bool)
        for i, (_, res) in enumerate(self.buf):
            p = res["primary"]
            pk[i, :len(p["cls"])], ps[i, :len(p["strata"])], pp[i] = p["cls"], p["strata"], p["px_per_mm"]
            if "fine" in res:
                f = res["fine"]
                fk[i, :len(f["cls"])], fs[i, :len(f["strata"])], fp[i], has_fine[i] = f["cls"], f["strata"], f["px_per_mm"], True
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
    ap.add_argument("--workers", type=int, default=16, help="preprocessing processes (fetch + localise + tiles)")
    ap.add_argument("--task-timeout", type=float, default=600, help="seconds before an in-flight image is abandoned")
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    import torch
    device = args.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    rows = [json.loads(l) for l in open(args.manifest)]
    done = already_done(args.out_dir)
    rows = [r for r in rows if r["imageId"] not in done]
    if args.limit:
        rows = rows[:args.limit]
    print(f"{len(rows)} images to extract ({len(done)} already in shards), device {device}, model {args.model}, "
          f"{args.workers} workers", flush=True)
    if not rows:
        return
    # Workers are SPAWNED, not forked, and the pool exists before torch is initialised:
    # forking after the encoder loads inherits torch's OpenMP/BLAS state and the children
    # deadlock on their first numpy call (observed on the first pod run: 24 workers, CPU idle,
    # GPU 0%). Spawned workers import only numpy/PIL/requests.
    pool = ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn"))
    enc = load_encoder(args.model, device)
    writer = ShardWriter(args.out_dir, args.shard_size)
    fail_log = open(os.path.join(args.out_dir, "failures.jsonl"), "a")
    t0, n_ok, n_fail, n_fine = time.time(), 0, 0, 0

    # Unordered consumption with a sliding window and a per-task watchdog. The first
    # full-corpus run stalled for 77 minutes on one task that never returned (a worker hung
    # with no timeout — requests' timeouts do not cover DNS resolution), and ordered map()
    # blocked every later result behind it. Here a task older than --task-timeout is
    # abandoned (logged as a failure; the hung worker keeps its slot, the rest continue).
    window = args.workers * 3
    pending = {}            # future -> (row, submit_time)
    it = iter(rows)
    done_n = 0
    def submit_more():
        while len(pending) < window:
            try:
                row = next(it)
            except StopIteration:
                return
            pending[pool.submit(prepare, row)] = (row, time.time())
    submit_more()
    while pending:
        finished = [f for f in pending if f.done()]
        if not finished:
            stale = [f for f, (_, ts) in pending.items() if time.time() - ts > args.task_timeout]
            for f in stale:
                row, _ = pending.pop(f)
                f.cancel()
                n_fail += 1; done_n += 1
                fail_log.write(json.dumps({"imageId": row["imageId"], "hiresUrl": row["hiresUrl"],
                                           "reason": f"abandoned after {args.task_timeout}s (worker hung)"}) + "\n")
                fail_log.flush()
                print(f"  abandoned {row['imageId']} after {args.task_timeout}s", flush=True)
            submit_more()
            time.sleep(0.5)
            continue
        for f in finished:
            row, _ = pending.pop(f)
            try:
                _, meta, res, err = f.result()
            except Exception as e:
                meta, res, err = None, None, f"{type(e).__name__}: {str(e)[:160]}"
            if err is None:
                try:
                    out = {}
                    for name, r in res.items():
                        out[name] = {"cls": encode(enc, r["tiles"]), "strata": r["strata"], "px_per_mm": r["px_per_mm"]}
                    writer.add(meta, out)
                    n_ok += 1
                    n_fine += int("fine" in res)
                except Exception as e:
                    err = f"{type(e).__name__}: {str(e)[:160]}"
            if err is not None:
                n_fail += 1
                fail_log.write(json.dumps({"imageId": row["imageId"], "hiresUrl": row["hiresUrl"], "reason": err}) + "\n")
                fail_log.flush()
            done_n += 1
            if done_n % 100 == 0:
                rate = done_n / (time.time() - t0)
                print(f"  {done_n}/{len(rows)}  ok={n_ok} fine={n_fine} failed={n_fail}  {rate:.2f} img/s  "
                      f"eta {(len(rows) - done_n) / max(rate, 1e-6) / 60:.0f} min", flush=True)
        submit_more()
    writer.flush()
    fail_log.close()
    print(f"done: {n_ok} extracted ({n_fine} with fine scale), {n_fail} failed, {time.time() - t0:.0f}s", flush=True)
    pool.shutdown(wait=False, cancel_futures=True)   # a hung worker must not keep the process alive
    os._exit(0)


if __name__ == "__main__":
    main()
