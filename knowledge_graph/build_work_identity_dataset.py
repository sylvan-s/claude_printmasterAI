"""
PrintMasterAI — labelled pair dataset for a supervised work-identity model.
Version: IDENTITY-DATASET-1.0

Builds the training/eval set a pairwise classifier would need, and nothing else. It does not
train, score or merge anything. Output is a CSV in the same shape as
`picasso_held_title_triage_2026-09-11.csv`, so the eval slice can be adjudicated by hand.

WHY THIS EXISTS. Three image-side approaches have now been rejected on measurement — the
2026-09-10 DINOv2 threshold sweep, ADR-0009 Amendment 1's GDS feature-Jaccard, and
`probe_geometric_verification.py`. None of them tested a LEARNED COMBINATION of weak signals,
which is a different proposition. The blocker for that has never been the model; it is that
there was no labelled set. This builds one.

TWO RULES THE CONSTRUCTION OBEYS, both earned by getting them wrong first.

1. NO WORK-LEVEL PROPERTY IS EVER A FEATURE.

   A positive pair is two INSTITUTIONS' records of one `ConceptualWork`, so anything stored on
   the work node itself is read off one node twice and is perfectly correlated with the label.
   A first attempt at this measurement used `w.name`, `w.dateCreated_year` and the work's
   collected techniques, and scored `titleSim` at AUC 1.000 against BOTH the different-work and
   the state class — a feature that is perfect at two different tasks is leakage, not signal.

   Every feature here is therefore computed per SIDE, from that side's own `Impression`,
   `SourceRecord` and `DigitalImage` nodes only:

       title        Impression.sourceTitle      (the institution's own wording)
       medium       Impression.rawMedium        (the institution's own vocabulary)
       technique    Impression-[:USES_TECHNIQUE]->Technique
       dimensions   Impression.plateDimensions, then .imageDimensions, NEVER .sheetDimensions
       state        Impression.stateLabel
       images       DigitalImage.embedding + .clipImageEmbedding

   `dateCreated_year` is deliberately ABSENT. It lives on `ConceptualWork` and there is no
   per-impression equivalent, so including it would leak on positives and not on negatives —
   leakage in exactly one direction, which is worse than no feature.

2. THE LABEL SOURCE IS A COLUMN, because most labels are circular.

   The 1,107 multi-institution works exist BECAUSE something merged them; post-merge
   co-residence is the merge decision. Training on them teaches the exact-key rules back to
   you. The standard remedy applies: noisy rule-produced labels for TRAINING, human-adjudicated
   labels for EVALUATION only. `labelSource` and `evalEligible` carry that split, and any
   consumer that trains on an `evalEligible` row has invalidated its own result.

NEGATIVES ARE STRATIFIED BY FAILURE MODE, not sampled from the similar tail.

Mining "high similarity, catalogue conflict" yields plenty of negatives and systematically
excludes the one class every approach so far has failed on. States and colourways do not
announce themselves as catalogue conflicts, so a test set built that way has the hard class
engineered out of it and any model scores beautifully on it. The strata:

    N_catalogue_conflict   different numeric base under a shared prefix, same artist, ranked by
                           image similarity so the retained pairs are HARD
    N_state                same matrix, different work — the class with no known solution
    N_plate_family         titles differing only by a plate designation (`. III`, `No. V`),
                           which ADR-0017 Amendment 2 measured as orthogonal to state

TWO KNOWN POISONS IN THE CATALOGUE MINE, both excluded here, both characterised elsewhere:

  - Glued suffixes. `Baer 618` and `Baer 618Bd` are the SAME work (Portrait de Vollard II,
    scoring 0.982). `find_museum_anchored_work_clusters.entry_base_number` deliberately leaves
    the suffix attached, so conflict is judged on the NUMERIC prefix only — 618 vs 618Bd is
    silent, 618 vs 619 conflicts.
  - Portfolio entries. One Cramer-prefixed entry numbered 30 is the whole of La Bible: 1,172
    works, 1,046 titles. An entry shared by many works is an anchor, not an identity, and a
    group whose entry spans more than MAX_WORKS_PER_ENTRY works is skipped entirely.

Wrong auction citations are NOT excluded, because they cannot be detected here — the held-title
triage found 4 in 63 (Carmen plates cited as Baer 80). That is the negative set's own error
rate and the reason the eval slice must be human-adjudicated rather than mined.

WHAT THE FIRST GRAPH-WIDE RUN ACTUALLY YIELDED (2026-09-11, 4,963 rows), because two of these
numbers decide whether a classifier is worth building at all:

    class                    n   artists   dinoMax   clipMax   titleRatio   dims present
    P_multi_institution   1309       269     0.925     0.935        1.000             6%
    N_catalogue_conflict  2776       291     0.634     0.844        0.304             2%
    N_plate_family         845       116     0.656     0.886        0.955            50%
    N_state                 12         7     0.871     0.873        0.964             8%
    H_human_triage          21         2     0.416     0.748        0.198              0%

  1. TITLE IS THE STRONGEST FEATURE AND IT IS MOSTLY THE LABEL RESTATED. Single-feature AUC for
     titleJaccard is 0.971 against catalogue conflicts, beating dinoMax's 0.919 — but 1,188 of
     the 1,309 positives are identical once normalized, because exact normalized title is what
     merged them. Only **121** positives survive `circularOnTitle = 0`. Filter to those before
     believing any title result.

  2. THE HARD CLASS HAS 12 EXAMPLES IN THE WHOLE GRAPH, and this is not a builder limitation.
     `State` nodes cannot supply more: the museum models states WITHIN one work (905 states
     across 431 works), so they never yield two distinct `ConceptualWork` nodes to pair. The
     only source of same-matrix-different-work pairs is title strings, and there are 12, across
     7 artists. Every approach rejected so far died on this class; a model built here would be
     scored almost entirely on the two strata where DINOv2 already works.

  Technique and medium are at or below chance on every stratum (mediumJaccard scores 0.291
  against plate families — actively anti-correlated). Dimensions are present on 6% of positives
  and 2% of catalogue conflicts, so the one physically independent feature is absent precisely
  where it was wanted.

Usage:
    python3 build_work_identity_dataset.py --out dataset.csv
    python3 build_work_identity_dataset.py --artist "Pablo Picasso" --out picasso.csv
    python3 build_work_identity_dataset.py --max-artists 50 --neg-per-artist 20
"""

import argparse
import csv
import difflib
import os
import re
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase

from find_museum_anchored_work_clusters import entry_base_number

MAX_WORKS_PER_ENTRY = 12      # above this the entry is a portfolio anchor, not an identity
MAX_IMAGES_PER_SIDE = 4       # centroid of more adds nothing and costs a lot
DIM_TOLERANCE = 0.02          # classifyDimensionMatch's own tolerance
DEFAULT_NEG_PER_ARTIST = 12

DIM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)")
STATE_RE = re.compile(
    r"[\s,\-–(\[]+(?:state|etat|état)\s*(?:i{1,3}v?|iv|vi{0,3}|ix|x|[1-9])\b[\s)\]]*", re.I)
PLATE_RE = re.compile(r"[\s,.\-–(\[]+(?:no\.?\s*)?([IVX]{1,6})\s*[)\]]?\s*$")


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


# Every field here hangs off Impression, SourceRecord or DigitalImage. Nothing on the work node
# is selected except its id, which is a key and never a feature — see rule 1 in the docstring.
SIDES_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)
WHERE ($artist IS NULL OR a.name = $artist)
MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.embedding IS NOT NULL
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
RETURN a.name AS artist, w.id AS workId,
       coalesce(s.institutionName, s.sourceType, 'unknown') AS institution,
       s.sourceType AS sourceType,
       collect(DISTINCT i.sourceTitle)      AS sourceTitles,
       collect(DISTINCT i.rawMedium)        AS media,
       collect(DISTINCT i.plateDimensions)  AS plateDims,
       collect(DISTINCT i.imageDimensions)  AS imageDims,
       collect(DISTINCT i.stateLabel)       AS stateLabels,
       collect(DISTINCT t.name)             AS techniques,
       collect(DISTINCT [img.id, img.embedding, img.clipImageEmbedding])[0..8] AS images,
       collect(DISTINCT [cr.numberingPrefix, ce.number]) AS citations
"""

# Fallback wording ONLY, for negatives whose impressions predate the sourceTitle backfill. Never
# used on a positive pair, where it would be the same node read twice.
WORK_NAME_QUERY = "MATCH (w:ConceptualWork) WHERE w.id IN $ids RETURN w.id AS id, w.name AS name"

# Artists worth loading at all: one of their works is recorded by two institutions, or two of
# their works share a catalogue prefix. Iterating artists rather than loading the graph in one
# pass is a memory decision, not a scoping one — 84,751 images at 1024 dimensions in two
# embedding families is roughly 1.4 GB before any pairing happens.
CANDIDATE_ARTISTS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:SHOWS]-(img:DigitalImage)
WHERE img.embedding IS NOT NULL
MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
WITH a.name AS artist, w, count(DISTINCT coalesce(s.institutionName, s.sourceType)) AS insts
WITH artist, sum(CASE WHEN insts >= 2 THEN 1 ELSE 0 END) AS multiInstitutionWorks,
     count(w) AS imagedWorks
WHERE multiInstitutionWorks >= 1 OR imagedWorks >= 8
RETURN artist ORDER BY multiInstitutionWorks DESC, imagedWorks DESC
"""


def norm_text(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def parse_dims(*groups):
    """Plate first, image as fallback, sheet never — the paper is trimmed differently by every
    owner, so a sheet match says nothing about the matrix."""
    for group in groups:
        for raw in group or []:
            if not raw:
                continue
            m = DIM_RE.search(str(raw))
            if m:
                return float(m.group(1)), float(m.group(2))
    return None


def numeric_prefix(base):
    digits = ""
    for ch in str(base or ""):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits


def title_stem(name, pattern):
    """The title with a state or plate designation lifted out, plus the designation itself.
    Returns (stem, designation) or (None, None) when the pattern does not fire."""
    if not name:
        return None, None
    m = pattern.search(name)
    if not m:
        return None, None
    stem = norm_text(pattern.sub(" ", name))
    return (stem, m.group(0).strip()) if len(stem) >= 6 else (None, None)


class Side:
    """One institution's account of one work — or, for a negative, one whole work."""

    def __init__(self, artist, work_id, institution):
        self.artist = artist
        self.workId = work_id
        self.institution = institution
        self.titles, self.media, self.plate, self.image = [], [], [], []
        self.states, self.techniques, self.vectors, self.clips = [], set(), [], []
        self.bases = set()

    def absorb(self, row):
        self.titles += [t for t in row["sourceTitles"] if t]
        self.media += [m for m in row["media"] if m]
        self.plate += [d for d in row["plateDims"] if d]
        self.image += [d for d in row["imageDims"] if d]
        self.states += [s for s in row["stateLabels"] if s]
        self.techniques.update(t for t in row["techniques"] if t)
        for _, emb, clip in row["images"] or []:
            if emb is not None and len(self.vectors) < MAX_IMAGES_PER_SIDE:
                self.vectors.append(emb)
                self.clips.append(clip)
        for prefix, number in row["citations"]:
            if prefix and number and entry_base_number(number):
                self.bases.add((prefix, entry_base_number(number)))

    @property
    def title(self):
        return self.titles[0] if self.titles else None


def _cos_stats(a_vecs, b_vecs):
    pairs = [(x, y) for x in a_vecs for y in b_vecs if x is not None and y is not None]
    if not pairs:
        return None, None
    A = np.array([p[0] for p in pairs], dtype=np.float32)
    B = np.array([p[1] for p in pairs], dtype=np.float32)
    A /= np.linalg.norm(A, axis=1, keepdims=True)
    B /= np.linalg.norm(B, axis=1, keepdims=True)
    sims = (A * B).sum(axis=1)
    return float(sims.max()), float(sims.mean())


def features(a, b, fallback_names=None):
    """All cross-side, all from per-side material. A feature that cannot be computed is
    written as an empty cell, never as a zero — a missing dimension is not a disagreement."""
    f = {}
    f["dinoMax"], f["dinoMean"] = _cos_stats(a.vectors, b.vectors)
    f["clipMax"], f["clipMean"] = _cos_stats(a.clips, b.clips)

    ta, tb = a.title, b.title
    basis = "sourceTitle"
    if (not ta or not tb) and fallback_names:
        ta = ta or fallback_names.get(a.workId)
        tb = tb or fallback_names.get(b.workId)
        basis = "workName"
    f["titleBasis"] = basis if (ta and tb) else ""
    if ta and tb:
        na, nb = norm_text(ta), norm_text(tb)
        f["titleRatio"] = round(difflib.SequenceMatcher(None, na, nb).ratio(), 4)
        sa, sb = set(na.split()), set(nb.split())
        f["titleJaccard"] = round(len(sa & sb) / len(sa | sb), 4) if sa | sb else ""
    else:
        f["titleRatio"] = f["titleJaccard"] = ""

    if a.techniques and b.techniques:
        f["techJaccard"] = round(
            len(a.techniques & b.techniques) / len(a.techniques | b.techniques), 4)
    else:
        f["techJaccard"] = ""

    ma = {norm_text(m) for m in a.media}
    mb = {norm_text(m) for m in b.media}
    f["mediumJaccard"] = round(len(ma & mb) / len(ma | mb), 4) if (ma and mb) else ""

    da = parse_dims(a.plate, a.image)
    db = parse_dims(b.plate, b.image)
    if da and db:
        f["dimMatch"] = int(abs(da[0] - db[0]) <= DIM_TOLERANCE * max(da[0], db[0])
                            and abs(da[1] - db[1]) <= DIM_TOLERANCE * max(da[1], db[1]))
        f["dimA"] = f"{da[0]}x{da[1]}"
        f["dimB"] = f"{db[0]}x{db[1]}"
    else:
        f["dimMatch"] = f["dimA"] = f["dimB"] = ""

    sa = {norm_text(s) for s in a.states}
    sb = {norm_text(s) for s in b.states}
    f["stateA"] = "; ".join(sorted(sa)) if sa else ""
    f["stateB"] = "; ".join(sorted(sb)) if sb else ""
    f["stateConflict"] = int(bool(sa and sb and not (sa & sb))) if (sa and sb) else ""

    shared = {p for p, _ in a.bases} & {p for p, _ in b.bases}
    verdict = "silent"
    for prefix in shared:
        na = {numeric_prefix(x) for p, x in a.bases if p == prefix}
        nb = {numeric_prefix(x) for p, x in b.bases if p == prefix}
        if na & nb:
            verdict = "agree"
            break
        if na and nb:
            verdict = "conflict"
    f["catalogueVerdict"] = verdict

    # Circularity marker, not a feature. 933 of 1,309 positives carry IDENTICAL wording on both
    # sides, because exact normalized title is what `find_duplicate_work_clusters.py` merged
    # them on — so for those rows the title features are the label restated. Any consumer
    # training a title feature must filter to circularOnTitle = 0, which is the slice a
    # catalogue anchor or a human produced rather than a title rule.
    f["circularOnTitle"] = int(bool(ta and tb and norm_text(ta) == norm_text(tb)))
    return f


def load_sides(session, artist):
    """(workId, institution) -> Side, plus workId -> [Side] and workId -> artist."""
    sides, by_work, artist_of = {}, defaultdict(list), {}
    for r in session.run(SIDES_QUERY, artist=artist):
        key = (r["workId"], r["institution"])
        side = sides.get(key)
        if side is None:
            side = sides[key] = Side(r["artist"], r["workId"], r["institution"])
            by_work[r["workId"]].append(side)
            artist_of[r["workId"]] = r["artist"]
        side.absorb(r)
    return sides, by_work, artist_of


def whole_work(sides_of_work):
    """Collapse a work's institution-sides into one, for use as a negative's side."""
    first = sides_of_work[0]
    merged = Side(first.artist, first.workId, "+".join(
        sorted({s.institution for s in sides_of_work})))
    for s in sides_of_work:
        merged.titles += s.titles
        merged.media += s.media
        merged.plate += s.plate
        merged.image += s.image
        merged.states += s.states
        merged.techniques |= s.techniques
        merged.bases |= s.bases
        for v, c in zip(s.vectors, s.clips):
            if len(merged.vectors) < MAX_IMAGES_PER_SIDE:
                merged.vectors.append(v)
                merged.clips.append(c)
    return merged


def build_positives(by_work):
    """One row per work per institution PAIR. Both sides must carry an embedded image and the
    institutions must differ, or the pair is the same record compared with itself."""
    out = []
    for work_id, sides in by_work.items():
        usable = [s for s in sides if s.vectors]
        for i in range(len(usable)):
            for j in range(i + 1, len(usable)):
                a, b = usable[i], usable[j]
                if a.institution == b.institution:
                    continue
                out.append(("P_multi_institution", 1, "rule:multi_institution", 0, a, b, ""))
    return out


def build_catalogue_negatives(by_work, artist_of, per_artist):
    """Distinct works whose NUMERIC entry prefixes differ under a shared catalogue prefix,
    ranked by image similarity so what survives is hard rather than merely plentiful."""
    works = {w: whole_work(s) for w, s in by_work.items()}
    by_entry, by_artist_prefix = defaultdict(set), defaultdict(lambda: defaultdict(list))
    for w, side in works.items():
        for prefix, base in side.bases:
            by_entry[(prefix, base)].add(w)
            by_artist_prefix[artist_of[w]][prefix].append((numeric_prefix(base), side))

    portfolio = {k for k, v in by_entry.items() if len(v) > MAX_WORKS_PER_ENTRY}
    out = []
    for artist, prefixes in by_artist_prefix.items():
        scored = []
        for prefix, entries in prefixes.items():
            buckets = defaultdict(list)
            for num, side in entries:
                if num and (prefix, num) not in portfolio:
                    buckets[num].append(side)
            nums = sorted(buckets)
            for i in range(len(nums)):
                for j in range(i + 1, len(nums)):
                    a, b = buckets[nums[i]][0], buckets[nums[j]][0]
                    if a.workId == b.workId or not (a.vectors and b.vectors):
                        continue
                    top, _ = _cos_stats(a.vectors, b.vectors)
                    if top is not None:
                        scored.append((top, prefix, nums[i], nums[j], a, b))
        scored.sort(key=lambda x: -x[0])
        for top, prefix, na, nb, a, b in scored[:per_artist]:
            out.append(("N_catalogue_conflict", 0, "rule:catalogue_conflict", 0, a, b,
                        f"{prefix} {na} vs {nb}"))
    return out


def build_title_negatives(by_work, artist_of, names, pattern, cls, label_source):
    """Two works whose titles agree once a state (or plate) designation is lifted out. The
    designation is the only thing separating them, which is exactly the point."""
    works = {w: whole_work(s) for w, s in by_work.items()}
    groups = defaultdict(list)
    for work_id, side in works.items():
        stem, designation = title_stem(names.get(work_id), pattern)
        if stem and side.vectors:
            groups[(artist_of[work_id], stem)].append((designation, side))
    out = []
    for (artist, stem), members in groups.items():
        seen = {d for d, _ in members}
        if len(members) < 2 or len(seen) < 2:
            continue
        for i in range(len(members) - 1):
            (da, a), (db, b) = members[i], members[i + 1]
            if da == db or a.workId == b.workId:
                continue
            out.append((cls, 0, label_source, 0, a, b, f"{artist}: {stem} [{da} | {db}]"))
    return out


def load_triage(path, sides_by_work, names):
    """The human-adjudicated rows. B and C are the same work, A and D are different works —
    the only labels in this file that were decided by a person looking at the evidence, and
    therefore the only ones eligible for evaluation."""
    if not path or not os.path.exists(path):
        return []
    label_of = {"B_same_work_alias": 1, "C_near_identical_title": 1,
                "A_citation_error": 0, "D_different_works": 0}
    out = []
    for row in csv.DictReader(open(path, encoding="utf-8")):
        label = label_of.get(row["category"])
        if label is None:
            continue
        a_sides = sides_by_work.get(row["anchorId"])
        b_sides = sides_by_work.get(row["otherId"])
        if not a_sides or not b_sides:
            # Categories B and C were merged in 87e4441, so one side's node is gone. The
            # judgement still stands; the row is emitted without features rather than dropped.
            out.append(("H_human_triage", label, f"human:{row['category']}", 1, None, None,
                        f"UNRESOLVED {row['anchorId']} | {row['otherId']}"))
            continue
        out.append(("H_human_triage", label, f"human:{row['category']}", 1,
                    whole_work(a_sides), whole_work(b_sides), row["category"]))
    return out


COLUMNS = ["cls", "label", "labelSource", "evalEligible", "artist", "workA", "workB",
           "institutionA", "institutionB", "titleA", "titleB", "titleBasis",
           "dinoMax", "dinoMean", "clipMax", "clipMean", "titleRatio", "titleJaccard",
           "techJaccard", "mediumJaccard", "dimMatch", "dimA", "dimB",
           "stateA", "stateB", "stateConflict", "catalogueVerdict", "circularOnTitle",
           "note"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist", default=None, help="restrict to one artist")
    ap.add_argument("--out", default="work_identity_dataset.csv")
    ap.add_argument("--neg-per-artist", type=int, default=DEFAULT_NEG_PER_ARTIST)
    ap.add_argument("--max-artists", type=int, default=None,
                    help="cap the artist loop; omit for the whole graph")
    ap.add_argument("--triage", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "picasso_held_title_triage_2026-09-11.csv"))
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    rows, names, all_by_work = [], {}, {}
    tally = defaultdict(int)
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            if args.artist:
                artists = [args.artist]
            else:
                print("finding candidate artists...", flush=True)
                artists = [r["artist"] for r in session.run(CANDIDATE_ARTISTS_QUERY)]
                if args.max_artists:
                    artists = artists[:args.max_artists]
                print(f"  {len(artists)} artists", flush=True)

            for n, artist in enumerate(artists, 1):
                sides, by_work, artist_of = load_sides(session, artist)
                if not by_work:
                    continue
                local_names = {r["id"]: r["name"] for r in session.run(
                    WORK_NAME_QUERY, ids=list(by_work))}
                names.update(local_names)
                all_by_work.update(by_work)
                batch = build_positives(by_work)
                batch += build_catalogue_negatives(by_work, artist_of, args.neg_per_artist)
                batch += build_title_negatives(by_work, artist_of, local_names, STATE_RE,
                                               "N_state", "rule:title_state")
                batch += build_title_negatives(by_work, artist_of, local_names, PLATE_RE,
                                               "N_plate_family", "rule:title_plate")
                rows += batch
                for r in batch:
                    tally[r[0]] += 1
                if n % 25 == 0 or n == len(artists):
                    print(f"  {n}/{len(artists)} artists — "
                          + "  ".join(f"{k} {v}" for k, v in sorted(tally.items())), flush=True)
    finally:
        driver.close()

    triage = load_triage(args.triage, all_by_work, names)
    rows += triage
    print(f"  H_human_triage {len(triage)}", flush=True)

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        written = 0
        for cls, label, source, eval_ok, a, b, note in rows:
            rec = {"cls": cls, "label": label, "labelSource": source,
                   "evalEligible": eval_ok, "note": note}
            if a is None or b is None:
                writer.writerow(rec)
                written += 1
                continue
            rec.update({"artist": a.artist, "workA": a.workId, "workB": b.workId,
                        "institutionA": a.institution, "institutionB": b.institution,
                        "titleA": a.title or names.get(a.workId, ""),
                        "titleB": b.title or names.get(b.workId, "")})
            rec.update(features(a, b, fallback_names=names if label == 0 else None))
            writer.writerow({k: ("" if v is None else v) for k, v in rec.items()})
            written += 1
    print(f"\nwrote {written} rows -> {args.out}")
    print(f"  positives {sum(1 for r in rows if r[1] == 1)}  "
          f"negatives {sum(1 for r in rows if r[1] == 0)}  "
          f"evalEligible {sum(1 for r in rows if r[3] == 1)}")


if __name__ == "__main__":
    main()
