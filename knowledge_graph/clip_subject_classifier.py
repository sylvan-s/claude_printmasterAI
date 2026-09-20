"""
PrintMasterAI — CLIP zero-shot subject classification for DigitalImage nodes.
Version: CLIP-SUBJECT-1.0

Classifies every image that already has a stored CLIP embedding
(`DigitalImage.clipImageEmbedding`, openai/clip-vit-base-patch32 — written by
bonhams_embed_images.py / roseberys_embed_images.py / forum_embed_images.py / bm_embed_images.py
/ etc.) against a fixed 10-category subject taxonomy, by cosine similarity to CLIP TEXT
embeddings of each category's prompts. No image re-embedding happens here — only the (cheap)
text side is computed, then matched against vectors already in the graph.

Taxonomy (agreed 2026-09-14, session with the user): portrait, nude, landscape (incl.
marine/seascape), animal, still_life (incl. floral/botanical), religious_mythological,
genre_scene, abstract, surreal, comic_satirical. Prompts were tuned once against a 155-image
title-keyword-labelled pilot (see session scratchpad clip_subject_pilot.py):
  - raw top-1 agreement with weak title labels: 65.2%
  - at confidence margin (top-1 minus top-2 cosine) >= 0.02: 85.1% agreement, 48% coverage
  - at margin >= 0.05: 100% agreement (small n), 12% coverage
Two categories (animal, comic_satirical) stayed weaker even after prompt tuning — largely
monochrome 19th-c./old-master line engravings that are genuinely ambiguous (a bone/skull study
vs. an animal; a satirical crowd scene vs. a genre scene) and out of CLIP's native photographic
training distribution. Their coefficients in any downstream price model should be read with
wider error bars than the other categories.

What one run writes, on every DigitalImage with a non-null clipImageEmbedding:
  DigitalImage.clipSubject            top-1 category name (always set)
  DigitalImage.clipSubjectMargin      top-1 cosine minus top-2 cosine
  DigitalImage.clipSubjectConfident   true iff margin >= --margin-threshold (default 0.02)
  DigitalImage.clipSubjectRun         this run's id ("CLIP-SUBJECT-1.0@<built_at>")

Discipline, as in write_price_priors.py:
  --dry-run   compute and print the plan (category counts, confident share), write nothing
  (apply)     pre-snapshot of every clipSubject* property this run will touch (JSON, gitignored),
              then batched UNWIND writes
  --verify    the verification query only

    set -a; source .env; set +a
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/clip_subject_classifier.py --dry-run
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/clip_subject_classifier.py
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/clip_subject_classifier.py --verify
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
WRITER_VERSION = "CLIP-SUBJECT-1.0"
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"
DEFAULT_MARGIN_THRESHOLD = 0.02
SNAPSHOT_DIR = os.path.join(HERE, "_snapshots")

LABELS = {
    "portrait": ["a portrait print of a person's face", "a print depicting a single person, portrait style"],
    "nude": ["a nude portrait of an unclothed human figure", "a naked human body, a nude figure study"],
    "landscape": ["a print of a landscape or seascape", "an artwork depicting natural outdoor scenery"],
    "animal": ["a print of an animal such as a horse, bird, dog, elephant, or wild creature",
               "wildlife artwork depicting an animal's body, head, or skull"],
    "still_life": ["a still life print of inanimate objects, fruit, or flowers arranged on a surface",
                   "an artwork depicting arranged household objects or a vase of flowers"],
    "religious_mythological": ["a print of a religious or biblical scene", "an artwork depicting mythological or classical religious figures"],
    "genre_scene": ["a genre scene of ordinary daily life, people working or at leisure",
                    "a candid narrative scene of everyday activity, not posed and not a caricature"],
    "abstract": ["an abstract print with no recognizable subject", "a non-representational abstract artwork"],
    "surreal": ["a surreal or fantastical print", "an artwork with dreamlike, impossible, or fantastical imagery"],
    "comic_satirical": ["a satirical caricature print with exaggerated, comic features mocking its subject",
                         "an editorial cartoon or comic-strip panel print"],
}
CATEGORY_NAMES = list(LABELS.keys())


def load_env():
    for path in (os.path.join(REPO_ROOT, ".env"),):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _require_env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} is not set. Run `set -a; source .env; set +a` first.")
    return v


FETCH_QUERY = """
MATCH (img:DigitalImage)
WHERE img.clipImageEmbedding IS NOT NULL
RETURN img.id AS imgId, img.clipImageEmbedding AS vec
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.clipSubject = row.subject,
    img.clipSubjectMargin = row.margin,
    img.clipSubjectConfident = row.confident,
    img.clipSubjectRun = $runId
"""

VERIFY_QUERY = """
MATCH (img:DigitalImage)
WHERE img.clipSubjectRun IS NOT NULL
RETURN img.clipSubjectRun AS run, img.clipSubject AS subject, img.clipSubjectConfident AS confident,
       count(*) AS n
ORDER BY run, subject, confident
"""

SNAPSHOT_QUERY = """
MATCH (img:DigitalImage)
WHERE img.clipSubject IS NOT NULL OR img.clipSubjectRun IS NOT NULL
RETURN img.id AS imgId, img.clipSubject AS clipSubject, img.clipSubjectMargin AS clipSubjectMargin,
       img.clipSubjectConfident AS clipSubjectConfident, img.clipSubjectRun AS clipSubjectRun
"""


def build_text_matrix():
    """Text-side only: CLIP text embeddings for each category, averaged over its prompt
    ensemble and L2-normalised. Kept separate from embedding_service.py (which only serves
    the image side over HTTP) since this needs get_text_features, run once, offline."""
    import torch
    from transformers import CLIPModel, CLIPProcessor

    model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    model.eval()

    vecs = []
    with torch.no_grad():
        for cat in CATEGORY_NAMES:
            inputs = processor(text=LABELS[cat], return_tensors="pt", padding=True)
            feats = model.get_text_features(**inputs)
            feats = feats / feats.norm(dim=-1, keepdim=True)
            v = feats.mean(dim=0)
            v = v / v.norm()
            vecs.append(v.numpy())
    return np.stack(vecs)  # [n_categories, 512]


def classify(image_vectors: np.ndarray, text_matrix: np.ndarray, margin_threshold: float):
    """image_vectors: [N, 512] raw (unnormalised) CLIP image features, as stored.
    Returns (subjects[N], margins[N], confident[N])."""
    norms = np.linalg.norm(image_vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    img_unit = image_vectors / norms
    sims = img_unit @ text_matrix.T  # [N, n_categories]
    order = np.argsort(-sims, axis=1)
    top1_idx = order[:, 0]
    top2_idx = order[:, 1]
    top1_score = sims[np.arange(len(sims)), top1_idx]
    top2_score = sims[np.arange(len(sims)), top2_idx]
    margin = top1_score - top2_score
    subjects = np.array(CATEGORY_NAMES)[top1_idx]
    confident = margin >= margin_threshold
    return subjects, margin, confident


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--margin-threshold", type=float, default=DEFAULT_MARGIN_THRESHOLD)
    ap.add_argument("--batch-size", type=int, default=2000)
    args = ap.parse_args()

    load_env()
    uri = _require_env("NEO4J_URI")
    user = _require_env("NEO4J_USER")
    password = _require_env("NEO4J_PASSWORD")
    database = os.environ.get("NEO4J_DATABASE", "neo4j")
    driver = GraphDatabase.driver(uri, auth=(user, password))

    if args.verify:
        with driver.session(database=database) as sess:
            for rec in sess.run(VERIFY_QUERY):
                print(dict(rec))
        driver.close()
        return

    print(f"Fetching DigitalImage nodes with clipImageEmbedding …", file=sys.stderr)
    imgs = []
    with driver.session(database=database) as sess:
        for rec in sess.run(FETCH_QUERY):
            imgs.append((rec["imgId"], rec["vec"]))
    print(f"  {len(imgs)} images", file=sys.stderr)

    if not imgs:
        print("Nothing to classify.")
        driver.close()
        return

    print("Building CLIP text embeddings for the 10-category taxonomy …", file=sys.stderr)
    text_matrix = build_text_matrix()

    ids = [i for i, _ in imgs]
    vecs = np.array([v for _, v in imgs], dtype=np.float32)
    subjects, margins, confident = classify(vecs, text_matrix, args.margin_threshold)

    # ---- report plan ----
    print(f"\nRun: {WRITER_VERSION}  margin-threshold={args.margin_threshold}")
    print(f"Total images classified: {len(ids)}")
    print(f"Confident (margin >= {args.margin_threshold}): {confident.sum()} ({confident.mean():.1%})")
    print("\nCategory counts (all, then confident-only):")
    for cat in CATEGORY_NAMES:
        mask = subjects == cat
        conf_mask = mask & confident
        print(f"  {cat:24s} all={mask.sum():6d}   confident={conf_mask.sum():6d}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        driver.close()
        return

    built_at = datetime.now(timezone.utc).isoformat()
    run_id = f"{WRITER_VERSION}@{built_at}"

    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    snap_path = os.path.join(SNAPSHOT_DIR, f"clip_subject_pre_snapshot_{built_at.replace(':', '-')}.json")
    print(f"\nTaking pre-write snapshot -> {snap_path}", file=sys.stderr)
    with driver.session(database=database) as sess:
        snapshot = [dict(rec) for rec in sess.run(SNAPSHOT_QUERY)]
    with open(snap_path, "w") as f:
        json.dump(snapshot, f)
    print(f"  {len(snapshot)} pre-existing clipSubject* nodes snapshotted", file=sys.stderr)

    rows = [
        {"imgId": ids[i], "subject": str(subjects[i]), "margin": float(margins[i]), "confident": bool(confident[i])}
        for i in range(len(ids))
    ]
    print(f"\nWriting {len(rows)} rows in batches of {args.batch_size}, run={run_id} …", file=sys.stderr)
    with driver.session(database=database) as sess:
        for start in range(0, len(rows), args.batch_size):
            batch = rows[start:start + args.batch_size]
            sess.run(WRITE_QUERY, rows=batch, runId=run_id)
            print(f"  wrote {start + len(batch)}/{len(rows)}", file=sys.stderr)

    driver.close()
    print(f"\nDone. Run id: {run_id}")


if __name__ == "__main__":
    main()
