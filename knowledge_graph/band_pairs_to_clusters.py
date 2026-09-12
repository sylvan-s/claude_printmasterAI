"""
PrintMasterAI — turn a scored PAIR list into merge clusters.
Version: BAND-TO-CLUSTERS-1.0

`rank_title_collisions.py` emits PAIRS; `merge_duplicate_work_clusters.py` consumes CLUSTERS.
This is the join between them, and it is not a reshape — three things have to be decided that
neither script can decide alone.

1. ONLY NODES ACTUALLY LINKED BY A SCORED PAIR MAY FOLD.

   A collision of four works produces up to six pairs, and the band may contain only two of
   them. Folding the whole collision would merge works that were never compared. So members are
   grouped by UNION-FIND over the band pairs: two disjoint pairs inside one collision become two
   clusters, not one. On the first live run, 362 clusters came out of 735 pairs and 278 of them
   were simple pairs.

   Chaining is still possible WITHIN a collision — a node in two band pairs joins them — and that
   is intended here, because every pair in a collision shares an artist and a folded title.
   Chaining ACROSS collisions cannot happen: `rank_title_collisions` blocks predictions on the
   collision key, so no pair ever spans two.

2. A VISUAL VERDICT OVERRIDES THE RULE.

   Any pair a run of `adjudicate_merge_candidates.py` returned DIFFERENT_WORK for is dropped,
   whatever its weight and whatever the catalogue says. The John Piper "Carew Castle" pair is why:
   two entirely different prints under one title and one Levinson number, so the catalogue itself
   was the error and only the picture caught it. Verdict files are read from `--verdicts`.

3. A PAIR NAMING A DELETED NODE IS DROPPED, NOT RESOLVED.

   A band generated before an earlier merge will reference works that no longer exist — 91 of 830
   on the first run. `MergeEvent.mergedFromId` could resolve them, but a pair whose endpoint has
   already been folded elsewhere was scored against a node that no longer means what it did, and
   re-deriving it is a judgement this script should not make silently.

Usage:
    python3 band_pairs_to_clusters.py --pairs band.csv --out clusters.json \
        --verdicts verdicts1.csv:pairs1.csv --verdicts verdicts2.csv:pairs2.csv
    python3 merge_duplicate_work_clusters.py --json clusters.json --rule titleCollisionBand
"""

import argparse
import csv
import json
import os
from collections import defaultdict

from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


def load_rejections(specs):
    """Pairs a visual check returned DIFFERENT_WORK for. Each spec is `verdicts.csv:pairs.csv` —
    the verdict file carries a rank, the pairs file carries the work ids for that rank."""
    rejected = set()
    for spec in specs or []:
        verdicts, pairs = spec.split(":", 1)
        by_rank = {r["rank"]: r for r in csv.DictReader(open(pairs, encoding="utf-8"))}
        for row in csv.DictReader(open(verdicts, encoding="utf-8")):
            if row.get("verdict") == "DIFFERENT_WORK" and row["rank"] in by_rank:
                q = by_rank[row["rank"]]
                rejected.add(tuple(sorted((q["workA"], q["workB"]))))
    return rejected


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--out", default="band_clusters.json")
    ap.add_argument("--verdicts", action="append",
                    help="verdicts.csv:pairs.csv — repeatable; DIFFERENT_WORK rows are dropped")
    args = ap.parse_args()

    band = list(csv.DictReader(open(args.pairs, encoding="utf-8")))
    rejected = load_rejections(args.verdicts)
    print(f"{len(band)} pairs; {len(rejected)} rejected by a visual check")

    ids = sorted({r[k] for r in band for k in ("workA", "workB")})
    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            alive = {r["id"] for r in session.run(
                "MATCH (w:ConceptualWork) WHERE w.id IN $ids RETURN w.id AS id", ids=ids)}
    finally:
        driver.close()

    uf, meta = UnionFind(), {}
    kept = stale = vetoed = 0
    for r in band:
        a, b = r["workA"], r["workB"]
        if a not in alive or b not in alive:
            stale += 1
            continue
        if tuple(sorted((a, b))) in rejected:
            vetoed += 1
            continue
        uf.union(a, b)
        kept += 1
        meta[a] = meta[b] = {"artist": r["artist"], "title": r["titleA"],
                             "year": r.get("yearA") or None,
                             "weight": r.get("matchWeight", ""),
                             "cat": r.get("catalogueVerdict", "")}

    components = defaultdict(list)
    for node in list(uf.parent):
        components[uf.find(node)].append(node)

    clusters = []
    for members in components.values():
        if len(members) < 2:
            continue
        m = meta[members[0]]
        clusters.append({
            "artist": m["artist"], "title": m["title"],
            "year": int(m["year"]) if str(m["year"]).isdigit() else None,
            "workIds": sorted(members), "size": len(members),
            "corroborator": f"splink band: weight >= 15, catalogue {m['cat']}",
            "matchWeight": m["weight"],
        })
    clusters.sort(key=lambda c: (-c["size"], c["artist"]))
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"proposed": clusters}, fh, indent=1, ensure_ascii=False)

    pairs_only = sum(1 for c in clusters if c["size"] == 2)
    print(f"  {kept} kept, {stale} dropped as stale, {vetoed} dropped by a visual verdict")
    print(f"  -> {len(clusters)} clusters, {sum(c['size'] for c in clusters)} nodes, "
          f"{sum(c['size'] - 1 for c in clusters)} surplus  ({pairs_only} are simple pairs)")
    print(f"  wrote {args.out}")


if __name__ == "__main__":
    main()
