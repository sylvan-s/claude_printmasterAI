"""Read-only: repeat-sales year indices for Swann (USD realised), the US dollar-hammer market
(Bonhams USD + Skinner), and UK sterling hammer, with segment splits and Swann sell-through."""
import bisect, json, os, sys
from collections import Counter, defaultdict
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, f"{WT}/knowledge_graph/pricing_ml")
import house_offsets as ho
from neo4j import GraphDatabase
ho.load_env()
fx = json.load(open(f"{WT}/knowledge_graph/fx_gbp_ecb.json"))["rates"]; days = sorted(fx)
def usd_per_gbp(date):
    i = bisect.bisect_right(days, date[:10]) - 1
    while i >= 0 and "USD" not in fx[days[i]]: i -= 1
    return fx[days[i]]["USD"]
d = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
Q = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sourceType='auction' AND s.sold=true AND s.saleDate IS NOT NULL AND $where
WITH cw, a, s, collect(imp.signed)[0] AS signed
WITH cw, head(collect(a.dateBorn_year)) AS born, head(collect(a.name)) AS artist,
     collect({house:s.institutionName, date:substring(s.saleDate,0,10), price:$price, signed:signed}) AS sales
UNWIND sales AS x
WITH cw, born, artist, x WHERE x.price > 0
RETURN cw.id AS work, born, artist, x.house AS house, x.date AS date, x.price AS price, x.signed AS signed
"""
def run(where, price):
    with d.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        return [dict(r) for r in s.run(Q.replace("$where", where).replace("$price", price))]
swann = run("s.institutionName = 'Swann Auction Galleries' AND s.priceCurrency = 'USD'", "s.priceRealised")
us = run("s.institutionName IN ['Bonhams','Skinner'] AND s.priceCurrency = 'USD' AND s.hammerPrice > 0", "s.hammerPrice")
uk = run("s.priceCurrency = 'GBP' AND s.hammerPriceGBP > 0", "s.hammerPriceGBP")
with d.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
    st = s.run("""MATCH (s:SourceRecord) WHERE s.institutionName='Swann Auction Galleries' AND s.saleDate IS NOT NULL
      RETURN substring(s.saleDate,0,4) AS y, count(*) AS offered, sum(CASE WHEN s.sold THEN 1 ELSE 0 END) AS sold,
             percentileCont(CASE WHEN s.sold THEN s.priceRealised END, 0.5) AS med ORDER BY y""").data()
d.close()

SHOW = (2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026)
def rows_of(raw, to_gbp=False):
    out = [{"work": r["work"], "house": r["house"], "year": int(r["date"][:4]), "hammer": float(r["price"]) / (usd_per_gbp(r["date"]) if to_gbp else 1.0),
            "signed": r["signed"], "born": r["born"], "artist": r["artist"]} for r in raw]
    return [r for r in out if r["year"] >= 2016]
def index(rows, label, B=100):
    pw = Counter(r["work"] for r in rows); rows = [r for r in rows if pw[r["work"]] >= 2]
    if len(rows) < 300: print(f"  {label}: too few repeat sales ({len(rows)})"); return None
    years = sorted({r["year"] for r in rows}); houses = sorted({r["house"] for r in rows})
    _, y, *_ = ho.fit(rows, houses, years)
    rng = np.random.default_rng(11); bw = defaultdict(list)
    for r in rows: bw[r["work"]].append(r)
    ws = sorted(bw); dr = defaultdict(list)
    for b in range(B):
        smp = []
        for k, w in enumerate(rng.choice(len(ws), size=len(ws), replace=True)):
            smp.extend({**r, "work": f"{ws[w]}#{k}"} for r in bw[ws[w]])
        _, yb, *_ = ho.fit(smp, houses, years)
        for yy in SHOW:
            if yy in yb and 2025 in yb: dr[yy].append(yb[yy] - yb[2025])
    n = Counter(r["year"] for r in rows)
    res = {}
    cells = []
    for yy in SHOW:
        if yy not in y or not dr[yy]: cells.append(f"{yy}:  -  "); continue
        lo, hi = np.percentile(dr[yy], [5, 95]); pt = y[yy] - y[2025]
        res[yy] = (float(np.exp(pt)), float(np.exp(lo)), float(np.exp(hi)), n[yy])
        cells.append(f"{yy}:{np.exp(pt):.2f}[{np.exp(lo):.2f}-{np.exp(hi):.2f}]")
    print(f"  {label:38s} sales={len(rows):5d} works={len(ws):5d}\n     " + " ".join(cells) + f"\n     repeat sales per year: " + " ".join(f"{yy}:{n[yy]}" for yy in SHOW))
    return res

out = {}
print("Repeat-sales index vs 2025 [90% band], sales 2016-2026, each market fitted separately")
S_usd, S_gbp, U_usd, K_gbp = rows_of(swann), rows_of(swann, True), rows_of(us), rows_of(uk)
out["swann_usd"] = index(S_usd, "Swann, USD realised")
out["swann_gbp"] = index(S_gbp, "Swann, converted to GBP at sale date")
out["us_hammer_usd"] = index(U_usd, "Bonhams USD + Skinner, USD hammer")
out["uk_hammer_gbp"] = index(K_gbp, "UK sterling hammer (Bonhams/Roseberys/Forum)")
print("\nSwann segments (USD realised)")
for lab, f in [("born before 1900", lambda b: b and b < 1900), ("born 1900-1944", lambda b: b and 1900 <= b < 1945), ("born 1945+", lambda b: b and b >= 1945)]:
    out[f"swann_{lab}"] = index([r for r in S_usd if f(r["born"])], f"Swann, artist {lab}")
wmed = defaultdict(list)
for r in S_usd: wmed[r["work"]].append(r["hammer"])
wm = {w: np.median(v) for w, v in wmed.items()}
for lab, f in [("under $1,000", lambda m: m < 1000), ("$1,000-5,000", lambda m: 1000 <= m < 5000), ("$5,000+", lambda m: m >= 5000)]:
    out[f"swann_{lab}"] = index([r for r in S_usd if f(wm[r["work"]])], f"Swann, work median {lab}")
print("Swann most-resold artists:", Counter(r["artist"] for r in S_usd if Counter(x["work"] for x in S_usd)[r["work"]] >= 2).most_common(12))
print("Swann repeat sales by artist era:", Counter(("pre-1900" if (r["born"] or 0) and r["born"] < 1900 else "1900-44" if r["born"] and r["born"] < 1945 else "1945+" if r["born"] else "unknown") for r in S_usd))
print("\nSwann offered / sell-through / median realised USD by year")
for r in st: print(f"  {r['y']}: {r['offered']:5d} offered  {100*r['sold']/r['offered']:3.0f}% sold  median ${r['med'] or 0:,.0f}")
if len(sys.argv) > 1:
    json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
