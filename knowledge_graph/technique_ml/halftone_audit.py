"""
PrintMasterAI — ADR-0019 Phase 3: halftone-screen audit of `Lithograph` vs `Offset lithograph`.
Version: TECHML-HALFTONE-1.2

`Offset lithograph` is the class the classifier could never learn (F1 0.01 in the 2026-09-07
model; a gate false-pass at 0.29 test F1 in the tile model) and the research note
(docs/research/intaglio-technique-visual-cues-2026-09-13.md §4 row D) names the one
physical, label-independent test for it: a photomechanical print carries a regular halftone
screen, a hand-drawn lithograph does not. A regular screen is a sharp peak pair (or quartet)
in the 2-D power spectrum of a tile; crayon and tusche grain is broadband. Screens finer than
the photograph resolves alias into moiré, which is still periodic, so peak detection survives
below Nyquist — only the inferred pitch is wrong.

This script does NOT retrain anything. It fetches a labelled sample at native resolution,
scores every image with the detector, and writes:
  artifacts/halftone_audit.jsonl   one line per image: scores, label, px/mm, institution
  artifacts/halftone_audit.md      separation of the two labels by the physical score,
                                   and the flagged lists (Lithograph with a screen; Offset
                                   without one at adequate resolution)
  <scratch>/halftone_crops/        4x zoomed 224 px tile crops of the extremes, to eyeball

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/halftone_audit.py \
        --manifest knowledge_graph/technique_ml/data/phase2_full.jsonl --per-class 250 \
        --crops-dir /path/to/scratch/halftone_crops
"""

import argparse
import io
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hires import USER_AGENT, choose_dimensions  # noqa: E402
from tiling import TILE_PX, locate_print_area, stratified_tiles  # noqa: E402
from train_tile_head import weighted_auroc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
Image.MAX_IMAGE_PIXELS = 60_000_000


# ---------------------------------------------------------------------------
# detector
# ---------------------------------------------------------------------------

def screen_score(tile_rgb, px_per_mm):
    """Spectral peakiness of a native-resolution tile, restricted to where a halftone can be.

    Returns (score, peak_lpi, n_peaks). First version fired on flat colour: an almost empty
    spectrum makes JPEG 8-px block harmonics look like sharp peaks, and picking the
    highest-scoring tile per image selected exactly those tiles. So: (1) tiles with no
    high-frequency texture are scored 0; (2) only frequencies >= 2.4 cycles/mm (>= 60 lpi,
    the coarsest commercial screen) count, which at 8 px/mm also excludes the 1 mm block
    period; (3) axis-aligned peaks at multiples of 1/8 cycle/px (block harmonics) are
    notched out — halftone screens sit at 45 deg (single-colour) or 15/75 deg (process).
    score = MAD-z of the strongest surviving peak; a screen shows >= 2 peaks in distinct
    directions.
    """
    g = np.asarray(Image.fromarray(tile_rgb).convert("L"), np.float32) / 255.0
    if g.mean() > 0.85 or np.percentile(g, 25) > 0.8:     # blank paper cannot carry a screen
        return 0.0, None, 0
    g = g - g.mean()
    n = g.shape[0]
    # texture floor: high-pass residual after a 5x5 box blur
    k = 5
    pad = np.pad(g, k // 2, mode="reflect")
    blur = sum(pad[i:i + n, j:j + n] for i in range(k) for j in range(k)) / (k * k)
    hp = g - blur
    if hp.std() < 0.012:
        return 0.0, None, 0
    w = np.hanning(n)
    F = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2(g * w[:, None] * w[None, :]))))
    cy, cx = n // 2, n // 2
    yy, xx = np.mgrid[:n, :n]
    dy, dx = yy - cy, xx - cx
    r = np.sqrt(dy ** 2 + dx ** 2)
    cyc_per_px = r / n
    cyc_per_mm = cyc_per_px * px_per_mm
    mask = (cyc_per_mm >= 2.4) & (r <= n * 0.48)
    # notch JPEG block harmonics: within 2 bins of an axis AND within 1.5 bins of k*n/8
    on_axis = (np.abs(dy) <= 2) | (np.abs(dx) <= 2)
    harm = np.abs((r / (n / 8.0)) - np.round(r / (n / 8.0))) * (n / 8.0) <= 1.5
    mask &= ~(on_axis & harm)
    if mask.sum() < 100:
        return 0.0, None, 0
    vals = F[mask]
    med, mad = np.median(vals), np.median(np.abs(vals - np.median(vals))) + 1e-6
    z = np.where(mask, (F - med) / (1.4826 * mad), -np.inf)
    peaks = []
    zc = z.copy()
    for _ in range(6):
        idx = int(np.argmax(zc))
        py, px = divmod(idx, n)
        if zc[py, px] < 4.0:
            break
        ang = np.degrees(np.arctan2(py - cy, px - cx)) % 180.0
        if all(min(abs(ang - a), 180 - abs(ang - a)) > 15 for _, a, _ in peaks):
            peaks.append((float(zc[py, px]), ang, float(cyc_per_px[py, px])))
        zc[max(0, py - 6):py + 7, max(0, px - 6):px + 7] = -np.inf
    if len(peaks) < 2:
        return 0.0, None, len(peaks)
    # lattice test: a dot screen is a 2-D lattice -> two peaks of similar radius ~90 deg apart
    # (60-120 tolerated for process-colour rosettes). Score = the weaker of the pair.
    best_pair = 0.0
    best_f = None
    for i in range(len(peaks)):
        for j in range(i + 1, len(peaks)):
            zi, ai, fi = peaks[i]; zj, aj, fj = peaks[j]
            dang = abs(ai - aj); dang = min(dang, 180 - dang)
            ratio = max(fi, fj) / max(min(fi, fj), 1e-6)
            if 60 <= dang <= 120 and ratio <= 1.3:
                if min(zi, zj) > best_pair:
                    best_pair, best_f = min(zi, zj), (fi + fj) / 2
    if best_f is None:
        return 0.0, None, len(peaks)
    lpi = best_f * px_per_mm * 25.4
    return best_pair, (float(lpi) if best_f < 0.5 else None), len(peaks)


# ---------------------------------------------------------------------------
# per image
# ---------------------------------------------------------------------------

def fetch(url, timeout=90):
    for attempt in range(3):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if r.status_code == 200:
                return r.content
            if r.status_code in (403, 404, 410):
                return None
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))
    return None


def audit_image(row):
    data = fetch(row["hiresUrl"])
    if data is None:
        return {**row_summary(row), "error": "fetch"}
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as e:
        return {**row_summary(row), "error": f"decode: {type(e).__name__}"}
    box, _ = locate_print_area(im)
    dims, basis = choose_dimensions(row.get("sheet"), row.get("image"), row.get("plate"))
    if not dims:
        return {**row_summary(row), "error": "no dims"}
    long_px = max(box[2] - box[0], box[3] - box[1]) if basis in ("plate", "image") else max(im.size)
    native = long_px / max(dims)
    tiles = stratified_tiles(im, box, native, native, seed=7)      # native scale: no resampling
    if not tiles:
        return {**row_summary(row), "error": "no tiles"}
    scored = []
    for t in tiles:
        s, lpi, npk = screen_score(t["tile"], native)
        scored.append((s, lpi, npk, t))
    scored.sort(key=lambda x: -x[0])
    top = scored[:3]
    out = {**row_summary(row), "nativePxPerMm": round(native, 2), "nTiles": len(tiles),
           "score_max": round(top[0][0], 2), "score_top3": round(float(np.mean([s for s, _, _, _ in top])), 2),
           "peaks_max": top[0][2], "lpi_est": (round(top[0][1]) if top[0][1] else None),
           "frac_tiles_screened": round(float(np.mean([s >= 8.0 and npk >= 2 for s, _, npk, _ in scored])), 2)}
    out["_best_tile"] = top[0][3]["tile"]
    return out


def row_summary(row):
    return {"imageId": row["imageId"], "label": row["_label"], "institution": row["institution"],
            "pxPerMm_sheet": row.get("pxPerMm"), "hiresUrl": row["hiresUrl"], "artist": row.get("artistName")}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--per-class", type=int, default=250)
    ap.add_argument("--min-px-per-mm", type=float, default=7.0)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--crops-dir", required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "halftone_audit.jsonl"))
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows = [json.loads(l) for l in open(args.manifest)]
    pools = {"Lithograph": [], "Offset lithograph": []}
    for r in rows:
        t = set(r["techniques"])
        if len(t) == 1 and next(iter(t)) in pools and (r.get("pxPerMm") or 0) >= args.min_px_per_mm:
            r["_label"] = next(iter(t))
            pools[r["_label"]].append(r)
    for k in pools:
        rng.shuffle(pools[k])
    sample = pools["Lithograph"][:args.per_class] + pools["Offset lithograph"][:args.per_class]
    print(f"available at ≥{args.min_px_per_mm} px/mm: Lithograph-only {len(pools['Lithograph'])}, Offset-only {len(pools['Offset lithograph'])}; "
          f"auditing {len(sample)}", flush=True)

    os.makedirs(args.crops_dir, exist_ok=True)
    results, t0 = [], time.time()
    with ThreadPoolExecutor(args.threads) as pool:
        for i, res in enumerate(pool.map(audit_image, sample)):
            results.append(res)
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(sample)} ({time.time() - t0:.0f}s)", flush=True)
    ok = [r for r in results if "error" not in r]
    print(f"scored {len(ok)}/{len(results)}; errors: {sum(1 for r in results if 'error' in r)}")

    # separation of the labels by the physical score
    y = np.array([1.0 if r["label"] == "Offset lithograph" else 0.0 for r in ok])
    g = np.array([r["artist"] or r["imageId"] for r in ok])
    from dataset import artist_eval_weights
    w = artist_eval_weights(g)
    lines = [f"# Halftone-screen audit — Lithograph vs Offset lithograph ({time.strftime('%Y-%m-%d')})", "",
             f"{len(ok)} images at ≥{args.min_px_per_mm} px/mm (sheet basis), {args.per_class} sampled per label; "
             f"score = spectral peakiness of the best native-resolution tile (log-ratio, MAD units).", ""]
    for key in ("score_max", "score_top3", "frac_tiles_screened"):
        s = np.array([r[key] for r in ok], np.float32)
        lines.append(f"- artist-weighted AUROC of `{key}` for Offset vs Lithograph labels: **{weighted_auroc(y, s, w):.3f}**")
    for lab in ("Lithograph", "Offset lithograph"):
        s = np.array([r["score_max"] for r in ok if r["label"] == lab])
        lines.append(f"- `{lab}`: score_max median {np.median(s):.1f}, p10 {np.percentile(s, 10):.1f}, p90 {np.percentile(s, 90):.1f}; "
                     f"share with a ≥2-direction screen (score ≥ 8): {np.mean([r['score_max'] >= 8 and r['peaks_max'] >= 2 for r in ok if r['label'] == lab]):.0%}")
    lines.append("")
    screened = lambda r: r["score_max"] >= 8.0 and r["peaks_max"] >= 2  # noqa: E731
    flag_litho = sorted([r for r in ok if r["label"] == "Lithograph" and screened(r)], key=lambda r: -r["score_max"])
    flag_offset = sorted([r for r in ok if r["label"] == "Offset lithograph" and not screened(r) and r["nativePxPerMm"] >= 9], key=lambda r: r["score_max"])
    lines.append(f"## `Lithograph`-labelled images with a regular screen ({len(flag_litho)}) — candidates for relabelling as offset / photolithograph")
    lines.append("| score | peaks | lpi est. | px/mm | institution | artist | image |")
    lines.append("|---:|---:|---:|---:|---|---|---|")
    for r in flag_litho[:40]:
        lines.append(f"| {r['score_max']} | {r['peaks_max']} | {r['lpi_est'] or '—'} | {r['nativePxPerMm']} | {r['institution']} | {r['artist']} | {r['imageId']} |")
    lines.append("")
    lines.append(f"## `Offset lithograph`-labelled images with NO screen at ≥ 9 px/mm ({len(flag_offset)}) — possibly hand-drawn, or screen finer than resolved")
    lines.append("| score | peaks | px/mm | institution | artist | image |")
    lines.append("|---:|---:|---:|---|---|---|")
    for r in flag_offset[:40]:
        lines.append(f"| {r['score_max']} | {r['peaks_max']} | {r['nativePxPerMm']} | {r['institution']} | {r['artist']} | {r['imageId']} |")
    md_path = args.out.replace(".jsonl", ".md")
    open(md_path, "w").write("\n".join(lines) + "\n")
    with open(args.out, "w") as f:
        for r in results:
            f.write(json.dumps({k: v for k, v in r.items() if not k.startswith("_")}) + "\n")

    # crops of the extremes, 4x zoomed, for eyeballing
    def save(r, name):
        t = r.get("_best_tile")
        if t is None:
            return
        Image.fromarray(t).resize((TILE_PX * 4, TILE_PX * 4), Image.NEAREST).save(os.path.join(args.crops_dir, name))
    for i, r in enumerate(flag_litho[:6]):
        save(r, f"litho_with_screen_{i}_score{r['score_max']}.png")
    for i, r in enumerate(flag_offset[:6]):
        save(r, f"offset_no_screen_{i}_score{r['score_max']}.png")
    typ_off = sorted([r for r in ok if r["label"] == "Offset lithograph" and screened(r)], key=lambda r: -r["score_max"])[:3]
    typ_lit = sorted([r for r in ok if r["label"] == "Lithograph" and not screened(r)], key=lambda r: r["score_max"])[:3]
    for i, r in enumerate(typ_off):
        save(r, f"typical_offset_{i}_score{r['score_max']}.png")
    for i, r in enumerate(typ_lit):
        save(r, f"typical_litho_{i}_score{r['score_max']}.png")
    print("\n".join(lines[:12]))
    print(f"wrote {args.out}, {md_path}, crops in {args.crops_dir} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
