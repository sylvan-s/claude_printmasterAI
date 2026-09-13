"""
PrintMasterAI — correct `Artist` life dates where two independent authorities agree
against the graph
Version: RECONCILE-ARTIST-DATES-0.1

`navigart_backfill_artist_dates.py` deliberately never overwrites: it fills blanks and
records disagreements as `dateBorn_disputed` / `dateDied_disputed`. That was the right
default with two sources, because the disagreements ran both ways — the museum was right
about Toulouse-Lautrec and the graph was right about Jean Moyreau.

With `ulan_local.sqlite` now carrying ULAN's structured `estStart`/`estEnd` there is a
**third, independent** authority, and that changes what is decidable. This script is the
one place in the Navigart work that overwrites an existing value, and it does so only on
the narrowest rule that justifies it:

    ULAN and the holding museum agree with each other (within 1 year),
    AND the graph differs from BOTH by 2 years or more
        -> the graph's value is corrected, and the old one is kept on the node.

Everything else is left alone, including cases where the graph is merely *unconfirmed*.

## Two thresholds this got wrong first, both worth stating

1. **Tolerance for MATCHING a person is not tolerance for CORRECTING a year.**
   `resolve_artist_ulan_local.py` uses ±5 years to decide "is this the same human",
   because authorities genuinely differ at the margins. Reusing ±5 here hid a real error:
   Laboureur died 1943 by both ULAN and the museum, the graph says 1947, and a 4-year gap
   passes a ±5 match veto while still being wrong. Correction therefore triggers on any
   difference of 2+, not on the matching tolerance.

2. **"The graph differs from ULAN" is not the test — "the graph differs from BOTH" is.**
   A version keyed on the first condition proposed 20 corrections, and 12 of them were
   off-by-one cases where the graph already agreed with the MUSEUM exactly and ULAN was
   the outlier: Potémont b.1827 (graph and museum) vs ULAN 1828, Pissarro b.1830 (graph
   and museum) vs ULAN 1831. Correcting those would have replaced a two-source consensus
   with a one-source disagreement — the exact inversion of this script's purpose.

## What is written

    dateBorn_year / dateDied_year   corrected
    dateBorn_supersededValue        the old year, kept, not discarded
    dateBorn_disputed = false       the dispute is resolved, not outstanding
    dateBorn_disputeNote            names both agreeing authorities and the old value
    datesResolvedBy / datesResolvedAt

Usage:
    python knowledge_graph/reconcile_artist_dates.py --dry-run
    python knowledge_graph/reconcile_artist_dates.py --apply
"""

import argparse
import csv
import glob
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "ulan_local.sqlite")
RESOLUTION_PATH = os.path.join(HERE, "navigart_artist_resolution.json")
REPORT_PATH = os.path.join(HERE, "artist_date_corrections.csv")

AGREE_WITHIN = 1     # ULAN and the museum must agree with each other this closely
CORRECT_FROM = 2     # the graph must be at least this far from both to be corrected
RESOLVER_TAG = "ulan+museum-reconcile-0.1"
_YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def museum_years():
    resolution = json.load(open(RESOLUTION_PATH, encoding="utf-8"))["resolution"]
    out = {}
    for path in sorted(glob.glob(os.path.join(os.path.dirname(HERE), "benchmark", "data",
                                              "navigart", "*.json"))):
        cache = json.load(open(path, encoding="utf-8"))
        if not isinstance(cache, dict) or "records" not in cache:
            continue
        for record in cache["records"]:
            artwork = record.get("artwork") or {}
            entry = resolution.get((artwork.get("authors_list") or "").strip())
            raw = artwork.get("authors_birth_death")
            if not entry or not raw or entry["canonicalName"] in out:
                continue
            years = [int(y) for y in _YEAR_RE.findall(raw)]
            if years:
                out[entry["canonicalName"]] = (
                    years[0], years[-1] if len(years) > 1 else None, cache["institution"])
    return out


READ_QUERY = """
MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL
RETURN a.name AS name, a.ulanUrl AS ulanUrl,
       a.dateBorn_year AS born, a.dateDied_year AS died
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name})
SET a.datesResolvedAt = row.resolvedAt, a.datesResolvedBy = row.resolvedBy
FOREACH (_ IN CASE WHEN row.field = "born" THEN [1] ELSE [] END |
  SET a.dateBorn_year = row.corrected,
      a.dateBorn_supersededValue = row.previous,
      a.dateBorn_disputed = false,
      a.dateBorn_disputeNote = row.note)
FOREACH (_ IN CASE WHEN row.field = "died" THEN [1] ELSE [] END |
  SET a.dateDied_year = row.corrected,
      a.dateDied_supersededValue = row.previous,
      a.dateDied_disputed = false,
      a.dateDied_disputeNote = row.note)
"""


def main(apply_changes):
    museum = museum_years()
    conn = sqlite3.connect(DB_PATH)
    if "est_start" not in {r[1] for r in conn.execute("PRAGMA table_info(ulan_person)")}:
        raise RuntimeError("ulan_local.sqlite predates estStart/estEnd — rebuild it first.")

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    now = datetime.now(timezone.utc).isoformat()
    rows, skipped = [], {"graph_agrees_with_museum": 0, "within_tolerance": 0,
                         "authorities_disagree": 0, "no_comparison": 0}
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            artists = session.run(READ_QUERY).data()
            print(f"[SCOPE] {len(artists)} artist(s) carry a ULAN url; "
                  f"{len(museum)} have a museum-published year", flush=True)

            for a in artists:
                m = re.search(r"/(\d+)/?$", a["ulanUrl"] or "")
                mus = museum.get(a["name"])
                if not m or not mus:
                    continue
                got = conn.execute(
                    "SELECT est_start, est_end FROM ulan_person WHERE ulan_id = ?",
                    (m.group(1),)).fetchone()
                if not got:
                    continue
                for field, graph_year, ulan_year, museum_year in (
                        ("born", a["born"], got[0], mus[0]),
                        ("died", a["died"], got[1], mus[1])):
                    if graph_year is None or ulan_year is None or museum_year is None:
                        skipped["no_comparison"] += 1
                        continue
                    if abs(ulan_year - museum_year) > AGREE_WITHIN:
                        skipped["authorities_disagree"] += 1
                        continue
                    if abs(graph_year - museum_year) < CORRECT_FROM:
                        # Includes every case where the graph is already right — see
                        # docstring point 2.
                        skipped["graph_agrees_with_museum" if graph_year == museum_year
                                else "within_tolerance"] += 1
                        continue
                    if abs(graph_year - ulan_year) < CORRECT_FROM:
                        skipped["within_tolerance"] += 1
                        continue
                    rows.append({
                        "name": a["name"], "field": field,
                        "previous": graph_year, "corrected": ulan_year,
                        "resolvedAt": now, "resolvedBy": RESOLVER_TAG,
                        "note": (f"Corrected {graph_year} -> {ulan_year}: ULAN "
                                 f"{m.group(1)} and {mus[2]} independently agree. Previous "
                                 f"value retained in date{field.capitalize()}_supersededValue."),
                        "institution": mus[2], "ulanId": m.group(1),
                        "museumYear": museum_year,
                    })

            print(f"[SKIPPED] {skipped}", flush=True)
            print(f"[ROWS]    {len(rows)} correction(s) across "
                  f"{len({r['name'] for r in rows})} artist(s)", flush=True)
            print(f"\n{'artist':<30}{'field':<6}{'graph':>7}{'->':>4}{'ULAN':>6}{'museum':>8}"
                  f"  off by", flush=True)
            for r in sorted(rows, key=lambda x: -abs(x["previous"] - x["corrected"])):
                print(f"  {r['name'][:28]:<28}{r['field']:<6}{r['previous']:>7}{'->':>4}"
                      f"{r['corrected']:>6}{r['museumYear']:>8}"
                      f"{abs(r['previous'] - r['corrected']):>8}", flush=True)

            with open(REPORT_PATH, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["artist", "field", "previousValue", "correctedTo",
                            "ulanId", "museumValue", "institution"])
                w.writerows([[r["name"], r["field"], r["previous"], r["corrected"],
                              r["ulanId"], r["museumYear"], r["institution"]] for r in rows])
            print(f"\n[FILES] {len(rows)} -> {REPORT_PATH}", flush=True)

            if not apply_changes:
                print("[DRY RUN] nothing written", flush=True)
                return
            session.run(WRITE_QUERY, rows=rows).consume()
            print("[DONE]", flush=True)
    finally:
        driver.close()
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.apply and not args.dry_run:
        parser.error("Provide --apply or --dry-run")
    main(args.apply)
