"""
PrintMasterAI — add Period and Region as real, shared ACKG nodes.

Doc 08 §5 deliberately deferred Period and Region to plain properties
(ConceptualWork.dateCreated_year, Artist.nationality) rather than shared nodes, on the
grounds that there was "no identified cross-cutting query need yet." The ADR-0009 similarity
prototype (gds_prototype.py) created exactly that need: node-similarity/FastRP need graph
*neighbours* to compare artists by, and a property alone can't be a shared neighbour two
different artists both point to. This script is the real (small, reversible) schema addition
that resolves it — not a workaround inside the GDS session, because that was tried and
confirmed not to work: apoc.create.vNode({bucket: 1970}) called three times in a row returns
three DIFFERENT internal ids, so two artists from the same decade would each get a private
virtual node sharing nothing, silently contributing zero tie-breaking signal.

Two new node types, following the exact pattern Technique/Paper/Subject already established:

  Period {decade: INTEGER, label: STRING}      -- e.g. {decade: 1970, label: "1970s"}
  Region {name: STRING}                         -- e.g. {name: "British"}

Two new edges:

  ConceptualWork -[:DATED_TO]-> Period          -- from dateCreated_year, decade-binned
  Artist -[:FROM_REGION]-> Region               -- from nationality, parsed (see below)

Period binning: floor(year/10)*10. dateCreated_year == 0 (21 records, a placeholder for
"unknown" — never a real year) is excluded, not binned into a bogus "0s" decade.

Region parsing is the harder half. Artist.nationality is unstructured free text, not a
controlled vocabulary — confirmed by a live query against this project's real data returning
~190 distinct values including plain typos ("AMerican", "Britsh", "Brtitish", "Japanse",
"Ukranian"), compound dual-nationality strings ("American/British", "American, born
Australia", "Swiss, born France"), and at least one outright data-entry error ("Bristol" — a
city, not a nationality). Blindly MERGE-ing the raw string would fragment the Region vocabulary
with near-duplicates of the same real value, which would make the similarity signal *worse*
than not having Region at all. So this script normalizes first:
  1. Split each value on "/", ",", and the literal " born " marker — a compound like
     "American, born Australia" or "Swiss/French" becomes multiple candidate fragments.
     Treated as multi-valued, matching how USES_TECHNIQUE already handles an artist/work with
     more than one true value, not a forced pick-one.
  2. Trim, strip a literal leading "born " left over from the split, and apply a small,
     explicitly-listed typo-correction map for the handful of real misspellings actually
     observed (case-only differences are handled by title-casing, not listed separately).
  3. Drop fragments in an explicit exclude list for values confirmed NOT to be a nationality
     ("Bristol"). Nothing else is silently dropped — an unrecognized fragment still becomes
     its own Region node rather than being discarded, since this is a judgment call, not a
     verified crosswalk (contrast doc 08 principle 6's AAT verification discipline, which
     doesn't apply here — nationality has no equivalent live-checkable authority list).

Idempotent — MERGE on both the node and the relationship, safe to re-run.
"""

import os
import re

from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. `set -a; source .env; set +a` before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

# Real misspellings observed via a live distinct-values query against this project's Artist
# nodes on 2026-08-26 — not a guess. Keyed lowercase; title-casing handles plain case variants
# ("AMerican") without needing a separate entry.
NATIONALITY_TYPO_FIXES = {
    "britsh": "British",
    "brtitish": "British",
    "japanse": "Japanese",
    "ukranian": "Ukrainian",
    "france": "French",  # a country name used where a nationality was meant
}

# Confirmed not a nationality at all (a UK city recorded in the nationality field by mistake).
NATIONALITY_EXCLUDE = {"bristol"}


def parse_nationality_fragments(raw):
    """Splits one raw Artist.nationality string into normalized Region name fragments.
    Multi-valued by design — 'American/British' becomes two fragments, both real."""
    parts = re.split(r"/|,", raw)
    fragments = []
    for part in parts:
        part = part.strip()
        part = re.sub(r"^born\s+", "", part, flags=re.IGNORECASE)
        part = part.strip()
        if not part:
            continue
        key = part.lower()
        if key in NATIONALITY_EXCLUDE:
            continue
        canonical = NATIONALITY_TYPO_FIXES.get(key, part)
        fragments.append(canonical)
    return fragments


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            print("Creating Period nodes + ConceptualWork -[:DATED_TO]-> Period edges...")
            period_result = session.run(
                """
                MATCH (cw:ConceptualWork)
                WHERE cw.dateCreated_year IS NOT NULL AND cw.dateCreated_year > 0
                WITH cw, (cw.dateCreated_year / 10) * 10 AS decade
                MERGE (p:Period {decade: decade})
                ON CREATE SET p.label = toString(decade) + "s"
                MERGE (cw)-[:DATED_TO]->(p)
                RETURN count(DISTINCT p) AS periodNodes, count(*) AS edges
                """
            ).single()
            print(f"  {period_result['periodNodes']} Period nodes, {period_result['edges']} DATED_TO edges.")

            print("Fetching distinct Artist.nationality values for parsing...")
            nationalities = [
                r["nationality"]
                for r in session.run(
                    "MATCH (a:Artist) WHERE a.nationality IS NOT NULL RETURN DISTINCT a.nationality AS nationality"
                )
            ]
            raw_to_fragments = {raw: parse_nationality_fragments(raw) for raw in nationalities}
            distinct_regions = sorted({frag for frags in raw_to_fragments.values() for frag in frags})
            print(f"  {len(nationalities)} distinct raw nationality strings -> {len(distinct_regions)} distinct Region names.")

            print("Creating Region nodes + Artist -[:FROM_REGION]-> Region edges...")
            rows = [{"raw": raw, "fragments": frags} for raw, frags in raw_to_fragments.items() if frags]
            region_result = session.run(
                """
                UNWIND $rows AS row
                MATCH (a:Artist {nationality: row.raw})
                UNWIND row.fragments AS regionName
                MERGE (r:Region {name: regionName})
                MERGE (a)-[:FROM_REGION]->(r)
                RETURN count(DISTINCT r) AS regionNodes, count(*) AS edges
                """,
                rows=rows,
            ).single()
            print(f"  {region_result['regionNodes']} Region nodes, {region_result['edges']} FROM_REGION edges.")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
