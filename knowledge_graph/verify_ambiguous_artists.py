"""
PrintMasterAI — bio + web-search verification for artists stuck as multiple_candidates /
single_candidate_strong in the ULAN backfill (see backfill_artist_ulan.py, ADR-... none
yet, discussed 2026-08-31).

Why this exists: the string-fuzzy-match resolver in resolve_artist_identity.py cannot
tell apart real name-twins in ULAN (e.g. "Sidney Nolan" the Australian painter vs. a
Russian sculptor vs. an American filmmaker, all literally named "Nolan, Sidney"). ~1,000
artists in this graph are stuck in exactly this state — a plausible candidate exists, but
the fuzzy score alone can't confirm it. This script gives an LLM real disambiguating
evidence (each candidate's ULAN bio) plus live web search, and asks for an explicit
CONFIRM / REJECT / UNCERTAIN verdict with a cited rationale — never writes to the graph
itself. Output is a review CSV for a human (or a follow-up write step once this trial
is validated), consistent with this project's never-auto-merge policy (ADR-0008) and
[[feedback-defer-broad-sweeps]].

Usage:
    python3 verify_ambiguous_artists.py --limit 20              # trial run, this file
    python3 verify_ambiguous_artists.py --limit 20 --model claude-haiku-4-5   # cheaper
"""
import argparse
import csv
import json
import os
import re
import time
from datetime import datetime, timezone

import anthropic
from neo4j import GraphDatabase

from resolve_artist_identity import resolve_artist, _fetch_bio

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artist_verification_report.csv")

DEFAULT_MODEL = "claude-opus-5"
MAX_CANDIDATES_WITH_BIO = 3

SYSTEM_PROMPT = """You are verifying artist identity for a fine-art-print knowledge \
graph. You will be given an artist name as it appears in an auction/museum record, \
plus a short list of Getty ULAN authority-record candidates that fuzzy name-matching \
found plausible — each with its own biography snippet. Multiple different real people \
can share the exact same name (e.g. three different people are all literally named \
"Sidney Nolan" in ULAN); your job is to determine, using the bios and web search, which \
candidate (if any) is actually the SAME real individual as the graph's artist name — not \
just a string match.

Ground your verdict in concrete facts: nationality, active dates/era, medium/occupation, \
and anything else that lets you confirm or rule out a candidate. Use web search only when \
the bios alone are not decisive. If you are not genuinely confident after searching, say \
UNCERTAIN rather than guessing — a wrong confirmation is worse than an honest "don't know".

Respond with your reasoning, then end your reply with EXACTLY one fenced JSON block, \
nothing after it:

```json
{
  "verdict": "CONFIRM" | "REJECT" | "UNCERTAIN",
  "matchedUlanId": "<the ulanId string of the confirmed candidate, or null>",
  "rationale": "<one or two sentences citing the specific evidence that decided this>"
}
```

"CONFIRM" only when you're citing real, specific evidence (dates, occupation, a source \
found via search) that ties the graph name to that exact candidate. "REJECT" when none \
of the candidates are the same person as the graph name (e.g. they're all name-twins). \
"UNCERTAIN" when the evidence is genuinely insufficient either way."""


def build_user_prompt(artist_name, node_context, candidates_with_bio, wikidata):
    lines = [f'Graph artist name: "{artist_name}"']
    if node_context.get("nationality"):
        lines.append(f"Known nationality (from the graph): {node_context['nationality']}")
    if node_context.get("dateBorn_year") or node_context.get("dateDied_year"):
        lines.append(
            f"Known dates (from the graph): "
            f"{node_context.get('dateBorn_year', '?')}–{node_context.get('dateDied_year', '?')}"
        )
    lines.append(f"Known print/work count in this graph: {node_context.get('works', '?')}")
    lines.append("")
    lines.append("Candidate ULAN records (fuzzy name match found these plausible):")
    for i, c in enumerate(candidates_with_bio, 1):
        lines.append(
            f"  {i}. ulanId={c['ulanId']}  name=\"{c['ulanName']}\"  "
            f"matchScore={c['matchScore']}  bio={c['bio'] or '(no bio available)'}"
        )
    if wikidata:
        lines.append("")
        lines.append("Wikidata search results (may or may not be relevant):")
        for w in wikidata[:3]:
            lines.append(f"  - {w['label']} ({w['qid']}), name-match score {w['matchScore']}")
    return "\n".join(lines)


_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


def extract_verdict(text):
    m = _JSON_BLOCK_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


# web_search_20260209 (dynamic filtering) needs Opus 5/4.8/4.7/4.6 or Sonnet 5/4.6 —
# Haiku 4.5 (and other older/smaller models) only support the basic variant.
_DYNAMIC_FILTER_MODELS = {
    "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-5", "claude-sonnet-4-6",
}


def _web_search_tool(model):
    tool_type = "web_search_20260209" if model in _DYNAMIC_FILTER_MODELS else "web_search_20250305"
    return {"type": tool_type, "name": "web_search", "max_uses": 3}


def verify_one(client, model, artist_name, node_context, candidates, wikidata):
    # Fetch bios for the top few ULAN candidates — resolve_artist() only does this
    # internally for high_confidence_auto/single_candidate_strong's top pick; here we
    # want it for every candidate we show the model, since disambiguation is the point.
    candidates_with_bio = []
    for c in candidates[:MAX_CANDIDATES_WITH_BIO]:
        bio = c.get("bio")
        if bio is None and not c.get("viaWikidata"):
            bio = _fetch_bio(c["ulanUrl"])
        candidates_with_bio.append({**c, "bio": bio})

    user_prompt = build_user_prompt(artist_name, node_context, candidates_with_bio, wikidata)

    messages = [{"role": "user", "content": user_prompt}]
    restarts = 0
    response = None
    t0 = time.time()
    while restarts <= 3:
        response = client.messages.create(
            model=model,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            tools=[_web_search_tool(model)],
            messages=messages,
        )
        if response.stop_reason != "pause_turn":
            break
        messages.append({"role": "assistant", "content": response.content})
        restarts += 1
    elapsed = time.time() - t0

    text_blocks = [b.text for b in response.content if b.type == "text"]
    full_text = "\n".join(text_blocks)
    verdict = extract_verdict(full_text)
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "web_search_requests": getattr(response.usage.server_tool_use, "web_search_requests", 0)
        if response.usage.server_tool_use else 0,
        "elapsed_s": round(elapsed, 1),
    }
    return verdict, full_text, candidates_with_bio, usage


def fetch_candidates(session, limit):
    q = (
        "MATCH (a:Artist) WHERE a.ulanUrl IS NULL "
        "OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork) "
        "WITH a, count(DISTINCT w) AS works WHERE works >= 2 "
        "RETURN elementId(a) AS eid, a.name AS name, a.nationality AS nationality, "
        "       a.dateBorn_year AS dateBorn_year, a.dateDied_year AS dateDied_year, works "
        "ORDER BY works DESC LIMIT $limit"
    )
    return session.run(q, limit=limit).data()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--report-path", default=REPORT_PATH)
    args = ap.parse_args()

    client = anthropic.Anthropic()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    report_new = not os.path.exists(args.report_path)
    rf = open(args.report_path, "a", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    if report_new:
        rw.writerow([
            "name", "priorConfidence", "verdict", "matchedUlanId", "matchedUlanName",
            "rationale", "candidateCount", "elapsedSeconds", "ts",
        ])

    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            artists = fetch_candidates(session, args.limit)
        print(f"Verifying {len(artists)} artist(s) with model={args.model}\n")

        counts = {"CONFIRM": 0, "REJECT": 0, "UNCERTAIN": 0, "no_candidates": 0, "parse_error": 0}
        for i, a in enumerate(artists, 1):
            name = a["name"]
            r = resolve_artist(name)
            candidates = r["candidates"]
            if not candidates:
                counts["no_candidates"] += 1
                print(f"  [{i}/{len(artists)}] {name!r}: no ULAN candidates at all — skipping")
                rw.writerow([name, r["confidence"], "no_candidates", "", "", "", 0, 0,
                             datetime.now(timezone.utc).isoformat()])
                rf.flush()
                continue

            verdict, full_text, candidates_with_bio, usage = verify_one(
                client, args.model, name, a, candidates, r.get("wikidata")
            )
            print(f"      usage: {usage}")

            if verdict is None:
                counts["parse_error"] += 1
                print(f"  [{i}/{len(artists)}] {name!r}: FAILED TO PARSE VERDICT")
                print(f"      raw tail: {full_text[-300:]!r}")
                rw.writerow([name, r["confidence"], "parse_error", "", "", full_text[:300],
                             len(candidates_with_bio), usage.get("elapsed_s", 0),
                             datetime.now(timezone.utc).isoformat()])
            else:
                v = verdict.get("verdict", "UNCERTAIN")
                counts[v] = counts.get(v, 0) + 1
                matched_id = verdict.get("matchedUlanId")
                matched_name = next(
                    (c["ulanName"] for c in candidates_with_bio if c["ulanId"] == matched_id), ""
                )
                print(f"  [{i}/{len(artists)}] {name!r}: {v}"
                      + (f" -> {matched_name!r} ({matched_id})" if matched_id else ""))
                print(f"      {verdict.get('rationale', '')}")
                rw.writerow([name, r["confidence"], v, matched_id or "", matched_name,
                             verdict.get("rationale", ""), len(candidates_with_bio),
                             usage.get("elapsed_s", 0),
                             datetime.now(timezone.utc).isoformat()])
            rf.flush()
            time.sleep(1.0)

        print(f"\ndone — {counts} ({args.report_path})")
    finally:
        rf.close()
        driver.close()


if __name__ == "__main__":
    main()
