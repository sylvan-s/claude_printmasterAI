"""
PrintMasterAI — duplicate ConceptualWork clusters anchored on an institutional record.
Version: MUSEUM-ANCHOR-1.0

A candidate GENERATOR, not a merger. It emits the same JSON contract
`find_duplicate_work_clusters.py` does, so `merge_duplicate_work_clusters.py --json`
consumes its output unchanged:

    python3 find_museum_anchored_work_clusters.py --artist "Pablo Picasso" --json anchored.json
    python3 merge_duplicate_work_clusters.py --json anchored.json --artist "Pablo Picasso"

Writing a second merger would mean a second copy of ADR-0017's naming contract, which is
exactly the "two divergent lists problem" `crosswalk_matching.py`'s docstring names. The
merge logic already exists and is correct; only the candidate rule is new.

WHY A DIFFERENT RULE IS NEEDED AT ALL

`find_duplicate_work_clusters.py` keys on (artist, normalized title, year). That finds
works the sources already agree about. It cannot find the far more common case where two
sources describe the same print differently — and for a catalogue-raisonne-heavy artist
that is most of the duplication. This script keys on the **shared catalogue entry**
instead, and uses an institutional record as the arbiter of which title is right.

That arbiter did not exist for any copyright-era artist until now.
`merge_duplicate_work_clusters.py`'s own docstring records it:

    "Measured on the first real run: all 194 Picasso clusters contain ZERO institutional
     records, so tier 2 was inert and every one fell through to frequency plus tie-breaks.
     Expect that for any copyright-era artist, where Tate/BM/Met coverage is thin by
     licensing (ADR-0002)."

The Musee national Picasso-Paris load (2,214 records, ADR-0002 *Amendment 1*) supplies
1,266 institutional Picasso works, 100% of them dated, 1,757 of the source records tied to
an explicit catalogue citation. So that naming tier stops being inert for Picasso — no new
naming code required, the existing precedence simply now has something to prefer.

THE TIERS, and why the line falls where it does

Measured over the 88 distinct (institutional work, auction work) pairs sharing a catalogue
entry for Picasso, 2026-09-11:

  T1  exact after normalization                     19 pairs   -> proposed
      "Etreinte. I" / "Etreinte I", "Fumeur. I" / "Fumeur.I"

  T2  equal after removing a SERIES CLAUSE          16 pairs   -> proposed
      trailing  "Nu au collier" / "Nu Au Collier, Plate II from Six Contes Fantasques"
      leading   "Le Saltimbanque au repos" / "La suite des Saltimbanques - Le Saltimbanque au Repos"
      A portfolio annotation is not an identity discriminator: every plate in the Suite
      Vollard carries the same one. Removing it is an exact string operation on a
      delimiter, not a similarity judgement.

  T3  equal after removing a trailing PARENTHETICAL  7 pairs   -> HELD, not proposed
      "Fumeur au maillot raye gris et bleu" / same + "(Smoker in Gray and Blue Striped Jersey)"
      These are usually English glosses and usually safe. They are held anyway, because a
      blanket parenthetical strip is the exact operation that caused a real corruption
      incident in this graph: `catalogue_matching.py` docstring point 2 records five
      different Stik colourways ("Holding Hands" in Yellow/Orange/Red) merged into one
      work because the normalization erased the only detail distinguishing them. A
      parenthetical can be a translation; it can equally be a colour, a state, or a plate.
      This script cannot tell those apart by exact means, so it does not try.

  T4  everything else                               46 pairs   -> HELD, and valuable
      "Autoportrait sous trois formes..." / "Minotaure caressant une Femme" (Baer 350)
      Two kinds live here and both are worth reading: genuine ALIAS DIVERGENCE, where
      Baer's descriptive title and the dealer's trade title are both correct for the same
      plate — which is precisely the alias model ADR-0017 Decision 3 describes — and
      CITATION ERRORS. The first run found one of the latter: `Bloch-1200` is cited by two
      different Picasso-Paris works, "Le Bain" (1905) and "Le Modele" (1965). Sixty years
      apart, so one of those citations is wrong.

Nothing here merges on a shared catalogue entry alone. That is deliberate and is the
lesson of the Chagall incident in `catalogue_matching.py`: a single Cramer-prefixed entry
numbered 30 covers the whole of *La Bible*, 1,172 works and 1,046 distinct titles. A
catalogue entry is an anchor, never an identity.

SAFETY CHECKS, in the order they are applied

  1. **Catalogue conflict outranks everything**, same as `find_duplicate_work_clusters.py`.
     Two works citing the SAME catalogue prefix with DIFFERENT entry numbers are different
     prints, whatever their titles say. Checked first, never proposed.
  2. **Image dissent** demotes but does not reject. Scores come from Neo4j's
     `vector.similarity.cosine`, which returns (1 + cos)/2 and NOT raw cosine — unrelated
     pairs in this graph floor around 0.486. The floor is imported from
     `find_duplicate_work_clusters` rather than restated, so the two scripts cannot drift.

     This is the one role DINOv2 is sound in here. The 2026-09-10 work-merge probe
     REJECTED it as a merge *generator* — a >=0.98 sweep recovered only ~44% of known
     duplicates and still fired on different prints. Asked instead to veto a candidate
     that an exact rule already produced, it faces a completely different problem: not
     "which of 3,262 works match" but "does this specific pair disagree". Verifier, never
     generator.
  3. **No institutional anchor, no cluster.** A pair of two auction works is
     `find_duplicate_work_clusters.py`'s job, not this script's.

Scope note: the rule is artist-agnostic and will work for any artist with institutional
coverage. In practice that means Picasso today; Tate and BM coverage supplies anchors for
the pre-1955 tail (ADR-0002 Findings).
"""

import argparse
import json
import os
import re
import unicodedata
from collections import defaultdict

from neo4j import GraphDatabase

from catalogue_matching import normalize_title
from find_duplicate_work_clusters import DEFAULT_DISSENT_FLOOR


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

# An institutional SourceRecord is the anchor. sourceType is doc 08 §2's own enum value,
# not an institutionName allowlist, so Tate/BM/V&A anchors qualify on the same footing.
CANDIDATE_QUERY = """
MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(cw:ConceptualWork)<-[:CREATED]-(a:Artist)
WHERE $artist IS NULL OR a.name = $artist
WITH ce, a, collect(DISTINCT cw) AS works
WHERE size(works) > 1
UNWIND works AS cw
OPTIONAL MATCH (cw)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
              <-[:DOCUMENTS]-(src:SourceRecord)
OPTIONAL MATCH (cw)<-[:DOCUMENTS]-(anyEntry:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
WITH ce, a, cw,
     collect(DISTINCT src.sourceType) AS sourceTypes,
     collect(DISTINCT src.institutionName) AS institutions,
     collect(DISTINCT [cr.numberingPrefix, anyEntry.number]) AS citations
RETURN ce.id AS entryId, a.name AS artist, cw.id AS workId, cw.name AS title,
       cw.dateCreated_year AS year, sourceTypes, institutions, citations
"""

# Same (1 + cos)/2 convention as find_duplicate_work_clusters.CLUSTER_SIM_QUERY.
PAIR_SIM_QUERY = """
UNWIND $pairs AS p
MATCH (x:DigitalImage {id: p[0]}), (y:DigitalImage {id: p[1]})
WHERE x.embedding IS NOT NULL AND y.embedding IS NOT NULL
RETURN p[0] AS a, p[1] AS b, vector.similarity.cosine(x.embedding, y.embedding) AS sim
"""

WORK_IMAGES_QUERY = """
UNWIND $workIds AS wid
MATCH (cw:ConceptualWork {id: wid})-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(imp)
WHERE img.embedding IS NOT NULL
RETURN wid AS workId, collect(DISTINCT img.id)[0..6] AS imageIds
"""

# A portfolio annotation, not an identity discriminator — see the tier table above.
_TRAILING_SERIES_RE = re.compile(
    r"[,\s]+(?:from|plate\s+[ivxlc\d]+\s+from|pl\.?\s*[ivxlc\d]+[,\s]*(?:from)?|planche\s+[ivxlc\d]+)\b.*$",
    re.IGNORECASE)
_LEADING_SERIES_RE = re.compile(r"^\s*(?:la\s+suite\s+[^-]{3,40}|suite\s+[^-]{3,40})\s+-\s+", re.IGNORECASE)
_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")


def strip_series_clause(title):
    """Exact delimiter operations only. Returns the stem, or the title unchanged."""
    if not title:
        return title
    out = _LEADING_SERIES_RE.sub("", title)
    out = _TRAILING_SERIES_RE.sub("", out)
    return out.strip(" ,;-")


def classify(anchor_title, other_title):
    """Returns one of T1_EXACT / T2_SERIES / T3_PARENTHETICAL / T4_DIFFERENT."""
    a, o = normalize_title(anchor_title), normalize_title(other_title)
    if a and a == o:
        return "T1_EXACT"
    if normalize_title(strip_series_clause(anchor_title)) == normalize_title(strip_series_clause(other_title)):
        return "T2_SERIES"
    if normalize_title(_TRAILING_PAREN_RE.sub("", other_title or "")) == a:
        return "T3_PARENTHETICAL"
    return "T4_DIFFERENT"


def entry_base_number(number):
    """Baer entry numbers in this graph carry state/edition designations — "1173.B.b.1",
    "1125.II.B.b.1", "18.b.2", "1760,Bb2" (survey note §3.2). Those designate a STATE or a
    printing, which doc 08 models on State/Impression, not on ConceptualWork. At work level
    "Baer 1173" and "Baer 1173.B.b.1" are the same entry, and treating them as a conflict
    rejected a confirmed-identical pair on the first run ("Fumeur. IV" / "Fumeur IV", where
    Picasso-Paris cites Baer 1173 and Bonhams cites Baer 1173.B.b.1, both citing Bloch 1173).

    Splits on the first "." or "," ONLY. A glued suffix is deliberately left attached:
    "1042A", "18b", "325Bd" and "211bis" cannot be separated into entry-versus-edition
    without a copy of Baer to check against — Baer 1042A really is its own entry, while
    325Bd is entry 325 in edition B.d. Leaving them distinct under-merges, which leaves the
    graph correct; guessing would risk folding two real entries together."""
    return re.split(r"[.,]", str(number).strip(), 1)[0].strip()


def catalogue_conflict(citations_a, citations_b):
    """Same catalogue prefix, different BASE entry numbers => different prints. Outranks
    every title signal, checked before anything else — same rule and same precedence as
    find_duplicate_work_clusters.catalogue_conflict(), narrowed to base numbers per
    entry_base_number()."""
    by_prefix = defaultdict(set)
    for prefix, number in citations_a + citations_b:
        if prefix and number:
            by_prefix[prefix].add(entry_base_number(number))
    return sorted(p for p, nums in by_prefix.items() if len(nums) > 1)


def fetch_rows(session, artist):
    return [dict(r) for r in session.run(CANDIDATE_QUERY, artist=artist)]


def score_pairs(session, work_ids_by_cluster):
    """min/max pairwise similarity per cluster. No embedded images on both sides is NOT a
    dissent — it is no evidence, exactly as a THIN artist pair is not a rejection."""
    images = {}
    all_ids = sorted({w for ids in work_ids_by_cluster.values() for w in ids})
    for batch in range(0, len(all_ids), 500):
        for rec in session.run(WORK_IMAGES_QUERY, workIds=all_ids[batch:batch + 500]):
            images[rec["workId"]] = rec["imageIds"]

    pairs, owner = [], {}
    for key, wids in work_ids_by_cluster.items():
        imgs = sorted({i for w in wids for i in images.get(w, [])})
        for i in range(len(imgs) - 1):
            for j in range(i + 1, len(imgs)):
                pairs.append([imgs[i], imgs[j]])
                owner[(imgs[i], imgs[j])] = key

    sims = defaultdict(list)
    for batch in range(0, len(pairs), 2000):
        for rec in session.run(PAIR_SIM_QUERY, pairs=pairs[batch:batch + 2000]):
            sims[owner[(rec["a"], rec["b"])]].append(rec["sim"])
    return sims


def build(session, artist, dissent_floor):
    rows = fetch_rows(session, artist)
    by_entry = defaultdict(list)
    for r in rows:
        by_entry[(r["entryId"], r["artist"])].append(r)

    proposed, dissent, conflict, held_paren, held_diff = [], [], [], [], []
    cluster_members = {}

    for (entry_id, artist_name), works in by_entry.items():
        anchors = [w for w in works if "institutional" in (w["sourceTypes"] or [])]
        others = [w for w in works if w not in anchors]
        if not anchors or not others:
            continue
        anchor = sorted(anchors, key=lambda w: w["workId"])[0]

        merge_ids = [anchor["workId"]]
        for o in others:
            clash = catalogue_conflict(anchor["citations"], o["citations"])
            if clash:
                conflict.append({"entry": entry_id, "artist": artist_name,
                                 "anchorTitle": anchor["title"], "otherTitle": o["title"],
                                 "conflictingCatalogues": clash})
                continue
            tier = classify(anchor["title"], o["title"])
            record = {"entry": entry_id, "artist": artist_name, "tier": tier,
                      "anchorId": anchor["workId"], "anchorTitle": anchor["title"],
                      "otherId": o["workId"], "otherTitle": o["title"],
                      "anchorYear": anchor["year"], "otherYear": o["year"]}
            if tier in ("T1_EXACT", "T2_SERIES"):
                merge_ids.append(o["workId"])
            elif tier == "T3_PARENTHETICAL":
                held_paren.append(record)
            else:
                held_diff.append(record)

        if len(merge_ids) > 1:
            cluster_members[(entry_id, artist_name)] = sorted(set(merge_ids))

    # One work pair is commonly anchored by TWO entries — a Picasso print cites both a
    # Baer and a Bloch number, so "Les Saltimbanques" arrives under Baer-9 and again under
    # Bloch-7 with an identical workIds set. Emitting both makes the merger do the same
    # fold twice (its alias map absorbs it, but the report double-counts and reads as if
    # there were more to merge than there is). Collapsed here, with the other anchoring
    # entries kept on the cluster so the corroboration isn't lost — two independent
    # catalogues agreeing is stronger evidence than one, and worth seeing in the output.
    deduped = {}
    for key, wids in cluster_members.items():
        fingerprint = frozenset(wids)
        if fingerprint in deduped:
            deduped[fingerprint]["alsoAnchoredBy"].append(key[0])
        else:
            deduped[fingerprint] = {"key": key, "workIds": wids, "alsoAnchoredBy": []}
    cluster_members = {v["key"]: v["workIds"] for v in deduped.values()}
    also_anchored = {v["key"]: sorted(v["alsoAnchoredBy"]) for v in deduped.values()}

    sims = score_pairs(session, cluster_members)
    for (entry_id, artist_name), wids in cluster_members.items():
        vals = sims.get((entry_id, artist_name))
        anchor = [w for w in by_entry[(entry_id, artist_name)] if w["workId"] == wids[0]]
        anchor_row = next((w for w in by_entry[(entry_id, artist_name)]
                           if "institutional" in (w["sourceTypes"] or [])), None)
        cluster = {
            "artist": artist_name,
            "title": (anchor_row or {}).get("title"),
            "year": (anchor_row or {}).get("year"),
            "workIds": wids,
            "size": len(wids),
            "anchorEntry": entry_id,
            "alsoAnchoredBy": also_anchored.get((entry_id, artist_name), []),
            "anchorWorkId": (anchor_row or {}).get("workId"),
            "anchorInstitution": ((anchor_row or {}).get("institutions") or [None])[0],
            "minSim": round(min(vals), 4) if vals else None,
            "maxSim": round(max(vals), 4) if vals else None,
        }
        (dissent if cluster["minSim"] is not None and cluster["minSim"] < dissent_floor
         else proposed).append(cluster)

    proposed.sort(key=lambda c: (-c["size"], c["artist"], c["title"] or ""))
    dissent.sort(key=lambda c: (c["minSim"] or 0))
    return proposed, dissent, conflict, held_paren, held_diff


def main(artist=None, dissent_floor=DEFAULT_DISSENT_FLOOR, out_json=None, details=10):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            proposed, dissent, conflict, held_paren, held_diff = build(session, artist, dissent_floor)
    finally:
        driver.close()

    print(f"=== CATALOGUE CONFLICT — same catalogue, different entry numbers: DIFFERENT "
          f"WORKS, never proposed ({len(conflict)}) ===")
    for c in conflict[:details]:
        print(f"  {c['entry']:<16} {c['conflictingCatalogues']}  {c['anchorTitle']!r} vs {c['otherTitle']!r}")

    print(f"\n=== PROPOSED — institutional anchor, T1/T2 title match, images do not "
          f"dissent ({len(proposed)} clusters, {sum(c['size'] for c in proposed)} works) ===")
    for c in proposed[:details]:
        sim = "no image coverage" if c["minSim"] is None else f"sim {c['minSim']:.3f}-{c['maxSim']:.3f}"
        also = f" +{len(c['alsoAnchoredBy'])} catalogue" if c["alsoAnchoredBy"] else ""
        print(f"  [{c['anchorEntry']:<14}] {str(c['title'])[:48]:<48} n={c['size']} {sim}{also}")

    print(f"\n=== IMAGES DISSENT (min sim < {dissent_floor}) — review, NOT a rejection ({len(dissent)}) ===")
    print("    ~20% of known-duplicate pairs score below this floor; a low score on a")
    print("    different photograph of the same print is normal. Read as 'look at this'.")
    for c in dissent[:details]:
        print(f"  [{c['anchorEntry']:<14}] {str(c['title'])[:52]:<52} minSim={c['minSim']}")

    print(f"\n=== HELD — trailing parenthetical ({len(held_paren)}) — usually an English "
          f"gloss, but a blanket paren strip is what merged five Stik colourways ===")
    for c in held_paren[:details]:
        print(f"  [{c['entry']:<14}] {str(c['anchorTitle'])[:40]:<40} | {str(c['otherTitle'])[:46]}")

    print(f"\n=== HELD — different titles ({len(held_diff)}) — alias divergence AND "
          f"citation errors; read, don't merge ===")
    for c in held_diff[:details]:
        flag = " <== YEARS DISAGREE" if (c["anchorYear"] and c["otherYear"]
                                        and abs(c["anchorYear"] - c["otherYear"]) > 5) else ""
        print(f"  [{c['entry']:<14}] {str(c['anchorTitle'])[:40]:<40} | {str(c['otherTitle'])[:40]}{flag}")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({
                "catalogueConflict": conflict,
                "proposed": proposed,
                "imagesDissent": dissent,
                "heldParenthetical": held_paren,
                "heldDifferentTitle": held_diff,
            }, f, indent=2, ensure_ascii=False)
        print(f"\nWrote {out_json}")
        print("Feed the proposed bucket to the EXISTING merger, which already implements")
        print("ADR-0017's naming contract — no second copy of it lives here:")
        print(f"  python3 merge_duplicate_work_clusters.py --json {out_json} "
              f"--artist {artist!r}          # dry run is the default; --apply writes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artist", help="Restrict to one Artist.name (recommended)")
    parser.add_argument("--dissent-floor", type=float, default=DEFAULT_DISSENT_FLOOR,
                        help="Neo4j (1+cos)/2 similarity floor below which a cluster is demoted to review")
    parser.add_argument("--json", dest="out_json", help="Write the buckets for merge_duplicate_work_clusters.py")
    parser.add_argument("--details", type=int, default=10, help="Rows printed per bucket")
    args = parser.parse_args()
    main(artist=args.artist, dissent_floor=args.dissent_floor,
         out_json=args.out_json, details=args.details)
