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
    U_SAMPLE_PAIRS, _require_env, entry_base, parse_dims, settings, technique_family,
)

# A group this large is a portfolio or a placeholder that survived the filter, not a duplicate
# set; scoring every pair inside it is quadratic and the answer is never "fold them all".
DEFAULT_MAX_NODES = 10

WORKS_QUERY = """
MATCH (w:ConceptualWork) WHERE w.id IN $ids
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.embedding IS NOT NULL
OPTIONAL MATCH (i)<-[:SHOWS]-(img2:DigitalImage) WHERE img2.sourceUrl IS NOT NULL
OPTIONAL MATCH (i)<-[:DOCUMENTS]-(src:SourceRecord)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
RETURN w.id AS workId, w.name AS name, w.dateCreated_year AS year,
       collect(DISTINCT i.rawMedium)        AS media,
       collect(DISTINCT img2.sourceUrl)[0..2] AS imageUrls,
       collect(DISTINCT coalesce(src.institutionName, src.sourceType)) AS institutions,
       count(DISTINCT i)                    AS impressions,
       collect(DISTINCT cr.numberingPrefix + ' ' + ce.number) AS catalogueRefs,
       collect(DISTINCT t.name)             AS techs,
       collect(DISTINCT i.plateDimensions) + collect(DISTINCT i.imageDimensions) AS dims,
       collect(DISTINCT ce.number)          AS entries,
       collect(DISTINCT img.embedding)[0..3] AS embeddings
"""


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
            vectors = [v for v in m["embeddings"] if v]
            embedding = None
            if vectors:
                M = np.array(vectors, dtype=np.float32)
                M /= np.linalg.norm(M, axis=1, keepdims=True)
                c = M.mean(axis=0)
                embedding = (c / np.linalg.norm(c)).tolist()
            width, height = parse_dims(m["dims"])
            rows.append({
                "unique_id": len(rows), "work_id": work_id,
                "collision_key": f"{n}",          # blocking key: one group, one value
                "artist": g["artist"],
                "title": m["name"],
                "tech_family": technique_family(list(m["techs"]) + list(m["media"])),
                "dim_w": width, "dim_h": height,
                "entry": entry_base(m["entries"]), "emb": embedding,
                "year": m["year"],
                "institutions": "; ".join(sorted(x for x in m["institutions"] if x)),
                "impressions": m["impressions"],
                "catalogueRefs": "; ".join(sorted(x for x in m["catalogueRefs"] if x)),
                "imageUrls": " | ".join(u for u in m["imageUrls"] if u),
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
    ap.add_argument("--pairs-min-weight", type=float, default=10.0)
    ap.add_argument("--pairs-catalogue", default="none",
                    help="'none' = collisions with no citation anywhere, which the metadata "
                         "routing cannot decide; 'any' for all")
    args = ap.parse_args()

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
    linker.training.estimate_probability_two_random_records_match(
        ["l.title = r.title and l.entry = r.entry"], recall=0.7)
    print("u sampling...", flush=True)
    linker.training.estimate_u_using_random_sampling(max_pairs=U_SAMPLE_PAIRS)
    for rule in (block_on("entry"), block_on("dim_w")):
        print(f"EM on {rule}...", flush=True)
        try:
            linker.training.estimate_parameters_using_expectation_maximisation(rule)
        except Exception as exc:
            print(f"  skipped: {type(exc).__name__}: {exc}", flush=True)

    model = linker.misc.save_model_to_json()
    print("\nEM-learned weights (log2 Bayes factor)")
    for comparison in model["comparisons"]:
        print(f"  {comparison['output_column_name']}")
        for level in comparison["comparison_levels"]:
            if "m_probability" in level and "u_probability" in level:
                bf = level["m_probability"] / max(level["u_probability"], 1e-12)
                print(f"    {level.get('label_for_charts',''):42s} log2 BF {np.log2(bf):+6.2f}")

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
        wanted = {f"{n}" for n, g in enumerate(groups)
                  if (args.pairs_catalogue == "any" or not g["catalogue"])}
        pair_rows = []
        for left, right, weight, prob in pred.itertuples(index=False):
            a, b = info[left], info[right]
            if a["collision_key"] not in wanted or weight < args.pairs_min_weight:
                continue
            if not (a["imageUrls"] and b["imageUrls"]):
                continue        # nothing for a vision pass to look at
            designation = int(designation_only_difference(a["title"], b["title"]))
            pair_rows.append({
                # No catalogue anywhere in this band, so catalogueVerdict is 'silent' and the
                # route is needsVision by construction — that IS the selection.
                "route": "needsVision", "matchWeight": round(float(weight), 3),
                "matchProbability": round(float(prob), 6), "artist": a["artist"],
                "workA": a["work_id"], "workB": b["work_id"],
                "titleA": a["title"], "titleB": b["title"],
                "yearA": a["year"] or "", "yearB": b["year"] or "",
                "institutionsA": a["institutions"], "institutionsB": b["institutions"],
                "impressionsA": a["impressions"], "impressionsB": b["impressions"],
                "catalogueA": a["catalogueRefs"], "catalogueB": b["catalogueRefs"],
                "catalogueVerdict": "silent",
                "techFamilyA": a["tech_family"] or "", "techFamilyB": b["tech_family"] or "",
                "techFamilyVeto": int(bool(a["tech_family"] and b["tech_family"]
                                           and a["tech_family"] != b["tech_family"])),
                "yearConflict": int(bool(a["year"] and b["year"]
                                         and abs(a["year"] - b["year"]) > 3)),
                "designationDiffers": designation,
                "imagesA": a["imageUrls"], "imagesB": b["imageUrls"],
                "flags": "designationDiffers" if designation else "",
                "note": "title collision, no catalogue citation",
            })
        pair_rows.sort(key=lambda r: -r["matchWeight"])
        for n, r in enumerate(pair_rows, 1):
            r["rank"] = n
        pair_cols = ["route", "rank", "matchWeight", "matchProbability", "artist",
                     "workA", "workB", "titleA", "titleB", "yearA", "yearB",
                     "institutionsA", "institutionsB", "impressionsA", "impressionsB",
                     "catalogueA", "catalogueB", "catalogueVerdict",
                     "techFamilyA", "techFamilyB", "techFamilyVeto", "yearConflict",
                     "designationDiffers", "imagesA", "imagesB", "flags", "note"]
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
