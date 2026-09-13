"""
PrintMasterAI — triage of Splink artist candidates into review buckets.
Version: ARTIST-SPLINK-TRIAGE-1.0

Sorts scored pairs into what a reviewer should do with them. Merges nothing.

The bands are ORDERED BY HOW MUCH JUDGEMENT THEY NEED, not by match weight, because the
two come apart at both ends. `Wilfredo Lam` against `Wifredo Lam` scores 7.3 — a one-letter
name difference the model cannot distinguish from a genuine near-miss — and is nevertheless
certain, because both nodes carry Getty 500006317. `School of William Scott` against
`William Scott` scores 36.0 and must never merge. Weight alone would invert both.
"""
import argparse
import numpy as np
import pandas as pd

NAME_LEVELS = {15.6: "exact after normalisation", 14.2: "same token bag",
               13.5: "Jaro-Winkler >=0.94", 13.3: "edit distance <=2",
               8.9: "one token set contains other", 8.6: "Jaro-Winkler >=0.88",
               -3.9: "no name agreement"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scored")
    ap.add_argument("--out", required=True)
    ap.add_argument("--records", required=True,
                    help="artist_records.parquet, for the flags the model does not score")
    a = ap.parse_args()
    d = pd.read_csv(a.scored)
    rec = pd.read_parquet(a.records)[["unique_id", "has_conjunction", "is_placeholder"]]
    for side in ("l", "r"):
        d = d.merge(rec.add_suffix(f"_{side}"), left_on=f"unique_id_{side}",
                    right_on=f"unique_id_{side}", how="left")
    # Exactly one side carries a conjunction, and the other is contained in it.
    d["collaboration_conflict"] = (d.has_conjunction_l ^ d.has_conjunction_r)
    d["placeholder_flag"] = d.is_placeholder_l | d.is_placeholder_r
    d["name_level"] = np.log2(d.bf_name).map(
        lambda w: NAME_LEVELS[min(NAME_LEVELS, key=lambda k: abs(k - w))])

    # A qualifier disagreement is the only hard stop. "After"/"School of"/"Style of" is a
    # disclaimer of authorship, so the pair is two different things however the name reads.
    stop = d.qualifier_conflict
    # A trailing "&" is a multi-artist lot header the parser left behind. NOT a merge and NOT
    # a non-merge: the node's works may belong to either artist named in the lot, so the
    # question is which works are misattributed, not which node survives.
    artifact = d.multi_artist_flag & ~stop

    d["band"] = "D weak — below review"
    d.loc[d.match_weight >= 0, "band"] = "C review — judgement needed"
    d.loc[d.match_weight >= 20, "band"] = "B strong — name and dates agree"
    d.loc[(d.name_level == "exact after normalisation") & (d.match_weight >= 20),
          "band"] = "B strong — name and dates agree"
    d.loc[d.collaboration_conflict, "band"] = "X collaboration node — DO NOT MERGE"
    d.loc[d.placeholder_flag, "band"] = "X placeholder node — not an artist"
    d.loc[artifact, "band"] = "X parser artifact — investigate, do not merge"
    d.loc[stop, "band"] = "X attribution qualifier — DO NOT MERGE"
    # Last, so nothing overwrites it: Getty authority settles identity by itself.
    d.loc[d.ulan_same_id & ~stop & ~artifact & ~d.collaboration_conflict
          & ~d.placeholder_flag, "band"] = "A deterministic — same Getty ULAN id"

    d = d.sort_values(["band", "match_weight"], ascending=[True, False])
    cols = ["band", "match_weight", "name_level", "dino_max", "nA", "nB",
            "name_l", "born_l", "died_l", "works_l", "ulan_id_l",
            "name_r", "born_r", "died_r", "works_r", "ulan_id_r",
            "ulan_same_id", "ulan_conflict", "qualifier_conflict", "multi_artist_flag",
            "collaboration_conflict", "placeholder_flag",
            "bf_name", "bf_forenames", "bf_born", "bf_died", "bf_nationality",
            "bf_alt_overlap", "unique_id_l", "unique_id_r"]
    d[[c for c in cols if c in d.columns]].to_csv(a.out, index=False)

    print(f"{len(d):,} pairs -> {a.out}\n")
    g = d.groupby("band").agg(pairs=("match_weight", "size"),
                              median_weight=("match_weight", "median"),
                              median_dino=("dino_max", "median"))
    print(g.to_string(float_format=lambda x: f"{x:.2f}"))
    print("\nworks at stake (sum of the smaller side of each pair, "
          "i.e. edges that would move on merge):")
    for band, sub in d.groupby("band"):
        print(f"  {band:46s} {int(np.minimum(sub.works_l, sub.works_r).sum()):6,d}")


if __name__ == "__main__":
    main()
