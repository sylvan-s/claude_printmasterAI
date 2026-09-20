"""
PrintMasterAI — page-cited catalogues raisonnés: one node per catalogue, and the entries the
ingest never made.
Version: PAGE-CITATION-REPAIR-1.0

    python3 repair_page_form_catalogue_entries.py            # dry run
    python3 repair_page_form_catalogue_entries.py --apply

Some catalogues raisonnés cite by PAGE, not by entry number: Czwiklitzer for Picasso's posters,
Littmann for Haring, Sorlier for Chagall. Two defects followed from that, both found on 2026-09-17
while reading Roseberys A0793 lot 305 (Picasso, Le Clown et l'Harlequin, "Czwiklitzer p.437"):

  A. THE MARKER LANDED IN THE CATALOGUE'S NAME. `catalogue_matching.parse_catalogue_refs` splits a
     citation at the last token, so "Littmann p. 93" became the catalogue "Littmann p." with entry
     "93". The graph holds ~130 such nodes — "Littmann p." (37 entries), "L. p." (34), "Cirrus p."
     (21), "Sorlier p." (4) — one per page-cited catalogue instead of one per catalogue.
     `_move_page_marker` now moves the marker onto the entry number, and this pass rewrites what is
     already stored: prefix "Littmann p." -> "Littmann", entry "Littmann p.-93" -> "Littmann-p.93".

  B. WITH NO SPACE, NOTHING WAS PARSED AT ALL. `extractCatalogueRefs` required the entry token to
     start with a digit, so "(Czwiklitzer p.437)" never reached the `catalogue_refs` column and no
     CatalogueEntry was ever created: the reference stayed inside the work's title. The regex now
     accepts the marker (src/shared/text_extraction.ts, benchmark/src/forum/parse.ts), which fixes
     future ingests; this pass reads the citations already sitting in stored titles and creates the
     missing entries.

NOT TOUCHED: "V. 182, p. 258" (Bonhams) — that prefix ends in a NUMBER before the marker, which is
the comma-split defect `repair_comma_split_catalogue_entries.py` owns, not this one. A fragment that
is only a marker ("p. 258") still parses to nothing, as before.

WHAT A CatalogueEntry MEANS HERE: it documents a work. This pass never merges works, never changes
`ConceptualWork.id`, and never re-keys identity — a page-cited catalogue can cover several prints on
one page, which is exactly the portfolio-level-citation trap catalogue_matching.py's docstring
records. It only adds the citation the source already printed.
"""
import argparse
import datetime
import json
import os
import re
import sys

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_matching import genuine_refs, parse_catalogue_refs  # noqa: E402

VERSION = "PAGE-CITATION-REPAIR-1.0"
# Case matters: a lowercase "p." / "pp." is a page marker, an uppercase "P." is an author's
# initial — "A. & P." (Adhémar & Pouillon) and "G. & P." are catalogue NAMES, not page references.
# The marker must be a separate token: "App." (appendix) ends in "pp." but has no break before it,
# and must never be read as the catalogue "A" cited by page.
PAGE_PREFIX = re.compile(r"^(.*?[^\w]|)[\s,]*(pp?\.|[Pp]age)$")
# A bracketed citation whose entry is a page reference: "(Czwiklitzer p.437)", "[Littmann p. 93]".
TITLE_CITATION = re.compile(r"[\[(]\s*([A-Z][A-Za-z&.'’\s]{2,25}?\s+pp?\.\s*\d{1,4}[a-z]?)\s*[\])]")

PREFIXES = """
MATCH (cr:CatalogueRaisonne) WHERE cr.numberingPrefix =~ '(?i).*\\\\b(pp?\\\\.?|page)$'
OPTIONAL MATCH (cr)-[:CONTAINS]->(ce:CatalogueEntry)
RETURN cr.numberingPrefix AS prefix, collect({id: ce.id, number: ce.number}) AS entries
"""
TITLE_RE = '(?i).*[\\[(][^\\[\\]()]*\\bpp?\\.\\s*\\d.*'
TITLES_BY_WORK = """
MATCH (w:ConceptualWork) WHERE w.name =~ $re
RETURN w.id AS workId, w.name AS name, [w.name] AS titles,
       COLLECT { MATCH (c:CatalogueEntry)-[:DOCUMENTS]->(w) RETURN c.id } AS existing
"""
TITLES_BY_IMPRESSION = """
MATCH (i:Impression) WHERE i.sourceTitle =~ $re
MATCH (i)<-[:INCLUDES]-(:EditionRun)<-[:PRINTED_AS]-(w:ConceptualWork)
RETURN w.id AS workId, w.name AS name, collect(DISTINCT i.sourceTitle) AS titles,
       COLLECT { MATCH (c:CatalogueEntry)-[:DOCUMENTS]->(w) RETURN c.id } AS existing
"""
RENAME_PREFIX = """
MATCH (old:CatalogueRaisonne {numberingPrefix: $old})
MERGE (new:CatalogueRaisonne {numberingPrefix: $new})
WITH old, new WHERE elementId(old) <> elementId(new)
OPTIONAL MATCH (old)-[r:CONTAINS]->(ce:CatalogueEntry)
FOREACH (x IN CASE WHEN ce IS NULL THEN [] ELSE [ce] END | MERGE (new)-[:CONTAINS]->(x) DELETE r)
WITH old, new
SET new.pageCited = true, new.repairedBy = $version
DETACH DELETE old
RETURN new.numberingPrefix AS prefix
"""
RENAME_ENTRY = """
MATCH (old:CatalogueEntry {id: $oldId})
OPTIONAL MATCH (keep:CatalogueEntry {id: $newId})
WITH old, keep WHERE keep IS NULL OR elementId(keep) <> elementId(old)
CALL (old, keep) {
  WITH old, keep WHERE keep IS NOT NULL
  OPTIONAL MATCH (old)-[d:DOCUMENTS]->(w) FOREACH (x IN CASE WHEN w IS NULL THEN [] ELSE [w] END | MERGE (keep)-[:DOCUMENTS]->(x) DELETE d)
  WITH old, keep
  OPTIONAL MATCH (cr)-[c:CONTAINS]->(old) FOREACH (x IN CASE WHEN cr IS NULL THEN [] ELSE [cr] END | MERGE (x)-[:CONTAINS]->(keep) DELETE c)
  DETACH DELETE old
}
CALL (old, keep) {
  WITH old, keep WHERE keep IS NULL
  SET old.idBeforeRepair = old.id, old.id = $newId, old.number = $newNumber, old.repairedBy = $version
}
RETURN $newId AS id
"""
ADD_ENTRY = """
MATCH (w:ConceptualWork {id: $workId})
MERGE (cr:CatalogueRaisonne {numberingPrefix: $prefix})
  ON CREATE SET cr.createdBy = $version
SET cr.pageCited = true
MERGE (ce:CatalogueEntry {id: $prefix + '-' + $number})
  ON CREATE SET ce.number = $number, ce.createdBy = $version, ce.createdFrom = $source
MERGE (cr)-[:CONTAINS]->(ce)
MERGE (ce)-[:DOCUMENTS]->(w)
RETURN ce.id AS id
"""


def clean_prefix(prefix):
    """'Littmann p.' -> 'Littmann'. None when the name before the marker ends in a digit (the
    comma-split defect, e.g. 'V. 182, p.') or is empty."""
    m = PAGE_PREFIX.match(prefix)
    if not m:
        return None
    name = m.group(1).strip(" ,")
    if not name or name.rstrip(".")[-1:].isdigit() or not re.search(r"[A-Za-z]", name):
        return None
    return name, m.group(2).rstrip(".").lower().replace("page", "p")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with drv.session(database=os.environ.get("NEO4J_DATABASE") or "neo4j") as s:
        # A. prefixes carrying the marker
        renames = []
        for r in s.run(PREFIXES):
            c = clean_prefix(r["prefix"])
            if not c:
                print(f"  left alone: prefix {r['prefix']!r} (nothing usable before the marker, or it ends in a number — the comma-split defect)")
                continue
            name, marker = c
            entries = [e for e in r["entries"] if e["id"]]
            renames.append({"old": r["prefix"], "new": name, "entries": [
                {"oldId": e["id"], "newId": f"{name}-{marker}.{e['number']}", "newNumber": f"{marker}.{e['number']}"}
                for e in entries if e["number"] and not str(e["number"]).lower().startswith(("p.", "pp."))]})
        # B. citations still sitting in titles
        adds = []
        rows = {}
        for q in (TITLES_BY_WORK, TITLES_BY_IMPRESSION):
            for r in s.run(q, re=TITLE_RE):
                cur = rows.setdefault(r["workId"], {"workId": r["workId"], "name": r["name"], "titles": [], "existing": r["existing"]})
                cur["titles"] += [t for t in r["titles"] if t]
        for r in rows.values():
            found = {}
            for t in r["titles"]:
                for m in TITLE_CITATION.finditer(t):
                    for ref in genuine_refs(parse_catalogue_refs(m.group(1))):
                        found[(ref["catalogueName"], ref["entryNumber"])] = t
            for (prefix, number), src in found.items():
                if f"{prefix}-{number}" in (r["existing"] or []):
                    continue
                adds.append({"workId": r["workId"], "prefix": prefix, "number": number, "source": src[:120], "work": r["name"]})
        print(f"A. {len(renames)} page-cited catalogues to rename, {sum(len(x['entries']) for x in renames)} entries to re-id")
        for x in renames[:6]:
            print(f"   {x['old']!r} -> {x['new']!r}" + (f"; e.g. {x['entries'][0]['oldId']} -> {x['entries'][0]['newId']}" if x["entries"] else ""))
        print(f"B. {len(adds)} missing entries from citations in titles, on {len({a['workId'] for a in adds})} works")
        for a in adds[:6]:
            print(f"   {a['prefix']} {a['number']} -> {a['work'][:60]}")
        if not args.apply:
            print("\ndry run: nothing written.")
            return
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap = f"page_citation_presnapshot_{stamp}.json"
        json.dump({"renames": renames, "adds": adds}, open(snap, "w"), indent=1)
        for x in renames:
            for e in x["entries"]:
                s.run(RENAME_ENTRY, oldId=e["oldId"], newId=e["newId"], newNumber=e["newNumber"], version=VERSION).consume()
            s.run(RENAME_PREFIX, old=x["old"], new=x["new"], version=VERSION).consume()
        made = 0
        for a in adds:
            made += 1 if s.run(ADD_ENTRY, workId=a["workId"], prefix=a["prefix"], number=a["number"], source=a["source"], version=VERSION).single() else 0
        print(f"\nsnapshot -> {snap}; {len(renames)} catalogues renamed, {made} entries added")
    drv.close()


if __name__ == "__main__":
    main()
