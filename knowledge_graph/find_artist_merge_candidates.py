"""
PrintMasterAI — Artist-node merge-candidate detection: token-subset name matching,
corroborated by DINOv2 image-embedding cross-similarity
Version: ARTIST-MERGE-CANDIDATES-1.0

Complements the exact-normalization checks already run in this graph's history
(honorific-stripping, ALL-CAPS case-folding) with a genuinely different, complementary
technique: those both rely on one name being a clean prefix/suffix of the other after
stripping a known suffix/casing difference. Real name variants are often NOT a clean
prefix/suffix relationship — a middle name gets inserted in the middle ("Roberto Matta"
vs "Roberto Sébastian Matta"), which no substring check catches. **Token-set
containment** does: treat each name as a bag of words and flag pairs where one
artist's word-set is a subset of the other's, regardless of word order or position.
Grouped by surname first (the last token) to keep this cheap and avoid an O(n^2) scan
across the whole Artist label.

**This alone is not enough to trust as an auto-merge signal — confirmed by two real
false-positive traps found live, 2026-09-06, not designed defensively in the
abstract:**
  1. "Alexander Calder" (556 works) vs "Alexander Milne Calder" (1 work) — passes the
     name check, but Alexander Milne Calder was a real, different person: the famous
     mobile-sculptor's own grandfather, three generations of Calder sculptors sharing
     a name pattern.
  2. "Camille Pissarro" (32 embedded works) vs "Orovida Camille Pissarro" (10 embedded
     works) — Orovida was Camille Pissarro's own granddaughter, a distinct artist with
     her own separate career (1893-1968), found only by running this check broadly,
     not by looking for it.

**DINOv2 cross-similarity between the two candidate nodes' own already-embedded
DigitalImage vectors turns out to be a genuinely discriminating corroborating signal
for exactly this — CLIP does not.** Confirmed live against the two known cases above
plus the real Roberto Matta split (same person, 4-way name-variant fragmentation):
Matta's real split scored DINOv2 max=0.934 across name-variant pairs; Calder and
Pissarro/Orovida (both confirmed different real people) scored 0.522 and 0.408
respectively. CLIP stayed high (~0.75-0.80) regardless of true identity in every case
tested — not discriminating here, likely because CLIP's embedding leans more on broad
semantic/content category than the fine-grained stylistic "hand" signature DINOv2
captures. So this script scores DINOv2 only, not CLIP.

**Coverage caveat:** only pairs where BOTH sides have at least one embedded
`DigitalImage` can be scored at all — currently that means Bonhams/Tate/British Museum
only (Roseberys/Forum have no DINOv2/CLIP coverage). Pairs with only 1-2 images per
side are statistically noisy — a low score there means "not enough data," not
"confirmed different." Don't over-read a thin-sample low score as a rejection.

Same "no fuzzy matching, always generate candidates for review rather than auto-merge"
discipline as catalogue_matching.py and every prior artist-dedup pass in this graph's
history (see feedback_catalogue_identity_no_fuzzy_matching memory) — `--merge` only
acts on pairs whose DINOv2 max similarity clears `--threshold` (default 0.80, the
value that cleanly separated every genuine match from every known false positive in
the pairs checked so far); everything else is left for a human to look at via `--scan`.

Canonical node per merged pair is chosen the same way as every other merge this
session: (has ulanUrl, has wikidataUrl, most CREATED works) in that priority order —
computed live per pair, never assumed from which name happens to be "shorter" or
"longer".

Usage:
    python3 find_artist_merge_candidates.py --scan                        # report only, no writes
    python3 find_artist_merge_candidates.py --scan --json out.json        # also save full results
    python3 find_artist_merge_candidates.py --merge --threshold 0.80      # execute merges for scored pairs >= threshold
    python3 find_artist_merge_candidates.py --merge --threshold 0.80 --dry-run   # print what would merge, no writes
"""

import argparse
import json
import math
import os

from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

# Surnames (last token of the normalized name) that are placeholder buckets, not real
# individual identities — confirmed real cases found in this graph, not guessed:
# "Anonymous, Nth century"/"British Nth Century" (a nationality-qualified anonymous
# placeholder, not one coherent identity), "Various Artists"/"Various ... Artists"
# (multi-artist lot placeholders). Excluded from candidate generation entirely, same
# category as "Monogrammist"/"Master" already excluded from the honorific sweep.
PLACEHOLDER_SURNAMES = {"artists", "century", "unknown", "known"}

DEFAULT_THRESHOLD = 0.80

PAIRS_QUERY = """
MATCH (a:Artist)
OPTIONAL MATCH (a)-[:CREATED]->(cw)
WITH a, count(DISTINCT cw) AS works
WITH a, works,
     [t IN split(toLower(replace(replace(a.name, ',', ' '), '.', '')), ' ') WHERE t <> ''] AS toks
WHERE size(toks) > 0
WITH a, works, toks, toks[-1] AS surname
WITH surname, collect({node: a, works: works, toks: toks}) AS members
WHERE size(members) > 1 AND NOT surname IN $placeholderSurnames
UNWIND members AS m1
UNWIND members AS m2
WITH surname, m1, m2
WHERE id(m1.node) < id(m2.node)
  AND size(m1.toks) + 1 = size(m2.toks)
  AND size([t IN m1.toks WHERE NOT t IN m2.toks]) = 0
  AND size(m1.toks) >= 2
RETURN surname, m1.node.name AS shorterName, m1.works AS shorterWorks,
       m2.node.name AS longerName, m2.works AS longerWorks
ORDER BY surname
"""

EMBEDDINGS_QUERY = """
UNWIND $names AS nm
MATCH (a:Artist {name: nm})-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:SHOWS]-(img:DigitalImage)
WHERE img.embedding IS NOT NULL
RETURN nm AS name, collect(img.embedding) AS embeddings
"""

ARTIST_INFO_QUERY = """
MATCH (a:Artist {name: $name})
OPTIONAL MATCH (a)-[:CREATED]->(cw)
RETURN a.ulanUrl AS ulan, a.wikidataUrl AS wikidata, count(DISTINCT cw) AS works
"""

MERGE_QUERY = """
MATCH (dup:Artist {name: $dupName})
MATCH (canon:Artist {name: $canonName})
WITH canon, dup, coalesce(canon.alternateNames,[]) + coalesce(dup.alternateNames,[]) + [dup.name] AS combined
UNWIND combined AS x
WITH canon, dup, collect(DISTINCT x) AS deduped
SET canon.alternateNames = deduped
WITH canon, dup
OPTIONAL MATCH (dup)-[:CREATED]->(cw2:ConceptualWork)
FOREACH (x IN CASE WHEN cw2 IS NULL THEN [] ELSE [cw2] END | MERGE (canon)-[:CREATED]->(x))
WITH canon, dup
OPTIONAL MATCH (dup)-[:FROM_REGION]->(reg:Region)
FOREACH (x IN CASE WHEN reg IS NULL THEN [] ELSE [reg] END | MERGE (canon)-[:FROM_REGION]->(x))
WITH canon, dup
OPTIONAL MATCH (src:SourceRecord)-[:ATTRIBUTED_TO]->(dup)
FOREACH (x IN CASE WHEN src IS NULL THEN [] ELSE [src] END | MERGE (x)-[:ATTRIBUTED_TO]->(canon))
WITH dup
DETACH DELETE dup
"""


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def find_candidate_pairs(session):
    result = session.run(PAIRS_QUERY, placeholderSurnames=list(PLACEHOLDER_SURNAMES))
    return [dict(r) for r in result]


def fetch_embeddings(session, names):
    result = session.run(EMBEDDINGS_QUERY, names=names)
    return {r["name"]: r["embeddings"] for r in result}


def score_pairs(pairs, embeddings):
    scored = []
    unscored = []
    for p in pairs:
        vecsA = embeddings.get(p["shorterName"])
        vecsB = embeddings.get(p["longerName"])
        if not vecsA or not vecsB:
            unscored.append(p)
            continue
        sims = [cosine(a, b) for a in vecsA for b in vecsB]
        scored.append({
            **p,
            "nA": len(vecsA), "nB": len(vecsB),
            "meanSim": sum(sims) / len(sims), "maxSim": max(sims),
        })
    scored.sort(key=lambda r: -r["maxSim"])
    return scored, unscored


def get_artist_info(session, name):
    row = session.run(ARTIST_INFO_QUERY, name=name).single()
    return dict(row) if row else {"ulan": None, "wikidata": None, "works": 0}


def pick_canonical(session, nameA, nameB):
    infoA = get_artist_info(session, nameA)
    infoB = get_artist_info(session, nameB)

    def score(info):
        return (1_000_000 if info["ulan"] else 0) + (100_000 if info["wikidata"] else 0) + 10 * info["works"]

    if score(infoA) >= score(infoB):
        return nameA, nameB
    return nameB, nameA


def run_scan(session, out_json=None):
    pairs = find_candidate_pairs(session)
    print(f"Total candidate pairs (after excluding placeholder surnames): {len(pairs)}")
    names = sorted(set([p["shorterName"] for p in pairs] + [p["longerName"] for p in pairs]))
    embeddings = fetch_embeddings(session, names)
    print(f"Artists with >=1 embedded image among candidates: {len(embeddings)} / {len(names)}")
    scored, unscored = score_pairs(pairs, embeddings)
    print(f"Scored (both sides have embeddings): {len(scored)}")
    print(f"Unscored (no embedding coverage on one/both sides): {len(unscored)}\n")

    print(f"=== STYLE-CORROBORATED (max DINOv2 sim >= {DEFAULT_THRESHOLD}) — high confidence merge ===")
    for r in scored:
        if r["maxSim"] >= DEFAULT_THRESHOLD:
            print(f"{r['maxSim']:.3f} (mean {r['meanSim']:.3f}, n={r['nA']}x{r['nB']})  {r['shorterName']!r} <-> {r['longerName']!r}")

    print("\n=== NAME MATCHES BUT STYLE DOES NOT CORROBORATE (max DINOv2 sim < 0.55) — needs manual review ===")
    for r in scored:
        if r["maxSim"] < 0.55:
            print(f"{r['maxSim']:.3f} (mean {r['meanSim']:.3f}, n={r['nA']}x{r['nB']})  {r['shorterName']!r} <-> {r['longerName']!r}")

    print("\n=== AMBIGUOUS (0.55 <= max < {:.2f}) ===".format(DEFAULT_THRESHOLD))
    for r in scored:
        if 0.55 <= r["maxSim"] < DEFAULT_THRESHOLD:
            print(f"{r['maxSim']:.3f} (mean {r['meanSim']:.3f}, n={r['nA']}x{r['nB']})  {r['shorterName']!r} <-> {r['longerName']!r}")

    print(f"\n=== NO EMBEDDING COVERAGE ({len(unscored)} pairs, name-only signal) ===")
    for p in unscored:
        print(f"{p['shorterName']!r} <-> {p['longerName']!r}  ({p['shorterWorks']} vs {p['longerWorks']} works)")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({"scored": scored, "unscored": unscored}, f, indent=2, ensure_ascii=False)
        print(f"\nFull results saved to {out_json}")

    return scored, unscored


def run_merge(session, threshold, dry_run=False):
    pairs = find_candidate_pairs(session)
    names = sorted(set([p["shorterName"] for p in pairs] + [p["longerName"] for p in pairs]))
    embeddings = fetch_embeddings(session, names)
    scored, _ = score_pairs(pairs, embeddings)

    to_merge = [r for r in scored if r["maxSim"] >= threshold]
    print(f"{len(to_merge)} pair(s) clear the {threshold} DINOv2 max-similarity threshold.\n")

    merged = 0
    for r in to_merge:
        canon, dup = pick_canonical(session, r["shorterName"], r["longerName"])
        if dry_run:
            print(f"[DRY RUN] would merge {dup!r} -> {canon!r} (maxSim={r['maxSim']:.3f})")
            continue
        result = session.run(MERGE_QUERY, dupName=dup, canonName=canon)
        counters = result.consume().counters
        if counters.nodes_deleted:
            print(f"[MERGED] {dup!r} -> {canon!r} (maxSim={r['maxSim']:.3f}, "
                  f"rels created={counters.relationships_created}, deleted={counters.relationships_deleted})")
            merged += 1
        else:
            print(f"[SKIP] {dup!r} -> {canon!r} — dup node not found (likely already merged by a prior pass)")
    print(f"\n{merged} node(s) merged." if not dry_run else f"\n{len(to_merge)} pair(s) would be merged.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true", help="Report candidate pairs and DINOv2 scores, no writes")
    parser.add_argument("--merge", action="store_true", help="Execute merges for pairs scoring >= --threshold")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="DINOv2 max-similarity cutoff for --merge")
    parser.add_argument("--dry-run", action="store_true", help="With --merge, print what would happen without writing")
    parser.add_argument("--json", dest="out_json", help="With --scan, also save full results to this path")
    args = parser.parse_args()

    if not args.scan and not args.merge:
        parser.error("Provide --scan or --merge")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.scan:
                run_scan(session, out_json=args.out_json)
            if args.merge:
                run_merge(session, threshold=args.threshold, dry_run=args.dry_run)
    finally:
        driver.close()
