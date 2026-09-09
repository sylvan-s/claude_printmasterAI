"""
PrintMasterAI — degraded ("noisy") copies of the backtest image pool
Version: NOISYPOOL-1.0

Takes the stratified backtest pool (tests/backtest/test_pool_100.json), downloads each
lot's image once, and writes a set of *degraded copies* of that image — one per recipe —
so the pipeline can be run against realistic bad photography instead of the auction
house's clean studio shot.

The pool JSON is copied verbatim per recipe with only `imageUrl` rewritten to a local
`file://` path, so `npm run test:pool -- --pool <path>` runs the identical lots, the
identical ground truth and the identical Stage 1c notes against a worse image. Anything
that moves between the clean run and a degraded run is attributable to the image alone.

Recipes (--list to print the parameters):

  pristine      control — same decode/re-encode path, no degradation
  lowres        genuinely small image (384px long edge) + moderate JPEG
  defocus       out of focus: Gaussian blur scaled to the image
  glare         specular blob + a soft light streak, geometry untouched
  angle         photographed off-axis: yaw/pitch/roll, keystoned onto a surface
  framed        mount board + moulding around the print, shot straight on
  framed_glass  framed, behind glass, with a window reflection and a slight tilt
  phone_snap    the composite worst case — tilt, uneven light, mild defocus,
                sensor noise, warm cast, downscale, low-quality JPEG

Every recipe is seeded from (lot id, recipe name), so a lot's degradation is random
across the pool but identical on every re-run — the same reproducibility contract as
build_test_pool.py.

Usage:
    python3 knowledge_graph/build_noisy_pool.py                       # all recipes, whole pool
    python3 knowledge_graph/build_noisy_pool.py --recipes angle,glare --limit 10
    python3 knowledge_graph/build_noisy_pool.py --contact-sheet       # + per-lot comparison strips
    python3 knowledge_graph/build_noisy_pool.py --list                # show recipe parameters

Then:
    npm run test:pool -- --pool tests/backtest/noisy_pool/pools/test_pool_100_angle.json \
                         --out tests/backtest/pool_output_angle --limit 99

Requires Pillow + numpy: knowledge_graph/venv-embeddings/bin/python has both.
"""

import argparse
import hashlib
import io
import json
import os
import random
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_POOL = os.path.join(REPO, "tests", "backtest", "test_pool_100.json")
DEFAULT_OUT = os.path.join(REPO, "tests", "backtest", "noisy_pool")

# run_pool.ts rejects anything outside this band before it reaches the model.
MIN_IMAGE_BYTES = 6_000
MAX_IMAGE_BYTES = 4_400_000

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PrintMasterAI-noisy-pool/1.0"


# ── geometry ─────────────────────────────────────────────────────────────────


def _rot(yaw, pitch, roll):
    """Camera-relative rotation of the picture plane, degrees -> 3x3."""
    y, p, r = np.radians([yaw, pitch, roll])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
    rz = np.array([[np.cos(r), -np.sin(r), 0], [np.sin(r), np.cos(r), 0], [0, 0, 1]])
    return rz @ ry @ rx


def _perspective_coeffs(src_quad, dst_quad):
    """Coefficients for Image.transform(PERSPECTIVE): output (dst) -> input (src)."""
    rows, rhs = [], []
    for (sx, sy), (dx, dy) in zip(src_quad, dst_quad):
        rows.append([dx, dy, 1, 0, 0, 0, -dx * sx, -dy * sx])
        rows.append([0, 0, 0, dx, dy, 1, -dx * sy, -dy * sy])
        rhs += [sx, sy]
    return np.linalg.solve(np.array(rows, float), np.array(rhs, float))


def tilt(img, yaw, pitch, roll, margin=0.08, focal_mult=2.2):
    """Project the picture plane through a pinhole camera at yaw/pitch/roll.

    Returns RGBA the same size as the input, the print keystoned and centred, everything
    outside it transparent — so the caller decides what surface it is lying on.
    """
    w, h = img.size
    f = focal_mult * max(w, h)
    corners = np.array([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], float)
    pts = corners @ _rot(yaw, pitch, roll).T
    pts[:, 2] += f
    proj = np.stack([f * pts[:, 0] / pts[:, 2], f * pts[:, 1] / pts[:, 2]], axis=1)

    # fit the projected quad into the canvas with a margin
    lo, hi = proj.min(axis=0), proj.max(axis=0)
    scale = min(w * (1 - 2 * margin) / (hi[0] - lo[0]), h * (1 - 2 * margin) / (hi[1] - lo[1]))
    dst = (proj - (lo + hi) / 2) * scale + np.array([w / 2, h / 2])

    src = [(0, 0), (w, 0), (w, h), (0, h)]
    coeffs = _perspective_coeffs(src, [tuple(p) for p in dst])
    return img.convert("RGBA").transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(0, 0, 0, 0))


# ── surfaces, light, optics ──────────────────────────────────────────────────


def surface(size, rng, base=None):
    """A plausible thing to be lying on / hanging against: flat tone, soft gradient."""
    w, h = size
    base = base or (rng.randint(126, 168),) * 3
    base = tuple(min(255, max(0, c + rng.randint(-6, 6))) for c in base)
    grad = np.linspace(-14, 14, h)[:, None] + np.linspace(-10, 10, w)[None, :]
    arr = np.clip(np.array(base, float)[None, None, :] + grad[:, :, None], 0, 255)
    return Image.fromarray(arr.astype(np.uint8))


def on_surface(rgba, rng, base=None, shadow=True):
    """Composite a transparent-background plate onto a surface, with a contact shadow."""
    bg = surface(rgba.size, rng, base)
    if shadow:
        alpha = rgba.split()[3]
        off = max(2, rgba.size[0] // 220)
        sh = Image.new("L", rgba.size, 0)
        sh.paste(alpha, (off, off))
        sh = sh.filter(ImageFilter.GaussianBlur(off * 3))
        bg = Image.composite(Image.new("RGB", rgba.size, (48, 46, 44)), bg, sh.point(lambda v: int(v * 0.55)))
    bg.paste(rgba, (0, 0), rgba)
    return bg


def defocus(img, strength):
    """Out of focus. `strength` is blur sigma as a fraction of the long edge."""
    return img.filter(ImageFilter.GaussianBlur(max(0.6, max(img.size) * strength)))


def glare(img, rng, blobs=1, streaks=1, blob_gain=0.62, streak_gain=0.34):
    """Specular highlights: soft elliptical hot spots plus low-angle light streaks.

    Screen-blended, so it washes detail out towards white the way a real reflection does
    rather than simply lightening everything.
    """
    w, h = img.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)

    for _ in range(blobs):
        cx, cy = rng.uniform(0.15, 0.85) * w, rng.uniform(0.12, 0.7) * h
        rx, ry = rng.uniform(0.12, 0.3) * w, rng.uniform(0.08, 0.22) * h
        blob = Image.new("L", (w, h), 0)
        ImageDraw.Draw(blob).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=int(255 * blob_gain))
        blob = blob.rotate(rng.uniform(0, 180), center=(cx, cy))
        layer = Image.fromarray(np.maximum(np.array(layer), np.array(blob)))

    for _ in range(streaks):
        band = Image.new("L", (w, h), 0)
        bw = rng.uniform(0.1, 0.2) * w
        x0 = rng.uniform(-0.1, 0.75) * w
        ImageDraw.Draw(band).polygon(
            [(x0, -h), (x0 + bw, -h), (x0 + bw + w * 0.5, 2 * h), (x0 + w * 0.5, 2 * h)],
            fill=int(255 * streak_gain),
        )
        band = band.rotate(rng.uniform(-12, 12), center=(w / 2, h / 2))
        layer = Image.fromarray(np.maximum(np.array(layer), np.array(band)))

    layer = layer.filter(ImageFilter.GaussianBlur(max(w, h) * 0.035))
    base = np.asarray(img.convert("RGB"), float) / 255.0
    g = (np.asarray(layer, float) / 255.0)[:, :, None]
    return Image.fromarray((255 * (1 - (1 - base) * (1 - g))).astype(np.uint8))


def window_reflection(img, rng, gain=0.30):
    """The signature 'it is behind glass' artefact: a mullioned window pane, off-axis."""
    w, h = img.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    pw, ph = rng.uniform(0.3, 0.45) * w, rng.uniform(0.3, 0.5) * h
    x0, y0 = rng.uniform(0.05, 0.4) * w, rng.uniform(0.03, 0.3) * h
    skew = rng.uniform(0.08, 0.22) * pw
    d.polygon([(x0, y0), (x0 + pw, y0 - skew), (x0 + pw + skew * 0.6, y0 + ph), (x0 + skew * 0.3, y0 + ph + skew)],
              fill=int(255 * gain))
    bar = max(2, int(w * 0.008))
    d.line([(x0 + pw / 2, y0), (x0 + pw / 2 + skew * 0.5, y0 + ph)], fill=0, width=bar * 2)
    d.line([(x0, y0 + ph / 2), (x0 + pw + skew * 0.6, y0 + ph / 2 - skew * 0.4)], fill=0, width=bar * 2)
    layer = layer.filter(ImageFilter.GaussianBlur(max(w, h) * 0.012))
    base = np.asarray(img.convert("RGB"), float) / 255.0
    g = (np.asarray(layer, float) / 255.0)[:, :, None]
    return Image.fromarray((255 * (1 - (1 - base) * (1 - g))).astype(np.uint8))


def uneven_light(img, rng, drop=0.42, vignette=0.22):
    """One lamp, off to a side, plus lens vignetting."""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = rng.uniform(0.1, 0.9) * w, rng.uniform(0.1, 0.9) * h
    r = np.hypot((xx - cx) / w, (yy - cy) / h) / 1.2
    lamp = 1.0 - drop * np.clip(r, 0, 1) ** 1.4
    rv = np.hypot((xx - w / 2) / w, (yy - h / 2) / h) / 0.71
    vig = 1.0 - vignette * np.clip(rv, 0, 1) ** 2.2
    arr = np.asarray(img.convert("RGB"), float) * (lamp * vig)[:, :, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def colour_cast(img, rng, strength=0.06):
    """Auto white balance losing to tungsten/daylight."""
    gains = np.array([1 + rng.uniform(0.4, 1.0) * strength, 1.0, 1 - rng.uniform(0.4, 1.0) * strength])
    if rng.random() < 0.35:
        gains = gains[::-1]  # cool cast instead
    arr = np.asarray(img.convert("RGB"), float) * gains[None, None, :]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def sensor_noise(img, nprng, sigma=5.0):
    arr = np.asarray(img.convert("RGB"), float)
    arr = arr + nprng.normal(0, sigma, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def downscale(img, long_edge):
    w, h = img.size
    if max(w, h) <= long_edge:
        return img
    s = long_edge / max(w, h)
    return img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


def recompress(img, quality):
    """Bake in JPEG artefacts mid-pipeline (the final save is separate)."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


# ── framing ──────────────────────────────────────────────────────────────────

MOULDINGS = [
    ((58, 41, 28), (96, 71, 50)),    # dark wood
    ((26, 25, 27), (62, 60, 62)),    # black
    ((166, 133, 66), (214, 187, 122)),  # gilt
    ((168, 141, 104), (203, 180, 145)),  # natural oak
]


def frame(img, rng, mount=0.10, moulding=0.045):
    """Mount board + moulding around the print, seen straight on."""
    img = img.convert("RGB")
    w, h = img.size
    m = max(8, int(min(w, h) * mount * rng.uniform(0.8, 1.25)))
    f = max(6, int(min(w, h) * moulding * rng.uniform(0.8, 1.3)))
    W, H = w + 2 * (m + f), h + 2 * (m + f)

    dark, light = MOULDINGS[rng.randrange(len(MOULDINGS))]
    out = Image.new("RGB", (W, H), dark)
    d = ImageDraw.Draw(out)
    # moulding: light on the top-left face, dark on the bottom-right
    d.polygon([(0, 0), (W, 0), (W - f, f), (f, f)], fill=light)
    d.polygon([(0, 0), (f, f), (f, H - f), (0, H)], fill=tuple(int(c * 0.9) for c in light))
    d.rectangle([f - 1, f - 1, W - f, H - f], fill=(0, 0, 0))

    board = tuple(min(255, c + rng.randint(-8, 4)) for c in (247, 243, 235))
    d.rectangle([f, f, W - f - 1, H - f - 1], fill=board)
    d.rectangle([f, f, W - f - 1, H - f - 1], outline=tuple(int(c * 0.82) for c in board), width=max(1, f // 6))

    out.paste(img, (m + f, m + f))
    # shadow cast by the mount's bevelled window onto the print edge — a soft band on the
    # opening itself, not over the whole board
    ring = Image.new("L", (W, H), 0)
    ImageDraw.Draw(ring).rectangle([m + f, m + f, W - m - f - 1, H - m - f - 1], outline=255, width=max(3, f // 2))
    ring = ring.filter(ImageFilter.GaussianBlur(max(2, f // 3)))
    out.paste(Image.new("RGB", (W, H), (84, 78, 70)), (0, 0), ring.point(lambda v: int(v * 0.42)))
    d.rectangle([m + f - 1, m + f - 1, W - m - f, H - m - f], outline=(188, 181, 170), width=1)
    return out


# ── recipes ──────────────────────────────────────────────────────────────────


def r_pristine(img, rng, nprng):
    return img.convert("RGB")


def r_lowres(img, rng, nprng):
    return recompress(downscale(img.convert("RGB"), rng.randint(340, 430)), rng.randint(58, 72))


def r_defocus(img, rng, nprng):
    return defocus(img.convert("RGB"), rng.uniform(0.0035, 0.0075))


def r_glare(img, rng, nprng):
    return glare(img.convert("RGB"), rng, blobs=rng.randint(1, 2), streaks=1)


def r_angle(img, rng, nprng):
    plate = tilt(img, yaw=rng.uniform(-26, 26) or 14, pitch=rng.uniform(-13, 13), roll=rng.uniform(-5, 5))
    return on_surface(plate, rng)


def r_framed(img, rng, nprng):
    return frame(img, rng)


def r_framed_glass(img, rng, nprng):
    framed = frame(img, rng)
    plate = tilt(framed, yaw=rng.uniform(-16, 16), pitch=rng.uniform(-9, 9), roll=rng.uniform(-3, 3), margin=0.05)
    on_wall = on_surface(plate, rng, base=(196, 191, 182))
    lit = window_reflection(on_wall, rng, gain=rng.uniform(0.34, 0.52))
    return glare(lit, rng, blobs=1, streaks=0, blob_gain=rng.uniform(0.25, 0.45))


def r_phone_snap(img, rng, nprng):
    base = img.convert("RGB")
    plate = tilt(base, yaw=rng.uniform(-22, 22), pitch=rng.uniform(-12, 12), roll=rng.uniform(-6, 6))
    out = on_surface(plate, rng)
    out = uneven_light(out, rng, drop=rng.uniform(0.3, 0.5))
    out = colour_cast(out, rng, strength=rng.uniform(0.04, 0.09))
    out = defocus(out, rng.uniform(0.0018, 0.0038))
    out = glare(out, rng, blobs=1, streaks=1, blob_gain=rng.uniform(0.25, 0.45), streak_gain=rng.uniform(0.15, 0.3))
    out = downscale(out, rng.randint(720, 1100))
    out = sensor_noise(out, nprng, sigma=rng.uniform(3.5, 7.0))
    return recompress(out, rng.randint(40, 55))


def r_mixed(img, rng, nprng):
    """A random *combination* of the primitives, not a single named effect.

    Each lot draws its own subset and its own severities, so the 99 mixed images span the
    space of real-world bad photography instead of testing one axis at a time. Applied in
    physical order — the print is framed before it is photographed, the photograph is
    blurred before the sensor adds noise, JPEG is last.

    Draw (seeded per lot):
      framing     35%  bare | mount+moulding
      geometry    75%  off-axis tilt, severity scaled by a difficulty roll
      lighting    55%  uneven lamp, and 30% a colour cast on top
      glare       60%  specular blobs/streaks; a window reflection only if framed
      optics      50%  defocus
      capture     45%  downscale;  40% sensor noise;  70% lossy JPEG
    The `severity` roll (0-1) scales every magnitude, so the pool contains genuinely mild
    cases and genuinely brutal ones rather than 99 samples of the same middling badness.
    """
    sev = rng.random()  # 0 = barely touched, 1 = worst case
    applied = []
    out = img.convert("RGB")

    framed_now = rng.random() < 0.35
    if framed_now:
        out = frame(out, rng, mount=rng.uniform(0.06, 0.13), moulding=rng.uniform(0.03, 0.06))
        applied.append("frame")

    if rng.random() < 0.75:
        amp = 6 + 22 * sev
        plate = tilt(out, yaw=rng.uniform(-amp, amp), pitch=rng.uniform(-amp * 0.5, amp * 0.5),
                     roll=rng.uniform(-amp * 0.25, amp * 0.25), margin=0.05 + 0.05 * rng.random())
        base = (196, 191, 182) if framed_now else None  # a wall if it is hanging, a table if not
        out = on_surface(plate, rng, base=base)
        applied.append("tilt")

    if rng.random() < 0.55:
        out = uneven_light(out, rng, drop=0.15 + 0.4 * sev, vignette=0.1 + 0.2 * sev)
        applied.append("uneven_light")
    if rng.random() < 0.30:
        out = colour_cast(out, rng, strength=0.03 + 0.07 * sev)
        applied.append("colour_cast")

    if framed_now and rng.random() < 0.6:
        out = window_reflection(out, rng, gain=0.2 + 0.35 * sev)
        applied.append("window_reflection")
    if rng.random() < 0.6:
        out = glare(out, rng, blobs=rng.randint(1, 2), streaks=rng.randint(0, 1),
                    blob_gain=0.2 + 0.5 * sev, streak_gain=0.12 + 0.3 * sev)
        applied.append("glare")

    if rng.random() < 0.5:
        out = defocus(out, 0.0012 + 0.006 * sev)
        applied.append("defocus")

    if rng.random() < 0.45:
        out = downscale(out, int(1400 - 1000 * sev))
        applied.append("downscale")
    if rng.random() < 0.40:
        out = sensor_noise(out, nprng, sigma=2 + 7 * sev)
        applied.append("sensor_noise")
    if rng.random() < 0.70:
        out = recompress(out, int(85 - 40 * sev))
        applied.append("jpeg")

    if not applied:  # never hand back an untouched image from the "noisy" pool
        out = defocus(out, 0.002)
        applied.append("defocus")
    return out, {"severity": round(sev, 3), "applied": applied}


RECIPES = {
    "mixed": (r_mixed, 80, "random combination of every primitive, severity-scaled per lot"),
    "pristine": (r_pristine, 92, "control — same decode/re-encode path, no degradation"),
    "lowres": (r_lowres, 78, "340-430px long edge, JPEG q58-72"),
    "defocus": (r_defocus, 90, "Gaussian blur, sigma 0.35-0.75% of the long edge"),
    "glare": (r_glare, 90, "1-2 specular blobs + one light streak, screen-blended"),
    "angle": (r_angle, 88, "yaw +/-26, pitch +/-13, roll +/-5, on a grey surface with a contact shadow"),
    "framed": (r_framed, 90, "mount board (10%) + moulding (4.5%), straight on"),
    "framed_glass": (r_framed_glass, 88, "framed + tilted on a wall + mullioned window reflection + one hot spot"),
    "phone_snap": (r_phone_snap, 62, "tilt + uneven light + cast + mild defocus + glare + downscale + noise + q40-55"),
}


# ── driver ───────────────────────────────────────────────────────────────────


def lot_id(lot):
    return f"{lot['saleId']}_{lot['lotNumber']}"


def seed_for(lot, recipe):
    return int(hashlib.sha256(f"{lot_id(lot)}|{recipe}".encode()).hexdigest()[:12], 16)


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > MIN_IMAGE_BYTES:
        return
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def save_jpeg(img, path, quality):
    """Save under run_pool.ts's 4.5MB ceiling, stepping quality down rather than resizing."""
    q = quality
    while True:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=q, subsampling=1 if q >= 70 else 2)
        if buf.tell() <= MAX_IMAGE_BYTES or q <= 35:
            break
        q -= 8
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return buf.tell(), q


def contact_sheet(source, variants, path, cell=380):
    """One strip per lot: the original next to every degraded copy, labelled."""
    tiles = [("source", source)] + variants
    thumbs = []
    for name, im in tiles:
        t = Image.new("RGB", (cell, cell + 26), (24, 24, 26))
        im = im.copy()
        im.thumbnail((cell - 12, cell - 12), Image.LANCZOS)
        t.paste(im, ((cell - im.size[0]) // 2, (cell - im.size[1]) // 2))
        ImageDraw.Draw(t).text((8, cell + 6), name, fill=(232, 230, 226))
        thumbs.append(t)
    sheet = Image.new("RGB", (cell * len(thumbs), cell + 26), (24, 24, 26))
    for i, t in enumerate(thumbs):
        sheet.paste(t, (i * cell, 0))
    sheet.save(path, "JPEG", quality=84)


def main():
    ap = argparse.ArgumentParser(description="Build degraded copies of the backtest image pool")
    ap.add_argument("--pool", default=DEFAULT_POOL, help="source pool JSON (default: tests/backtest/test_pool_100.json)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output root (default: tests/backtest/noisy_pool)")
    ap.add_argument("--recipes", default="", help="comma-separated subset (default: all)")
    ap.add_argument("--limit", type=int, default=0, help="first N lots only (0 = whole pool)")
    ap.add_argument("--jobs", type=int, default=6, help="parallel workers")
    ap.add_argument("--contact-sheet", action="store_true", help="also write a per-lot comparison strip")
    ap.add_argument("--force", action="store_true", help="rebuild variants that already exist")
    ap.add_argument("--list", action="store_true", help="print the recipes and exit")
    args = ap.parse_args()

    if args.list:
        for name, (_, q, desc) in RECIPES.items():
            print(f"  {name:<14} q{q:<3} {desc}")
        return 0

    names = [r.strip() for r in args.recipes.split(",") if r.strip()] or list(RECIPES)
    unknown = [r for r in names if r not in RECIPES]
    if unknown:
        sys.exit(f"unknown recipe(s): {', '.join(unknown)} (known: {', '.join(RECIPES)})")

    with open(args.pool, encoding="utf-8") as f:
        pool = json.load(f)
    pool = [l for l in pool if l.get("imageUrl")]
    if args.limit:
        pool = pool[: args.limit]

    src_dir = os.path.join(args.out, "_source")
    sheet_dir = os.path.join(args.out, "contact_sheets")
    os.makedirs(src_dir, exist_ok=True)
    for r in names:
        os.makedirs(os.path.join(args.out, "images", r), exist_ok=True)
    os.makedirs(os.path.join(args.out, "pools"), exist_ok=True)
    if args.contact_sheet:
        os.makedirs(sheet_dir, exist_ok=True)

    print(f"{len(pool)} lots x {len(names)} recipes -> {args.out}")
    manifest, failures = {}, []

    def build(lot):
        lid = lot_id(lot)
        ext = os.path.splitext(lot["imageUrl"].split("?")[0])[1].lower() or ".jpg"
        src_path = os.path.join(src_dir, lid + ext)
        try:
            download(lot["imageUrl"], src_path)
            source = Image.open(src_path)
            source.load()
        except Exception as e:  # noqa: BLE001 — one dead CDN link must not stop the build
            failures.append((lid, "download", repr(e)))
            print(f"  FAIL {lid:<14} download: {e}")
            return None

        made, tiles = {}, []
        for r in names:
            fn, quality, _ = RECIPES[r]
            out_path = os.path.join(args.out, "images", r, lid + ".jpg")
            if os.path.exists(out_path) and not args.force and not args.contact_sheet:
                made[r] = out_path
                continue
            seed = seed_for(lot, r)
            try:
                built_img = fn(source, random.Random(seed), np.random.default_rng(seed))
            except Exception as e:  # noqa: BLE001
                failures.append((lid, r, repr(e)))
                print(f"  FAIL {lid:<14} {r}: {e}")
                continue
            # a recipe may return (image, meta) to record what it randomly drew
            img, meta = built_img if isinstance(built_img, tuple) else (built_img, {})
            size, used_q = save_jpeg(img, out_path, quality)
            if size < MIN_IMAGE_BYTES:
                failures.append((lid, r, f"{size}B — under run_pool.ts's {MIN_IMAGE_BYTES}B floor"))
                print(f"  WARN {lid:<14} {r}: only {size}B, run_pool.ts will reject it")
            made[r] = out_path
            if args.contact_sheet:
                tiles.append((r, img))
            manifest[f"{lid}/{r}"] = {"path": os.path.relpath(out_path, args.out), "bytes": size,
                                      "quality": used_q, "seed": seed, "px": list(img.size), **meta}
        if args.contact_sheet and tiles:
            contact_sheet(source.convert("RGB"), tiles, os.path.join(sheet_dir, lid + ".jpg"))
        print(f"  ok   {lid:<14} {source.size[0]}x{source.size[1]}  {len(made)} variants")
        return lid, made

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        results = [r for r in ex.map(build, pool) if r]

    built = dict(results)
    for r in names:
        variant = []
        for lot in pool:
            paths = built.get(lot_id(lot))
            if not paths or r not in paths:
                continue
            copy = dict(lot)
            copy["imageUrl"] = "file://" + os.path.abspath(paths[r])
            copy["sourceImageUrl"] = lot["imageUrl"]
            copy["degradation"] = r
            variant.append(copy)
        p = os.path.join(args.out, "pools", f"test_pool_100_{r}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(variant, f, indent=2, ensure_ascii=False)
        print(f"wrote {p}  ({len(variant)} lots)")

    with open(os.path.join(args.out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "NOISYPOOL-1.0", "sourcePool": os.path.relpath(args.pool, REPO),
                   "recipes": {r: RECIPES[r][2] for r in names}, "variants": manifest,
                   "failures": [{"lot": a, "stage": b, "error": c} for a, b, c in failures]},
                  f, indent=2, ensure_ascii=False)
    if failures:
        print(f"\n{len(failures)} failure(s) — see MANIFEST.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
