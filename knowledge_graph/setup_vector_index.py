"""
One-time (idempotent) setup of the two Neo4j native vector indexes Stage 1d needs
(docs/adr/0013-stage1d-image-embedding-evidence.md). DINOv2 (1024-dim, property
`embedding`) and CLIP (512-dim, property `clipImageEmbedding`) each need their own
index — one property/dimension per `db.index.vector` index.

Confirmed live (2026-09-05): Neo4j 5.26.30 Community Edition already exposes
`db.index.vector.createNodeIndex`/`queryNodes` — no upgrade needed.

Usage:
    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/setup_vector_index.py

Runs in the toolkit's base environment (just `neo4j`) — no venv-embeddings/torch needed.
"""

import os
import time

from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

INDEXES = [
    {
        "name": "digitalImageDinov2Embedding",
        "label": "DigitalImage",
        "property": "embedding",
        "dim": 1024,
    },
    {
        "name": "digitalImageClipEmbedding",
        "label": "DigitalImage",
        "property": "clipImageEmbedding",
        "dim": 512,
    },
]

CREATE_QUERY = """
CALL db.index.vector.createNodeIndex($name, $label, $property, $dim, 'cosine')
"""

SHOW_INDEXES_QUERY = "SHOW INDEXES YIELD name, state, populationPercent RETURN name, state, populationPercent"


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            existing = {r["name"] for r in session.run(SHOW_INDEXES_QUERY)}

            for idx in INDEXES:
                if idx["name"] in existing:
                    print(f"  {idx['name']}: already exists, skipping create")
                    continue
                session.run(
                    CREATE_QUERY,
                    name=idx["name"], label=idx["label"], property=idx["property"], dim=idx["dim"],
                )
                print(f"  {idx['name']}: created ({idx['label']}.{idx['property']}, dim={idx['dim']})")

            names = [idx["name"] for idx in INDEXES]
            print("\nWaiting for population...")
            while True:
                rows = {
                    r["name"]: r for r in session.run(SHOW_INDEXES_QUERY)
                    if r["name"] in names
                }
                done = True
                for name in names:
                    row = rows.get(name)
                    if row is None:
                        done = False
                        continue
                    pct = row["populationPercent"]
                    print(f"  {name}: state={row['state']} population={pct}%")
                    if row["state"] != "ONLINE" or pct != 100.0:
                        done = False
                if done:
                    print("\nBoth indexes ONLINE at 100% population.")
                    break
                time.sleep(2)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
