"""
PrintMasterAI — apply the spelling-variant merge rule.
Version: SPELLING-VARIANT-MERGE-1.0

Consumes `find_spelling_variant_merges.py --scan --json` and folds the clusters that earn it,
through `merge_duplicate_work_clusters.py`'s own writer (rule `spellingVariant`). Dry run by
default; --apply writes.

TWO ADMISSION PATHS, because the two title classes measured differently on 2026-09-20:

  ARTICLE CLASS -> admitted on the rule alone. Titles identical once a leading article,
  punctuation and accents are folded, with the cluster's images agreeing and no work by that
  artist outside the variant family as close. 54 of 54 were confirmed SAME_WORK by Haiku 4.5,
  and Opus 5 agreed with Haiku on 13 of 13 in a random audit. No token changes its number, so
  no title can quietly denote a different composition.

  PLURALS AND ANYTHING UNCERTAIN -> a vision adjudication decides, never the rule. A plural in
  a print title can name a different composition: Warhol's "Guns - Flintlock Pistols" is a
  sheet of pistols, "Gun - Flintlock Pistol" is one pistol, and their images score 0.9485 —
  the embedding gate passes them. Both Haiku and Opus return DIFFERENT_WORK on that pair with
  the plate numbers cited, which is why adjudication is the gate here and a catalogue-number
  proxy is not: requiring identical citations would have REFUSED Johns's "Voice 2"/"Voices 2",
  which is one print whose record carries a stray second citation.

  Measured on the 28 plural clusters (30 pairs): 27 SAME_WORK, 1 DIFFERENT_WORK (the Warhol),
  1 that neither model nor a human could call (Morellet's "Horizontale"/"Horizontales", two
  near-blank sheets whose only content is the line that would differ). That one stays unmerged,
  which is the point of the review file.

WHAT IS NEVER ADMITTED HERE. `catalogueConflict`, `techniqueConflict`, `notDistinctive`,
`imageDissent` and `noImage` are the scan's own vetoes and this script will not read them, with
or without an adjudication. A model verdict cannot overturn a veto; it can only decide a case
the vetoes already let through.

A verdict that is not a confident SAME_WORK is NOT a refusal either — it goes to the review
file. UNCERTAIN in particular has twice turned out to be infrastructure rather than doubt (an
image over the pixel cap, an image over the byte cap; both fixed in adjudicate_merge_candidates.py),
so treating it as "no" would silently lose real merges, and treating it as "yes" would merge on
a failed fetch.

Usage (source .env first):
    python3 merge_spelling_variants.py --json spelling.json
    python3 merge_spelling_variants.py --json spelling.json --apply --backup premerge.json
    python3 merge_spelling_variants.py --json spelling.json --adjudicate-all   # article class too
"""

import argparse
import json
import os
import re
import unicodedata
from datetime import datetime

import anthropic
from neo4j import GraphDatabase

import adjudicate_merge_candidates as adj
import merge_duplicate_work_clusters as mergetool

VERSION = "SPELLING-VARIANT-MERGE-1.0"
RULE = "spellingVariant"
ADJUDICATION_MODEL = "claude-haiku-4-5"
ESCALATION_MODEL = "claude-opus-5"
# A verdict below this is not trusted to merge on its own; it escalates, then goes to review.
MIN_CONFIDENCE = 0.90
# Buckets the scan already vetoed. Named so the refusal is explicit rather than implied.
VETOED = ("catalogueConflict", "techniqueConflict", "notDistinctive", "imageDissent", "noImage")

DETAIL_QUERY = """
MATCH (w:ConceptualWork {id: $id})
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (s:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (i)<-[:SHOWS]-(d:DigitalImage) WHERE d.sourceUrl IS NOT NULL
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(w)
OPTIONAL MATCH (cr:CatalogueRaisonne)-[:CONTAINS]->(ce)
RETURN w.name AS title, w.dateCreated_year AS year, count(DISTINCT i) AS impressions,
       collect(DISTINCT s.institutionName)[0..3] AS institutions,
       collect(DISTINCT cr.numberingPrefix + ' ' + ce.number)[0..3] AS catalogue,
       collect(DISTINCT t.name)[0..3] AS tech,
       collect(DISTINCT d.sourceUrl)[0..2] AS images,
       collect(DISTINCT i.editionNumber)[0..2] AS editions
"""


def fold(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def cluster_title(cluster):
    """The writer keys its log line and MergeEvent.clusterTitle on `title`, which the exact-key
    scan emits and this one does not — it carries `titles`, a list, because a variant cluster
    has several by definition. Give it the folded common form."""
    return re.sub(r"^the\s+", "", fold(cluster["titles"][0]))


def is_article_class(cluster):
    """No token changed its number — the class that needs no adjudication."""
    keys = {re.sub(r"^the\s+", "", fold(t)) for t in cluster["titles"]}
    return len(keys) == 1


def side(details, wid, letter):
    d = details[wid]
    return {
        f"title{letter}": d["title"], f"year{letter}": d["year"],
        f"institutions{letter}": ", ".join(x for x in d["institutions"] if x),
        f"catalogue{letter}": ", ".join(d["catalogue"]),
        f"techFamily{letter}": ", ".join(d["tech"]),
        f"edition{letter}": ", ".join(str(x) for x in d["editions"] if x),
        f"impressions{letter}": d["impressions"],
        f"images{letter}": " | ".join(d["images"]),
    }


def adjudication_rows(cluster, details):
    """One row per PAIR — a three-spelling cluster is three decisions, and the cluster is only
    admitted when every pair in it comes back SAME_WORK."""
    ids = cluster["workIds"]
    rows = []
    for n, (a, b) in enumerate([(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))], 1):
        cat_a = set(details[a]["catalogue"])
        cat_b = set(details[b]["catalogue"])
        row = {"rank": f"{cluster['artist']}#{n}", "matchWeight": cluster["evidence"].get("minPairSim", ""),
               "artist": cluster["artist"], "workA": a, "workB": b,
               "catalogueVerdict": "agree" if (cat_a & cat_b) else ("none" if not (cat_a or cat_b) else "one-sided"),
               "flags": cluster["class"], "designationDiffers": "0", "route": "needsVision"}
        row.update(side(details, a, "A"))
        row.update(side(details, b, "B"))
        rows.append(row)
    return rows


def verdict_for(client, model, rows, cache, spend):
    """Adjudicate every pair in a cluster. Returns (decision, per-pair results)."""
    results = []
    for row in rows:
        res = adj.adjudicate(client, model, row, cache)
        pin, pout = adj.PRICING.get(model, (0, 0))
        spend[model] = spend.get(model, 0.0) + (res.get("inputTokens", 0) * pin
                                                + res.get("outputTokens", 0) * pout) / 1e6
        results.append({"pair": f"{row['titleA']} ~ {row['titleB']}", "model": model,
                        "verdict": res.get("verdict"), "confidence": res.get("confidence"),
                        "reasoning": (res.get("reasoning") or "")[:400]})
    # A refusal has to clear the same bar as an admission. The first version refused on any
    # DIFFERENT_WORK at any confidence, so Morellet's 0.75 and Raine's 0.85 were final while a
    # 0.89 SAME_WORK escalated — an asymmetry with nothing behind it. Opus had already called
    # Morellet SAME_WORK at 0.82 in the plural review, so the cheap model's shaky "no" was
    # silently overriding the expensive model's shaky "yes".
    refusals = [r for r in results if r["verdict"] == "DIFFERENT_WORK"]
    if any(float(r["confidence"] or 0) >= MIN_CONFIDENCE for r in refusals):
        return "refused", results
    if not refusals and all(r["verdict"] == "SAME_WORK"
                            and float(r["confidence"] or 0) >= MIN_CONFIDENCE for r in results):
        return "admitted", results
    return "review", results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="find_spelling_variant_merges.py --scan --json output")
    ap.add_argument("--artist", help="restrict to one Artist node's exact name")
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--backup", help="pre-merge member state, passed to the merge writer")
    ap.add_argument("--review", default="spelling_variant_review.json",
                    help="clusters that need a human, with their verdicts")
    ap.add_argument("--model", default=ADJUDICATION_MODEL)
    ap.add_argument("--escalation-model", default=ESCALATION_MODEL,
                    help="re-adjudicates anything the first model did not decide confidently")
    ap.add_argument("--adjudicate-all", action="store_true",
                    help="adjudicate the article class too, instead of admitting it on the rule")
    args = ap.parse_args()

    for var in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"):
        if not os.environ.get(var):
            raise RuntimeError(f"{var} is not set. Source .env first.")
    data = json.load(open(args.json))
    for bucket in VETOED:
        if data.get(bucket):
            print(f"[VETO] {len(data[bucket])} cluster(s) in {bucket} — not read by this script")

    pool = []
    for bucket in ("proposed", "pluralHeld", "typo1Held"):
        for c in data.get(bucket, []):
            if args.artist and c.get("artist") != args.artist:
                continue
            pool.append((bucket, c))
    if not pool:
        print("nothing to consider")
        return

    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    database = os.environ.get("NEO4J_DATABASE", "neo4j")
    details = {}
    with driver.session(database=database) as session:
        for _, c in pool:
            for wid in c["workIds"]:
                if wid not in details:
                    rec = session.run(DETAIL_QUERY, id=wid).single()
                    details[wid] = dict(rec) if rec else None

    client = anthropic.Anthropic() if os.environ.get("ANTHROPIC_API_KEY") else None
    cache, admitted, refused, review, spend = {}, [], [], [], {}
    for bucket, c in pool:
        if any(details.get(w) is None for w in c["workIds"]):
            review.append({**c, "bucket": bucket, "decision": "review",
                           "why": "a member work is no longer in the graph"})
            continue
        if bucket == "proposed" and is_article_class(c) and not args.adjudicate_all:
            admitted.append({**c, "title": cluster_title(c), "bucket": bucket,
                             "admittedBy": "rule (article class)"})
            continue
        if client is None:
            raise RuntimeError("ANTHROPIC_API_KEY is not set, and this run needs adjudication.")
        rows = adjudication_rows(c, details)
        decision, results = verdict_for(client, args.model, rows, cache, spend)
        if decision == "review" and args.escalation_model:
            decision, results = verdict_for(client, args.escalation_model, rows, cache, spend)
        entry = {**c, "title": cluster_title(c), "bucket": bucket, "verdicts": results}
        if decision == "admitted":
            admitted.append({**entry, "admittedBy": f"adjudication ({results[0]['model']})"})
        elif decision == "refused":
            refused.append(entry)
        else:
            review.append({**entry, "decision": "review"})
        print(f"  [{decision:8}] {c['artist'][:22]:24} {' ~ '.join(c['titles'])[:56]}")

    print(f"\n{len(admitted)} admitted, {len(refused)} refused, {len(review)} to review")
    if spend:
        print("adjudication cost: " + ", ".join(f"{m} ${c:.3f}" for m, c in spend.items())
              + f"  (total ${sum(spend.values()):.3f})")
    json.dump({"version": VERSION, "at": datetime.now().isoformat(),
               "refused": refused, "review": review},
              open(args.review, "w"), indent=1)
    print(f"refusals and review queue -> {args.review}")

    if not admitted:
        driver.close()
        return
    plan_path = args.review.replace(".json", "") + "_admitted.json"
    json.dump({"proposed": admitted}, open(plan_path, "w"), indent=1)
    print(f"admitted clusters (merge contract) -> {plan_path}")
    if not args.apply:
        print("\nDRY RUN — nothing merged. Re-run with --apply.")
        driver.close()
        return
    with driver.session(database=database) as session:
        mergetool.run(session, admitted, True, backup_path=args.backup, rule=RULE)
    driver.close()


if __name__ == "__main__":
    main()
