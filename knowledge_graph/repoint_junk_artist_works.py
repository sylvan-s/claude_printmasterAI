"""
PrintMasterAI — works stranded on Artist nodes that are not artists.
Version: JUNK-ARTIST-REPOINT-1.0

    python3 repoint_junk_artist_works.py --out junk_artist_repoint.csv
    python3 repoint_junk_artist_works.py --out ... --apply

Auction cataloguing writes bookkeeping lines into the artist field, and the ingest made each one
an Artist. 89 such nodes hold 153 works between them on 2026-09-13 — `RTO David Hockney`
(returned to owner), `Property of a KAWS collector`, `MOVED TO RECEIPT LINE 161105-1 - Sir Frank
Bowling`, and forty-odd `AMENDMENT: ...` notes. The works are real; their artist is not.

THIS IS NOT A MERGE, which is why it is not in `merge_artists.py`. Folding `RTO David Hockney`
into David Hockney would add that string to his `alternateNames` and assert it is a name he goes
by. The node has to be DELETED and its works re-pointed.

`Various Artists` IS EXCLUDED AND MUST STAY. Its 75 works are genuine multi-artist portfolios —
`American Abstract Artists 50th Anniversary Print Portfolio`, `Artist's Choice Portfolio`, `Bugs:
a portfolio` — and every one of them has no other artist. Deleting it orphans 75 works. It is a
modelling question, not junk.

THREE KINDS OF EVIDENCE, and only the first two are used without a person looking:

  source    the work's own SourceRecord already ATTRIBUTED_TO exactly one real artist alongside
            the junk string. No inference at all; the ingest recorded both.
  embedded  a real Artist's name or alternateName appears inside the junk node's name. Matched
            against alternateNames too, because the surface form in the junk string may itself
            have been merged away — `PROPERTY FROM ESTATES OF L.S. LOWRY AND LATE CAROL ANN
            LOWRY` stopped matching any node the moment `L.S. Lowry` folded into `Laurence
            Stephen Lowry`.
  image     the work's nearest DINOv2 neighbour above the threshold belongs to exactly one real
            artist. REVIEW ONLY — never applied. `Property of an Urban Art Collector` holds 19
            works by several different hands and no rule can tell which is which.

A candidate target must be a real person in this graph: not junk-shaped itself, and carrying
either a ULAN or more than one work. Without that filter `Please note` — an Artist node with two
works — is matched as the artist of half the AMENDMENT lines.
"""

import argparse
import csv
import os
import re
import sys

from neo4j import GraphDatabase

JUNK_PATTERN = (
    "(?i)^(property\\b|moved to|amendment|rto\\b|the property|lots?\\s*\\d|client has paid|"
    "\\*\\*\\*|t\\.ob|a small collection|a collection of|old master print|artists various).*"
    "|(?i).*(receipt line|collection of|estates? of).*")
NOT_A_TARGET = re.compile(
    r"(?i)property|amendment|\brto\b|various|collection|receipt|moved to|please note|"
    r"this lot|^lots?\b|client has|^\*\*\*|to be authenticated|t\.ob")

WORKS = """
MATCH (junk:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE junk.name =~ $p AND junk.name <> 'Various Artists'
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (src)-[:ATTRIBUTED_TO]->(sa:Artist) WHERE NOT sa.name =~ $p
OPTIONAL MATCH (co:Artist)-[:CREATED]->(w) WHERE co.name <> junk.name AND NOT co.name =~ $p
RETURN junk.name AS junk, w.id AS workId, w.name AS title,
       collect(DISTINCT sa.name) + collect(DISTINCT co.name) AS named
"""

TARGETS = """
MATCH (a:Artist)
RETURN a.name AS name, coalesce(a.alternateNames, []) AS alts,
       a.ulanUrl IS NOT NULL AS ulan,
       count { (a)-[:CREATED]->(:ConceptualWork) } AS works
"""

NEIGHBOUR = """
MATCH (w:ConceptualWork {id: $workId})-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
MATCH (img:DigitalImage)-[:SHOWS]->(i) WHERE img.embedding IS NOT NULL
CALL db.index.vector.queryNodes('digitalImageDinov2Embedding', 5, img.embedding)
YIELD node AS nb, score
WITH w, nb, 2 * score - 1 AS cos WHERE cos >= $mincos
MATCH (nb)-[:SHOWS]->(:Impression)<-[:INCLUDES]-(:EditionRun)<-[:PRINTED_AS]-(o:ConceptualWork)
MATCH (a:Artist)-[:CREATED]->(o) WHERE o.id <> w.id AND NOT a.name =~ $p
RETURN a.name AS name, max(cos) AS cos ORDER BY cos DESC LIMIT 2
"""

# CREATED is re-pointed and ATTRIBUTED_TO carried over, because the junk node is deleted and an
# edge left on it dies with it. MERGE, not CREATE: the target may already hold both.
REPOINT = """
MATCH (junk:Artist {name: $junk})-[old:CREATED]->(w:ConceptualWork {id: $workId})
MATCH (target:Artist {name: $target})
MERGE (target)-[:CREATED]->(w)
DELETE old
WITH junk, w, target
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(:Impression)<-[:INCLUDES]-(:EditionRun)<-[:PRINTED_AS]-(w)
OPTIONAL MATCH (src)-[att:ATTRIBUTED_TO]->(junk)
FOREACH (x IN CASE WHEN att IS NULL THEN [] ELSE [src] END |
         MERGE (x)-[n:ATTRIBUTED_TO]->(target) SET n.qualifier = coalesce(att.qualifier, 'direct')
         DELETE att)
RETURN count(*) AS n
"""

DELETE_EMPTY = """
MATCH (junk:Artist {name: $junk})
WHERE NOT (junk)-[:CREATED]->(:ConceptualWork)
  AND NOT (junk)-[:MADE_MATRIX]->() AND NOT (junk)-[:CATALOGUES]->()
DETACH DELETE junk RETURN count(*) AS n
"""


def _flat(text):
    """Punctuation folded to single spaces. `RTO Jean Paul Riopelle` has to reach
    `Jean-Paul Riopelle`: without this the hyphen blocks the match, and the longest form that
    DOES match is the bare forename node `Jean` (12 works), which is a different person
    entirely. Found in the first dry run, not anticipated."""
    return " " + re.sub(r"\s+", " ", re.sub(r"[^0-9a-z]+", " ", (text or "").lower())).strip() + " "


def build_index(rows):
    """Surface forms that may stand for a real artist: the node name and every alternateName."""
    index = []
    for a in rows:
        if NOT_A_TARGET.search(a["name"]) or not (a["ulan"] or a["works"] > 1):
            continue
        for form in {a["name"], *a["alts"]}:
            form = (form or "").strip()
            flat = _flat(form).strip()
            # A MONONYM MUST EARN IT. `Jean` and `Hans` are both Artist nodes here with a dozen
            # works each, and either will swallow any longer name containing it. A single-token
            # form is only usable when it is distinctive — five characters and a Getty record.
            if len(flat) < 4 or (len(flat.split()) == 1 and (len(flat) < 5 or not a["ulan"])):
                continue
            index.append((form, flat, a["name"], len(flat)))
    index.sort(key=lambda t: -t[3])
    return index


def embedded_target(junk, index):
    flat_junk = _flat(junk)
    for form, flat, canonical, _ in index:
        if f" {flat} " in flat_junk:
            return canonical, form
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--out", default="junk_artist_repoint.csv")
    ap.add_argument("--min-cos", type=float, default=0.93)
    ap.add_argument("--apply", action="store_true",
                    help="re-point the `source` and `embedded` rows and delete emptied nodes; "
                         "`image` rows are never applied")
    args = ap.parse_args()
    for v in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE"):
        if not os.environ.get(v):
            sys.exit(f"{v} is not set. Source .env first.")
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"],
                               auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    try:
        with drv.session(database=os.environ["NEO4J_DATABASE"]) as s:
            works = [dict(r) for r in s.run(WORKS, p=JUNK_PATTERN)]
            index = build_index([dict(r) for r in s.run(TARGETS)])
            print(f"{len(works)} works on {len({w['junk'] for w in works})} non-artist nodes; "
                  f"{len(index)} surface forms usable as a target", flush=True)

            rows = []
            for w in works:
                named = sorted({n for n in w["named"] if n})
                target, basis, detail = "", "", ""
                if len(named) == 1:
                    target, basis, detail = named[0], "source", "SourceRecord attribution"
                else:
                    t, form = embedded_target(w["junk"], index)
                    if t:
                        target, basis, detail = t, "embedded", f"matched {form!r} in the node name"
                    elif named:
                        basis, detail = "ambiguous", "source names " + "; ".join(named)
                    else:
                        nb = [dict(r) for r in s.run(NEIGHBOUR, workId=w["workId"],
                                                     mincos=args.min_cos, p=JUNK_PATTERN)]
                        if len(nb) == 1 or (nb and (len(nb) == 1 or nb[0]["name"] != nb[1]["name"])):
                            target, basis = nb[0]["name"], "image"
                            detail = f"nearest neighbour at cosine {nb[0]['cos']:.3f}"
                        elif nb:
                            basis, detail = "image", "neighbours disagree"
                        else:
                            basis, detail = "unresolved", "no source, no name, no near neighbour"
                rows.append({"basis": basis, "junkNode": w["junk"], "workId": w["workId"],
                             "title": w["title"], "target": target, "evidence": detail})

            order = {"source": 0, "embedded": 1, "image": 2, "ambiguous": 3, "unresolved": 4}
            rows.sort(key=lambda r: (order.get(r["basis"], 9), r["junkNode"], r["title"]))
            with open(args.out, "w", newline="", encoding="utf-8") as fh:
                wr = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
                wr.writeheader()
                wr.writerows(rows)
            counts = {}
            for r in rows:
                counts[r["basis"]] = counts.get(r["basis"], 0) + 1
            print()
            for k in ("source", "embedded", "image", "ambiguous", "unresolved"):
                if counts.get(k):
                    print(f"  {k:11s} {counts[k]:>4d} works"
                          + ("   <- applied" if args.apply and k in ("source", "embedded") else ""))
            print(f"\nwrote {args.out}")

            if not args.apply:
                print("\nNothing written to the graph. Re-run with --apply to re-point the "
                      "`source` and `embedded` rows; `image` rows stay for a person to read.")
                return
            moved = 0
            for r in rows:
                if r["basis"] in ("source", "embedded") and r["target"]:
                    s.run(REPOINT, junk=r["junkNode"], workId=r["workId"], target=r["target"])
                    moved += 1
            emptied = 0
            for junk in sorted({r["junkNode"] for r in rows}):
                if s.run(DELETE_EMPTY, junk=junk).single()["n"]:
                    emptied += 1
            print(f"\n{moved} work(s) re-pointed; {emptied} non-artist node(s) deleted once empty.")
    finally:
        drv.close()


if __name__ == "__main__":
    main()
