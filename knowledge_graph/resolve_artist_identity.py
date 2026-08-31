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

import re
import time
import urllib.parse
import urllib.request
import urllib.error
import json

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


def _search_ulan(name):
    # Deliberately does NOT join biography in this query. An earlier version joined
    # `foaf:focus/gvp:biographyPreferred/schema:description` here and it was confirmed
    # to make the endpoint take 60+ seconds (timed out) even though the equivalent
    # query without that join reliably returns in under a second. Fetch bio
    # separately, only for the candidate(s) actually worth showing — see
    # _fetch_bio(), called just on the top-ranked result.
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
    """Separate, cheap, single-record lookup — not joined into the bulk search."""
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
                "ulanUrl": f"http://vocab.getty.edu/ulan/{uid}",
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

    auto = (
        (best_ulan >= 0.92 and best_ulan - runner_ulan >= 0.15)
        or (best_wd >= 0.92 and best_wd - runner_wd >= 0.15)
    )
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
