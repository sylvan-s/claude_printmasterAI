"""
PrintMasterAI — SIFT + RANSAC geometric verification as a work-identity confirmer.
Version: GEOM-PROBE-1.0

RUN ONCE, 2026-09-11, AND REJECTED. Kept so the measurement is not repeated from scratch.
Reads only; nothing here writes to the graph and there is no --merge mode.

THE PROPOSAL THIS TESTS

`find_image_similar_work_candidates.py` uses DINOv2 for RETRIEVAL and refuses to promote on
similarity alone, because its own measurement shows no threshold separates the classes: true
pairs top out at 0.973 while different-work pairs reach 0.985. Promotion therefore needs an
exact METADATA corroborator, which leaves three populations unreachable — the headline being
634 auction Picasso works citing no catalogue at all.

The standing proposal (2026-08-31) was to add the other half of a classic instance-retrieval
architecture: coarse global descriptor to retrieve, then local features plus a RANSAC
homography to confirm, scoring on INLIER COUNT. The appeal is that an inlier count is not a
fuzzy similarity — it asserts that one matrix produced both images — so it could stand as an
independent corroborator without touching `catalogue_matching.py`'s prohibition.

MEASURED OVER 1,040 LABELLED PAIRS. IT DOES NOT WORK, for two independent reasons.

1. IT LOSES TO THE EMBEDDING IT WAS MEANT TO CONFIRM.

       same work vs different work        AUC
         DINOv2 raw cosine               0.977
         SIFT inlier ratio               0.885
         SIFT inlier count               0.843

   The premise — that a lone embedding stays in a mushy band and geometry sharpens it — is
   false on this corpus. DINOv2 is already the stronger discriminator.

2. IT IS AT CHANCE ON STATES, the class it existed to survive.

       same work vs STATE of the same work   AUC
         DINOv2 raw cosine                  0.575
         SIFT inlier count                  0.498   <- chance

   This is not a tuning failure and no operating point fixes it. A state IS the same matrix,
   so the signal geometry measures is precisely the signal that cannot discriminate here.
   "Notepad Doodle 3 (State I)" vs "(State III)": 1,030 inliers at ratio 0.91. "Suckers,
   state I" vs "state II": ratio 0.97. At inliers >= 50 AND ratio >= 0.95 — strict enough to
   cost 65% of true pairs — 8% of state pairs still fire.

THE CONFOUND THE 2026-08-31 DESIGN MISSED

That design argued frame, matting and wall "just become outliers that RANSAC rejects". True
of a PHOTOGRAPHIC frame. False when the frame is part of the print. Picasso's 1962-63 linocut
portraits are printed inside one shared painted trompe-l'oeil border block covering ~60% of
the sheet:

    La Dame a la Collerette (Bloch 1147) vs L'Homme a la Fraise (Bloch 1148)
        SIFT   590 inliers, ratio 0.76      -> confidently WRONG
        DINOv2 0.523                        -> correctly low

Three of the four hardest false positives are this same family (Bloch 1146/1147/1148 and
1267/1268). Geometry fails exactly where the embedding succeeds, so it is not even a useful
second opinion.

WHAT IT IS GENUINELY GOOD AT, recorded so the result is not overstated

Once both images show the same image region the inlier ratio goes near-binary. The "L'Ecuyere"
family — one work spelled six ways across sources — returns 2,400+ inliers at ratio 0.99 while
cosine sits at 0.81-0.89, inside the overlap band. That is CONFIDENCE on a pair already
retrieved, not discrimination between pairs, and it does not justify the dependency.

CORRECTED WHILE RUNNING, recorded rather than quietly dropped: keypoint starvation on sparse
line etchings was predicted beforehand and is NOT the problem. Only 4% of images yield under
100 SIFT keypoints and the missed positives had a median of 174. The misses are crop and scale
differences, not texture poverty.

CONSEQUENCE FOR THE DEDUP PLAN

No image-only signal separates a state from its own work. ADR-0017 Decision 1 (decompose
plateDesignation and state out of the title) is therefore not a prerequisite that would make
geometry safe — it is the answer, and no image model substitutes for it. Third image-side
approach to fail this way, after the 2026-09-10 DINOv2 threshold sweep and the GDS
feature-Jaccard attempt in ADR-0009 Amendment 1.

Usage:
    python3 probe_geometric_verification.py --artist "Pablo Picasso" --out probe/
    python3 probe_geometric_verification.py --artist "Pablo Picasso" --hard --out probe/

Requires opencv-python-headless. Anaconda's Python 3.8 has no wheel for it; the run used a
venv on /usr/bin/python3 (3.9), cv2 5.0.0.

NOT BIT-REPRODUCIBLE: a work with several images contributes whichever one Neo4j returns
first, so re-running moves the small-sample figures a little (N_same_cat's >= 30 rate moved
4%-7% between two runs). The AUCs, which are what the conclusion rests on, held to +-0.01.
"""

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import random
import re
import ssl
import sys
import time
import urllib.request
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase

SEED = 11
MAX_DIM = 1024          # SIFT input; larger buys keypoints the matcher does not need
LOWE_RATIO = 0.75
RANSAC_PX = 5.0
MIN_GOOD_MATCHES = 4    # a homography needs four points


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


# One row per (work, image). Restricted to works that HAVE an embedded image, which is the
# only population any of this can be measured on.
ROWS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:SHOWS]-(img:DigitalImage)
WHERE img.sourceUrl IS NOT NULL AND img.embedding IS NOT NULL
  AND ($artist IS NULL OR a.name = $artist)
RETURN a.name AS artist, w.id AS workId, w.name AS title, w.dateCreated_year AS year,
       img.id AS imgId, img.sourceUrl AS url, img.embedding AS emb,
       [(i)<-[:DOCUMENTS]-(s:SourceRecord) | s.sourceType] AS sourceTypes,
       [(w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
        | [cr.numberingPrefix, ce.number]] AS citations
"""

STATE_RE = re.compile(
    r"[\s,\-–(\[]+(?:state|etat|état)\s*(?:i{1,3}v?|iv|vi{0,3}|ix|x|[1-9])\b[\s)\]]*", re.I)


def state_key(title):
    """The title with its state designation removed, or None if it carried none.

    Two works whose titles agree under this key and differ above it are the same matrix and
    different works — the adversarial class."""
    if not title:
        return None
    stripped = STATE_RE.sub(" ", title)
    if stripped == title:
        return None
    return re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()


def entry_base(number):
    """Leading digits only. Baer numbers carry state and edition designations
    ("1173.B.b.1") that doc 08 models on State and Impression, not ConceptualWork."""
    digits = ""
    for ch in str(number):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits or None


def cosine(a, b):
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))


def load_works(session, artist):
    works = {}
    for r in session.run(ROWS_QUERY, artist=artist):
        w = works.setdefault(r["workId"], {
            "workId": r["workId"], "artist": r["artist"], "title": r["title"],
            "year": r["year"], "images": [], "cites": set()})
        w["images"].append({"imgId": r["imgId"], "url": r["url"], "emb": r["emb"],
                            "sourceTypes": [t for t in r["sourceTypes"] if t]})
        for prefix, number in r["citations"]:
            if prefix and number and entry_base(number):
                w["cites"].add((prefix, entry_base(number)))
    return works


def make_pair(cls, wa, ia, wb, ib, note=""):
    return {"cls": cls, "note": note,
            "workA": wa["workId"], "workB": wb["workId"],
            "titleA": wa["title"], "titleB": wb["title"],
            "yearA": wa["year"], "yearB": wb["year"],
            "imgA": ia["imgId"], "imgB": ib["imgId"],
            "urlA": ia["url"], "urlB": ib["url"],
            "dino": round(cosine(ia["emb"], ib["emb"]), 4)}


def build_pairs(session, artist, hard):
    """Five classes.

    P_cross_source  same work, institutional image vs auction image. The dedup case.
    P_same_source   same work, two images from one source. Sanity floor for the matcher.
    N_state         SAME MATRIX, DIFFERENT WORK. The class that decides the question.
    N_same_cat      adjacent base numbers under one catalogue prefix — different plates of
                    one portfolio, the realistic hard negative.
    N_random        different works, no shared citation. The floor.

    --hard instead emits N_same_entry: distinct works citing the SAME base number. That is
    the generator's own overlapping class, but it is CONTAMINATED with unmerged true
    duplicates (dino reaches 1.000), so it is read as a disagreement map and never as a
    labelled negative.
    """
    random.seed(SEED)
    works = load_works(session, artist)
    print(f"  {len(works)} imaged works for {artist or 'all artists'}", flush=True)
    pairs = []

    buckets = defaultdict(list)
    for w in works.values():
        for prefix, base in w["cites"]:
            buckets[(prefix, base)].append(w)

    if hard:
        for (prefix, base), ws in buckets.items():
            for i in range(len(ws)):
                for j in range(i + 1, len(ws)):
                    pairs.append(make_pair("N_same_entry", ws[i], ws[i]["images"][0],
                                           ws[j], ws[j]["images"][0], f"{prefix} {base}"))
        return pairs

    for w in works.values():
        inst = [i for i in w["images"] if "institutional" in i["sourceTypes"]]
        auct = [i for i in w["images"] if "auction" in i["sourceTypes"]]
        if inst and auct:
            pairs.append(make_pair("P_cross_source", w, inst[0], w, auct[0]))

    n = 0
    for w in works.values():
        if len(w["images"]) >= 2 and n < 60:
            a, b = w["images"][0], w["images"][1]
            if a["imgId"] != b["imgId"] and set(a["sourceTypes"]) == set(b["sourceTypes"]):
                pairs.append(make_pair("P_same_source", w, a, w, b))
                n += 1

    by_prefix = defaultdict(lambda: defaultdict(list))
    for (prefix, base), ws in buckets.items():
        by_prefix[prefix][base] = ws
    n = 0
    for prefix, by_base in by_prefix.items():
        bases = sorted(by_base)
        for i in range(len(bases) - 1):
            if n >= 150:
                break
            wa, wb = by_base[bases[i]][0], by_base[bases[i + 1]][0]
            if wa["workId"] == wb["workId"]:
                continue
            pairs.append(make_pair("N_same_cat", wa, wa["images"][0], wb, wb["images"][0],
                                   f"{prefix} {bases[i]} vs {bases[i + 1]}"))
            n += 1

    # States are graph-wide: the artists carrying them are Hamilton, Kitaj, Thiebaud,
    # Ruscha, Oldenburg — not the artist under test.
    state_rows = ROWS_QUERY.replace("AND ($artist IS NULL OR a.name = $artist)",
                                    "AND w.name =~ $re")
    states = {}
    for r in session.run(state_rows,
                         re=r"(?i).*(state|etat|état)\s*(i{1,3}v?|iv|vi{0,3}|ix|x|[1-9])\b.*"):
        w = states.setdefault(r["workId"], {
            "workId": r["workId"], "artist": r["artist"], "title": r["title"],
            "year": r["year"], "images": [], "cites": set()})
        w["images"].append({"imgId": r["imgId"], "url": r["url"], "emb": r["emb"],
                            "sourceTypes": []})
    groups = defaultdict(list)
    for w in states.values():
        k = state_key(w["title"])
        if k and len(k) >= 6:
            groups[(w["artist"], k)].append(w)
    for (state_artist, k), ws in groups.items():
        for i in range(len(ws) - 1):
            if ws[i]["title"] != ws[i + 1]["title"]:
                pairs.append(make_pair("N_state", ws[i], ws[i]["images"][0],
                                       ws[i + 1], ws[i + 1]["images"][0],
                                       f"{state_artist}: {k}"))

    pool = list(works.values())
    n = 0
    while n < 80 and len(pool) > 2:
        wa, wb = random.sample(pool, 2)
        if wa["cites"] & wb["cites"]:
            continue
        pairs.append(make_pair("N_random", wa, wa["images"][0], wb, wb["images"][0]))
        n += 1
    return pairs


def fetch_images(pairs, img_dir):
    os.makedirs(img_dir, exist_ok=True)
    urls = {}
    for p in pairs:
        urls[p["imgA"]] = p["urlA"]
        urls[p["imgB"]] = p["urlB"]
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    def path(image_id):
        return os.path.join(img_dir, hashlib.sha1(image_id.encode()).hexdigest() + ".jpg")

    def get(item):
        image_id, url = item
        dest = path(image_id)
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            return "cached"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PrintMasterAI/research"})
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                body = r.read()
            if len(body) < 1000:
                return "tiny"
            with open(dest, "wb") as fh:
                fh.write(body)
            return "ok"
        except Exception as exc:
            return f"err:{type(exc).__name__}"

    counts = defaultdict(int)
    with cf.ThreadPoolExecutor(max_workers=12) as pool:
        for status in pool.map(get, urls.items()):
            counts[status] += 1
    print(f"  images: {dict(counts)}", flush=True)
    return {i: os.path.basename(path(i)) for i in urls}


def verify_all(pairs, imgmap, img_dir):
    import cv2

    sift = cv2.SIFT_create(nfeatures=4000)
    matcher = cv2.BFMatcher()
    cache = {}

    def feats(image_id):
        if image_id not in cache:
            grey = cv2.imread(os.path.join(img_dir, imgmap[image_id]), cv2.IMREAD_GRAYSCALE)
            if grey is None:
                cache[image_id] = (None, None)
            else:
                h, w = grey.shape
                scale = MAX_DIM / max(h, w)
                if scale < 1.0:
                    grey = cv2.resize(grey, (int(w * scale), int(h * scale)),
                                      interpolation=cv2.INTER_AREA)
                cache[image_id] = sift.detectAndCompute(grey, None)
        return cache[image_id]

    results = []
    started = time.time()
    for n, p in enumerate(pairs, 1):
        kp_a, des_a = feats(p["imgA"])
        kp_b, des_b = feats(p["imgB"])
        out = dict(p)
        if des_a is None or des_b is None or len(des_a) < 2 or len(des_b) < 2:
            out.update(kpA=0, kpB=0, good=0, inliers=0, inlierRatio=0.0)
            results.append(out)
            continue
        knn = matcher.knnMatch(des_a, des_b, k=2)
        good = [a for a, b in (m for m in knn if len(m) == 2)
                if a.distance < LOWE_RATIO * b.distance]
        out.update(kpA=len(kp_a), kpB=len(kp_b), good=len(good))
        if len(good) < MIN_GOOD_MATCHES:
            out.update(inliers=0, inlierRatio=0.0)
            results.append(out)
            continue
        src = np.float32([kp_a[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
        dst = np.float32([kp_b[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
        _, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC_PX)
        inliers = int(mask.sum()) if mask is not None else 0
        out.update(inliers=inliers, inlierRatio=round(inliers / len(good), 3))
        results.append(out)
        if n % 100 == 0:
            print(f"    {n}/{len(pairs)}  {time.time() - started:.0f}s", flush=True)
    return results


def auc(pos, neg, key):
    a = np.array([key(r) for r in pos], dtype=float)
    b = np.array([key(r) for r in neg], dtype=float)
    if not len(a) or not len(b):
        return float("nan")
    wins = (a[:, None] > b[None, :]).sum() + 0.5 * (a[:, None] == b[None, :]).sum()
    return wins / (len(a) * len(b))


def report(results):
    P = [r for r in results if r["cls"].startswith("P_")]
    NS = [r for r in results if r["cls"] == "N_state"]
    ND = [r for r in results if r["cls"] in ("N_same_cat", "N_random")]

    print(f"\n{'class':16s} {'n':>5s} {'inl med':>8s} {'inl p90':>8s} "
          f"{'>=30':>6s} {'dino med':>9s}")
    for c in ("P_cross_source", "P_same_source", "N_state", "N_same_cat", "N_random",
              "N_same_entry"):
        sub = [r for r in results if r["cls"] == c]
        if not sub:
            continue
        inl = [r["inliers"] for r in sub]
        print(f"{c:16s} {len(sub):5d} {np.median(inl):8.0f} {np.percentile(inl, 90):8.0f} "
              f"{sum(1 for x in inl if x >= 30) / len(inl):6.0%} "
              f"{np.median([r['dino'] for r in sub]):9.3f}")

    if not (P and ND):
        return
    print(f"\n{'score':18s} {'P vs different-work':>21s} {'P vs STATE':>12s}")
    for name, key in (("DINOv2 cosine", lambda r: r["dino"]),
                      ("SIFT inliers", lambda r: r["inliers"]),
                      ("SIFT inlier ratio", lambda r: r["inlierRatio"])):
        print(f"{name:18s} {auc(P, ND, key):21.3f} {auc(P, NS, key):12.3f}")

    print("\nStrong-geometry rule: inliers >= 50 AND inlierRatio >= r")
    print(f"{'ratio':>6} {'P recall':>9} {'N_diff FP':>10} {'N_state FP':>11}")
    for rt in (0.50, 0.70, 0.80, 0.90, 0.95):
        fires = lambda r: r["inliers"] >= 50 and r["inlierRatio"] >= rt  # noqa: E731
        print(f"{rt:6.2f} {sum(1 for r in P if fires(r)) / len(P):9.0%} "
              f"{sum(1 for r in ND if fires(r)) / len(ND):10.0%} "
              f"{(sum(1 for r in NS if fires(r)) / len(NS)) if NS else float('nan'):11.0%}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist", default="Pablo Picasso")
    ap.add_argument("--hard", action="store_true",
                    help="emit N_same_entry (contaminated; a disagreement map, not labels)")
    ap.add_argument("--out", default="geom_probe")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            print("building pairs...", flush=True)
            pairs = build_pairs(session, args.artist, args.hard)
    finally:
        driver.close()
    print(f"  {len(pairs)} pairs", flush=True)

    print("fetching images...", flush=True)
    img_dir = os.path.join(args.out, "img")
    imgmap = fetch_images(pairs, img_dir)

    print("verifying...", flush=True)
    results = verify_all(pairs, imgmap, img_dir)
    dest = os.path.join(args.out, "results_hard.json" if args.hard else "results.json")
    with open(dest, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"  wrote {dest}")
    report(results)


if __name__ == "__main__":
    main()
