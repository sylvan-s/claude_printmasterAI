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
_HONORIFIC_PREFIXES = [
    "sir", "dame", "lord", "lady", "dr", "prof", "professor", "the hon", "hon",
]
_POSTNOMINAL_SUFFIXES = [
    "ra", "rha", "rsa", "rws", "roi", "npra", "are", "ceo", "obe", "mbe", "cbe",
    "dbe", "che", "ch", "kt", "dbe", "frsa", "phd", "md",
    # Added after finding these caused real Artist-node fragmentation in the Roseberys
    # bulk data (L.S. Lowry split across "RA RBA LG NS" variants that weren't stripped):
    "rba", "lg", "ns", "om", "fba", "prba", "rp", "hrsa", "rsw",
]


def strip_honorifics(name):
    """Remove known honorific prefixes and post-nominal suffixes from a display name."""
    tokens = name.replace(",", " ").split()
    # Strip trailing all-caps post-nominal tokens (e.g. "RA", "CH", "DBE")
    while tokens and tokens[-1].lower().rstrip(".") in _POSTNOMINAL_SUFFIXES:
        tokens.pop()
    # Strip leading honorific tokens (e.g. "Dame", "Sir")
    while tokens and tokens[0].lower().rstrip(".") in _HONORIFIC_PREFIXES:
        tokens.pop(0)
    return " ".join(tokens).strip()


def _sparql_query(query, retries=3, backoff_seconds=8.0):
    # Confirmed by testing, not assumed: Getty's endpoint throttles under moderate
    # request frequency, with a real cooldown longer than a short retry (an isolated
    # query failing back-to-back succeeded cleanly after a 15s wait). Any caller
    # processing more than a handful of artists needs real spacing between requests
    # (several seconds, not milliseconds) — this is not safe to hammer in a tight loop
    # the way met_ingest.py's Met API calls are.
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
    last_error = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read())
        except (json.JSONDecodeError, urllib.error.URLError) as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
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


def resolve_artist(raw_name):
    """
    raw_name: the artist name as it appears in a source that has no authority ID of
              its own (e.g. an auction listing).

    Returns candidates ranked by token overlap with the stripped query name — this is
    NOT a claim of correctness, just a ranked shortlist with enough evidence (ULAN's
    own bio string) for a human or a tool-using step to judge. Confidence tiers:
      - "single_candidate_strong": exactly one candidate, high token overlap with
        the query name — still not auto-verified, but the best case this tool gives.
      - "multiple_candidates": more than one plausible match (e.g. the Boussidan
        surname collision found earlier) — needs given-name/biography disambiguation
        a human or agent should do, not this script.
      - "unresolved": no ULAN candidates at all.
    """
    stripped = strip_honorifics(raw_name)
    bindings = _search_ulan(stripped)

    query_tokens = _name_tokens(stripped)
    candidates = []
    for b in bindings:
        cand_name = b["name"]["value"]
        cand_tokens = _name_tokens(cand_name)
        overlap = len(query_tokens & cand_tokens)
        candidates.append({
            "ulanId": b["ulan"]["value"].rsplit("/", 1)[-1],
            "ulanUrl": b["ulan"]["value"],
            "ulanName": cand_name,
            "bio": None,  # filled in below, top candidate only
            "nameTokenOverlap": overlap,
        })

    candidates.sort(key=lambda c: c["nameTokenOverlap"], reverse=True)

    if not candidates:
        confidence = "unresolved"
    elif len(candidates) == 1 or candidates[0]["nameTokenOverlap"] > candidates[1]["nameTokenOverlap"]:
        confidence = "single_candidate_strong" if candidates[0]["nameTokenOverlap"] >= 2 else "multiple_candidates"
    else:
        confidence = "multiple_candidates"

    # Bio is only fetched for the top-ranked candidate, as a separate cheap query —
    # not joined into the bulk search (see _search_ulan's docstring for why).
    if candidates:
        candidates[0]["bio"] = _fetch_bio(candidates[0]["ulanUrl"])

    return {
        "query": raw_name,
        "strippedName": stripped,
        "candidates": candidates,
        "confidence": confidence,
    }


if __name__ == "__main__":
    import sys
    for name in sys.argv[1:]:
        result = resolve_artist(name)
        print(json.dumps(result, indent=2, ensure_ascii=False))
