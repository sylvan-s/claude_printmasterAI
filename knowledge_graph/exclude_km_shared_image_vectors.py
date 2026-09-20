"""
PrintMasterAI — strip image vectors from King & McGaw images that are one file shared by several works.
Version: KM-SHARED-IMAGE-EXCLUSION-1.0

King & McGaw serves ONE image file for several different products in some families: four Miffy
prints, six theatre posters, three Grimshaw paintings (13 images, 3 files, found 2026-09-19).
Each `DigitalImage` node is a distinct node, so each carries an identical DINOv2 and CLIP vector —
and that vector is a property of the family's picture, not of any one work. Left in the vector
indexes they match each other at cosine 1.000 and match unrelated works at whatever the shared
picture happens to resemble, which is noise with the authority of a similarity score.

WHAT THIS DOES NOT TOUCH. Identical vectors are common across the graph (7,103 groups, 16,080
images), but 6,290 of those groups are several photographs of ONE work, which is real evidence.
The rule here is narrow and checked twice: a group qualifies only when its images are attached
to at least two DIFFERENT ConceptualWorks AND the downloaded files are byte-identical (md5).
A vector match alone is never enough.

Per qualifying image: the DINOv2 and CLIP vector properties are removed, and the node is marked

    embeddingExcludedReason  'byte-identical image file shared by N different works'
    embeddingExcludedAt      ISO timestamp
    sharedImageMd5           the file hash (the group key)

`embed_poster_images.py` skips marked images, so a re-run does not silently re-embed them. The
image and its SHOWS edge stay; only the vectors go. `--rollback` restores them from the snapshot.

    python3 exclude_km_shared_image_vectors.py                 # find + confirm + snapshot, NO writes
    python3 exclude_km_shared_image_vectors.py --apply PLAN.json
    python3 exclude_km_shared_image_vectors.py --rollback SNAPSHOT.json
    python3 exclude_km_shared_image_vectors.py --verify
"""
import argparse
import hashlib
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
import requests
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

VECTOR_PROPS = ("embedding", "embeddingModel", "embeddingDim", "embeddedAt",
                "clipImageEmbedding", "clipImageEmbeddingModel", "clipImageEmbeddingDim", "clipEmbeddedAt")


def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


# Label-scoped on purpose: an unlabelled MATCH would silently skip the id index.
FETCH = """
MATCH (img:DigitalImage)-[:SHOWS]->(cw:ConceptualWork)
WHERE img.id STARTS WITH 'km-img-' AND img.embedding IS NOT NULL
RETURN img.id AS id, img.sourceUrl AS url, cw.id AS cwId, img.embedding AS emb,
       img.embeddingModel AS embeddingModel, img.embeddingDim AS embeddingDim, img.embeddedAt AS embeddedAt,
       img.clipImageEmbedding AS clipImageEmbedding, img.clipImageEmbeddingModel AS clipImageEmbeddingModel,
       img.clipImageEmbeddingDim AS clipImageEmbeddingDim, img.clipEmbeddedAt AS clipEmbeddedAt
ORDER BY id
"""

APPLY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.id})
WHERE img.embedding IS NOT NULL
SET img.embeddingExcludedReason = row.reason,
    img.embeddingExcludedAt = $at,
    img.sharedImageMd5 = row.md5
REMOVE img.embedding, img.embeddingModel, img.embeddingDim, img.embeddedAt,
       img.clipImageEmbedding, img.clipImageEmbeddingModel, img.clipImageEmbeddingDim, img.clipEmbeddedAt
RETURN count(img) AS n
"""

ROLLBACK = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.id})
SET img.embedding = row.emb, img.embeddingModel = row.embeddingModel,
    img.embeddingDim = row.embeddingDim, img.embeddedAt = row.embeddedAt,
    img.clipImageEmbedding = row.clipImageEmbedding, img.clipImageEmbeddingModel = row.clipImageEmbeddingModel,
    img.clipImageEmbeddingDim = row.clipImageEmbeddingDim, img.clipEmbeddedAt = row.clipEmbeddedAt
REMOVE img.embeddingExcludedReason, img.embeddingExcludedAt, img.sharedImageMd5
RETURN count(img) AS n
"""

VERIFY = """
MATCH (img:DigitalImage) WHERE img.id STARTS WITH 'km-img-'
RETURN count(img) AS total,
  sum(CASE WHEN img.embeddingExcludedReason IS NOT NULL THEN 1 ELSE 0 END) AS excluded,
  sum(CASE WHEN img.embeddingExcludedReason IS NOT NULL AND
            (img.embedding IS NOT NULL OR img.clipImageEmbedding IS NOT NULL) THEN 1 ELSE 0 END) AS excludedStillEmbedded,
  sum(CASE WHEN img.embeddingExcludedReason IS NULL AND img.embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
"""


def md5_of(url):
    for attempt in range(3):
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
            if r.status_code == 200 and r.content:
                return hashlib.md5(r.content).hexdigest()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.5 * (attempt + 1))
    return None


def find(session):
    rows = session.run(FETCH).data()
    print(f"{len(rows)} King & McGaw images carry a DINOv2 vector")
    # Candidate groups from the vectors: identical DINOv2 vector on >= 2 DIFFERENT works.
    by_vec = defaultdict(list)
    for r in rows:
        by_vec[hashlib.md5(np.round(np.asarray(r["emb"], dtype="float64"), 5).tobytes()).hexdigest()].append(r)
    cand = [g for g in by_vec.values() if len({r["cwId"] for r in g}) > 1]
    print(f"{len(cand)} candidate groups by vector ({sum(len(g) for g in cand)} images)")

    plan, rejected = [], []
    flat = [r for g in cand for r in g]
    with ThreadPoolExecutor(8) as ex:
        hashes = dict(zip((r["id"] for r in flat), ex.map(lambda r: md5_of(r["url"]), flat)))
    for g in cand:
        md5s = {hashes[r["id"]] for r in g}
        n_works = len({r["cwId"] for r in g})
        if None in md5s or len(md5s) != 1:
            rejected.append({"ids": [r["id"] for r in g], "why": f"files not confirmed byte-identical ({sorted(map(str, md5s))})"})
            continue
        for r in g:
            plan.append({**{k: r[k] for k in ("id", "cwId", "url")}, "md5": md5s.copy().pop(),
                         "reason": f"byte-identical image file shared by {n_works} different works"})
    return plan, rejected, {r["id"]: r for r in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", metavar="PLAN")
    ap.add_argument("--rollback", metavar="SNAPSHOT")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with driver.session(database="neo4j") as s:
        if args.verify:
            v = s.run(VERIFY).single().data()
            print(v)
            ok = v["excludedStillEmbedded"] == 0
            print("OK" if ok else "RESIDUE")
            sys.exit(0 if ok else 1)
        if args.rollback:
            rows = json.load(open(args.rollback))["rows"]
            print("rolled back", s.run(ROLLBACK, rows=rows).single()["n"], "of", len(rows))
            return
        if args.apply:
            plan = json.load(open(args.apply))["plan"]
            at = datetime.now(timezone.utc).isoformat()
            n = s.run(APPLY, rows=plan, at=at).single()["n"]
            print(f"excluded {n} of {len(plan)} planned images")
            print("after:", s.run(VERIFY).single().data())
            return

        plan, rejected, full = find(s)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap = os.path.join(HERE, f"km_shared_image_exclusion_presnapshot_{ts}.json")
        with open(snap, "w") as f:
            json.dump({"version": "KM-SHARED-IMAGE-EXCLUSION-1.0", "takenAt": ts,
                       "rows": [full[p["id"]] for p in plan]}, f)
        path = os.path.join(HERE, f"km_shared_image_exclusion_plan_{ts}.json")
        with open(path, "w") as f:
            json.dump({"snapshot": snap, "plan": plan, "rejected": rejected}, f, indent=1)
        groups = defaultdict(list)
        for p in plan:
            groups[p["md5"]].append(p)
        print(f"\n{len(plan)} images in {len(groups)} confirmed byte-identical groups | rejected groups: {len(rejected)}")
        for md5, g in groups.items():
            print(f"  {md5[:10]} -> {len(g)} images, {len({p['cwId'] for p in g})} works: "
                  + ", ".join(sorted(p['cwId'].replace('km-cw-', '')[:34] for p in g))[:200])
        for r in rejected:
            print("  REJECTED", r)
        print("snapshot ->", snap, "\nplan ->", path, "\n(no graph writes made)")


if __name__ == "__main__":
    main()
