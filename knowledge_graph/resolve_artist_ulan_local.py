"""
PrintMasterAI — resolve `Artist.ulanUrl` against the LOCAL ULAN mirror, date-corroborated
Version: ULAN-LOCAL-RESOLVE-0.1

The offline half of ADR-0012. `backfill_artist_ulan.py` already exists and stays: it runs
the live Wikidata+Getty resolver, takes 1.5–2h for ~2,000 artists, and is the right tool
when a name needs real research. This is the other case — a large population of artists
whose names match exactly one ULAN artist record, answerable from `ulan_local.sqlite` in
seconds, with two guards the live path does not have.

## Guard 1: the occupation filter ADR-0012 was written about

ADR-0012 §Context traces every name-collision bug of that session to one cause: the live
`_search_ulan()` query constrains only `a gvp:PersonConcept` — "is this any person" — with
nothing narrowing to artists. Sidney Nolan matched a Russian sculptor and an American
filmmaker; John Flaxman matched his own father and wife. The mirror carries
`is_artist` / `is_printmaker`, derived from ULAN's own AAT agent-type concepts, so that
filter is finally available. Only `is_artist = 1` records are candidates at all, and
`is_printmaker` is recorded on every write.

## Guard 2: dates veto, they do not merely rank

A unique exact-name match is good evidence and is not proof. What makes this safe enough
to write automatically is that most of these artists now carry birth/death years — from
`navigart_backfill_artist_dates.py` — and ULAN's biography text carries its own. So the
name proposes and an **independent** fact disposes:

  - the candidate's year agrees within `--year-tolerance` (default 5) with EITHER the
    year on the node OR the year the source museum published  ->  written,
    `identityConfidence = "ulan_date_corroborated"`.
  - it contradicts BOTH  ->  REFUSED, however good the name match is.
  - there is no year anywhere to compare  ->  NOT written. Reported instead.

**Two reference years, not one, and that is the whole design.** A first version compared
ULAN against the graph alone and refused 17 matches — but four of them were refusals of
the RIGHT ULAN record because the graph's own date was wrong: it holds Toulouse-Lautrec at
b.1894 (ULAN and the museum both say 1864), Laboureur at 1887 (both say 1877), Guillaumin
at 1891 (both say 1841), Paul-Émile Colin at 1882 (ULAN says 1867). A veto that trusts one
possibly-wrong number to judge another is not a check, it is a coin toss with extra steps.
Requiring agreement with *at least one independent record of the same artist* is the actual
guarantee — and where ULAN and the museum agree against the graph, that is also the
evidence that settles the dispute `navigart_backfill_artist_dates.py` recorded.

That last line is the one that matters. An uncorroborated unique-name match is exactly the
shape of thing this project has had to clean up twice, and "there was only one candidate"
is not corroboration — it is the absence of a competing candidate, which is a different
claim. Those go to `artist_ulan_local_unverified.csv` for the live resolver or a human.

Tolerance is 5 years rather than 0 because real authorities disagree at the margins:
Paul Elie Ranson is 1861 (museum), 1862 (ULAN) or 1864 (this graph), and all three are
defensible. A 5-year window admits that and still excludes a different person — the
collisions ADR-0012 documents were decades apart, not years.

## What it never does

Never overwrites an existing `ulanUrl`. Never merges nodes. Never writes on an ambiguous
name (2+ ULAN artist candidates) — those are reported, not guessed.

Usage:
    python knowledge_graph/resolve_artist_ulan_local.py --dry-run
    python knowledge_graph/resolve_artist_ulan_local.py --dry-run --source navigart
    python knowledge_graph/resolve_artist_ulan_local.py --apply --source navigart
"""

import argparse
import csv
import json
import os
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone

from neo4j import GraphDatabase
from ulan_url import canonical_ulan_url

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "ulan_local.sqlite")
RESOLUTION_PATH = os.path.join(HERE, "navigart_artist_resolution.json")
# A STATE file, not a run log. This resolver is incremental — it only considers artists
# whose ulanUrl is still null — so a second run writes 5 rows where the first wrote 356.
# Dumping "what this run did" would silently replace the record of the first 356 with a
# 5-row file that looks complete, which is the same trap `navigart_ingest.py` fell into
# with its review CSVs. So this is rebuilt from the GRAPH after every apply: every artist
# ever resolved by this tag, whichever run did it.
RESOLVED_PATH = os.path.join(HERE, "artist_ulan_local_resolved.csv")
UNVERIFIED_PATH = os.path.join(HERE, "artist_ulan_local_unverified.csv")

RESOLVER_TAG = "ulan-local-mirror-0.1"
_RANGE_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\s*[-–]\s*(1[0-9]{3}|20[0-2][0-9])\b")
_BORN_RE = re.compile(r"\bborn\s+(1[0-9]{3}|20[0-2][0-9])", re.IGNORECASE)


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def norm_key(name):
    """Accent-stripped, punctuation-stripped, upper-cased, tokens sorted — the same exact
    key `navigart_resolve_artists.py` uses. Word-order and diacritic normalisation, not
    similarity: 'Laboureur, Jean-Émile' and 'Jean-Emile Laboureur' agree, and nothing else
    does."""
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z ]", " ", s.upper())
    tokens = [t for t in s.split() if len(t) > 1]
    return " ".join(sorted(tokens)) if tokens else None


def parse_bio_years(bio):
    """FALLBACK ONLY, kept for a mirror built before `est_start`/`est_end` existed.

    The bio is free text: a full range is authoritative for both years, a bare 'born 1951'
    gives only the birth year, and 'active before 1801' is a floruit that gives neither.
    That recovers a range for 41% of artist records. The rebuilt mirror carries ULAN's own
    structured `estStart`/`estEnd` on 98% of them, so this runs only where those are null."""
    if not bio:
        return None, None
    m = _RANGE_RE.search(bio)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = _BORN_RE.search(bio)
    if m:
        return int(m.group(1)), None
    return None, None


def museum_years():
    """Birth/death years as the source museums published them, from the Navigart caches —
    the second reference year. Independent of whatever is on the node."""
    import glob
    years = {}
    if not os.path.exists(RESOLUTION_PATH):
        return years
    resolution = json.load(open(RESOLUTION_PATH, encoding="utf-8"))["resolution"]
    pattern = os.path.join(os.path.dirname(HERE), "benchmark", "data", "navigart", "*.json")
    for path in sorted(glob.glob(pattern)):
        cache = json.load(open(path, encoding="utf-8"))
        if not isinstance(cache, dict) or "records" not in cache:
            continue
        for record in cache["records"]:
            artwork = record.get("artwork") or {}
            entry = resolution.get((artwork.get("authors_list") or "").strip())
            raw = artwork.get("authors_birth_death")
            if not entry or not raw or entry["canonicalName"] in years:
                continue
            found = re.findall(r"\b(1[0-9]{3}|20[0-2][0-9])\b", raw)
            if found:
                years[entry["canonicalName"]] = (
                    int(found[0]), int(found[-1]) if len(found) > 1 else None)
    return years


def build_index(conn):
    """normalised name -> {ulan_id}. Artists only (guard 1). Single-token names are
    dropped: a bare surname collides with everyone who shares it."""
    index = defaultdict(set)
    rows = conn.execute(
        "SELECT n.ulan_id, n.name FROM ulan_name n "
        "JOIN ulan_person p ON p.ulan_id = n.ulan_id WHERE p.is_artist = 1")
    for ulan_id, name in rows:
        key = norm_key(name)
        if key and len(key.split()) > 1:
            index[key].add(ulan_id)
    return index


READ_ALL = """
MATCH (a:Artist)
WHERE a.ulanUrl IS NULL AND a.name IS NOT NULL AND a.name <> ''
  AND ($names IS NULL OR a.name IN $names)
RETURN a.name AS name, a.dateBorn_year AS born, a.dateDied_year AS died,
       size([(a)-[:CREATED]->(w) | w]) AS works
"""

WRITE_QUERY = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name})
WHERE a.ulanUrl IS NULL
SET a.ulanUrl = row.ulanUrl,
    a.ulanIsPrintmaker = row.isPrintmaker,
    a.identityConfidence = "ulan_date_corroborated",
    a.identityResolvedAt = row.resolvedAt,
    a.identityResolvedBy = row.resolvedBy
"""


def main(apply_changes, source, tolerance, min_works):
    conn = sqlite3.connect(DB_PATH)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(ulan_person)")}
    if "est_start" not in cols:
        raise RuntimeError(
            "ulan_local.sqlite has no est_start column — rebuild it with "
            "`python3 build_ulan_index.py --zip explicit.zip` to pick up ULAN's structured "
            "life dates, which this resolver's corroboration check relies on.")
    index = build_index(conn)
    museum = museum_years()
    print(f"[REF]   {len(museum)} artist(s) have a museum-published year as a second "
          f"reference", flush=True)
    print(f"[ULAN]  {len(index)} normalised artist-name key(s) in the local mirror", flush=True)

    names = None
    if source == "navigart":
        payload = json.load(open(RESOLUTION_PATH, encoding="utf-8"))
        names = sorted({v["canonicalName"] for v in payload["resolution"].values()})
        print(f"[SCOPE] restricted to the {len(names)} Navigart artists", flush=True)

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            artists = [r for r in session.run(READ_ALL, names=names).data()
                       if r["works"] >= min_works]
            print(f"[GRAPH] {len(artists)} artist(s) without a ulanUrl "
                  f"(min_works={min_works})", flush=True)

            now = datetime.now(timezone.utc).isoformat()
            rows, unverified = [], []
            stats = defaultdict(int)
            for a in artists:
                key = norm_key(a["name"])
                candidates = index.get(key) or set()
                if not candidates:
                    stats["no_ulan_artist_match"] += 1
                    continue
                if len(candidates) > 1:
                    stats["ambiguous_multiple_ulan"] += 1
                    unverified.append([a["name"], a["works"], "ambiguous",
                                       ";".join(sorted(candidates)), "", a["born"] or "", ""])
                    continue

                ulan_id = next(iter(candidates))
                pref, bio, est_start, est_end, is_pm = conn.execute(
                    "SELECT pref_name, bio, est_start, est_end, is_printmaker "
                    "FROM ulan_person WHERE ulan_id = ?", (ulan_id,)).fetchone()
                u_born, u_died = est_start, est_end
                if u_born is None and u_died is None:
                    u_born, u_died = parse_bio_years(bio)
                m_born, m_died = museum.get(a["name"], (None, None))

                born_refs = [y for y in (a["born"], m_born) if y is not None]
                died_refs = [y for y in (a["died"], m_died) if y is not None]
                checks = ([(u_born, born_refs)] if u_born is not None else []) + \
                         ([(u_died, died_refs)] if u_died is not None else [])
                comparable = [(u, refs) for u, refs in checks if refs]

                if comparable:
                    if any(any(abs(u - r) <= tolerance for r in refs) for u, refs in comparable):
                        stats["corroborated"] += 1
                        if any(any(abs(u - r) > tolerance for r in refs)
                               for u, refs in comparable):
                            stats["corroborated_but_graph_year_looks_wrong"] += 1
                    else:
                        stats["refused_date_conflict"] += 1
                        u, refs = comparable[0]
                        unverified.append([a["name"], a["works"], "date_conflict", ulan_id,
                                           pref, "/".join(str(r) for r in refs), u])
                        continue
                else:
                    # Guard 2's last line: a unique name and nothing to check it against.
                    stats["uncorroborated_not_written"] += 1
                    unverified.append([a["name"], a["works"], "no_dates_to_compare",
                                       ulan_id, pref, a["born"] or "", u_born or ""])
                    continue

                if is_pm:
                    stats["also_flagged_printmaker"] += 1
                rows.append({"name": a["name"],
                             # WAS f".../page/ulan/{ulan_id}" — the page form addresses
                             # Getty's HTML page, not the resource, and this resolver was the
                             # single largest source of the duplicate-Artist bug repaired
                             # 2026-09-12. See ulan_url.py.
                             "ulanUrl": canonical_ulan_url(ulan_id),
                             "isPrintmaker": bool(is_pm),
                             "resolvedAt": now, "resolvedBy": RESOLVER_TAG})

            for k in sorted(stats):
                print(f"    {k:<28} {stats[k]:>5}", flush=True)
            print(f"[ROWS]  {len(rows)} artist(s) would get a ulanUrl", flush=True)

            with open(UNVERIFIED_PATH, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["artist", "works", "reason", "ulanCandidates", "ulanPrefName",
                            "graphYear", "ulanYear"])
                w.writerows(unverified)
            print(f"[FILES] {len(unverified)} -> {UNVERIFIED_PATH}", flush=True)

            if not apply_changes:
                print("[DRY RUN] nothing written", flush=True)
                return
            for i in range(0, len(rows), 200):
                session.run(WRITE_QUERY, rows=rows[i:i + 200]).consume()
                print(f"[PROGRESS] {min(i + 200, len(rows))}/{len(rows)}", flush=True)

            state = session.run(
                "MATCH (a:Artist) WHERE a.identityResolvedBy = $tag "
                "RETURN a.name AS name, a.ulanUrl AS ulanUrl, "
                "       a.ulanIsPrintmaker AS isPrintmaker, a.dateBorn_year AS born, "
                "       a.dateDied_year AS died ORDER BY a.name",
                tag=RESOLVER_TAG).data()
            with open(RESOLVED_PATH, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["artist", "ulanUrl", "isPrintmaker", "born", "died"])
                w.writerows([[r["name"], r["ulanUrl"], r["isPrintmaker"],
                              r["born"] or "", r["died"] or ""] for r in state])
            print(f"[STATE] {len(state)} artist(s) resolved by {RESOLVER_TAG} in total "
                  f"-> {RESOLVED_PATH}", flush=True)
            print("[DONE]", flush=True)
    finally:
        driver.close()
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--source", choices=("navigart", "all"), default="navigart",
                        help="navigart (default): only the artists that load touched. "
                             "all: every Artist node without a ulanUrl.")
    parser.add_argument("--year-tolerance", type=int, default=5,
                        help="Years of disagreement tolerated before a match is refused")
    parser.add_argument("--min-works", type=int, default=1)
    args = parser.parse_args()
    if not args.apply and not args.dry_run:
        parser.error("Provide --apply or --dry-run")
    main(args.apply, args.source, args.year_tolerance, args.min_works)
