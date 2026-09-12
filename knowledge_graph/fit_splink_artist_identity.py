"""
PrintMasterAI — probabilistic record linkage for ARTIST-node identity, via Splink.
Version: SPLINK-ARTIST-IDENTITY-1.0

Emits a ranked CANDIDATE LIST. Writes nothing to the graph and merges nothing. Same
discipline as `find_artist_merge_candidates.py` and every prior artist pass: candidates go
to review, and the two false-positive traps that discipline exists for (Alexander Calder /
Alexander Milne Calder, Camille Pissarro / Orovida Camille Pissarro — both real, different,
related people) are the reason no threshold here is allowed to merge on its own.

WHY THIS AND NOT `find_artist_merge_candidates.py`. That script is five hand-written rules
(normalized_equal, honorific, initialism, typo, token_subset), each with a hand-set DINOv2
threshold, and it answers "does this pair match rule R". It cannot say which of two pairs
that both fire is the better candidate, and it cannot use birth year, death year,
nationality or ULAN at all — those fields are simply absent from it. Fellegi-Sunter turns
every field into evidence on one additive log2 scale, so the output is RANKED and every
rank is decomposable into which field paid for it.

THE FRAME DECIDES THE RESULT, and this frame is not the one Splink assumes. u is
"probability of agreement given non-match", and `estimate_u_using_random_sampling` draws
from the full 67M-pair cartesian, where two random artists share nothing. Predictions are
made only within surname / metaphone / token-bag blocks, so EVERY scored pair already
agrees on a surname-ish key. The consequence, stated plainly rather than left to be
discovered:

    ABSOLUTE MATCH PROBABILITIES ARE INFLATED AND SHOULD NOT BE READ AS PROBABILITIES.
    The surname term contributes a large, near-constant positive weight to every candidate
    because it is scored against a global u in which surname agreement is rare. Within the
    blocked frame it is worth almost nothing. It shifts the whole scale and barely moves
    the ORDER, which is what this output is for.

Read the ranking and the per-field waterfall. Do not read `match_probability`.

A SECOND CAVEAT WITH TEETH: Fellegi-Sunter assumes the comparisons are conditionally
independent given match status, and `name`, `surname` and `alt_overlap` plainly are not —
they are three views of the same string. Correlated evidence gets counted three times, which
inflates the spread between strong and weak candidates. Again this distorts the scale more
than the order, and again it is a reason the output is a queue for a human and not a
threshold anybody merges on.

WHAT `alt_overlap` IS AND WHY IT IS HALF-LEAKY. `alternateNames` holds the surface forms a
node has already absorbed, so it is partly the record of PAST merges — a feature that
partly encodes the prior output of the rules this model is meant to be independent of. It
is also, and mostly, ingest-native: sources emit "Trevelyan, Julian" and "Julian Trevelyan
R.A." for one node with no merge involved. Kept, because a variant one node already knows
about is real evidence about a second node carrying that variant as its canonical name, and
recorded here rather than left for someone to find in the weights.

Usage:
    python3 fit_splink_artist_identity.py artist_records.parquet --out candidates.csv
    python3 fit_splink_artist_identity.py artist_records.parquet --min-weight 8
"""
import argparse

import pandas as pd
import splink.comparison_level_library as cll
from splink import DuckDBAPI, Linker, SettingsCreator, block_on
from splink.comparison_library import CustomComparison

U_SAMPLE_PAIRS = 2_000_000     # u is an agreement RATE; the cartesian is 67M, this is 3%
DETERMINISTIC_RECALL = 0.5     # exact-normalisation equality finds about half the dupes

# Prediction frame. Surname carries the load; metaphone exists for the typo class
# ("Trevelyan"/"Treveyan") that no exact normalisation reaches; token_key for inverted and
# reordered forms; forename1+born for the case where the SURNAME is the corrupted field.
BLOCKING = [
    block_on("surname"),
    block_on("surname_mp"),
    block_on("token_key"),
    block_on("forename1", "born"),
]

# EM holds one side of the evidence fixed and learns m for the other. Two passes, in
# opposite directions, so neither the name comparisons nor the date comparisons are
# estimated from a block defined by themselves.
EM_RULES = [
    block_on("surname", "forename1"),   # name ~fixed  -> learns born / died / nationality
    block_on("born", "died"),           # dates fixed  -> learns the name comparisons
]


def settings():
    return SettingsCreator(
        link_type="dedupe_only",
        blocking_rules_to_generate_predictions=BLOCKING,
        comparisons=[
            CustomComparison(output_column_name="name", comparison_levels=[
                cll.NullLevel("norm"),
                cll.ExactMatchLevel("norm"),
                # word order and "Surname, Forename" inversion made invisible
                cll.CustomLevel("token_key_l = token_key_r", "same token bag"),
                # middle-name insertion: "Roberto Matta" c "Roberto Sebastian Matta".
                # ALSO the Calder / Milne Calder trap — fires on both, which is the point:
                # it is a candidate level, and the dates and images below have to settle it.
                cll.CustomLevel(
                    "list_has_all(tokens_l, tokens_r) OR list_has_all(tokens_r, tokens_l)",
                    "one token set contains the other"),
                cll.JaroWinklerLevel("norm", 0.94),
                cll.CustomLevel(
                    "damerau_levenshtein(norm_l, norm_r) <= 2 AND length(norm_l) >= 8",
                    "edit distance <= 2"),
                cll.JaroWinklerLevel("norm", 0.88),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="forenames", comparison_levels=[
                cll.NullLevel("forenames"),
                cll.ExactMatchLevel("forenames"),
                cll.CustomLevel("forename1_l = forename1_r AND forename1_l <> ''",
                                "first forename matches"),
                # THE ABBREVIATION CLASS, ADDED AFTER IT WAS MEASURED MISSING. The first fit
                # scored "Ed Ruscha" against "Edward Ruscha" at -17 — same surname, same
                # birth year, same nationality, and a name comparison that fell through to
                # "no agreement" because a truncated forename is neither an exact match nor a
                # single initial. It was one of only two same-ULAN pairs the model failed to
                # surface at any cutoff, so the gap is measured rather than supposed.
                cll.CustomLevel("initials_l = initials_r AND length(initials_l) >= 2",
                                "same initials throughout"),   # "R.B. Kitaj" c "Ronald Brooks Kitaj"
                cll.CustomLevel(
                    "forename1_l <> '' AND forename1_r <> '' AND forename1_l <> forename1_r AND "
                    "(starts_with(forename1_l, forename1_r) OR starts_with(forename1_r, forename1_l))",
                    "forename truncated"),                     # "Ed" c "Edward"
                # "F. Bartolozzi" c "Francesco Bartolozzi"
                cll.CustomLevel(
                    "(length(forename1_l) = 1 AND length(forename1_r) > 1 "
                    " AND forename1_l = substr(forename1_r, 1, 1)) OR "
                    "(length(forename1_r) = 1 AND length(forename1_l) > 1 "
                    " AND forename1_r = substr(forename1_l, 1, 1))",
                    "initial matches forename"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="born", comparison_levels=[
                cll.CustomLevel("born_l IS NULL OR born_r IS NULL", "missing")
                   .configure(is_null_level=True),
                cll.ExactMatchLevel("born"),
                # source birth years disagree by a year or two constantly; Felix Buhot is
                # in this graph as both 1847 and 1860 and is one man.
                cll.CustomLevel("abs(born_l - born_r) <= 2", "within 2 years"),
                cll.CustomLevel("abs(born_l - born_r) <= 10", "within 10 years"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="died", comparison_levels=[
                cll.CustomLevel("died_l IS NULL OR died_r IS NULL", "missing")
                   .configure(is_null_level=True),
                cll.ExactMatchLevel("died"),
                cll.CustomLevel("abs(died_l - died_r) <= 2", "within 2 years"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="nationality", comparison_levels=[
                cll.NullLevel("nationality"),
                cll.ExactMatchLevel("nationality"),
                cll.ElseLevel(),
            ]),
            CustomComparison(output_column_name="alt_overlap", comparison_levels=[
                cll.CustomLevel("len(alt_tokens_l) = 0 OR len(alt_tokens_r) = 0",
                                "no alternates").configure(is_null_level=True),
                cll.CustomLevel(
                    "list_has_all(alt_tokens_l, alt_tokens_r) OR "
                    "list_has_all(alt_tokens_r, alt_tokens_l)",
                    "one alternate set contains the other"),
                cll.CustomLevel("len(list_intersect(alt_tokens_l, alt_tokens_r)) >= 2",
                                ">=2 shared alternate tokens"),
                cll.ElseLevel(),
            ]),
            # NO `ulan` COMPARISON, and the reason changed once the data was looked at.
            # The intent was a veto: both sides resolved to different ULANs means different
            # people. THAT VETO WOULD HAVE BEEN WRONG ON ITS FIRST TWELVE PAIRS. `ulanUrl` is
            # stored in two forms by two resolvers (see `ulan_id` in the extractor), so
            # "different ULAN URL" was true of Pierre-Auguste Renoir against Auguste Renoir,
            # both 500115467. Compared on canonical ids the 12 become what they are —
            # deterministic duplicates needing no model at all.
            #
            # It stays out of the model for a different reason: same-id is near-deterministic
            # evidence and only 12 pairs carry it, which is too thin to estimate m from and
            # strong enough to swamp every other comparison if it were. It is reported as a
            # flag — `ulan_same_id` is a merge the graph can make on authority alone, and
            # `ulan_conflict` is a caution and NOT a veto, since it also fires on two people
            # who merely share a birth year.
        ],
        retain_intermediate_calculation_columns=True,
        retain_matching_columns=False,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("records")
    ap.add_argument("--out", default="artist_splink_candidates.csv")
    ap.add_argument("--min-weight", type=float, default=0.0)
    a = ap.parse_args()

    df = pd.read_parquet(a.records)
    print(f"{len(df):,} artist records")

    db_api = DuckDBAPI()
    linker = Linker(df, settings(), db_api=db_api)

    linker.training.estimate_probability_two_random_records_match(
        ["l.norm = r.norm"], recall=DETERMINISTIC_RECALL)
    linker.training.estimate_u_using_random_sampling(max_pairs=U_SAMPLE_PAIRS)
    for rule in EM_RULES:
        print(f"\n--- EM on {rule} ---")
        linker.training.estimate_parameters_using_expectation_maximisation(rule)

    pred = linker.inference.predict(threshold_match_weight=a.min_weight).as_pandas_dataframe()
    print(f"\n{len(pred):,} scored pairs at match_weight >= {a.min_weight}")

    keep = ["unique_id", "name", "born", "died", "nationality", "ulan", "ulan_id", "wikidata",
            "works", "embedded", "qualifier", "multi_artist", "sources"]
    out = (pred
           .merge(df[keep].add_suffix("_l"), left_on="unique_id_l", right_on="unique_id_l")
           .merge(df[keep].add_suffix("_r"), left_on="unique_id_r", right_on="unique_id_r"))

    # Reported, never applied — the same reason `generate_splink_merge_candidates.py` reports
    # its flags: a wrong veto silently removes a true pair from the only list anyone reads.
    out["ulan_same_id"] = (out.ulan_id_l.notna() & out.ulan_id_r.notna()
                           & (out.ulan_id_l == out.ulan_id_r))
    out["ulan_conflict"] = (out.ulan_id_l.notna() & out.ulan_id_r.notna()
                            & (out.ulan_id_l != out.ulan_id_r))
    out["qualifier_conflict"] = out.qualifier_l.fillna("") != out.qualifier_r.fillna("")
    out["multi_artist_flag"] = out.multi_artist_l | out.multi_artist_r
    out = out.sort_values("match_weight", ascending=False)
    out.to_csv(a.out, index=False)
    print(f"-> {a.out}")

    print("\nlearned weights (log2 Bayes factor per level)")
    linker.visualisations.match_weights_chart().save(a.out.replace(".csv", "_weights.html"))
    for c in linker.misc.save_model_to_json()["comparisons"]:
        print(f"\n  {c['output_column_name']}")
        for lv in c["comparison_levels"]:
            m, u = lv.get("m_probability"), lv.get("u_probability")
            if m and u:
                import math
                print(f"    {lv['label_for_charts']:38s} m={m:.4f} u={u:.4f} "
                      f"log2BF {math.log2(m/u):+6.2f}")
            else:
                print(f"    {lv['label_for_charts']:38s} (null / unestimated)")


if __name__ == "__main__":
    main()
