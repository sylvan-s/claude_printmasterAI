"""
PrintMasterAI — fold duplicate ConceptualWork clusters into one node.
Version: DUPWORK-MERGE-1.0

Consumes `find_duplicate_work_clusters.py --json` output and applies ADR-0017's naming
contract. That script stays scan-only by design (its docstring and ADR-0017 both say so),
so the write lives here instead of being bolted onto it.

Only the `proposed` bucket is eligible. `catalogueConflict` and
`institutionalPortfolioSuspect` are explicit NON-merges — different prints sharing a title —
and `imagesDissent`, `nullYear` and `largeCluster` are review queues, not decisions. Naming
another bucket requires --bucket and is refused for the two conflict buckets outright.

WHAT IT WRITES (ADR-0017 decisions 2-4, and the first use of either property in this graph)

  Impression.sourceTitle    the title the source actually asserted, written BEFORE anything
                            moves. Decision 4: provenance belongs to the record that made the
                            assertion, not to the merged work. This is what makes the fold
                            lossless — after four nodes become one, "which house called it
                            what" is still answerable, and a future ingest can still match an
                            incoming lot against the wording its own house used. It is also
                            the honest home for strings that were never titles: lot-descriptive
                            openers, and ids like 'Untitled (A0250 lot 70)'.

  ConceptualWork.alternateTitles   every distinct title string the cluster carried, the
                            survivor's own included. Decision 3 chose a plain array mirroring
                            Artist.alternateNames over a (:Title) node model; the array loses
                            language tags, which is an accepted cost until multilingual search
                            is a real requirement.

  ConceptualWork.name       the principal title, by Decision 2's precedence.

TWO DECISIONS, NOT ONE — the same split find_artist_merge_candidates.py makes between
pick_canonical() and preferred_name(), for the same reason:

  Which NODE survives is about what a merge cannot re-derive. A CatalogueEntry pointing at a
  work is an external anchor, so a node holding one outranks a node with more impressions.
  Impression count, then id, break the rest.

  Which NAME it ends up with is a separate question answered by source precedence: a catalogue
  raisonne title (not ingested — ADR-0017 *Not addressed*), else an institutional title with
  that institution's placeholders excluded, else the most frequently asserted form. Tie-breaks
  in order: keeps its diacritics, then no embedded catalogue citation, then no lot-descriptive
  opener, then lexicographic for stability.

  Measured on the first real run: all 194 Picasso clusters contain ZERO institutional records,
  so tier 2 was inert and every one fell through to frequency plus tie-breaks. Expect that for
  any copyright-era artist, where Tate/BM/Met coverage is thin by licensing (ADR-0002).

  Tier 2 also refuses ingest FALLBACK titles, not just placeholders — ADR-0017 Amendment 1,
  written after Rembrandt's 25 institutional-tier clusters all produced 123-character truncated
  BM descriptions. See is_ingest_fallback().

NOT DONE HERE. ADR-0017 Decision 1 (decompose `plateDesignation` and `state` out of the title
before naming) is not implemented. The fold does not require it — the exact key demands
identical normalized titles, so '..., 3e planche' and '..., 2e planche' cannot land in one
cluster — but until it exists the principal name still carries those discriminators inline.
Note also that `state` as a flat property contradicts doc 08 §2, which already defines a
`State` node type in the Work layer (`traditionType`, tradition-agnostic); that type has zero
instances today and ADR-0017's own *Not addressed* leaves the modelling open.

Usage:
    python3 merge_duplicate_work_clusters.py --json dupwork.json --artist "Pablo Picasso" --dry-run
    python3 merge_duplicate_work_clusters.py --json dupwork.json --artist "Pablo Picasso" --apply
    python3 merge_duplicate_work_clusters.py --json dupwork.json --apply --backup out.json
"""

import argparse
import json
import os
import re
import unicodedata
from collections import Counter

from neo4j import GraphDatabase

from find_duplicate_work_clusters import PLACEHOLDER_TITLES


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

MERGEABLE_BUCKETS = {"proposed"}
NEVER_MERGE_BUCKETS = {"catalogueConflict", "institutionalPortfolioSuspect"}

# An embedded catalogue citation in the title — '(Delteil 8)', '[Vallier 181]', '(Cramer 30)'.
# ADR-0017: these belong in CatalogueEntry, so a title carrying one loses the tie-break.
_CITATION_RE = re.compile(
    r"[\(\[]\s*(?:not\s+in\s+\w+|"
    r"(?:cramer|delteil|vallier|bloch|schiefler|kemp|levinson|daunt|mourlot|field|"
    r"czwiklitzer|czw|baer|geiser|michler|stella|lugt|coppel|cristea|sanesi|krakow|"
    r"new\s+hollstein|hollstein|bartsch|hind|feldman|corlett|duthuit|dupin|herdman|"
    r"heenk|tommasini|breeskin|m\s*(?:&|and)\s*l|f\.?\s*(?:&|and)\s*s|b|d|ma|cz)\b\.?)"
    # A bracket may name two catalogues before the number — "(Bartsch, Hollstein 277,
    # Hind 227, New Hollstein 236)" — so allow intervening text, but require a number.
    r"[^)\]]{0,60}?[0-9IVXLivxl]",
    re.I,
)

# 'Six etchings...', 'One plate, from...', 'La Bible: Five Plates' — describes the LOT, not the
# work. 707 titles graph-wide match this shape; they must never win the principal name.
_LOT_DESCRIPTIVE_RE = re.compile(
    r"^\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]+)\s+"
    r"(?:plate|plates|etching|etchings|work|works|print|prints|lithograph|lithographs|"
    r"sheet|sheets|plate\(s\))\b",
    re.I,
)


CLUSTER_DETAIL_QUERY = """
UNWIND $workIds AS wid
MATCH (w:ConceptualWork {id: wid})
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (sr:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(w)
RETURN w.id AS workId, w.name AS name,
       count(DISTINCT i) AS impressions,
       collect(DISTINCT i.id) AS impressionIds,
       collect(DISTINCT sr.sourceType) AS sourceTypes,
       collect(DISTINCT sr.institutionName) AS institutions,
       count(DISTINCT ce) AS catalogueEntries
"""

# Decision 4, and it runs BEFORE any edge moves: once an Impression hangs off the survivor,
# the wording its own source used is gone. Never overwrite one that already carries a value —
# a re-run must not relabel an impression with the survivor's title.
STAMP_SOURCE_TITLE_QUERY = """
UNWIND $rows AS row
MATCH (w:ConceptualWork {id: row.workId})-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
WHERE i.sourceTitle IS NULL AND row.name IS NOT NULL
SET i.sourceTitle = row.name
RETURN count(i) AS stamped
"""

# Every edge type a ConceptualWork can carry, confirmed live 2026-09-11 by enumerating them:
# PRINTED_AS->EditionRun (97,989), <-CREATED-Artist (92,157), DATED_TO->Period (35,424),
# <-DOCUMENTS-CatalogueEntry (26,193), <-SHOWS-DigitalImage (31). If that inventory ever grows,
# this query silently drops the new type on merge — re-check it before a fresh sweep.
MERGE_QUERY = """
MATCH (surv:ConceptualWork {id: $survivorId})
MATCH (dup:ConceptualWork {id: $dupId})
WITH surv, dup WHERE elementId(surv) <> elementId(dup)
WITH surv, dup,
     coalesce(surv.alternateTitles, []) + coalesce(dup.alternateTitles, [])
     + [surv.name, dup.name] AS combined
UNWIND combined AS t
WITH surv, dup, collect(DISTINCT t) AS titles
SET surv.alternateTitles = [x IN titles WHERE x IS NOT NULL],
    surv.seriesTitle = coalesce(surv.seriesTitle, dup.seriesTitle),
    surv.catalogueRefsRaw = coalesce(surv.catalogueRefsRaw, dup.catalogueRefsRaw),
    surv.dateCreated_year = coalesce(surv.dateCreated_year, dup.dateCreated_year)
WITH surv, dup
OPTIONAL MATCH (dup)-[:PRINTED_AS]->(er:EditionRun)
FOREACH (x IN CASE WHEN er IS NULL THEN [] ELSE [er] END | MERGE (surv)-[:PRINTED_AS]->(x))
WITH DISTINCT surv, dup
OPTIONAL MATCH (art:Artist)-[:CREATED]->(dup)
FOREACH (x IN CASE WHEN art IS NULL THEN [] ELSE [art] END | MERGE (x)-[:CREATED]->(surv))
WITH DISTINCT surv, dup
OPTIONAL MATCH (dup)-[:DATED_TO]->(per:Period)
FOREACH (x IN CASE WHEN per IS NULL THEN [] ELSE [per] END | MERGE (surv)-[:DATED_TO]->(x))
WITH DISTINCT surv, dup
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(dup)
FOREACH (x IN CASE WHEN ce IS NULL THEN [] ELSE [ce] END | MERGE (x)-[:DOCUMENTS]->(surv))
WITH DISTINCT surv, dup
OPTIONAL MATCH (di:DigitalImage)-[:SHOWS]->(dup)
FOREACH (x IN CASE WHEN di IS NULL THEN [] ELSE [di] END | MERGE (x)-[:SHOWS]->(surv))
WITH DISTINCT dup
DETACH DELETE dup
"""

SET_NAME_QUERY = """
MATCH (w:ConceptualWork {id: $workId}) SET w.name = $name RETURN w.name AS name
"""


def _diacritics(s):
    return sum(1 for ch in unicodedata.normalize("NFKD", s or "") if unicodedata.combining(ch))


# ADR-0017 Amendment 1. An ingest fallback is not an institutional title and must not win
# tier 2. Identified by the exact signature of the code that produced it, never by shape:
# `bm_ingest.py` line 612 substitutes `description[:120] + "..."` (so exactly 123 chars) when a
# BM record carries neither an "Object:" title nor a "Series:" entry — 78 works graph-wide — and
# falls finally to `Untitled (<object_id>)` — a branch that never actually fires, since the
# description fallback catches those records first. The equivalent that DOES fire is
# roseberys_ingest.py:219 / forum_ingest.py:247's `Untitled (<sale_code> lot <n>)`, 1,493 works.
#
# Shape alone would be wrong, and measurably so: 137 titles end in "..." but only those 78 are
# fallbacks. The other 59 are real works whose titles end in an ellipsis — Tate holds
# 'Sounds Barely Heard ...', 'Someone, Somewhere ...', 'Both the Garden Style ...'.
#
# Brittle on purpose: 123 is bm_ingest.py's 120 plus three dots. If that constant moves this
# silently stops matching. The real fix is for the ingest to mark the substitution — see the
# amendment's "Accepted brittleness".
_BM_TRUNCATED_DESCRIPTION_LEN = 123
# Only the ID-shaped parentheticals. 2,818 works are named 'Untitled (...)' and the overwhelming
# majority are REAL descriptive titles — 'Untitled (Nepal Relief)', 'Untitled (Self Portrait)',
# 'Untitled (Natura Morta)' — which must survive untouched.
_UNTITLED_FALLBACK_RES = (
    re.compile(r"^untitled\s*\([A-Z]+[0-9]+\s+lot\s+[0-9A-Za-z]+\)$", re.I),
    re.compile(r"^untitled\s*\((?:bm|bonhams|forum|roseberys|met|tate)[-_][A-Za-z0-9_.\-]+\)$", re.I),
)


def is_ingest_fallback(title):
    if not title:
        return False
    t = title.strip()
    if len(t) == _BM_TRUNCATED_DESCRIPTION_LEN and t.endswith("..."):
        return True
    return any(rx.match(t) for rx in _UNTITLED_FALLBACK_RES)


def is_placeholder(title):
    t = re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()
    return t in PLACEHOLDER_TITLES


def pick_survivor(details):
    """Which NODE lives. An external anchor outranks volume — a CatalogueEntry pointing at this
    work cannot be re-derived from the others, an impression count can."""
    def score(d):
        return (d["catalogueEntries"] > 0, d["impressions"], d["workId"])
    return max(details, key=score)["workId"]


def pick_principal_name(details):
    """Which NAME the survivor carries — ADR-0017 Decision 2. Returns (name, tier)."""
    institutional = [d for d in details
                     if "institutional" in (d["sourceTypes"] or [])
                     and d["name"] and not is_placeholder(d["name"])
                     and not is_ingest_fallback(d["name"])]
    pool, tier = (institutional, "institutional") if institutional else (details, "frequency")

    names = [d["name"] for d in pool
             if d["name"] and not is_placeholder(d["name"]) and not is_ingest_fallback(d["name"])]
    if not names:
        names = [d["name"] for d in pool if d["name"] and not is_placeholder(d["name"])]
    if not names:
        names = [d["name"] for d in details if d["name"]]
    if not names:
        return None, "none"

    freq = Counter(names)
    top = freq.most_common(1)[0][1]
    candidates = sorted({n for n in names if freq[n] == top})

    candidates.sort(key=lambda n: (
        -_diacritics(n),                              # keeps its diacritics
        1 if _CITATION_RE.search(n) else 0,           # no embedded catalogue citation
        1 if _LOT_DESCRIPTIVE_RE.match(n) else 0,     # no lot-descriptive opener
        n,                                            # stable
    ))
    return candidates[0], tier


def load_clusters(path, artist, bucket, min_size):
    data = json.load(open(path))
    if bucket in NEVER_MERGE_BUCKETS:
        raise SystemExit(
            f"--bucket {bucket} is an explicit NON-merge bucket: those clusters are different "
            f"prints that share a title. Refusing.")
    if bucket not in data:
        raise SystemExit(f"bucket {bucket!r} not in {path} (have: {sorted(data)})")
    out = [c for c in data[bucket] if c["size"] >= min_size]
    if artist:
        out = [c for c in out if c.get("artist") == artist]
    return out


def run(session, clusters, apply_changes, backup_path=None):
    work_ids = sorted({w for c in clusters for w in c["workIds"]})
    details = {}
    for chunk in range(0, len(work_ids), 1000):
        for r in session.run(CLUSTER_DETAIL_QUERY, workIds=work_ids[chunk:chunk + 1000]):
            details[r["workId"]] = dict(r)

    plans, missing = [], 0
    for c in clusters:
        ds = [details[w] for w in c["workIds"] if w in details]
        if len(ds) < 2:
            missing += 1
            continue
        survivor = pick_survivor(ds)
        name, tier = pick_principal_name(ds)
        plans.append({
            "artist": c["artist"], "clusterTitle": c["title"], "year": c["year"],
            "survivor": survivor, "dups": [d["workId"] for d in ds if d["workId"] != survivor],
            "principalName": name, "nameTier": tier,
            "alternateTitles": sorted({d["name"] for d in ds if d["name"]}),
            "members": ds,
        })

    if missing:
        print(f"{missing} cluster(s) skipped — fewer than 2 members still present in the graph.\n")
    if backup_path:
        json.dump(plans, open(backup_path, "w"), indent=1, ensure_ascii=False)
        print(f"Plan + pre-merge state saved to {backup_path}\n")

    tiers = Counter(p["nameTier"] for p in plans)
    print(f"{len(plans)} cluster(s), {sum(len(p['dups']) for p in plans)} node(s) to remove. "
          f"Principal name by tier: {dict(tiers)}\n")

    renamed = stamped_total = merged = 0
    for p in plans:
        survivor_name = details[p["survivor"]]["name"]
        tag = "" if p["principalName"] == survivor_name else f"  RENAME -> {p['principalName']!r}"
        print(f"  [{len(p['dups']) + 1}] {p['clusterTitle'][:52]!r} ({p['year']}) "
              f"keep {p['survivor']}{tag}")
        for d in p["dups"]:
            print(f"        drop {d}")

        if p["principalName"] and p["principalName"] != survivor_name:
            renamed += 1

        if not apply_changes:
            continue

        rows = [{"workId": d["workId"], "name": d["name"]} for d in p["members"]]
        stamped_total += session.run(STAMP_SOURCE_TITLE_QUERY, rows=rows).single()["stamped"]
        for dup in p["dups"]:
            session.run(MERGE_QUERY, survivorId=p["survivor"], dupId=dup).consume()
            merged += 1
        if p["principalName"] and p["principalName"] != survivor_name:
            session.run(SET_NAME_QUERY, workId=p["survivor"], name=p["principalName"]).consume()

    verb = "were" if apply_changes else "would be"
    print(f"\n{merged if apply_changes else sum(len(p['dups']) for p in plans)} node(s) {verb} "
          f"folded into {len(plans)} survivor(s); {renamed} survivor(s) {verb} renamed.")
    if apply_changes:
        print(f"{stamped_total} Impression(s) stamped with sourceTitle.")
    return plans


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", required=True, help="find_duplicate_work_clusters.py --json output")
    parser.add_argument("--artist", help="Restrict to one Artist node's exact name")
    parser.add_argument("--bucket", default="proposed",
                        help="Cluster bucket to fold (default: proposed). The two conflict "
                             "buckets are refused outright.")
    parser.add_argument("--min-size", type=int, default=2)
    parser.add_argument("--apply", action="store_true", help="Write. Without it, this is a dry run.")
    parser.add_argument("--backup", help="Save the plan and pre-merge member state to this path")
    args = parser.parse_args()

    clusters = load_clusters(args.json, args.artist, args.bucket, args.min_size)
    if not clusters:
        raise SystemExit("No clusters matched.")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            run(session, clusters, apply_changes=args.apply, backup_path=args.backup)
    finally:
        driver.close()
