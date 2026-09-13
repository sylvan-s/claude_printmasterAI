"""
PrintMasterAI — artist birth/death backfill from Navigart's `authors_birth_death`
Version: NAVIGART-ARTIST-DATES-0.1

Navigart publishes, on 93% of records, a life-dates string for the artist:

    "1866, Moscou (Russie, Empire Russe) - 1944, Neuilly-sur-Seine (Seine, France)"

94% of the 603 distinct artists in the public-domain tier parse to two clean years. This
backfills them onto existing `Artist` nodes. It writes no new artists, no works, and
nothing about any artwork — it is a property backfill over the identity layer.

## Why this is worth a script

The Navigart load created 519 `Artist` nodes carrying no dates at all, and the graph's
own duplicate-artist work runs on date and nationality tiebreaks (`nationality_dob_disambig`,
`dob_tiebreak_run.log`). `navigart_resolve_artists.py` had to break 19 ambiguous name
groups on a work-count ladder precisely because there was no date to break them on. This
supplies the missing evidence for 464 birth years and 454 death years.

## The conflict rule: never overwrite, always record

12 artists already carry a year that disagrees with the museum's. Both directions are
represented, which is exactly why this must not pick a winner:

    Laboureur        graph 1887-1947   museum 1877-1943   (the museum is right)
    Toulouse-Lautrec graph b.1894      museum b.1864      (the museum is right)
    Guillaumin       graph 1891-1955   museum 1841-1927   (the museum is right)
    Joseph Pennell   graph b.1857      museum b.1860      (the graph is right)
    Jean Moyreau     graph b.1690      museum b.1712      (the graph is right)
    Claude Lorrain   graph b.1600      museum b.1604      (genuinely disputed, c.1600-1605)

So on a conflict this **leaves the existing value alone** and sets
`dateBorn_disputed` / `dateDied_disputed` plus a `_disputeNote` naming both values and the
institution that supplied the other one. `dateDied_disputed`/`dateDied_disputeNote` already
exist on this label; the birth-side pair is added symmetrically, per doc 08 §3.1's rule that
the date shape applies uniformly rather than per-field.

A blank is filled. A disagreement is recorded. Nothing is silently replaced — including the
cases above where the incoming value is almost certainly the better one, because "almost
certainly" is not a standard this graph resolves identity on.

## What else it writes

`nationality` (29% of records carry one) only where the node has none, and birth/death
PLACE strings, which doc 08 §5 explicitly keeps as Artist properties rather than `Region`
nodes. Places are the single most useful disambiguator for the homonym problem this
backfill exists to help with — two engravers called Martin are separated by Lyon vs Anvers
faster than by anything else in the record.

Provenance is stamped `datesResolvedAt` / `datesResolvedBy`, matching the existing
`identityResolvedAt` / `identityResolvedBy` convention on this label.

Usage:
    python knowledge_graph/navigart_backfill_artist_dates.py --dry-run
    python knowledge_graph/navigart_backfill_artist_dates.py --apply
"""

import argparse
import csv
import glob
import json
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_GLOB = os.path.join(os.path.dirname(HERE), "benchmark", "data", "navigart", "*.json")
RESOLUTION_PATH = os.path.join(HERE, "navigart_artist_resolution.json")
CONFLICT_PATH = os.path.join(HERE, "navigart_artist_date_conflicts.csv")

_YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")
# Places contain hyphens ("Neuilly-sur-Seine", "Gif-sur-Yvette"), so the birth/death split
# is on a SPACED hyphen only. Confirmed against every string in the caches.
_SPLIT_RE = re.compile(r"\s+-\s+")


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def parse_life_dates(raw):
    """Returns {born_year, born_place, died_year, died_place, displayLabel}. A half with a
    year but no place ('1936, ?') keeps the year and drops the place; a string with no year
    at all yields nothing, rather than a guess."""
    out = {"bornYear": None, "bornPlace": None, "diedYear": None, "diedPlace": None,
           "displayLabel": (raw or "").strip() or None}
    if not raw:
        return out
    halves = _SPLIT_RE.split(raw.strip(), maxsplit=1)

    def one(part):
        m = _YEAR_RE.search(part or "")
        if not m:
            return None, None
        year = int(m.group(1))
        place = part[m.end():].lstrip(" ,").strip()
        if place in ("", "?", "-"):
            place = None
        return year, place

    out["bornYear"], out["bornPlace"] = one(halves[0])
    if len(halves) > 1:
        out["diedYear"], out["diedPlace"] = one(halves[1])
    return out


def collect_from_caches():
    """canonical Artist name -> (life-dates string, nationality, institution). First
    non-empty wins; a later institution disagreeing is not a conflict worth modelling here,
    it is the same museum network quoting the same authority file."""
    payload = json.load(open(RESOLUTION_PATH, encoding="utf-8"))
    resolution = payload["resolution"]
    out = {}
    for path in sorted(glob.glob(CACHE_GLOB)):
        cache = json.load(open(path, encoding="utf-8"))
        if not isinstance(cache, dict) or "records" not in cache:
            continue
        for record in cache["records"]:
            artwork = record.get("artwork") or {}
            raw_author = (artwork.get("authors_list") or "").strip()
            entry = resolution.get(raw_author)
            if not entry:
                continue
            name = entry["canonicalName"]
            if name in out and out[name][0]:
                continue
            life = (artwork.get("authors_birth_death") or "").strip()
            nat = (artwork.get("authors_nationality") or "").strip() or None
            if life or nat:
                out[name] = (life, nat, cache["institution"])
    return out


READ_QUERY = """
MATCH (a:Artist) WHERE a.name IN $names
RETURN a.name AS name, a.dateBorn_year AS bornYear, a.dateDied_year AS diedYear,
       a.nationality AS nationality, a.dateBorn_precision AS bornPrecision
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name})
SET a.datesResolvedAt = row.resolvedAt,
    a.datesResolvedBy = row.resolvedBy

FOREACH (_ IN CASE WHEN row.setBornYear IS NOT NULL THEN [1] ELSE [] END |
  SET a.dateBorn_year = row.setBornYear,
      a.dateBorn_precision = "exact",
      a.dateBorn_displayLabel = coalesce(a.dateBorn_displayLabel, row.displayLabel))
FOREACH (_ IN CASE WHEN row.setDiedYear IS NOT NULL THEN [1] ELSE [] END |
  SET a.dateDied_year = row.setDiedYear,
      a.dateDied_precision = "exact",
      a.dateDied_displayLabel = coalesce(a.dateDied_displayLabel, row.displayLabel))
FOREACH (_ IN CASE WHEN row.setNationality IS NOT NULL THEN [1] ELSE [] END |
  SET a.nationality = row.setNationality)
FOREACH (_ IN CASE WHEN row.bornPlace IS NOT NULL THEN [1] ELSE [] END |
  SET a.birthPlace = coalesce(a.birthPlace, row.bornPlace))
FOREACH (_ IN CASE WHEN row.diedPlace IS NOT NULL THEN [1] ELSE [] END |
  SET a.deathPlace = coalesce(a.deathPlace, row.diedPlace))

FOREACH (_ IN CASE WHEN row.bornDisputeNote IS NOT NULL THEN [1] ELSE [] END |
  SET a.dateBorn_disputed = true,
      a.dateBorn_disputeNote = row.bornDisputeNote)
FOREACH (_ IN CASE WHEN row.diedDisputeNote IS NOT NULL THEN [1] ELSE [] END |
  SET a.dateDied_disputed = true,
      a.dateDied_disputeNote = row.diedDisputeNote)
"""


def build_rows(incoming, existing):
    now = datetime.now(timezone.utc).isoformat()
    rows, conflicts = [], []
    stats = defaultdict(int)
    for name, (life, nat, institution) in sorted(incoming.items()):
        parsed = parse_life_dates(life)
        current = existing.get(name)
        if current is None:
            stats["artist_not_in_graph"] += 1
            continue

        row = {"name": name, "resolvedAt": now,
               "resolvedBy": f"navigart:{institution}",
               "displayLabel": parsed["displayLabel"],
               "bornPlace": parsed["bornPlace"], "diedPlace": parsed["diedPlace"],
               "setBornYear": None, "setDiedYear": None, "setNationality": None,
               "bornDisputeNote": None, "diedDisputeNote": None}

        for field, key, note_key in (("bornYear", "setBornYear", "bornDisputeNote"),
                                     ("diedYear", "setDiedYear", "diedDisputeNote")):
            incoming_year = parsed[field]
            if incoming_year is None:
                continue
            have = current.get(field)
            if have is None:
                row[key] = incoming_year
                stats[f"filled_{field}"] += 1
            elif have != incoming_year:
                row[note_key] = (f"{institution} records {incoming_year}; this graph holds "
                                 f"{have}. Not overwritten — see "
                                 f"navigart_backfill_artist_dates.py.")
                stats[f"disputed_{field}"] += 1
                conflicts.append([name, field.replace("Year", ""), have, incoming_year,
                                  institution, parsed["displayLabel"]])
            else:
                stats[f"agreed_{field}"] += 1

        if nat and not current.get("nationality"):
            row["setNationality"] = nat
            stats["filled_nationality"] += 1
        if parsed["bornPlace"] or parsed["diedPlace"]:
            stats["places_available"] += 1

        if any(row[k] is not None for k in ("setBornYear", "setDiedYear", "setNationality",
                                            "bornDisputeNote", "diedDisputeNote",
                                            "bornPlace", "diedPlace")):
            rows.append(row)
    return rows, conflicts, dict(stats)


def main(apply_changes):
    incoming = collect_from_caches()
    print(f"[SOURCE] {len(incoming)} artist(s) with life-dates or nationality in the caches",
          flush=True)

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            existing = {r["name"]: r for r in
                        session.run(READ_QUERY, names=list(incoming)).data()}
            print(f"[GRAPH]  {len(existing)} of them exist as Artist nodes", flush=True)

            rows, conflicts, stats = build_rows(incoming, existing)
            for key in sorted(stats):
                print(f"    {key:<24} {stats[key]:>5}", flush=True)
            print(f"[ROWS]   {len(rows)} artist(s) would change", flush=True)

            with open(CONFLICT_PATH, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["artist", "field", "graphValue", "navigartValue",
                                 "institution", "navigartString"])
                writer.writerows(conflicts)
            print(f"[FILES]  {len(conflicts)} conflict(s) -> {CONFLICT_PATH}", flush=True)
            for c in conflicts:
                print(f"    DISPUTE {c[0][:34]:<34} {c[1]:<5} graph={c[2]} navigart={c[3]}",
                      flush=True)

            if not apply_changes:
                print("[DRY RUN] nothing written", flush=True)
                return
            start = time.time()
            for i in range(0, len(rows), 200):
                session.run(WRITE_QUERY, rows=rows[i:i + 200]).consume()
                print(f"[PROGRESS] {min(i + 200, len(rows))}/{len(rows)}", flush=True)
            print(f"[DONE] elapsed={time.time() - start:.0f}s", flush=True)
    finally:
        driver.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write to Neo4j")
    parser.add_argument("--dry-run", action="store_true", help="Report only (default)")
    args = parser.parse_args()
    if not args.apply and not args.dry_run:
        parser.error("Provide --apply or --dry-run")
    main(apply_changes=args.apply)
