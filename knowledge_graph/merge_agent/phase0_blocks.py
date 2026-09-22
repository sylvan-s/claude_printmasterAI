"""
PrintMasterAI — merge-review agent, Phase 0: candidate-pool (blocking) recall and pool size.
Version: MERGE-AGENT-P0-BLOCKS-1.0

Design: docs/plans/2026-09-22-artist-merge-active-learning-agent.md, Phase 0.

QUESTION. The agent only ever scores pairs that some block lets into its pool, so a true
duplicate no block surfaces is invisible to it forever. How many of the Artist merges this graph
has already made would each block have found?

GROUND TRUTH. Artist MergeEvents (subject 'Artist'), excluding `survivorRenamed` (a rename,
not a pair of nodes). Each gives the absorbed name and the survivor's name at merge time
(`survivorNameAtMerge`, else the survivor's current name).

WHAT CAN AND CANNOT BE MEASURED AFTER THE FACT. A merge moves the absorbed node's works,
images and source records onto the survivor, and SourceRecords do not keep the raw artist
string, so the graph can no longer say which works were whose. So:
  measurable from the names alone   surname, initialism, and the five name rules
  measurable from dated snapshots   Splink pool (artist_splink_triage.csv, 2026-09-12) and
                                    the shared-image scan (artist_image_candidates.csv)
  NOT measurable post-merge         shared-work, alias-overlap (the merge itself wrote the
                                    absorbed name into the survivor's aliases)
The last two are reported as pool sizes on the live graph only.

    python3 merge_agent/phase0_blocks.py [--out-dir merge_agent/out]
"""
import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
import find_artist_merge_candidates as fam  # noqa: E402
from identity_candidates import connect, session  # noqa: E402

MAIN_KG = os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph")
SPLINK_TRIAGE = os.path.join(MAIN_KG, "artist_splink_triage.csv")
IMAGE_CANDIDATES = os.path.join(os.path.dirname(HERE), "artist_image_candidates.csv")

KNOWN = """
MATCH (e:MergeEvent {subject: 'Artist'})-[:MERGED_INTO]->(s:Artist)
WHERE e.rule <> 'survivorRenamed'
RETURN e.mergedFromName AS absorbed,
       CASE WHEN coalesce(e.survivorNameAtMerge, '') <> '' THEN e.survivorNameAtMerge
            ELSE s.name END AS survivor,
       s.name AS survivorNow, e.rule AS rule, e.decidedBy AS decidedBy,
       coalesce(e.backfilled, false) AS backfilled
"""


def stripped(name):
    return fam.strip_honorifics(fam.tokens(name))


def block_surname_last(a, b):
    ta, tb = stripped(a), stripped(b)
    return bool(ta and tb and ta[-1] == tb[-1] and not fam._is_placeholder(ta))


def block_surname_any(a, b):
    """The last token of either name appears anywhere in the other. Catches the inverted
    catalogue form ('MARCOUSSIS Louis') and 'X called Y' strings the strict block misses."""
    ta, tb = stripped(a), stripped(b)
    if not ta or not tb:
        return False
    return (len(ta[-1]) >= 3 and ta[-1] in tb) or (len(tb[-1]) >= 3 and tb[-1] in ta)


def block_squashed(a, b):
    """Equal once spaces are removed: 'MayaHayuk' vs 'Maya Hayuk' (a Roseberys spacing slip)."""
    x, y = fam.normalize(a).replace(" ", ""), fam.normalize(b).replace(" ", "")
    return len(x) >= 6 and x == y


def block_surname_edit1(a, b):
    """Surnames one edit apart (transposition counts as one) and the same forename initial:
    'Edouardo Poalozzi' vs 'Eduardo Paolozzi'. Neither strict surname nor typo sees it: typo
    blocks on an exact shared token and this pair shares none."""
    ta, tb = stripped(a), stripped(b)
    if len(ta) < 2 or len(tb) < 2 or fam._is_placeholder(ta) or fam._is_placeholder(tb):
        return False
    if min(len(ta[-1]), len(tb[-1])) < 5 or ta[0][0] != tb[0][0]:
        return False
    return fam.damerau_levenshtein(ta[-1], tb[-1], cap=2) == 1


def name_rules(a, b):
    """Which of find_artist_merge_candidates' generators fire on exactly this pair."""
    arts = [(a, fam.tokens(a)), (b, fam.tokens(b))]
    fired = set()
    for x, y, rule in (
            fam.gen_key_collisions(arts, lambda t: " ".join(t) if len(t) >= 2 else None,
                                   "normalized_equal")
            + fam.gen_key_collisions(arts, lambda t: " ".join(fam.strip_honorifics(t)),
                                     "honorific")
            + fam.gen_initialism(arts) + fam.gen_typo(arts)):
        fired.add(rule)
    ta, tb = arts[0][1], arts[1][1]
    for s, l in ((ta, tb), (tb, ta)):
        if len(s) >= 2 and len(s) + 1 == len(l) and s[-1] == l[-1] and all(t in l for t in s):
            fired.add("token_subset")
    return fired


def pair_set(path, col_a, col_b):
    out = set()
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            out.add(frozenset((r[col_a], r[col_b])))
    return out


# ------------------------------------------------------------------------------ live pool size

SHARED_WORK = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)<-[:CREATED]-(b:Artist)
WHERE elementId(a) < elementId(b)
RETURN count(DISTINCT [elementId(a), elementId(b)]) AS pairs
"""
SHARED_SOURCE = """
MATCH (a:Artist)<-[:ATTRIBUTED_TO]-(s:SourceRecord)-[:ATTRIBUTED_TO]->(b:Artist)
WHERE elementId(a) < elementId(b)
RETURN count(DISTINCT [elementId(a), elementId(b)]) AS pairs
"""
ALIAS = """
MATCH (a:Artist) WHERE size(coalesce(a.alternateNames, [])) > 0
UNWIND a.alternateNames AS alt
WITH a, alt WHERE alt <> a.name
MATCH (b:Artist {name: alt}) WHERE b <> a
RETURN count(*) AS pairs
"""
ALL = "MATCH (a:Artist) RETURN a.name AS name"


def live_pool(s):
    names = [r["name"] for r in s.run(ALL) if r["name"]]
    arts = [(n, fam.tokens(n)) for n in names]
    last = defaultdict(int)
    for n, _ in arts:
        t = stripped(n)
        if t and not fam._is_placeholder(t):
            last[t[-1]] += 1
    surname_pairs = sum(k * (k - 1) // 2 for k in last.values())
    biggest = sorted(last.items(), key=lambda kv: -kv[1])[:8]
    rule_pairs = Counter()
    raw = (fam.gen_key_collisions(arts, lambda t: " ".join(t) if len(t) >= 2 else None,
                                  "normalized_equal")
           + fam.gen_key_collisions(arts, lambda t: " ".join(fam.strip_honorifics(t)),
                                    "honorific")
           + fam.gen_initialism(arts) + fam.gen_typo(arts))
    seen = set()
    for a, b, rule in raw:
        k = frozenset((a, b))
        if a != b and k not in seen:
            seen.add(k)
            rule_pairs[rule] += 1
    squash = defaultdict(int)
    for n, _ in arts:
        k = fam.normalize(n).replace(" ", "")
        if len(k) >= 6:
            squash[k] += 1
    squashed_pairs = sum(k * (k - 1) // 2 for k in squash.values())
    by_initial = defaultdict(list)
    for n, _ in arts:
        t = stripped(n)
        if len(t) >= 2 and not fam._is_placeholder(t) and len(t[-1]) >= 5:
            by_initial[(t[0][0], len(t[-1]))].append(t[-1])
    edit1 = 0
    for (ini, ln), sn in by_initial.items():
        pool_n = sn + by_initial.get((ini, ln + 1), [])
        uniq = sorted(set(sn))
        others = sorted(set(pool_n))
        for i, x in enumerate(uniq):
            for y in others:
                if y > x and fam.damerau_levenshtein(x, y, cap=2) == 1:
                    edit1 += sn.count(x) * pool_n.count(y)
    return {
        "squashedPairs": squashed_pairs,
        "surnameEdit1Pairs": edit1,
        "artists": len(names),
        "allPairs": len(names) * (len(names) - 1) // 2,
        "surnameLastPairs": surname_pairs,
        "largestSurnameBlocks": biggest,
        "nameRulePairs": dict(rule_pairs),
        "sharedWorkPairs": s.run(SHARED_WORK).single()["pairs"],
        "sharedSourceRecordPairs": s.run(SHARED_SOURCE).single()["pairs"],
        "aliasOverlapPairs": s.run(ALIAS).single()["pairs"],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--out-dir", default=os.path.join(HERE, "out"))
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    splink = pair_set(SPLINK_TRIAGE, "name_l", "name_r")
    image = pair_set(IMAGE_CANDIDATES, "artistA", "artistB")

    drv = connect()
    with session(drv) as s:
        known = [dict(r) for r in s.run(KNOWN)]
        pool = live_pool(s)
    drv.close()

    rows = []
    for k in known:
        a, b = k["absorbed"], k["survivor"]
        if a == b:
            continue
        rules = name_rules(a, b)
        pair = frozenset((a, b))
        row = {**k,
               "surnameLast": block_surname_last(a, b),
               "surnameAny": block_surname_any(a, b),
               "nameRules": "+".join(sorted(rules)),
               "splinkPool0912": pair in splink,
               "imageScan": pair in image}
        row["squashed"] = block_squashed(a, b)
        row["surnameEdit1"] = block_surname_edit1(a, b)
        row["anyNameBlock"] = (row["surnameAny"] or bool(rules) or row["squashed"]
                               or row["surnameEdit1"])
        row["anyBlock"] = row["anyNameBlock"] or row["splinkPool0912"] or row["imageScan"]
        rows.append(row)

    n = len(rows)
    def rate(key, subset=None):
        sub = rows if subset is None else [r for r in rows if subset(r)]
        hit = sum(bool(r[key]) for r in sub)
        return hit, len(sub)

    print(f"known Artist merges (pairs of two names): {n}\n")
    print("recall per block")
    for key, label in (("surnameLast", "surname (last token, strict)"),
                       ("surnameAny", "surname (either last token in the other)"),
                       ("nameRules", "any of the five name rules"),
                       ("splinkPool0912", "Splink pool, 2026-09-12 snapshot"),
                       ("imageScan", "shared-image scan"),
                       ("squashed", "joined-words (spaces removed)"),
                       ("surnameEdit1", "surname one edit apart, same initial"),
                       ("anyNameBlock", "UNION of name blocks"),
                       ("anyBlock", "UNION of everything measurable")):
        h, t = rate(key)
        print(f"   {label:44s} {h:4d}/{t:<4d} {h / t:6.1%}")

    print("\nunion recall by how the merge was decided")
    for by in sorted({r["decidedBy"] for r in rows}):
        h, t = rate("anyBlock", lambda r, by=by: r["decidedBy"] == by)
        hn, _ = rate("anyNameBlock", lambda r, by=by: r["decidedBy"] == by)
        print(f"   {by:8s} any {h:4d}/{t:<4d} {h / t:6.1%}   names only {hn / t:6.1%}")

    print("\nname rules firing on known merges")
    c = Counter(x for r in rows for x in (r["nameRules"].split("+") if r["nameRules"] else []))
    for k, v in c.most_common():
        print(f"   {k:20s} {v}")

    misses = [r for r in rows if not r["anyBlock"]]
    print(f"\nmissed by every measurable block: {len(misses)}")
    for r in misses[:25]:
        print(f"   [{r['rule']}] {r['absorbed'][:44]!r} -> {r['survivor'][:40]!r}")

    print("\nlive candidate pool (sizes, not recall)")
    for k, v in pool.items():
        print(f"   {k:24s} {v}")

    with open(os.path.join(args.out_dir, "phase0_block_recall.csv"), "w", newline="",
              encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(args.out_dir, "phase0_live_pool.json"), "w") as fh:
        json.dump(pool, fh, indent=1)
    print(f"\n-> {args.out_dir}/phase0_block_recall.csv, phase0_live_pool.json")


if __name__ == "__main__":
    main()
