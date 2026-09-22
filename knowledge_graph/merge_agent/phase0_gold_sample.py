"""
PrintMasterAI — merge-review agent, Phase 0: draw the gold set.
Version: MERGE-AGENT-P0-GOLD-1.0

The gold set is the only set whose numbers get quoted: a person labels it once, it is never
trained on, and it calibrates the LLM labeller per stratum. See the design doc, Phase 0.

POOL. The union of the blocks phase0_blocks.py measured (99.3% recall on 283 known merges):
same stripped surname, the five name rules, joined-words, surname one edit apart with the same
initial, and shared work (both nodes CREATED one ConceptualWork). Pairs with a REJECTED
POSSIBLE_SAME_AS edge are excluded: they are seed labels, and a gold pair must never also be
a training pair. Open edges stay in: they are exactly the undecided middle.

STRATA. The LLM is calibrated per stratum, so the strata are the ones where its behaviour is
expected to differ:
  name level   strong  exact after normalisation, same token bag, joined-words
               subset  one name's tokens inside the other's
               fuzzy   Jaro-Winkler / edit distance / one-letter surname slip / initialism
               weak    only the surname agrees (or only a shared work)
  trap         yes if either name is a collaboration string, an 'after/school/follower/
               workshop/manner of' attribution or a placeholder, or the pair shares a surname
               with birth years more than 15 apart (the Calder / Piranesi / Pissarro shape)
8 strata; the middle strata (subset, fuzzy) get most of the 150, since that is where
the LLM's reliability is in doubt. `weak/no-trap` is almost all obvious non-matches; it is
kept so the gold set measures false positives where they are cheapest to make.

House mix and shared-work are recorded and reported, not stratified on.

    python3 merge_agent/phase0_gold_sample.py [--n 150] [--seed 20260922]
"""
import argparse
import json
import os
import random
import re
import sqlite3
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
import find_artist_merge_candidates as fam  # noqa: E402
import jellyfish  # noqa: E402
from identity_candidates import connect, session  # noqa: E402
from phase0_blocks import (block_squashed, block_surname_edit1, name_rules,  # noqa: E402
                           stripped)

ULAN_DB = os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph/ulan_local.sqlite")

ARTISTS = """
MATCH (a:Artist)
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
WITH a, count(DISTINCT w) AS works, collect(DISTINCT w.name)[..6] AS titles
OPTIONAL MATCH (s:SourceRecord)-[:ATTRIBUTED_TO]->(a)
WITH a, works, titles, collect(DISTINCT split(s.id, '-')[0]) AS houses
RETURN a.name AS name, a.dateBorn_year AS born, a.dateDied_year AS died,
       a.nationality AS nat, a.ulanUrl AS ulan, a.wikidataUrl AS wikidata,
       coalesce(a.alternateNames, [])[..6] AS alts, works, titles, houses
"""
SHARED_WORK = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)<-[:CREATED]-(b:Artist)
WHERE a.name < b.name
RETURN a.name AS a, b.name AS b, count(DISTINCT w) AS n, collect(DISTINCT w.name)[..3] AS titles
"""
EDGES = """
MATCH (x:Artist)-[p:POSSIBLE_SAME_AS]-(y:Artist) WHERE x.name < y.name
RETURN x.name AS a, y.name AS b, p.status AS status
"""

COLLAB = re.compile(r"(\s&\s|\sand\s|\swith\s|\set\s|\+)", re.I)
ATTRIB = re.compile(r"\b(after|school of|follower of|workshop|manner of|circle of|studio of|attributed to)\b", re.I)


def trap(a, b, ra, rb):
    for n in (a, b):
        if COLLAB.search(f" {n} ") or ATTRIB.search(n) or fam._is_placeholder(fam.tokens(n)):
            return True
    ta, tb = stripped(a), stripped(b)
    if ta and tb and ta[-1] == tb[-1] and ra.get("born") and rb.get("born"):
        if abs(ra["born"] - rb["born"]) > 15:
            return True
    return False


def name_level(a, b):
    na, nb = fam.normalize(a), fam.normalize(b)
    ta, tb = fam.tokens(a), fam.tokens(b)
    if na == nb or sorted(ta) == sorted(tb) or block_squashed(a, b):
        return "strong"
    if set(ta) <= set(tb) or set(tb) <= set(ta):
        return "subset"
    rules = name_rules(a, b)
    if ("typo" in rules or "initialism" in rules or block_surname_edit1(a, b)
            or jellyfish.jaro_winkler_similarity(na, nb) >= 0.88):
        return "fuzzy"
    return "weak"


def ulan_bio(con, url):
    if not url:
        return None
    uid = url.rstrip("/").split("/")[-1]
    r = con.execute("SELECT pref_name, bio FROM ulan_person WHERE ulan_id = ?", (uid,)).fetchone()
    return f"{r[0]}: {r[1]}" if r else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--seed", type=int, default=20260922)
    ap.add_argument("--out", default=os.path.join(HERE, "out", "gold_sample.json"))
    args = ap.parse_args()

    drv = connect()
    with session(drv) as s:
        rec = {r["name"]: dict(r) for r in s.run(ARTISTS) if r["name"]}
        shared = {frozenset((r["a"], r["b"])): r for r in s.run(SHARED_WORK)}
        edges = {frozenset((r["a"], r["b"])): r["status"] for r in s.run(EDGES)}
    drv.close()
    names = sorted(rec)
    print(f"{len(names):,} artists; {len(shared):,} shared-work pairs; {len(edges)} candidate edges")

    # --- pool: union of blocks
    pool = set(shared)
    by_last = defaultdict(list)
    for n in names:
        t = stripped(n)
        if t and not fam._is_placeholder(t):
            by_last[t[-1]].append(n)
    for members in by_last.values():
        if len(members) > 60:          # 'school', 'smith' ... still sampled, just capped
            members = members[:60]
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                pool.add(frozenset((members[i], members[j])))
    arts = [(n, fam.tokens(n)) for n in names]
    for a, b, _ in (fam.gen_key_collisions(arts, lambda t: " ".join(t) if len(t) >= 2 else None, "x")
                    + fam.gen_key_collisions(arts, lambda t: " ".join(fam.strip_honorifics(t)), "x")
                    + fam.gen_initialism(arts) + fam.gen_typo(arts)):
        if a != b:
            pool.add(frozenset((a, b)))
    squash = defaultdict(list)
    for n in names:
        k = fam.normalize(n).replace(" ", "")
        if len(k) >= 6:
            squash[k].append(n)
    for m in squash.values():
        for i in range(len(m)):
            for j in range(i + 1, len(m)):
                pool.add(frozenset((m[i], m[j])))
    by_ini = defaultdict(list)
    for n in names:
        t = stripped(n)
        if len(t) >= 2 and not fam._is_placeholder(t) and len(t[-1]) >= 5:
            by_ini[t[0][0]].append(n)
    for m in by_ini.values():
        surn = defaultdict(list)
        for n in m:
            surn[stripped(n)[-1]].append(n)
        keys = sorted(surn)
        for i, x in enumerate(keys):
            for y in keys[i + 1:]:
                if abs(len(x) - len(y)) <= 1 and fam.damerau_levenshtein(x, y, cap=2) == 1:
                    for na in surn[x]:
                        for nb in surn[y]:
                            pool.add(frozenset((na, nb)))

    rejected = {k for k, v in edges.items() if v == "rejected"}
    pool = {p for p in pool if len(p) == 2 and p not in rejected}
    print(f"candidate pool: {len(pool):,} pairs ({len(rejected)} rejected pairs excluded)")

    # --- strata
    strata = defaultdict(list)
    for p in pool:
        a, b = sorted(p)
        lvl = name_level(a, b)
        t = trap(a, b, rec[a], rec[b])
        strata[(lvl, "trap" if t else "clean")].append((a, b))
    print("\npool by stratum:")
    for k in sorted(strata):
        print(f"   {k[0]:7s} {k[1]:6s} {len(strata[k]):6,}")

    for k in strata:                 # set order varies with string hashing; sort for a
        strata[k].sort()             # draw that the seed actually reproduces
    rng = random.Random(args.seed)
    # Where the LLM's behaviour is uncertain gets the samples: the middle strata (subset,
    # fuzzy) over the extremes. `strong/trap` holds almost nothing, and whatever a small
    # stratum cannot fill goes to the middle, not to the 8,000 surname-only pairs.
    alloc = {("strong", "clean"): 20, ("strong", "trap"): 5, ("subset", "clean"): 22,
             ("subset", "trap"): 22, ("fuzzy", "clean"): 24, ("fuzzy", "trap"): 22,
             ("weak", "clean"): 18, ("weak", "trap"): 17}
    scale = args.n / sum(alloc.values())
    picked, short = [], 0
    for k in sorted(alloc):
        want = round(alloc[k] * scale)
        take = min(want, len(strata.get(k, [])))
        short += want - take
        picked += [(k, p) for p in rng.sample(strata.get(k, []), take)]
    chosen = {p for _, p in picked}
    for k in [("fuzzy", "clean"), ("subset", "clean"), ("subset", "trap"), ("fuzzy", "trap")]:
        rest = [p for p in strata.get(k, []) if p not in chosen]
        extra = rng.sample(rest, min(short, len(rest)))
        picked += [(k, p) for p in extra]
        chosen.update(extra)
        short -= len(extra)
    rng.shuffle(picked)

    con = sqlite3.connect(ULAN_DB)
    out = []
    for i, ((lvl, tr), (a, b)) in enumerate(picked, 1):
        def side(n):
            d = {k: rec[n][k] for k in ("name", "born", "died", "nat", "ulan", "wikidata",
                                        "alts", "works", "titles", "houses")}
            d["ulanBio"] = ulan_bio(con, rec[n]["ulan"])
            return d
        sw = shared.get(frozenset((a, b)))
        out.append({"id": f"g{i:03d}", "stratum": f"{lvl}/{tr}", "a": side(a), "b": side(b),
                    "sharedWorks": sw["n"] if sw else 0,
                    "sharedTitles": sw["titles"] if sw else [],
                    "openEdge": edges.get(frozenset((a, b))) == "open"})
    con.close()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({"version": "MERGE-AGENT-P0-GOLD-1.0", "seed": args.seed, "poolSize": len(pool),
               "strata": {f"{k[0]}/{k[1]}": len(v) for k, v in strata.items()}, "pairs": out},
              open(args.out, "w"), indent=1, default=str)
    c = Counter(p["stratum"] for p in out)
    print(f"\ngold sample: {len(out)} pairs -> {args.out}")
    for k in sorted(c):
        print(f"   {k:14s} {c[k]}")
    print(f"   with a shared work: {sum(p['sharedWorks'] > 0 for p in out)}   "
          f"already an open edge: {sum(p['openEdge'] for p in out)}")


if __name__ == "__main__":
    main()
