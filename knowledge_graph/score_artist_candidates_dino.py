"""
PrintMasterAI — DINOv2 corroboration for Splink artist candidates.
Version: ARTIST-SPLINK-DINO-1.0

Adds the one signal the metadata model structurally cannot have: whether the two nodes'
pictures were made by the same hand. Scores only, merges nothing.

WHY THIS AND NOT MORE METADATA. `fit_splink_artist_identity.py` ranks on name, dates and
nationality, and its own worst case is the pair those fields cannot separate — a father and
grandson sharing a name, where the name agrees perfectly and the dates are the only
objection. DINOv2 cross-similarity is independent of every field in that model and was
measured on exactly this problem in `find_artist_merge_candidates.py`:

    Roberto Matta, genuine 4-way name split          max 0.934
    Alexander Calder / Alexander Milne Calder        max 0.522   (different people)
    Camille Pissarro / Orovida Camille Pissarro      max 0.408   (different people)

CLIP was tested on the same three and stayed at 0.75-0.80 regardless of truth, so only
DINOv2 is scored here. Thresholds and the 15-image cap are taken from that script rather
than re-derived, so the two generators stay comparable.

A THIN SAMPLE IS NOT A REJECTION. A pair with two images a side that scores low means
"not enough pictures", not "different people" — `nA`/`nB` are reported so a low score can
be read against the sample it came from, and pairs with no coverage are carried through
unscored rather than dropped.
"""
import argparse, os, sys
import numpy as np, pandas as pd
from dotenv import load_dotenv
from neo4j import GraphDatabase

MAX_VECS_PER_ARTIST = 15     # same cap as find_artist_merge_candidates.py

EMBEDDINGS_QUERY = """
UNWIND $ids AS nid
MATCH (a:Artist) WHERE elementId(a) = nid
CALL {
    WITH a
    MATCH (a)-[:CREATED]->(:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
         -[:INCLUDES]->(:Impression)<-[:SHOWS]-(img:DigitalImage)
    WHERE img.embedding IS NOT NULL
    RETURN img.embedding AS e
    LIMIT $maxVecs
}
RETURN nid AS id, collect(e) AS embeddings
"""


def unit(vecs):
    m = np.asarray(vecs, dtype=np.float32)
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return m / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("candidates")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    d = pd.read_csv(a.candidates)
    need = sorted(set(d[(d.embedded_l > 0) & (d.embedded_r > 0)].unique_id_l)
                  | set(d[(d.embedded_l > 0) & (d.embedded_r > 0)].unique_id_r))
    print(f"{len(d):,} candidate pairs; fetching embeddings for {len(need):,} artists")

    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    drv = GraphDatabase.driver(os.getenv("NEO4J_URI"),
                               auth=(os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")))
    emb = {}
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        for i in range(0, len(need), 40):
            for r in s.run(EMBEDDINGS_QUERY, ids=need[i:i + 40], maxVecs=MAX_VECS_PER_ARTIST):
                if r["embeddings"]:
                    emb[r["id"]] = unit(r["embeddings"])
            print(f"  {min(i+40,len(need))}/{len(need)}", end="\r", flush=True)
    drv.close()
    print(f"\nembeddings for {len(emb):,} artists")

    rows = []
    for _, r in d.iterrows():
        va, vb = emb.get(r.unique_id_l), emb.get(r.unique_id_r)
        if va is None or vb is None:
            rows.append((np.nan, np.nan, 0, 0))
            continue
        sims = va @ vb.T
        rows.append((float(sims.max()), float(sims.mean()), len(va), len(vb)))
    d[["dino_max", "dino_mean", "nA", "nB"]] = pd.DataFrame(rows, index=d.index)
    d.to_csv(a.out, index=False)
    print(f"scored {d.dino_max.notna().sum():,} pairs -> {a.out}")

    ok = d[d.dino_max.notna()]
    print("\ndino_max by match_weight band (pairs with both sides embedded)")
    print(f"{'band':>14} {'n':>5} {'median':>8} {'>=0.80':>7} {'>=0.90':>7}")
    for lo, hi in [(30, 99), (20, 30), (10, 20), (5, 10), (0, 5)]:
        b = ok[(ok.match_weight >= lo) & (ok.match_weight < hi)]
        if len(b):
            print(f"{lo:6.0f} - {hi:<5.0f} {len(b):5d} {b.dino_max.median():8.3f} "
                  f"{(b.dino_max>=0.80).mean():6.0%} {(b.dino_max>=0.90).mean():6.0%}")


if __name__ == "__main__":
    main()
