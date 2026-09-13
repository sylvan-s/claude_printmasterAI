"""
PrintMasterAI — Splink-ranked merge candidates for visual adjudication.
Version: SPLINK-CANDIDATES-1.0

Emits a CANDIDATE LIST, not a merge plan. Nothing here merges, and its output is deliberately
NOT the JSON contract `merge_duplicate_work_clusters.py` consumes — that contract's `proposed`
bucket means "eligible to fold", and this list is not.

WHY IT STOPS SHORT OF PROPOSING. Measured on Picasso within Baer (`fit_splink_work_identity.py`):

    match_weight   flagged    TP   precision   recall
        0 (p .50)      239   124       51.9%    86.7%
        5 (p .97)      103    84       81.6%    58.7%
       10 (p .999)      18    18      100.0%    12.6%

THAT TABLE DOES NOT DESCRIBE THIS OUTPUT, and the distinction matters. Its "TP" are pairs of
records already sitting on ONE ConceptualWork — prior merges. Those are dropped here (see note 1),
so the candidates are precisely the rows that table counted as FALSE positives. Their real
precision is unknown, which is the whole reason a visual pass exists: each is either two
different works, or a duplicate the graph has not folded yet, and nothing in the metadata
separates those two readings.

What the model is good at is the reduction. On Picasso within Baer it turned 686,206 pairs into
104 candidates, every one with an image on both sides — a 6,600-fold cut in what has to be
looked at, at 87% recall of the matches it could be checked against.

Every flag is reported, never applied. A catalogue-base conflict or a technique-family
disagreement is strong evidence of different works — the anchored generator vetoes on the first —
but here they are columns, because the adjudicator is being shown the pictures and a wrong veto
would silently remove a true pair from the only list anyone looks at.

TWO THINGS THAT WOULD BE BUGS IF NOT DONE.

  1. SAME-WORK PAIRS ARE KEPT FOR THE FIT AND DROPPED FROM THE OUTPUT. Records are one per
     (work, institution), so two institutions describing one already-merged work form a pair.
     Those pairs are the strongest label-free evidence of what a true match LOOKS like, so EM
     needs them; they are not merge candidates, because the nodes are already one. Dropping them
     before the fit would estimate m from nothing.

     They are not entirely innocent: co-residence on one node is a prior merge decision, so m is
     estimated partly from the rules' own past output. That is milder than training a classifier
     on those labels — EM never sees the label, only the records — but it is not zero and is
     recorded here rather than left for someone to find.

  2. OUTPUT IS AGGREGATED TO WORK PAIRS. Splink links RECORDS. A work with three institutions
     produces three records, so one work pair can surface as several record pairs; the strongest
     is kept and the rest collapsed, or the same candidate would be adjudicated repeatedly.

Usage:
    python3 generate_splink_merge_candidates.py --artist "Pablo Picasso" --catalogue baer \
        --out candidates.csv
    python3 generate_splink_merge_candidates.py --artist "Henry Moore" --min-weight 5
"""

import argparse
import csv
import os
import re
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase
from splink import DuckDBAPI, Linker, block_on

from fit_splink_work_identity import (
    DETERMINISTIC_RECALL, U_SAMPLE_PAIRS, _require_env, build_records, settings,
    technique_family,
)

DEFAULT_MIN_WEIGHT = 0.0        # p >= 0.5; the 86.7%-recall band, see docstring
DEFAULT_IMAGES_PER_SIDE = 2
MAX_YEAR_SPREAD = 3             # same constant the image generator holds components on

# A DESIGNATION THE PICTURE WILL NOT SHOW. The first run put "La Femme qui pleure. III" against
# ". IV", and ". IV" against ". V", in the top six — same Baer 623, same year, same institution,
# and visually near-identical because they ARE one plate. ADR-0017 Amendment 2 measured this:
# a trailing Roman numeral is a PLATE designation, orthogonal to state, and 14 of 31 works
# carrying both axes hold two to five states behind one numeral. A vision model shown two states
# of one plate will call them the same image and be right about the image and wrong about the
# work. So when two titles are identical except for a trailing designation, say so loudly — it is
# the one thing on this list that looking harder cannot settle.
_TRAILING_DESIGNATION_RE = re.compile(
    r"[\s,.\-–(\[]+(?:(?:no|pl|planche|plate|state|etat|état)\.?\s*)?"
    r"([IVXLC]{1,6}|\d{1,3})\s*[)\]]?\s*$", re.I)


def trailing_designation(title):
    """(stem, designation) when a title ends in a plate/state designation, else (None, None)."""
    if not title:
        return None, None
    m = _TRAILING_DESIGNATION_RE.search(title)
    if not m:
        return None, None
    stem = re.sub(r"[^a-z0-9]+", " ", title[:m.start()].lower()).strip()
    return (stem, m.group(0).strip()) if len(stem) >= 4 else (None, None)


def designation_only_difference(title_a, title_b):
    """True when the two titles agree once a trailing designation is lifted off each, and the
    designations differ. That is a different plate or state, not a different wording."""
    stem_a, des_a = trailing_designation(title_a)
    stem_b, des_b = trailing_designation(title_b)
    if stem_a and stem_b and stem_a == stem_b and des_a.lower() != des_b.lower():
        return True
    # one side carries the designation and the other is the bare stem
    for stem, des, other in ((stem_a, des_a, title_b), (stem_b, des_b, title_a)):
        if stem and re.sub(r"[^a-z0-9]+", " ", (other or "").lower()).strip() == stem:
            return True
    return False

# Everything the adjudicator needs to look at a pair, keyed by work.
EVIDENCE_QUERY = """
MATCH (w:ConceptualWork) WHERE w.id IN $ids
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.sourceUrl IS NOT NULL
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
RETURN w.id AS workId, w.name AS name, w.dateCreated_year AS year,
       collect(DISTINCT i.sourceTitle)  AS sourceTitles,
       collect(DISTINCT i.rawMedium)    AS media,
       collect(DISTINCT t.name)         AS techniques,
       collect(DISTINCT img.sourceUrl)  AS imageUrls,
       collect(DISTINCT coalesce(s.institutionName, s.sourceType)) AS institutions,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations,
       count(DISTINCT i) AS impressions
"""


def numeric_prefix(number):
    digits = ""
    for ch in str(number or ""):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits or None


def catalogue_verdict(a_citations, b_citations):
    """'conflict' only when a SHARED prefix carries different numeric bases. A glued suffix is
    an edition or state designation, not a different entry — Baer 618 and 618Bd are one work
    (find_museum_anchored_work_clusters.entry_base_number), so that stays silent."""
    a = defaultdict(set)
    b = defaultdict(set)
    for prefix, number in a_citations:
        if prefix and numeric_prefix(number):
            a[prefix].add(numeric_prefix(number))
    for prefix, number in b_citations:
        if prefix and numeric_prefix(number):
            b[prefix].add(numeric_prefix(number))
    verdict = "silent"
    for prefix in set(a) & set(b):
        if a[prefix] & b[prefix]:
            return "agree"
        verdict = "conflict"
    return verdict


def fit(df):
    db_api = DuckDBAPI()
    linker = Linker(df, settings(), db_api=db_api)
    linker.training.estimate_probability_two_random_records_match(
        ["l.title = r.title and l.entry = r.entry"], recall=DETERMINISTIC_RECALL)
    linker.training.estimate_u_using_random_sampling(max_pairs=U_SAMPLE_PAIRS)
    for rule in (block_on("tech_family"), block_on("entry")):
        try:
            linker.training.estimate_parameters_using_expectation_maximisation(rule)
        except Exception as exc:
            print(f"  EM on {rule} skipped: {type(exc).__name__}: {exc}", flush=True)
    result = linker.inference.predict()
    pred = db_api._con.execute(
        f"SELECT unique_id_l, unique_id_r, match_weight, match_probability "
        f"FROM {result.physical_name}").df()
    return linker.misc.save_model_to_json(), pred


def to_work_pairs(pred, df, min_weight):
    """Record pairs -> work pairs. Same-work pairs are dropped here, AFTER the fit used them."""
    work_of = df.set_index("unique_id")["work_id"].to_dict()
    best = {}
    kept_same_work = 0
    for left, right, weight, prob in pred.itertuples(index=False):
        if weight < min_weight:
            continue
        wa, wb = work_of[left], work_of[right]
        if wa == wb:
            kept_same_work += 1
            continue
        key = tuple(sorted((wa, wb)))
        if key not in best or weight > best[key][0]:
            best[key] = (float(weight), float(prob))
    return best, kept_same_work


def load_evidence(session, work_ids):
    out = {}
    ids = sorted(work_ids)
    for chunk in range(0, len(ids), 1000):
        for r in session.run(EVIDENCE_QUERY, ids=ids[chunk:chunk + 1000]):
            row = dict(r)
            row["citations"] = [(p, n) for p, n in row["citations"] if p and n]
            row["techFamily"] = technique_family(
                [t for t in row["techniques"] if t] + [m for m in row["media"] if m])
            out[row["workId"]] = row
    return out


# ROUTING — decided on metadata, BEFORE anything reaches a vision model.
#
# Measured on the graph 2026-09-12, from two families that look identical in syntax:
#
#   La Femme qui pleure. I .. VII   ALL cite Baer 623   -> one plate, seven states, ONE work
#   L'Homme attable.   I .. IV      Baer 47/48/49/50    -> four plates, FOUR works
#                                                          (each already carrying its own states 1-3)
#
# Baer numbers each PLATE separately and gives the states of one plate a shared number, so the
# catalogue itself separates the two axes and no picture is needed to do it. The four
# La Femme qui pleure pairs were sent to three different vision models before anyone noticed
# they were decidable from the citation alone.
#
#   stateFamily    designation differs, catalogue base AGREES -> one work; fold and keep the
#                  State nodes. State-[:PRINTED_AS]->EditionRun is untouched by MERGE_QUERY, so
#                  the states survive the fold with no new merge code.
#   plateConflict  catalogue bases CONFLICT -> different plates. Same standing veto
#                  find_museum_anchored_work_clusters applies, and not worth a vision call.
#   needsVision    everything else — no shared catalogue to decide with, or no designation in
#                  play. This is what the adjudicator is actually for.
#
# The known error rate on plateConflict is the held-title triage's 4 wrong citations in 63
# (the Carmen plates cited as Baer 80). Those rows stay IN THE FILE under their own route, so a
# wrong citation costs a review rather than a silent disappearance.
def route(designation_differs, verdict):
    if verdict == "conflict":
        return "plateConflict"
    if designation_differs and verdict == "agree":
        return "stateFamily"
    return "needsVision"


COLUMNS = ["route", "rank", "matchWeight", "matchProbability", "artist",
           "workA", "workB", "titleA", "titleB", "yearA", "yearB",
           "institutionsA", "institutionsB", "impressionsA", "impressionsB",
           "catalogueA", "catalogueB", "catalogueVerdict",
           "techFamilyA", "techFamilyB", "techFamilyVeto", "yearConflict",
           "designationDiffers",
           "imagesA", "imagesB", "flags"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist", required=True)
    ap.add_argument("--catalogue", default="", help="substring of numberingPrefix; omit for all")
    ap.add_argument("--min-weight", type=float, default=DEFAULT_MIN_WEIGHT,
                    help="0 = p>=0.5, the 86.7%%-recall band; 5 = p>=0.97")
    ap.add_argument("--images", type=int, default=DEFAULT_IMAGES_PER_SIDE)
    ap.add_argument("--out", default="splink_merge_candidates.csv")
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            df = build_records(session, args.artist, args.catalogue or ".")
            if len(df) < 20:
                raise SystemExit(f"only {len(df)} records — too few to estimate u or m on")
            print(f"{len(df)} records over {df.work_id.nunique()} works", flush=True)

            model, pred = fit(df)
            pairs, same_work = to_work_pairs(pred, df, args.min_weight)
            print(f"{len(pred):,} record pairs scored; {same_work:,} dropped as already one work; "
                  f"{len(pairs):,} distinct work pairs above weight {args.min_weight}", flush=True)
            if not pairs:
                raise SystemExit("no candidates at this threshold")

            evidence = load_evidence(session, {w for key in pairs for w in key})
    finally:
        driver.close()

    rows = []
    for (wa, wb), (weight, prob) in sorted(pairs.items(), key=lambda kv: -kv[1][0]):
        a, b = evidence.get(wa), evidence.get(wb)
        if not a or not b:
            continue
        verdict = catalogue_verdict(a["citations"], b["citations"])
        veto = int(bool(a["techFamily"] and b["techFamily"]
                        and a["techFamily"] != b["techFamily"]))
        year_conflict = int(bool(a["year"] and b["year"]
                                 and abs(a["year"] - b["year"]) > MAX_YEAR_SPREAD))
        designation = int(designation_only_difference(
            (a["sourceTitles"] or [None])[0] or a["name"],
            (b["sourceTitles"] or [None])[0] or b["name"]))
        flags = [name for name, on in (("designationDiffers", designation),
                                       ("catalogueConflict", verdict == "conflict"),
                                       ("techFamilyVeto", veto),
                                       ("yearConflict", year_conflict),
                                       ("catalogueAgrees", verdict == "agree")) if on]
        def cite(rec):
            return "; ".join(sorted({f"{p} {n}" for p, n in rec["citations"]}))
        rows.append({
            "route": route(designation, verdict),
            "matchWeight": round(weight, 3), "matchProbability": round(prob, 6),
            "artist": args.artist, "workA": wa, "workB": wb,
            "titleA": (a["sourceTitles"] or [None])[0] or a["name"],
            "titleB": (b["sourceTitles"] or [None])[0] or b["name"],
            "yearA": a["year"], "yearB": b["year"],
            "institutionsA": "; ".join(sorted(x for x in a["institutions"] if x)),
            "institutionsB": "; ".join(sorted(x for x in b["institutions"] if x)),
            "impressionsA": a["impressions"], "impressionsB": b["impressions"],
            "catalogueA": cite(a), "catalogueB": cite(b), "catalogueVerdict": verdict,
            "techFamilyA": a["techFamily"] or "", "techFamilyB": b["techFamily"] or "",
            "techFamilyVeto": veto, "yearConflict": year_conflict,
            "designationDiffers": designation,
            "imagesA": " | ".join(sorted(u for u in a["imageUrls"] if u)[:args.images]),
            "imagesB": " | ".join(sorted(u for u in b["imageUrls"] if u)[:args.images]),
            "flags": ",".join(flags),
        })
    for n, row in enumerate(rows, 1):
        row["rank"] = n

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nwrote {len(rows)} candidates -> {args.out}")
    print("\nrouting (decided on metadata, before any vision call)")
    for name, note in (("stateFamily", "one work, differing state designation — fold, keep States"),
                       ("plateConflict", "different catalogue bases — different plates"),
                       ("needsVision", "undecidable from metadata — send to the adjudicator")):
        n = sum(1 for r in rows if r["route"] == name)
        print(f"  {name:14s} {n:5d}  ({n/max(len(rows),1):3.0%})  {note}")
    vision = [r for r in rows if r["route"] == "needsVision"]
    both = sum(1 for r in vision if r["imagesA"] and r["imagesB"])
    print(f"\n  of {len(vision)} needsVision rows, {both} have an image on both sides")
    for name in ("designationDiffers", "catalogueAgrees", "catalogueConflict",
                 "techFamilyVeto", "yearConflict"):
        n = sum(1 for r in rows if name in r["flags"])
        print(f"  {name:20s} {n:5d}  ({n/max(len(rows),1):.0%})   [reported, never applied]")


if __name__ == "__main__":
    main()
