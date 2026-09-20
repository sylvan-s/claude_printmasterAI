"""
PrintMasterAI — the spelling-variant merge rule (scan only).
Version: SPELLING-VARIANT-1.0

Emits `merge_duplicate_work_clusters.py`'s JSON contract and a pairs CSV. Decides nothing,
merges nothing, writes nothing.

WHY THIS EXISTS. `find_duplicate_work_clusters.py` keys identity on artist + EXACT normalized
title + year, so "Boules Players" and "Boule Players" stay two works, as do "Tower and Oxen"
and "Tower & Oxen" — the same print catalogued by two houses that spelled it differently.

WHY IT IS NOT A FUZZY MATCHER. Similarity scoring over titles caused two real corruption
incidents on this graph (catalogue_matching.py's docstring holds both), which is why the
standing discipline is `find_exact_catalogue_merges.py`'s: EXACT KEYS PROMOTE, WEAK SIGNALS
VETO, nothing is admitted by a score. This rule keeps that shape. It does not compute a title
distance and threshold it. It applies a CLOSED SET of deterministic rewrites, and admits a pair
only when the two titles become identical under them — every one reversible and meaning-
preserving in English print cataloguing:

    article      a leading "the "                     The Boule Players ~ Boule Players
    ampersand    "&" <-> "and"                        Tower & Oxen ~ Tower and Oxen
    plural       a trailing "s" on ONE token          Boules Players ~ Boule Players
    punctuation  hyphens, apostrophes, spacing        Self-Portrait ~ Self Portrait
    accents      NFD folding                          Café ~ Cafe

Anything outside that set is not a spelling variant and is never admitted, however close it
looks. `typo1` (a single-character edit) is generated but held in its own bucket, NOT proposed:
one character is the difference between "Plate II" and "Plate III", and between "Red Nude" and
"Bed Nude".

PLURALS ARE HELD, NOT PROPOSED — measured, not assumed. A hand-check of 12 proposed clusters
(2026-09-20) came out 6/6 correct on the article/punctuation/accent class and 3 correct, 2
wrong, 1 doubtful on the plural class. The plural failures are not spelling at all: Warhol's
"Guns - Flintlock Pistols" is a sheet of several pistols and "Gun - Flintlock Pistol" is one
pistol; Johns's "Voice 2" and "Voices 2" are different prints. In print titles a plural can
name a different composition, and the image gate does not separate a sheet of objects from one
of its objects reliably (that pair scored 0.9485). So `pluralHeld` is a review queue, and only
article/punctuation/accent reaches `proposed`.

The Johns pair also shows the limit of the catalogue veto: its "Voice 2" node cites BOTH
ULAE 229 and ULAE/Field 228, so the number sets intersect and nothing conflicts. Messy
catalogue data cannot be repaired by a title rule.

HARD EXCLUSIONS, applied before any pair is formed — these are where title-keyed rules die
(project memory: series titles and variation-series artists carry the failures):

  numerals      any difference in digits or roman numerals. Plate, state and edition numbers
                live there, and they are precisely what distinguishes two real prints.
  colour words  a colour present on one side and not the other. Stripping a colour-variant
                detail from a title is one of the two recorded corruptions: different
                colourways from one matrix are DIFFERENT works (ADR-0017, project memory).
  series marker "plate", "state", "from the ... suite", "no.", "pl." on either side.
  placeholders  "untitled", lot-descriptive openers, ingest fallbacks.

THE IMAGE GATE (the reason this rule can be loosened at all). A spelling variant is admitted
only when the pictures agree AND the agreement is DISTINCTIVE:

  pairAgrees      both sides have an embedded image and their best pair scores >= --floor
                  (Neo4j's (1+cos)/2, not raw cosine — 0.85 here is raw 0.70)
  isDistinctive   no work by the same artist OUTSIDE THIS VARIANT CLUSTER has an image
                  scoring within --margin of that pair score. This is the veto that series and
                  colourways trip: if a third print by the same artist looks just as close, the
                  picture is not evidence of identity, it is evidence of a family.

                  Clusters, not pairs, for a reason measured on the first run: "Boule Players"
                  is held under three spellings, so pairwise each variant is the other's
                  nearest rival and the veto fires on the very case it is meant to admit.
                  Variant pairs are therefore closed into connected components first, and the
                  rival search excludes every member.

  A pair with no image on either side is NOT proposed. Absence never vetoes elsewhere in this
  directory (a missing signal is not disagreement), but here the image IS the evidence that
  licenses loosening the title key, so its absence leaves the pair unlicensed, in `noImage`.

Usage (source .env first):
    python3 find_spelling_variant_merges.py --scan
    python3 find_spelling_variant_merges.py --scan --artist "Julian Trevelyan" --json out.json
"""

import argparse
import csv
import json
import os
import re
import unicodedata
from collections import defaultdict
from itertools import combinations

from neo4j import GraphDatabase

RULE_VERSION = "SPELLING-VARIANT-1.0"
DEFAULT_FLOOR = 0.85       # (1+cos)/2, same scale as find_duplicate_work_clusters.py
DEFAULT_MARGIN = 0.02      # how much closer the pair must be than the artist's next-best work

COLOUR_WORDS = {
    "red", "blue", "green", "yellow", "black", "white", "orange", "purple", "violet", "pink",
    "brown", "grey", "gray", "gold", "golden", "silver", "sepia", "ochre", "turquoise", "teal",
    "magenta", "cyan", "crimson", "scarlet", "indigo", "monochrome", "colour", "color",
    "noir", "blanc", "rouge", "bleu", "vert", "jaune", "rose", "brun",
}
SERIES_MARKERS = re.compile(
    r"\b(plate|pl|state|etat|état|no|num|number|suite|series|portfolio|volume|vol|"
    r"edition|variant|version|proof)\b")
PLACEHOLDER = re.compile(r"^\s*(untitled|no title|sans titre|ohne titel)\b|lot \d+", re.I)
ROMAN = re.compile(r"\b[ivxlcdm]{1,7}\b")


def fold(s):
    """NFD accent folding, lowercase, punctuation to spaces."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def numeric_signature(title):
    """Digits and roman numerals, in order. Two titles whose signatures differ are never a
    spelling variant — plate/state/edition numbers live here."""
    folded = fold(title)
    return (re.findall(r"\d+", folded), [t for t in folded.split() if ROMAN.fullmatch(t)])


def colour_signature(title):
    return {t for t in fold(title).split() if t in COLOUR_WORDS}


def variant_key(title):
    """The closed rewrite set. Two titles sharing this key differ only by article, ampersand,
    a single trailing plural, punctuation or accents."""
    s = fold(title)
    s = re.sub(r"^the\s+", "", s)
    s = re.sub(r"\band\b", "&", s)          # both spellings collapse to one marker
    tokens = [re.sub(r"s$", "", t) if len(t) > 3 else t for t in s.split()]
    return " ".join(tokens)


def excluded(title):
    """Reasons a title may never enter a pair at all."""
    if not title or not title.strip():
        return "empty"
    if PLACEHOLDER.search(title):
        return "placeholder"
    if SERIES_MARKERS.search(fold(title)):
        return "series marker"
    return None


def classify(a, b):
    """How the two titles differ, or None when the closed set does not explain it."""
    if fold(a) == fold(b):
        return "identical"          # the exact rule already owns these
    classes = []
    fa, fb = fold(a), fold(b)
    if re.sub(r"^the\s+", "", fa) == re.sub(r"^the\s+", "", fb):
        classes.append("article")
    if re.sub(r"\band\b", "&", fa) == re.sub(r"\band\b", "&", fb):
        classes.append("ampersand")
    if variant_key(a) == variant_key(b):
        classes.append("plural/punctuation/accent")
    return "+".join(dict.fromkeys(classes)) if classes else None


def levenshtein1(a, b):
    """True when the two folded titles are one character apart. Generated, never proposed."""
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    for i in range(len(a) + 1):
        if a[:i] == b[:i] and a[i:] == b[i + 1:]:
            return True
    return a == b[:len(a)] and len(b) - len(a) == 1


WORKS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE ($artist IS NULL OR a.name = $artist)
  AND w.name IS NOT NULL AND trim(w.name) <> '' AND w.dateCreated_year IS NOT NULL
RETURN a.name AS artist, w.id AS workId, w.name AS title, w.dateCreated_year AS year
"""

# Rival exclusion is built from EVERY work, including the undated ones the identity key
# cannot cluster: an undated third spelling is still a spelling variant, not a lookalike.
FAMILY_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE ($artist IS NULL OR a.name = $artist)
  AND w.name IS NOT NULL AND trim(w.name) <> ''
RETURN a.name AS artist, w.id AS workId, w.name AS title
"""

DETAIL_QUERY = """
UNWIND $workIds AS wid
MATCH (w:ConceptualWork {id: wid})
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (s:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (i)-[:SHOWS]-(d:DigitalImage) WHERE d.embedding IS NOT NULL
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(w)
OPTIONAL MATCH (cr:CatalogueRaisonne)-[:CONTAINS]->(ce)
RETURN w.id AS workId, count(DISTINCT i) AS impressions,
       collect(DISTINCT d.id)[0..4] AS imageIds,
       collect(DISTINCT t.name) AS techniques,
       collect(DISTINCT s.institutionName) AS houses,
       collect(DISTINCT s.sourceType) AS sourceTypes,
       collect(DISTINCT {prefix: cr.numberingPrefix, number: ce.number}) AS catalogueEntries
"""

PAIR_SIM_QUERY = """
UNWIND $pairs AS p
MATCH (x:DigitalImage {id: p[0]}), (y:DigitalImage {id: p[1]})
RETURN p[0] AS a, p[1] AS b, vector.similarity.cosine(x.embedding, y.embedding) AS sim
"""

# The distinctiveness veto: the best score this image reaches against images of the SAME
# artist's OTHER works — the ones not in the pair. A series or a colourway family scores here.
RIVAL_QUERY = """
MATCH (d:DigitalImage {id: $imageId})
MATCH (a:Artist {name: $artist})-[:CREATED]->(w:ConceptualWork)
WHERE NOT w.id IN $pairWorkIds
MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)<-[:SHOWS]-(o:DigitalImage)
WHERE o.embedding IS NOT NULL AND o.id <> d.id
RETURN w.id AS rivalWorkId, w.name AS rivalTitle,
       vector.similarity.cosine(d.embedding, o.embedding) AS sim
ORDER BY sim DESC LIMIT 3
"""


def components(pairs):
    """Close admissible pairs into variant clusters. Membership is transitive: if A~B and B~C
    are both explained by the rewrite set, all three are one spelling family."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        parent[find(x)] = find(y)

    for p in pairs:
        union(p["a"]["workId"], p["b"]["workId"])
    groups = defaultdict(list)
    for p in pairs:
        groups[find(p["a"]["workId"])].append(p)
    out = []
    for members in groups.values():
        works, classes = {}, []
        for p in members:
            works[p["a"]["workId"]] = p["a"]
            works[p["b"]["workId"]] = p["b"]
            classes.append(p["class"])
        out.append({"artist": members[0]["artist"], "year": members[0]["year"],
                    "class": "+".join(sorted({c for c in classes})),
                    "works": list(works.values())})
    return out


def build_pairs(rows):
    """Candidate pairs: same artist, same year, titles explained by the closed rewrite set."""
    by_group = defaultdict(list)
    for r in rows:
        by_group[(r["artist"], r["year"])].append(r)
    pairs, skipped = [], defaultdict(int)
    for (artist, year), works in by_group.items():
        if len(works) < 2:
            continue
        for x, y in combinations(works, 2):
            why_x, why_y = excluded(x["title"]), excluded(y["title"])
            if why_x or why_y:
                skipped[why_x or why_y] += 1
                continue
            if numeric_signature(x["title"]) != numeric_signature(y["title"]):
                skipped["numerals differ"] += 1
                continue
            if colour_signature(x["title"]) != colour_signature(y["title"]):
                skipped["colour words differ"] += 1
                continue
            cls = classify(x["title"], y["title"])
            if cls == "identical":
                skipped["already exact (other rule owns it)"] += 1
                continue
            if cls is None:
                if levenshtein1(fold(x["title"]), fold(y["title"])):
                    pairs.append({"artist": artist, "year": year, "class": "typo1",
                                  "a": x, "b": y})
                else:
                    skipped["not a closed-set variant"] += 1
                continue
            pairs.append({"artist": artist, "year": year, "class": cls, "a": x, "b": y})
    return pairs, dict(skipped)


def article_or_punct_only(cluster):
    """True when every title in the cluster is identical once a leading article, punctuation and
    accents are folded — i.e. no token changed its number. See the docstring on why plurals are
    held rather than proposed."""
    keys = {re.sub(r"^the\s+", "", fold(w["title"])) for w in cluster["works"]}
    return len(keys) == 1


def adjudicate(session, cluster, details, floor, margin, variant_family=None):
    """Apply the vetoes to one variant cluster. Returns (bucket, evidence dict)."""
    ids = [w["workId"] for w in cluster["works"]]
    d = [details[i] for i in ids]
    ev = {"houses": sorted({h for x in d for h in x["houses"] if h}),
          "impressions": [x["impressions"] for x in d]}

    cats = [{(c["prefix"], c["number"]) for c in x["catalogueEntries"] if c["prefix"]} for x in d]
    for i, j in combinations(range(len(d)), 2):
        shared = {p for p, _ in cats[i]} & {p for p, _ in cats[j]}
        for p in shared:
            if {n for pp, n in cats[i] if pp == p} != {n for pp, n in cats[j] if pp == p}:
                ev["catalogueConflict"] = p
                return "catalogueConflict", ev
    # Numbers disagree even when the PREFIX strings differ. Jasper Johns "Voice 2" cites
    # ULAE/Field 228 and "Voices 2" cites ULAE 229: two catalogues, one numbering, two works —
    # and the prefix-keyed check above cannot see it because the strings are not equal. Dürer's
    # "Bartsch 41" against "B. 41" is the benign case the intersection test keeps.
    numbers = [{re.sub(r"[^0-9]", "", str(n)) for _, n in c if re.search(r"\d", str(n))}
               for c in cats]
    for i, j in combinations(range(len(d)), 2):
        if numbers[i] and numbers[j] and not (numbers[i] & numbers[j]):
            ev["catalogueNumberConflict"] = [sorted(numbers[i]), sorted(numbers[j])]
            return "catalogueConflict", ev

    agreeing = sorted({p for i, j in combinations(range(len(d)), 2)
                       for p in ({q for q, _ in cats[i]} & {q for q, _ in cats[j]})})
    if agreeing:
        ev["catalogueAgrees"] = agreeing

    techs = [set(x["techniques"]) for x in d]
    for i, j in combinations(range(len(d)), 2):
        if techs[i] and techs[j] and not (techs[i] & techs[j]):
            ev["techniqueConflict"] = [sorted(techs[i]), sorted(techs[j])]
            return "techniqueConflict", ev

    if any(not x["imageIds"] for x in d):
        ev["withoutImage"] = [x["workId"] for x in d if not x["imageIds"]]
        return "noImage", ev

    # Every member must agree with every other: the WEAKEST pair carries the cluster.
    weakest, best_imgs = None, []
    for i, j in combinations(range(len(d)), 2):
        sims = session.run(PAIR_SIM_QUERY,
                           pairs=[[x, y] for x in d[i]["imageIds"] for y in d[j]["imageIds"]]).data()
        best = max(sims, key=lambda s: s["sim"])
        best_imgs += [best["a"], best["b"]]
        weakest = best["sim"] if weakest is None else min(weakest, best["sim"])
    ev["minPairSim"] = round(weakest, 4)
    if weakest < floor:
        return "imageDissent", ev

    # A work that is ITSELF a spelling variant of this title is not an independent rival —
    # measured on Trevelyan, where a third spelling of "Lock Keeper's Cottage" carried a
    # different year, fell outside the (artist, year) cluster, and then vetoed it as a
    # lookalike. Exclude the whole variant family, of any year, not just this cluster.
    excluded_ids = sorted(set(ids) | set(variant_family or []))
    ev["rivalExclusions"] = len(excluded_ids)
    rivals = []
    for img in dict.fromkeys(best_imgs):
        rivals += session.run(RIVAL_QUERY, imageId=img, artist=cluster["artist"],
                              pairWorkIds=excluded_ids).data()
    if rivals:
        top = max(rivals, key=lambda r: r["sim"])
        ev["nearestRival"] = {"workId": top["rivalWorkId"], "title": top["rivalTitle"],
                              "sim": round(top["sim"], 4)}
        if top["sim"] >= weakest - margin:
            return "notDistinctive", ev
    if "typo1" in cluster["class"]:
        return "typo1Held", ev
    if not article_or_punct_only(cluster):
        return "pluralHeld", ev
    return "proposed", ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true",
                    help="required — this script has no write mode by design")
    ap.add_argument("--artist", help="restrict to one Artist node's exact name")
    ap.add_argument("--floor", type=float, default=DEFAULT_FLOOR)
    ap.add_argument("--margin", type=float, default=DEFAULT_MARGIN)
    ap.add_argument("--json", dest="out_json")
    ap.add_argument("--csv", dest="out_csv")
    args = ap.parse_args()
    if not args.scan:
        ap.error("Provide --scan (this script has no write mode by design)")
    for var in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
        if not os.environ.get(var):
            raise RuntimeError(f"{var} is not set. Source .env first.")

    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    database = os.environ.get("NEO4J_DATABASE", "neo4j")
    buckets = defaultdict(list)
    with driver.session(database=database) as session:
        rows = session.run(WORKS_QUERY, artist=args.artist).data()
        print(f"{len(rows)} dated works in scope", flush=True)
        pairs, skipped = build_pairs(rows)
        clusters = components(pairs)
        print(f"{len(pairs)} candidate pair(s) -> {len(clusters)} variant cluster(s) "
              f"after the closed rewrite set", flush=True)
        for reason, n in sorted(skipped.items(), key=lambda kv: -kv[1]):
            print(f"    excluded {n:>7} — {reason}")
        # artist -> variant key -> every work id carrying it, ANY year (rival exclusion)
        family = defaultdict(lambda: defaultdict(set))
        for r in session.run(FAMILY_QUERY, artist=args.artist).data():
            if not excluded(r["title"]):
                family[r["artist"]][variant_key(r["title"])].add(r["workId"])
        ids = sorted({w["workId"] for c in clusters for w in c["works"]})
        details = {d["workId"]: d for d in session.run(DETAIL_QUERY, workIds=ids).data()} if ids else {}
        for n, cluster in enumerate(clusters, 1):
            keys = {variant_key(w["title"]) for w in cluster["works"]}
            kin = {wid for k in keys for wid in family[cluster["artist"]][k]}
            bucket, ev = adjudicate(session, cluster, details, args.floor, args.margin, kin)
            buckets[bucket].append({
                "artist": cluster["artist"], "year": cluster["year"], "class": cluster["class"],
                "titles": [w["title"] for w in cluster["works"]],
                "workIds": [w["workId"] for w in cluster["works"]],
                "size": len(cluster["works"]), "evidence": ev,
            })
            if n % 50 == 0:
                print(f"  adjudicated {n}/{len(clusters)}", flush=True)
    driver.close()

    print(f"\n=== SPELLING-VARIANT {RULE_VERSION} "
          f"(floor {args.floor}, distinctiveness margin {args.margin}) ===")
    for bucket in ("proposed", "pluralHeld", "typo1Held", "notDistinctive", "imageDissent",
                   "noImage", "catalogueConflict", "techniqueConflict"):
        items = buckets.get(bucket, [])
        print(f"\n--- {bucket} ({len(items)}) ---")
        for c in items[:12]:
            ev = c["evidence"]
            extra = f" minSim {ev['minPairSim']}" if "minPairSim" in ev else ""
            if "nearestRival" in ev:
                extra += f" | nearest work outside the cluster {ev['nearestRival']['sim']} '{ev['nearestRival']['title']}'"
            print(f"  [{c['class']}] {c['artist']} ({c['year']}) x{c['size']}: "
                  f"{' ~ '.join(repr(t) for t in c['titles'])}{extra}")
        if len(items) > 12:
            print(f"  ... and {len(items) - 12} more")

    if args.out_json:
        # merge_duplicate_work_clusters.py's contract: only `proposed` is eligible there.
        json.dump({k: v for k, v in buckets.items()}, open(args.out_json, "w"), indent=1)
        print(f"\nFull results saved to {args.out_json}")
    if args.out_csv:
        with open(args.out_csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["bucket", "class", "artist", "year", "size", "titles", "workIds",
                        "minPairSim", "nearestRivalSim", "nearestRivalTitle"])
            for bucket, items in buckets.items():
                for c in items:
                    ev = c["evidence"]
                    w.writerow([bucket, c["class"], c["artist"], c["year"], c["size"],
                                " | ".join(c["titles"]), " | ".join(c["workIds"]),
                                ev.get("minPairSim"),
                                (ev.get("nearestRival") or {}).get("sim"),
                                (ev.get("nearestRival") or {}).get("title")])
        print(f"Pairs CSV saved to {args.out_csv}")


if __name__ == "__main__":
    main()
