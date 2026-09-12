"""
PrintMasterAI — Artist-node record extraction for probabilistic linkage.
Version: ARTIST-SPLINK-EXTRACT-1.0

Pulls one record per Artist node and derives the name keys the linkage model blocks and
compares on. Writes a parquet; touches nothing in the graph.

NAME DERIVATION mirrors `find_artist_merge_candidates.py` deliberately, so the two
generators disagree about candidates rather than about what a name IS:
  - NFKD accent-strip, punctuation removal, case-fold, whitespace collapse
  - post-nominals / titles / trailing life-dates stripped (the `honorific` rule's list)
  - "Surname, Forename" inverted to "Forename Surname" before tokenising, because
    Roseberys and Forum emit inverted forms and a bag-of-words comparison would otherwise
    be the only thing that could see through it.

`tokens` is the sorted normalised bag of words and is what makes word-order and
middle-name-insertion invisible to the comparison layer. `surname_mp` is the metaphone of
the last token — the only phonetic key here, and it exists for the typo class
("Trevelyan"/"Treveyan") that no exact normalisation reaches.
"""
import os, re, unicodedata, sys
import jellyfish, pandas as pd
from ulan_url import ulan_id
from dotenv import load_dotenv
from neo4j import GraphDatabase

HONORIFICS = {
    "ra","ara","pra","re","rgi","rws","rba","rsa","prsa","rsw","hrha","rha","ari","rca",
    "arca","dlitt","cbe","obe","mbe","kbe","dbe","om","ch","frsa","frs","sir","dame","lady",
    "hon","prof","professor","dr","mr","mrs","ms","miss","rp","nems","aria","rwa","arwa",
}
# ATTRIBUTION QUALIFIERS ARE STRIPPED FROM THE NAME AND KEPT AS A SEPARATE FIELD.
# They must not survive into the name, or "Style of Salvador Dali" never blocks against
# "Salvador Dali" and the pair is never looked at. They must not be silently DISCARDED
# either: in the print market "After X" is a reproductive print by someone else and
# "Style of X" is a disclaimer of authorship, so a qualifier on one side and not the other
# is evidence of DIFFERENT nodes, not a spelling variant. Both were live in the first run —
# "Style of Salvador Dali" collided exactly onto "Salvador Dali" under normalisation alone.
QUALIFIER_RE = re.compile(
    r"^\s*(after|attributed\s+to|attrib(?:uted)?\.?|circle\s+of|school\s+of|studio\s+of|"
    r"workshop\s+of|follower\s+of|manner\s+of|style\s+of|in\s+the\s+style\s+of|"
    r"imitator\s+of|copy\s+after|bears\s+signature)\b", re.I)
PREFIX_NOISE = {"after","attributed","to","circle","of","school","follower","manner","style",
                "studio","workshop","imitator","copy","bears","signature","in","the"}

ALL_ARTISTS = """
MATCH (a:Artist)
OPTIONAL MATCH (a)-[:CREATED]->(cw:ConceptualWork)
WITH a, count(DISTINCT cw) AS works
OPTIONAL MATCH (a)-[:CREATED]->(:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
              -[:INCLUDES]->(:Impression)<-[:SHOWS]-(img:DigitalImage)
WHERE img.embedding IS NOT NULL
WITH a, works, count(img) AS embedded
OPTIONAL MATCH (src:SourceRecord)-[:ATTRIBUTED_TO]->(a)
RETURN elementId(a)          AS node_id,
       a.name                AS name,
       a.alternateNames      AS alt_names,
       a.dateBorn_year       AS born,
       a.dateDied_year       AS died,
       a.nationality         AS nationality,
       a.birthPlace          AS birth_place,
       a.deathPlace          AS death_place,
       a.ulanUrl             AS ulan,
       a.wikidataUrl         AS wikidata,
       works, embedded,
       collect(DISTINCT src.institutionName)[..6] AS sources
"""


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def qualifier_of(raw):
    """The attribution qualifier carried by a name, normalised, or '' if the name asserts
    authorship outright. Never folded into the name — see QUALIFIER_RE."""
    m = QUALIFIER_RE.match(strip_accents(str(raw or "")))
    return re.sub(r"\s+", " ", m.group(1).lower()) if m else ""


def normalise(raw):
    """Lowercase, de-accent, drop punctuation, strip honorifics/life-dates, un-invert."""
    if not raw:
        return "", []
    s = strip_accents(str(raw)).lower()
    s = re.sub(r"\b1[0-9]{3}\s*[-–—]\s*1?[0-9]{3,4}\b", " ", s)   # trailing life dates
    s = re.sub(r"\(.*?\)", " ", s)                                 # parenthetical asides
    if "," in s:                                                   # "surname, forename"
        head, _, tail = s.partition(",")
        if tail.strip() and not re.search(r"\d", tail):
            s = f"{tail} {head}"
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    toks = [t for t in s.split() if t and t not in HONORIFICS and t not in PREFIX_NOISE]
    toks = [t for t in toks if not (len(t) == 1 and t.isdigit())]
    return " ".join(toks), toks


def build(rec):
    norm, toks = normalise(rec["name"])
    alt_toks = set()
    for a in (rec.get("alt_names") or []):
        _, at = normalise(a)
        alt_toks.update(at)
    raw = str(rec["name"] or "")
    surname = toks[-1] if toks else ""
    forenames = toks[:-1]
    return {
        "unique_id": rec["node_id"],
        "name": rec["name"],
        "norm": norm,
        "tokens": sorted(set(toks)),
        "token_key": " ".join(sorted(set(toks))),
        "surname": surname,
        "surname_mp": jellyfish.metaphone(surname) if surname else "",
        "surname_3": surname[:3],
        "forenames": " ".join(forenames),
        "forename1": forenames[0] if forenames else "",
        "initials": "".join(t[0] for t in toks),
        "alt_tokens": sorted(alt_toks),
        "n_tokens": len(set(toks)),
        "born": rec["born"], "died": rec["died"],
        "nationality": (rec["nationality"] or "").strip().lower() or None,
        "birth_place": (rec["birth_place"] or "").strip().lower() or None,
        "ulan": rec["ulan"], "ulan_id": ulan_id(rec["ulan"]),
        "wikidata": rec["wikidata"],
        "works": rec["works"], "embedded": rec["embedded"],
        "qualifier": qualifier_of(rec["name"]),
        # A CONJUNCTION MAKES A COLLABORATION NODE, NOT A NAME VARIANT. "Colin Self and
        # Christopher Logue" contains every token of "Colin Self", so the token-subset level
        # fires on it exactly as it fires on the Matta split — and it is the Calder trap in a
        # second form: a real, different entity whose name properly contains another's. It was
        # the largest false-positive class in the first triage (Jake and Dinos Chapman against
        # Jake Chapman, Christopher Wool and Felix Gonzalez-Torres against Christopher Wool).
        # Parentheticals are excluded because a bracketed real name behind a pseudonym is not a
        # collaboration — "The Miaz Brothers (Roberto and Renato Miaz)" is one entity.
        "has_conjunction": bool(re.search(r"\s(?:and|&|with|et)\s",
                                          re.sub(r"\(.*?\)|\[.*?\]", " ", raw), re.I)),
        # Placeholder nodes are not artists and must never be merged into one.
        "is_placeholder": bool(re.match(
            r"^(anon|anonymous|unknown|various|unidentified|monogrammist|master\b)", norm)
            or re.search(r"\b(century|school|circle|various artists)\b", norm)),
        # trailing "&" is a multi-artist lot header the parser left behind ("Andy Warhol
        # (American 1928-1987) &"), not a name variant. Reported, never merged on.
        "multi_artist": bool(re.search(r"&\s*$", raw)),
        "sources": "|".join(sorted(s for s in (rec["sources"] or []) if s)),
    }


def main():
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    uri, user, pw = os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")
    if not all([uri, user, pw]):
        sys.exit("NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD must be set")
    drv = GraphDatabase.driver(uri, auth=(user, pw))
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        rows = [build(r) for r in s.run(ALL_ARTISTS)]
    drv.close()
    df = pd.DataFrame(rows)
    out = sys.argv[1] if len(sys.argv) > 1 else "artist_records.parquet"
    df.to_parquet(out, index=False)
    print(f"{len(df):,} artist records -> {out}")
    print(f"  with born year : {df.born.notna().sum():,}")
    print(f"  with ULAN      : {df.ulan.notna().sum():,} "
          f"({df.ulan_id.nunique():,} distinct ids from {df.ulan.nunique():,} distinct urls)")
    print(f"  with embeddings: {(df.embedded>0).sum():,}")
    print(f"  blank norm     : {(df.norm=='').sum():,}")
    print(f"  with qualifier : {(df.qualifier!='').sum():,}")
    print(f"  multi-artist   : {df.multi_artist.sum():,}")
    print("\nlargest surname blocks:")
    print(df.surname.value_counts().head(12).to_string())


if __name__ == "__main__":
    main()
