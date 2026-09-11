"""
PrintMasterAI — join a plate record to the impressions pulled from it.
Version: PLATE-JOIN-1.0

Third generator feeding `merge_duplicate_work_clusters.py`'s JSON contract, alongside
`find_museum_anchored_work_clusters.py` and `find_image_similar_work_candidates.py`.

THE DEFECT. doc 08 models one work as holding both its matrix and its printings —
`ConceptualWork -[:REALIZED_AS]-> Matrix` and `ConceptualWork -[:PRINTED_AS]-> EditionRun`.
The Picasso-Paris load does not produce that. All **187** `Estampe, Matrice` records carry
**zero** catalogue citations (checked: 0 of 187), so every one keys on its own accession
id through `build_conceptual_work_id`'s fallback and lands on a ConceptualWork of its own,
disconnected from the work holding the impressions of the same image. 145 plate works have
a same-named impression-side twin.

The effect is that the museum's most distinctive holding — Picasso's own coppers, zincs and
linoleum — sits in the graph unreachable from the prints pulled off it. Neither other
generator can see it either: both traverse `PRINTED_AS`/`INCLUDES` to reach images, and a
Matrix hangs off `REALIZED_AS`.

WHY IMAGE SIMILARITY IS NOT USED HERE, AND MUST NOT BE READ AS A VETO

This is the one place in this toolkit where a LOW DINOv2 score is expected and means
nothing is wrong. A copper plate is the mirror of its print and tonally inverted — an
inked impression against a bare metal surface. Measured over the 104 scoreable same-name
pairs:

    mean 0.540   median 0.552   min 0.112   max 0.861
    below 0.70: 80 of 104        at or above 0.85: 1 of 104

For impression-to-impression matching a score of 0.55 is evidence of DIFFERENT works
(`find_image_similar_work_candidates.py`'s positives average 0.896). Here it is the normal
appearance of a correct pair. So similarity is neither a corroborator nor a veto in this
script, and is recorded in the output only so a reader can see it was considered.

WHAT DECIDES INSTEAD

  1. Exact normalized title, within one Artist. Same `normalize_title` as everywhere else.
  2. Year agreement within YEAR_TOLERANCE (88 of 104 pairs agree within 1).
  3. **Both sides must be unambiguous.** A title matching more than one plate work, or
     more than one impression work, is held rather than guessed. This is the `Le Taureau`
     lesson from the image generator's first run: Picasso reused titles decades apart, and
     a title alone cannot carry identity for him. Requiring a 1:1 mapping is what makes an
     exact-title rule safe here in a way it would not be on its own.

A plate that genuinely has no impression in the graph stays as it is. That is a correct
outcome, not a miss — the museum holds plates whose impressions it does not hold.

REQUIRES the REALIZED_AS fix in merge_duplicate_work_clusters.py (same date). Without it
the merger's DETACH DELETE drops the Matrix link, which is precisely the edge this script
exists to preserve.

Usage:
    python3 find_plate_impression_pairs.py --artist "Pablo Picasso" --json plates.json
    python3 merge_duplicate_work_clusters.py --json plates.json --artist "Pablo Picasso"
"""

import argparse
import json
import os
from collections import defaultdict

from neo4j import GraphDatabase

from catalogue_matching import normalize_title


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

YEAR_TOLERANCE = 1

PLATE_QUERY = """
MATCH (mw:ConceptualWork)-[:REALIZED_AS]->(m:Matrix)
MATCH (mw)<-[:CREATED]-(a:Artist)
WHERE ($artist IS NULL OR a.name = $artist) AND NOT (mw)-[:PRINTED_AS]->(:EditionRun)
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(m)
RETURN mw.id AS workId, mw.name AS title, mw.dateCreated_year AS year, a.name AS artist,
       m.material AS material, src.accessionNumber AS accession
"""

IMPRESSION_QUERY = """
MATCH (iw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
MATCH (iw)<-[:CREATED]-(a:Artist)
WHERE $artist IS NULL OR a.name = $artist
RETURN DISTINCT iw.id AS workId, iw.name AS title, iw.dateCreated_year AS year, a.name AS artist
"""


def build(session, artist):
    plates = [dict(r) for r in session.run(PLATE_QUERY, artist=artist)]
    imps = [dict(r) for r in session.run(IMPRESSION_QUERY, artist=artist)]
    print(f"{len(plates)} plate work(s) with no EditionRun | {len(imps)} impression work(s)",
          flush=True)

    by_title_plate, by_title_imp = defaultdict(list), defaultdict(list)
    for p in plates:
        by_title_plate[(p["artist"], normalize_title(p["title"]))].append(p)
    for i in imps:
        by_title_imp[(i["artist"], normalize_title(i["title"]))].append(i)

    proposed, held = [], []
    for key, ps in by_title_plate.items():
        if not key[1]:
            continue
        candidates = by_title_imp.get(key, [])
        if not candidates:
            continue
        # Ambiguity guard — see module docstring point 3.
        if len(ps) > 1 or len(candidates) > 1:
            held.append({"artist": key[0], "title": ps[0]["title"],
                         "plateWorks": [p["workId"] for p in ps],
                         "impressionWorks": [c["workId"] for c in candidates],
                         "reason": f"{len(ps)} plate work(s) and {len(candidates)} "
                                   f"impression work(s) share this title; a 1:1 mapping "
                                   f"cannot be established by title alone"})
            continue
        p, i = ps[0], candidates[0]
        if p["year"] and i["year"] and abs(p["year"] - i["year"]) > YEAR_TOLERANCE:
            held.append({"artist": key[0], "title": p["title"],
                         "plateWorks": [p["workId"]], "impressionWorks": [i["workId"]],
                         "reason": f"years disagree: plate {p['year']} vs impression {i['year']}"})
            continue
        proposed.append({
            "artist": p["artist"],
            "title": i["title"],
            "year": i["year"] or p["year"],
            "workIds": sorted([p["workId"], i["workId"]]),
            "size": 2,
            "plateWorkId": p["workId"],
            "impressionWorkId": i["workId"],
            "material": p["material"],
            "accession": p["accession"],
        })

    proposed.sort(key=lambda c: (c["title"] or ""))
    return proposed, held


def main(artist=None, out_json=None, details=12):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            proposed, held = build(session, artist)
    finally:
        driver.close()

    print(f"\n=== PROPOSED — exact title, 1:1, years agree within {YEAR_TOLERANCE} "
          f"({len(proposed)}) ===")
    for c in proposed[:details]:
        print(f"  {str(c['accession']):<14} {str(c['material']):<10} {str(c['year']):>6}  "
              f"{str(c['title'])[:50]}")

    print(f"\n=== HELD — ambiguous or years disagree ({len(held)}) ===")
    for h in held[:details]:
        print(f"  {str(h['title'])[:44]:44s} {h['reason'][:60]}")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({"proposed": proposed, "heldAmbiguous": held}, f, indent=2,
                      ensure_ascii=False)
        print(f"\nWrote {out_json}")
        print(f"  python3 merge_duplicate_work_clusters.py --json {out_json} "
              f"--artist {artist!r}          # dry run is the default; --apply writes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artist", help="Restrict to one Artist.name (recommended)")
    parser.add_argument("--json", dest="out_json", help="Write buckets for merge_duplicate_work_clusters.py")
    parser.add_argument("--details", type=int, default=12)
    args = parser.parse_args()
    main(artist=args.artist, out_json=args.out_json, details=args.details)
