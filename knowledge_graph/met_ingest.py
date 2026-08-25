"""
PrintMasterAI — Met Open Access ingestion into the ACKG (Neo4j)
Version: MET-INGEST-2.0 (CSV-direct)

This is the executable counterpart to doc 09's field-mapping table — doc 09 describes
the rules, this file enforces them. If the two ever disagree, doc 09 is stale, not
this file: update the doc to match a deliberate code change, not the other way round.

CHANGED FROM v1.0: reads metmuseum/openaccess's MetObjects.csv directly instead of
calling the Met Collection API per object. The original per-object API loop rate-limited
this IP after sustained volume (a real failed run hit 403 on 6,158 consecutive requests)
and even with a circuit breaker was still slow and network-dependent. The CSV (CC0,
updated regularly, no key/rate-limit) already carries every field this ingest uses
EXCEPT primary image URLs — confirmed against the repo's own README ("Images are not
included and are not part of the dataset"). Since LOAD_QUERY never actually used image
URLs anyway, dropping that field is not a regression. If image URLs are ever needed,
fetch them lazily per object from the API as a separate, much smaller follow-up step —
not as part of this bulk load.

Bulk download (Git LFS):
    wget https://media.githubusercontent.com/media/metmuseum/openaccess/master/MetObjects.csv

Usage:
    python3 met_ingest.py --artists "Roy Lichtenstein,Robert Motherwell"
    python3 met_ingest.py --object-ids 336450,340396,359300
    python3 met_ingest.py --all --limit 50          # test run
    python3 met_ingest.py --all --skip 5000         # resume after a crash

Requires MET_CSV_PATH (below) to exist locally, and the neo4j driver + connection
details from AURA_DB_CREDENTIALS.md.

MULTI-CONSTITUENT HANDLING (new in this version — the API's flat artistDisplayName
field hid this): MetObjects.csv pipe-delimits ALL constituent-related columns in
parallel when an object has more than one constituent (e.g. "Lee Friedlander|Thomas
Palmer" / "Artist|Printer" / ...). Confirmed against the 10,966-object target set:
7,354 objects have at least one constituent in an Artist-family role; the remaining
3,612 have only Publisher/Printer/other roles (dominated by 3,324 Publisher-only
objects — anonymous prints known only by their publisher). Each constituent is
classified independently by its own role into one of three buckets:
  - creator  (role contains "artist", or is maker/printmaker/engraver/etcher/
    illustrator) -> Artist node, CREATED edge, ATTRIBUTED_TO edge with a qualifier.
  - publisher (role == "publisher") -> Publisher node, EditionRun-[:PUBLISHED_BY]->
  - printer   (role == "printer")   -> Publisher node, EditionRun-[:PRINTED_BY]->
    (doc 08: both edges target the same Publisher node type, added for the Roseberys
    bulk data — "printer pulls the impression, publisher commissions/sells it")
  - anything else (Designer, Author, Sitter, Correspondent, Manufacturer, Subject,
    Poet, Translator, Purveyor, Collaborator, Binder) is out of scope for this schema
    and ignored.
An object can have zero, one, or several creators. Zero-creator objects (the
Publisher-only case) deliberately get NO Artist node and NO CREATED edge — this is a
correctness fix, not a gap: the v1.0 API-based script would have MERGEd such objects
onto a single Artist node with name=null (Cypher's MERGE matches null-valued
properties across rows), silently collapsing thousands of unrelated anonymous prints
onto one garbage node. The CSV's per-constituent role data is what makes avoiding that
possible.
"""

import argparse
import os
import math
import re
import time

import pandas as pd
from neo4j import GraphDatabase

def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real AuraDB values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

MET_CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/met/MetObjects.csv"

# Technique/paper extraction lives in crosswalk_matching.py, shared with
# roseberys_ingest.py — see that module for why (prevents the two source adapters'
# vocabularies from silently drifting apart from each other).
from crosswalk_matching import extract_techniques, extract_papers

# --- doc 09 §4 SEMANTIC_SPLIT: tags -> Genre vs Subject ---
# Standard fine-art/print genre categories (a stable, well-established art-cataloguing
# taxonomy, not an ad hoc guess). Checked FIRST. Anything not on this list defaults to
# Subject (iconographic content), which was the correct call for every Subject-routed
# tag seen so far (Sun, Oxen, Tower, Windsor Castle).
#
# Known limitation (see doc 09 §4): AAT facet position is NOT a reliable automatic
# discriminator on its own — "Landscapes" resolves to AAT's Objects Facet, the same
# facet as "Sun" (a genuine Subject), so facet lookup alone would misclassify it. This
# list is the actual rule in force; extend it deliberately, don't rely on facet lookup
# to catch new genre terms automatically.
GENRE_TERMS = {
    "abstraction", "landscapes", "landscape", "portrait", "portraits", "still life",
    "genre scene", "genre scenes", "seascape", "seascapes", "marine", "nude", "nudes",
    "history painting", "religious", "mythological", "allegory", "caricature", "satire",
    "christmas", "seasonal",
}

ATTRIBUTION_QUALIFIERS = [
    ("after", ["after"]),
    ("circle_of", ["circle of"]),
    ("attributed_to", ["attributed to"]),
    ("manner_of", ["manner of"]),
    ("school_of", ["school of"]),
]

# Constituent-role classification (see module docstring). "artist" is checked as a
# substring so composite roles like "Artist and publisher" / "Artist and engraver"
# still resolve to creator.
CREATOR_ROLE_KEYWORDS = {"maker", "printmaker", "engraver", "etcher", "illustrator"}


def classify_tag(term):
    """doc 09 §4 SEMANTIC_SPLIT rule. Returns 'Genre' or 'Subject'."""
    return "Genre" if term.strip().lower() in GENRE_TERMS else "Subject"


def qualifier_from_prefix(prefix):
    prefix_l = (prefix or "").strip().lower()
    for qualifier, keywords in ATTRIBUTION_QUALIFIERS:
        if any(kw in prefix_l for kw in keywords):
            return qualifier
    return "direct"


def _classify_role(role):
    r = (role or "").strip().lower()
    if "artist" in r or r in CREATOR_ROLE_KEYWORDS:
        return "creator"
    if r == "publisher":
        return "publisher"
    if r == "printer":
        return "printer"
    return None


def _clean(v):
    """CSV cells surface as NaN (float), None, or whitespace-padded strings
    ("1794      " is real, observed data) — normalize all of that to None or a
    stripped string so downstream code never has to special-case NaN."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    s = str(v).strip()
    return s if s and s.lower() != "nan" else None


def _split_pipe(raw):
    c = _clean(raw)
    if c is None:
        return []
    return [seg.strip() for seg in c.split("|")]


def _none_if_placeholder(v):
    """The CSV uses the literal string "(not assigned)" as an explicit ULAN/Wikidata
    sentinel for a constituent known to lack one — confirmed in real rows, not
    hypothetical. Must not be treated as a real identifier."""
    if v is None:
        return None
    return None if v.strip().lower() == "(not assigned)" else v


# Met uses sentinel values (observed: "9999" for a living artist's end date, in place
# of null) rather than omitting the field. A plain isdigit()-and-cast, as this script
# originally did, trusts "9999" as a real death year — which would silently break any
# downstream posthumous-detection logic built on Artist.dateDied (see doc 08 §1,
# principle re: computed posthumous checks). Guard against ANY implausible year, not
# just the one sentinel already observed, in case Met uses others elsewhere.
_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(raw):
    s = _clean(raw)
    if not s or not s.isdigit():
        return None
    year = int(s)
    return year if _PLAUSIBLE_YEAR_RANGE[0] <= year <= _PLAUSIBLE_YEAR_RANGE[1] else None


# Populated once per run by _resolve_creator_identities() before any Neo4j writes —
# see that function's docstring for why this can't be resolved per-chunk or per-row.
_CREATOR_ULAN_BY_NAME = {}
_CREATOR_WIKIDATA_BY_NAME = {}


def parse_constituents(r):
    """Zips the parallel pipe-delimited constituent columns and buckets each
    constituent by role. See module docstring for the bucketing rule."""
    names = _split_pipe(r.get("Artist Display Name"))
    roles = _split_pipe(r.get("Artist Role"))
    prefixes = _split_pipe(r.get("Artist Prefix"))
    nationalities = _split_pipe(r.get("Artist Nationality"))
    begins = _split_pipe(r.get("Artist Begin Date"))
    ends = _split_pipe(r.get("Artist End Date"))
    ulans = _split_pipe(r.get("Artist ULAN URL"))
    wikidatas = _split_pipe(r.get("Artist Wikidata URL"))

    def at(lst, i):
        return lst[i] if i < len(lst) else None

    creators, publishers, printers = [], [], []
    for i, raw_name in enumerate(names):
        name = _clean(raw_name)
        if not name:
            continue
        bucket = _classify_role(at(roles, i))
        if bucket == "creator":
            ulan_url = _none_if_placeholder(_clean(at(ulans, i))) or _CREATOR_ULAN_BY_NAME.get(name)
            wikidata_url = _none_if_placeholder(_clean(at(wikidatas, i))) or _CREATOR_WIKIDATA_BY_NAME.get(name)
            creators.append({
                "name": name,
                "ulanUrl": ulan_url,
                "wikidataUrl": wikidata_url,
                "nationality": _clean(at(nationalities, i)),
                "beginYear": _plausible_year(at(begins, i)),
                "endYear": _plausible_year(at(ends, i)),
                "qualifier": qualifier_from_prefix(at(prefixes, i)),
            })
        elif bucket == "publisher":
            publishers.append({"name": name})
        elif bucket == "printer":
            printers.append({"name": name})
    return creators, publishers, printers


def map_record(r):
    """Implements doc 09 §4's field mapping table row by row. r is one row of
    MetObjects.csv as a dict (column name -> raw cell value)."""
    oid = r["Object ID"]
    medium = _clean(r.get("Medium")) or ""
    techniques = extract_techniques(medium)
    papers = extract_papers(medium)

    begin_raw, end_raw = r.get("Object Begin Date"), r.get("Object End Date")
    begin = int(begin_raw) if pd.notna(begin_raw) else None
    end = int(end_raw) if pd.notna(end_raw) else None

    dims = _clean(r.get("Dimensions")) or ""
    sheet_match = re.search(r"sheet:\s*([^\r\n]+)", dims, re.IGNORECASE)
    image_match = re.search(r"image:\s*([^\r\n]+)", dims, re.IGNORECASE)

    tags = _split_pipe(r.get("Tags"))
    genre_terms, subject_terms = [], []
    for term in tags:
        (genre_terms if classify_tag(term) == "Genre" else subject_terms).append(term)

    creators, publishers, printers = parse_constituents(r)

    return {
        "objectId": str(oid),
        "title": _clean(r.get("Title")) or f"Untitled (Met {oid})",
        "creators": creators,
        "publishers": publishers,
        "printers": printers,
        "dateYear": begin,
        "dateEndYear": end if end != begin else None,
        "rawMedium": medium,
        "techniques": techniques,
        "papers": papers,
        "sheetDimensions": sheet_match.group(1).strip() if sheet_match else None,
        "imageDimensions": image_match.group(1).strip() if image_match else (dims if dims and not sheet_match else None),
        "genreTerms": genre_terms,
        "subjectTerms": subject_terms,
        "accessionNumber": _clean(r.get("Object Number")),
    }


LOAD_QUERY = """
UNWIND $rows AS row

MERGE (cw:ConceptualWork {id: "met-" + row.objectId})
SET cw.name = row.title,
    cw.dateCreated_year = row.dateYear,
    cw.dateCreated_endYear = row.dateEndYear,
    cw.dateCreated_precision = CASE WHEN row.dateEndYear IS NULL THEN "exact" ELSE "range" END

MERGE (er:EditionRun {id: "met-" + row.objectId + "-er"})
SET er.dateRange_year = row.dateYear, er.dateRange_precision = "exact"
MERGE (cw)-[:PRINTED_AS]->(er)

MERGE (imp:Impression {id: "met-" + row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.imageDimensions = row.imageDimensions,
    imp.rawMedium = row.rawMedium
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: "met-" + row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = "Metropolitan Museum of Art",
    src.accessionNumber = row.accessionNumber
MERGE (src)-[:DOCUMENTS]->(imp)

WITH row, cw, er, imp, src
CALL {
  // Wrapped in a subquery that ends in an aggregate RETURN so this block always
  // yields exactly one row back to the outer query, even when row.creators is
  // empty (a bare UNWIND of an empty list would otherwise silently drop the whole
  // object from every clause that follows — techniques, papers, subjects, genres,
  // publishers, printers — none of which should depend on creators existing).
  WITH row, cw, src
  UNWIND row.creators AS creator
  CALL {
    WITH creator
    WITH creator WHERE creator.ulanUrl IS NOT NULL
    MERGE (a:Artist {ulanUrl: creator.ulanUrl})
    RETURN a
    UNION
    WITH creator
    WITH creator WHERE creator.ulanUrl IS NULL AND creator.wikidataUrl IS NOT NULL
    MERGE (a:Artist {wikidataUrl: creator.wikidataUrl})
    RETURN a
    UNION
    WITH creator
    WITH creator WHERE creator.ulanUrl IS NULL AND creator.wikidataUrl IS NULL
    MERGE (a:Artist {name: creator.name})
    RETURN a
  }
  SET a.name = creator.name,
      a.ulanUrl = coalesce(creator.ulanUrl, a.ulanUrl),
      a.wikidataUrl = coalesce(creator.wikidataUrl, a.wikidataUrl),
      a.nationality = coalesce(creator.nationality, a.nationality),
      a.dateBorn_year = coalesce(creator.beginYear, a.dateBorn_year),
      a.dateBorn_precision = CASE WHEN creator.beginYear IS NOT NULL THEN "exact" ELSE a.dateBorn_precision END,
      a.dateDied_year = coalesce(creator.endYear, a.dateDied_year),
      a.dateDied_precision = CASE WHEN creator.endYear IS NOT NULL THEN "exact" ELSE a.dateDied_precision END,
      a.identityConfidence = CASE
          WHEN creator.ulanUrl IS NOT NULL OR creator.wikidataUrl IS NOT NULL THEN "institutional"
          ELSE coalesce(a.identityConfidence, "unresolved")
      END,
      a.alternateNames = CASE
          WHEN NOT creator.name IN coalesce(a.alternateNames, []) THEN coalesce(a.alternateNames, []) + creator.name
          ELSE a.alternateNames
      END
  MERGE (a)-[:CREATED]->(cw)
  MERGE (src)-[att:ATTRIBUTED_TO]->(a)
  SET att.qualifier = creator.qualifier
  RETURN count(*) AS creatorsWritten
}

WITH row, cw, er, imp, src
UNWIND (CASE WHEN size(row.publishers) = 0 THEN [null] ELSE row.publishers END) AS pub
FOREACH (_ IN CASE WHEN pub IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Publisher {name: pub.name})
  MERGE (er)-[:PUBLISHED_BY]->(p)
)

WITH row, cw, er, imp, src
UNWIND (CASE WHEN size(row.printers) = 0 THEN [null] ELSE row.printers END) AS printer
FOREACH (_ IN CASE WHEN printer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Publisher {name: printer.name})
  MERGE (er)-[:PRINTED_BY]->(p)
)

WITH row, imp
UNWIND row.techniques AS tech
MERGE (t:Technique {name: tech.name})
FOREACH (_ IN CASE WHEN tech.aatId IS NOT NULL THEN [1] ELSE [] END | SET t.aatId = tech.aatId)
MERGE (imp)-[:USES_TECHNIQUE]->(t)

WITH row, imp
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  MERGE (imp)-[:PRINTED_ON]->(p)
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END
)

WITH row, imp
UNWIND (CASE WHEN size(row.subjectTerms) = 0 THEN [null] ELSE row.subjectTerms END) AS subjName
FOREACH (_ IN CASE WHEN subjName IS NOT NULL THEN [1] ELSE [] END |
  MERGE (s:Subject {name: subjName})
  MERGE (imp)-[:DEPICTS]->(s)
)

WITH row, imp
UNWIND (CASE WHEN size(row.genreTerms) = 0 THEN [null] ELSE row.genreTerms END) AS genreName
FOREACH (_ IN CASE WHEN genreName IS NOT NULL THEN [1] ELSE [] END |
  MERGE (g:Genre {name: genreName})
  MERGE (imp)-[:CLASSIFIED_AS]->(g)
)
"""


def _load_csv():
    return pd.read_csv(MET_CSV_PATH, low_memory=False)


def _prints_df(df):
    return df[df["Classification"].astype(str).str.contains("Print", case=False, na=False)]


def select_by_artists(df, artist_names):
    prints = _prints_df(df)
    return prints[prints["Artist Display Name"].isin(artist_names)]


def select_by_object_ids(df, object_ids):
    ids = set(object_ids)
    return df[df["Object ID"].isin(ids)]


def select_all_qualifying(df):
    """The full 20th-century-born-printmaker filter established earlier in the
    project: Classification contains 'Print' AND (first-listed) Artist Begin Date
    1900-1999. Unchanged from v1.0 — this selects the same 10,966 objects."""
    prints = _prints_df(df).copy()

    def begin_year(x):
        try:
            return int(str(x).split("|")[0].strip())
        except (ValueError, TypeError):
            return None

    prints["begin_year"] = prints["Artist Begin Date"].apply(begin_year)
    return prints[(prints["begin_year"] >= 1900) & (prints["begin_year"] <= 1999)]


def _resolve_creator_identities(df):
    """Populates the module-level name->ULAN/Wikidata maps ONCE, across the whole
    selected DataFrame, before any Neo4j writes happen.

    Confirmed by a real failed run: Artist has separate uniqueness constraints on
    name, ulanUrl, AND wikidataUrl (`SHOW CONSTRAINTS`). Met's own CSV data isn't
    internally consistent about which of an artist's rows carry a ULAN/Wikidata URL
    — e.g. Martin Puryear's ULAN URL is populated on some of his prints' rows but not
    others. Resolving each creator's identifier per-chunk (or per-row) means two
    different rows for the same real person can pick two different MERGE keys
    (one via ulanUrl, one via bare name) within — or across — chunks. Neo4j's
    query planner doesn't reliably make the second MERGE see the first MERGE's
    write within one UNWIND-driven statement (a documented Cypher "eager" pitfall),
    so the second MERGE attempts to CREATE a second node with the same name and
    trips the uniqueness constraint. Resolving globally up front, once, guarantees
    every occurrence of a given name uses the identical identifier for the entire
    run, so this can't happen — and as a side benefit, an artist whose ULAN URL
    is only recorded on SOME of their prints now gets correctly identified on all
    of them, not just the rows where Met happened to populate it.
    """
    global _CREATOR_ULAN_BY_NAME, _CREATOR_WIKIDATA_BY_NAME
    ulan_by_name, wikidata_by_name = {}, {}
    for r in df.to_dict("records"):
        names = _split_pipe(r.get("Artist Display Name"))
        roles = _split_pipe(r.get("Artist Role"))
        ulans = _split_pipe(r.get("Artist ULAN URL"))
        wikidatas = _split_pipe(r.get("Artist Wikidata URL"))
        for i, raw_name in enumerate(names):
            name = _clean(raw_name)
            if not name or _classify_role(roles[i] if i < len(roles) else None) != "creator":
                continue
            ulan = _none_if_placeholder(_clean(ulans[i] if i < len(ulans) else None))
            if ulan and name not in ulan_by_name:
                ulan_by_name[name] = ulan
            wikidata = _none_if_placeholder(_clean(wikidatas[i] if i < len(wikidatas) else None))
            if wikidata and name not in wikidata_by_name:
                wikidata_by_name[name] = wikidata
    _CREATOR_ULAN_BY_NAME = ulan_by_name
    _CREATOR_WIKIDATA_BY_NAME = wikidata_by_name


RECONCILE_QUERY = """
UNWIND $entries AS e
OPTIONAL MATCH (byName:Artist {name: e.name})
OPTIONAL MATCH (ulanOwner:Artist {ulanUrl: e.ulanUrl}) WHERE e.ulanUrl IS NOT NULL
OPTIONAL MATCH (wikiOwner:Artist {wikidataUrl: e.wikidataUrl}) WHERE e.wikidataUrl IS NOT NULL
FOREACH (_ IN CASE
    WHEN byName IS NOT NULL AND e.ulanUrl IS NOT NULL AND byName.ulanUrl IS NULL AND ulanOwner IS NULL
    THEN [1] ELSE [] END |
  SET byName.ulanUrl = e.ulanUrl
)
FOREACH (_ IN CASE
    WHEN byName IS NOT NULL AND e.wikidataUrl IS NOT NULL AND byName.wikidataUrl IS NULL AND wikiOwner IS NULL
    THEN [1] ELSE [] END |
  SET byName.wikidataUrl = e.wikidataUrl
)
"""


def _reconcile_existing_artists():
    """Runs once, right after _resolve_creator_identities(), before any chunked
    writes. Confirmed by a real crash: a prior partial ingest (the old API-based
    v1 script, and this script's own first, buggy attempt) already created some
    Artist nodes keyed by name alone, because the object row it happened to see
    didn't carry that artist's ULAN/Wikidata URL. Now that the global identity map
    knows the correct identifier (from a DIFFERENT row for the same artist), the
    chunked load's MERGE-by-ulanUrl would try to CREATE a second node and collide
    with the uniqueness constraint on name. This promotes the identifier onto the
    EXISTING name-keyed node first, so the chunked load finds one node, not two.
    Guarded against a second node already owning that identifier (byOwner checks)
    so this can't itself trip a uniqueness violation."""
    entries = [
        {"name": name, "ulanUrl": _CREATOR_ULAN_BY_NAME.get(name), "wikidataUrl": _CREATOR_WIKIDATA_BY_NAME.get(name)}
        for name in set(_CREATOR_ULAN_BY_NAME) | set(_CREATOR_WIKIDATA_BY_NAME)
    ]
    if not entries:
        return
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            session.run(RECONCILE_QUERY, entries=entries).consume()
    finally:
        driver.close()


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    """Neo4j connections to AuraDB Free have been observed to drop mid-session
    (confirmed: a live bulk run died on SessionExpired after 400/10966 objects with
    no retry handling). Rebuild the driver fresh on each attempt rather than reusing
    a possibly-defunct connection — a plain query retry on the same driver instance
    would likely hit the same dead socket."""
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(LOAD_QUERY, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def run(df, chunk_size=200):
    """No network calls, no rate limit — this is a purely local CSV-to-graph load.
    The only real failure mode left is the AuraDB connection drop _write_chunk_with_retry
    already guards against."""
    _resolve_creator_identities(df)
    _reconcile_existing_artists()
    records = df.to_dict("records")
    total = len(records)
    start = time.time()
    for chunk_start in range(0, total, chunk_size):
        chunk = records[chunk_start:chunk_start + chunk_size]
        rows = [map_record(r) for r in chunk]
        _write_chunk_with_retry(rows)

        done = chunk_start + len(chunk)
        elapsed = time.time() - start
        print(f"[PROGRESS] {done}/{total} done | elapsed={elapsed:.0f}s | "
              f"est_remaining={(elapsed/done)*(total-done):.0f}s | resume_with: --skip {done}",
              flush=True)
    print(f"[DONE] total={total} elapsed={time.time()-start:.0f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artists", help="Comma-separated Artist Display Name values")
    parser.add_argument("--object-ids", help="Comma-separated Met Object IDs")
    parser.add_argument("--all", action="store_true",
                         help="Ingest every object matching the 20th-century-born-printmaker filter")
    parser.add_argument("--limit", type=int, help="Cap the number of objects (for a test run with --all)")
    parser.add_argument("--skip", type=int, default=0,
                         help="Skip the first N objects in the --all list (for resuming after a crash)")
    args = parser.parse_args()

    full_df = _load_csv()

    if args.object_ids:
        ids = [int(x) for x in args.object_ids.split(",")]
        selected = select_by_object_ids(full_df, ids)
    elif args.artists:
        selected = select_by_artists(full_df, [a.strip() for a in args.artists.split(",")])
    elif args.all:
        selected = select_all_qualifying(full_df)
        if args.skip:
            selected = selected.iloc[args.skip:]
        if args.limit:
            selected = selected.iloc[:args.limit]
    else:
        parser.error("Provide --artists, --object-ids, or --all")

    print(f"Ingesting {len(selected)} object(s)...", flush=True)
    run(selected)
