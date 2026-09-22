"""
PrintMasterAI — `POSSIBLE_SAME_AS`: identity candidates a scan held back, kept in the graph.
Version: IDENTITY-CANDIDATES-1.0

WHY. Merging is the identity decision this graph acts on: every consumer (the price export, the
priors, Stage 3 same-work comps, the resolvers) reads one node as one thing and never has to know
about clusters. But the scans that propose merges also HOLD pairs back — a fuzzy name the images
did not corroborate, a spelling variant that changes a plural, a title collision below the band —
and until now those lived only in regenerable CSVs, so nothing could query them, a reviewer's
"these are different" was lost with the file, and the next scan re-proposed the Calder trap.

    (:Artist)-[:POSSIBLE_SAME_AS {status, rule, ruleVersion, score, scoreKind, evidence,
                                  heldBecause, nameA, nameB, proposedAt, lastSeenAt,
                                  decidedBy, decidedAt, decisionNote}]-(:Artist)
    the same between two ConceptualWork nodes; never across labels

  status   open       held by a scan, awaiting evidence or a person
           rejected   decided NOT the same thing — kept, not deleted: it is the most expensive
                      verdict this graph holds, and `merge_artists.merge_pair` and
                      `merge_duplicate_work_clusters.py` refuse to fold a rejected pair
  (promoted edges do not persist: promoting merges the two nodes, the DETACH DELETE takes the
   edge, and the MergeEvent's evidence cites the edge's rule and score)

ONE EDGE PER UNORDERED PAIR, read undirected. Written with an undirected MERGE so a re-run, or a
rename that reverses the pair's order, finds the same edge. A re-proposal of a pair refreshes an
OPEN edge's score and evidence and never reopens a rejected one.

READERS ARE OPT-IN. The edge means "possibly", and a query that forgets to filter `status`
would read it as identity. Only the files in check_identity_candidates.ALLOWED may name it.

THE SCANS STAY READ-ONLY. Each adapter below reads a scan's existing output file, so no
candidate generator gains graph-write code.

  source             file                                    label           loads
  band-b-held        merge_artists.py band-b --held-out      Artist          every B4 row, open
  artist-image       find_artist_candidates_by_shared_image  Artist          differentNames and
                                                                             nameVariant open;
                                                                             refusals rejected
  spelling-variant   find_spelling_variant_merges --json     ConceptualWork  held buckets open
  title-collisions   rank_title_collisions --pairs-out       ConceptualWork  unvetoed pairs at or
                                                                             above --min-weight

`splink_poster_merge_candidates.csv` has no adapter on purpose: all 23.6k rows are `needsVision`,
which is "not yet looked at", not "close enough to hold".

    python3 identity_candidates.py load --source band-b-held --file artist_band_b_held.csv
    python3 identity_candidates.py load --source artist-image --file artist_image_candidates.csv --apply
    python3 identity_candidates.py list --label Artist --out review.csv
    python3 identity_candidates.py decide --file review.csv            # dry run
    python3 identity_candidates.py decide --file review.csv --apply
"""
import argparse
import csv
import json
import math
import os
import sys
from datetime import datetime, timezone
from itertools import combinations

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase                                              # noqa: E402
from catalogue_matching import resolved_artist_name_cypher                   # noqa: E402

VERSION = "IDENTITY-CANDIDATES-1.0"
STATUSES = {"open", "rejected"}
KEY = {"Artist": "name", "ConceptualWork": "id"}


# ------------------------------------------------------------------------------ graph primitive

def _resolved(label, expr):
    """Where a proposed id lives NOW: a scan's CSV can name a node an earlier merge absorbed."""
    if label == "Artist":
        return resolved_artist_name_cypher(expr)
    return (f"coalesce(head([(mergeEv_:MergeEvent {{mergedFromId: {expr}}})"
            f"-[:MERGED_INTO]->(mergeSurvivor_:ConceptualWork) | mergeSurvivor_.id]), {expr})")


def upsert_query(label):
    """Writes the `write` rows only; `preview_query` gives the tallies for every row."""
    k = KEY[label]
    return f"""
UNWIND $rows AS row
WITH row, {_resolved(label, 'row.a')} AS ka, {_resolved(label, 'row.b')} AS kb
MATCH (x:{label} {{{k}: ka}})
MATCH (y:{label} {{{k}: kb}})
WITH row, x, y WHERE x <> y
MERGE (x)-[p:POSSIBLE_SAME_AS]-(y)
ON CREATE SET p.status = row.status, p.rule = row.rule, p.ruleVersion = row.ruleVersion,
              p.score = row.score, p.scoreKind = row.scoreKind, p.evidence = row.evidence,
              p.heldBecause = row.heldBecause, p.nameA = row.a, p.nameB = row.b,
              p.proposedAt = datetime(),
              p.decidedBy = CASE WHEN row.status = 'rejected' THEN row.decidedBy END,
              p.decidedAt = CASE WHEN row.status = 'rejected' THEN datetime() END,
              p.decisionNote = CASE WHEN row.status = 'rejected' THEN row.heldBecause END
// A re-proposal refreshes an OPEN edge, and a rejection from the scan may close an open one.
// Nothing reopens a rejected edge. `status` is assigned last so the CASEs read the old value.
SET p.lastSeenAt = datetime(),
    p.score = CASE WHEN p.status = 'open' THEN row.score ELSE p.score END,
    p.evidence = CASE WHEN p.status = 'open' THEN row.evidence ELSE p.evidence END,
    p.decidedBy = CASE WHEN p.status = 'open' AND row.status = 'rejected'
                       THEN row.decidedBy ELSE p.decidedBy END,
    p.decidedAt = CASE WHEN p.status = 'open' AND row.status = 'rejected'
                       THEN datetime() ELSE p.decidedAt END,
    p.decisionNote = CASE WHEN p.status = 'open' AND row.status = 'rejected'
                          THEN row.heldBecause ELSE p.decisionNote END,
    p.status = CASE WHEN row.status = 'rejected' THEN 'rejected' ELSE p.status END
RETURN count(p) AS n
"""


# Dry run: the same resolution, no MERGE, and what the MERGE would find.
def preview_query(label):
    k = KEY[label]
    return f"""
UNWIND $rows AS row
WITH row, {_resolved(label, 'row.a')} AS ka, {_resolved(label, 'row.b')} AS kb
OPTIONAL MATCH (x:{label} {{{k}: ka}})
OPTIONAL MATCH (y:{label} {{{k}: kb}})
OPTIONAL MATCH (x)-[p:POSSIBLE_SAME_AS]-(y)
WITH row, x, y, p,
     CASE WHEN x IS NULL OR y IS NULL THEN 'missingNode'
          WHEN x = y THEN 'alreadyMerged' ELSE 'write' END AS outcome
// Writes are counted per distinct node pair, not per row: two rows can name one pair once an
// absorbed name resolves to its survivor (measured 2026-09-22: 134 rows became 132 edges).
WITH outcome, p IS NULL AS created,
     CASE WHEN outcome = 'write'
          THEN CASE WHEN elementId(x) < elementId(y) THEN [elementId(x), elementId(y)]
                    ELSE [elementId(y), elementId(x)] END
          ELSE [row.a, row.b] END AS pair
RETURN outcome, created, count(DISTINCT pair) AS n
"""


def rejected_pairs(session, label):
    """Every pair decided NOT the same, as frozensets of keys. For scans that want to skip them."""
    k = KEY[label]
    q = (f"MATCH (x:{label})-[p:POSSIBLE_SAME_AS {{status: 'rejected'}}]-(y:{label}) "
         f"WHERE elementId(x) < elementId(y) RETURN x.{k} AS a, y.{k} AS b")
    return {frozenset((r["a"], r["b"])) for r in session.run(q)}


def _row(a, b, status, rule, rule_version, score, score_kind, evidence, held, decided_by=None):
    a, b = str(a).strip(), str(b).strip()
    if not a or not b or a == b:
        return None
    if isinstance(score, float) and math.isnan(score):
        score = None
    return {"a": min(a, b), "b": max(a, b), "status": status, "rule": rule,
            "ruleVersion": rule_version, "score": score, "scoreKind": score_kind,
            "evidence": evidence, "heldBecause": held, "decidedBy": decided_by}


# ------------------------------------------------------------------------------------ adapters

def _num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def adapt_band_b_held(path, _args):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if not str(r.get("tier", "")).startswith("B4"):
                continue
            dino = _num(r.get("dino_max"))
            ev = (f"splink band B, name level {r.get('level') or r.get('name_level')}; "
                  f"match weight {float(r['match_weight']):.2f}"
                  + (f"; DINOv2 max {dino:.3f}" if dino is not None else "; no image coverage")
                  + f"; born {r.get('born_l') or '?'} / {r.get('born_r') or '?'}")
            rows.append(_row(r["name_l"], r["name_r"], "open", "splinkBandB",
                             "ARTIST-MERGE-3.x band-b", float(r["match_weight"]),
                             "splinkMatchWeight", ev, r["tier"].split("—", 1)[-1].strip()))
    return "Artist", rows


# Routes of find_artist_candidates_by_shared_image.py. The first two are "maybe the same person,
# look"; every other route is the scan saying why the shared image does NOT make them one.
IMAGE_OPEN = {"differentNames", "nameVariant"}
IMAGE_REJECT_WHY = {
    "collaboration": "a collaboration node sharing images with one of its members",
    "collective": "a collective or workshop node, not one person",
    "afterAttribution": "an 'after' attribution: a copy after the artist, not by them",
    "nonArtistNode": "a node that is not an artist (publisher, placeholder, sale note)",
    "ulanConflict": "the two nodes carry different ULAN ids",
}


def adapt_artist_image(path, _args):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            route, refused = r["route"], (r.get("refusedBecause") or "").strip()
            ev = (f"{r['sharedImages']} shared image(s), max cosine {r['maxCos']}, "
                  f"median {r['medianCos']}; name relation {r.get('nameRelation') or '-'}; "
                  f"born {r.get('bornA') or '?'} / {r.get('bornB') or '?'}")
            if route in IMAGE_OPEN and not refused:
                row = _row(r["artistA"], r["artistB"], "open", "sharedImage",
                           "ARTIST-IMAGE-CANDIDATES-1.0", _num(r["maxCos"]), "dinov2Cosine",
                           ev, f"route {route}: shared images, names not an exact variant")
            elif refused or route == "refused":
                row = _row(r["artistA"], r["artistB"], "rejected", "sharedImage",
                           "ARTIST-IMAGE-CANDIDATES-1.0", _num(r["maxCos"]), "dinov2Cosine",
                           ev, refused or "refused by review", decided_by="human")
            elif route in IMAGE_REJECT_WHY:
                row = _row(r["artistA"], r["artistB"], "rejected", "sharedImage",
                           "ARTIST-IMAGE-CANDIDATES-1.0", _num(r["maxCos"]), "dinov2Cosine",
                           ev, IMAGE_REJECT_WHY[route], decided_by="rule")
            else:
                continue
            rows.append(row)
    return "Artist", rows


# Buckets of find_spelling_variant_merges.py. `proposed` goes to the merger, not here; the three
# conflict buckets are evidence AGAINST, which the scan already acted on, so they are not loaded.
SPELLING_HELD = {"pluralHeld": "the rewrite changes a plural, which can be a different work",
                 "typo1Held": "a one-character edit, outside the closed rewrite set",
                 "notDistinctive": "the image does not separate this cluster from its rivals",
                 "noImage": "no image to corroborate"}


def adapt_spelling_variant(path, _args):
    buckets = json.load(open(path, encoding="utf-8"))
    rows = []
    for bucket, held in SPELLING_HELD.items():
        for c in buckets.get(bucket, []):
            sim = (c.get("evidence") or {}).get("minPairSim")
            for (ia, ta), (ib, tb) in combinations(zip(c["workIds"], c["titles"]), 2):
                rows.append(_row(ia, ib, "open", "spellingVariant", "SPELLING-VARIANT-1.0",
                                 _num(sim), "dinov2MinPairCosine",
                                 f"{c['artist']} ({c['year']}), class {c['class']}: "
                                 f"{ta!r} ~ {tb!r}", held))
    return "ConceptualWork", rows


def adapt_title_collisions(path, args):
    if args.min_weight is None:
        sys.exit("title-collisions needs --min-weight: the file is every scored pair, and only "
                 "the caller knows where 'held' starts")
    rows = []
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            w = _num(r["matchWeight"])
            vetoed = (r.get("pairCatalogue") == "conflict" or r.get("techFamilyVeto") == "1"
                      or r.get("yearConflict") == "1")
            if w is None or w < args.min_weight or vetoed:
                continue
            rows.append(_row(r["workA"], r["workB"], "open", "titleCollision",
                             "COLLISION-RANK-1.x", w, "splinkMatchWeight",
                             f"{r['artist']}: {r['titleA']!r} ~ {r['titleB']!r}; {r['note']}",
                             f"title collision at weight {w:.1f}, below the merge band or "
                             f"flagged {r.get('flags') or 'none'}"))
    return "ConceptualWork", rows


ADAPTERS = {"band-b-held": adapt_band_b_held, "artist-image": adapt_artist_image,
            "spelling-variant": adapt_spelling_variant, "title-collisions": adapt_title_collisions}


# ----------------------------------------------------------------------------------- commands

def connect():
    return GraphDatabase.driver(os.environ["NEO4J_URI"],
                                auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))


def session(drv):
    return drv.session(database=os.environ.get("NEO4J_DATABASE") or "neo4j")


def dedupe(rows):
    """One row per pair; a rejection beats an open proposal from the same file."""
    best = {}
    for r in filter(None, rows):
        key = (r["a"], r["b"])
        if key not in best or (r["status"] == "rejected" and best[key]["status"] == "open"):
            best[key] = r
    return list(best.values())


def cmd_load(a):
    label, rows = ADAPTERS[a.source](a.file, a)
    rows = dedupe(rows)
    by_status = {s: sum(r["status"] == s for r in rows) for s in STATUSES}
    print(f"{a.source}: {len(rows)} pair(s) from {os.path.basename(a.file)} "
          f"({by_status['open']} open, {by_status['rejected']} rejected) on {label}")
    drv = connect()
    with session(drv) as s:
        res = s.run(preview_query(label), rows=rows).data()
        written = s.run(upsert_query(label), rows=rows).single()["n"] if a.apply else None
    drv.close()
    tally = {}
    for r in res:
        k = r["outcome"] if r["outcome"] != "write" else ("new" if r["created"] else "existing")
        tally[k] = tally.get(k, 0) + r["n"]
    verb = "written" if a.apply else "would be written"
    print(f"   new edges {verb}: {tally.get('new', 0)}   existing edges refreshed: "
          f"{tally.get('existing', 0)}")
    print(f"   skipped — both sides are already one node: {tally.get('alreadyMerged', 0)}   "
          f"a side no longer exists: {tally.get('missingNode', 0)}")
    if a.apply:
        print(f"   edges touched: {written}")
    else:
        print("\n(dry run — nothing written)")


LIST = """
MATCH (x:{label})-[p:POSSIBLE_SAME_AS]-(y:{label})
WHERE elementId(x) < elementId(y) AND ($status IS NULL OR p.status = $status)
RETURN x.{k} AS a, y.{k} AS b, p.status AS status, p.rule AS rule, p.score AS score,
       p.scoreKind AS scoreKind, p.heldBecause AS heldBecause, p.evidence AS evidence
ORDER BY p.rule, p.score DESC
"""


def cmd_list(a):
    drv = connect()
    with session(drv) as s:
        rows = s.run(LIST.format(label=a.label, k=KEY[a.label]), status=a.status).data()
    drv.close()
    cols = ["label", "a", "b", "status", "rule", "score", "scoreKind", "heldBecause", "evidence",
            "decision", "survivor", "note"]
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({**r, "label": a.label, "decision": "", "survivor": "", "note": ""})
    print(f"{len(rows)} {a.status or 'any-status'} {a.label} pair(s) -> {a.out}\n"
          f"fill `decision` (promote | reject), `note`, and for a promoted pair optionally "
          f"`survivor` (a | b), then run `decide`")


EDGE = """
MATCH (x:{label} {{{k}: $a}})-[p:POSSIBLE_SAME_AS]-(y:{label} {{{k}: $b}})
RETURN p.status AS status, p.rule AS rule, p.score AS score, p.scoreKind AS scoreKind
"""
REJECT = """
MATCH (x:{label} {{{k}: $a}})-[p:POSSIBLE_SAME_AS {{status: 'open'}}]-(y:{label} {{{k}: $b}})
SET p.status = 'rejected', p.decidedBy = 'human', p.decidedAt = datetime(), p.decisionNote = $note
RETURN count(p) AS n
"""


def _promote(s, label, a, b, survivor, edge, note):
    ev = (f"promoted from POSSIBLE_SAME_AS ({edge['rule']}, {edge['scoreKind']} "
          f"{edge['score']}): {note}")
    if label == "Artist":
        from merge_artists import merge_pair
        from find_artist_merge_candidates import pick_canonical
        if survivor in ("a", "b"):
            canon, dup = (a, b) if survivor == "a" else (b, a)
        else:
            info = {r["name"]: {"ulan": r["ulan"], "wikidata": r["wd"], "works": r["works"]}
                    for r in s.run("MATCH (x:Artist) WHERE x.name IN [$a, $b] "
                                   "OPTIONAL MATCH (x)-[:CREATED]->(w:ConceptualWork) "
                                   "RETURN x.name AS name, x.ulanUrl AS ulan, "
                                   "x.wikidataUrl AS wd, count(DISTINCT w) AS works", a=a, b=b)}
            canon, dup = pick_canonical(info, a, b)
        got = merge_pair(s, canon, dup, provenance={
            "rule": "humanPairs", "ruleVersion": VERSION, "decidedBy": "human", "evidence": ev})
        return got is not None
    import merge_duplicate_work_clusters as mw
    surv, dup = (b, a) if survivor == "b" else (a, b)
    # The work merger's own order: stamp each impression with the title its record gave it
    # (ADR-0017 Decision 4) before the fold rewrites which work it hangs from.
    members = s.run("MATCH (w:ConceptualWork) WHERE w.id IN [$a, $b] "
                    "RETURN w.id AS workId, w.name AS name", a=surv, b=dup).data()
    s.run(mw.STAMP_SOURCE_TITLE_QUERY, rows=members).consume()
    counters = s.run(mw.MERGE_QUERY, survivorId=surv, dupId=dup, rule="humanTriage",
                     ruleVersion=mw.MERGE_RULES["humanTriage"], decidedBy="human",
                     evidence=ev, confidence=None).consume().counters
    return bool(counters.nodes_deleted)


def cmd_decide(a):
    with open(a.file, encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if (r.get("decision") or "").strip()]
    bad = [r for r in rows if r["decision"].strip() not in ("promote", "reject")
           or not (r.get("note") or "").strip()]
    if bad:
        sys.exit(f"{len(bad)} row(s) need decision in (promote, reject) AND a note, e.g. {bad[0]}")
    drv = connect()
    done = {"promote": 0, "reject": 0}
    with session(drv) as s:
        for r in rows:
            label, d = r["label"], r["decision"].strip()
            q = EDGE.format(label=label, k=KEY[label])
            edge = s.run(q, a=r["a"], b=r["b"]).single()
            if edge is None or edge["status"] != "open":
                print(f"   skip {r['a']!r} ~ {r['b']!r}: "
                      f"{'no edge' if edge is None else 'edge is ' + edge['status']}")
                continue
            if not a.apply:
                print(f"   would {d} {r['a']!r} ~ {r['b']!r}")
                continue
            if d == "reject":
                done[d] += s.run(REJECT.format(label=label, k=KEY[label]),
                                 a=r["a"], b=r["b"], note=r["note"]).single()["n"]
            elif _promote(s, label, r["a"], r["b"], (r.get("survivor") or "").strip(),
                          dict(edge), r["note"]):
                done[d] += 1
    drv.close()
    if a.apply:
        print(f"\n{done['promote']} promoted (merged), {done['reject']} rejected")
    else:
        print("\n(dry run — nothing written)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("load")
    p.add_argument("--source", required=True, choices=sorted(ADAPTERS))
    p.add_argument("--file", required=True)
    p.add_argument("--min-weight", type=float, help="title-collisions only")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_load)
    p = sub.add_parser("list")
    p.add_argument("--label", required=True, choices=sorted(KEY))
    p.add_argument("--status", default="open", help="open | rejected | '' for all")
    p.add_argument("--out", default=f"possible_same_as_review_"
                                    f"{datetime.now(timezone.utc):%Y-%m-%d}.csv")
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("decide")
    p.add_argument("--file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_decide)
    a = ap.parse_args()
    if getattr(a, "status", None) == "":
        a.status = None
    a.fn(a)


if __name__ == "__main__":
    main()
