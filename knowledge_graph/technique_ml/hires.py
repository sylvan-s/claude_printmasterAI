"""
PrintMasterAI — ADR-0019 Phase 1: native-resolution image access and physical scale.
Version: TECHML-HIRES-1.0

Three things every later phase needs and nothing in the graph recorded before 2026-09-13:

  hires_url(source_url)        the best-resolution URL a host serves for a stored sourceUrl
  fetch_dimensions(url)        (width, height, total_bytes) from a 64 KB Range request —
                               JPEG via PIL's lazy header read, WebP via its RIFF header —
                               falling back to a full GET only if the header is not in range
  px_per_mm / resolution_tier  physical scale from Impression.sheetDimensions and the tier
                               ADR-0019 Phase 1 assigns from it

Host facts (probed live 2026-09-13, recorded in ADR-0019 §Context):
  Bonhams    images{1,2}.bonhams.com/image?src=...   stored URL already serves the 2880px
             original; `&width=N` resamples (4000 is an upscale). Identity.
  Roseberys  S3 .../lot_images/large/<a>/<b>.webp      /large/ = 650px, /xlarge/ = 4000px.
  BM         media.britishmuseum.org/.../preview_X.jpg preview_ = 611px, mid_ = 1000px.
  Pompidou   images.navigart.fr/1000/...              hard cap at 1000; other sizes 404/415.
  Tate       media.tate.org.uk/.../.width-600_X.jpg   only rendition served.
"""

import io
import re
import struct
import time

import requests

USER_AGENT = "PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; non-commercial academic research)"
HEADER_BYTES = 65536

# Tier floors from ADR-0019 Phase 1: family-level needs any px/mm; aquatint / mezzotint /
# drypoint need >= 5 (what Phase 0 worked at); fine-grain confident needs >= 10.
TIER_PROCESS_PX_PER_MM = 5.0
TIER_FINE_PX_PER_MM = 10.0


def hires_url(source_url):
    """Best-resolution URL for a stored DigitalImage.sourceUrl. Identity where the stored URL
    is already the best the host serves."""
    if not source_url:
        return source_url
    if "am-s3-bucket-assets" in source_url and "/lot_images/large/" in source_url:
        return source_url.replace("/lot_images/large/", "/lot_images/xlarge/")
    if "media.britishmuseum.org" in source_url and "/preview_" in source_url:
        return source_url.replace("/preview_", "/mid_")
    return source_url


def host_of(url):
    try:
        return url.split("//", 1)[1].split("/", 1)[0]
    except (IndexError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# dimensions from a partial fetch
# ---------------------------------------------------------------------------

def _webp_dimensions(b):
    """Width/height from a WebP RIFF header (VP8, VP8L or VP8X chunk). None if not WebP."""
    if len(b) < 30 or b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    chunk = b[12:16]
    if chunk == b"VP8X":
        w = 1 + (b[24] | b[25] << 8 | b[26] << 16)
        h = 1 + (b[27] | b[28] << 8 | b[29] << 16)
        return w, h
    if chunk == b"VP8 ":
        # key frame header: 3-byte frame tag, 3-byte start code, then 14-bit w/h
        w = struct.unpack("<H", b[26:28])[0] & 0x3FFF
        h = struct.unpack("<H", b[28:30])[0] & 0x3FFF
        return w, h
    if chunk == b"VP8L":
        bits = struct.unpack("<I", b[21:25])[0]
        return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
    return None


def _dimensions_from_bytes(b):
    d = _webp_dimensions(b)
    if d:
        return d
    from PIL import Image
    im = Image.open(io.BytesIO(b))   # lazy: reads the header only, no decode
    return im.size


def fetch_dimensions(url, timeout=30, retries=3, backoff=2.0, session=None):
    """-> (width, height, total_bytes). Raises RuntimeError with the last error on failure."""
    s = session or requests
    headers = {"User-Agent": USER_AGENT, "Range": f"bytes=0-{HEADER_BYTES - 1}"}
    last = None
    for attempt in range(retries):
        try:
            r = s.get(url, headers=headers, timeout=timeout)
            if r.status_code in (200, 206):
                total = None
                cr = r.headers.get("Content-Range")
                if cr and "/" in cr:
                    total = int(cr.rsplit("/", 1)[1])
                elif r.status_code == 200:
                    total = len(r.content)
                try:
                    w, h = _dimensions_from_bytes(r.content)
                    return w, h, total
                except Exception:
                    if r.status_code == 206:   # header not in the first 64 KB — take the whole file
                        r2 = s.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
                        if r2.status_code == 200:
                            w, h = _dimensions_from_bytes(r2.content)
                            return w, h, len(r2.content)
                        last = f"HTTP {r2.status_code} on full fetch"
                    else:
                        raise
            else:
                last = f"HTTP {r.status_code}"
                if r.status_code in (403, 404, 410):
                    break   # permanent — don't hammer it
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        if attempt < retries - 1:
            time.sleep(backoff * (attempt + 1))
    raise RuntimeError(last or "unknown error")


# ---------------------------------------------------------------------------
# physical scale
# ---------------------------------------------------------------------------

_DIM_RE = re.compile(r"\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(cm|mm|in)?", re.I)


def parse_dimensions_mm(s):
    """'45.4x55.2cm' / '235x140mm' / '12x9in' -> (a_mm, b_mm), or None."""
    m = _DIM_RE.match(s or "")
    if not m:
        return None
    try:
        a, b = float(m.group(1)), float(m.group(2))
    except ValueError:
        return None
    unit = (m.group(3) or "cm").lower()
    k = {"cm": 10.0, "mm": 1.0, "in": 25.4}[unit]
    a, b = a * k, b * k
    if a <= 0 or b <= 0 or max(a, b) > 5000:
        return None
    return a, b


def px_per_mm(width_px, height_px, dims_mm):
    """Pixels per millimetre, assuming the object spans the image's long axis. This is an
    upper bound when the photograph includes a mount or frame; Phase 2 refines it from the
    localised print area."""
    if not dims_mm or not width_px or not height_px:
        return None
    return max(width_px, height_px) / max(dims_mm)


def resolution_tier(ppm):
    if ppm is None:
        return None
    if ppm >= TIER_FINE_PX_PER_MM:
        return "fine"
    if ppm >= TIER_PROCESS_PX_PER_MM:
        return "process"
    return "family"


def choose_dimensions(sheet=None, image=None, plate=None):
    """Which catalogue dimension to scale against, and its basis label. Sheet first: it is
    what the whole photographed object most nearly is; plate/image only when sheet is absent."""
    for basis, value in (("sheet", sheet), ("plate", plate), ("image", image)):
        d = parse_dimensions_mm(value)
        if d:
            return d, basis
    return None, None
