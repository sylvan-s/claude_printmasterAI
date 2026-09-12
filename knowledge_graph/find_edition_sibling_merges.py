"""
PrintMasterAI — one numbered edition held as many ConceptualWork nodes.
Version: EDITION-SIBLINGS-1.0

Emits `merge_duplicate_work_clusters.py`'s JSON contract. Merges nothing.

THE DEFECT. `navigart_ingest.py` passes `catalogue_refs=[]` UNCONDITIONALLY to
`build_conceptual_work_id`, so every record falls through to `fallback_id=object_id` — the
accession. `tate_ingest.py` reaches the same place more directly, keying the work on the
accession itself. An institution holding ten impressions of one edition therefore produces TEN
ConceptualWork nodes.

Charbonnier's *Les Fenêtres* is the clean case: FNAC_2021-0353 to -0362, one title, one year,
one institution, a byte-identical 90-character medium string, and `Impression.editionNumber`
1 to 10 against a declared size of 55. Ten nodes; one work.

Graph-wide, 608 such groups, 2,402 nodes, 1,794 surplus — roughly a tenth of all duplicate
surplus in the graph, from one line in one adapter.

WHY THE ADAPTER IS NOT SIMPLY WRONG. Its comment argues the case, and the argument is the right
one: "without a catalogue citation there is nothing to join impressions on, and joining them on
title alone is the fuzzy identity matching this project has been burned by." Joining on title
alone IS the Chagall/Stik failure. The adapter is refusing a bad join, not missing an obvious
one.

WHAT IT MISSED is that a second join exists here which is not fuzzy at all: an institution's own
EDITION NUMBERING. This module requires ALL of

  1. the same `Artist` node
  2. the same NFD-folded title, excluding placeholders and ingest fallbacks
  3. the same institution
  4. the same `dateCreated_year`, or none recorded on either side
  5. a byte-identical `rawMedium` string
  6. `editionNumber` present on every member, ALL DISTINCT
  7. every number within the declared size, where one is declared

none of which is a similarity score. (6) is what carries it: repeats mean two different works
each numbered within its own edition, so a repeat disqualifies the group outright rather than
merely weakening it. That is the test the title cannot do and the edition numbering can.

THE ADAPTERS ARE NOT CHANGED HERE, deliberately. Re-keying `conceptual_work_id` only affects
future loads and would leave two id schemes in one source while another session is loading
Navigart. The data is fixed here, reversibly, through the merger that records
`MergeEvent{rule: 'editionSiblings'}`; the adapter change is a separate, coordinated call.

Usage:
    python3 find_edition_sibling_merges.py --json editions.json --pairs-out sample.csv --sample 20
    python3 merge_duplicate_work_clusters.py --json editions.json --rule editionSiblings
"""

import argparse
import csv
import json
import os
from collections import defaultdict

from neo4j import GraphDatabase

from find_title_collisions import MIN_TITLE_CHARS, PLACEHOLDER_TITLES, fold
from merge_duplicate_work_clusters import is_ingest_fallback

WORKS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)
      -[:INCLUDES]->(i:Impression)
WHERE i.editionNumber IS NOT NULL AND ($artist IS NULL OR a.name = $artist)
MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.sourceUrl IS NOT NULL
RETURN elementId(a) AS artistNode, a.name AS artist, w.id AS workId, w.name AS name,
       w.dateCreated_year AS year, s.institutionName AS institution,
       i.rawMedium AS medium, i.editionNumber AS editionNumber,
       er.declaredSize AS declaredSize, count(DISTINCT i) AS impressions,
       collect(DISTINCT img.sourceUrl)[0..2] AS imageUrls
"""


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


def declared_size(members):
    sizes = {m["declaredSize"] for m in members if m["declaredSize"]}
    return sizes.pop() if len(sizes) == 1 else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist")
    ap.add_argument("--json", dest="out_json", default="edition_sibling_merges.json")
    ap.add_argument("--pairs-out")
    ap.add_argument("--sample", type=int)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    groups, excluded = defaultdict(list), defaultdict(int)
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            for r in session.run(WORKS_QUERY, artist=args.artist):
                key = fold(r["name"])
                if key in PLACEHOLDER_TITLES:
                    excluded["placeholder title"] += 1
                    continue
                if len(key.replace(" ", "")) < MIN_TITLE_CHARS:
                    excluded["title too short"] += 1
                    continue
                if is_ingest_fallback(r["name"]):
                    excluded["ingest fallback title"] += 1
                    continue
                if not r["institution"]:
                    excluded["no institution recorded"] += 1
                    continue
                # (3),(4),(5) are in the key, so a group is homogeneous by construction.
                groups[(r["artistNode"], key, r["institution"], r["year"],
                        r["medium"])].append(dict(r))
    finally:
        driver.close()

    proposed, held = [], defaultdict(list)
    for (artist_node, key, institution, year, medium), members in groups.items():
        if len(members) < 2:
            continue

        def hold(reason, detail=""):
            held[reason].append((members[0]["artist"], key, len(members), detail))

        if any(m["impressions"] != 1 for m in members):
            hold("a member holds several impressions — already joined, not a sibling set")
            continue
        numbers = [m["editionNumber"] for m in members]
        if len(set(numbers)) != len(numbers):
            # THE DISQUALIFIER. A repeated number means two different works, each numbered
            # inside its own edition — exactly what must not be folded.
            hold("edition numbers repeat, so these are different works",
                 f"{sorted(numbers)[:6]}")
            continue
        size = declared_size(members)
        if size and any(n > size for n in numbers):
            hold("an edition number exceeds the declared size",
                 f"max {max(numbers)} > {size}")
            continue
        proposed.append({
            "artist": members[0]["artist"],
            "title": sorted({m["name"] for m in members})[0],
            "year": year,
            "workIds": sorted(m["workId"] for m in members),
            "size": len(members),
            "corroborator": (f"one numbered edition at {institution}: "
                             f"{len(numbers)} distinct impressions "
                             f"{min(numbers)}-{max(numbers)}"
                             + (f" of {size}" if size else "")),
            "institution": institution,
            "declaredSize": size,
            "editionNumbers": sorted(numbers),
            "_members": members,
        })

    proposed.sort(key=lambda c: (-c["size"], c["artist"]))
    out = {"proposed": [{k: v for k, v in c.items() if not k.startswith("_")}
                        for c in proposed]}
    with open(args.out_json, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    print(f"{len(proposed)} editions proposed, {sum(c['size'] for c in proposed)} nodes, "
          f"{sum(c['size'] - 1 for c in proposed)} surplus  -> {args.out_json}")
    print(f"  largest: {max((c['size'] for c in proposed), default=0)} nodes")
    print(f"  with a declared size: {sum(1 for c in proposed if c['declaredSize'])}")
    print("\nheld:")
    for reason, rows in sorted(held.items(), key=lambda kv: -len(kv[1])):
        example = next((r for r in rows if r[3]), rows[0])
        detail = f"   e.g. {example[0][:20]} {example[3]}" if example[3] else ""
        print(f"  {len(rows):6d}  {reason}{detail}")
    print("\nexcluded before grouping:")
    for reason, n in sorted(excluded.items(), key=lambda kv: -kv[1]):
        print(f"  {n:6d}  {reason}")

    if args.pairs_out:
        import random
        chosen = proposed
        if args.sample and args.sample < len(chosen):
            random.seed(args.seed)
            chosen = random.sample(chosen, args.sample)
        cols = ["route", "rank", "matchWeight", "matchProbability", "artist", "workA", "workB",
                "titleA", "titleB", "yearA", "yearB", "institutionsA", "institutionsB",
                "impressionsA", "impressionsB", "catalogueA", "catalogueB", "catalogueVerdict",
                "techFamilyA", "techFamilyB", "techFamilyVeto", "yearConflict",
                "designationDiffers", "editionA", "editionB", "imagesA", "imagesB",
                "flags", "note"]
        rows = []
        for c in chosen:
            imaged = [m for m in c["_members"] if m["imageUrls"]]
            if len(imaged) < 2:
                continue
            a, b = imaged[0], imaged[1]
            size = c["declaredSize"] or "?"
            rows.append({
                "route": "needsVision", "matchWeight": "", "matchProbability": "",
                "artist": c["artist"], "workA": a["workId"], "workB": b["workId"],
                "titleA": a["name"], "titleB": b["name"],
                "yearA": a["year"] or "", "yearB": b["year"] or "",
                "institutionsA": a["institution"], "institutionsB": b["institution"],
                "impressionsA": 1, "impressionsB": 1,
                "catalogueA": "", "catalogueB": "", "catalogueVerdict": "none",
                "techFamilyA": "", "techFamilyB": "", "techFamilyVeto": 0,
                "yearConflict": 0, "designationDiffers": 0,
                "editionA": f"{a['editionNumber']}/{size}",
                "editionB": f"{b['editionNumber']}/{size}",
                "imagesA": " | ".join(a["imageUrls"]),
                "imagesB": " | ".join(b["imageUrls"]),
                "flags": "", "note": c["corroborator"][:80]})
        for n, r in enumerate(rows, 1):
            r["rank"] = n
        with open(args.pairs_out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {len(rows)} pairs for a visual check -> {args.pairs_out}")


if __name__ == "__main__":
    main()
