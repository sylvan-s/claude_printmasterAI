"""
PrintMasterAI — regression guard: DigitalImage vectors live where the vector indexes look.

Exists because of a silent gap, not for coverage's sake. `embed_poster_images.py` 2.0 wrote
King & McGaw's DINOv2 vectors to `dinov2Embedding` and a 768-d CLIP ViT-L/14 vector to
`embedding`, while the graph's two vector indexes are built on

    digitalImageDinov2Embedding   DigitalImage.embedding            1024-d, DINOv2-Large
    digitalImageClipEmbedding     DigitalImage.clipImageEmbedding    512-d, CLIP ViT-B/32

Nothing failed: the embed run exited cleanly and the counts looked right. But all 570 King &
McGaw images were invisible to both indexes, and 768-d vectors sat in the property every DINOv2
reader treats as 1024-d. `fit_splink_work_identity.py` had even been rewritten to read the
wrong properties to match, which silently dropped DINOv2 features for every other work.
Repaired 2026-09-19 by `repair_km_image_embeddings.py`.

NEO4J CANNOT ENFORCE THIS (self-hosted CE: no property-type or dimension constraints, and a
vector index silently skips a node whose vector has the wrong dimension), so the invariant
lives here.

    python3 check_image_embedding_properties.py            # exits 1 on regression
    python3 check_image_embedding_properties.py --no-db    # skip the live-graph check

Two layers:
  1. No script writes the legacy `dinov2Embedding` family, and `embed_poster_images.py`'s
     model map targets the indexed properties.
  2. If the graph is reachable: no DigitalImage carries `dinov2Embedding`; every `embedding` is
     1024-d DINOv2-Large; every `clipImageEmbedding` is 512-d ViT-B/32.
"""
import argparse
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Property access on a DigitalImage alias, or a model-map entry pointing at the legacy name. Prose that
# merely explains the old bug (docstrings, comments) does not match either shape.
LEGACY_RE = re.compile(r"\b(?:img|i|node)\.dinov2(?:Embedding|Model|Dim|EmbeddedAt)\b|\"prop_name\":\s*\"dinov2")
# Files that legitimately name the legacy properties: the repair (reads/removes them) and this guard.
EXEMPT = {"repair_km_image_embeddings.py", "check_image_embedding_properties.py"}
EXPECTED_MODEL_MAP = {
    "dinov2_large": ("embedding", 1024),
    "clip": ("clipImageEmbedding", 512),
}


def check_static():
    bad = []
    for path in sorted(glob.glob(os.path.join(HERE, "*.py"))):
        name = os.path.basename(path)
        if name in EXEMPT:
            continue
        for i, line in enumerate(open(path, encoding="utf-8", errors="ignore"), 1):
            if LEGACY_RE.search(line):
                bad.append(f"{name}:{i}: {line.strip()}")
    try:
        from embed_poster_images import MODEL_CONFIGS
        for key, (prop, dim) in EXPECTED_MODEL_MAP.items():
            cfg = MODEL_CONFIGS.get(key, {})
            if cfg.get("prop_name") != prop or cfg.get("embedding_dim") != dim:
                bad.append(f"embed_poster_images.py: MODEL_CONFIGS['{key}'] writes "
                           f"{cfg.get('prop_name')} ({cfg.get('embedding_dim')}-d), expected {prop} ({dim}-d)")
    except Exception as e:  # noqa: BLE001 — heavy imports may be missing in this interpreter
        print(f"skip model-map check: {type(e).__name__}: {e}")
    return bad


def check_live():
    from neo4j import GraphDatabase
    from repair_km_work_names import NEO4J_URI, NEO4J_USER, get_neo4j_password
    d = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with d.session(database="neo4j") as s:
        return s.run("""
            MATCH (img:DigitalImage)
            RETURN sum(CASE WHEN img.dinov2Embedding IS NOT NULL THEN 1 ELSE 0 END) AS legacy,
                   sum(CASE WHEN img.embedding IS NOT NULL AND
                        (size(img.embedding) <> 1024 OR img.embeddingModel <> 'facebook/dinov2-large')
                        THEN 1 ELSE 0 END) AS badDino,
                   sum(CASE WHEN img.clipImageEmbedding IS NOT NULL AND
                        (size(img.clipImageEmbedding) <> 512
                         OR img.clipImageEmbeddingModel <> 'openai/clip-vit-base-patch32')
                        THEN 1 ELSE 0 END) AS badClip
        """).single().data()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    failed = False

    bad = check_static()
    if bad:
        failed = True
        print("FAIL static:")
        for b in bad:
            print("  ", b)
    else:
        print("ok static: no script writes the legacy dinov2* properties; embed model map targets the indexes")

    if not args.no_db:
        try:
            r = check_live()
        except Exception as e:  # noqa: BLE001 — an unreachable graph is not a regression
            print(f"skip live: graph unreachable ({type(e).__name__})")
        else:
            if r["legacy"] or r["badDino"] or r["badClip"]:
                failed = True
                print(f"FAIL live: {r['legacy']} images carry legacy dinov2Embedding, "
                      f"{r['badDino']} have a non-1024/non-DINOv2-Large `embedding`, "
                      f"{r['badClip']} have a non-512/non-ViT-B/32 clipImageEmbedding")
            else:
                print("ok live: every DigitalImage vector is where its index looks, at the right dimension")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
