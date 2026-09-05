"""
One-off analysis (not a pipeline component): for every currently-unresolved Artist
(ulanUrl IS NULL, works >= 2), search the local ULAN mirror and see what changes if
candidates are restricted to is_printmaker=True vs the unfiltered pool. Answers:
  1. How many would now resolve confidently if restricted to printmaker-tagged ULAN
     candidates?
  2. How many have ZERO printmaker-tagged candidate at all (would have to be reported
     as "no relevant printmaking ULAN found", a different failure mode than ambiguity)?
Read-only — does not write to Neo4j or the local ULAN db.
"""
import json
import sqlite3

from neo4j import GraphDatabase
import os

from resolve_artist_identity import strip_honorifics, _name_match_score

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulan_local.sqlite")


def fetch_stuck_artists():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            q = (
                "MATCH (a:Artist) WHERE a.ulanUrl IS NULL "
                "OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork) "
                "WITH a, count(DISTINCT w) AS works WHERE works >= 2 "
                "RETURN a.name AS name ORDER BY works DESC"
            )
            return [r["name"] for r in session.run(q).data()]
    finally:
        driver.close()


def fts_query(name):
    """Build a permissive FTS5 query: OR of the significant tokens."""
    toks = [t for t in name.replace('"', ' ').split() if len(t) > 1]
    if not toks:
        return None
    return " OR ".join(f'"{t}"' for t in toks[:8])


def search_candidates(conn, raw_name, only=None):
    """only: None (no filter), 'artist', or 'printmaker'. Returns scored candidates
    sorted best-first: [(ulan_id, pref_name, score, is_artist, is_printmaker), ...]"""
    stripped = strip_honorifics(raw_name)
    q = fts_query(stripped)
    if not q:
        return []
    where = ""
    if only == "artist":
        where = "AND p.is_artist = 1"
    elif only == "printmaker":
        where = "AND p.is_printmaker = 1"
    try:
        rows = conn.execute(f"""
            SELECT DISTINCT p.ulan_id, p.pref_name, p.is_artist, p.is_printmaker
            FROM ulan_name_fts f JOIN ulan_person p ON p.ulan_id = f.ulan_id
            WHERE ulan_name_fts MATCH ? {where}
            LIMIT 60
        """, (q,)).fetchall()
    except sqlite3.OperationalError:
        return []
    scored = []
    for uid, pname, is_artist, is_printmaker in rows:
        score = _name_match_score(stripped, pname or "")
        scored.append((uid, pname, score, is_artist, is_printmaker))
    scored.sort(key=lambda r: -r[2])
    return scored


def classify(scored):
    """Mirrors resolve_artist_identity's auto/strong thresholds, ULAN-side only."""
    if not scored:
        return "no_candidates"
    best = scored[0][2]
    runner = scored[1][2] if len(scored) > 1 else 0.0
    if best >= 0.92 and best - runner >= 0.15:
        return "auto"
    if best >= 0.82 and best - runner >= 0.10:
        return "strong"
    if best >= 0.55:
        return "multiple"
    return "no_candidates"


def main():
    names = fetch_stuck_artists()
    print(f"{len(names)} currently-unresolved artists\n")
    conn = sqlite3.connect(DB_PATH)

    results = []
    for i, name in enumerate(names, 1):
        unfiltered = search_candidates(conn, name, only=None)
        printmaker = search_candidates(conn, name, only="printmaker")
        results.append({
            "name": name,
            "unfiltered_class": classify(unfiltered),
            "printmaker_class": classify(printmaker),
            "printmaker_candidate_count": len(printmaker),
        })
        if i % 200 == 0:
            print(f"  ...{i}/{len(names)}", flush=True)

    conn.close()

    from collections import Counter
    unf = Counter(r["unfiltered_class"] for r in results)
    pm = Counter(r["printmaker_class"] for r in results)

    print("\n=== Unfiltered (raw ULAN name-match only) ===")
    for k, v in unf.most_common():
        print(f"  {k:15s} {v:5d}")

    print("\n=== Printmaker-filtered ===")
    for k, v in pm.most_common():
        print(f"  {k:15s} {v:5d}")

    now_confident = sum(
        1 for r in results
        if r["printmaker_class"] in ("auto", "strong") and r["unfiltered_class"] not in ("auto", "strong")
    )
    no_printmaker_candidate = sum(1 for r in results if r["printmaker_candidate_count"] == 0)
    print(f"\nNewly confident (auto/strong) once filtered to printmaker, "
          f"wasn't already: {now_confident}")
    print(f"Zero printmaker-tagged ULAN candidate at all: {no_printmaker_candidate}")

    with open("printmaker_filter_analysis.json", "w") as f:
        json.dump(results, f, indent=1)
    print("\nFull per-artist results -> printmaker_filter_analysis.json")


if __name__ == "__main__":
    main()
