"""
PrintMasterAI — same artist, same title, several ConceptualWork nodes.
Version: TITLE-COLLISIONS-1.0

Scan-only. Writes a CSV and nothing else; there is no merge mode.

WIDER THAN `find_duplicate_work_clusters.py` BY ONE FIELD. That scan keys on artist + normalized
title + YEAR, so a work whose sources disagree about the date, or record none, never clusters.
This drops the year and keys on artist + folded title alone, which is the population the
year-keyed scan cannot see. The year is reported per collision instead of assumed.

PLACEHOLDERS ARE THE WHOLE DIFFICULTY, and the existing filter is English-only. Graph-wide:

    sans titre            4,236      <- NOT in find_duplicate_work_clusters.PLACEHOLDER_TITLES
    untitled              2,084
    composition             197
    untitled composition     45
    ohne titel                7
    senza titolo              7
    no title                  6

`sans titre` is the single commonest placeholder in the graph — more than double the English
form — and it arrived with the French-language loads (Navigart, Musee Picasso-Paris) after that
filter was written. Unfiltered it produces the largest collisions in the graph: 365 Robert Beltz,
307 Picasso, 142 Derain. It also reaches the year-keyed scan's `proposed` bucket, which is the
one eligible to fold: 26 clusters / 70 nodes there are French placeholders, and folding four
different Marcel Arthaud "sans titre" of 1943 into one work would be a corruption of exactly the
kind catalogue_matching.py's docstring records.

TITLES ARE FOLDED, NOT JUST LOWERCASED. `normalize_title` maps anything outside [a-z0-9] to a
space, so an accented character is DELETED rather than folded: "Scene de Theatre" and "Scène de
Théâtre" normalise to different keys ("sc ne de th tre"). Diacritics are stripped here via NFD
before the alphanumeric squash, so the accent variants that no existing rule bridges collide as
they should.

Ingest fallbacks are excluded too — "Untitled (A0305 lot 308)" and the British Museum's truncated
descriptions are not titles, and `merge_duplicate_work_clusters.is_ingest_fallback` already knows
their shapes.

WHAT A COLLISION IS AND IS NOT. Two nodes sharing an artist and a title are a QUESTION, not a
duplicate. The columns exist to answer it: differing catalogue base numbers mean different works
(ADR-0017 Amendment 2), a spread of years means the artist reused a title, and `distinctSpellings`
shows whether the sources actually wrote the same thing or only fold to the same key.

Usage:
    python3 find_title_collisions.py --out title_collisions.csv
    python3 find_title_collisions.py --artist "Pablo Picasso" --min-nodes 3
"""

import argparse
import csv
import os
import re
import unicodedata
from collections import defaultdict

from neo4j import GraphDatabase

from merge_duplicate_work_clusters import is_ingest_fallback

# Multilingual. The English-only set this replaces missed the commonest placeholder in the graph.
PLACEHOLDER_TITLES = {
    "no title", "title not known", "titre inconnu",
    "untitled", "sans titre", "ohne titel", "senza titolo", "sin titulo", "zonder titel",
    "untitled composition", "composition", "unknown", "n a", "np", "none",
}
MIN_TITLE_CHARS = 4

RAW_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE w.name IS NOT NULL AND ($artist IS NULL OR a.name = $artist)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.sourceUrl IS NOT NULL
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)<-[:PRINTED_AS]-(st:State)
RETURN a.name AS artist, w.id AS workId, w.name AS name, w.dateCreated_year AS year,
       count(DISTINCT i) AS impressions, count(DISTINCT img) AS images,
       collect(DISTINCT st.stateNumber) AS states,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations
"""


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


def fold(title):
    """Lowercase, strip diacritics, alphanumeric key. Unlike normalize_title this FOLDS an
    accented character to its base letter instead of deleting it."""
    s = unicodedata.normalize("NFD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def numeric_base(number):
    digits = ""
    for ch in str(number or ""):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits or None


def catalogue_state(members):
    """'agree' when every citing member shares a prefix and base, 'conflict' when a shared prefix
    carries different bases, 'partial' when only some members cite anything, '' when none do."""
    by_prefix = defaultdict(list)
    citing = 0
    for m in members:
        bases = {(p, numeric_base(n)) for p, n in m["citations"] if p and numeric_base(n)}
        if bases:
            citing += 1
        for prefix, base in bases:
            by_prefix[prefix].append(base)
    if not citing:
        return ""
    verdict = "agree"
    for prefix, bases in by_prefix.items():
        if len(set(bases)) > 1:
            verdict = "conflict"
            break
    if verdict == "agree" and citing < len(members):
        return "partial"
    return verdict


COLUMNS = ["artist", "foldedTitle", "nodes", "distinctSpellings", "years", "yearSpread",
           "catalogue", "catalogueRefs", "stateNumbers", "impressions", "imagedNodes",
           "spellings", "workIds"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist")
    ap.add_argument("--min-nodes", type=int, default=2)
    ap.add_argument("--out", default="title_collisions.csv")
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    groups = defaultdict(list)
    excluded = defaultdict(int)
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            for r in session.run(RAW_QUERY, artist=args.artist):
                key = fold(r["name"])
                if key in PLACEHOLDER_TITLES:
                    excluded[f"placeholder: {key!r}"] += 1
                    continue
                if len(key.replace(" ", "")) < MIN_TITLE_CHARS:
                    excluded["title under 4 chars"] += 1
                    continue
                if is_ingest_fallback(r["name"]):
                    excluded["ingest fallback title"] += 1
                    continue
                groups[(r["artist"], key)].append({
                    "workId": r["workId"], "name": r["name"], "year": r["year"],
                    "impressions": r["impressions"], "images": r["images"],
                    "states": [s for s in r["states"] if s is not None],
                    "citations": [(p, n) for p, n in r["citations"] if p and n]})
    finally:
        driver.close()

    rows = []
    for (artist, key), members in groups.items():
        if len(members) < args.min_nodes:
            continue
        years = sorted({m["year"] for m in members if m["year"]})
        spellings = sorted({m["name"] for m in members})
        refs = sorted({f"{p} {n}" for m in members for p, n in m["citations"]})
        states = sorted({s for m in members for s in m["states"]})
        rows.append({
            "artist": artist, "foldedTitle": key, "nodes": len(members),
            "distinctSpellings": len(spellings),
            "years": "; ".join(str(y) for y in years),
            "yearSpread": (max(years) - min(years)) if len(years) > 1 else 0,
            "catalogue": catalogue_state(members),
            "catalogueRefs": "; ".join(refs[:6]),
            "stateNumbers": "; ".join(str(s) for s in states),
            "impressions": sum(m["impressions"] for m in members),
            "imagedNodes": sum(1 for m in members if m["images"]),
            "spellings": " | ".join(spellings[:4]),
            "workIds": " ".join(m["workId"] for m in members[:8]),
        })
    rows.sort(key=lambda r: (-r["nodes"], r["artist"]))

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    surplus = sum(r["nodes"] - 1 for r in rows)
    print(f"{len(rows)} title collisions, {sum(r['nodes'] for r in rows)} work nodes, "
          f"{surplus} surplus if every one folded  -> {args.out}")
    print(f"  {sum(1 for r in rows if r['distinctSpellings'] > 1)} collide only after folding "
          f"(the sources wrote the title differently)")
    print(f"  {sum(1 for r in rows if r['yearSpread'] > 3)} span more than 3 years "
          f"(the artist may have reused the title)")
    print(f"  {sum(1 for r in rows if r['stateNumbers'])} carry State nodes")
    print(f"\n{'catalogue':10s} {'collisions':>10s}   what it means")
    for verdict, note in (("agree", "every citing node shares a base number — likely one work"),
                          ("conflict", "shared prefix, different bases — different works"),
                          ("partial", "only some nodes cite a catalogue"),
                          ("", "no catalogue citation anywhere in the collision")):
        n = sum(1 for r in rows if r["catalogue"] == verdict)
        print(f"{verdict or '(none)':10s} {n:>10d}   {note}")
    print("\nexcluded before grouping:")
    for reason, n in sorted(excluded.items(), key=lambda kv: -kv[1])[:8]:
        print(f"  {n:6d}  {reason}")


if __name__ == "__main__":
    main()
