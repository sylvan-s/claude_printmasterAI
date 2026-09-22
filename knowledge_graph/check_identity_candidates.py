"""
PrintMasterAI — regression guard for POSSIBLE_SAME_AS identity candidates.
Version: IDENTITY-CANDIDATES-CHECK-1.0

The edge means "possibly the same", never "the same". Its risk is being read as identity, so
this guards both where it is read and what the graph holds (see identity_candidates.py).

    python3 check_identity_candidates.py            # exits 1 on any problem
    python3 check_identity_candidates.py --no-db    # source check only

Source: only the files in ALLOWED may name the relationship. A new reader has to be added here
on purpose, which is the moment to check that it filters `status`.

Graph:
  - endpoints share one label, Artist or ConceptualWork (never mixed, never another label)
  - no self-loops
  - one edge per unordered pair
  - status is 'open' or 'rejected'; a rejected edge carries decidedBy and decisionNote
"""
import argparse
import os
import sys

ALLOWED = {
    "identity_candidates.py",           # writer, review list, decisions
    "merge_artists.py",                 # carries edges through a fold, refuses rejected pairs
    "merge_duplicate_work_clusters.py", # the same for works
    "check_identity_candidates.py",
    "08_ackg_schema_definition.md",
}
NAME = "POSSIBLE_SAME_AS"


def check_sources(root):
    bad = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".py") or name in ALLOWED:
            continue
        try:
            text = open(os.path.join(root, name), encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        if NAME in text:
            bad.append(f"{name}: names {NAME} but is not in check_identity_candidates.ALLOWED — "
                       f"make sure it filters `status` (open/rejected) and never reads the edge "
                       f"as identity, then add it")
    return bad


CHECKS = [
    ("edges joining two different labels, or a label other than Artist/ConceptualWork", """
     MATCH (x)-[p:POSSIBLE_SAME_AS]->(y)
     WHERE NOT ((x:Artist AND y:Artist) OR (x:ConceptualWork AND y:ConceptualWork))
     RETURN count(p) AS n"""),
    ("self-loops", """
     MATCH (x)-[p:POSSIBLE_SAME_AS]->(x) RETURN count(p) AS n"""),
    ("pairs carrying more than one edge", """
     MATCH (x)-[p:POSSIBLE_SAME_AS]-(y) WHERE elementId(x) < elementId(y)
     WITH x, y, count(p) AS c WHERE c > 1 RETURN count(*) AS n"""),
    ("edges with a status other than open/rejected", """
     MATCH ()-[p:POSSIBLE_SAME_AS]->() WHERE NOT p.status IN ['open', 'rejected']
     RETURN count(p) AS n"""),
    ("rejected edges without decidedBy and decisionNote", """
     MATCH ()-[p:POSSIBLE_SAME_AS {status: 'rejected'}]->()
     WHERE p.decidedBy IS NULL OR p.decisionNote IS NULL RETURN count(p) AS n"""),
]


def check_graph():
    from dotenv import load_dotenv
    from neo4j import GraphDatabase
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"],
                               auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    bad, summary = [], None
    try:
        with drv.session(database=os.environ.get("NEO4J_DATABASE") or "neo4j") as s:
            for what, q in CHECKS:
                n = s.run(q).single()["n"]
                if n:
                    bad.append(f"{n} {what}")
            summary = s.run("""
                MATCH (x)-[p:POSSIBLE_SAME_AS]->()
                RETURN head(labels(x)) AS label, p.status AS status, count(p) AS n
                ORDER BY label, status""").data()
    finally:
        drv.close()
    return bad, summary


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--no-db", action="store_true")
    a = ap.parse_args()
    failures = check_sources(os.path.dirname(os.path.abspath(__file__)))
    print(f"{'FAIL' if failures else 'ok  '}  only allow-listed files name {NAME}")
    if a.no_db:
        print("skip  live graph (--no-db)")
    else:
        bad, summary = check_graph()
        print(f"{'FAIL' if bad else 'ok  '}  live graph: labels, self-loops, one edge per pair, "
              f"status vocabulary, rejected edges explained")
        for r in summary or []:
            print(f"        {r['label']:15s} {r['status']:9s} {r['n']:6d}")
        failures += bad
    if failures:
        print("\n" + "\n".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
