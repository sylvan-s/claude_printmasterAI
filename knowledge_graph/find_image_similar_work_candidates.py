"""
PrintMasterAI — image-similarity candidate generator for cross-source work identity.
Version: IMAGE-CANDIDATES-1.0

The second generator feeding `merge_duplicate_work_clusters.py`'s JSON contract, alongside
`find_museum_anchored_work_clusters.py`. Neither one merges; the existing merger does, and
it already implements ADR-0017's naming contract.

WHY THIS EXISTS, GIVEN DINOv2 WAS ALREADY REJECTED FOR WORK MERGING

The 2026-09-10 probe rejected DINOv2 as a merge mechanism and that rejection was correct
for what it tested: a global `>= 0.98` similarity sweep, which recovered ~44% of known
duplicates and still fired on different prints. Re-probed 2026-09-11 against a labelled
cross-source set that did not exist then (the museum/auction pairs confirmed by the first
anchored merge), the picture splits cleanly in two:

  THRESHOLDS STILL FAIL, and the numbers say why:

      class                                 n        mean   p95     max
      same work                            27       0.896  0.961   0.973
      different work, shares a cat entry  221       0.615  0.933   0.970
      different work                  4370062       0.363  0.625   0.985

  True pairs top out at 0.973 while other pairs reach 0.985. A 0.98 cut keeps almost no
  true pair. There is no threshold that separates these classes.

  RETRIEVAL WORKS. Asking "is the true counterpart the nearest neighbour" rather than
  "is this pair above a line", against 2,205 candidates:

      top-1 52%   top-3 87%   top-5 96%   top-10 100%

So similarity is used here to decide WHAT TO LOOK AT, never what is true. A candidate is
only promoted when an independent EXACT signal corroborates it. That keeps this inside the
standing prohibition on fuzzy identity matching (`catalogue_matching.py`) — nothing merges
because two things scored highly.

WHAT THIS REACHES THAT THE CATALOGUE ANCHOR CANNOT

`find_museum_anchored_work_clusters.py` can only see works that share a CatalogueEntry.
Three populations are invisible to it, all confirmed live:

  1. **634 auction Picasso works carry no catalogue citation at all** (536 with embedded
     images). Nothing to anchor on, ever.
  2. **Glued entry suffixes.** Picasso-Paris cites `Baer 618` for *Portrait de Vollard II*;
     Bonhams cites `Baer 618Bd`. The anchored finder deliberately leaves glued suffixes
     attached (Baer 1042A really is its own entry), so those never join. Image similarity
     crosses it: that pair scores 0.982.
  3. **Titles that no exact rule can bridge.** Tate's *Head of a Young Boy* (1945) and
     Picasso-Paris's *Tête de jeune garçon* (Mourlot 8, 1945) are the same work in two
     languages with no shared entry — 0.976. And where the museum record is `(Sans titre)`
     there is no title to match on at all.

CORROBORATION, exactly one of which must hold to promote

  a. shared catalogue BASE number (`entry_base_number`, so 618 meets 618Bd)
  b. title tier T1/T2 (`classify`, so punctuation and series clauses are handled)
  c. same creation year AND at least one shared Technique

(c) is what promotes the *Head of a Young Boy* case, which has neither a shared entry nor
a matching title. It is deliberately the weakest of the three and the most likely to be
wrong on portfolio plates, which is why a catalogue-base CONFLICT vetoes it outright:
two works citing the same catalogue with different base numbers are never proposed,
whatever they score and whatever else agrees.

Everything not promoted goes to a review queue ranked by similarity, which on the first run
is where the interesting material is. Read it before trusting the promotions.

CAVEAT, stated because the numbers above look better than they are: the labelled positive
set is 27 image pairs across 19 works, and it came from title-based merges, so it is a
biased sample of works whose titles already agreed. The top-5/top-10 figures are
encouraging, not established.

Usage:
    python3 find_image_similar_work_candidates.py --artist "Pablo Picasso" --json cands.json
    python3 merge_duplicate_work_clusters.py --json cands.json --artist "Pablo Picasso"
"""

import argparse
import json
import os
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase

from find_museum_anchored_work_clusters import classify, entry_base_number


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

DEFAULT_TOP_K = 10

# year+technique is the WEAKEST corroborator and must not stand on its own for a prolific
# artist: Picasso made hundreds of etchings in any given year. On the first run it carried
# 1,055 of 1,221 promotions, with median similarity 0.796 and a minimum of 0.387 — a pair
# agreeing only on "1933" and "Etching" at 0.387 is noise. It now also requires strong
# image agreement, and lands in its own bucket rather than `proposed`.
#
# This is NOT the threshold the 2026-09-10 probe rejected. Nothing is promoted by
# similarity alone; this is three weak signals that must ALL hold. The floor is the
# measured 50th percentile of the confirmed-positive class (0.903), so it keeps the half
# of true pairs that agree most strongly and discards the rest rather than guessing.
WEAK_CORROBORATOR_SIM_FLOOR = 0.90

# Pairs are proposed independently, but merge_duplicate_work_clusters.py folds OVERLAPPING
# clusters transitively through its alias map. So a node appearing in two proposed pairs
# chains them: if X merges with A and X also merges with B, A and B become one work even
# though nothing ever compared them. On the first run 84 of 171 clusters involved such a
# node, and three chains were provably wrong — Picasso reused titles decades apart, so
# "Tete de jeune fille" chained 1925 to 1945 across 7 nodes, "Nature morte au compotier"
# 1908 to 1945, "Le Taureau" 1936 to 1946 (a Histoire Naturelle etching and a lithograph).
#
# Each individual pair looked fine. Only the component is wrong, so the guard has to be at
# component level. A component whose anchor years span more than this many years is held
# whole rather than partly merged — picking which pair in a chain to keep would be a guess.
MAX_COMPONENT_YEAR_SPREAD = 3

WORKS_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(i:Impression)<-[:INCLUDES]-(:EditionRun)
      <-[:PRINTED_AS]-(cw:ConceptualWork)<-[:CREATED]-(a:Artist)
WHERE img.embedding IS NOT NULL AND ($artist IS NULL OR a.name = $artist)
OPTIONAL MATCH (cw)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(src:SourceRecord)
RETURN img.id AS imgId, img.embedding AS emb, cw.id AS workId, cw.name AS title,
       a.name AS artist, cw.dateCreated_year AS year,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations,
       collect(DISTINCT t.name) AS techniques,
       collect(DISTINCT src.sourceType) AS sourceTypes
"""


def load(session, artist):
    rows = [dict(r) for r in session.run(WORKS_QUERY, artist=artist)]
    works = {}
    for r in rows:
        w = works.setdefault(r["workId"], {
            "workId": r["workId"], "title": r["title"], "artist": r["artist"],
            "year": r["year"], "images": [], "vectors": [],
            "bases": set(), "techniques": set(), "institutional": False,
        })
        w["images"].append(r["imgId"])
        w["vectors"].append(r["emb"])
        for prefix, number in r["citations"]:
            if prefix and number:
                w["bases"].add((prefix, entry_base_number(number)))
        w["techniques"].update(t for t in r["techniques"] if t)
        if "institutional" in (r["sourceTypes"] or []):
            w["institutional"] = True
    return list(works.values())


def _centroid(w):
    """One vector per work. A work with several impressions photographed separately is
    still one work; averaging is the cheapest way to stop a single odd photograph from
    dominating its work's rank."""
    M = np.array(w["vectors"], dtype=np.float32)
    M /= np.linalg.norm(M, axis=1, keepdims=True)
    v = M.mean(axis=0)
    return v / np.linalg.norm(v)


def _numeric_prefix(base):
    """Leading digits of an entry number. "618Bd" -> "618", "1042A" -> "1042"."""
    digits = ""
    for ch in str(base):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits


def catalogue_verdict(a, b):
    """'agree' — a shared prefix with the same base number. 'conflict' — a shared prefix
    whose NUMERIC parts differ, which vetoes the pair outright. 'silent' otherwise.

    Conflict compares the numeric part, not the whole base, because a glued suffix is an
    edition designation we deliberately refuse to strip (`entry_base_number`). Picasso-Paris
    cites `Baer 618` for *Portrait de Vollard II* and Bonhams cites `Baer 618Bd`; on the
    first run that produced a CONFLICT veto on a true pair scoring 0.978. Refusing to MERGE
    on an ambiguous suffix is conservative and right; refusing to LOOK at it is not — the
    veto is a stronger action than silence and must be reserved for a real disagreement.
    `618` vs `618Bd` is now silent (no corroboration, but no veto); `618` vs `619` conflicts."""
    by_prefix_a = defaultdict(set)
    by_prefix_b = defaultdict(set)
    for prefix, base in a["bases"]:
        by_prefix_a[prefix].add(base)
    for prefix, base in b["bases"]:
        by_prefix_b[prefix].add(base)
    shared = set(by_prefix_a) & set(by_prefix_b)
    if not shared:
        return "silent"
    if any(by_prefix_a[p] & by_prefix_b[p] for p in shared):
        return "agree"
    for p in shared:
        nums_a = {_numeric_prefix(x) for x in by_prefix_a[p]}
        nums_b = {_numeric_prefix(x) for x in by_prefix_b[p]}
        if nums_a & nums_b:
            return "silent"
    return "conflict"


def corroboration(a, b, sim):
    """Returns (bucket, reason) where bucket is 'proposed', 'weak' or 'review'. A catalogue
    conflict overrides everything."""
    verdict = catalogue_verdict(a, b)
    if verdict == "conflict":
        return "review", "catalogue base numbers conflict"
    if verdict == "agree":
        return "proposed", "shared catalogue base number"
    tier = classify(a["title"], b["title"])
    if tier in ("T1_EXACT", "T2_SERIES"):
        return "proposed", f"title {tier}"
    if a["year"] and b["year"] and a["year"] == b["year"] and (a["techniques"] & b["techniques"]):
        shared = sorted(a["techniques"] & b["techniques"])[0]
        if sim >= WEAK_CORROBORATOR_SIM_FLOOR:
            return "weak", f"year {a['year']} + technique {shared} + sim>={WEAK_CORROBORATOR_SIM_FLOOR}"
        return "review", f"year+technique only, sim {sim:.3f} below floor"
    return "review", "no exact corroborator"


def build(session, artist, top_k):
    works = load(session, artist)
    anchors = [w for w in works if w["institutional"]]
    others = [w for w in works if not w["institutional"]]
    print(f"{len(works)} embedded works | {len(anchors)} institutional anchors | "
          f"{len(others)} candidates", flush=True)
    if not anchors or not others:
        return [], []

    A = np.stack([_centroid(w) for w in anchors])
    B = np.stack([_centroid(w) for w in others])
    S = A @ B.T

    proposed, weak, review, seen = [], [], [], set()
    for i, anchor in enumerate(anchors):
        for j in np.argsort(-S[i])[:top_k]:
            other = others[int(j)]
            key = tuple(sorted((anchor["workId"], other["workId"])))
            if key in seen:
                continue
            seen.add(key)
            sim = round(float(S[i, int(j)]), 4)
            bucket, reason = corroboration(anchor, other, sim)
            record = {
                "artist": anchor["artist"],
                "title": anchor["title"],
                "year": anchor["year"],
                "workIds": sorted(key),
                "size": 2,
                "similarity": sim,
                "corroborator": reason,
                "anchorWorkId": anchor["workId"],
                "otherTitle": other["title"],
                "otherYear": other["year"],
            }
            {"proposed": proposed, "weak": weak, "review": review}[bucket].append(record)

    proposed, chained = _hold_year_incoherent_components(proposed)
    for b in (proposed, weak, review, chained):
        b.sort(key=lambda c: -c["similarity"])
    return proposed, weak, review, chained


def _hold_year_incoherent_components(proposed):
    """Splits `proposed` into (kept, held) by connected component — see
    MAX_COMPONENT_YEAR_SPREAD."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for c in proposed:
        union(c["workIds"][0], c["workIds"][1])

    members = defaultdict(list)
    for c in proposed:
        members[find(c["workIds"][0])].append(c)

    kept, held = [], []
    for group in members.values():
        years = {c["year"] for c in group if c["year"]}
        if len(years) > 1 and (max(years) - min(years)) > MAX_COMPONENT_YEAR_SPREAD:
            for c in group:
                c["heldReason"] = (f"component spans {min(years)}-{max(years)}; "
                                   f"a shared node would chain them into one work")
            held.extend(group)
        else:
            kept.extend(group)
    return kept, held


def main(artist=None, top_k=DEFAULT_TOP_K, out_json=None, details=12):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            proposed, weak, review, chained = build(session, artist, top_k)
    finally:
        driver.close()

    print(f"\n=== PROPOSED — top-{top_k} neighbour AND an exact corroborator ({len(proposed)}) ===")
    for c in proposed[:details]:
        print(f"  {c['similarity']:.3f}  [{c['corroborator'][:34]:34s}] "
              f"{str(c['title'])[:36]:36s} | {str(c['otherTitle'])[:36]}")

    print(f"\n=== HELD — transitive chain would merge different works ({len(chained)}) ===")
    print(f"    A node in two proposed pairs chains them through the merger's alias map.")
    for c in chained[:details]:
        print(f"  {c['similarity']:.3f}  {str(c['year']):>6}  {str(c['title'])[:34]:34s} | "
              f"{str(c['otherTitle'])[:30]}")

    print(f"\n=== WEAK — year + technique + sim>={WEAK_CORROBORATOR_SIM_FLOOR} ({len(weak)}) "
          f"=== separate bucket; merge with --bucket weakCorroborator only after reading it")
    for c in weak[:details]:
        print(f"  {c['similarity']:.3f}  [{c['corroborator'][:40]:40s}] "
              f"{str(c['title'])[:30]:30s} | {str(c['otherTitle'])[:30]}")

    print(f"\n=== REVIEW QUEUE — high similarity, no exact corroborator ({len(review)}) ===")
    print("    Similarity chose what to look at. It does NOT make these true.")
    for c in review[:details]:
        print(f"  {c['similarity']:.3f}  [{c['corroborator'][:34]:34s}] "
              f"{str(c['title'])[:36]:36s} | {str(c['otherTitle'])[:36]}")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({"proposed": proposed, "weakCorroborator": weak,
                       "heldTransitiveChain": chained,
                       "reviewQueue": review}, f, indent=2, ensure_ascii=False)
        print(f"\nWrote {out_json}")
        print(f"  python3 merge_duplicate_work_clusters.py --json {out_json} "
              f"--artist {artist!r}          # dry run is the default; --apply writes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artist", help="Restrict to one Artist.name (recommended)")
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K,
                        help="Neighbours considered per anchor work (retrieval depth, not a threshold)")
    parser.add_argument("--json", dest="out_json", help="Write buckets for merge_duplicate_work_clusters.py")
    parser.add_argument("--details", type=int, default=12, help="Rows printed per bucket")
    args = parser.parse_args()
    main(artist=args.artist, top_k=args.top_k, out_json=args.out_json, details=args.details)
