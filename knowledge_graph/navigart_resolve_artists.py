"""
PrintMasterAI — Navigart artist name resolution against the live ACKG
Version: NAVIGART-RESOLVE-ARTISTS-0.1

`picasso_paris_ingest.py` carries a five-entry hand-written `ARTIST_RESOLUTION` dict and
its own docstring says that is NOT a general mechanism: "a wider load must run new names
through resolve_artist_identity.py instead". This load has 714 distinct names across 33
collections, so it needs one — but it must be a mechanism this project's own history
allows.

That history is specific: the Roseberys ingest created duplicate `Artist` nodes by
matching on exact raw strings, and 40 pairs had to be merged by hand. The response to
that was never "match more loosely" — two separate ACKG corruption incidents came from
similarity matching, and the standing rule is exact-field matching only.

So this resolver matches on an **exact key**, computed from a normalisation that is
purely mechanical and reversible in meaning:

    accent-stripped, parenthetical aliases removed, non-letters dropped,
    upper-cased, tokens sorted

`DELAUNAY Jules Elie` and `Jules-Élie Delaunay` both produce `DELAUNAY ELIE JULES`. That
is word-order and diacritic normalisation, not similarity: two names either contain the
same letter-tokens or they do not. No edit distance, no token-subset matching, no
embedding anywhere in this file.

Three refusals, all of which produce an UNMATCHED entry rather than a guess:

  1. **Ambiguous keys.** If one normalised key maps to more than one distinct ACKG
     `Artist.name`, the graph itself does not agree on who that is. In practice all 19
     such names in this load are the ACKG's own known duplicate-`Artist` bug — accent and
     hyphen variants of one person ("Jean Emile Laboureur" / "Jean Émile Laboureur" /
     "Jean-Emile Laboureur"), the same class of pair the 2026-09-10 merge pass fixed 40
     of and did not finish. So the ambiguity is broken by a two-rung DETERMINISTIC ladder
     before it is refused, and the rung used is recorded on every row:

       a. exactly one candidate carries a `ulanUrl` -> that one (an identity-resolved
          node beats an unresolved one);
       b. else exactly one candidate has strictly the most `CREATED` works -> that one
          (the node a dedupe pass would keep as the merge target);
       c. else refused.

     Neither rung is a similarity judgement: the candidates already share an exact
     normalised key, so the only question is which duplicate to attach to. Rows resolved
     this way are attaching to one branch of a duplicate pair the graph has not merged
     yet, which grows that branch — they are flagged in the output so the outstanding
     dedupe pass can see them.
  2. **Anonymous primaries.** The graph already carries ~15 anonymous-artist node
     variants ("Anonymous, American, 20th century", "Anon", "Anonyme", "Artist
     Unknown"...) and cleaning those up is open work. This resolver refuses to add a
     16th, so records whose primary author is anonymous are excluded from the load
     rather than merged into a new junk node.
  3. **Nameless nodes.** The graph contains one `Artist` with `name = ""` carrying 17
     `alternateNames` of the shape "(n/a) Giovanni Battista Piranesi" — an ingest
     artifact, with 18 real works and 18 SourceRecords hanging off it. An empty string is
     not a name and cannot be a match target, so it is dropped from the index outright.
     Left in, it alone made Piranesi (830 records, the largest artist in this load)
     ambiguous. Logged as a data-quality finding; not repaired here.

  4. **Single-token names.** `SALLEY`, `GUVIER`, a bare surname with no forename, is not
     enough to identify anyone; a one-token key collides with every artist who shares
     that surname. Refused, recorded, loaded as a new unresolved node only if you
     explicitly allow it.

Multi-author strings ("AUDRAN Benoît I, LE BRUN Charles" — Audran engraved, Le Brun
designed) resolve on the FIRST author only. Navigart orders `authors_list` with the
primary maker first, and the secondary author's ROLE is not machine-readable in this
data — "(d'après)" appears on 14 records out of 217 and the rest carry no role marker at
all. Inventing a second `CREATED` edge from an unstated role is exactly the kind of
confident-looking assertion this project keeps out of the graph; the full raw string is
carried onto the record instead (survey §10, UNMAPPED).

Display names come from `authors_notice`, which Navigart publishes in natural order
("Jules Elie DELAUNAY") on 100% of records, rather than from re-ordering `authors_list`
("DELAUNAY Jules Elie") by guessing where the surname ends.

Usage:
    python knowledge_graph/navigart_resolve_artists.py            # write the mapping
    python knowledge_graph/navigart_resolve_artists.py --report   # show it, write nothing
"""

import argparse
import glob
import json
import os
import re
import unicodedata
from collections import defaultdict

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_GLOB = os.path.join(os.path.dirname(HERE), "benchmark", "data", "navigart",
                          "*_pd-image.json")
OUT_PATH = os.path.join(HERE, "navigart_artist_resolution.json")

_PAREN_RE = re.compile(r"\([^)]*\)")
_ANON_RE = re.compile(r"^\s*anonym", re.IGNORECASE)

# Exact-string aliases, one line per name, each checked by eye against the ACKG node it
# points at. Same shape and same justification as `bm_ingest.py`'s
# PILOT_ARTIST_RESOLUTION and `picasso_paris_ingest.py`'s ARTIST_RESOLUTION: a
# hand-verified pair, NOT a rule the code generalises from.
#
# These exist because the normalised key is deliberately strict, and strictness has a
# cost in the other direction — it refuses to bridge a transliteration ("Vassily" /
# "Wassily") or a fuller form of the same name ("Benjamin Jean-Pierre Henri Rivière" /
# "Henri Rivière"), so without this table the load would create a SECOND Kandinsky node
# carrying 475 works. That is the duplicate-`Artist` bug this project already had to
# clean up once, arriving by the opposite route.
#
# Deliberately NOT in this table, though a token-subset rule would have caught them:
#   - "COLIN Paul-Emile" -> "Paul Colin". Two different artists: Paul-Émile Colin
#     (1867-1949, wood engraver) and Paul Colin (1892-1985, poster designer). This is
#     precisely why a token-subset rule is not applied automatically.
#   - "ADAM Victor-Jean" -> "Victor Adam". Probably the same lithographer (1801-1866,
#     also catalogued Jean-Victor), but the forename order differs between sources and
#     "probably" is not the standard here. Loads as a new node; 15 records.
#   - "GONZÁLEZ Julio" -> "Julio Castellanos González". Different people.
#   - "DE LA GANDARA Antonio" -> "A.R. de Antonio". Different people.
HAND_VERIFIED_ALIASES = {
    "KANDINSKY Vassily": "Wassily Kandinsky",
    "VAN RIJN Rembrandt Harmensz. dit REMBRANDT": "Rembrandt van Rijn",
    "RIVIÈRE Benjamin Jean-Pierre Henri dit RIVIÈRE Henri": "Henri Rivière",
    "GELLÉE Claude dit LE LORRAIN": "Claude Lorrain",
    "BÉJOT Eugène Joseph": "Eugène Bejot",
    "VOGELER Heinrich Johann": "Heinrich Vogeler",
    "HERMANN-PAUL (HERMANN-PAUL René-Georges, dit)": "René-Georges Hermann-Paul",
    "FRIESZ Emile Othon": "Achille-Émile Othon Friesz",
    "RASSENFOSSE André Louis Armand": "Armand Rassenfosse",
    "HOLROYD Charles": "Sir Charles Holroyd",
}


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def normalize_key(name):
    """The exact match key. See module docstring — mechanical, not fuzzy."""
    if not name:
        return None
    s = _PAREN_RE.sub(" ", name)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z ]", " ", s.upper())
    tokens = [t for t in s.split() if len(t) > 1]
    return " ".join(sorted(tokens)) if tokens else None


def split_authors(raw):
    """Splits a multi-author string on commas OUTSIDE parentheses — the alias form
    'MONDRIAN Piet (MONDRIAAN Pieter-Cornelis, dit)' carries a comma inside its own
    parenthetical and a naive split severs it."""
    parts, depth, current = [], 0, []
    for ch in raw or "":
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return [p for p in parts if p]


# Cataloguing role markers, not parts of a name. Title-casing them produced
# "Raffaello Sanzio Dit Raphaël" and "Charles-Nicolas Fils Cochin" in the first load.
# Deliberately excludes the name particles (de, du, le, la, van, von): those ARE part of
# a surname here — `authors_notice` shouts "Jacques-Philippe LE BAS", so lowercasing
# "Le" would corrupt a real name to fix a cosmetic one.
_ROLE_MARKERS = {"dit", "dite", "fils", "pere", "père", "aine", "aîné", "jeune"}


def display_name(notice_first):
    """`authors_notice` is natural order with the surname shouted: 'Jules Elie
    DELAUNAY'. Title-case each letter run, leaving hyphens and apostrophes in place, and
    leave the French role markers lower-case where they are not the first word."""
    core = _PAREN_RE.sub("", notice_first or "").strip()
    core = re.sub(r"\s+", " ", core)
    if not core:
        return None
    titled = re.sub(r"[A-Za-zÀ-ÿ]+", lambda m: m.group(0).capitalize(), core)
    words = titled.split(" ")
    return " ".join(
        w if i == 0 or w.lower() not in _ROLE_MARKERS else w.lower()
        for i, w in enumerate(words))


def load_ackg_index():
    driver = GraphDatabase.driver(
        _require_env("NEO4J_URI"),
        auth=(_require_env("NEO4J_USER"), _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            rows = session.run(
                "MATCH (a:Artist) "
                "RETURN a.name AS name, a.alternateNames AS alts, a.ulanUrl AS ulanUrl, "
                "       size([(a)-[:CREATED]->(w) | w]) AS works").data()
    finally:
        driver.close()

    index = defaultdict(set)
    ulan, works, skipped = {}, {}, 0
    for row in rows:
        name = (row.get("name") or "").strip()
        if not name:                      # docstring refusal 3
            skipped += 1
            continue
        ulan[name] = row.get("ulanUrl")
        works[name] = row.get("works") or 0
        for candidate in [name] + list(row.get("alts") or []):
            key = normalize_key(candidate)
            if key:
                index[key].add(name)
    if skipped:
        print(f"[ACKG] dropped {skipped} Artist node(s) with a blank name from the match "
              f"index — see docstring refusal 3", flush=True)
    return index, ulan, works, len(rows)


def collect_names():
    """raw authors_list value -> (primary raw author, primary display name, count)."""
    counts = defaultdict(int)
    notices = {}
    for path in sorted(glob.glob(CACHE_GLOB)):
        payload = json.load(open(path, encoding="utf-8"))
        for record in payload["records"]:
            artwork = record.get("artwork") or {}
            raw = (artwork.get("authors_list") or "").strip()
            if not raw:
                continue
            counts[raw] += 1
            notices.setdefault(raw, artwork.get("authors_notice") or raw)
    return counts, notices


def break_ambiguity(candidates, ulan, works):
    """The deterministic ladder from docstring refusal 1. Returns (name, rule) or
    (None, None)."""
    with_ulan = [c for c in candidates if ulan.get(c)]
    if len(with_ulan) == 1:
        return with_ulan[0], "ambiguous_broken_by_ulan"
    ranked = sorted(candidates, key=lambda c: -works.get(c, 0))
    if len(ranked) > 1 and works.get(ranked[0], 0) > works.get(ranked[1], 0):
        return ranked[0], "ambiguous_broken_by_work_count"
    return None, None


def resolve():
    index, ulan, works, artist_count = load_ackg_index()
    ambiguous_keys = {k for k, v in index.items() if len(v) > 1}
    print(f"[ACKG] {artist_count} Artist nodes -> {len(index)} normalised keys "
          f"({len(ambiguous_keys)} ambiguous)", flush=True)

    counts, notices = collect_names()
    print(f"[NAVIGART] {len(counts)} distinct authors_list values over "
          f"{sum(counts.values())} records", flush=True)

    resolution, refused = {}, {}
    stats = defaultdict(int)
    for raw, n in sorted(counts.items(), key=lambda x: -x[1]):
        primary_raw = split_authors(raw)[0]
        primary_notice = split_authors(notices.get(raw) or raw)[0]

        if _ANON_RE.match(primary_raw) or primary_raw.strip().upper() == "ANONYME":
            refused[raw] = {"reason": "anonymous_primary", "records": n}
            stats["anonymous_primary"] += n
            continue

        alias = HAND_VERIFIED_ALIASES.get(raw) or HAND_VERIFIED_ALIASES.get(primary_raw)
        if alias:
            if alias not in ulan:
                raise RuntimeError(
                    f"HAND_VERIFIED_ALIASES points {raw!r} at {alias!r}, which is not an "
                    f"Artist in the graph. Fix the table rather than loading past it.")
            resolution[raw] = {"canonicalName": alias, "ulanUrl": ulan.get(alias),
                               "matchRule": "hand_verified_alias", "records": n}
            stats["hand_verified_alias"] += n
            continue

        key = normalize_key(primary_raw)
        if not key:
            refused[raw] = {"reason": "unusable_name", "records": n}
            stats["unusable_name"] += n
            continue
        if len(key.split()) < 2:
            refused[raw] = {"reason": "single_token_name", "records": n,
                            "display": display_name(primary_notice)}
            stats["single_token_name"] += n
            continue
        if key in ambiguous_keys:
            picked, rule = break_ambiguity(sorted(index[key]), ulan, works)
            if picked is None:
                refused[raw] = {"reason": "ambiguous_unbroken", "records": n,
                                "candidates": sorted(index[key])}
                stats["ambiguous_unbroken"] += n
                continue
            resolution[raw] = {"canonicalName": picked, "ulanUrl": ulan.get(picked),
                               "matchRule": rule, "records": n,
                               "ackgDuplicateCandidates": sorted(index[key])}
            stats[rule] += n
            continue

        matched = index.get(key)
        if matched:
            name = next(iter(matched))
            resolution[raw] = {"canonicalName": name, "ulanUrl": ulan.get(name),
                               "matchRule": "exact_normalised_key", "records": n}
            stats["matched_existing"] += n
        else:
            resolution[raw] = {"canonicalName": display_name(primary_notice),
                               "ulanUrl": None, "matchRule": "new_from_authors_notice",
                               "records": n}
            stats["new_artist"] += n

    # A second collision check, this time inside the resolution itself: two different
    # Navigart spellings can legitimately land on one new canonical name, which is fine
    # and intended, but two different NEW canonical names must not collide on one key.
    by_key = defaultdict(set)
    for raw, entry in resolution.items():
        by_key[normalize_key(entry["canonicalName"])].add(entry["canonicalName"])
    collisions = {k: sorted(v) for k, v in by_key.items() if len(v) > 1}

    # An alias whose key never matches any raw value does nothing and says nothing —
    # which is how three of the ten entries in the first version of this table silently
    # failed, creating a second Rembrandt node with 29 works. Unused entries are a
    # defect in the table, so they fail loudly here.
    unused = sorted(k for k in HAND_VERIFIED_ALIASES if k not in counts)
    if unused:
        raise RuntimeError(
            "HAND_VERIFIED_ALIASES entries that match no authors_list value in the "
            "caches — fix the key, do not leave it: " + repr(unused))

    return resolution, refused, dict(stats), collisions


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", action="store_true", help="Print only, write nothing")
    args = parser.parse_args()

    resolution, refused, stats, collisions = resolve()

    matched = sum(1 for v in resolution.values() if v["matchRule"] == "exact_normalised_key")
    print(f"\n[RESOLVED] {len(resolution)} names "
          f"({matched} matched an existing Artist, {len(resolution) - matched} new)")
    print(f"[REFUSED]  {len(refused)} names")
    for reason, n in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"    {reason:<22} {n:>6} records")
    if collisions:
        print(f"\n[COLLISION] {len(collisions)} normalised key(s) reached by two different "
              f"new canonical names — review before loading:")
        for k, v in list(collisions.items())[:20]:
            print(f"    {k}: {v}")

    print("\nTop refusals by record count:")
    for raw, info in sorted(refused.items(), key=lambda x: -x[1]["records"])[:15]:
        print(f"    {info['records']:>4}  {info['reason']:<20} {raw[:60]}")

    if not args.report:
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump({"resolution": resolution, "refused": refused,
                       "stats": stats, "collisions": collisions},
                      f, ensure_ascii=False, indent=1, sort_keys=True)
        print(f"\n-> {OUT_PATH}")
