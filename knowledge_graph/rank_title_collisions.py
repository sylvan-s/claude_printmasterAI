"""
PrintMasterAI — rank `find_title_collisions.py`'s output with the Splink model.
Version: COLLISION-RANK-1.0

Scores and ranks. Writes a CSV, touches nothing, proposes no merge.

WHAT THIS IS FOR. The collision scan finds 9,334 groups where one artist has several
ConceptualWork nodes under one folded title. That is a QUESTION per group, not a duplicate, and
6,444 of them carry no catalogue citation at all — nothing in the metadata orders them. This
applies the Fellegi-Sunter model to put the ones most likely to be one work at the top.

THE FRAME, and the caveat that goes with it. `fit_splink_work_identity.py` blocks to one artist
within one catalogue so that u — "agreement given non-match" — is estimated on portfolio mates,
the population that actually matters. That frame does not exist here: a collision is defined
within an artist but across the whole graph, and most have no catalogue.

So the input is restricted to works that are IN a collision, and predictions are blocked on the
collision key, which yields exactly the within-collision pairs. u is still estimated by random
sampling across the whole restricted population, where a random pair is usually two works by
DIFFERENT artists — an easier population than the pairs being scored.

  THE CONSEQUENCE, stated rather than buried: match_weight and match_probability are
  OPTIMISTIC IN ABSOLUTE TERMS on this frame and must not be read as calibrated probabilities or
  compared against the Picasso-within-Baer operating points. The RANKING is what this produces,
  and ranking is far less sensitive to u than the absolute scale is.

WHICH BAND IS WORTH CHECKING, measured on 60 stratified pairs at weight >= 15 (43 artists, at
most 2 each), every failure confirmed by triplicate replication — 5 of 5 unanimous, so none is
model instability:

    stratum     n   precision   95% lower bound
    agree      14       100%          81%
    none       30        97%          85%
    partial    12        83%          56%
    conflict    4        50%          10%
    ALL        60        92%          83%

PRECISION IS FLAT IN WEIGHT — 92% at 15-18, 95% at 18-21 — so raising the threshold buys
nothing. What separates the errors is the CATALOGUE STRATUM. Both `conflict` failures were
decidable from metadata alone: Rembrandt's "Joseph telling his dreams" cites Bartsch 27 against
37, and Warhol's "Camouflage" cites F&S 406/407/409 against 409.

So the default band is weight >= 15 AND stratum in {agree, none}: 43/44 correct on the sample,
and at weight >= 15 graph-wide the dropped strata are 78 `partial` and 16 `conflict` of 1,099
pairs — losing ~9% of the band to remove ~80% of the errors.

THE RESIDUAL IS NOT REMOVABLE BY RULE. The one failure inside the band is Gordon House's
"Triangles within a Square", a variation series where the title genuinely repeats across plates
and the triangle count differs. Only the picture catches that, which is why this emits a review
queue and not a merge plan.

ONE RECORD PER WORK, not per (work, institution). The unit being compared here is the work node,
and collapsing institutions first removes the same-work pairs that the candidate generator has
to filter out afterwards.

Title contributes almost nothing by construction — the records collide BECAUSE their titles fold
together — so the weight EM gives it is near zero and the discrimination comes from the image
embedding, the catalogue entry, technique family and dimensions. That is the intended behaviour,
not a defect: it is the same comparison the generator makes, with the one field that is constant
within a group carrying no information.

Usage:
    python3 rank_title_collisions.py --collisions title_collisions.csv --out ranked.csv
    python3 rank_title_collisions.py --collisions title_collisions.csv --min-nodes 2 --max-nodes 8
"""

import argparse
import csv
import os
import re

import numpy as np
import pandas as pd
from neo4j import GraphDatabase
from splink import DuckDBAPI, Linker, block_on

from generate_splink_merge_candidates import designation_only_difference

from fit_splink_work_identity import (
    U_SAMPLE_PAIRS, _fold_title, _require_env, entry_keys, parse_dims, settings,
    entry_exact_keys, technique_family, training_rules,
)

# A group this large is a portfolio or a placeholder that survived the filter, not a duplicate
# set; scoring every pair inside it is quadratic and the answer is never "fold them all".
DEFAULT_MAX_NODES = 10

WORKS_QUERY = """
MATCH (w:ConceptualWork) WHERE w.id IN $ids
OPTIONAL MATCH (w)-[:PRINTED_AS]->(er2:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.embedding IS NOT NULL
OPTIONAL MATCH (i)<-[:SHOWS]-(img2:DigitalImage) WHERE img2.sourceUrl IS NOT NULL
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(src:SourceRecord)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
RETURN w.id AS workId, w.name AS name, w.dateCreated_year AS year,
       collect(DISTINCT i.rawMedium)        AS media,
       collect(DISTINCT i.editionNumber)    AS editionNumbers,
       collect(DISTINCT er2.declaredSize)   AS declaredSizes,
       collect(DISTINCT img2.sourceUrl)[0..2] AS imageUrls,
       collect(DISTINCT coalesce(src.institutionName, src.sourceType)) AS institutions,
       count(DISTINCT i)                    AS impressions,
       collect(DISTINCT cr.numberingPrefix + ' ' + ce.number) AS catalogueRefs,
       collect(DISTINCT t.name)             AS techs,
       collect(DISTINCT i.plateDimensions) + collect(DISTINCT i.imageDimensions) AS dims,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations,
       collect(DISTINCT img.embedding)[0..3] AS embeddings,
       collect(DISTINCT img.clipImageEmbedding)[0..3] AS clipEmbeddings
"""


def _edition_label(numbers, sizes):
    """"5/55; 8/55" — the impression numbers this work holds, against the declared size."""
    ns = sorted(n for n in (numbers or []) if n is not None)
    if not ns:
        return ""
    size = next((s for s in (sizes or []) if s), "?")
    return "; ".join(f"{n}/{size}" for n in ns[:6])


def load_collisions(path, min_nodes, max_nodes):
    groups = []
    for row in csv.DictReader(open(path, encoding="utf-8")):
        n = int(row["nodes"])
        if not (min_nodes <= n <= max_nodes):
            continue
        ids = row["workIds"].split()
        if len(ids) < 2:
            continue
        groups.append({"artist": row["artist"], "key": row["foldedTitle"],
                       "catalogue": row["catalogue"], "years": row["years"],
                       "spellings": row["spellings"], "ids": ids})
    return groups


def build_frame(session, groups):
    ids = sorted({i for g in groups for i in g["ids"]})
    meta = {}
    for chunk in range(0, len(ids), 2000):
        for r in session.run(WORKS_QUERY, ids=ids[chunk:chunk + 2000]):
            meta[r["workId"]] = dict(r)
    rows, key_of = [], {}
    for n, g in enumerate(groups):
        for work_id in g["ids"]:
            m = meta.get(work_id)
            if not m:
                continue
            def centroid(vs):
                vs = [v for v in vs if v]
                if not vs:
                    return None
                M = np.array(vs, dtype=np.float32)
                M /= np.linalg.norm(M, axis=1, keepdims=True)
                c = M.mean(axis=0)
                return (c / np.linalg.norm(c)).tolist()

            embedding = centroid(m["embeddings"])
            clip_embedding = centroid(m["clipEmbeddings"])
            width, height = parse_dims(m["dims"])
            rows.append({
                "unique_id": len(rows), "work_id": work_id,
                "collision_key": f"{n}",          # blocking key: one group, one value
                "artist": g["artist"],
                "title": m["name"],
                "title_folded": _fold_title(m["name"]),
                "tech_family": technique_family(list(m["techs"]) + list(m["media"])),
                "dim_w": width, "dim_h": height,
                "entries": entry_keys(m["citations"]),
                "exact_entries": entry_exact_keys(m["citations"], g["artist"]),
                "emb": embedding,
                "clip": clip_embedding,
                "year": m["year"],
                "institutions": "; ".join(sorted(x for x in m["institutions"] if x)),
                "impressions": m["impressions"],
                "catalogueRefs": "; ".join(sorted(x for x in m["catalogueRefs"] if x)),
                "imageUrls": " | ".join(u for u in m["imageUrls"] if u),
                # Decisive for a VARIABLE EDITION, where the images are meant to differ and only
                # the numbering says the works are one. See adjudicate_merge_candidates.
                "edition": _edition_label(m["editionNumbers"], m["declaredSizes"]),
            })
            key_of[work_id] = n
    return pd.DataFrame(rows), key_of


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--collisions", required=True)
    ap.add_argument("--out", default="title_collisions_ranked.csv")
    ap.add_argument("--min-nodes", type=int, default=2)
    ap.add_argument("--max-nodes", type=int, default=DEFAULT_MAX_NODES)
    ap.add_argument("--pairs-out", help="also emit PAIRS in adjudicate_merge_candidates.py's "
                                        "schema, for the band selected below")
    # THE BAND, measured rather than chosen. See "WHICH BAND IS WORTH CHECKING" above.
    ap.add_argument("--pairs-min-weight", type=float, default=15.0)
    ap.add_argument("--pairs-catalogue", default="agree,none",
                    help="comma-separated catalogue strata to emit: agree, none, partial, "
                         "conflict, or 'any'. The default drops the two strata that carried "
                         "4 of 5 measured failures")
    ap.add_argument("--u-pairs", type=int, default=U_SAMPLE_PAIRS,
                    help="random pairs drawn to estimate u. A level that is RARE in the "
                         "population (image cosine >= 0.97) needs a large sample or it goes "
                         "untrained, and the run then refuses to emit a ranking")
    args = ap.parse_args()
    u_pairs = args.u_pairs

    groups = load_collisions(args.collisions, args.min_nodes, args.max_nodes)
    print(f"{len(groups)} collisions in range, {sum(len(g['ids']) for g in groups)} work nodes",
          flush=True)

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            df, _ = build_frame(session, groups)
    finally:
        driver.close()
    print(f"{len(df)} records  {int(df.emb.notna().sum())} with an image "
          f"({df.emb.notna().mean():.0%})", flush=True)

    st = settings()
    # Exactly the within-collision pairs. "1=1" would be 364M pairs at this scale.
    st.blocking_rules_to_generate_predictions = [block_on("collision_key")]
    st.retain_intermediate_calculation_columns = False
    st.retain_matching_columns = False

    db_api = DuckDBAPI()
    linker = Linker(df, st, db_api=db_api)
    deterministic, em_rules, coverage = training_rules(df)
    print("  field coverage: "
          + ", ".join(f"{c} {v:.0%}" for c, v in sorted(coverage.items())), flush=True)
    print(f"  deterministic rule: {deterministic[0]}", flush=True)
    linker.training.estimate_probability_two_random_records_match(deterministic, recall=0.7)
    prior = linker._settings_obj._probability_two_random_records_match
    if not prior:
        raise SystemExit(
            "the deterministic rule matched NOTHING, so the prior is zero and every weight "
            "that follows is meaningless. Refusing to emit a ranking.")
    print(f"u sampling ({u_pairs:,} pairs)...", flush=True)
    linker.training.estimate_u_using_random_sampling(max_pairs=u_pairs)
    for rule in em_rules:
        print(f"EM on {rule}...", flush=True)
        try:
            linker.training.estimate_parameters_using_expectation_maximisation(rule)
        except Exception as exc:
            print(f"  skipped: {type(exc).__name__}: {exc}", flush=True)

    model = linker.misc.save_model_to_json()

    # A LEVEL with no trained u is not a rounding error. Splink substitutes a default, the level
    # stops discriminating, and — because this printer used to skip any level missing m or u —
    # it did so invisibly. Measured on the post-merge no-catalogue frame 2026-09-12: u sampling
    # at 200k pairs never drew a pair at `image cosine >= 0.97`, so the STRONGEST image level
    # went untrained and 433 pairs whose DINOv2 centroids agree at 0.998-1.000 scored -3.51 —
    # the bottom of the range — while pairs at 0.85 scored +8.55. The ranking inverted exactly
    # where it should be most certain, and nothing in the output said so.
    #
    # u is an agreement RATE estimated by random sampling, so a level that is genuinely rare in
    # the population needs a bigger sample, not a smaller model. Raise --u-pairs.
    FIELD_OF = {"image": "emb", "clip": "clip", "title": "title_folded",
                "tech_family": "tech_family", "dims": "dim_w", "entry": "exact_entries"}

    def _populated(col):
        if col not in df.columns:
            return 0.0
        def ok(v):
            if v is None:
                return False
            if isinstance(v, (list, tuple, np.ndarray)):
                return len(v) > 0
            return pd.notna(v)
        return sum(ok(v) for v in df[col]) / max(len(df), 1)

    print("\nEM-learned weights (log2 Bayes factor)")
    untrained, inert = [], []
    for comparison in model["comparisons"]:
        name = comparison["output_column_name"]
        print(f"  {name}")
        covered = _populated(FIELD_OF.get(name, "")) >= 0.10
        for level in comparison["comparison_levels"]:
            label = level.get("label_for_charts", "")
            if level.get("is_null_level"):
                continue
            if "m_probability" in level and "u_probability" in level:
                bf = level["m_probability"] / max(level["u_probability"], 1e-12)
                print(f"    {label:42s} log2 BF {np.log2(bf):+6.2f}")
            else:
                missing = ", ".join(k for k in ("m", "u")
                                    if f"{k}_probability" not in level)
                print(f"    {label:42s} UNTRAINED ({missing})")
                (untrained if covered else inert).append(f"{name}: {label} (no {missing})")
    if inert:
        print("\n  untrained levels on fields this frame does not populate (inert, not fatal):")
        for x in inert:
            print(f"    {x}")
    if untrained:
        raise SystemExit(
            "\nREFUSING TO EMIT A RANKING. These levels were never observed while training, on "
            "fields this frame DOES populate, so they fall back to defaults and score wrongly:\n  "
            + "\n  ".join(untrained)
            + f"\n\nu was sampled on {u_pairs:,} random pairs. Re-run with a larger --u-pairs.")

    result = linker.inference.predict()
    pred = db_api._con.execute(
        f"SELECT unique_id_l, unique_id_r, match_weight, match_probability "
        f"FROM {result.physical_name}").df()
    print(f"\nscored {len(pred):,} within-collision pairs", flush=True)

    info = df.set_index("unique_id").to_dict("index")
    by_group = {}
    for left, right, weight, prob in pred.itertuples(index=False):
        a, b = info[left], info[right]
        g = a["collision_key"]
        rec = by_group.setdefault(g, {"best": -99, "worst": 99, "pairs": 0,
                                      "artist": a["artist"], "title": a["title"]})
        rec["best"] = max(rec["best"], float(weight))
        rec["worst"] = min(rec["worst"], float(weight))
        rec["pairs"] += 1

    rows = []
    for n, g in enumerate(groups):
        rec = by_group.get(f"{n}")
        if not rec:
            continue
        rows.append({
            "bestWeight": round(rec["best"], 3), "worstWeight": round(rec["worst"], 3),
            "pairs": rec["pairs"], "nodes": len(g["ids"]),
            "artist": g["artist"], "foldedTitle": g["key"],
            "catalogue": g["catalogue"], "years": g["years"],
            "spellings": g["spellings"][:120], "workIds": " ".join(g["ids"]),
        })
    rows.sort(key=lambda r: -r["bestWeight"])
    for n, r in enumerate(rows, 1):
        r["rank"] = n

    cols = ["rank", "bestWeight", "worstWeight", "pairs", "nodes", "artist", "foldedTitle",
            "catalogue", "years", "spellings", "workIds"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    if args.pairs_out:
        strata = {x.strip() for x in args.pairs_catalogue.split(",")}
        wanted = {f"{n}" for n, g in enumerate(groups)
                  if "any" in strata or (g["catalogue"] or "none") in strata}
        pair_rows = []
        for left, right, weight, prob in pred.itertuples(index=False):
            a, b = info[left], info[right]
            if a["collision_key"] not in wanted or weight < args.pairs_min_weight:
                continue
            if not (a["imageUrls"] and b["imageUrls"]):
                continue        # nothing for a vision pass to look at
            designation = int(designation_only_difference(a["title"], b["title"]))
            # PAIR-LEVEL catalogue state. `catalogueVerdict` below is the GROUP's stratum, which
            # is what --pairs-catalogue selects on, but it says nothing about THIS pair: inside a
            # `partial` collision one pair may have both sides cited, another neither, another
            # exactly one. The one-sided case is its own question — the cited node is an anchor
            # and the uncited one is either the same work or a sibling the citation would have
            # separated — and nothing downstream could ask it while only the group label existed.
            # the EXACT keys, not the stems: a pair citing F./S. IIA.30 against IIIA.30 agrees
            # on no stem at all under entry_base (both yield nothing) and would read as
            # `oneSided`, which is how a real catalogue conflict reached a merge candidate list.
            ea = set(a["exact_entries"] or []) or set(a["entries"] or [])
            eb = set(b["exact_entries"] or []) or set(b["entries"] or [])
            pair_cat = ("none" if not ea and not eb else
                        "oneSided" if not ea or not eb else
                        "agree" if ea & eb else "conflict")
            pair_rows.append({
                # Was hardcoded 'silent' when this only served the no-catalogue band; the
                # refined rule selects ON this field, so it has to carry the real state.
                "route": "needsVision", "matchWeight": round(float(weight), 3),
                "matchProbability": round(float(prob), 6), "artist": a["artist"],
                "workA": a["work_id"], "workB": b["work_id"],
                "titleA": a["title"], "titleB": b["title"],
                "yearA": a["year"] or "", "yearB": b["year"] or "",
                "institutionsA": a["institutions"], "institutionsB": b["institutions"],
                "impressionsA": a["impressions"], "impressionsB": b["impressions"],
                "catalogueA": a["catalogueRefs"], "catalogueB": b["catalogueRefs"],
                "catalogueVerdict": groups[int(a["collision_key"])]["catalogue"] or "none",
                "pairCatalogue": pair_cat,
                "techFamilyA": a["tech_family"] or "", "techFamilyB": b["tech_family"] or "",
                "techFamilyVeto": int(bool(a["tech_family"] and b["tech_family"]
                                           and a["tech_family"] != b["tech_family"])),
                "yearConflict": int(bool(a["year"] and b["year"]
                                         and abs(a["year"] - b["year"]) > 3)),
                "designationDiffers": designation,
                "editionA": a["edition"], "editionB": b["edition"],
                "imagesA": a["imageUrls"], "imagesB": b["imageUrls"],
                "flags": "designationDiffers" if designation else "",
                # Was the literal "title collision, no catalogue citation", written when this
                # only served the no-catalogue band and false for every pair that has one. It
                # reaches MergeEvent.evidence through cluster_evidence(), which is where the
                # same class of mistake put a ">= 15" claim on 4,099 merges made below it.
                "note": {"none": "title collision, no catalogue citation on either side",
                         "oneSided": "title collision, catalogue citation on one side only",
                         "agree": "title collision, catalogue bases agree",
                         "conflict": "title collision, catalogue bases CONFLICT"}[pair_cat],
            })
        pair_rows.sort(key=lambda r: -r["matchWeight"])
        for n, r in enumerate(pair_rows, 1):
            r["rank"] = n
        pair_cols = ["route", "rank", "matchWeight", "matchProbability", "artist",
                     "workA", "workB", "titleA", "titleB", "yearA", "yearB",
                     "institutionsA", "institutionsB", "impressionsA", "impressionsB",
                     "catalogueA", "catalogueB", "catalogueVerdict", "pairCatalogue",
                     "techFamilyA", "techFamilyB", "techFamilyVeto", "yearConflict",
                     "designationDiffers", "editionA", "editionB",
                     "imagesA", "imagesB", "flags", "note"]
        with open(args.pairs_out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=pair_cols)
            w.writeheader()
            w.writerows(pair_rows)
        print(f"\nwrote {len(pair_rows)} adjudicable pairs -> {args.pairs_out}")

    print(f"\nwrote {len(rows)} ranked collisions -> {args.out}")
    print("  match_weight is OPTIMISTIC on this frame — rank, not calibrated probability")
    for lo, hi, label in ((15, 99, "very strong"), (10, 15, "strong"),
                          (5, 10, "moderate"), (-99, 5, "weak")):
        n = sum(1 for r in rows if lo <= r["bestWeight"] < hi)
        print(f"  bestWeight {label:12s} {n:5d}")


if __name__ == "__main__":
    main()
