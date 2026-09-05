"""One-off: look for patterns in which Roseberys-attributed artists lack a ULAN id."""
import os
import re
from collections import Counter

from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
with driver.session(database=NEO4J_DATABASE) as session:
    rows = session.run("""
        MATCH (a:Artist)<-[:ATTRIBUTED_TO]-(:SourceRecord {institutionName: 'Roseberys London'})
        WITH DISTINCT a
        OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
        WITH a, count(DISTINCT w) AS works
        RETURN a.name AS name, works, a.ulanUrl IS NULL AS unresolved,
               a.dateBorn_year AS dateBorn_year, a.dateDied_year AS dateDied_year,
               a.nationality AS nationality
    """).data()
driver.close()

print(f"{len(rows)} total Roseberys-attributed artists\n")

# ── works-count bucket ──
def bucket(w):
    if w is None or w < 2: return "1"
    if w < 5: return "2-4"
    if w < 10: return "5-9"
    if w < 25: return "10-24"
    if w < 100: return "25-99"
    return "100+"

buckets = Counter()
buckets_unresolved = Counter()
for r in rows:
    b = bucket(r["works"])
    buckets[b] += 1
    if r["unresolved"]:
        buckets_unresolved[b] += 1

print("=== By works-count bucket: unresolved rate ===")
for b in ["1", "2-4", "5-9", "10-24", "25-99", "100+"]:
    tot = buckets[b]
    unr = buckets_unresolved[b]
    if tot:
        print(f"  {b:8s} total={tot:5d}  unresolved={unr:5d}  rate={100*unr/tot:.1f}%")

# ── has dates at all? ──
def has_dates(r):
    return r["dateBorn_year"] is not None or r["dateDied_year"] is not None

dated_tot = sum(1 for r in rows if has_dates(r))
dated_unr = sum(1 for r in rows if has_dates(r) and r["unresolved"])
nodated_tot = sum(1 for r in rows if not has_dates(r))
nodated_unr = sum(1 for r in rows if not has_dates(r) and r["unresolved"])
print("\n=== By whether the graph has any birth/death year ===")
print(f"  has dates:    total={dated_tot:5d}  unresolved={dated_unr:5d}  rate={100*dated_unr/dated_tot:.1f}%")
print(f"  no dates:     total={nodated_tot:5d}  unresolved={nodated_unr:5d}  rate={100*nodated_unr/nodated_tot:.1f}%")

# ── living / no death year vs deceased ──
living_tot = sum(1 for r in rows if r["dateBorn_year"] and not r["dateDied_year"])
living_unr = sum(1 for r in rows if r["dateBorn_year"] and not r["dateDied_year"] and r["unresolved"])
deceased_tot = sum(1 for r in rows if r["dateDied_year"])
deceased_unr = sum(1 for r in rows if r["dateDied_year"] and r["unresolved"])
print("\n=== Living (has birth, no death year) vs deceased (has death year) ===")
print(f"  living-ish:   total={living_tot:5d}  unresolved={living_unr:5d}  rate={100*living_unr/living_tot:.1f}%" if living_tot else "  living-ish: 0")
print(f"  deceased:     total={deceased_tot:5d}  unresolved={deceased_unr:5d}  rate={100*deceased_unr/deceased_tot:.1f}%" if deceased_tot else "  deceased: 0")

# ── birth-year era bucket (for those with a birth year) ──
def era(y):
    if y is None: return None
    if y < 1800: return "<1800"
    if y < 1900: return "1800s"
    if y < 1940: return "1900-1939"
    if y < 1965: return "1940-1964"
    if y < 1985: return "1965-1984"
    return "1985+"

era_tot = Counter()
era_unr = Counter()
for r in rows:
    e = era(r["dateBorn_year"])
    if e:
        era_tot[e] += 1
        if r["unresolved"]:
            era_unr[e] += 1
print("\n=== By birth-year era (only artists with a known birth year) ===")
for e in ["<1800", "1800s", "1900-1939", "1940-1964", "1965-1984", "1985+"]:
    tot = era_tot[e]
    unr = era_unr[e]
    if tot:
        print(f"  {e:10s} total={tot:5d}  unresolved={unr:5d}  rate={100*unr/tot:.1f}%")

# ── name-pattern heuristics ──
PATTERNS = {
    "has_ampersand_or_and": lambda n: bool(re.search(r'\b(&|and)\b', n, re.IGNORECASE)),
    "all_caps_single_word": lambda n: n.isupper() and len(n.split()) == 1 and len(n) > 1,
    "mononym_no_space": lambda n: len(n.split()) == 1 and not n.isupper(),
    "junk_marker": lambda n: bool(re.search(
        r'\b(anon|anonymous|unknown|various artists|property|please note|no lot|'
        r'copyright|withdrawn|school|collective|artist unknown)\b', n, re.IGNORECASE)),
    "parenthetical_real_name": lambda n: bool(re.search(r'\([A-Z][a-z]+ [A-Z]', n)),  # e.g. "(Dean Stockton)"
    "has_honorific_suffix": lambda n: bool(re.search(
        r'\b(OBE|CBE|MBE|RA|RE|RWS|RSA|KBE|PRA|Sir|Dame|OM)\b', n)),
}

print("\n=== By name-pattern heuristic ===")
for label, fn in PATTERNS.items():
    tot = sum(1 for r in rows if fn(r["name"]))
    unr = sum(1 for r in rows if fn(r["name"]) and r["unresolved"])
    if tot:
        print(f"  {label:28s} total={tot:5d}  unresolved={unr:5d}  rate={100*unr/tot:.1f}%")

overall_rate = 100 * sum(1 for r in rows if r["unresolved"]) / len(rows)
print(f"\n(overall unresolved rate across all Roseberys artists: {overall_rate:.1f}%)")
