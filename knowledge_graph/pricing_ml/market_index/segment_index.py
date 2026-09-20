"""Read-only: sterling-only repeat-sales year index by segment, plus sell-through by year."""
import os, sys
from collections import Counter, defaultdict
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, f"{WT}/knowledge_graph/pricing_ml")
import house_offsets as ho
from neo4j import GraphDatabase
ho.load_env()
d = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
Q = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sourceType='auction' AND s.sold=true AND s.hammerPriceGBP>0 AND s.saleDate IS NOT NULL AND s.priceCurrency='GBP'
WITH cw, a, s, collect(imp.signed)[0] AS signed
WITH cw, head(collect(a.dateBorn_year)) AS born, head(collect(a.name)) AS artist,
     collect({house:s.institutionName, date:substring(s.saleDate,0,10), hammer:s.hammerPriceGBP, signed:signed}) AS sales
WHERE size(sales) >= 2
UNWIND sales AS x
RETURN cw.id AS work, born, artist, x.house AS house, x.date AS date, x.hammer AS hammer, x.signed AS signed
"""
ST = """
MATCH (s:SourceRecord) WHERE s.sourceType='auction' AND s.saleDate IS NOT NULL AND s.priceCurrency='GBP'
  AND s.institutionName IN ['Roseberys London','Bonhams','Forum Auctions']
RETURN substring(s.saleDate,0,4) AS y, s.institutionName AS h, count(*) AS offered, sum(CASE WHEN s.sold THEN 1 ELSE 0 END) AS sold,
       percentileCont(CASE WHEN s.sold AND s.hammerPriceGBP>0 THEN s.hammerPriceGBP END, 0.5) AS medHammer
ORDER BY y, h
"""
with d.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
    raw = [dict(r) for r in s.run(Q)]
    st = [dict(r) for r in s.run(ST)]
d.close()

def index(rows, label, show=(2015, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026)):
    rows = [dict(r) for r in rows]
    pw = Counter(r["work"] for r in rows); rows = [r for r in rows if pw[r["work"]] >= 2]
    if len(rows) < 300: print(f"{label}: too few ({len(rows)})"); return
    years = sorted({r["year"] for r in rows}); houses = sorted({r["house"] for r in rows})
    _, y, *_ = ho.fit(rows, houses, years)
    rng = np.random.default_rng(11); bw = defaultdict(list)
    for r in rows: bw[r["work"]].append(r)
    ws = sorted(bw); dr = defaultdict(list)
    for b in range(100):
        smp = []
        for k, w in enumerate(rng.choice(len(ws), size=len(ws), replace=True)):
            smp.extend({**r, "work": f"{ws[w]}#{k}"} for r in bw[ws[w]])
        _, yb, *_ = ho.fit(smp, houses, years)
        for yy in show:
            if yy in yb and 2025 in yb: dr[yy].append(yb[yy] - yb[2025])
    cells = []
    for yy in show:
        if yy not in y or not dr[yy]: cells.append("   -   "); continue
        lo, hi = np.percentile(dr[yy], [5, 95])
        cells.append(f"{np.exp(y[yy]-y[2025]):.2f}[{np.exp(lo):.2f}-{np.exp(hi):.2f}]")
    n = Counter(r["year"] for r in rows)
    print(f"{label:34s} n={len(rows):5d} works={len(ws):5d} | " + "  ".join(f"{yy}:{c}" for yy, c in zip(show, cells)) + f" | sales 2019/22/25: {n[2019]}/{n[2022]}/{n[2025]}")

base = [{"work": r["work"], "house": r["house"], "year": int(r["date"][:4]), "hammer": float(r["hammer"]), "signed": r["signed"], "born": r["born"], "artist": r["artist"]} for r in raw]
med = defaultdict(list)
for r in base: med[r["work"]].append(r["hammer"])
wmed = {w: float(np.median(v)) for w, v in med.items()}
print("sterling-only repeat-sales index vs 2025 [90% band, 100 bootstraps]")
index(base, "ALL sterling")
index([r for r in base if r["born"] and r["born"] < 1900], "artist born before 1900")
index([r for r in base if r["born"] and 1900 <= r["born"] < 1945], "artist born 1900-1944")
index([r for r in base if r["born"] and r["born"] >= 1945], "artist born 1945+")
index([r for r in base if wmed[r["work"]] < 500], "work median hammer < £500")
index([r for r in base if 500 <= wmed[r["work"]] < 2000], "work median £500-2,000")
index([r for r in base if wmed[r["work"]] >= 2000], "work median £2,000+")
for h in ["Roseberys London", "Forum Auctions", "Bonhams"]:
    index([r for r in base if r["house"] == h], f"only {h} sales")
top = Counter(r["artist"] for r in base if r["born"] and r["born"] >= 1945).most_common(8)
print("most-resold 1945+ artists:", top)
print("\nsell-through and median hammer (GBP records) by year and house")
by = defaultdict(dict)
for r in st:
    if r["y"] >= "2015": by[r["y"]][r["h"]] = r
for y in sorted(by):
    print(y, "  ".join(f"{h.split()[0]}: {v['offered']:5d} offered {100*v['sold']/v['offered']:3.0f}% sold med £{(v['medHammer'] or 0):,.0f}" for h, v in sorted(by[y].items())))
