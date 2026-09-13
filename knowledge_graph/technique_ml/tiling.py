"""
PrintMasterAI — ADR-0019 Phase 1: print-area localisation and content-stratified tiles.
Version: TECHML-TILING-1.0

Phase 0 took a 4x4 grid from the central 60% of the photograph with no localiser, so mat,
frame and backdrop tiles entered as noise and tiles landed on tone regions by chance. The
research note (docs/research/intaglio-technique-visual-cues-2026-09-13.md §5) ranks fixing
that as the highest-value change. Two functions:

  locate_print_area(im)   bounding box of the printed image on a downsampled copy, from a
                          local-variance map: the printed area is textured, the mat and the
                          paper margin are flat. Falls back to the central 80% when the map
                          is uninformative.

  stratified_tiles(im, box, native_px_per_mm, target_px_per_mm)
                          16 tiles of 224 px at a fixed physical scale, chosen by content:
                            flat_midtone   aquatint reticulation, mezzotint ground, litho tint
                            edge_dense     line syntax, burr halos
                            darkest        massed burr, mezzotint blacks, plate tone
                            edge_band      the print's border, for the plate mark
                          Tiles that are > 90% paper-white are excluded — they carry the
                          photographer's lighting and paper colour, not the process. Every
                          tile carries its stratum so attention weights stay interpretable.

numpy + PIL only; no scipy/cv2 in venv-embeddings.
"""

from collections import deque

import numpy as np
from PIL import Image

TILE_PX = 224
N_PER_STRATUM = 4
STRATA = ("flat_midtone", "edge_dense", "darkest", "edge_band")


# ---------------------------------------------------------------------------
# localiser
# ---------------------------------------------------------------------------

def _otsu(values):
    v = values[np.isfinite(values)]
    if v.size < 2:
        return float(np.median(values)) if values.size else 0.0
    hist, edges = np.histogram(v, bins=64)
    mids = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist).astype(np.float64)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * mids) / np.maximum(w0, 1e-9)
    m1 = (np.cumsum((hist * mids)[::-1])[::-1] - hist * mids) / np.maximum(w1, 1e-9)
    between = w0[:-1] * w1[:-1] * (m0[:-1] - m1[1:]) ** 2
    return float(mids[int(np.argmax(between))])


def _largest_component(mask):
    """4-connected largest True component of a small 2-D bool array -> bool mask."""
    H, W = mask.shape
    seen = np.zeros_like(mask, bool)
    best, best_n = None, 0
    for y0 in range(H):
        for x0 in range(W):
            if not mask[y0, x0] or seen[y0, x0]:
                continue
            comp, q = [], deque([(y0, x0)])
            seen[y0, x0] = True
            while q:
                y, x = q.popleft()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(comp) > best_n:
                best, best_n = comp, len(comp)
    out = np.zeros_like(mask, bool)
    if best:
        ys, xs = zip(*best)
        out[list(ys), list(xs)] = True
    return out


def _dilate(m):
    p = np.pad(m, 1)
    return (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | m)


def _erode(m):
    p = np.pad(m, 1, constant_values=True)
    return (p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:] & m)


def locate_print_area(im, long_edge=512, block=8, margin=0.03):
    """-> (x0, y0, x1, y1) in full-resolution pixel coordinates, plus a dict of diagnostics."""
    W, H = im.size
    s = long_edge / max(W, H)
    small = im.convert("L").resize((max(block, int(W * s)), max(block, int(H * s))), Image.BILINEAR)
    g = np.asarray(small, np.float32) / 255.0
    h, w = (g.shape[0] // block) * block, (g.shape[1] // block) * block
    g = g[:h, :w]
    blocks = g.reshape(h // block, block, w // block, block).transpose(0, 2, 1, 3).reshape(h // block, w // block, -1)
    local_std = blocks.std(-1)
    # local gradient adds sensitivity to fine line work that a flat-tone std misses
    gy, gx = np.gradient(g)
    grad = np.sqrt(gx ** 2 + gy ** 2)
    local_grad = grad[:h, :w].reshape(h // block, block, w // block, block).transpose(0, 2, 1, 3).reshape(h // block, w // block, -1).mean(-1)
    tex = np.log1p(50 * local_std) + np.log1p(50 * local_grad)
    thr = _otsu(tex)
    mask = tex > thr
    mask = _erode(_dilate(mask))           # close single-block gaps
    comp = _largest_component(mask)
    frac = comp.mean()
    diag = {"threshold": thr, "component_fraction": float(frac), "fallback": False}
    if frac < 0.08 or frac > 0.97:
        diag["fallback"] = True
        x0, y0, x1, y1 = int(W * 0.1), int(H * 0.1), int(W * 0.9), int(H * 0.9)
        return (x0, y0, x1, y1), diag
    ys, xs = np.where(comp)
    bx0, by0, bx1, by1 = xs.min() * block, ys.min() * block, (xs.max() + 1) * block, (ys.max() + 1) * block
    # back to full-res, then shrink inward so the sheet edge / mat bevel is excluded
    x0, y0, x1, y1 = bx0 / s, by0 / s, bx1 / s, by1 / s
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    box = (int(max(0, x0 + mx)), int(max(0, y0 + my)), int(min(W, x1 - mx)), int(min(H, y1 - my)))
    return box, diag


# ---------------------------------------------------------------------------
# stratified tiles
# ---------------------------------------------------------------------------

def _iou(a, b):
    ix0, iy0, ix1, iy1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if inter == 0:
        return 0.0
    area = (a[2] - a[0]) * (a[3] - a[1])
    return inter / (2 * area - inter)


def stratified_tiles(im, box, native_px_per_mm, target_px_per_mm, tile_px=TILE_PX,
                     n_per_stratum=N_PER_STRATUM, white_frac_max=0.85, seed=0):
    """-> list of dicts {tile: HxWx3 uint8, stratum, x, y, px_per_mm}; the coordinates are in
    the resampled crop. Never upsamples: if the native scale is coarser than the target the
    crop is used at native scale and px_per_mm reports what was actually used. Returns []
    when the localised area is smaller than one tile."""
    rng = np.random.default_rng(seed)
    x0, y0, x1, y1 = box
    crop = im.crop((x0, y0, x1, y1)).convert("RGB")
    used = min(native_px_per_mm, target_px_per_mm) if native_px_per_mm else target_px_per_mm
    scale = used / native_px_per_mm if native_px_per_mm else 1.0
    if scale < 1.0:
        crop = crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))), Image.LANCZOS)
    W, H = crop.size
    if W < tile_px or H < tile_px:
        return []
    arr = np.asarray(crop)
    gray = arr.mean(-1) / 255.0
    paper_white = float(np.percentile(gray, 95))
    gy, gx = np.gradient(gray)
    edge = np.sqrt(gx ** 2 + gy ** 2)

    stride = tile_px // 2
    xs = list(range(0, W - tile_px + 1, stride))
    ys = list(range(0, H - tile_px + 1, stride))
    if xs[-1] != W - tile_px:
        xs.append(W - tile_px)
    if ys[-1] != H - tile_px:
        ys.append(H - tile_px)
    cands = []
    for y in ys:
        for x in xs:
            g = gray[y:y + tile_px, x:x + tile_px]
            white = float((g > paper_white * 0.92).mean())
            if white > white_frac_max:
                continue
            cands.append({
                "x": x, "y": y, "mean": float(g.mean()),
                "edge": float(edge[y:y + tile_px, x:x + tile_px].mean()),
                "white": white,
                "border": x == xs[0] or y == ys[0] or x == xs[-1] or y == ys[-1],
            })
    if not cands:
        return []
    edges_all = np.array([c["edge"] for c in cands])
    lo_edge, hi_edge = np.percentile(edges_all, 40), np.percentile(edges_all, 60)

    def pick(pool, key, n, chosen):
        out = []
        for c in sorted(pool, key=key):
            b = (c["x"], c["y"], c["x"] + tile_px, c["y"] + tile_px)
            if all(_iou(b, (d["x"], d["y"], d["x"] + tile_px, d["y"] + tile_px)) < 0.25 for d in chosen + out):
                out.append(c)
            if len(out) >= n:
                break
        return out

    chosen = []
    plan = [
        ("flat_midtone", [c for c in cands if not c["border"] and c["edge"] <= lo_edge and 0.2 <= c["mean"] <= 0.8],
         lambda c: c["edge"]),
        ("edge_dense", [c for c in cands if c["edge"] >= hi_edge], lambda c: -c["edge"]),
        ("darkest", list(cands), lambda c: c["mean"]),
        ("edge_band", [c for c in cands if c["border"]], lambda c: -c["edge"]),
    ]
    for name, pool, key in plan:
        got = pick(pool, key, n_per_stratum, chosen)
        for c in got:
            c["stratum"] = name
        chosen += got
    want = n_per_stratum * len(STRATA)
    if len(chosen) < want:   # fill from whatever is left, most textured first, random tie-break
        rest = [c for c in cands if "stratum" not in c]
        rng.shuffle(rest)
        for c in pick(rest, lambda c: -c["edge"], want - len(chosen), chosen):
            c["stratum"] = "fill"
            chosen.append(c)
    return [{"tile": arr[c["y"]:c["y"] + tile_px, c["x"]:c["x"] + tile_px].copy(), "stratum": c["stratum"],
             "x": c["x"], "y": c["y"], "px_per_mm": used} for c in chosen]
