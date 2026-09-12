"""
PrintMasterAI — Artist identity reconciliation against ULAN
Version: ARTIST-IDENTITY-RESOLVER-1.0

Implements the plan worked through with the user: Artist nodes should be keyed by a
canonical authority identifier (ulanUrl, falling back to wikidataUrl, falling back to
name only when neither resolves), not by raw name string — see doc 08 for why (name
collisions fragment query_ackg's support counts across duplicate nodes for the same
real person).

Uses Getty's vocab.getty.edu SPARQL endpoint directly (a real, deterministic JSON API
confirmed working in this session — vocab.getty.edu/sparql.json with a `luc:term`
full-text predicate), NOT an LLM-parsed web page. This matters: an LLM asked to eyeball
a search-results page can introduce transcription errors (confirmed twice this session
— a misread surname and a misread date), so anything feeding the graph automatically
must go through this deterministic path, not a page-reading step.

What this does NOT do: fully resolve every artist automatically. Confirmed by testing
(David Ferry, Madame Hassia) that some artists have no ULAN or Wikidata presence at
all, and that a generic name-only fallback (plain Wikipedia) is actively dangerous, not
just unhelpful — it returned an unrelated poet and, in one case, a Greek mountain range
for a bare name match. This tool surfaces ranked candidates with the evidence needed to
judge them; it does not auto-accept a match, and low/ambiguous-confidence results
should go to a human or a tool-using specialist agent, not straight into the graph.

Usage:
    from resolve_artist_identity import resolve_artist
    result = resolve_artist("Dame Elizabeth Frink CH DBE RA")
    # -> {"query": ..., "strippedName": ..., "candidates": [...], "confidence": ...}
"""

import os
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import urllib.error
import json
from ulan_url import canonical_ulan_url

SPARQL_ENDPOINT = "https://vocab.getty.edu/sparql.json"

# Honorifics / post-nominals that are titles, not name content, and must be stripped
# before matching — "Dame Elizabeth Frink CH DBE RA" needs to become "Elizabeth Frink"
# before it's searched, or the search degrades badly.
_HONORIFIC_PREFIXES = {
    "sir", "dame", "lord", "lady", "dr", "prof", "professor", "hon", "mr", "mrs", "ms",
}
_POSTNOMINAL_SUFFIXES = {
    "ra", "rha", "rsa", "rws", "roi", "npra", "are", "ceo", "obe", "mbe", "cbe",
    "dbe", "che", "ch", "kt", "frsa", "phd", "md", "esq", "arca", "rca", "re", "arws",
    # Added after finding these caused real Artist-node fragmentation in the Roseberys
    # bulk data (L.S. Lowry split across "RA RBA LG NS" variants that weren't stripped):
    "rba", "lg", "ns", "om", "fba", "prba", "rp", "hrsa", "rsw", "aria", "ari", "rp.",
}
# tokens that are only honorific when NOT at the very start (mid-name post-nominals
# appear comma-separated, e.g. "Henry, OM, CH Moore")
_ANYWHERE = _POSTNOMINAL_SUFFIXES | {"the"}


def strip_honorifics(name):
    """Remove honorific prefixes/suffixes from a display name — including comma-separated
    ones interspersed mid-string ("Henry, OM, CH Moore" -> "Henry Moore", "Roy Lichtenstein,"
    -> "Roy Lichtenstein")."""
    raw = (name or "").replace(",", " ")
    tokens = [t for t in raw.split() if t]
    # drop any post-nominal token wherever it sits (they are never real name content)
    kept = [t for t in tokens if t.lower().rstrip(".") not in _ANYWHERE]
    # then strip a leading honorific
    while kept and kept[0].lower().rstrip(".") in _HONORIFIC_PREFIXES:
        kept.pop(0)
    out = " ".join(kept).strip()
    return out or name.strip()


def _sparql_query(query, retries=5, backoff_seconds=10.0):
    # Confirmed by testing, not assumed: Getty's endpoint throttles under moderate
    # request frequency, with a real cooldown longer than a short retry (an isolated
    # query failing back-to-back succeeded cleanly after a 15s wait). Any caller
    # processing more than a handful of artists needs real spacing between requests
    # (several seconds, not milliseconds) — this is not safe to hammer in a tight loop
    # the way met_ingest.py's Met API calls are.
    #
    # Also confirmed by testing (2026-08-31): a query string with leading indentation /
    # embedded newlines returns HTTP 200 with a 0-byte body. Collapse to one line.
    query = re.sub(r"\s+", " ", query).strip()
    url = SPARQL_ENDPOINT + "?" + urllib.parse.urlencode({"query": query})
    # Getty's endpoint rejects/empties-out requests carrying urllib's default
    # User-Agent — confirmed by testing, not assumed. A real one is required.
    req = urllib.request.Request(url, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": "Mozilla/5.0 (PrintMasterAI artist-identity resolver)",
    })
    # Also empirically flaky under repeated requests even with a correct User-Agent
    # (confirmed: identical queries that succeed in isolation intermittently return
    # an empty body in a loop) — retry with backoff rather than fail outright.
    import random
    last_error = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = resp.read()
                if not body.strip():
                    raise json.JSONDecodeError("empty body", "", 0)
                return json.loads(body)
        except (json.JSONDecodeError, urllib.error.URLError, TimeoutError) as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1) + random.uniform(0, 3))
    raise RuntimeError(f"SPARQL query failed after {retries} attempts: {last_error}")


_LOCAL_ULAN_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulan_local.sqlite")
_local_ulan_conn = None


def _local_ulan_db():
    """Lazy singleton connection to the local ULAN mirror (see build_ulan_index.py,
    docs/adr/0012-local-ulan-mirror.md). Falls back to None (caller then falls back to
    live SPARQL) if the mirror hasn't been built yet, so this module still works
    standalone on a fresh checkout."""
    global _local_ulan_conn
    if _local_ulan_conn is None and os.path.exists(_LOCAL_ULAN_DB_PATH):
        _local_ulan_conn = sqlite3.connect(_LOCAL_ULAN_DB_PATH, check_same_thread=False)
    return _local_ulan_conn


def _fts_query(name):
    toks = [t for t in re.sub(r'[^\w\s]', ' ', name).split() if len(t) > 1]
    return " OR ".join(f'"{t}"' for t in toks[:8]) if toks else None


def _search_ulan(name):
    """Local-mirror-backed (see docs/adr/0012-local-ulan-mirror.md) — replaced the live
    vocab.getty.edu SPARQL `luc:term` search 2026-08-31. Same return shape as the old
    SPARQL JSON-binding format ([{"ulan": {"value": url}, "name": {"value": name}}, ...])
    so resolve_artist()'s scoring/confidence logic downstream is unchanged. Falls back to
    the original live SPARQL query if the local mirror isn't present (e.g. a fresh
    checkout that hasn't run build_ulan_index.py yet)."""
    conn = _local_ulan_db()
    if conn is None:
        return _search_ulan_live(name)
    q = _fts_query(name)
    if not q:
        return []
    try:
        rows = conn.execute("""
            SELECT DISTINCT p.ulan_id, p.pref_name
            FROM ulan_name_fts f JOIN ulan_person p ON p.ulan_id = f.ulan_id
            WHERE ulan_name_fts MATCH ? AND p.pref_name IS NOT NULL
            ORDER BY bm25(ulan_name_fts)
            LIMIT 30
        """, (q,)).fetchall()
    except sqlite3.OperationalError:
        return []
    return [
        {"ulan": {"value": canonical_ulan_url(uid)}, "name": {"value": pname}}
        for uid, pname in rows
    ]


def _search_ulan_live(name):
    """Original live-SPARQL path — kept as a fallback for when the local mirror (see
    docs/adr/0012-local-ulan-mirror.md) hasn't been built. Deliberately does NOT join
    biography in this query; see _fetch_bio_live()'s docstring for why."""
    escaped = name.replace('"', '\\"')
    query = f"""
        SELECT ?ulan ?name WHERE {{
          ?ulan luc:term "{escaped}"; a gvp:PersonConcept;
                gvp:prefLabelGVP/xl:literalForm ?name .
        }} LIMIT 10
    """
    data = _sparql_query(query)
    return data.get("results", {}).get("bindings", [])


def _fetch_bio(ulan_url):
    """Local-mirror-backed; falls back to live SPARQL if the mirror isn't present."""
    conn = _local_ulan_db()
    if conn is None:
        return _fetch_bio_live(ulan_url)
    m = re.search(r"/ulan/(\d+)$", ulan_url)
    if not m:
        return None
    row = conn.execute(
        "SELECT bio FROM ulan_person WHERE ulan_id = ?", (m.group(1),)
    ).fetchone()
    return row[0] if row else None


def _fetch_bio_live(ulan_url):
    """Original live-SPARQL path — separate, cheap, single-record lookup, not joined
    into the bulk search. An earlier version joined
    `foaf:focus/gvp:biographyPreferred/schema:description` into the main search query
    and it was confirmed to make the endpoint take 60+ seconds (timed out), even though
    the equivalent query without that join reliably returns in under a second — that's
    why this stayed a separate per-candidate lookup rather than a join."""
    query = f"""
        SELECT ?bio WHERE {{
          <{ulan_url}> foaf:focus/gvp:biographyPreferred/schema:description ?bio .
        }} LIMIT 1
    """
    try:
        data = _sparql_query(query, retries=1)
        bindings = data.get("results", {}).get("bindings", [])
        return bindings[0]["bio"]["value"] if bindings else None
    except Exception:
        return None


def _name_tokens(name):
    return set(re.sub(r"[^\w\s]", "", name.lower()).split())


import unicodedata


def _fold(s):
    """Lowercase, strip diacritics, collapse punctuation/space — for string-distance."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^\w\s]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def _jaro_winkler(a, b):
    """Jaro-Winkler similarity in [0, 1]. Prefix-weighted, good for names + typos
    ('Taytu Betul' ~ 'Tatyu Betul'). Hand-rolled to avoid a dependency."""
    a, b = _fold(a), _fold(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    max_dist = max(len(a), len(b)) // 2 - 1
    a_match = [False] * len(a)
    b_match = [False] * len(b)
    matches = 0
    for i, ca in enumerate(a):
        lo, hi = max(0, i - max_dist), min(i + max_dist + 1, len(b))
        for j in range(lo, hi):
            if not b_match[j] and ca == b[j]:
                a_match[i] = b_match[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    t = 0
    k = 0
    for i in range(len(a)):
        if a_match[i]:
            while not b_match[k]:
                k += 1
            if a[i] != b[k]:
                t += 1
            k += 1
    t /= 2
    jaro = (matches / len(a) + matches / len(b) + (matches - t) / matches) / 3
    prefix = 0
    for ca, cb in zip(a[:4], b[:4]):
        if ca == cb:
            prefix += 1
        else:
            break
    return jaro + prefix * 0.1 * (1 - jaro)


def _name_match_score(query, candidate):
    """0..1 blend of token overlap (order-independent, handles initials) and
    Jaro-Winkler (typo-tolerant), taking the best of the candidate as-given and with a
    "Surname, First" -> "First Surname" flip (ULAN stores names reversed)."""
    def variants(name):
        v = [name]
        if "," in name:
            a, b = name.split(",", 1)
            v.append(f"{b.strip()} {a.strip()}")
        return v

    qt = sorted(_name_tokens(query))
    if not qt:
        return 0.0
    best = 0.0
    for cand in variants(candidate):
        ct = sorted(_name_tokens(cand))
        if not ct:
            continue
        # fuzzy token overlap: each query token scored against its best candidate token
        # (so "george" ~ "georges" counts), averaged over the larger token set
        tok = sum(max((_jaro_winkler(q, c) for c in ct), default=0.0) for q in qt) / max(len(qt), len(ct))
        whole = _jaro_winkler(query, cand)
        best = max(best, 0.55 * tok + 0.45 * whole)
    return round(best, 4)


# ── Wikidata fallback ───────────────────────────────────────────────────────────
_ARTIST_OCCUPATION_QIDS = {
    "Q1028181",  # painter
    "Q10862983", # etcher
    "Q11569986", # printmaker
    "Q1281618",  # sculptor
    "Q15296811", # draughtsperson
    "Q483501",   # artist
    "Q1925963",  # graphic artist
    "Q644687",   # illustrator
    "Q329439",   # engraver
    "Q18074503", # visual artist
}


def _search_wikidata(name):
    """wbsearchentities → for each hit, check P31=human (Q5) and P106 in the artist set.
    Deterministic API, lighter than SPARQL, and covers artists ULAN lacks."""
    try:
        url = "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({
            "action": "wbsearchentities", "search": name, "language": "en",
            "type": "item", "limit": "7", "format": "json",
        })
        req = urllib.request.Request(url, headers={"User-Agent": "PrintMasterAI/1.0 (artist-identity resolver)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            hits = json.loads(r.read()).get("search", [])
        if not hits:
            return []
        qids = [h["id"] for h in hits]
        url2 = "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({
            "action": "wbgetentities", "ids": "|".join(qids), "props": "claims|labels",
            "languages": "en", "format": "json",
        })
        req2 = urllib.request.Request(url2, headers={"User-Agent": "PrintMasterAI/1.0 (artist-identity resolver)"})
        with urllib.request.urlopen(req2, timeout=15) as r:
            ents = json.loads(r.read()).get("entities", {})
        out = []
        for qid in qids:
            e = ents.get(qid, {})
            claims = e.get("claims", {})
            is_human = any(
                c.get("mainsnak", {}).get("datavalue", {}).get("value", {}).get("id") == "Q5"
                for c in claims.get("P31", [])
            )
            occ = {
                c.get("mainsnak", {}).get("datavalue", {}).get("value", {}).get("id")
                for c in claims.get("P106", [])
            }
            if is_human and occ & _ARTIST_OCCUPATION_QIDS:
                label = e.get("labels", {}).get("en", {}).get("value", qid)
                ulan = None
                for c in claims.get("P245", []):  # ULAN ID property
                    ulan = c.get("mainsnak", {}).get("datavalue", {}).get("value")
                out.append({"qid": qid, "label": label, "ulanIdFromWikidata": ulan})
        return out
    except Exception:
        return []


def resolve_artist(raw_name):
    """
    raw_name: the artist name as it appears in a source that has no authority ID of
              its own (e.g. an auction listing).

    Wikidata is tried first — its search is typo-tolerant, its endpoint is reliable
    (unlike Getty's), and an artist entity often carries the ULAN id directly (P245), so
    one hit yields BOTH authority ids. ULAN's luc:term search then fills / confirms the
    ULAN when Wikidata didn't have it.

    Confidence tiers (only "high_confidence_auto" is safe for the backfill to write):
      - "high_confidence_auto": a single dominant match at score >= 0.92 with the runner-up
        (if any) >= 0.15 lower — from Wikidata (with or without a paired ULAN) or ULAN.
      - "single_candidate_strong": a dominant match at 0.82-0.92 — likely right, review.
      - "multiple_candidates": two+ within 0.15 of each other — a name collision.
      - "unresolved": nothing plausible.
    """
    stripped = strip_honorifics(raw_name)

    # ── Wikidata ──
    wikidata = _search_wikidata(stripped)
    for w in wikidata:
        w["matchScore"] = _name_match_score(stripped, w["label"])
    wikidata.sort(key=lambda w: w["matchScore"], reverse=True)

    # ── ULAN luc:term ──
    candidates = []
    for b in _search_ulan(stripped):
        candidates.append({
            "ulanId": b["ulan"]["value"].rsplit("/", 1)[-1],
            "ulanUrl": b["ulan"]["value"],
            "ulanName": b["name"]["value"],
            "bio": None,
            "matchScore": _name_match_score(stripped, b["name"]["value"]),
        })
    candidates.sort(key=lambda c: c["matchScore"], reverse=True)

    # If the top Wikidata hit carries a ULAN id, promote/merge it into the ULAN list.
    wd_top = wikidata[0] if wikidata else None
    if wd_top and wd_top.get("ulanIdFromWikidata"):
        uid = wd_top["ulanIdFromWikidata"]
        if not any(c["ulanId"] == uid for c in candidates):
            candidates.insert(0, {
                "ulanId": uid,
                "ulanUrl": canonical_ulan_url(uid),
                "ulanName": wd_top["label"],
                "bio": None,
                "matchScore": wd_top["matchScore"],
                "viaWikidata": True,
            })
            candidates.sort(key=lambda c: c["matchScore"], reverse=True)

    # ── confidence ──
    best_ulan = candidates[0]["matchScore"] if candidates else 0.0
    runner_ulan = candidates[1]["matchScore"] if len(candidates) > 1 else 0.0
    best_wd = wd_top["matchScore"] if wd_top else 0.0
    runner_wd = wikidata[1]["matchScore"] if len(wikidata) > 1 else 0.0

    ulan_auto = best_ulan >= 0.92 and best_ulan - runner_ulan >= 0.15
    wd_auto = best_wd >= 0.92 and best_wd - runner_wd >= 0.15
    # BUG FIX (found 2026-09-01, "Alexander King" / "Alexander Yakut" case): wd_auto
    # confirms the WIKIDATA identity is unambiguous — it says nothing about whether any
    # particular ULAN candidate is that same person. The old `auto = ulan_auto or
    # wd_auto` let a confirmed-but-ULAN-less Wikidata match auto-write candidates[0],
    # which is just whatever the ULAN search ranked first — observed writing "Karther,
    # Alexander" (score 0.84, an unrelated landscape architect) for the query "Alexander
    # Yakut" this way. wd_auto may only contribute to `auto` when Wikidata itself pairs
    # a ULAN id (wd_top["ulanIdFromWikidata"]) — i.e. Wikidata is vouching for THIS
    # specific ULAN record, not just that the person exists. Confirmed found via a
    # local re-triage of 992 already-written nodes: 104 had a stored ULAN scoring
    # < 0.92 against the query name under this exact failure mode.
    wd_auto_with_ulan = wd_auto and bool(wd_top and wd_top.get("ulanIdFromWikidata"))
    auto = ulan_auto or wd_auto_with_ulan
    strong = (best_ulan >= 0.82 and best_ulan - runner_ulan >= 0.10) or (
        best_wd >= 0.85 and best_wd - runner_wd >= 0.10
    )
    if auto:
        confidence = "high_confidence_auto"
    elif strong:
        confidence = "single_candidate_strong"
    elif best_ulan >= 0.55 or best_wd >= 0.60:
        confidence = "multiple_candidates"
    else:
        confidence = "unresolved"

    # BUG FIX (found 2026-08-31, "Sidney Nolan" case): a Wikidata match with no
    # runner-up (runner_wd defaults to 0.0 when Wikidata returns a single hit) can
    # satisfy wd_auto even while the ULAN side is a genuine unresolved tie between
    # DIFFERENT real people who happen to share a name (e.g. three distinct ULAN
    # records all literally named "Nolan, Sidney" — an Australian painter, a
    # Russian sculptor, and an American filmmaker). When that happens,
    # candidates[0] is whatever the tied ULAN search returned first — NOT
    # necessarily the person Wikidata actually confirmed. If wd_auto is what
    # drove "auto" (not ulan_auto), the Wikidata-linked ULAN id must be moved to
    # candidates[0] unconditionally — not only when it was previously absent from
    # the ULAN list — since a same-name-different-person collision means it's
    # very likely present, just not necessarily first.
    if wd_auto and not ulan_auto and wd_top and wd_top.get("ulanIdFromWikidata"):
        uid = wd_top["ulanIdFromWikidata"]
        idx = next((i for i, c in enumerate(candidates) if c["ulanId"] == uid), None)
        if idx is not None and idx != 0:
            candidates.insert(0, candidates.pop(idx))
        elif idx is None:
            candidates.insert(0, {
                "ulanId": uid,
                "ulanUrl": canonical_ulan_url(uid),
                "ulanName": wd_top["label"],
                "bio": None,
                "matchScore": wd_top["matchScore"],
                "viaWikidata": True,
            })

    if candidates and confidence in ("high_confidence_auto", "single_candidate_strong") and not candidates[0].get("viaWikidata"):
        candidates[0]["bio"] = _fetch_bio(candidates[0]["ulanUrl"])

    return {
        "query": raw_name,
        "strippedName": stripped,
        "candidates": candidates,
        "wikidata": wikidata,
        "confidence": confidence,
        # convenience: the ids the backfill would write on a high_confidence_auto
        "resolvedUlanUrl": candidates[0]["ulanUrl"] if candidates else None,
        "resolvedUlanName": candidates[0]["ulanName"] if candidates else None,
        "resolvedWikidataUrl": f"http://www.wikidata.org/entity/{wd_top['qid']}" if wd_top else None,
    }


# ── DOB tie-break for genuine name-twins ────────────────────────────────────────
# "multiple_candidates" is frequently NOT ambiguity about which real person is meant
# (the graph's source record is unambiguous) — it's several distinct ULAN records that
# happen to share the exact same full name (e.g. 11 different "Taylor, John" entries).
# When the query's dateBorn_year lands on exactly one of the complete-name-matched
# (score >= 0.92) candidates' bios, that's a safe, free resolution — verified against
# 21 real Roseberys cases (2026-09-01), including several with 3-11 tied candidates,
# with zero false positives on spot-check.
#
# The birth-year extraction is deliberately strict, three patterns only, ordered so a
# "YYYY-YYYY" range is read as (birth, death) and never confused with a death year —
# this fixes a real bug found in this project's history: a looser "any 4-digit year in
# the bio" check matched a bio's DEATH year and produced a false corroboration
# ("Donald Smith" -> a candidate who merely died in the query's birth year, wrong
# person, wrong name too). Do not loosen these patterns without re-testing that case.
_BIRTH_YEAR_PATTERNS = [
    re.compile(r'\bborn\s+(?:in\s+)?(\d{4})\b', re.I),
    re.compile(r'\bb\.\s*(\d{4})\b'),
    re.compile(r',\s*(\d{4})\s*-\s*(?:\d{4}|present|\.\.\.|\?)?\b'),  # "1904-1982" / "1954-": first year is birth
]


def _extract_birth_year(bio):
    """Strict birth-year extraction from a ULAN bio string — see the module note above
    for why this can't be loosened to "any year in the bio"."""
    if not bio:
        return None
    for pat in _BIRTH_YEAR_PATTERNS:
        m = pat.search(bio)
        if m:
            return int(m.group(1))
    return None


def resolve_artist_with_dob(raw_name, dob_year):
    """resolve_artist() plus a DOB tie-break for the "multiple_candidates" case where
    several ULAN records share the exact same full name (score >= 0.92 "complete
    match"). If dob_year uniquely corroborates exactly one of the tied candidates'
    birth years (via _extract_birth_year, never the death year — see module note), the
    result is upgraded to confidence "dob_tiebreak_auto" with that candidate moved to
    candidates[0] and its bio attached. If dob_year is absent, or doesn't uniquely
    resolve the tie (0 or 2+ matches), the original resolve_artist() result is returned
    unchanged — this never downgrades or overrides an existing auto/strong result.
    """
    r = resolve_artist(raw_name)
    if not dob_year or r["confidence"] != "multiple_candidates":
        return r

    complete = [c for c in r["candidates"] if c["matchScore"] >= 0.92]
    if len(complete) < 2:
        return r

    matches = []
    for c in complete:
        bio = c.get("bio") or _fetch_bio(c["ulanUrl"])
        if _extract_birth_year(bio) == dob_year:
            matches.append({**c, "bio": bio})

    if len(matches) != 1:
        return r

    winner = matches[0]
    r = dict(r)
    r["confidence"] = "dob_tiebreak_auto"
    r["candidates"] = [winner] + [c for c in r["candidates"] if c["ulanId"] != winner["ulanId"]]
    r["resolvedUlanUrl"] = winner["ulanUrl"]
    r["resolvedUlanName"] = winner["ulanName"]
    r["dobTiebreakEvidence"] = {"dobYear": dob_year, "tiedCandidates": len(complete), "bio": winner["bio"]}
    return r


if __name__ == "__main__":
    import sys
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    for name in args:
        r = resolve_artist(name)
        if as_json:
            print(json.dumps(r, ensure_ascii=False))
            continue
        print(f"\n{r['query']!r}  (stripped: {r['strippedName']!r})  ->  {r['confidence']}")
        for c in r["candidates"][:4]:
            print(f"   ULAN {c['ulanId']}  {c['ulanName']!r}   score={c['matchScore']}"
                  + (f"   [{c['bio']}]" if c.get("bio") else ""))
        for w in r.get("wikidata", [])[:3]:
            print(f"   WD   {w['qid']}  {w['label']!r}   score={w['matchScore']}"
                  + (f"   ulan-from-WD={w['ulanIdFromWikidata']}" if w.get("ulanIdFromWikidata") else ""))
