"""
PrintMasterAI — repair King & McGaw DigitalImage embeddings stored under the wrong properties.
Version: KM-IMAGE-EMBEDDING-REPAIR-1.0

Every other DigitalImage in the ACKG (112,171 of them) keeps its vectors like this, and the two
vector indexes are built on it:

    embedding             DINOv2-Large CLS, 1024-d   -> index digitalImageDinov2Embedding
    embeddingModel/Dim/embeddedAt
    clipImageEmbedding    CLIP ViT-B/32,     512-d   -> index digitalImageClipEmbedding
    clipImageEmbeddingModel/Dim, clipEmbeddedAt

`embed_poster_images.py` (EMBED-POSTER-IMAGES-2.0) wrote King & McGaw's differently: DINOv2 to
`dinov2Embedding`, and CLIP ViT-L/14 (768-d) to `embedding`. So all 570 King & McGaw images were
absent from the DINOv2 index (wrong property) and from the CLIP index (wrong property AND wrong
dimension), and their 768-d vectors sat in the property every DINOv2 reader treats as 1024-d.

The repair, per image:
  1. DINOv2: `dinov2Embedding` -> `embedding` (+ Model/Dim/embeddedAt), then drop the `dinov2*` set.
     The stored vector is kept only if a fresh recompute from the live image agrees (cosine >=
     0.99). The old embed script silently substituted a synthetic canvas whenever a download
     failed, so a stored vector is not trusted until it is re-derived from the real image.
  2. CLIP: compute ViT-B/32 (512-d, the graph's CLIP model, same recipe as embed_tate_images.py)
     into `clipImageEmbedding*`. The 768-d ViT-L/14 vectors are discarded (snapshot keeps them).

    venv-embeddings/bin/python repair_km_image_embeddings.py                  # compute + snapshot, NO writes
    venv-embeddings/bin/python repair_km_image_embeddings.py --apply PLAN.json
    venv-embeddings/bin/python repair_km_image_embeddings.py --verify         # exits 1 on residue
    venv-embeddings/bin/python repair_km_image_embeddings.py --rollback SNAPSHOT.json
"""
import argparse
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")

DINO_MODEL = "facebook/dinov2-large"
CLIP_MODEL = "openai/clip-vit-base-patch32"
CLIP_DIM = 512
DINO_AGREE_COS = 0.99
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


# Label-scoped on purpose: an unlabelled MATCH would silently skip the id index.
FETCH = """
MATCH (img:DigitalImage)
WHERE img.id STARTS WITH 'km-img-' AND img.dinov2Embedding IS NOT NULL
RETURN img.id AS id, img.sourceUrl AS url,
       img.dinov2Embedding AS dino, img.dinov2Model AS dinoModel, img.dinov2Dim AS dinoDim,
       img.dinov2EmbeddedAt AS dinoAt,
       img.embedding AS oldEmbedding, img.embeddingModel AS oldEmbeddingModel,
       img.embeddingDim AS oldEmbeddingDim, img.embeddedAt AS oldEmbeddedAt
ORDER BY id
"""

APPLY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.id})
WHERE img.dinov2Embedding IS NOT NULL
SET img.embedding = img.dinov2Embedding,
    img.embeddingModel = img.dinov2Model,
    img.embeddingDim = img.dinov2Dim,
    img.embeddedAt = img.dinov2EmbeddedAt,
    img.clipImageEmbedding = row.clip,
    img.clipImageEmbeddingModel = $clipModel,
    img.clipImageEmbeddingDim = $clipDim,
    img.clipEmbeddedAt = row.at
REMOVE img.dinov2Embedding, img.dinov2Model, img.dinov2Dim, img.dinov2EmbeddedAt
RETURN count(img) AS n
"""

ROLLBACK = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.id})
SET img.embedding = row.oldEmbedding, img.embeddingModel = row.oldEmbeddingModel,
    img.embeddingDim = row.oldEmbeddingDim, img.embeddedAt = row.oldEmbeddedAt,
    img.dinov2Embedding = row.dino, img.dinov2Model = row.dinoModel,
    img.dinov2Dim = row.dinoDim, img.dinov2EmbeddedAt = row.dinoAt
REMOVE img.clipImageEmbedding, img.clipImageEmbeddingModel, img.clipImageEmbeddingDim, img.clipEmbeddedAt
RETURN count(img) AS n
"""

VERIFY = """
MATCH (img:DigitalImage) WHERE img.id STARTS WITH 'km-img-' AND img.embeddingExcludedReason IS NULL
RETURN count(img) AS total,
  sum(CASE WHEN img.dinov2Embedding IS NOT NULL THEN 1 ELSE 0 END) AS legacyDino,
  sum(CASE WHEN img.embedding IS NOT NULL AND size(img.embedding) = 1024
            AND img.embeddingModel = $dino THEN 1 ELSE 0 END) AS dinoOk,
  sum(CASE WHEN img.clipImageEmbedding IS NOT NULL AND size(img.clipImageEmbedding) = $clipDim
            AND img.clipImageEmbeddingModel = $clip THEN 1 ELSE 0 END) AS clipOk
"""


def download(url):
    last = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
            if r.status_code == 200 and r.content:
                return r.content, None
            last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(1.5 * (attempt + 1))
    return None, last  # never substitute a synthetic image


def cosine(a, b):
    import numpy as np
    a, b = np.asarray(a, dtype="float64"), np.asarray(b, dtype="float64")
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))


def embed_dinov2(processor, model, image):
    """Raw CLS token: the recipe embed_tate_images.py used for the other 112,171 images."""
    import torch
    with torch.no_grad():
        out = model(**processor(images=image, return_tensors="pt"))
    return out.last_hidden_state[:, 0, :].squeeze(0).tolist()


def embed_clip_image(processor, model, image):
    """Raw image features, as embed_tate_images.py. (Not imported from there: it demands NEO4J_* at import.)"""
    import torch
    with torch.no_grad():
        feats = model.get_image_features(**processor(images=image, return_tensors="pt"))
    return feats.squeeze(0).tolist()


def compute(session, out_dir):
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

    rows = session.run(FETCH).data()
    print(f"{len(rows)} King & McGaw images carry legacy `dinov2Embedding`")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    snap = os.path.join(out_dir, f"km_image_embedding_repair_presnapshot_{ts}.json")
    with open(snap, "w") as f:
        json.dump({"version": "KM-IMAGE-EMBEDDING-REPAIR-1.0", "takenAt": ts, "rows": rows}, f)
    print("snapshot ->", snap)

    print("downloading...")
    with ThreadPoolExecutor(8) as ex:
        blobs = list(ex.map(lambda r: download(r["url"]), rows))

    print("loading models...")
    dino_p, dino_m = AutoImageProcessor.from_pretrained(DINO_MODEL), AutoModel.from_pretrained(DINO_MODEL)
    clip_p, clip_m = CLIPProcessor.from_pretrained(CLIP_MODEL), CLIPModel.from_pretrained(CLIP_MODEL)
    dino_m.eval(), clip_m.eval()

    plan, bad = [], []
    at = datetime.now(timezone.utc).isoformat()
    for n, (r, (blob, err)) in enumerate(zip(rows, blobs), 1):
        if blob is None:
            bad.append({"id": r["id"], "why": f"download failed: {err}"})
            continue
        img = Image.open(io.BytesIO(blob)).convert("RGB")
        agree = cosine(embed_dinov2(dino_p, dino_m, img), r["dino"])
        if agree < DINO_AGREE_COS:
            bad.append({"id": r["id"], "why": f"stored DINOv2 disagrees with the live image (cos {agree:.3f})"})
            continue
        clip = embed_clip_image(clip_p, clip_m, img)
        assert len(clip) == CLIP_DIM, len(clip)
        plan.append({"id": r["id"], "clip": clip, "at": at, "dinoAgreement": round(agree, 5)})
        if n % 50 == 0:
            print(f"  {n}/{len(rows)}")

    path = os.path.join(out_dir, f"km_image_embedding_repair_plan_{ts}.json")
    with open(path, "w") as f:
        json.dump({"snapshot": snap, "plan": plan, "unrepairable": bad}, f)
    print(f"\nplan ok: {len(plan)} | unrepairable: {len(bad)}")
    for b in bad[:20]:
        print("  ", b)
    print("plan ->", path, "\n(no graph writes made)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", metavar="PLAN")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--rollback", metavar="SNAPSHOT")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with driver.session(database="neo4j") as s:
        if args.verify:
            v = s.run(VERIFY, dino=DINO_MODEL, clip=CLIP_MODEL, clipDim=CLIP_DIM).single().data()
            print(v)
            ok = v["legacyDino"] == 0 and v["dinoOk"] == v["total"] and v["clipOk"] == v["total"]
            print("OK" if ok else "RESIDUE")
            sys.exit(0 if ok else 1)
        if args.rollback:
            rows = json.load(open(args.rollback))["rows"]
            print("rolled back", s.run(ROLLBACK, rows=rows).single()["n"], "of", len(rows))
            return
        if args.apply:
            plan = json.load(open(args.apply))["plan"]
            total = 0
            for i in range(0, len(plan), 50):
                total += s.run(APPLY, rows=plan[i:i + 50], clipModel=CLIP_MODEL, clipDim=CLIP_DIM).single()["n"]
            print(f"repaired {total} of {len(plan)} planned images")
            v = s.run(VERIFY, dino=DINO_MODEL, clip=CLIP_MODEL, clipDim=CLIP_DIM).single().data()
            print("after:", v)
            return
        compute(s, HERE)


if __name__ == "__main__":
    main()
