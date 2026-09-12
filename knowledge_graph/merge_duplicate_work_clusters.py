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

# THE DECISION RULE IS RECORDED, because a merge is otherwise unanswerable. DETACH DELETE takes
# the duplicate's id with it, so today the graph cannot say what was folded into a work, by what
# reasoning, or when — only a gitignored backup JSON can, and only if --backup was passed. That
# makes a bad RULE unreversible at scale: there is no way to ask "show me everything merged by
# the year+technique corroborator" once it turns out to have been too weak.
#
# The vocabulary is the set of paths that actually exist, not an invented taxonomy. Each maps to
# a generator in this directory and carries that generator's own version string.
MERGE_RULES = {
    "exactTitleYear":      "DUPWORK-SCAN-1.0",        # artist + normalized title + year
    "catalogueAnchor":     "MUSEUM-ANCHOR-1.0",       # shared CatalogueEntry, institutional arbiter
    "imageCorroborated":   "IMAGE-CANDIDATES-1.0",    # DINOv2 retrieval + an EXACT corroborator
    "splinkStateFamily":   "SPLINK-CANDIDATES-1.0",   # same catalogue base, differing state designation
    "visualAdjudication":  "VISUAL-ADJUDICATOR-1.0",  # a vision model's cited verdict
    "plateImpressionJoin": "PLATE-JOIN-1.0",          # a Matrix record joined to its impressions
    "exactCatalogueTitle": "EXACT-CAT-MERGE-1.0",    # same artist node, folded title and cat base
    "editionSiblings":     "EDITION-SIBLINGS-1.0",   # one numbered edition held as many nodes
    "titleCollisionBand":  "COLLISION-RANK-1.0",     # splink weight >= 15 and catalogue agree/none
    "humanTriage":         "human",                   # a person read the evidence and decided
}

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
// REALIZED_AS was missing until 2026-09-11 and DETACH DELETE would have silently
// destroyed it: a ConceptualWork folded into another lost its link to the physical
// Matrix. 276 such edges exist. Found while joining Picasso-Paris plate records to the
// impressions pulled from them — those works reach a Matrix through REALIZED_AS and
// nothing else, so merging one would have deleted the only path to the plate.
OPTIONAL MATCH (dup)-[:REALIZED_AS]->(mx:Matrix)
FOREACH (x IN CASE WHEN mx IS NULL THEN [] ELSE [mx] END | MERGE (surv)-[:REALIZED_AS]->(x))
WITH DISTINCT surv, dup
OPTIONAL MATCH (dup)-[:DATED_TO]->(per:Period)
FOREACH (x IN CASE WHEN per IS NULL THEN [] ELSE [per] END | MERGE (surv)-[:DATED_TO]->(x))
WITH DISTINCT surv, dup
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(dup)
FOREACH (x IN CASE WHEN ce IS NULL THEN [] ELSE [ce] END | MERGE (x)-[:DOCUMENTS]->(surv))
WITH DISTINCT surv, dup
OPTIONAL MATCH (di:DigitalImage)-[:SHOWS]->(dup)
FOREACH (x IN CASE WHEN di IS NULL THEN [] ELSE [di] END | MERGE (x)-[:SHOWS]->(surv))
WITH DISTINCT surv, dup
// Written BEFORE the delete and in the same transaction, so a fold either leaves a record of
// itself or does not happen. mergedFromId is what makes a stale external reference resolvable:
// a saved comparable, another session's CSV or a workIds column can be looked up after the node
// it names has gone.
MERGE (ev:MergeEvent {id: surv.id + ' <- ' + dup.id})
SET ev.mergedFromId   = dup.id,
    ev.mergedFromName = dup.name,
    ev.rule           = $rule,
    ev.ruleVersion    = $ruleVersion,
    ev.decidedBy      = $decidedBy,
    ev.evidence       = $evidence,
    ev.confidence     = $confidence,
    ev.at             = datetime()
MERGE (ev)-[:MERGED_INTO]->(surv)
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


# WHAT EACH GENERATOR CALLS ITS EVIDENCE. They agree on nothing, because each was written for
# its own signal: the anchored and exact-catalogue rules write `corroborator`, the image
# generator writes `corroborator` plus `similarity`, the edition rule writes `corroborator` plus
# `editionNumbers`, and a human triage row writes `note`. Assembled here rather than demanded of
# them, so adding a generator does not mean touching the merger.
_EVIDENCE_FIELDS = ("corroborator", "note", "heldReason")
_EVIDENCE_NUMERIC = (("similarity", "image similarity"), ("bestImageCosine", "best image cosine"),
                     ("yearGap", "year gap"), ("matchWeight", "splink weight"))


def cluster_evidence(cluster):
    """One readable line recording WHY this cluster was proposed, for MergeEvent.evidence.

    Empty on all 773 events written before 2026-09-12: run() read `corroborator` off the PLAN,
    and the plan never carried it. The field existed and nothing reached it."""
    parts = [str(cluster[f]) for f in _EVIDENCE_FIELDS if cluster.get(f)]
    for key, label in _EVIDENCE_NUMERIC:
        if cluster.get(key) is not None:
            parts.append(f"{label} {cluster[key]}")
    # Fallbacks only. The edition rule already spells both of these into its corroborator, and
    # repeating them made the line say the same thing three times.
    if not parts:
        if cluster.get("editionNumbers"):
            numbers = cluster["editionNumbers"]
            parts.append(f"edition numbers {min(numbers)}-{max(numbers)}"
                         + (f" of {cluster['declaredSize']}"
                            if cluster.get("declaredSize") else ""))
        if cluster.get("institution"):
            parts.append(f"at {cluster['institution']}")
    return "; ".join(parts)


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


def run(session, clusters, apply_changes, backup_path=None, rule="exactTitleYear"):
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
            "evidence": cluster_evidence(c),
            "confidence": c.get("confidence"),
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

    # A work with TWO Artist nodes lands in two clusters at once — confirmed on the first
    # graph-wide sweep, where 123 work ids appeared in more than one cluster because pairs like
    # 'Connor Brothers'/'The Connor Brothers' are still unmerged at artist level. Once the first
    # cluster folds that node away, a later cluster naming it MATCHes nothing and its whole merge
    # silently no-ops, stranding dups. find_artist_merge_candidates.py solves this with the same
    # alias map; this is that mechanism, ported (it was missing on the first sweep, which left 3
    # of 10,811 nodes unfolded — no data lost, just under-merged).
    alias = {}

    def resolve(wid):
        seen = set()
        while wid in alias and wid not in seen:
            seen.add(wid)
            wid = alias[wid]
        return wid

    renamed = stamped_total = merged = skipped = 0
    for p in plans:
        survivor = resolve(p["survivor"])
        dups = sorted({resolve(d) for d in p["dups"]} - {survivor})
        if not dups:
            skipped += 1
            continue
        if survivor != p["survivor"]:
            print(f"  [REROUTED] {p['survivor']} already folded into {survivor}")
        p = {**p, "survivor": survivor, "dups": dups}
        survivor_name = details.get(p["survivor"], {}).get("name")
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
            counters = session.run(
                MERGE_QUERY, survivorId=p["survivor"], dupId=dup,
                rule=rule, ruleVersion=MERGE_RULES[rule],
                decidedBy=("human" if rule == "humanTriage"
                           else "model" if rule == "visualAdjudication" else "rule"),
                evidence=p.get("evidence") or "",
                confidence=p.get("confidence")).consume().counters
            if not counters.nodes_deleted:
                print(f"        [SKIP] {dup} — no longer present")
                skipped += 1
                continue
            alias[dup] = p["survivor"]
            merged += 1
        if p["principalName"] and p["principalName"] != survivor_name:
            session.run(SET_NAME_QUERY, workId=p["survivor"], name=p["principalName"]).consume()

    verb = "were" if apply_changes else "would be"
    print(f"\n{merged if apply_changes else sum(len(p['dups']) for p in plans)} node(s) {verb} "
          f"folded into {len(plans)} survivor(s); {renamed} survivor(s) {verb} renamed; "
          f"{skipped} skipped (already folded by an overlapping cluster).")
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
    parser.add_argument("--rule", default="exactTitleYear", choices=sorted(MERGE_RULES),
                        help="which decision rule produced these clusters. Recorded on the "
                             "MergeEvent so a bad rule can be found and reversed later.")
    args = parser.parse_args()

    clusters = load_clusters(args.json, args.artist, args.bucket, args.min_size)
    if not clusters:
        raise SystemExit("No clusters matched.")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            run(session, clusters, apply_changes=args.apply, backup_path=args.backup,
                rule=args.rule)
    finally:
        driver.close()
