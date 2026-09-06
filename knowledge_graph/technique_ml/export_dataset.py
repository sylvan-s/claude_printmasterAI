"""
PrintMasterAI — export the DINOv2 / technique-label training set out of the ACKG.
Version: TECHML-EXPORT-1.0

Pulls every `DigitalImage` that has BOTH a DINOv2-Large embedding and at least one
`USES_TECHNIQUE` edge on its Impression, together with the three grouping keys the
trainer needs to keep itself honest:

  * artistId    — the split group. No artist may appear in both train and test, so a
                  model that has merely memorised "Picasso ⇒ lithograph" scores zero
                  credit. Every embedded+labelled image in the graph resolves to
                  exactly one artist (3 of 44,680 resolve to two; those are dropped).
  * workId      — the ConceptualWork. 2,346 works carry more than one image (up to 20
                  of the same work), so image-level splitting alone would leak.
                  Artist grouping subsumes this, but the id is exported for auditing.
  * institution — Bonhams / Tate / British Museum. This is a real confound, not a
                  nuisance: nine technique labels are 100% single-institution
                  (Gelatin silver print, Offset lithograph, Chromogenic/Platinum/
                  Cibachrome/Pigment/Inkjet/Digital print, Giclée are Bonhams-only;
                  Photomechanical/Photorelief/Stencil are BM-only), so a classifier
                  can score well on those by recognising the photographer's lighting
                  rather than the printing process. The trainer reports per-institution
                  metrics and a source-leakage probe so this stays visible.

Output is a single .npz (float32 embeddings + object arrays) written to
`technique_ml/data/dataset.npz` by default. ~44.7k x 1024 float32 ≈ 175 MB.

Usage:
    set -a; source .env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/export_dataset.py
    ... --limit 2000 --out /tmp/smoke.npz      # smoke test
"""

import argparse
import os
import time

import numpy as np
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Export the project's Neo4j credentials first "
            f"(e.g. `set -a; source .env; set +a`)."
        )
    return value


# One row per (image, artist). Techniques are collected so multi-technique impressions
# (5,836 of them — etching+aquatint and friends) stay a single multi-label row rather
# than being duplicated into contradictory single-label rows.
FETCH_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)
WHERE img.embedding IS NOT NULL
MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp)
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WITH img, imp,
     collect(DISTINCT t.name) AS techniques,
     collect(DISTINCT a.name) AS artistNames,
     collect(DISTINCT elementId(a)) AS artistIds,
     collect(DISTINCT elementId(cw)) AS workIds,
     collect(DISTINCT src.institutionName) AS institutions
RETURN elementId(img) AS imageId,
       img.embedding AS embedding,
       techniques,
       artistNames,
       artistIds,
       workIds,
       institutions
ORDER BY imageId
SKIP $skip LIMIT $limit
"""

PAGE_SIZE = 2000


def export(out_path, limit=None, page_size=PAGE_SIZE):
    driver = GraphDatabase.driver(
        _require_env("NEO4J_URI"),
        auth=(_require_env("NEO4J_USER"), _require_env("NEO4J_PASSWORD")),
    )
    database = _require_env("NEO4J_DATABASE")

    embeddings = []
    image_ids, artist_ids, artist_names, work_ids, institutions, technique_sets = (
        [], [], [], [], [], []
    )
    dropped_multi_artist = 0
    dropped_bad_dim = 0
    expected_dim = None

    started = time.time()
    skip = 0
    try:
        with driver.session(database=database) as session:
            while True:
                take = page_size
                if limit is not None:
                    take = min(take, limit - len(embeddings) - dropped_multi_artist)
                    if take <= 0:
                        break
                rows = list(session.run(FETCH_QUERY, skip=skip, limit=take))
                if not rows:
                    break
                skip += len(rows)
                for row in rows:
                    # A handful of impressions resolve to two artists; the split group
                    # would be ambiguous, so they are dropped rather than assigned
                    # arbitrarily to one side of the train/test boundary.
                    if len(row["artistIds"]) != 1:
                        dropped_multi_artist += 1
                        continue
                    vec = np.asarray(row["embedding"], dtype=np.float32)
                    if expected_dim is None:
                        expected_dim = vec.shape[0]
                    if vec.shape[0] != expected_dim:
                        dropped_bad_dim += 1
                        continue
                    embeddings.append(vec)
                    image_ids.append(row["imageId"])
                    artist_ids.append(row["artistIds"][0])
                    artist_names.append(row["artistNames"][0])
                    work_ids.append(row["workIds"][0] if row["workIds"] else "")
                    institutions.append(
                        row["institutions"][0]
                        if row["institutions"] and row["institutions"][0]
                        else "unknown"
                    )
                    technique_sets.append("|".join(sorted(row["techniques"])))
                print(
                    f"  fetched {skip:,} rows  kept {len(embeddings):,}  "
                    f"({time.time() - started:.0f}s)",
                    flush=True,
                )
    finally:
        driver.close()

    if not embeddings:
        raise RuntimeError("No rows returned — check the Neo4j connection and that "
                           "DigitalImage.embedding is populated.")

    X = np.vstack(embeddings)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    np.savez_compressed(
        out_path,
        X=X,
        image_id=np.array(image_ids, dtype=object),
        artist_id=np.array(artist_ids, dtype=object),
        artist_name=np.array(artist_names, dtype=object),
        work_id=np.array(work_ids, dtype=object),
        institution=np.array(institutions, dtype=object),
        techniques=np.array(technique_sets, dtype=object),
    )
    print(
        f"\nWrote {out_path}: {X.shape[0]:,} images x {X.shape[1]}d, "
        f"{len(set(artist_ids)):,} artists, {len(set(institutions))} institutions "
        f"({time.time() - started:.0f}s)"
    )
    if dropped_multi_artist:
        print(f"  dropped {dropped_multi_artist} rows with an ambiguous artist")
    if dropped_bad_dim:
        print(f"  dropped {dropped_bad_dim} rows with an off-dimension embedding")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "dataset.npz"),
    )
    parser.add_argument("--limit", type=int, default=None, help="stop after N rows (smoke test)")
    parser.add_argument("--page-size", type=int, default=PAGE_SIZE)
    args = parser.parse_args()
    export(args.out, limit=args.limit, page_size=args.page_size)


if __name__ == "__main__":
    main()
