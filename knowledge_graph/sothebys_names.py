"""SOTHEBYS-NAME-1.0 — reading Sotheby's artist strings, and deciding which names to ask for.

One module for one rule family (ADR-0020). Two jobs, deliberately separated:

  A. `query_forms(...)`  — which name forms to SEND to Sotheby's for a given graph artist.
     Sotheby's indexes an artist under whatever the cataloguer wrote, so asking only for the
     graph's canonical name silently loses most of the record: "Rembrandt van Rijn" returns 2
     lots, while ULAN's own variants for the same ulan_id ("Rembrandt Harmenszoon van Rijn",
     "Rembrandt Harmensz. van Rijn") are the forms Sotheby's actually uses.

  B. `read_artist(...)` — how to READ a Sotheby's artistName back into (name, qualifier).
     Their strings carry cataloguing qualifiers, inverted surnames and collaboration
     separators that the shared normalisers were never meant to see.

Nothing here scores similarity. Matching reuses the project's own rule ladder from
find_artist_merge_candidates (normalized_equal -> honorific -> initialism); the typo and
token_subset rules are deliberately NOT used, because those carry a DINOv2 image floor
(token_subset needs 0.90) that is unavailable when matching against an external catalogue.
See feedback_catalogue_identity_no_fuzzy_matching and ADR-0017.
"""
import os
import re
import sqlite3

from find_artist_merge_candidates import HONORIFICS, normalize, tokens, strip_honorifics

# The local ULAN mirror (ADR-0012). Built by build_ulan_index.py; absent on a fresh checkout,
# in which case query_forms falls back to the graph's own names and records that it did.
_ULAN_DB_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulan_local.sqlite"),
    os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph/ulan_local.sqlite"),
]
_ulan_conn = None


def ulan_db():
    global _ulan_conn
    if _ulan_conn is None:
        for path in _ULAN_DB_CANDIDATES:
            if os.path.exists(path):
                _ulan_conn = sqlite3.connect(path, check_same_thread=False)
                break
    return _ulan_conn


def ulan_id_from_url(url):
    """Accepts either stored form — /ulan/500011051 or /page/ulan/500011051 (see
    project_ulan_url_form_inconsistency, where the two forms hid 12 duplicate pairs)."""
    m = re.search(r"/ulan/(\d+)", url or "")
    return m.group(1) if m else None


def ulan_names(ulan_url):
    """Every name ULAN records for this subject, preferred first. These are authority-recorded
    variants, not guesses: exact rows against the ulan_id the graph already holds."""
    conn, uid = ulan_db(), ulan_id_from_url(ulan_url)
    if conn is None or not uid:
        return []
    rows = conn.execute(
        "SELECT name FROM ulan_name WHERE ulan_id = ? ORDER BY rowid", (uid,)
    ).fetchall()
    return [r[0] for r in rows if r[0]]


# ---------------------------------------------------------------- A. what to ask for

def query_forms(graph_name, ulan_url=None, merge_aliases=(), limit=6):
    """Name forms worth sending to Sotheby's for this artist, most canonical first.

    Sources, all exact lookups of something already recorded:
      1. the graph's own name;
      2. names folded into this artist by a recorded MergeEvent (mergedFromName);
      3. ULAN variants for the artist's own ulan_id.

    Deduplicated on the shared `normalize`, so "Rembrandt, Harmensz. Van Rijn" and
    "Rembrandt Harmensz. van Rijn" cost one query, not two. Inverted forms ("Rijn, Rembrandt
    van") are dropped: they normalise to the same token bag as the upright form and add a
    query without adding reach.
    """
    out, seen = [], set()

    def add(name):
        if not name:
            return
        key = " ".join(sorted(tokens(name)))
        if key and key not in seen:
            seen.add(key)
            out.append(name)

    add(graph_name)
    for alias in merge_aliases:
        add(alias)
    for name in ulan_names(ulan_url):
        add(name)
    return out[:limit]


# ---------------------------------------------------------------- B. how to read theirs

# Cataloguing qualifiers. Kept, never discarded: "after X" is a per-artist price factor and is
# excluded from direct comps (project_after_attribution_in_pricing, BLEND-1.10), and the
# artist-merge rule is qualifier-preserving (ARTIST-MERGE-3.1).
QUALIFIER_PREFIXES = [
    ("after", r"^after\s+"),
    ("attributed", r"^attributed\s+to\s+"),
    ("circle", r"^circle\s+of\s+"),
    ("studio", r"^studio\s+of\s+"),
    ("workshop", r"^workshop\s+of\s+"),
    ("follower", r"^follower\s+of\s+"),
    ("manner", r"^(?:in\s+the\s+)?manner\s+of\s+"),
    ("style", r"^style\s+of\s+"),
    ("school", r"^school\s+of\s+"),
    ("copy", r"^(?:a\s+)?cop(?:y|ies)\s+after\s+"),
]

# "Rembrandt Harmensz. van Rijn and Others" — a multi-artist lot, not this artist alone.
_AND_OTHERS = re.compile(r"\s*(?:,|&|and)\s+others?\s*$", re.I)

# Books & Manuscripts writes "Picasso, Pablo -- Prosper Mérimée": illustrator first, then the
# author, separated by a double dash. The first party is the artist the lot is filed under.
_DOUBLE_DASH = re.compile(r"\s+--+\s+")

# "Rijn, Rembrandt Harmensz. van" — surname-first inversion, used by the Paris book sales.
# Only applied when the tail is short and the head is a single token, so "Picasso, Pablo"
# inverts but "Keith Haring, Andy Warhol" (a genuine two-artist string) does not.
def _is_postnominal(text):
    """"R.A.", "C.H.", "O.B.E." — the comma tail is a post-nominal, not a forename.

    `normalize` has already split the dotted form into single letters, so the test rejoins
    them before looking them up: "R.A." -> ["r","a"] -> "ra". Missing this inverted
    "David Hockney, R.A." into "R.A. David Hockney" and lost 50 Hockney, 108 Piper and 78
    Pasmore lots on the first run.
    """
    toks = tokens(text)
    if not toks:
        return False
    return "".join(toks) in HONORIFICS or all(t in HONORIFICS for t in toks)


def _uninvert(name):
    if name.count(",") != 1:
        return name
    head, tail = (p.strip() for p in name.split(","))
    if not head or not tail or _is_postnominal(tail):
        return name
    if len(head.split()) <= 2 and 1 <= len(tail.split()) <= 3:
        return f"{tail} {head}"
    return name


def read_artist(raw):
    """Sotheby's artistName -> (clean_name, qualifier, flags).

    qualifier is None for a direct attribution, else one of QUALIFIER_PREFIXES' keys.
    flags records what else was seen ("and_others", "collaboration", "inverted") so a caller
    can exclude multi-artist lots from per-artist statistics rather than silently keeping them.
    """
    name = (raw or "").strip()
    flags = []
    if not name:
        return "", None, flags

    qualifier = None
    for key, pattern in QUALIFIER_PREFIXES:
        if re.match(pattern, name, re.I):
            qualifier = key
            name = re.sub(pattern, "", name, flags=re.I).strip()
            break

    if _AND_OTHERS.search(name):
        flags.append("and_others")
        name = _AND_OTHERS.sub("", name).strip()

    if _DOUBLE_DASH.search(name):
        flags.append("collaboration")
        name = _DOUBLE_DASH.split(name)[0].strip()

    uninverted = _uninvert(name)
    if uninverted != name:
        flags.append("inverted")
        name = uninverted

    return name, qualifier, flags


# ---------------------------------------------------------------- C. does it match?

def _clean_tokens(name):
    """Tokens with honorifics and post-nominals removed.

    Thin wrapper now: the dotted-post-nominal handling this module carried locally moved
    into the shared helper as ARTIST-IDENTITY-RESOLVER-1.2, where the merge scanner gets it
    too. Kept as a named seam so the Sotheby's path has one place to diverge if their
    catalogue ever needs something the scanner should not have.
    """
    return strip_honorifics(tokens(name))


def _initialism_match(a_toks, b_toks):
    """The project's `initialism` rule, applied pairwise rather than as a bucket scan:
    surnames equal, and each forename either identical or a single letter the other's
    forename starts with, with at least one position actually abbreviated.
    "L.S. Lowry" vs "Laurence Stephen Lowry" -> True.
    """
    if len(a_toks) != len(b_toks) or len(a_toks) < 2:
        return False
    if a_toks[-1] != b_toks[-1]:
        return False
    abbreviated = False
    for x, y in zip(a_toks[:-1], b_toks[:-1]):
        if x == y:
            continue
        if len(x) == 1 and y.startswith(x):
            abbreviated = True
        elif len(y) == 1 and x.startswith(y):
            abbreviated = True
        else:
            return False
    return abbreviated


def match_rule(sothebys_name, graph_name, extra_forms=()):
    """Which of the project's rules makes these the same artist — or None.

    Ladder in RULE_PRIORITY order, stopping at the first hit:
      normalized_equal -> honorific -> initialism -> ulan_alias
    `typo` and `token_subset` are excluded on purpose: both are gated on a DINOv2 image floor
    in the merge scanner, and that evidence does not exist for an external catalogue.
    """
    a_raw, b_raw = normalize(sothebys_name), normalize(graph_name)
    if not a_raw or not b_raw:
        return None
    if a_raw == b_raw:
        return "normalized_equal"

    a, b = _clean_tokens(sothebys_name), _clean_tokens(graph_name)
    if a and a == b:
        return "honorific"
    if _initialism_match(a, b):
        return "initialism"

    for form in extra_forms:
        f = _clean_tokens(form)
        if a and (a == f or normalize(sothebys_name) == normalize(form)):
            return "ulan_alias"
        if _initialism_match(a, f):
            return "ulan_alias"
    return None
