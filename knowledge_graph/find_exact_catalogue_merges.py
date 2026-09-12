"""
PrintMasterAI — the exact-catalogue merge rule.
Version: EXACT-CAT-MERGE-1.0

Emits `merge_duplicate_work_clusters.py`'s JSON contract, and a pairs CSV for a visual check.
Decides nothing itself beyond the rule below, and merges nothing.

THE RULE. Exact keys PROMOTE; weak signals VETO. Nothing is admitted by a score, which is the
standing discipline in `catalogue_matching.py` and the shape that survived every probe in this
directory.

PROMOTE when all four hold:
  1. the same `Artist` NODE — not the same name string, since a split artist is a real defect
  2. the same NFD-folded title, excluding placeholders and ingest fallbacks
  3. the same catalogue NUMERIC BASE under a shared prefix
  4. that entry spans no more than MAX_WORKS_PER_ENTRY works

VETO on any of:
  5. a catalogue CONFLICT on some other shared prefix
  6. technique families known on both sides and disjoint
  8. images present on both sides and their best cosine below the artist's own floor
  9. a work reachable from two different groups (only possible via a split Artist node)

A MISSING SIGNAL NEVER VETOES. Absence is not disagreement — plate-or-image dimensions are on 6%
of pairs and technique on 32 nodes graph-wide, so treating silence as dissent would veto almost
everything.

WHY EACH VETO IS THERE, measured rather than assumed:

  catalogue base, not raw string — `Baer 618` and `Baer 618Bd` are ONE work (Portrait de Vollard
  II, image similarity 0.982) and `Baer 1173` / `1173.B.b.1` likewise, the suffix being a state
  designation. Raw-string equality rejects confirmed-identical pairs.

  the portfolio guard — one Cramer-prefixed entry numbered 30 is the whole of *La Bible*: 1,172
  works and 1,046 titles. An entry shared by hundreds of works is an anchor, not an identity. It
  excludes nothing in the current catalogue-agree band and is here for the load that changes that.

  NFD folding, not `normalize_title` — that maps anything outside [a-z0-9] to a space, so it
  DELETES accents: "Scène" becomes "sc ne". 359 collisions where the catalogue agrees differ only
  by diacritics ("Aerialistes" / "Aérialistes") and are invisible to it.

  placeholders — "sans titre" alone covers 4,236 works, more than the English "untitled".

  technique disjunction — no shared family holds for 3.6% of true pairs against 15.1% of hard
  negatives, a likelihood ratio near 3.4. Splink's EM arrived at the same asymmetry unprompted,
  giving disagreement log2 BF -3.90 while agreement is worth +0.33.

  the year gap is REPORTED as `yearGap`, not vetoed. It was a veto until 2026-09-12, guarding
  against title reuse — Picasso made *Le Taureau* in 1936 and again in 1946. But reuse produces
  DIFFERENT catalogue numbers and this rule already requires a shared numeric base, so that case
  cannot arrive here. What the veto actually caught was IMPRESSION DATES written onto the work:
  Tate holds Constable's *Noon* as 1831, 1831, 1855 and two undated, all one Lucas mezzotint,
  and 107 Tate title-groups have a spread over 3.

  the per-artist image floor — DINOv2 similarity is artist-dependent and the threshold holding a
  1% false-positive rate runs from 0.533 to 1.000 across 977 measured artists. A global floor is
  wrong in a knowable way, so `Artist.dinoBackgroundP95` is used where it exists and skipped where
  it does not.

STATES FOLD, AND THAT IS CORRECT. Seven *La Femme qui pleure* nodes all cite Baer 623 and are one
work under doc 08 and ADR-0017 Amendment 2. Their `State` nodes survive the fold untouched,
because `State-[:PRINTED_AS]->EditionRun` is not a relationship `MERGE_QUERY` re-points.

SPLINK IS NOT IN THE ADMISSION TEST, deliberately. Its weights are uncalibrated on a collision
frame — u is estimated from random pairs that are usually two works by different artists — and
they are not reproducible run to run, because EM seeds off record order: the "very strong" band
moved 397 -> 976 between two runs with no model change. Ranking is what it is good for, and
`rank_title_collisions.py` does that.

Usage:
    python3 find_exact_catalogue_merges.py --json proposed.json --pairs-out sample.csv
    python3 merge_duplicate_work_clusters.py --json proposed.json --rule exactCatalogueTitle
"""

import argparse
import csv
import json
import os
import random
import re
import unicodedata
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase

from find_title_collisions import MIN_TITLE_CHARS, PLACEHOLDER_TITLES, fold, numeric_base
from merge_duplicate_work_clusters import is_ingest_fallback

MAX_WORKS_PER_ENTRY = 12
MAX_YEAR_GAP = 3
FALLBACK_IMAGE_FLOOR = 0.70      # only where the artist has no measured background

WORKS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE w.name IS NOT NULL AND ($artist IS NULL OR a.name = $artist)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
OPTIONAL MATCH (w)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.embedding IS NOT NULL
OPTIONAL MATCH (i)<-[:SHOWS]-(pic:DigitalImage) WHERE pic.sourceUrl IS NOT NULL
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
RETURN elementId(a) AS artistNode, a.name AS artist,
       coalesce(a.dinoBackgroundP95, -1.0) AS artistFloor,
       w.id AS workId, w.name AS name, w.dateCreated_year AS year,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations,
       collect(DISTINCT t.name) AS techs, collect(DISTINCT i.rawMedium) AS media,
       collect(DISTINCT img.embedding)[0..2] AS embeddings,
       collect(DISTINCT pic.sourceUrl)[0..2] AS imageUrls,
       collect(DISTINCT coalesce(s.institutionName, s.sourceType)) AS institutions,
       collect(DISTINCT i.editionNumber) AS editionNumbers,
       collect(DISTINCT er.declaredSize) AS declaredSizes,
       count(DISTINCT i) AS impressions
"""

FAMILIES = [
    ("photomechanical", r"giclee|giclée|inkjet|digital|halftone|photogravure|photolith|"
                        r"collotype|offset|c-?print|chromogenic|pigment print"),
    ("relief", r"woodcut|wood[\s-]?engrav|linocut|lino[\s-]?cut|linoleum|relief|xylograph|metalcut"),
    ("intaglio", r"etch|engrav|drypoint|dry-?point|aquatint|mezzotint|burin|intaglio|"
                 r"soft-?ground|roulette|stipple|sugar-?lift|crayon manner"),
    ("planographic", r"lithograph|litho|planograph|zincograph|chromolith"),
    ("screen", r"screenprint|screen print|serigraph|silkscreen|pochoir|stencil"),
]
FAMILY_RES = [(f, re.compile(p, re.I)) for f, p in FAMILIES]


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


def _edition_label(numbers, sizes):
    """"5/55; 8/55" — decisive for a VARIABLE EDITION, where the printed images are MEANT to
    differ between numbered impressions and only the numbering says the works are one. See
    adjudicate_merge_candidates' SAME-work list."""
    ns = sorted(n for n in (numbers or []) if n is not None)
    if not ns:
        return ""
    size = next((s for s in (sizes or []) if s), "?")
    return "; ".join(f"{n}/{size}" for n in ns[:6])


def families(texts):
    out = set()
    for text in texts:
        if not text:
            continue
        for family, rx in FAMILY_RES:
            if rx.search(str(text)):
                out.add(family)
                break
    return out


def bases_of(citations):
    return {(p, numeric_base(n)) for p, n in citations if p and numeric_base(n)}


def best_cosine(members):
    """Highest cosine between any two members' image centroids. None when fewer than two
    members carry an image — which is silence, not dissent."""
    vectors = []
    for m in members:
        if m["centroid"] is not None:
            vectors.append(m["centroid"])
    if len(vectors) < 2:
        return None
    M = np.array(vectors, dtype=np.float32)
    sims = M @ M.T
    np.fill_diagonal(sims, -1.0)
    return float(sims.max())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist")
    ap.add_argument("--json", dest="out_json", default="exact_catalogue_merges.json")
    ap.add_argument("--pairs-out", help="emit a CSV of pairs for adjudicate_merge_candidates.py")
    ap.add_argument("--sample", type=int, help="random sample of N clusters for the pairs CSV")
    ap.add_argument("--seed", type=int, default=12)
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    groups, entry_span, seen_work = defaultdict(list), defaultdict(set), defaultdict(set)
    excluded = defaultdict(int)
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            for r in session.run(WORKS_QUERY, artist=args.artist):
                key = fold(r["name"])
                citations = [(p, n) for p, n in r["citations"] if p and n]
                for prefix, base in bases_of(citations):
                    entry_span[(prefix, base)].add(r["workId"])
                if key in PLACEHOLDER_TITLES:
                    excluded["placeholder title"] += 1
                    continue
                if len(key.replace(" ", "")) < MIN_TITLE_CHARS:
                    excluded["title too short"] += 1
                    continue
                if is_ingest_fallback(r["name"]):
                    excluded["ingest fallback title"] += 1
                    continue
                centroid = None
                vectors = [v for v in r["embeddings"] if v]
                if vectors:
                    M = np.array(vectors, dtype=np.float32)
                    M /= np.linalg.norm(M, axis=1, keepdims=True)
                    c = M.mean(axis=0)
                    centroid = c / np.linalg.norm(c)
                groups[(r["artistNode"], key)].append({
                    "workId": r["workId"], "name": r["name"], "year": r["year"],
                    "artist": r["artist"], "artistFloor": r["artistFloor"],
                    "bases": bases_of(citations),
                    "citations": sorted({f"{p} {n}" for p, n in citations}),
                    "families": families(list(r["techs"]) + list(r["media"])),
                    "centroid": centroid,
                    "imageUrls": [u for u in r["imageUrls"] if u],
                    "institutions": sorted({x for x in r["institutions"] if x}),
                    "edition": _edition_label(r["editionNumbers"], r["declaredSizes"]),
                    "impressions": r["impressions"]})
                seen_work[r["workId"]].add((r["artistNode"], key))
    finally:
        driver.close()

    proposed, held = [], defaultdict(list)
    for (artist_node, key), members in groups.items():
        if len(members) < 2:
            continue

        def hold(reason, detail=""):
            # Bucket by CATEGORY, not by value — putting the cosine in the reason string gave
            # one bucket per distinct number and made the summary unreadable.
            held[reason].append((members[0]["artist"], key, len(members), detail))

        # 9. a work reachable from two groups — only possible via a split Artist node
        if any(len(seen_work[m["workId"]]) > 1 for m in members):
            hold("work reachable from two groups (split artist)")
            continue
        # 3. every member must share one catalogue numeric base
        common = set.intersection(*(m["bases"] for m in members)) if all(
            m["bases"] for m in members) else set()
        if not common:
            hold("no catalogue base shared by every member")
            continue
        # 5. a conflict on some OTHER shared prefix
        by_prefix = defaultdict(set)
        for m in members:
            for prefix, base in m["bases"]:
                by_prefix[prefix].add(base)
        if any(len(v) > 1 for v in by_prefix.values()):
            hold("catalogue conflict on another prefix")
            continue
        # 4. portfolio guard
        if any(len(entry_span[b]) > MAX_WORKS_PER_ENTRY for b in common):
            hold(f"entry spans more than {MAX_WORKS_PER_ENTRY} works")
            continue
        # 6. technique families known on both sides and disjoint
        fams = [m["families"] for m in members if m["families"]]
        if len(fams) > 1 and not set.intersection(*fams):
            hold("technique families disjoint")
            continue
        # 7. YEAR IS REPORTED, NOT VETOED — a change made 2026-09-12 after measuring what it
        # held. The veto existed to catch title reuse: Picasso made "Le Taureau" in 1936 and
        # again in 1946. But title reuse produces DIFFERENT catalogue numbers, and this rule
        # already requires a shared numeric base, so the case it guards against cannot reach
        # here. What it actually held was impression dates: several sources write the year an
        # individual sheet was printed onto the WORK, so one design arrives with several years —
        # Tate holds Constable's "Noon" as 1831, 1831, 1855 and two undated, all one Lucas
        # mezzotint, and 107 Tate title-groups have a spread over 3. Of the 4 clusters this
        # veto held, the example is Muirhead Bone's "Canal and Bridge of S.S..." at 1916-1928,
        # one drypoint printed twice.
        years = [m["year"] for m in members if m["year"]]
        year_gap = (max(years) - min(years)) if len(years) > 1 else 0
        # 8. image dissent, against the artist's own floor where it exists
        top = best_cosine(members)
        floor = members[0]["artistFloor"]
        floor = floor if floor and floor > 0 else FALLBACK_IMAGE_FLOOR
        if top is not None and top < floor:
            hold("images dissent, best cosine below the artist floor",
                 f"{top:.3f} < {floor:.3f}")
            continue

        proposed.append({
            "artist": members[0]["artist"],
            "title": sorted({m["name"] for m in members})[0],
            "year": years[0] if years else None,
            "workIds": sorted(m["workId"] for m in members),
            "size": len(members),
            "corroborator": "same artist node, folded title and catalogue base "
                            + "; ".join(sorted(f"{p} {b}" for p, b in common)),
            "bestImageCosine": round(top, 4) if top is not None else None,
            "yearGap": year_gap,
            "spellings": sorted({m["name"] for m in members}),
            "_members": members,
        })

    proposed.sort(key=lambda c: (-c["size"], c["artist"]))
    out = {"proposed": [{k: v for k, v in c.items() if not k.startswith("_")} for c in proposed]}
    with open(args.out_json, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    print(f"{len(proposed)} clusters proposed, "
          f"{sum(c['size'] for c in proposed)} nodes, "
          f"{sum(c['size'] - 1 for c in proposed)} surplus  -> {args.out_json}")
    print("\nheld (each is a veto that fired, not a failure to find anything):")
    for reason, rows in sorted(held.items(), key=lambda kv: -len(kv[1])):
        example = next((r for r in rows if r[3]), rows[0])
        detail = f"   e.g. {example[0][:22]} {example[1][:24]!r} {example[3]}" if example[3] else ""
        print(f"  {len(rows):6d}  {reason}{detail}")
    print("\nexcluded before grouping:")
    for reason, n in sorted(excluded.items(), key=lambda kv: -kv[1]):
        print(f"  {n:6d}  {reason}")

    if args.pairs_out:
        chosen = proposed
        if args.sample and args.sample < len(chosen):
            random.seed(args.seed)
            chosen = random.sample(chosen, args.sample)
        cols = ["route", "rank", "matchWeight", "matchProbability", "artist", "workA", "workB",
                "titleA", "titleB", "yearA", "yearB", "institutionsA", "institutionsB",
                "impressionsA", "impressionsB", "catalogueA", "catalogueB", "catalogueVerdict",
                "techFamilyA", "techFamilyB", "techFamilyVeto", "yearConflict",
                "designationDiffers", "editionA", "editionB",
                "imagesA", "imagesB", "flags", "note"]
        rows = []
        for c in chosen:
            imaged = [m for m in c["_members"] if m["imageUrls"]]
            if len(imaged) < 2:
                continue
            a, b = imaged[0], imaged[1]
            rows.append({
                "route": "needsVision", "matchWeight": c["bestImageCosine"] or "",
                "matchProbability": "", "artist": c["artist"],
                "workA": a["workId"], "workB": b["workId"],
                "titleA": a["name"], "titleB": b["name"],
                "yearA": a["year"] or "", "yearB": b["year"] or "",
                "institutionsA": "; ".join(a["institutions"]),
                "institutionsB": "; ".join(b["institutions"]),
                "impressionsA": a["impressions"], "impressionsB": b["impressions"],
                "catalogueA": "; ".join(a["citations"]), "catalogueB": "; ".join(b["citations"]),
                "catalogueVerdict": "agree",
                "techFamilyA": "; ".join(sorted(a["families"])),
                "techFamilyB": "; ".join(sorted(b["families"])),
                "techFamilyVeto": 0, "yearConflict": 0, "designationDiffers": 0,
                "editionA": a["edition"], "editionB": b["edition"],
                "imagesA": " | ".join(a["imageUrls"]),
                "imagesB": " | ".join(b["imageUrls"]),
                "flags": "", "note": c["corroborator"][:80]})
        for n, r in enumerate(rows, 1):
            r["rank"] = n
        with open(args.pairs_out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {len(rows)} pairs for visual check -> {args.pairs_out}")


if __name__ == "__main__":
    main()
