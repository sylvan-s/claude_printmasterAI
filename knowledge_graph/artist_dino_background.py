"""Per-artist DINOv2 background distribution — the calibration behind D_T_DINO_FLOOR.

Stage 2a gates work identity ("is this the same PRINT?") on a single global number,
`D_T_DINO_FLOOR = 0.88`, whose own comment admits it is unfitted: five lots, with 0.010
between the lowest same-work match and the highest different-work one.

Measured 2026-09-11 over 37,905 image pairs from 400 artists, that number is a reasonable
CENTRE and a poor CONSTANT. DINOv2 similarity is ARTIST-DEPENDENT, and the threshold holding a
1% false-positive rate ranges from 0.533 to 1.000 across the 977 artists with enough embedded
output to measure — median 0.875, with 473 needing a higher floor and 504 a lower one. On
duplicate-filtered labels, normalising to the artist's own distribution lifts average precision
from 0.895 to 0.953.

This script writes each artist's own background so the floor can be read off it:

    Artist.dinoBackgroundP99    similarity exceeded by 1% of that artist's DIFFERENT-work pairs
    Artist.dinoBackgroundP95    the 5% point, so the operating point is tunable without a recompute
    Artist.dinoBackgroundPairs  how many pairs it was computed from — the caller's confidence signal
    Artist.dinoBackgroundAt     when

"Background" is deliberately the DIFFERENT-work distribution: the question a floor answers is
"could this similarity have arisen between two prints that merely share an artist?", and that
is exactly what these pairs sample. Same-work pairs are the signal being separated and are
never mixed in.

DUPLICATE NODES MUST BE EXCLUDED FROM THE BACKGROUND, and this is not a refinement — it is
the difference between a usable floor and a broken one. ~30% of ConceptualWork nodes are
variant-titled duplicates, so "two different works by this artist" routinely means one print
on two nodes, and those pairs score ~1.0. Measured on Peter Blake: 26 of 780 pairs had
identical normalised titles ("Eve" vs "Eve", "Got a Girl" vs "Got a Girl"), and they dragged
his p99 from 0.735 to 0.983 — a floor that then REJECTED a 0.886 match the regression suite
verifies as the same work against Tate P04038. Pairs whose titles normalise identically are
therefore dropped. That also discards the rare genuinely-different works sharing a title, a
trade worth making: including duplicates corrupts the statistic outright, excluding a few
honest pairs barely moves a quantile.

COVERAGE IS NOT UNIVERSAL AND MUST NOT BE REQUIRED. An artist needs several works each
carrying several embedded images before the distribution means anything; most do not. A
missing background is normal and callers fall back to the global floor — see
queryArtistDinoFloor in the TypeScript side, which never gates on the property existing.

Usage:
    set -a; source .env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/artist_dino_background.py \
        [--min-works 3] [--min-pairs 30] [--limit N] [--dry-run]
"""
import argparse, os, re, sys, time
from datetime import datetime, timezone

import numpy as np
from neo4j import GraphDatabase


def _env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} is not set. Run `set -a; source .env; set +a` first.")
    return v


# Eligibility: works that carry >=2 embedded images, and enough such works that pairs ACROSS
# them exist. Below that the "distribution" is a handful of numbers and a quantile of it is
# noise wearing a decimal point.
ELIGIBLE = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(imp) WHERE img.embedding IS NOT NULL
WITH a, cw, count(DISTINCT img) AS imgs WHERE imgs >= 1
WITH a, count(DISTINCT cw) AS works WHERE works >= $minWorks
RETURN a.name AS artist, works ORDER BY works DESC
"""

# Pairs BETWEEN different works by one artist. Capped per work and per artist: a prolific
# artist would otherwise contribute millions of pairs and dominate nothing but the runtime.
BACKGROUND = """
MATCH (a:Artist {name: $artist})-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(imp) WHERE img.embedding IS NOT NULL
WITH cw, collect(img)[..4] AS imgs
WITH collect({cw: cw, imgs: imgs})[..$maxWorks] AS works
UNWIND range(0, size(works)-2) AS i
UNWIND range(i+1, size(works)-1) AS j
WITH works[i] AS W1, works[j] AS W2
UNWIND W1.imgs AS i1
UNWIND W2.imgs AS i2
WITH W1.cw.name AS titleA, W2.cw.name AS titleB,
     vector.similarity.cosine(i1.embedding, i2.embedding) AS sim, rand() AS r
ORDER BY r
RETURN collect({sim: sim, titleA: titleA, titleB: titleB})[..$maxPairs] AS pairs
"""

_TITLE_NOISE = re.compile(r"[^a-z0-9 ]")
_WS = re.compile(r"\s+")


def title_key(s):
    """Same normalisation the threshold analysis uses, so the two agree on what a duplicate is."""
    return _WS.sub(" ", _TITLE_NOISE.sub(" ", (s or "").lower())).strip()

WRITE = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.artist})
SET a.dinoBackgroundP99 = row.p99,
    a.dinoBackgroundP95 = row.p95,
    a.dinoBackgroundPairs = row.n,
    a.dinoBackgroundAt = row.now
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-works", type=int, default=3, help="Distinct works with an embedded image")
    ap.add_argument("--min-pairs", type=int, default=30, help="Background pairs below which no value is written")
    ap.add_argument("--max-works", type=int, default=40)
    ap.add_argument("--max-pairs", type=int, default=2000)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--chunk-size", type=int, default=200)
    a = ap.parse_args()

    drv = GraphDatabase.driver(_env("NEO4J_URI"), auth=(_env("NEO4J_USER"), _env("NEO4J_PASSWORD")))
    db = os.environ.get("NEO4J_DATABASE", "neo4j")
    t0 = time.time()
    written, skipped, pending = 0, 0, []
    try:
        with drv.session(database=db) as s:
            artists = [r["artist"] for r in s.run(ELIGIBLE, minWorks=a.min_works)]
            if a.limit:
                artists = artists[: a.limit]
            print(f"[eligible] {len(artists)} artist(s) with >={a.min_works} works carrying an embedded image", flush=True)

            for n, artist in enumerate(artists, 1):
                try:
                    rec = s.run(BACKGROUND, artist=artist, maxWorks=a.max_works, maxPairs=a.max_pairs).single()
                    raw = rec["pairs"] if rec else []
                    sims = [p["sim"] for p in raw
                            if p["sim"] is not None and title_key(p["titleA"]) != title_key(p["titleB"])]
                    dropped = len(raw) - len(sims)
                except Exception as e:
                    print(f"  [warn] {artist[:40]}: {str(e)[:90]}", flush=True)
                    continue
                # Too few pairs is reported, never written. A quantile of 11 numbers would be
                # indistinguishable in the data from a real one and would silently become a gate.
                if len(sims) < a.min_pairs:
                    skipped += 1
                    continue
                arr = np.array(sims, dtype=float)
                pending.append({
                    "artist": artist,
                    "p99": float(np.quantile(arr, 0.99)),
                    "p95": float(np.quantile(arr, 0.95)),
                    "n": len(sims),
                    "now": datetime.now(timezone.utc).isoformat(),
                })
                if not a.dry_run and len(pending) >= a.chunk_size:
                    s.run(WRITE, rows=pending); written += len(pending); pending = []
                if n % 100 == 0:
                    el = time.time() - t0
                    print(f"  {n}/{len(artists)} | written {written} skipped {skipped} | "
                          f"{el:.0f}s, ~{el/n*(len(artists)-n):.0f}s left", flush=True)
            if pending and not a.dry_run:
                s.run(WRITE, rows=pending); written += len(pending); pending = []
    finally:
        drv.close()

    if a.dry_run:
        print(f"\n[DRY RUN] {len(pending)} artist(s) would be written, {skipped} skipped for <{a.min_pairs} pairs")
        for r in pending[:10]:
            print(f"   {r['artist'][:38]:<38} p99={r['p99']:.3f} p95={r['p95']:.3f} ({r['n']} pairs)")
        if pending:
            q = np.array([r["p99"] for r in pending])
            print(f"   p99 across these artists: min {q.min():.3f}, median {np.median(q):.3f}, max {q.max():.3f}")
            print(f"   global D_T_DINO_FLOOR is 0.880 — {(q > 0.880).sum()}/{len(q)} need a HIGHER floor")
    else:
        print(f"\n[DONE] wrote {written} artist background(s), skipped {skipped} for <{a.min_pairs} pairs, in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
