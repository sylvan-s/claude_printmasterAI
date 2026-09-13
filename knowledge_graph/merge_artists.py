"""
PrintMasterAI — Artist-node merging: the primitive, and the two passes that drive it.
Version: ARTIST-MERGE-3.0

One file, three sections, two subcommands. Folded together from `artist_merge.py`,
`canonicalise_ulan_and_merge.py` and `merge_artist_band_b.py`: only ever two callers shared
the primitive, and keeping them apart bought a backwards import (a ULAN migration reaching
into a band-B module) rather than isolation.

    python3 merge_artists.py ulan-canon --dry-run
    python3 merge_artists.py band-b --triage ... --records ... --dry-run

=============================================================================
SECTION 1 — THE MERGE PRIMITIVE
=============================================================================

There must be exactly one of these, because the failure it guards against is invisible: a
merge that forgets a relationship type destroys those edges on the DETACH DELETE and reports
success.

WHY NOT `find_artist_merge_candidates.MERGE_QUERY`. That one moves CREATED, FROM_REGION and
ATTRIBUTED_TO. Artist nodes carry five types — MADE_MATRIX (1,050 edges) and CATALOGUES (6)
as well — so it silently drops two. Giorgio de Chirico, in scope for the 2026-09-12 ULAN
pass, holds a CATALOGUES edge. All five are transferred here, and `assert_transferable`
refuses to delete a node carrying a sixth rather than trusting the list to stay current.

That guard runs in Python because THIS INSTANCE HAS NO APOC: `apoc.util.validate`, the
obvious way to assert it inside the write query, fails with Unknown function on the Oracle
Cloud self-hosted CE.

=============================================================================
SECTION 2 — `ulan-canon`: give Artist.ulanUrl one shape, merge what two shapes hid
=============================================================================

Getty serves the same authority record at two addresses — `/ulan/<id>` is the RDF resource,
`/page/ulan/<id>` is the HTML page about it — and two resolvers wrote one each. Because
`ulanUrl` is an equality key, no exact match could see across the forms, and it hid twelve
duplicate Artist pairs (Renoir, Toulouse-Lautrec, Ed Ruscha among them) from every prior
dedup pass. `ulan_url.py` now fixes the shape at every write site; this repairs the graph.

THE PHASE ORDER IS FORCED BY A CONSTRAINT AND IS NOT THE OBVIOUS ONE. `artist_ulanurl` is a
UNIQUENESS constraint, so rewriting a page-form URL onto an id another node already holds is
REJECTED — and those rejections are exactly the twelve pairs this is meant to fix. Hence:

    phase 1  canonicalise the page-form nodes that collide with nothing
    phase 2  merge the colliding pairs, which deletes one side and frees the id
    phase 3  canonicalise the survivors, now unopposed

Phase 1 alone is safe and leaves the graph consistent. This pass is idempotent: it has
already run (2026-09-12) and now reports nothing to do.

=============================================================================
SECTION 3 — `band-b`: execute the safe part of Splink band B, and say what it refused
=============================================================================

Band B is "name and dates agree". It is NOT one thing, and merging it as one block would be
the mistake this section exists to avoid. It splits by WHAT KIND of name agreement is on
offer, because only some kinds are safe without a human:

  B1 EXACT UNDER NORMALISATION   norm equal, or the same bag of words in a different order.
     Accents, honorifics, hyphenation, punctuation, "Surname, Forename" inversion. This is
     exact matching under a normalisation, not fuzzy matching — the same discipline
     `catalogue_matching.py` uses, and the same one the `normalized_equal` and `honorific`
     rules in find_artist_merge_candidates.py already merge on. Auto-merged.

  B2 EXACT, BUT THE BIRTH YEARS DISAGREE   merged, with the disagreement recorded rather
     than resolved. These are one person carrying one bad year — Toulouse-Lautrec as both
     1854 and 1864, Buhot as both 1847 and 1860 — so the names are not in question and the
     dates are. Both values are kept: the survivor's stays live, the other goes to
     dateBorn_supersededValue with dateBorn_disputed raised for reconcile_artist_dates.py.

  B3 FUZZY, CORROBORATED BY DINOv2   token containment, Jaro-Winkler, edit distance. The
     name alone cannot carry these — this is exactly the band holding the Calder trap
     (Alexander Calder against his own grandfather Alexander Milne Calder, a real different
     person whose name properly contains the other's). Merged only when DINOv2 cross-
     similarity clears the thresholds measured in find_artist_merge_candidates.py: 0.90 for
     token containment, 0.80 otherwise.

  B3b TYPO, NAME EVIDENCE ALONE   only under --relax-typo-gate. See TYPO_LEVELS.

  B4 EVERYTHING ELSE   held. A thin sample scoring low means "not enough pictures", not
     "different people", so these go to review, never to rejection.

THE LEVEL IS RECOMPUTED HERE, NOT READ FROM THE TRIAGE. `triage_artist_candidates.py`
reverse-engineers the name level from its Bayes factor, and in the current fit three levels
sit within 0.4 log2 of each other (+14.27 same token bag, +14.34 token containment, +14.68
Jaro-Winkler >=0.94), so that mapping conflates them. B3's threshold depends on telling
token containment from Jaro-Winkler, so the predicates are evaluated directly against the
record fields instead.

RE-RUN TO CONVERGENCE. Duplicates arrive in clusters, one pass does not finish them, and the
reason is in `merge_pair`'s docstring. A run reporting skipped-as-cluster is unfinished, not
failed.
"""
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone

import jellyfish
import pandas as pd
from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase                                          # noqa: E402
from ulan_url import CANON_PREFIX                                        # noqa: E402
from find_artist_merge_candidates import pick_canonical, preferred_name  # noqa: E402


def connect():
    uri, user, pw = (os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"),
                     os.getenv("NEO4J_PASSWORD"))
    if not all([uri, user, pw]):
        sys.exit("NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD must be set")
    return GraphDatabase.driver(uri, auth=(user, pw))


def session(drv):
    return drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j")


def stamp(now):
    """Second-resolution, never date-only. A date-only snapshot name silently OVERWROTE the
    earlier band-B snapshot when a second pass ran the same day, destroying the record of the
    state before the first 199 merges. The house convention
    (picasso_merge_backup_2026-09-11.json) carries the same latent bug."""
    return now[:19].replace(":", "")


# ============================================================ section 1: the merge primitive

# Every relationship type an Artist carries. ATTRIBUTED_TO and CATALOGUES are INCOMING.
HANDLED_TYPES = {"CREATED", "MADE_MATRIX", "FROM_REGION", "ATTRIBUTED_TO", "CATALOGUES"}

MERGE_PAIR = """
MATCH (canon:Artist {name: $canonName})
MATCH (dup:Artist   {name: $dupName})
WITH canon, dup,
     coalesce(canon.alternateNames, []) + coalesce(dup.alternateNames, [])
     + [dup.name, canon.name] AS combined
UNWIND combined AS x
WITH canon, dup, collect(DISTINCT x) AS deduped
SET canon.alternateNames = deduped
WITH canon, dup
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:CREATED]->(n)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:CREATED]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:MADE_MATRIX]->(n)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:MADE_MATRIX]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:FROM_REGION]->(n)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:FROM_REGION]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (n)-[:ATTRIBUTED_TO]->(dup)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (x)-[:ATTRIBUTED_TO]->(canon))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (n)-[:CATALOGUES]->(dup)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (x)-[:CATALOGUES]->(canon))
}
WITH canon, dup
// Inherit any identity field the survivor lacks, so a merge never loses an identifier.
SET canon.dateBorn_year   = coalesce(canon.dateBorn_year,   dup.dateBorn_year),
    canon.dateDied_year   = coalesce(canon.dateDied_year,   dup.dateDied_year),
    canon.nationality     = coalesce(canon.nationality,     dup.nationality),
    canon.birthPlace      = coalesce(canon.birthPlace,      dup.birthPlace),
    canon.deathPlace      = coalesce(canon.deathPlace,      dup.deathPlace),
    canon.ulanUrl         = coalesce(canon.ulanUrl,         dup.ulanUrl),
    canon.wikidataUrl     = coalesce(canon.wikidataUrl,     dup.wikidataUrl)
WITH canon, dup
DETACH DELETE dup
RETURN canon.name AS survivor
"""

RENAME = "MATCH (a:Artist {name: $from}) SET a.name = $to RETURN a.name AS name"

# Where the two sides disagree on a year, both values are KEPT: the survivor's stays live,
# the other goes to *_supersededValue, and *_disputed is raised so reconcile_artist_dates.py
# can settle it. Picking one silently would destroy the evidence that there was a question.
FLAG_DATE_DISPUTE = """
MATCH (a:Artist {name: $name})
SET a.dateBorn_supersededValue = $born,
    a.dateBorn_disputed = true,
    a.dateBorn_disputeNote = $note
RETURN a.name AS name
"""

REL_TYPES = "MATCH (dup:Artist {name: $dupName})-[r]-() RETURN DISTINCT type(r) AS t"


def assert_transferable(sess, dup_name):
    """Refuse to delete a node carrying a relationship type this merge does not transfer."""
    types = {r["t"] for r in sess.run(REL_TYPES, dupName=dup_name)}
    unhandled = types - HANDLED_TYPES
    if unhandled:
        raise RuntimeError(
            f"'{dup_name}' carries relationship types this merge does not transfer: "
            f"{sorted(unhandled)}. Extend MERGE_PAIR before rerunning.")


def merge_pair(sess, canon_name, dup_name, keep_name=None):
    """Fold `dup_name` into `canon_name`, optionally renaming the survivor afterwards.
    Returns the survivor's name, or **None if the merge did not happen**.

    THE None RETURN IS THE POINT. MERGE_PAIR opens with two MATCHes, and a MATCH that finds
    nothing yields no rows and no error — so a pair naming a node an earlier merge already
    absorbed, or renamed, silently does nothing and still looks like a success. That is how a
    208-pair run removed 195 nodes: duplicates arrive in CLUSTERS (Mr Doodle / Doodle /
    Doodle (Sam Cox) / Mr Doodle (Sam Cox) is one node in four pairs), and once the first
    pair consumes a side the rest of the cluster cannot match. Callers must count the Nones
    and re-run to convergence; they are unfinished work, not failures.

    The rename is a separate statement and must follow the delete, or it collides with the
    `artist_name` uniqueness constraint when the wanted name is the one being absorbed."""
    assert_transferable(sess, dup_name)
    if sess.run(MERGE_PAIR, canonName=canon_name, dupName=dup_name).single() is None:
        return None
    if keep_name and keep_name != canon_name:
        sess.run(RENAME, **{"from": canon_name, "to": keep_name}).consume()
    return keep_name or canon_name


# ================================================================== section 2: `ulan-canon`

SNAPSHOT = """
MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL
RETURN elementId(a) AS id, a.name AS name, a.ulanUrl AS ulanUrl,
       a.wikidataUrl AS wikidataUrl, a.identityResolvedBy AS resolvedBy
"""

DUP_PAIRS = """
MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL
WITH a, reverse(split(reverse(a.ulanUrl), '/')[0]) AS uid
WITH uid, collect(a) AS nodes WHERE size(nodes) > 1
UNWIND nodes AS a
OPTIONAL MATCH (a)-[:CREATED]->(cw:ConceptualWork)
WITH uid, a, count(DISTINCT cw) AS works
RETURN uid, collect({name: a.name, works: works,
                     ulan: a.ulanUrl, wikidata: a.wikidataUrl,
                     pageForm: a.ulanUrl CONTAINS '/page/'}) AS side
ORDER BY uid
"""

SAFE_TO_CANON = """
MATCH (a:Artist) WHERE a.ulanUrl CONTAINS '/page/ulan/'
WITH a, reverse(split(reverse(a.ulanUrl), '/')[0]) AS uid
WHERE NOT EXISTS {
    MATCH (b:Artist) WHERE b.ulanUrl = $prefix + uid AND elementId(b) <> elementId(a)
}
RETURN elementId(a) AS id, a.name AS name, a.ulanUrl AS old, $prefix + uid AS new
"""

APPLY_CANON = """
UNWIND $rows AS row
MATCH (a:Artist) WHERE elementId(a) = row.id
SET a.ulanUrl = row.new, a.ulanUrlCanonicalisedAt = $now
RETURN count(*) AS n
"""


def plan_ulan_merges(sess):
    """Resolve each colliding id to (canonical node, node to delete, name to keep)."""
    out = []
    for r in sess.run(DUP_PAIRS):
        sides = r["side"]
        if len(sides) != 2:
            print(f"  !! ulan {r['uid']} has {len(sides)} nodes, not 2 — skipped, "
                  f"needs manual review: {[s['name'] for s in sides]}")
            continue
        a, b = sides[0]["name"], sides[1]["name"]
        info = {s["name"]: {"ulan": s["ulan"], "wikidata": s["wikidata"],
                            "works": s["works"]} for s in sides}
        canon, dup = pick_canonical(info, a, b)
        out.append({"uid": r["uid"], "canon": canon, "dup": dup,
                    "keepName": preferred_name(info, a, b),
                    "works": {a: info[a]["works"], b: info[b]["works"]}})
    return out


def cmd_ulan_canon(a):
    phases = set(a.phase or [1, 2, 3])
    now = datetime.now(timezone.utc).isoformat()
    drv = connect()
    with session(drv) as s:
        snap = [dict(r) for r in s.run(SNAPSHOT)]
        merges = plan_ulan_merges(s)
        safe = [dict(r) for r in s.run(SAFE_TO_CANON, prefix=CANON_PREFIX)]

        if a.execute:
            path = os.path.join(a.snapshot_dir, f"ulan_canon_presnapshot_{stamp(now)}.json")
            with open(path, "w") as fh:
                json.dump({"takenAt": now, "artistsWithUlan": snap,
                           "plannedMerges": merges}, fh, indent=2)
            print(f"pre-snapshot: {len(snap):,} ULAN-bearing artists -> {path}\n")

        print(f"PHASE 1  canonicalise {len(safe):,} non-colliding page-form URLs")
        if 1 in phases and a.execute:
            print(f"         {s.run(APPLY_CANON, rows=safe, now=now).single()['n']:,} updated")
        elif 1 in phases:
            for r in safe[:3]:
                print(f"         e.g. {r['name']}: {r['old']} -> {r['new']}")
            print(f"         ... and {max(len(safe) - 3, 0):,} more")

        print(f"\nPHASE 2  merge {len(merges)} duplicate pairs")
        for m in merges:
            wc, wd = m["works"][m["canon"]], m["works"][m["dup"]]
            rn = "" if m["keepName"] == m["canon"] else f"  then rename -> '{m['keepName']}'"
            print(f"         ulan {m['uid']}: keep '{m['canon']}' (w{wc})"
                  f"  <- absorb '{m['dup']}' (w{wd}){rn}")
            if 2 in phases and a.execute:
                merge_pair(s, m["canon"], m["dup"], m["keepName"])

        if 3 in phases:
            rest = ([dict(r) for r in s.run(SAFE_TO_CANON, prefix=CANON_PREFIX)]
                    if a.execute else [])
            print("\nPHASE 3  canonicalise the merge survivors still on the page form"
                  + (f": {len(rest)}" if a.execute else
                     " (not enumerable until phases 1-2 have run)"))
            if a.execute:
                n = s.run(APPLY_CANON, rows=rest, now=now).single()["n"] if rest else 0
                print(f"         {n} updated")

        if a.execute:
            left = s.run("MATCH (a:Artist) WHERE a.ulanUrl CONTAINS '/page/' "
                         "RETURN count(*) AS n").single()["n"]
            dups = s.run("MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL "
                         "WITH reverse(split(reverse(a.ulanUrl),'/')[0]) AS uid, count(*) AS n "
                         "WHERE n > 1 RETURN count(*) AS n").single()["n"]
            tot = s.run("MATCH (a:Artist) RETURN count(*) AS n").single()["n"]
            print(f"\nVERIFY   page-form URLs remaining: {left}   "
                  f"duplicate ULAN ids remaining: {dups}   Artist nodes: {tot:,}")
    drv.close()


# ====================================================================== section 3: `band-b`

# A lot-grouping fragment the Roseberys/Forum parser left on the front of a name. NOT a
# typo and not mergeable with its twin: "Grouped line 30 Giacomo Manzu" and "grouped line
# 30Giacomo Manzu" are two fragments of ONE catalogue line, and there is a real Giacomo Manzu
# node holding a ULAN and 12 works. Merging the fragments into each other would produce a
# tidier junk node and hide that the family of six belongs somewhere else entirely.
LOT_GROUPING = re.compile(r"^\s*grouped\s+(?:with\s+)?line\b", re.I)

DINO_FLOOR = 0.80        # measured in find_artist_merge_candidates.py
DINO_FLOOR_SUBSET = 0.90 # its RULE_THRESHOLDS entry for token_subset
MAX_YEAR_GAP = 2         # source birth years disagree by a year or two constantly

EXACT = {"exact_norm", "same_token_bag"}
# One or two characters different over a long name — NOT token containment, which is the
# class the Calder trap belongs to and which keeps its DINOv2 gate unconditionally.
TYPO_LEVELS = {"edit2", "jw094"}


def name_level(a, b):
    """The model's name comparison level, evaluated directly. Order matters: the first
    predicate that holds is the level, exactly as in the Splink settings."""
    if a["norm"] == b["norm"]:
        return "exact_norm"
    if a["token_key"] == b["token_key"]:
        return "same_token_bag"
    ta, tb = set(a["tokens"]), set(b["tokens"])
    if ta <= tb or tb <= ta:
        return "token_subset"
    jw = jellyfish.jaro_winkler_similarity(a["norm"], b["norm"])
    if jw >= 0.94:
        return "jw094"
    if len(a["norm"]) >= 8 and jellyfish.damerau_levenshtein_distance(a["norm"], b["norm"]) <= 2:
        return "edit2"
    if jw >= 0.88:
        return "jw088"
    return "none"


def classify(row, rec, relax_typos=False):
    a, b = rec[row.unique_id_l], rec[row.unique_id_r]
    lvl = name_level(a, b)
    conflict = (pd.notna(row.born_l) and pd.notna(row.born_r)
                and abs(row.born_l - row.born_r) > MAX_YEAR_GAP)
    if lvl in EXACT:
        return ("B2 exact, birth years disagree" if conflict
                else "B1 exact under normalisation"), lvl
    if conflict:
        return "B4 held — fuzzy name and the dates disagree", lvl
    died_conflict = (pd.notna(row.died_l) and pd.notna(row.died_r)
                     and abs(row.died_l - row.died_r) > MAX_YEAR_GAP)
    if relax_typos and lvl in TYPO_LEVELS and not died_conflict:
        # THE DINOv2 GATE MEASURES SAMPLE SIZE HERE, NOT IDENTITY. Across the pairs it held
        # back, median cross-similarity rose monotonically with how many images the thinner
        # side had — 0.48 at 0-2 images, 0.72 at 3-5, 0.78 at 6-15 — and the duplicate side of
        # a typo almost always carries one or two works. The 0.80 floor was calibrated on
        # token containment, where the Calder trap lives; a one- or two-character difference
        # over a long name with the birth year AND death year agreeing is a different risk.
        # Elisabeth/Elizabeth Frink scored 0.17 and is one person. Both years must agree
        # where both are present — the death year is the independent second constraint that
        # makes the name evidence safe to act on alone.
        if LOT_GROUPING.search(str(a["name"])) or LOT_GROUPING.search(str(b["name"])):
            return "B4 held — lot-grouping parser artifact, belongs elsewhere", lvl
        return "B3b typo, name evidence alone", lvl
    if pd.isna(row.dino_max):
        return "B4 held — fuzzy name, no image coverage to corroborate", lvl
    floor = DINO_FLOOR_SUBSET if lvl == "token_subset" else DINO_FLOOR
    if row.dino_max >= floor:
        return "B3 fuzzy, DINOv2 corroborated", lvl
    return "B4 held — fuzzy name, DINOv2 below threshold", lvl


def cmd_band_b(a):
    d = pd.read_csv(a.triage)
    B = d[d.band.str.startswith("B")].copy()
    rec = {r["unique_id"]: r for _, r in pd.read_parquet(a.records).iterrows()}

    tiers, lvls = zip(*[classify(r, rec, a.relax_typo_gate) for _, r in B.iterrows()])
    B["tier"], B["level"] = tiers, lvls
    B = B.sort_values(["tier", "match_weight"], ascending=[True, False])

    print(f"band B: {len(B)} pairs\n")
    print(B.groupby("tier").agg(pairs=("match_weight", "size"),
                                median_weight=("match_weight", "median"),
                                median_dino=("dino_max", "median"))
          .to_string(float_format=lambda x: f"{x:.2f}"))

    todo = B[B.tier.str.startswith(("B1", "B2", "B3"))]   # B3b included by prefix
    print(f"\nwill merge {len(todo)}, hold {len(B) - len(todo)}")

    now = datetime.now(timezone.utc).isoformat()
    drv = connect()
    done, failed, skipped = [], [], []
    with session(drv) as s:
        if a.execute:
            snap = [dict(r) for r in s.run(
                "MATCH (a:Artist) RETURN a.name AS name, a.ulanUrl AS ulan, "
                "a.dateBorn_year AS born, a.dateDied_year AS died, "
                "a.alternateNames AS alts, size([(a)--() | 1]) AS degree")]
            path = os.path.join(a.snapshot_dir, f"band_b_presnapshot_{stamp(now)}.json")
            with open(path, "w") as fh:
                json.dump({"takenAt": now, "artists": snap,
                           "planned": todo.drop(columns=["dino_mean"], errors="ignore")
                                          .to_dict("records")}, fh, indent=2, default=str)
            print(f"pre-snapshot: {len(snap):,} artists -> {path}\n")

        for _, r in todo.iterrows():
            info = {r.name_l: {"ulan": r.ulan_id_l if pd.notna(r.ulan_id_l) else None,
                               "wikidata": None, "works": r.works_l},
                    r.name_r: {"ulan": r.ulan_id_r if pd.notna(r.ulan_id_r) else None,
                               "wikidata": None, "works": r.works_r}}
            canon, dup = pick_canonical(info, r.name_l, r.name_r)
            keep = preferred_name(info, r.name_l, r.name_r)
            line = (f"  [{r.tier[:2]}] keep {canon!r} (w{info[canon]['works']}) "
                    f"<- {dup!r} (w{info[dup]['works']})"
                    + (f"  rename -> {keep!r}" if keep != canon else ""))
            if not a.execute:
                print(line)
                continue
            try:
                if merge_pair(s, canon, dup, keep) is None:
                    # One side was consumed by an earlier pair in this same run — a cluster,
                    # not a failure. Re-run the pipeline; it will reappear as a new pair.
                    skipped.append((canon, dup))
                    print(f"  .. skipped (already absorbed this run) {canon!r} <- {dup!r}")
                    continue
                if r.tier.startswith("B2"):
                    loser = r.born_r if canon == r.name_l else r.born_l
                    s.run(FLAG_DATE_DISPUTE, name=keep, born=int(loser),
                          note=f"band-B merge {now[:10]}: absorbed node carried "
                               f"dateBorn_year={int(loser)}").consume()
                done.append((canon, dup, keep, r.tier))
                print(line)
            except Exception as e:                                     # noqa: BLE001
                failed.append((canon, dup, str(e)))
                print(f"  !! FAILED {canon!r} <- {dup!r}: {e}")

        if a.execute:
            tot = s.run("MATCH (a:Artist) RETURN count(*) AS n").single()["n"]
            print(f"\nmerged {len(done)}, skipped-as-cluster {len(skipped)}, "
                  f"failed {len(failed)}, Artist nodes now {tot:,}")
            if skipped:
                print("  re-run the pipeline: clustered duplicates need another pass")
    drv.close()

    held = B[B.tier.str.startswith("B4")]
    held.to_csv(a.held_out, index=False)
    print(f"held for review -> {a.held_out} ({len(held)} pairs)")
    if failed:
        sys.exit(1)


# =============================================================================
# SECTION 4 — `pairs`: fold a named list of duplicates, from a tracked CSV
# =============================================================================
#
# `ulan-canon` finds duplicates through Getty, `band-b` through name similarity plus DINOv2.
# Neither can see a duplicate that has NO ULAN and whose name is misspelt: measured 2026-09-13,
# James Abbott McNeill Whistler is held as FOUR nodes (209, 44, 4 and 4 works) and only one
# carries a ULAN, so no ULAN pass can link them and `James A McNeil Whistler` is a spelling the
# name passes gate on.
#
# What did find them was IMAGE SIMILARITY — a cross-attribution scan over DINOv2 neighbours at
# cosine >= 0.90, where the same Billingsgate etching appeared under three artist names. That is
# a different detector from either existing pass and it needs somewhere to put its answers, so
# this takes a reviewed CSV of `canon,dup,keepName` and folds them through the one primitive.
#
# The list is TRACKED and human-checked. Nothing here infers identity: a person read the
# evidence and wrote the row.


def cmd_pairs(a):
    now = datetime.now(timezone.utc).isoformat()
    with open(a.pairs, encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r.get("canon") and r.get("dup")]
    print(f"{len(rows)} pair(s) from {a.pairs}")
    drv = connect()
    with session(drv) as s:
        names = sorted({n for r in rows for n in (r["canon"], r["dup"])})
        snap = [dict(r) for r in s.run(
            "MATCH (a:Artist) WHERE a.name IN $names "
            "RETURN a.name AS name, properties(a) AS props, "
            "count { (a)-[:CREATED]->(:ConceptualWork) } AS works", names=names)]
        for r in snap:
            print(f"   {r['name'][:46]:46s} works={r['works']:<5d} "
                  f"ulan={'y' if r['props'].get('ulanUrl') else '-'}")
        if not a.execute:
            for r in rows:
                print(f"   would fold {r['dup']!r} -> {r['canon']!r}"
                      + (f", renaming survivor to {r['keepName']!r}" if r.get("keepName") else ""))
            return
        path = os.path.join(a.snapshot_dir, f"artist_pairs_presnapshot_{stamp(now)}.json")
        with open(path, "w") as fh:
            json.dump({"takenAt": now, "artists": snap, "pairs": rows}, fh, indent=2)
        print(f"pre-snapshot -> {path}\n")
        merged = unmatched = 0
        for r in rows:
            got = merge_pair(s, r["canon"], r["dup"], r.get("keepName") or None)
            if got is None:
                unmatched += 1
                print(f"   no-op: {r['dup']!r} -> {r['canon']!r} (a side was already absorbed)")
            else:
                merged += 1
                print(f"   folded {r['dup']!r} -> {got!r}")
        print(f"\n{merged} merged, {unmatched} no-op. "
              f"Duplicates arrive in CLUSTERS — re-run to convergence.")


# =============================================================================== entry point

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name, fn in (("ulan-canon", cmd_ulan_canon), ("band-b", cmd_band_b),
                     ("pairs", cmd_pairs)):
        p = sub.add_parser(name)
        g = p.add_mutually_exclusive_group(required=True)
        g.add_argument("--dry-run", action="store_true")
        g.add_argument("--execute", action="store_true")
        p.add_argument("--snapshot-dir", default=".")
        p.set_defaults(fn=fn)
        if name == "ulan-canon":
            p.add_argument("--phase", type=int, choices=[1, 2, 3], action="append")
        elif name == "pairs":
            p.add_argument("--pairs", required=True,
                           help="CSV with canon,dup[,keepName] — reviewed by a person")
        else:
            p.add_argument("--triage", required=True)
            p.add_argument("--records", required=True)
            p.add_argument("--held-out", default="artist_band_b_held.csv")
            p.add_argument("--relax-typo-gate", action="store_true",
                           help="merge edit-distance/Jaro-Winkler>=0.94 pairs whose birth AND "
                                "death years agree without requiring DINOv2 corroboration; "
                                "token containment keeps its gate regardless")

    a = ap.parse_args()
    a.fn(a)
    if a.dry_run:
        print("\n(dry run — nothing written)")


if __name__ == "__main__":
    main()
