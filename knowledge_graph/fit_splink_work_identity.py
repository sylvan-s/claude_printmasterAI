"""
PrintMasterAI — probabilistic record linkage for work identity, via Splink.
Version: SPLINK-IDENTITY-1.0

Fits and scores. Writes nothing to the graph and proposes no merges.

WHY A LINKAGE MODEL RATHER THAN A CLASSIFIER. `train_work_identity_model.py` reaches AUC 0.923
honestly, +0.007 over DINOv2 and CLIP alone, and its two strongest features turned out to be
leakage: `catalogueVerdict` is the sampler for three quarters of the negatives, and 1,188 of the
1,309 positives are title-identical. The constraint was never the model, it was the labels.
Splink estimates its m and u parameters by EM, WITHOUT labels. `work_id` is read here only to
score the output.

THE DESIGN DECISION THAT DECIDES THE RESULT. u is "probability of agreement given non-match",
normally estimated from random pairs. Random pairs in this graph are trivially different — the
N_random stratum sits at DINOv2 0.377 — while the negatives that matter are portfolio mates,
where technique agrees ~98% of the time and dimensions nearly always match. Estimating u on
random pairs would teach the model that "same technique, same size" is strong evidence, when
within one catalogue it is evidence of nothing. So the frame is BLOCKED TO ONE ARTIST WITHIN ONE
CATALOGUE: every record cites the same raisonne, and u is estimated on the hard population.

RESULT on Pablo Picasso within Baer — 1,172 records, 1,043 works, 686,206 pairs, 143 true matches:

    match_weight   flagged    TP   precision   recall
        0 (p .50)      239   124       51.9%    86.7%
        5 (p .97)      103    84       81.6%    58.7%
       10 (p .999)      18    18      100.0%    12.6%

  AUC OVER ALL PAIRS IS 1.000 AND MEANS NOTHING: 143 matches in 686k pairs, nearly all trivially
  different, so the metric is dominated by easy negatives. Restricted to the strata that matter
  it is ordinary:

        all negatives                       n=686,063   AUC 1.000
        sharing a catalogue base            n=    190   AUC 0.881
        image cosine >= 0.85                n=    336   AUC 0.912
        image cosine >= 0.92                n=     30   AUC 0.748

  The worst-ranked true match sits at position 1,592 with 1,449 negatives above it. This is a
  strong candidate generator and not a decider — the same seat DINOv2 already occupies, reached
  differently. Note 0.748 against the 30 hardest image pairs: where the pictures agree closely,
  nothing else here separates them, which is the state and colourway problem again.

THE FINDING WORTH HAVING is what EM did with technique, unsupervised:

    tech_family   exact match        m=0.986  u=0.761   log2 BF  +0.37
                  families disagree  m=0.015  u=0.239   log2 BF  -4.05

  Agreement is worth almost nothing, because 76% of non-matching portfolio mates agree too.
  DISAGREEMENT is worth -4.05. That is exactly the asymmetry measured by hand for
  `build_work_identity_dataset.py` (no shared family: 3.6% of positives against 15.1% of hard
  negatives, LR ~3.4) and bolted on there as `techFamilyVeto`. Fellegi-Sunter found it from the
  data, with no labels and nothing pointing at it. It is the structural argument for this
  approach, demonstrated rather than asserted.

TWO TRAPS, both hit before this file existed:

  1. DO NOT COMPRESS THE EMBEDDINGS WITH A CENTRED PCA. A 128-dim projection scored 96.7% bucket
     agreement against the full cosine but a MAXIMUM ABSOLUTE ERROR OF 0.864. Mean-centring
     before the SVD changes the inner-product geometry and renormalising afterwards distorts it
     again, so the projection preserves variance rather than the cosine it stands in for. It is
     unnecessary anyway: the original failure was 2,000,000 u-sampling pairs, not the width of
     the vector. At 200k, the full 1024 dimensions predict in 1.3 seconds.

  2. `retain_matching_columns` DEFAULTS TO TRUE AND OOM-KILLS THE FIT AFTER EM HAS CONVERGED —
     it keeps every input column on every pair, and emb_l + emb_r at 1024 floats each over 686k
     pairs is ~5.6 GB. It is the matching columns that must go, NOT the intermediate ones: the
     gamma level columns the hard-negative breakdown needs come only from
     `retain_intermediate_calculation_columns`, so turning that off to fix the OOM silently
     removed them. Keep intermediates on, matching columns off, and project the handful of
     wanted columns in SQL before anything reaches pandas.

Usage:
    python3 fit_splink_work_identity.py --artist "Pablo Picasso" --catalogue baer
    python3 fit_splink_work_identity.py --artist "Rembrandt van Rijn" --catalogue hollstein
"""

import argparse
import os
import re

import numpy as np
import pandas as pd
import splink.comparison_level_library as cll
from neo4j import GraphDatabase
from splink import DuckDBAPI, Linker, SettingsCreator, block_on
from splink.comparison_library import CustomComparison

from catalogue_prefix import canonical_prefix, fold_prefix

# Ported from two_pass_attribution.ts TECH_FAMILY_KEYWORDS, including its order, which is
# load-bearing: relief must precede intaglio because intaglio's `engrav` also matches "wood
# engraving". Kept in step with build_work_identity_dataset.py.
FAMILIES = [
    ("photomechanical", r"giclee|giclée|inkjet|digital|halftone|photogravure|photolith|"
                        r"collotype|offset|c-?print|chromogenic|pigment print"),
    ("relief",          r"woodcut|wood[\s-]?engrav|linocut|lino[\s-]?cut|linoleum|relief|"
                        r"xylograph|metalcut"),
    ("intaglio",        r"etch|engrav|drypoint|dry-?point|aquatint|mezzotint|burin|intaglio|"
                        r"soft-?ground|roulette|stipple|sugar-?lift|crayon manner"),
    ("planographic",    r"lithograph|litho|planograph|zincograph|chromolith"),
    ("screen",          r"screenprint|screen print|serigraph|silkscreen|pochoir|stencil"),
]
FAMILY_RES = [(f, re.compile(p, re.I)) for f, p in FAMILIES]
DIM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)")

U_SAMPLE_PAIRS = 200_000      # u is an agreement RATE; 200k puts its error below level spacing
DETERMINISTIC_RECALL = 0.7    # assumed recall of the label-free rule that sets the prior

RECORDS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
      -[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
MATCH (i)<-[:DOCUMENTS]-(s:SourceRecord)
MATCH (w)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
WHERE a.name = $artist AND cr.numberingPrefix =~ $cataloguePattern
OPTIONAL MATCH (i)<-[:SHOWS]-(img:DigitalImage) WHERE img.embedding IS NOT NULL
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
RETURN w.id AS workId, coalesce(s.institutionName, s.sourceType, 'unknown') AS institution,
       collect(DISTINCT i.sourceTitle) AS titles, collect(DISTINCT i.rawMedium) AS media,
       collect(DISTINCT t.name) AS techs,
       collect(DISTINCT i.plateDimensions) + collect(DISTINCT i.imageDimensions) AS dims,
       collect(DISTINCT ce.number) AS entries,
       collect(DISTINCT img.embedding)[0..3] AS embeddings
"""


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


def training_rules(df, min_pairs=200):
    """Deterministic rule for the prior, and EM blocking rules — chosen from the fields this
    FRAME actually populates, not hard-coded.

    Both were hard-coded to `entry` until 2026-09-12, and on the no-catalogue collision set —
    6,067 collisions where by definition nothing cites a catalogue — that produced a silently
    broken model rather than an error. The prior estimated to ZERO ("Deterministic matching rules
    led to no observed matches"), the EM session on `entry` raised and was skipped, and the one
    remaining session fitted weights that are visibly nonsense: image cosine >= 0.97 at log2 BF
    -161, exact title at -3.49. A ranking came out and was worthless.

    So coverage is measured first and a frame that cannot train is refused, loudly."""
    coverage = {c: float(df[c].notna().mean()) for c in
                ("dim_w", "tech_family", "title_folded", "year", "clip")
                if c in df.columns}
    for col in ("entries", "exact_entries"):
        if col in df.columns:
            coverage[col] = float(df[col].map(lambda v: bool(v)).mean())
    usable = [c for c, frac in coverage.items() if frac >= 0.10]

    # Deterministic rule: a conjunction precise enough that its matches are almost all true.
    # `entry` first where it exists, dimensions next — both are exact and independent of title.
    if coverage.get("exact_entries", 0) >= 0.10:
        deterministic = ["l.title_folded = r.title_folded "
                         "and len(list_intersect(l.exact_entries, r.exact_entries)) > 0"]
    elif coverage.get("entries", 0) >= 0.10:
        deterministic = ["l.title_folded = r.title_folded "
                         "and len(list_intersect(l.entries, r.entries)) > 0"]
    elif coverage.get("dim_w", 0) >= 0.10:
        deterministic = ["l.title_folded = r.title_folded and l.dim_w = r.dim_w "
                         "and l.dim_h = r.dim_h"]
    elif coverage.get("year", 0) >= 0.10:
        deterministic = ["l.title_folded = r.title_folded and l.year = r.year"]
    else:
        raise RuntimeError(
            "no field is populated enough for a deterministic rule — coverage "
            + ", ".join(f"{c} {f:.0%}" for c, f in sorted(coverage.items()))
            + ". A prior cannot be estimated and any ranking would be meaningless.")

    # EM blocking: PREFER A FIELD NO COMPARISON USES. Splink cannot estimate parameters for a
    # comparison whose field it blocked on, so blocking on `dim_w` silently leaves the `dims`
    # comparison at defaults — and on the no-catalogue frame that showed up as an INVERTED image
    # scale, cosine >= 0.97 scoring +5.04 against +8.10 for 0.70-0.85. `year` is compared by
    # nothing here, so it blocks for free. `title_folded` is excluded: within a collision frame
    # it is close to the collision key itself.
    # `entries` is an ARRAY and cannot be blocked on; it is also a comparison field.
    em = [block_on(c) for c in ("year",) if coverage.get(c, 0) >= 0.10]
    for c in ("dim_w", "tech_family"):
        if len(em) >= 2:
            break
        if coverage.get(c, 0) >= 0.10:
            em.append(block_on(c))
    if not em:
        raise RuntimeError("no field is populated enough to block an EM session on")
    return deterministic, em, coverage


def _fold_title(title):
    """Lowercase and strip diacritics. Matches find_title_collisions.fold, so what the
    collision scan groups on is what Splink compares."""
    import unicodedata
    s = unicodedata.normalize("NFD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip() or None


def technique_family(texts):
    for text in texts:
        if not text:
            continue
        for family, rx in FAMILY_RES:
            if rx.search(str(text)):
                return family
    return None


def parse_dims(values):
    """Plate first, image as fallback, sheet never — the paper is trimmed differently by every
    owner, so a sheet match says nothing about the matrix."""
    for raw in values or []:
        if not raw:
            continue
        m = DIM_RE.search(str(raw))
        if m:
            return round(float(m.group(1)), 1), round(float(m.group(2)), 1)
    return None, None


def entry_base(number):
    """Leading digits of ONE entry number. `1173.B.b.1` -> `1173`, so a state or edition
    designation does not split a work from itself — the Baer 618 / 618Bd lesson."""
    digits = ""
    for ch in str(number or ""):
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits or None


_ENTRY_ALNUM = re.compile(r"[^a-z0-9]")


def entry_exact_keys(citations, artist=None):
    """EVERY citation as prefix+number folded to lowercase alphanumerics, stripping NOTHING.

    `entry_base` takes leading DIGITS, breaking at the first non-digit from the START, so any
    number that begins with a letter yields nothing at all and the citation vanishes from the
    model. Measured 2026-09-13: 1,839 of 22,273 entries (8.3%), documenting 2,024 works.
    Feldmann & Schellmann — Warhol's catalogue — is 96% invisible, and `entry` is the strongest
    single comparison in the model at about +11 log2 on the partial frame.

    The obvious repair, "alphabetic designator plus the first run of digits", is NOT SAFE. It
    collapses W/C 4, W/D 10 and W/D 21 onto `w`, and RM12.03 through RM12.07 onto `rm12`: a
    state suffix (618Bd) and a second number component (12.03) cannot be told apart by pattern.

    So this strips nothing and is purely ADDITIVE. It can only group spellings that differ in
    punctuation or case — measured, the 159 groups it forms are all of that kind ('222', 'P.222',
    'p222'). It joins prefix-split spellings for free, since prefix and number are folded
    together: Lynton/'G27' and 'Lynton G'/'27' both give `lyntong27`. Where the NUMBER repeats
    its own catalogue's prefix ("L." + "L.263" against "L." + "263") both spellings are emitted,
    because that is one citation written twice.

    It does NOT replace entry_base, which exists for the Baer 618 / 618Bd state-family lesson.
    The two are separate comparison levels and EM weights each.

    The prefix is canonicalised by `catalogue_prefix.canonical_prefix`, which folds the spelling
    always and resolves an artist-scoped abbreviation only where the alias table carries measured
    evidence. Pass `artist` to get that second tier; without it only folding applies."""
    keys = set()
    for prefix, number in citations or []:
        folded_number = _ENTRY_ALNUM.sub("", str(number or "").lower())
        if not folded_number:
            continue
        # BOTH the folded spelling and the canonical one, so canonicalisation can only ADD keys.
        # It has to: where a source splits prefix and number differently — "Coppel" + "CEP.16"
        # against "Coppel  CEP" + "16" — folding alone already made those agree, and mapping
        # `coppel` to `coppelcep` doubles the designator on one side and breaks a match that
        # was working. Measured: emitting only the canonical key turned 5 agreeing pairs into
        # conflicts while fixing 57, and a canonicalisation that destroys evidence is not one.
        for folded_prefix in {fold_prefix(prefix), canonical_prefix(prefix, artist)}:
            keys.add(folded_prefix + folded_number)
            # the number repeating its own prefix ("L." + "L.263") is one citation written twice
            if folded_prefix and folded_number.startswith(folded_prefix) \
                    and len(folded_number) > len(folded_prefix):
                keys.add(folded_prefix + folded_number[len(folded_prefix):])
    return sorted(keys)


def entry_keys(citations):
    """EVERY citation a work carries, as "prefix base" — e.g. ["baer 623", "bloch 999"].

    Two bugs this replaces, both in a field named `entry` that held a bare number:

      THE PREFIX WAS DROPPED. Only `CatalogueEntry.number` was read, never
      `CatalogueRaisonne.numberingPrefix`, so "Baer 623" and "Bloch 623" both became "623" and
      matched EXACTLY — worth +5.33 log2 on a coincidence of numbering between two different
      catalogues. Picasso works routinely cite both. Every other module in this directory
      compares (prefix, base) PAIRS; this field was the one that did not.

      ONLY THE FIRST WAS KEPT. A work citing Baer 623 and Bloch 999 contributed one of them,
      chosen by Neo4j's collection order, so the field was not stable across runs.

    Returning the whole set lets the comparison ask whether the two works share ANY citation,
    which is what "the catalogue agrees" actually means. A scalar cannot express that."""
    keys = set()
    for prefix, number in citations or []:
        base = entry_base(number)
        if prefix and base:
            keys.add(f"{str(prefix).strip().lower()} {base}")
    return sorted(keys)


def build_records(session, artist, catalogue):
    rows = []
    for n, r in enumerate(session.run(RECORDS_QUERY, artist=artist,
                                      cataloguePattern=f"(?i).*{catalogue}.*")):
        vectors = [v for v in r["embeddings"] if v]
        embedding = None
        if vectors:
            M = np.array(vectors, dtype=np.float32)
            M /= np.linalg.norm(M, axis=1, keepdims=True)
            centroid = M.mean(axis=0)
            embedding = (centroid / np.linalg.norm(centroid)).tolist()
        width, height = parse_dims(r["dims"])
        titles = [t for t in r["titles"] if t]
        rows.append({
            "unique_id": n, "work_id": r["workId"], "institution": r["institution"],
            "title": titles[0] if titles else None,
            "title_folded": _fold_title(titles[0] if titles else None),
            "tech_family": technique_family(list(r["techs"]) + list(r["media"])),
            "dim_w": width, "dim_h": height,
            "entries": entry_keys(r["citations"]),
            "exact_entries": entry_exact_keys(r["citations"], r.get("artist")),
            "emb": embedding,
        })
    return pd.DataFrame(rows)


def settings():
    return SettingsCreator(
        link_type="dedupe_only",
        # Every record cites the same catalogue, so the frame IS the hard population.
        blocking_rules_to_generate_predictions=["1=1"],
        comparisons=[
            CustomComparison(output_column_name="image", comparison_levels=[
                cll.CustomLevel("emb_l IS NULL OR emb_r IS NULL", "no image")
                   .configure(is_null_level=True),
                # vectors are unit norm, so the dot product IS the cosine
                cll.CustomLevel("list_dot_product(emb_l, emb_r) >= 0.97", "cosine >= 0.97"),
                cll.CustomLevel("list_dot_product(emb_l, emb_r) >= 0.92", "0.92 - 0.97"),
                cll.CustomLevel("list_dot_product(emb_l, emb_r) >= 0.85", "0.85 - 0.92"),
                cll.CustomLevel("list_dot_product(emb_l, emb_r) >= 0.70", "0.70 - 0.85"),
                cll.ElseLevel(),
            ]),
            # COMPARED FOLDED, NOT RAW. ExactMatchLevel and JaroWinklerLevel are both
            # case-sensitive, and records reach a collision frame because their FOLDED titles
            # match — so the pairs that collide only after folding got the worst possible title
            # evidence. Measured: "Bally"/"BALLY" scored 0.200 raw and 1.000 folded,
            # "WHAAM!"/"Whaam" 0.182 and 0.909. With the title level at -1.41 log2 and a prior
            # near -17.4, that put true duplicates at the very BOTTOM of the ranking: 12 of the
            # 20 lowest-scoring pairs in the graph were confirmed the same work, one of them
            # Lichtenstein's WHAAM!. `title_folded` is NFD-stripped and lowercased by the
            # caller; `title` stays on the record for display.
            # CLIP ALONGSIDE DINOv2, not instead of it. Measured on 14 Picasso/Baer pairs:
            # DINOv2 scores AUC 0.977 against different works and 0.575 against states of one
            # plate; CLIP scores 0.930 and 0.677 — worse at the easy task, better at the hard
            # one. Different failure modes, and CLIP is backfilled at parity (84,751 images
            # each), so it costs nothing to carry.
            #
            # CAVEAT, stated because Fellegi-Sunter assumes it away: the two are NOT
            # conditionally independent. They are both global image descriptors over the same
            # pixels, so when they agree the model double-counts. Read a high combined weight as
            # "the pictures agree", not as two independent votes.
            CustomComparison(output_column_name="clip", comparison_levels=[
                cll.CustomLevel("clip_l IS NULL OR clip_r IS NULL", "no clip vector")
                   .configure(is_null_level=True),
                cll.CustomLevel("list_dot_product(clip_l, clip_r) >= 0.97", "cosine >= 0.97"),
                cll.CustomLevel("list_dot_product(clip_l, clip_r) >= 0.92", "0.92 - 0.97"),
                cll.CustomLevel("list_dot_product(clip_l, clip_r) >= 0.85", "0.85 - 0.92"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="title", comparison_levels=[
                cll.NullLevel("title_folded"), cll.ExactMatchLevel("title_folded"),
                cll.JaroWinklerLevel("title_folded", 0.92),
                cll.JaroWinklerLevel("title_folded", 0.80),
                cll.ElseLevel(),
            ]),
            # SCORED, NOT A VETO — and calibrated, which is the point. Technique is asymmetric:
            # agreement is worth almost nothing because ~78% of non-matching portfolio mates
            # agree too, while disagreement is real evidence. EM finds that asymmetry unprompted
            # on every frame (+0.33/-3.90 Picasso within Baer, +1.90/-2.85 all collisions,
            # +1.72/-1.64 no-catalogue only).
            #
            # Measured independently over 300 adjudicated pairs, technique disagreement carries
            # a likelihood ratio of 6.67x for different-work — log2(1/6.67) = -2.74, against the
            # -2.85 EM learned on the same population. The model is already right to within 0.11,
            # so a hard veto here would replace a fitted weight with -inf on the strength of the
            # five disagreeing pairs in that sample. It is not warranted.
            #
            # A veto belongs where there is no model to put the signal into:
            # find_exact_catalogue_merges.py is an exact-key rule and vetoes on technique there,
            # because that is the only way the signal can enter at all.
            CustomComparison(output_column_name="tech_family", comparison_levels=[
                cll.NullLevel("tech_family"), cll.ExactMatchLevel("tech_family"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="dims", comparison_levels=[
                cll.CustomLevel("dim_w_l IS NULL OR dim_w_r IS NULL", "no dimensions")
                   .configure(is_null_level=True),
                cll.CustomLevel("abs(dim_w_l-dim_w_r) <= 0.02*greatest(dim_w_l,dim_w_r) "
                                "AND abs(dim_h_l-dim_h_r) <= 0.02*greatest(dim_h_l,dim_h_r)",
                                "within 2%"),
                cll.ElseLevel(),
            ]),
            # SHARES ANY CITATION, not "the first ones happen to be equal" — see entry_keys.
            # ONE level, firing on EITHER key. Splitting it into "shares the printed citation"
            # and "shares only the stem" was tried on 2026-09-13 and dropped: on the partial
            # frame the stem-only level held TWELVE pairs of 2,327, and EM duly returned +11.24
            # for it against +9.16 for the exact level — the weaker evidence scoring higher,
            # which is noise, not a finding. The recovery this change is for comes from
            # entry_exact_keys reaching citations entry_base drops (8.3% of all entries), not
            # from grading the two against each other. Revisit only on a frame where the
            # stem-only level has enough pairs to estimate.
            CustomComparison(output_column_name="entry", comparison_levels=[
                cll.CustomLevel("(entries_l IS NULL OR len(entries_l) = 0) "
                                "AND (exact_entries_l IS NULL OR len(exact_entries_l) = 0) "
                                "OR (entries_r IS NULL OR len(entries_r) = 0) "
                                "AND (exact_entries_r IS NULL OR len(exact_entries_r) = 0)",
                                "no citation on one side").configure(is_null_level=True),
                cll.CustomLevel("len(list_intersect(exact_entries_l, exact_entries_r)) > 0 "
                                "OR len(list_intersect(entries_l, entries_r)) > 0",
                                "shares a catalogue citation"),
                cll.ElseLevel(),
            ]),
        ],
        # THE OOM WAS retain_matching_columns, WHICH DEFAULTS TO TRUE: it keeps every input
        # column on every pair, and emb_l + emb_r at 1024 floats each over 686k pairs is ~5.6 GB.
        # The gamma level columns, which the hard-negative breakdown needs, come only from
        # retain_intermediate_calculation_columns — turning that off to fix the OOM removed them
        # too. Keep it on, keep matching columns off, and project in SQL before materialising.
        retain_intermediate_calculation_columns=True,
        retain_matching_columns=False,
    )


def report(pred, truth, model):
    y = np.array([int(truth[a] == truth[b])
                  for a, b in zip(pred.unique_id_l, pred.unique_id_r)])
    pred["y"] = y
    w = pred.match_weight.values
    print(f"\n{len(pred):,} pairs, {int(y.sum())} true matches "
          f"(base rate 1 in {len(pred)//max(int(y.sum()),1):,})")

    print("\nprecision / recall — AUC over an unblocked cartesian is dominated by easy negatives")
    print(f"{'match_weight':>12} {'flagged':>9} {'TP':>5} {'precision':>10} {'recall':>8}")
    for t in (0, 5, 10, 15, 20):
        fired = w >= t
        tp = int((fired & (y == 1)).sum())
        print(f"{t:12d} {int(fired.sum()):9d} {tp:5d} "
              f"{tp/max(int(fired.sum()),1):10.1%} {tp/max(int(y.sum()),1):8.1%}")

    def auc(neg_mask):
        a, b = w[y == 1], w[neg_mask]
        if not len(a) or not len(b):
            return float("nan")
        return ((a[:, None] > b[None, :]).sum()
                + 0.5 * (a[:, None] == b[None, :]).sum()) / (len(a) * len(b))

    print("\nAUC by negative stratum — the restricted rows are the ones that mean anything")
    # bf_* is the Bayes factor the fitted level contributes, so a threshold on it selects a
    # level or better. Taken from the model rather than hard-coded, since EM sets them.
    level_bf = {c["output_column_name"]: [
        lvl["m_probability"] / max(lvl["u_probability"], 1e-12)
        for lvl in c["comparison_levels"] if "m_probability" in lvl]
        for c in model["comparisons"]}
    strata = [("all negatives", y == 0)]
    if "bf_entry" in pred:
        strata.append(("negatives sharing a catalogue base",
                       (y == 0) & (pred.bf_entry.values >= level_bf["entry"][0] * 0.99)))
    if "bf_image" in pred:
        for label, idx in (("image cosine >= 0.92", 1), ("image cosine >= 0.85", 2)):
            strata.append((f"negatives with {label}",
                           (y == 0) & (pred.bf_image.values >= level_bf["image"][idx] * 0.99)))
    for label, mask in strata:
        if int(mask.sum()):
            print(f"  {label:40s} n={int(mask.sum()):8,d}  AUC {auc(mask):.3f}")

    order = np.argsort(-w)
    ranks = np.where(y[order] == 1)[0]
    print(f"\nworst-ranked true match at position {ranks.max()+1:,} of {len(pred):,}; "
          f"{ranks.max()+1-len(ranks):,} negatives above it")
    return pred


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--artist", default="Pablo Picasso")
    ap.add_argument("--catalogue", default="baer", help="substring of numberingPrefix")
    ap.add_argument("--out", default="splink_work_identity.csv")
    args = ap.parse_args()

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            df = build_records(session, args.artist, args.catalogue)
    finally:
        driver.close()
    if df.empty:
        raise SystemExit(f"no records for {args.artist} within {args.catalogue}")
    print(f"{len(df)} records  {df.work_id.nunique()} works  "
          f"{int(df.emb.notna().sum())} with an image  "
          f"{int(df.title.notna().sum())} with a sourceTitle", flush=True)
    print(f"true matching pairs: "
          f"{int(sum(c*(c-1)//2 for c in df.work_id.value_counts()))}", flush=True)

    db_api = DuckDBAPI()
    linker = Linker(df, settings(), db_api=db_api)
    # The prior comes from a LABEL-FREE deterministic rule. work_id never enters the fit.
    linker.training.estimate_probability_two_random_records_match(
        ["l.title = r.title and l.entry = r.entry"], recall=DETERMINISTIC_RECALL)
    linker.training.estimate_u_using_random_sampling(max_pairs=U_SAMPLE_PAIRS)
    for rule in (block_on("tech_family"), block_on("entry")):
        try:
            linker.training.estimate_parameters_using_expectation_maximisation(rule)
        except Exception as exc:
            print(f"  EM on {rule} skipped: {type(exc).__name__}: {exc}", flush=True)

    model = linker.misc.save_model_to_json()      # already a dict in Splink 4
    print("\nEM-learned weights (log2 Bayes factor per comparison level)")
    for comparison in model["comparisons"]:
        print(f"  {comparison['output_column_name']}")
        for level in comparison["comparison_levels"]:
            if "m_probability" in level and "u_probability" in level:
                bf = level["m_probability"] / max(level["u_probability"], 1e-12)
                print(f"    {level.get('label_for_charts', ''):42s} "
                      f"m={level['m_probability']:.4f} u={level['u_probability']:.4f}  "
                      f"log2 BF {np.log2(bf):+6.2f}")

    result = linker.inference.predict()
    # `gamma_*` (the level index) is emitted only with retain_matching_columns, which is what
    # holds the vectors. `bf_*` comes from the intermediates and is monotone in the level, so it
    # carries the same stratification at none of the memory cost.
    bfs = ", ".join(f"bf_{c['output_column_name']}" for c in model["comparisons"])
    # Project in SQL so nothing wide is ever materialised into pandas.
    pred = db_api._con.execute(
        f"SELECT unique_id_l, unique_id_r, match_weight, match_probability, {bfs} "
        f"FROM {result.physical_name}").df()

    pred = report(pred, df.set_index("unique_id")["work_id"].to_dict(), model)
    pred.to_csv(args.out, index=False)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
