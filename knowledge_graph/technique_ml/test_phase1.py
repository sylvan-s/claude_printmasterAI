"""
Unit checks for the ADR-0019 Phase 1 modules. No network, no graph.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/test_phase1.py
"""

import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hires import (_webp_dimensions, choose_dimensions, hires_url, parse_dimensions_mm,  # noqa: E402
                   px_per_mm, resolution_tier)
from tiling import STRATA, locate_print_area, stratified_tiles  # noqa: E402


def test_hires_url():
    ros = "https://am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/roseberys/prod/lot_images/large/a/b.webp"
    assert hires_url(ros).endswith("/lot_images/xlarge/a/b.webp")
    bm = "http://media.britishmuseum.org/media/Repository/Documents/x/preview_PPA1.jpg"
    assert hires_url(bm).endswith("/mid_PPA1.jpg")
    for same in ("https://images2.bonhams.com/image?src=Images/live/2026-08/13/1-1.jpg",
                 "https://images.navigart.fr/1000/4C/35/4C35030.JPG",
                 "https://media.tate.org.uk/x/images/.width-600_J.jpg"):
        assert hires_url(same) == same
    assert hires_url(None) is None


def _close(got, want):
    return got is not None and all(abs(g - w) < 1e-6 for g, w in zip(got, want))


def test_parse_dimensions():
    assert _close(parse_dimensions_mm("45.4x55.2cm"), (454.0, 552.0))
    assert _close(parse_dimensions_mm("235x140mm"), (235.0, 140.0))
    assert _close(parse_dimensions_mm("12x9in"), (304.8, 228.6))
    assert _close(parse_dimensions_mm("22.225x11.7475cm"), (222.25, 117.475))
    assert parse_dimensions_mm("") is None and parse_dimensions_mm(None) is None
    assert parse_dimensions_mm("0x10cm") is None
    dims, basis = choose_dimensions(sheet=None, image="10x10cm", plate="20x30cm")
    assert basis == "plate" and _close(dims, (200.0, 300.0))
    assert choose_dimensions(None, None, None) == (None, None)


def test_scale_and_tier():
    assert abs(px_per_mm(2880, 2880, (454.0, 552.0)) - 2880 / 552) < 1e-9
    assert px_per_mm(0, 0, (1, 1)) is None and px_per_mm(10, 10, None) is None
    assert resolution_tier(None) is None
    assert resolution_tier(2.5) == "family" and resolution_tier(5.0) == "process" and resolution_tier(10.0) == "fine"


def test_webp_header():
    vp8x = b"RIFF" + struct.pack("<I", 100) + b"WEBP" + b"VP8X" + struct.pack("<I", 10) + b"\x00" * 4 \
        + bytes([3999 & 255, 3999 >> 8 & 255, 3999 >> 16]) + bytes([4583 & 255, 4583 >> 8 & 255, 4583 >> 16]) + b"\x00" * 10
    assert _webp_dimensions(vp8x) == (4000, 4584)
    assert _webp_dimensions(b"\xff\xd8\xff" + b"\x00" * 40) is None


def _synthetic_print(W=1200, H=900):
    """Grey mat, white sheet, textured print area in the middle."""
    rng = np.random.default_rng(0)
    im = np.full((H, W, 3), 160, np.uint8)                 # mat
    im[100:800, 150:1050] = 245                            # sheet
    tex = (rng.random((500, 640)) > 0.5).astype(np.uint8) * 90 + 120   # print area
    im[200:700, 280:920] = tex[..., None]
    im[400:500, 400:500] = 20                              # a dark mass
    return Image.fromarray(im)


def test_localiser_finds_print_area():
    im = _synthetic_print()
    (x0, y0, x1, y1), diag = locate_print_area(im)
    assert not diag["fallback"], diag
    # inside the textured region [280,920]x[200,700] with the 3% inward margin
    assert 280 <= x0 <= 330 and 880 <= x1 <= 920, (x0, x1)
    assert 200 <= y0 <= 240 and 665 <= y1 <= 700, (y0, y1)


def test_stratified_tiles_shape_and_strata():
    im = _synthetic_print()
    box, _ = locate_print_area(im)
    tiles = stratified_tiles(im, box, native_px_per_mm=8.0, target_px_per_mm=5.6)
    assert 1 <= len(tiles) <= 16
    for t in tiles:
        assert t["tile"].shape == (224, 224, 3) and t["tile"].dtype == np.uint8
        assert t["stratum"] in STRATA + ("fill",)
        assert abs(t["px_per_mm"] - 5.6) < 1e-9
    assert any(t["stratum"] == "darkest" for t in tiles)
    # never upsample: coarser native than target keeps native scale
    tiles2 = stratified_tiles(im, box, native_px_per_mm=3.0, target_px_per_mm=5.6)
    assert all(abs(t["px_per_mm"] - 3.0) < 1e-9 for t in tiles2)
    # tiny area -> no tiles
    assert stratified_tiles(im, (0, 0, 100, 100), 5.6, 5.6) == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"{len(fns)} passed")
