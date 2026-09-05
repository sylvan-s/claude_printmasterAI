"""
PrintMasterAI — ad hoc DINOv2/CLIP similarity query over embedded Tate DigitalImage nodes
Version: QUERY-TATE-SIM-1.0

Pulls every Tate DigitalImage that has a `field` embedding (default: DINOv2's
`embedding`, pass --field clipImageEmbedding for CLIP instead), computes pairwise
cosine similarity locally with numpy, and prints either the top-N most similar pairs
across the whole set (--top-pairs, default) or the nearest neighbours of one specific
accession number (--accession).

Deliberately does the similarity math client-side rather than in Cypher — this is a
small ad hoc querying-potential check (dozens of vectors from the Stage 0 pilot), not
the production similarity-search path. At full ~11k-work scale this should move to
Neo4j's native vector index (`db.index.vector.queryNodes`, available on this
Community Edition 5.26 instance) instead of an O(n^2) local matrix.

Also supports a zero-shot text-to-image query (--text-query), CLIP's actual
cross-modal party trick: embeds an arbitrary text prompt with CLIP's text encoder and
ranks every work's `clipImageEmbedding` against it — no DINOv2 equivalent exists
since DINOv2 has no text encoder at all.

Usage:
    python3 query_tate_image_similarity.py --top-pairs 10
    python3 query_tate_image_similarity.py --field clipImageEmbedding --top-pairs 10
    python3 query_tate_image_similarity.py --accession P01621 --top-k 5
    python3 query_tate_image_similarity.py --text-query "a photo of an animal" --top-k 10
"""

import argparse
import os

import numpy as np
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — source .env first.")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

FETCH_QUERY_TEMPLATE = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)<-[:DOCUMENTS]-(src:SourceRecord {{institutionName: 'Tate'}})
WHERE img.{field} IS NOT NULL
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(imp)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN src.accessionNumber AS accession, coalesce(cw.name, '(untitled)') AS title,
       img.{field} AS vector
ORDER BY accession
"""
# WHERE must precede the OPTIONAL MATCHes, not follow them: Cypher binds a trailing
# WHERE to whichever (OPTIONAL) MATCH immediately precedes it, so for the small number
# of works where the ConceptualWork optional-match itself fails, a trailing WHERE never
# gets evaluated and null/un-embedded vectors leak through — found live 2026-09-05 when
# this crashed numpy with a ragged-array error (8291 rows fetched vs. 6303 actually
# non-null on the same filter checked directly).


def fetch_vectors(field):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(FETCH_QUERY_TEMPLATE.format(field=field))
            rows = [dict(r) for r in result]
    finally:
        driver.close()
    return rows


def cosine_sim_matrix(vectors):
    m = np.array(vectors, dtype=np.float32)
    m = m / np.linalg.norm(m, axis=1, keepdims=True)
    return m @ m.T


def print_top_pairs(rows, sim, top_n):
    n = len(rows)
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs.append((sim[i, j], i, j))
    pairs.sort(reverse=True)
    print(f"\nTop {top_n} most similar pairs (of {n} works, {n*(n-1)//2} pairs):\n")
    for rank, (score, i, j) in enumerate(pairs[:top_n], 1):
        a, b = rows[i], rows[j]
        print(f"{rank:2d}. {score:.4f}  {a['accession']:8s} {a['title'][:45]:45s}"
              f"  <->  {b['accession']:8s} {b['title'][:45]}")


CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"  # must match embed_tate_images.py's model


def embed_text_query(text):
    # Lazy import so --top-pairs/--accession runs don't pay torch's import cost.
    import torch
    from transformers import CLIPModel, CLIPProcessor

    processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    model.eval()
    inputs = processor(text=[text], return_tensors="pt", truncation=True, padding=True)
    with torch.no_grad():
        features = model.get_text_features(**inputs)
    return features.squeeze(0).numpy()


def print_text_query_ranking(rows, text, top_k):
    query_vec = embed_text_query(text)
    query_vec = query_vec / np.linalg.norm(query_vec)

    m = np.array([r["vector"] for r in rows], dtype=np.float32)
    m = m / np.linalg.norm(m, axis=1, keepdims=True)
    scores = m @ query_vec

    order = np.argsort(-scores)
    print(f"\nRanked by CLIP image-embedding similarity to text query: \"{text}\"\n")
    for rank, i in enumerate(order[:top_k], 1):
        r = rows[i]
        print(f"{rank:2d}. {scores[i]:.4f}  {r['accession']:8s} {r['title']}")


def print_nearest_neighbors(rows, sim, accession, top_k):
    idx = next((i for i, r in enumerate(rows) if r["accession"] == accession), None)
    if idx is None:
        print(f"Accession {accession} not found among embedded works.")
        return
    order = np.argsort(-sim[idx])
    print(f"\nNearest neighbours of {accession} ({rows[idx]['title']}):\n")
    shown = 0
    for j in order:
        if j == idx:
            continue
        r = rows[j]
        print(f"{shown+1:2d}. {sim[idx, j]:.4f}  {r['accession']:8s} {r['title']}")
        shown += 1
        if shown >= top_k:
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--field", default="embedding",
                         help="Embedding property to compare (default: embedding = DINOv2)")
    parser.add_argument("--top-pairs", type=int, help="Print the N most similar pairs across the set")
    parser.add_argument("--accession", help="Print nearest neighbours of this accession number instead")
    parser.add_argument("--text-query", help="Rank works by CLIP text-to-image similarity to this prompt")
    parser.add_argument("--top-k", type=int, default=5, help="Neighbours/results to show with --accession/--text-query")
    args = parser.parse_args()

    field = "clipImageEmbedding" if args.text_query else args.field
    rows = fetch_vectors(field)
    print(f"Loaded {len(rows)} vectors (field={field})")
    if len(rows) < 2:
        raise SystemExit("Need at least 2 embedded works to compare.")

    if args.text_query:
        print_text_query_ranking(rows, args.text_query, args.top_k)
    elif args.accession:
        sim = cosine_sim_matrix([r["vector"] for r in rows])
        print_nearest_neighbors(rows, sim, args.accession, args.top_k)
    else:
        sim = cosine_sim_matrix([r["vector"] for r in rows])
        print_top_pairs(rows, sim, args.top_pairs or 10)
