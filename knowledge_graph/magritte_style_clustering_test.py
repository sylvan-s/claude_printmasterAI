"""
PrintMasterAI — one-off test: cluster René Magritte's embedded works by DINOv2 similarity,
then reuse those same cluster assignments to build CLIP centroids too.

Motivation: raw DINOv2 nearest-neighbour search only succeeds when a query image happens
to be visually close to an ALREADY-EMBEDDED instance by the same artist (confirmed via
tests/backtest/run_stage1d_only.ts's Magritte miss — the specific plate tested had zero
embedded images of itself in the graph). A per-artist prototype (a centroid over several
of the artist's embedded works, or several sub-style centroids) is one candidate fix: it
could let Stage 1d recognise a *new* image as "close to Magritte's style" even when no
single indexed image is a close match. This script tests whether Magritte's embedded
corpus actually clusters into coherent visual groups at all, before building anything
production-facing on top of the idea.

No scikit-learn (matches this repo's existing preference — see the technique-classifier
branch). K-means implemented directly in numpy; k chosen by a manually-computed
(cosine-based) silhouette score over a small range, not guessed.

Usage:
    python3 magritte_style_clustering_test.py [--k-min 2] [--k-max 8] [--seed 0]

Writes magritte_style_clustering_test_output.json (cluster assignments + both centroids).
"""
import argparse
import json
import os

import numpy as np
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — source .env first (set -a; source .env; set +a).")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

ARTIST_NAME = "René Magritte"

FETCH_QUERY = """
MATCH (a:Artist {name: $artistName})-[:CREATED]->(w:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(imp)<-[:SHOWS]-(img:DigitalImage)
WHERE img.embedding IS NOT NULL AND img.clipImageEmbedding IS NOT NULL
RETURN img.id AS imgId, w.name AS title, img.embedding AS dino, img.clipImageEmbedding AS clip
"""


def fetch_rows():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_QUERY, artistName=ARTIST_NAME)
            return [dict(r) for r in result]
    finally:
        driver.close()


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def kmeans(mat: np.ndarray, k: int, seed: int, n_iter: int = 100, n_restarts: int = 10):
    """Plain-numpy k-means on L2-normalized vectors (Euclidean k-means on unit vectors is
    equivalent to cosine-similarity k-means up to a monotonic transform). Returns the best
    (lowest-inertia) labeling across n_restarts random inits."""
    rng = np.random.default_rng(seed)
    n = mat.shape[0]
    best_labels, best_inertia = None, np.inf

    for restart in range(n_restarts):
        centroid_idx = rng.choice(n, size=k, replace=False)
        centroids = mat[centroid_idx].copy()
        labels = np.zeros(n, dtype=int)

        for _ in range(n_iter):
            dists = np.linalg.norm(mat[:, None, :] - centroids[None, :, :], axis=2)
            new_labels = dists.argmin(axis=1)
            if np.array_equal(new_labels, labels) and _ > 0:
                labels = new_labels
                break
            labels = new_labels
            for c in range(k):
                members = mat[labels == c]
                if len(members):
                    centroids[c] = l2_normalize(members.mean(axis=0, keepdims=True))[0]

        dists = np.linalg.norm(mat[:, None, :] - centroids[None, :, :], axis=2)
        inertia = sum(dists[i, labels[i]] ** 2 for i in range(n))
        if inertia < best_inertia:
            best_inertia = inertia
            best_labels = labels.copy()

    return best_labels, best_inertia


def cosine_silhouette(mat: np.ndarray, labels: np.ndarray) -> float:
    """Silhouette score using cosine similarity (1 - cosine_sim as distance), computed
    directly rather than via sklearn.metrics."""
    n = mat.shape[0]
    sim = mat @ mat.T  # rows are already unit-norm -> this is cosine similarity
    dist = 1.0 - sim
    scores = np.zeros(n)
    unique_labels = np.unique(labels)
    if len(unique_labels) < 2:
        return -1.0
    for i in range(n):
        own = labels[i]
        a = dist[i, labels == own]
        a = a[a > 0].mean() if (labels == own).sum() > 1 else 0.0
        b_candidates = []
        for other in unique_labels:
            if other == own:
                continue
            b_candidates.append(dist[i, labels == other].mean())
        b = min(b_candidates) if b_candidates else 0.0
        denom = max(a, b) or 1.0
        scores[i] = (b - a) / denom
    return float(scores.mean())


def dedupe_by_title(rows):
    """Group by exact title string. Kept for comparison — turned out NOT to catch
    cross-source duplicates, since the same physical print is often catalogued under
    slightly different title strings by different auction houses (see dedupe_by_dino_sim)."""
    by_title: dict = {}
    for r in rows:
        by_title.setdefault(r["title"], []).append(r)
    groups = list(by_title.values())
    dupes = sum(1 for g in groups if len(g) > 1)
    print(f"Deduped {len(rows)} images -> {len(groups)} distinct titles "
          f"({dupes} titles had multiple images averaged into one point).\n")
    return groups


def dedupe_by_dino_sim(rows, threshold: float):
    """Union-find over pairwise DINOv2 cosine similarity: two images above `threshold`
    are almost certainly the same physical print (possibly catalogued under different
    titles across sources — exact-title dedup missed exactly this case), so they're
    collapsed into one point regardless of what their title strings say."""
    n = len(rows)
    dino = l2_normalize(np.array([r["dino"] for r in rows], dtype=np.float64))
    sim = dino @ dino.T

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    merged_pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            if sim[i, j] > threshold:
                union(i, j)
                merged_pairs.append((i, j, sim[i, j]))

    groups_by_root: dict = {}
    for i in range(n):
        groups_by_root.setdefault(find(i), []).append(rows[i])
    groups = list(groups_by_root.values())

    dupes = sum(1 for g in groups if len(g) > 1)
    cross_title = [(i, j, s) for i, j, s in merged_pairs if rows[i]["title"] != rows[j]["title"]]
    print(f"Deduped {n} images -> {len(groups)} distinct prints "
          f"(DINOv2 sim > {threshold}; {dupes} groups had multiple images merged; "
          f"{len(merged_pairs)} pairwise merges, {len(cross_title)} of them across DIFFERENT "
          f"title strings — i.e. likely un-merged cross-source catalogue duplicates):\n")
    for i, j, s in sorted(cross_title, key=lambda x: -x[2]):
        print(f"    sim={s:.3f}  \"{rows[i]['title']}\"  <->  \"{rows[j]['title']}\"")
    print()
    return groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--k-min", type=int, default=2)
    parser.add_argument("--k-max", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--dedupe-mode", choices=["dino-sim", "title", "none"], default="dino-sim",
        help="How to collapse duplicate images of the same physical print before "
             "clustering. dino-sim (default): union-find over pairwise DINOv2 cosine "
             "similarity > --dino-sim-threshold. title: exact title-string match "
             "(misses cross-source title variants). none: one point per image.",
    )
    parser.add_argument("--dino-sim-threshold", type=float, default=0.95)
    parser.add_argument(
        "--cluster-space", choices=["dino", "clip"], default="dino",
        help="Which embedding space k-means actually clusters on (dedup is always DINOv2 "
             "regardless of this setting). Both centroids are computed either way, from "
             "whichever space's cluster assignments this produces.",
    )
    args = parser.parse_args()

    rows = fetch_rows()
    print(f"Fetched {len(rows)} embedded René Magritte images.\n")

    if args.dedupe_mode == "none":
        groups = [[r] for r in rows]
    elif args.dedupe_mode == "title":
        groups = dedupe_by_title(rows)
    else:
        groups = dedupe_by_dino_sim(rows, args.dino_sim_threshold)

    titles = [" / ".join(sorted({x["title"] for x in g})) for g in groups]
    img_ids = [",".join(x["imgId"] for x in g) for g in groups]
    dino_raw = np.array([np.mean([x["dino"] for x in g], axis=0) for g in groups], dtype=np.float64)
    clip_raw = np.array([np.mean([x["clip"] for x in g], axis=0) for g in groups], dtype=np.float64)

    if len(titles) < args.k_max * 2:
        print(f"(only {len(titles)} points — capping k-max)")

    dino = l2_normalize(dino_raw)
    clip = l2_normalize(clip_raw)
    cluster_mat = clip if args.cluster_space == "clip" else dino

    k_max = min(args.k_max, len(titles) // 2)
    print(f"Selecting k in [{args.k_min}, {k_max}] by cosine silhouette score "
          f"({args.cluster_space.upper()} space, since --cluster-space={args.cluster_space}):\n")

    best_k, best_score, best_labels = None, -2.0, None
    for k in range(args.k_min, k_max + 1):
        labels, inertia = kmeans(cluster_mat, k, seed=args.seed)
        score = cosine_silhouette(cluster_mat, labels)
        print(f"  k={k:2d}  silhouette={score:+.3f}  inertia={inertia:.2f}")
        if score > best_score:
            best_score, best_k, best_labels = score, k, labels

    print(f"\nBest k = {best_k} (silhouette {best_score:+.3f})\n")

    clusters = []
    for c in range(best_k):
        member_idx = np.where(best_labels == c)[0]
        dino_members = dino[member_idx]
        clip_members = clip[member_idx]
        dino_centroid = l2_normalize(dino_members.mean(axis=0, keepdims=True))[0]
        clip_centroid = l2_normalize(clip_members.mean(axis=0, keepdims=True))[0]

        # How tight is this cluster in each space? Mean cosine sim of members to their
        # own centroid — computed independently for DINOv2 (the clustering space) and
        # CLIP (reusing the same membership) to see whether a DINOv2-coherent group is
        # ALSO CLIP-coherent, or whether the two spaces disagree about "closeness" here.
        dino_tightness = float((dino_members @ dino_centroid).mean())
        clip_tightness = float((clip_members @ clip_centroid).mean())

        member_titles = [titles[i] for i in member_idx]
        clusters.append({
            "cluster": c,
            "size": len(member_idx),
            "imgIds": [img_ids[i] for i in member_idx],
            "titles": member_titles,
            "dinoCentroid": dino_centroid.tolist(),
            "clipCentroid": clip_centroid.tolist(),
            "dinoTightness": dino_tightness,
            "clipTightness": clip_tightness,
        })

    clusters.sort(key=lambda c: -c["size"])
    print(f"{'Cluster':<8}{'Size':<6}{'DINO tight':<12}{'CLIP tight':<12}Sample titles")
    for c in clusters:
        sample = "; ".join(c["titles"][:3]) + (" ..." if c["size"] > 3 else "")
        print(f"{c['cluster']:<8}{c['size']:<6}{c['dinoTightness']:<12.3f}{c['clipTightness']:<12.3f}{sample}")

    out_path = "magritte_style_clustering_test_output.json"
    with open(out_path, "w") as f:
        json.dump({
            "artist": ARTIST_NAME,
            "nImages": len(rows),
            "nPoints": len(titles),
            "dedupeMode": args.dedupe_mode,
            "clusterSpace": args.cluster_space,
            "bestK": best_k,
            "silhouette": best_score,
            "clusters": clusters,
        }, f, indent=2)
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
