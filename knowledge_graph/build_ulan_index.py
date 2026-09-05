"""
PrintMasterAI — build a local SQLite mirror of Getty ULAN's person records, for fast
name search + an occupation filter that the live SPARQL endpoint doesn't support.
See docs/adr/0012-local-ulan-mirror.md for the full design and rationale.

Source: Getty's official ULAN LOD bulk release ("explicit" variant — explicitly
asserted facts only, no precomputed transitive closure), ODC-BY 1.0 licensed:
    http://ulandownloads.getty.edu/VocabData/explicit.zip   (395 MB compressed)

That zip contains 22 separate N-Triples files (8.8 GB uncompressed total); this build
only reads the 6 that are actually needed (~3.4 GB), verified by direct inspection
2026-08-31:
  - ULANOut_1Subjects.nt     rdf:type -> PersonConcept
  - ULANOut_2Terms.nt        name labels, two-hop: subject -> prefLabelGVP/altLabel ->
                              term URI -> skosxl:literalForm (the actual string)
  - ULANOut_AgentTypes.nt    agentType / agentTypePreferred -> AAT role concept URIs
  - ULANOut_AgentMap.nt      subject -> foaf:focus -> "-agent" URI (needed for bio)
  - ULANOut_Biographies.nt   "-agent" URI -> biographyPreferred -> bio URI ->
                              schema:description -> the actual bio text
  - ULANOut_WikidataAlignment.nt   subject -> skos:exactMatch -> Wikidata QID (bonus)

Usage:
    python3 build_ulan_index.py --zip /path/to/explicit.zip
    python3 build_ulan_index.py --zip /path/to/explicit.zip --limit 5000   # smoke test
"""
import argparse
import json
import os
import re
import sqlite3
import time
import zipfile

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulan_local.sqlite")

# AAT role concept ids, resolved to real labels via a one-time batch SPARQL lookup
# against Getty's AAT (2026-08-31) — the 80 most frequent roles across all 353,510 ULAN
# person records in this download. NOT guessed: an earlier version of this file
# mislabeled 300025157 as "sculptors" by loose correlation (it's actually
# "watercolorists" — the real sculptors id, 300025181, only surfaced once actual AAT
# labels were pulled). Keep AAT id sourcing to confirmed labels, not correlation, going
# forward — correlation on one example is not reliable enough to commit to a filter.

# Strict printmaking-technique roles — this is the primary filter this project actually
# needs ("identify printmakers, etchers and related" per user direction 2026-08-31).
# Deliberately excludes 300025732 "printers (people)" — that's the production/press-
# operator role, already modeled separately in this graph's schema as a Printer/
# Publisher node with a PRINTED_BY edge, distinct from the Artist/CREATED edge; folding
# it into "printmaker" would conflate two roles the graph already keeps apart.
PRINTMAKER_AAT_IDS = {
    "300025164",  # printmakers
    "300025165",  # engravers (printmakers)
    "300025174",  # etchers
    "300025175",  # lithographers
}

# Broader visual-artist set (mirrors the Wikidata-side filter's intent) — kept for
# comparison/fallback use, not the primary filter. NOTE (verified empirically 2026-08-31,
# see docs/adr/0012-local-ulan-mirror.md): 196,495 of 221,169 (88.8%) of records
# matching this broader set carry ONLY the generic 300025103 "artists" tag with no more
# specific role — including at least one confirmed non-print-artist (an American
# filmmaker, ULAN 500345510) who has no other role tag to distinguish him. This set is
# knowingly imprecise; PRINTMAKER_AAT_IDS above is the one to actually filter on.
ARTIST_AAT_IDS = {
    "300025103",  # artists (visual artists) — general, imprecise per the note above
    "300025136",  # painters (artists)
    "300025164",  # printmakers
    "300025165",  # engravers (printmakers)
    "300025174",  # etchers
    "300025175",  # lithographers
    "300112172",  # draftsmen (artists)
    "300237351",  # portraitists
    "300025181",  # sculptors (corrected 2026-08-31 — was wrongly 300025157)
    "300025123",  # illustrators (confirmed via AAT label lookup)
    "300264850",  # graphic artists
}

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
PERSON_CONCEPT = "http://vocab.getty.edu/ontology#PersonConcept"
AGENT_TYPE_PREF = "http://vocab.getty.edu/ontology#agentTypePreferred"
AGENT_TYPE_NONPREF = "http://vocab.getty.edu/ontology#agentTypeNonPreferred"
FOAF_FOCUS = "http://xmlns.com/foaf/0.1/focus"
BIO_PREFERRED = "http://vocab.getty.edu/ontology#biographyPreferred"
SCHEMA_DESCRIPTION = "http://schema.org/description"
PREF_LABEL_GVP = "http://vocab.getty.edu/ontology#prefLabelGVP"
ALT_LABEL = "http://www.w3.org/2008/05/skos-xl#altLabel"
LITERAL_FORM = "http://www.w3.org/2008/05/skos-xl#literalForm"
EXACT_MATCH = "http://www.w3.org/2004/02/skos/core#exactMatch"

_TRIPLE_RE = re.compile(r'^<([^>]*)>\s+<([^>]*)>\s+(.*)\s\.\s*$')
_LIT_RE = re.compile(r'^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]*>)?$')
_ESCAPE_RE = re.compile(r'\\([tnr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})')
_ULAN_ID_RE = re.compile(r'/ulan/(\d+)$')


_SIMPLE_ESCAPES = {"t": "\t", "n": "\n", "r": "\r", '"': '"', "\\": "\\"}


def _unescape(s):
    def repl(m):
        e = m.group(1)
        if len(e) == 1:
            return _SIMPLE_ESCAPES[e]
        return chr(int(e[1:], 16))  # \uXXXX or \UXXXXXXXX
    return _ESCAPE_RE.sub(repl, s)


def parse_line(line):
    """Returns (subject, predicate, object, is_literal) or None for a malformed line."""
    m = _TRIPLE_RE.match(line)
    if not m:
        return None
    subj, pred, obj_raw = m.groups()
    obj_raw = obj_raw.strip()
    if obj_raw.startswith("<") and obj_raw.endswith(">"):
        return subj, pred, obj_raw[1:-1], False
    if obj_raw.startswith('"'):
        lm = _LIT_RE.match(obj_raw)
        if not lm:
            return None
        return subj, pred, _unescape(lm.group(1)), True
    return None


def _ulan_id(uri):
    m = _ULAN_ID_RE.search(uri)
    return m.group(1) if m else None


def _open(zf, name):
    return zf.open(name, "r")


def pass_person_ids(zf, limit=None):
    """1Subjects.nt -> the set of subject ids that are rdf:type PersonConcept."""
    persons = set()
    with _open(zf, "ULANOut_1Subjects.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if pred == RDF_TYPE and not is_lit and obj == PERSON_CONCEPT:
                pid = _ulan_id(subj)
                if pid:
                    persons.add(pid)
                    if limit and len(persons) >= limit:
                        break
    return persons


def pass_agent_types(zf, persons):
    """AgentTypes.nt -> {ulan_id: {"types": [...], "preferred": id_or_None}}"""
    out = {}
    with _open(zf, "ULANOut_AgentTypes.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if is_lit or pred not in (AGENT_TYPE_PREF, AGENT_TYPE_NONPREF):
                continue
            pid = _ulan_id(subj)
            if pid not in persons:
                continue
            aat_id = obj.rsplit("/", 1)[-1]
            entry = out.setdefault(pid, {"types": [], "preferred": None})
            entry["types"].append(aat_id)
            if pred == AGENT_TYPE_PREF:
                entry["preferred"] = aat_id
    return out


def pass_agent_map(zf, persons):
    """AgentMap.nt -> {ulan_id: agent_uri} via foaf:focus."""
    out = {}
    with _open(zf, "ULANOut_AgentMap.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if is_lit or pred != FOAF_FOCUS:
                continue
            pid = _ulan_id(subj)
            if pid in persons:
                out[pid] = obj
    return out


def pass_bios(zf, agent_uris):
    """Biographies.nt, two sub-passes: agent_uri -> bio_uri (preferred only), then
    bio_uri -> description text, restricted to the bio_uris we actually need."""
    needed_agents = set(agent_uris.values())
    agent_to_bio = {}
    with _open(zf, "ULANOut_Biographies.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if is_lit or pred != BIO_PREFERRED or subj not in needed_agents:
                continue
            agent_to_bio[subj] = obj
    needed_bios = set(agent_to_bio.values())
    bio_to_text = {}
    with _open(zf, "ULANOut_Biographies.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if not is_lit or pred != SCHEMA_DESCRIPTION or subj not in needed_bios:
                continue
            bio_to_text[subj] = obj
    return {
        pid: bio_to_text.get(agent_to_bio.get(agent_uri, ""))
        for pid, agent_uri in agent_uris.items()
        if agent_uri in agent_to_bio
    }


def pass_names(zf, persons):
    """2Terms.nt, two sub-passes: (subject, term_uri, is_pref) filtered to our persons,
    then term_uri -> literal text restricted to the term_uris we actually need."""
    subj_terms = []  # (ulan_id, term_uri, is_pref)
    with _open(zf, "ULANOut_2Terms.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if is_lit or pred not in (PREF_LABEL_GVP, ALT_LABEL):
                continue
            pid = _ulan_id(subj)
            if pid in persons:
                subj_terms.append((pid, obj, pred == PREF_LABEL_GVP))
    needed_terms = set(term for _, term, _ in subj_terms)
    term_text = {}
    with _open(zf, "ULANOut_2Terms.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if not is_lit or pred != LITERAL_FORM or subj not in needed_terms:
                continue
            term_text[subj] = obj
    names = {}  # ulan_id -> [(text, is_pref), ...]
    for pid, term, is_pref in subj_terms:
        text = term_text.get(term)
        if text:
            names.setdefault(pid, []).append((text, is_pref))
    return names


def pass_wikidata(zf, persons):
    out = {}
    with _open(zf, "ULANOut_WikidataAlignment.nt") as f:
        for raw in f:
            t = parse_line(raw.decode("utf-8", "replace"))
            if not t:
                continue
            subj, pred, obj, is_lit = t
            if is_lit or pred != EXACT_MATCH or "wikidata.org" not in obj:
                continue
            pid = _ulan_id(subj)
            if pid in persons:
                qid = obj.rsplit("/", 1)[-1]
                out[pid] = qid
    return out


def build(zip_path, db_path, limit=None):
    t0 = time.time()
    if os.path.exists(db_path):
        os.remove(db_path)
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE ulan_person (
            ulan_id TEXT PRIMARY KEY,
            pref_name TEXT,
            agent_types TEXT NOT NULL,
            agent_type_preferred TEXT,
            bio TEXT,
            wikidata_qid TEXT,
            is_artist INTEGER NOT NULL,
            is_printmaker INTEGER NOT NULL
        );
        CREATE TABLE ulan_name (
            ulan_id TEXT NOT NULL REFERENCES ulan_person(ulan_id),
            name TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE ulan_name_fts USING fts5(name, ulan_id UNINDEXED);
        CREATE INDEX idx_ulan_name_ulan_id ON ulan_name(ulan_id);
    """)

    with zipfile.ZipFile(zip_path) as zf:
        print("[1/6] Subjects -> person ids ...", flush=True)
        persons = pass_person_ids(zf, limit=limit)
        print(f"      {len(persons)} person records", flush=True)

        print("[2/6] AgentTypes -> occupation ...", flush=True)
        agent_types = pass_agent_types(zf, persons)
        n_artist = sum(
            1 for e in agent_types.values() if set(e["types"]) & ARTIST_AAT_IDS
        )
        n_printmaker = sum(
            1 for e in agent_types.values() if set(e["types"]) & PRINTMAKER_AAT_IDS
        )
        print(f"      {len(agent_types)} with role data, {n_artist} classified as artist, "
              f"{n_printmaker} classified as printmaker", flush=True)

        print("[3/6] AgentMap -> agent uris ...", flush=True)
        agent_map = pass_agent_map(zf, persons)
        print(f"      {len(agent_map)} agent links", flush=True)

        print("[4/6] Biographies -> bio text ...", flush=True)
        bios = pass_bios(zf, agent_map)
        print(f"      {len(bios)} bios resolved", flush=True)

        print("[5/6] Terms -> names ...", flush=True)
        names = pass_names(zf, persons)
        n_names = sum(len(v) for v in names.values())
        print(f"      {n_names} name rows across {len(names)} persons", flush=True)

        print("[6/6] WikidataAlignment ...", flush=True)
        wikidata = pass_wikidata(zf, persons)
        print(f"      {len(wikidata)} wikidata links", flush=True)

    print("Writing SQLite ...", flush=True)
    person_rows = []
    name_rows = []
    for pid in persons:
        entry = agent_types.get(pid, {"types": [], "preferred": None})
        entry_types = set(entry["types"])
        is_artist = 1 if entry_types & ARTIST_AAT_IDS else 0
        is_printmaker = 1 if entry_types & PRINTMAKER_AAT_IDS else 0
        pname_list = names.get(pid, [])
        pref = next((t for t, is_pref in pname_list if is_pref), None)
        if pref is None and pname_list:
            pref = pname_list[0][0]
        person_rows.append((
            pid, pref, json.dumps(entry["types"]), entry["preferred"],
            bios.get(pid), wikidata.get(pid), is_artist, is_printmaker,
        ))
        for text, _ in pname_list:
            name_rows.append((pid, text))

    conn.executemany(
        "INSERT INTO ulan_person VALUES (?,?,?,?,?,?,?,?)", person_rows
    )
    conn.executemany(
        "INSERT INTO ulan_name (ulan_id, name) VALUES (?,?)", name_rows
    )
    conn.execute("INSERT INTO ulan_name_fts (rowid, name, ulan_id) SELECT rowid, name, ulan_id FROM ulan_name")
    conn.commit()

    print(f"\nDone in {time.time()-t0:.0f}s -> {db_path}", flush=True)
    print(f"  {len(person_rows)} persons, {len(name_rows)} names, "
          f"{sum(1 for r in person_rows if r[6])} artists, "
          f"{sum(1 for r in person_rows if r[7])} printmakers", flush=True)
    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, help="Path to Getty's explicit.zip")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--limit", type=int, help="Cap on person count, for a smoke test")
    args = ap.parse_args()
    build(args.zip, args.db, limit=args.limit)
