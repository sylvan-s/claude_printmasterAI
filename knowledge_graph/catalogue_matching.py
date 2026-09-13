"""
PrintMasterAI — shared catalogue-raisonné-citation parsing and ConceptualWork identity
keying, used by forum_ingest.py and roseberys_ingest.py.

Extracted 2026-09-06 so a second adapter (roseberys_ingest.py) doesn't duplicate
forum_ingest.py's parsing regex and identity-keying rule and risk drifting from it —
same discipline crosswalk_matching.py's own docstring already established for
technique/paper vocabulary ("the two divergent lists problem").

The identity-keying rule here is stricter than it first looks, and every part of that
strictness was earned by a real, confirmed corruption incident during the Forum
backfill (doc 09 §7.6/§7.7), not designed defensively in the abstract:

  1. **Catalogue + entry number alone is not safe** — some catalogue-name prefixes are
     dealer/cataloguer names reused across MULTIPLE different artists (confirmed:
     Forum's "Cramer 56" collided Henry Moore with Picasso). Fixed by folding the
     artist's own cleaned name into the key.
  2. **Artist + catalogue + entry is STILL not safe** — some catalogue numbering
     operates at portfolio/series level, not per-plate. A single citation can
     legitimately cover several genuinely different prints by the SAME artist
     (confirmed, the hard way: "Cramer 30" for Chagall covered 6 different Bible
     plates — Samson and Delilah, Aaron et le Chandelier, Joshua Before Jericho,
     Jacob's Ladder, Lot and His Daughters, Isaiah — and the first version of this
     fix, validated only by a fuzzy name-similarity threshold, wrongly merged all 6
     into one ConceptualWork because their titles shared enough common scaffolding
     text ("...from Bible (Cramer 30)") to score above the threshold despite being
     different subjects entirely. A second real case, Stik's "No. 458" — actually a
     mis-parsed EDITION number, not a catalogue citation at all, see point 3 — merged
     5 different colourway prints ("Holding Hands" in Yellow/Orange/Red) because the
     validation's own title-normalization step stripped ALL parenthetical text before
     comparing, erasing the exact colour-name detail that distinguished them). The
     fix: require the normalized TITLE to match, not just similarity-score it. This
     is deliberately conservative — a genuine duplicate whose title text drifted even
     slightly between two listings (different punctuation, an added subtitle) will
     NOT merge, staying as two separate ConceptualWork nodes instead. That is the
     correct trade-off: under-merging leaves the graph correct, just not maximally
     deduplicated; over-merging corrupts it by treating two different real prints as
     one. No similarity threshold, fuzzy or otherwise, is used anywhere in this
     module for that reason.
  3. **The regex itself produces confident-looking garbage on plain descriptive text**
     that merely happens to end in a token — confirmed real cases, not hypothetical:
     "No. 458" (an EDITION number, not a catalogue citation — spanned 5 completely
     unrelated Stik prints), "Set of 8" (a title phrase shared by four unrelated
     artists), "American 1928-1987"/"British b. 1956-" (nationality + life-date
     fragments from the same free-text field). `NON_CATALOGUE_NAMES` excludes these
     confirmed-bad matches from both identity-keying and `CatalogueRaisonne`/
     `CatalogueEntry` creation — they are not real catalogue data with no home
     elsewhere (doc 09 §1's UNMAPPED category), they are noise from a fragile
     "last token = entry number" heuristic and get no home at all.
  4. **"Lugt" numbers catalogue collector/provenance MARKS, not artworks** — two
     different prints legitimately sharing a Lugt number is expected and correct, not
     a bug, so the whole prefix is untrustworthy for artwork-identity purposes
     regardless of artist or title agreement.

None of this replaces per-adapter validation before a real backfill — it lowers the
odds of the mistake, it doesn't guarantee correctness on data this module has never
seen. Always re-verify with a live query after running a backfill that uses this
module, the way doc 09 §7.6/§7.7 did, rather than trusting a clean script exit.
"""

import re

_CATALOGUE_REF_RE = re.compile(r"^(.+?)\s+(\S+)$")

# Confirmed-bad matches from real data (see module docstring point 3) — case-
# insensitive exact match against the parsed catalogueName. Extend this list only
# from a CONFIRMED case (checked against the actual source rows), never speculatively.
NON_CATALOGUE_NAMES = {
    "no.", "no", "set of", "untitled", "lugt",
    # Page references, not catalogues. Confirmed: Bonhams' "V. 182, p. 258" for Braque
    # (Vallier 182, page 258) produced a CatalogueRaisonne node literally named "V. 182, p."
    "p.", "p", "pp.", "pp", "page",
    "american", "british", "german", "french", "italian", "spanish", "dutch", "swiss",
    "american b.", "british b.", "belgian", "austrian", "russian", "japanese",
}


def _is_standalone_citation(fragment):
    """True only for '<something with letters> <token starting with a digit>'. The
    digit requirement is what makes the comma rule below safe: without it "Scottish Arts
    Council" parses as name "Scottish Arts" + number "Council" and looks like a citation.
    Confirmed against real Bonhams values, where that exact string appears."""
    m = _CATALOGUE_REF_RE.match(fragment.strip())
    return bool(m and re.search(r"[A-Za-z]", m.group(1)) and m.group(2)[:1].isdigit())


def _split_on_commas_when_unambiguous(part):
    """Some sources separate multiple citations with a COMMA rather than a semicolon
    ("Bloch 182, Baer 340"), which the semicolon-only split turns into the prefix
    "Bloch 182, Baer" — confirmed live: ~20 such CatalogueRaisonne nodes exist in the
    graph, all from Bonhams.

    A blind comma split is far more dangerous than the bug. **1,164 of 2,958 prefixes in
    this graph contain a comma**, and most are legitimate multi-author catalogue names:
    "Cramer, Grant & Mitchinson 1973" (75 entries), "Meyrick & Heuser 2015",
    "Fox-Weber & Cleaton-Roberts 2025". Splitting those corrupts far more than it repairs.

    So the split is accepted ONLY when EVERY resulting fragment is independently a
    citation by _is_standalone_citation. "Bloch 182, Baer 340" -> both fragments qualify,
    split. "Cramer, Grant & Mitchinson 1973 45" -> the fragment "Cramer" carries no
    number, so the comma is treated as part of the name and the value is left whole.

    Measured before adopting: zero change across all 1,887 distinct catalogue_refs values
    in the Forum/Roseberys extracts and all 107 in the Bonhams descriptions — i.e. it
    never fires destructively on data this project actually holds. It is PREVENTIVE. The
    inputs that produced the ~20 malformed nodes are not reproducible from the current
    Bonhams file, so this rule is not demonstrated to repair them; those nodes are fixed
    directly by repair_comma_split_catalogue_entries.py instead."""
    if "," not in part:
        return [part]
    fragments = [f.strip() for f in part.split(",")]
    if len(fragments) > 1 and all(_is_standalone_citation(f) for f in fragments):
        return fragments
    return [part]


def parse_catalogue_refs(raw):
    """'Delteil 2' -> [{"catalogueName": "Delteil", "entryNumber": "2"}]. Multiple refs
    are ';'-separated ('Lugt 3439; De Vesme 732'), or ','-separated when every fragment
    is unambiguously its own citation — see _split_on_commas_when_unambiguous. A value
    with no letters before the last token doesn't match the numbering-system-prefix model
    and is skipped."""
    if not raw:
        return []
    refs = []
    for part in raw.split(";"):
        for fragment in _split_on_commas_when_unambiguous(part.strip()):
            fragment = fragment.strip()
            if not fragment:
                continue
            m = _CATALOGUE_REF_RE.match(fragment)
            if m and re.search(r"[A-Za-z]", m.group(1)):
                refs.append({"catalogueName": m.group(1).strip(),
                             "entryNumber": m.group(2).strip()})
    return refs


def genuine_refs(refs):
    """Filters out NON_CATALOGUE_NAMES matches — use this before both identity-keying
    and CatalogueRaisonne/CatalogueEntry creation, never the raw parse_catalogue_refs
    output directly for either purpose."""
    return [r for r in refs if r["catalogueName"].strip().lower() not in NON_CATALOGUE_NAMES]


def sanitize_id_part(s):
    return re.sub(r"\s+", "_", s.strip())


def normalize_title(s):
    """Lowercase, alphanumeric-only comparison key. Deliberately does NOT strip
    parentheticals — see module docstring point 2 for the real corruption that
    stripping them caused (erasing a colour-variant detail that was the only thing
    distinguishing two different prints)."""
    s = (s or "").lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def build_conceptual_work_id(source_prefix, artist_name, title, catalogue_refs, fallback_id):
    """Returns the ConceptualWork id to use: `{source_prefix}-cw-{artist}-{catalogue}-
    {entry}-{title}` when a genuine catalogue ref exists (first one, if several),
    otherwise `fallback_id` (the source's own per-lot/per-accession id — graceful
    degradation, same as doc 08 §4.1's V&A case). The normalized title is part of the
    key itself, not a post-hoc validation step, so two lots can only ever share a
    ConceptualWork if their title text matches exactly in addition to citing the same
    artist+catalogue+entry — see module docstring point 2 for why this is
    non-negotiable, not a stylistic choice."""
    refs = genuine_refs(catalogue_refs)
    if not refs:
        return fallback_id
    first = refs[0]
    return (
        f"{source_prefix}-cw-{sanitize_id_part(artist_name)}"
        f"-{sanitize_id_part(first['catalogueName'])}-{sanitize_id_part(first['entryNumber'])}"
        f"-{sanitize_id_part(normalize_title(title))}"
    )


def resolve_merged_work_cypher(candidate, carry):
    """Cypher that binds `cw` to the ConceptualWork this id belongs to NOW — following any
    recorded merge — creating the node only if nothing has been merged onto it.

    WHY THIS EXISTS. A source with no catalogue citation keys its ConceptualWork on its own
    object id (see build_conceptual_work_id's fallback), so each accession is its own work. That
    is deliberate and stays: there is nothing exact to join impressions on, and joining them on
    title alone is the fuzzy identity matching this module exists to forbid.

    The defect was never the KEY. It was that re-ingest ignored decisions already taken. A merge
    DETACH DELETEs the folded node, so the next load MERGEs its id back into existence as a fresh
    ConceptualWork and the work is split again — 4,226 merges made on 2026-09-12/13 would have
    been undone by one re-run of navigart or tate.

    This is not similarity matching and does not weaken the prohibition. It is an EXACT id
    lookup against MergeEvent.mergedFromId — a decision some rule, model or person already made
    and recorded — and it resolves chains for free, because merge_duplicate_work_clusters.py
    re-points a chained event's MERGED_INTO onto the final survivor.

    `candidate` is the Cypher expression holding the proposed id (e.g. `row.conceptualWorkId`).
    `carry` names the variables that must stay in scope across the WITHs."""
    keep = ", ".join(carry)
    # The leading WITH is not decoration: Cypher requires one between a SET and a MATCH, and
    # this fragment is spliced in directly after the artist SET in navigart_ingest.
    return f"""
WITH {keep}
OPTIONAL MATCH (:MergeEvent {{mergedFromId: {candidate}}})-[:MERGED_INTO]->(merged:ConceptualWork)
WITH {keep}, collect(DISTINCT merged)[0] AS survivor
FOREACH (_ IN CASE WHEN survivor IS NULL THEN [1] ELSE [] END |
         MERGE (:ConceptualWork {{id: {candidate}}}))
WITH {keep}, coalesce(survivor.id, {candidate}) AS resolvedWorkId
MATCH (cw:ConceptualWork {{id: resolvedWorkId}})"""
