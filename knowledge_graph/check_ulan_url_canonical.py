"""
PrintMasterAI — regression guard for Getty ULAN URL canonicalisation.

Exists because of a silent data-corruption bug, not for coverage's sake. Getty serves the
same authority record at two addresses — `/ulan/<id>` is the RDF resource, `/page/ulan/<id>`
is the HTML page about it — and this repo was writing both. `Artist.ulanUrl` is used as an
equality key (the `artist_ulanurl` uniqueness constraint, `MERGE (a:Artist {ulanUrl: ...})`
in met_ingest.py, every dedup pass ever run), so the same artist resolved by two code paths
produced two nodes that no exact-match check could see were one.

It hid TWELVE duplicate Artist pairs — Pierre-Auguste Renoir against Auguste Renoir, Ed
Ruscha against Edward Ruscha, Lucian against Lucien Freud — and it defeated an attempted
"different ULAN means different people" veto, which fired on Renoir against Renoir. Nothing
about the failure was loud: every ingest exited cleanly and the counts looked right. Repaired
in the graph 2026-09-12 by `merge_artists.py ulan-canon`.

NEO4J CANNOT ENFORCE THIS. Property-format constraints are an Enterprise feature and this
graph is self-hosted CE, without APOC. The invariant therefore lives in Python, and this is
what checks it.

Run after any change to a script that writes ulanUrl:

    python3 check_ulan_url_canonical.py            # exits 1 on regression
    python3 check_ulan_url_canonical.py --no-db    # skip the live-graph check

Three layers, cheapest first:
  1. `ulan_url.canonical_ulan_url` still maps every real-world input shape correctly.
  2. No script builds a ULAN URL by hand — the shape has exactly one definition.
  3. If the graph is reachable: every stored ulanUrl is canonical, and no ULAN id is on two
     Artist nodes.
"""
import argparse
import os
import re
import sys

from ulan_url import CANON_PREFIX, canonical_ulan_url, is_canonical, ulan_id

C = CANON_PREFIX + "500115467"

# (input, expected). The first two are the exact pair of forms that caused the incident.
CASES = [
    ("http://vocab.getty.edu/page/ulan/500115467", C),
    ("http://vocab.getty.edu/ulan/500115467", C),
    ("https://vocab.getty.edu/page/ulan/500115467", C),
    ("https://vocab.getty.edu/ulan/500115467/", C),
    ("https://www.vocab.getty.edu/ulan/500115467", C),
    ("  http://vocab.getty.edu/ulan/500115467  ", C),
    ("500115467", C),          # bare id, the shape the backfill CSVs sometimes carry
    (500115467, C),            # and its int form, straight out of a parquet/CSV read
    (None, None),
    ("", None),
    ("   ", None),
]

# A non-ULAN value must RAISE, never silently become None: an unresolvable identifier that
# vanishes leaves the artist unresolved with nothing in the logs to say why.
MUST_RAISE = ["http://example.com/nope", "http://vocab.getty.edu/aat/300041273",
              "not a url", "http://www.wikidata.org/entity/Q151679"]

# Layer 2. Any literal or f-string that assembles the URL itself, outside the one module
# allowed to know its shape.
HAND_BUILT = re.compile(r"vocab\.getty\.edu/(?:page/)?ulan/")
# `merge_artists.py` is deliberately NOT here: it imports CANON_PREFIX from ulan_url and
# describes the two addresses as "/ulan/<id>" and "/page/ulan/<id>", without the host, so it
# has no URL for this scan to find. Every exemption weakens the check — keep the list short.
EXEMPT = {"ulan_url.py",                    # defines the shape
          "check_ulan_url_canonical.py",    # this file
          "extract_artist_records.py",      # documents the bug in a docstring
          "build_ulan_index.py"}            # reads Getty's RDF dump, different vocabulary


def check_behaviour():
    bad = []
    for raw, want in CASES:
        try:
            got = canonical_ulan_url(raw)
        except Exception as e:                                    # noqa: BLE001
            bad.append(f"  {raw!r} raised {e!r}, expected {want!r}")
            continue
        if got != want:
            bad.append(f"  {raw!r} -> {got!r}, expected {want!r}")
    for raw in MUST_RAISE:
        try:
            got = canonical_ulan_url(raw)
            bad.append(f"  {raw!r} -> {got!r}, expected ValueError")
        except ValueError:
            pass
    if not is_canonical(C) or is_canonical("http://vocab.getty.edu/page/ulan/500115467"):
        bad.append("  is_canonical() does not separate the two forms")
    if ulan_id("http://vocab.getty.edu/page/ulan/500115467") != "500115467":
        bad.append("  ulan_id() does not read the page form")
    return bad


def check_no_hand_built(root):
    bad = []
    for fn in sorted(os.listdir(root)):
        if not fn.endswith(".py") or fn in EXEMPT:
            continue
        with open(os.path.join(root, fn), encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if HAND_BUILT.search(line) and not line.lstrip().startswith("#"):
                    bad.append(f"  {fn}:{n} builds a ULAN URL by hand — use "
                               f"canonical_ulan_url(): {line.strip()[:88]}")
    return bad


def check_graph():
    from dotenv import load_dotenv
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    from neo4j import GraphDatabase
    uri, user, pw = (os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"),
                     os.getenv("NEO4J_PASSWORD"))
    if not all([uri, user, pw]):
        return ["  NEO4J_* not set — cannot check the live graph (use --no-db to skip)"]
    bad = []
    drv = GraphDatabase.driver(uri, auth=(user, pw))
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        for r in s.run("MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL "
                       "RETURN a.name AS name, a.ulanUrl AS url"):
            if not is_canonical(r["url"]):
                bad.append(f"  non-canonical on Artist {r['name']!r}: {r['url']}")
        dupes = s.run(
            "MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL "
            "WITH reverse(split(reverse(a.ulanUrl), '/')[0]) AS uid, "
            "     collect(a.name) AS names WHERE size(names) > 1 "
            "RETURN uid, names").data()
        for d in dupes:
            bad.append(f"  ULAN {d['uid']} is on {len(d['names'])} Artist nodes: {d['names']}")
    drv.close()
    return bad[:40]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    a = ap.parse_args()
    root = os.path.dirname(os.path.abspath(__file__))

    failures = []
    for label, fn in [("canonicalisation behaviour", check_behaviour),
                      ("no hand-built URLs", lambda: check_no_hand_built(root))]:
        bad = fn()
        print(f"{'FAIL' if bad else 'ok  '}  {label}")
        failures += bad

    if a.no_db:
        print("skip  live graph (--no-db)")
    else:
        bad = check_graph()
        print(f"{'FAIL' if bad else 'ok  '}  live graph: all ulanUrl canonical, no shared ids")
        failures += bad

    if failures:
        print("\n" + "\n".join(failures))
        print(f"\n{len(failures)} problem(s)")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
