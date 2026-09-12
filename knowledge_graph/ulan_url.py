"""
PrintMasterAI — the one place a Getty ULAN URL is given its shape.
Version: ULAN-URL-1.0

Getty exposes the same authority record at two addresses:

    http://vocab.getty.edu/ulan/500115467          the RDF resource — the identifier
    http://vocab.getty.edu/page/ulan/500115467     the HTML page ABOUT that resource

They are different things, and only the first is an identity. Every writer in this repo must
store the first, because `Artist.ulanUrl` is used as an equality key — by the
`artist_ulanurl` uniqueness constraint, by `MERGE (a:Artist {ulanUrl: ...})` in
`met_ingest.py`, and by every dedup pass that has ever asked "do these two nodes denote the
same person".

WHY THIS FILE EXISTS. Both forms were being written at once. `resolve_artist_ulan_local.py`
emitted the page form and `resolve_artist_identity.py` the plain one, so the same artist
resolved by two paths produced two nodes that no exact-match check could see were one. It
hid **twelve duplicate Artist pairs** — Pierre-Auguste Renoir against Auguste Renoir, Ed
Ruscha against Edward Ruscha, Lucian against Lucien Freud — from every prior
exact-normalisation dedup pass, and it defeated an attempted "different ULAN means different
people" veto, which fired on Renoir against Renoir. Repaired in the graph on 2026-09-12 by
`merge_artists.py ulan-canon`; this module is the half that stops it returning.

THE DATABASE CANNOT ENFORCE THIS. Neo4j CE has no property-format constraint (that is an
Enterprise feature), and this graph is self-hosted CE with no APOC, so the invariant lives in
Python and is checked by `check_ulan_url_canonical.py`. Call `canonical_ulan_url` on every
value on its way to the graph — including values that arrive already-formed from an
institution's API, which is where two of the three page-form sources came from.
"""
import re

CANON_PREFIX = "http://vocab.getty.edu/ulan/"

# Matches either address, plus the https/www/trailing-slash variants an external API may
# hand over, and a bare numeric id.
_ULAN = re.compile(
    r"^\s*(?:https?://(?:www\.)?vocab\.getty\.edu/(?:page/)?ulan/)?(\d{6,12})/?\s*$",
    re.I)


def ulan_id(value):
    """The bare Getty numeric id, or None if `value` is not a ULAN reference.

    Returns None rather than raising for empty/None input, so it can be applied to an
    optional field without the caller guarding first."""
    if value is None:
        return None
    m = _ULAN.match(str(value))
    return m.group(1) if m else None


def canonical_ulan_url(value):
    """The RDF-resource form of a ULAN reference, or None.

    Accepts the plain form, the `/page/` form, https, a trailing slash, or a bare id.
    Returns None for None/empty. **Raises ValueError on a non-empty value that is not a
    ULAN reference** — a malformed identifier must fail loudly at the write site rather
    than be silently dropped to None and leave the artist unresolved for no visible reason.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    uid = ulan_id(s)
    if uid is None:
        raise ValueError(f"not a recognisable Getty ULAN reference: {value!r}")
    return CANON_PREFIX + uid


def is_canonical(value):
    """True if `value` is already in the form this repo stores. A missing ULAN counts as
    canonical — the guard's business is malformed values, not absent ones."""
    if value is None or str(value).strip() == "":
        return True
    uid = ulan_id(value)
    return uid is not None and str(value).strip() == CANON_PREFIX + uid
