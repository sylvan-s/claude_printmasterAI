"""
PrintMasterAI — one-slide-per-lot PowerPoint for auction opportunities.

Turns the pipeline's own output into something reviewable before a sale. Every number on a
slide comes from a file the pipeline wrote or from the ACKG; nothing is composed here, so a
slide cannot say something the run did not.

Sources per lot:
  tests/backtest/output/<SALE>_<LOT>_1c1d_attr/result.json   pipeline run (isolation, no VEA)
  tests/backtest/output/<SALE>_<LOT>/result.json             pipeline run (full, with VEA)
  the ACKG                                                   every catalogued appearance of the work
  benchmark/data/<SALE>/images/RB-<SALE>-<lot>.webp          the lot image
  benchmark/data/<SALE>/catalogue.csv                        the house's own estimate

Both result paths are accepted because the two harnesses name their output differently, and a
deck will normally mix them: a lot worth a full VEA run and a lot screened without one sit
side by side. The risk factors say which is which — a run with no VEA earns an explicit
"no condition assessment" flag rather than quietly looking like a complete appraisal.

WHY RISK FACTORS ARE DERIVED, NOT WRITTEN. The pipeline emits nextSteps and a valuation
narrative, but the things that would actually cost money on a bid are structural and
computable: a low sell-through rate, thin comps, a stale comp set, wide dispersion, and — for
these runs specifically — the absence of Stage 1a, which means nobody assessed condition.
Those are read off the data rather than paraphrased from prose, so they cannot be softened.

WebP is converted to PNG because python-pptx cannot embed WebP.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/build_opportunity_deck.py \
        --sale A0793 --lots 210 320 516 517 --out /tmp/A0793_opportunities.pptx
"""

import argparse
import csv
import html
import io
import json
import os
import statistics
from datetime import datetime

from neo4j import GraphDatabase
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Emu, Inches, Pt

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Auction appearances are read from the graph here rather than from a pre-baked file, so the
# deck cannot silently go stale against the ACKG, and so a lot can be added without anyone
# remembering to regenerate a sidecar first.
HISTORY_QUERY = """
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE toLower(a.name) = toLower($artist) AND s.sourceType = 'auction'
WITH cw, s
// Punctuation becomes a space, which creates DOUBLE spaces: "Cats (Pink)" -> "cats  pink ".
// Without collapsing them the key "cats pink" matches nothing, and the work looks like it has
// almost no auction history — it silently under-reports rather than failing.
WHERE $key = '' OR trim(replace(replace(replace(
       replace(replace(replace(toLower(trim(cw.name)),'(',' '),')',' '),'-',' '),
       '   ',' '),'  ',' '),'  ',' ')) CONTAINS $key
RETURN cw.name AS work, s.institutionName AS house, s.saleId AS sale, s.lotNumber AS lot,
       substring(coalesce(s.saleDate,''),0,10) AS date, s.sold AS sold,
       s.estimateLow AS estLow, s.estimateHigh AS estHigh, s.priceRealisedGBP AS gbp
ORDER BY date DESC
"""

POST_NOMINALS = r"\b(FBA|RA|RE|RBA|RWS|ARA|ARE|OM|CH|CBE|OBE|MBE|DBE|PRA|RSA|RSW|NEAC|RCA|FRSA|Hon)\b\.?"


def _title_key(title):
    """Same punctuation/case fold the TS side uses, kept deliberately simple: this is a
    display query, not an identity merge."""
    t = title.lower()
    for ch in "().,'\u2019\"-/&":
        t = t.replace(ch, " ")
    return " ".join(t.split())[:24]


def fetch_history(artist, title):
    import re
    uri, user, pw = (os.environ.get(k) for k in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"))
    if not (uri and user and pw):
        print("  ! NEO4J_* not set — auction history omitted")
        return []
    clean = re.sub(POST_NOMINALS, "", artist).strip()
    drv = GraphDatabase.driver(uri, auth=(user, pw))
    try:
        with drv.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as ses:
            return [dict(r) for r in ses.run(HISTORY_QUERY, artist=clean, key=_title_key(title))]
    finally:
        drv.close()


def find_result(sale, lot):
    """Isolation runs write <SALE>_<LOT>_1c1d_attr; the full backtest writes <SALE>_<LOT>."""
    for d in (f"{sale}_{lot}_1c1d_attr", f"{sale}_{lot}"):
        p = f"{REPO}/tests/backtest/output/{d}/result.json"
        if os.path.exists(p):
            return p
    return None

INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x6B, 0x6B, 0x6B)
RULE = RGBColor(0xD8, 0xD4, 0xCC)
UP = RGBColor(0x1B, 0x6B, 0x3A)
DOWN = RGBColor(0xA3, 0x2A, 0x2A)
ACCENT = RGBColor(0x8A, 0x6D, 0x3B)


def txt(slide, l, t, w, h, s, size=11, bold=False, color=INK, align=None, italic=False, space_after=2):
    box = slide.shapes.add_textbox(Inches(l), Inches(t), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    for i, line in enumerate(str(s).split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.space_after = Pt(space_after)
        if align is not None:
            p.alignment = align
        for r in p.runs:
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.italic = italic
            r.font.color.rgb = color
            r.font.name = "Calibri"
    return box


def rule(slide, l, t, w):
    from pptx.enum.shapes import MSO_SHAPE
    sh = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(l), Inches(t), Inches(w), Emu(9525))
    sh.fill.solid(); sh.fill.fore_color.rgb = RULE
    sh.line.fill.background(); sh.shadow.inherit = False
    return sh


def load_catalogue(sale):
    out = {}
    with open(f"{REPO}/benchmark/data/{sale}/catalogue.csv", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            out[str(r["lot_number"]).strip()] = r
    return out


def money(v):
    return f"£{int(round(v)):,}" if v is not None else "—"


def risk_factors(hist, comps_gbp, result, cat_row):
    """Structural risks read off the data. See the module docstring on why not prose."""
    out = []
    sold = [h for h in hist if h.get("sold")]
    unsold = [h for h in hist if h.get("sold") is False]
    if hist:
        rate = len(sold) / len(hist)
        if rate < 0.6:
            out.append(f"LIQUIDITY: only {len(sold)} of {len(hist)} catalogued appearances sold "
                       f"({rate:.0%}). Comp medians count sales only and ignore the buy-ins.")
    if len(comps_gbp) < 4:
        out.append(f"THIN EVIDENCE: {len(comps_gbp)} same-work comparable(s). A median over so "
                   f"few sales moves a long way on one outlier.")
    if len(comps_gbp) >= 2:
        lo, hi = min(comps_gbp), max(comps_gbp)
        if lo and hi / lo >= 2.0:
            out.append(f"WIDE DISPERSION: realised prices span {money(lo)}–{money(hi)} "
                       f"({hi/lo:.1f}x). Condition and impression quality are doing real work here.")
    dates = [h["date"] for h in sold if h.get("date")]
    if dates:
        newest = max(dates)
        try:
            age = (datetime.now() - datetime.strptime(newest[:10], "%Y-%m-%d")).days / 365.25
            if age > 1.5:
                out.append(f"STALE COMPS: most recent sale {newest} ({age:.1f} years ago). "
                           f"The market may have moved.")
        except ValueError:
            pass
    vea_ran = bool(((result.get("report") or {}).get("stage1Result") or {})
                   .get("imagesReceived", {}).get("primaryScan"))
    if not vea_ran:
        out.append("NO CONDITION ASSESSMENT: this run skipped the visual extraction stage, so "
                   "nothing checked the sheet for trimming, foxing, fading or a later impression. "
                   "A discount in the house estimate may be condition the pipeline never saw.")
    if str(cat_row.get("edition_size") or "").strip() in ("", "0"):
        out.append("EDITION SIZE UNSTATED in the catalogue entry — rarity is inferred from "
                   "comparable records, not from the lot itself.")
    return out or ["No structural risk flags raised by the data."]


def build(sale, lots, out_path):
    cat = load_catalogue(sale)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)

    # ---- title slide ----
    s = prs.slides.add_slide(prs.slide_layouts[6])
    txt(s, 0.8, 2.2, 11.7, 0.9, f"{sale} — Opportunity Review", size=34, bold=True)
    txt(s, 0.8, 3.15, 11.7, 0.5, "Roseberys Prints & Multiples · lots where the pipeline values above the house estimate",
        size=14, color=MUTED)
    rule(s, 0.8, 3.8, 11.7)
    txt(s, 0.8, 4.0, 11.7, 1.6,
        f"{len(lots)} lots examined in full. Estimates produced by the PrintMasterAI 4-stage pipeline from\n"
        f"catalogue text, image-embedding identification and the project's own auction knowledge graph.\n"
        f"Every figure is traceable to a stored pipeline run or an ingested auction record.\n\n"
        f"Generated {datetime.now():%d %B %Y}. Not a valuation — see risk factors on each slide.",
        size=12, color=MUTED)

    for lot in lots:
        lot = str(lot)
        rp = find_result(sale, lot)
        if not rp:
            print(f"  ! lot {lot}: no pipeline result, skipped")
            continue
        res = json.load(open(rp))
        rep = res["report"]; est = rep.get("auctionEstimate") or {}
        row = cat.get(lot, {})
        hist = fetch_history(html.unescape(row.get("artist") or rep.get("likelyArtist") or ""),
                             html.unescape(row.get("title") or rep.get("artworkTitle") or ""))
        print(f"  lot {lot}: {len(hist)} auction record(s)")
        comps = [h["gbp"] for h in hist if h.get("sold") and h.get("gbp")]
        med = statistics.median(comps) if comps else None

        cl = float(row.get("low_estimate") or 0) or None
        ch = float(row.get("high_estimate") or 0) or None
        pl, ph = est.get("lowEstimate"), est.get("highEstimate")

        s = prs.slides.add_slide(prs.slide_layouts[6])
        title = html.unescape(row.get("title") or rep.get("artworkTitle") or "")
        artist = html.unescape(row.get("artist") or rep.get("likelyArtist") or "")
        txt(s, 0.55, 0.34, 8.6, 0.45, f"Lot {lot} · {artist}", size=21, bold=True)
        txt(s, 0.55, 0.82, 8.6, 0.38, title, size=14, italic=True, color=MUTED)
        rule(s, 0.55, 1.28, 12.25)

        # ---- image ----
        img = f"{REPO}/benchmark/data/{sale}/images/RB-{sale}-{lot}.webp"
        if os.path.exists(img):
            im = Image.open(img).convert("RGB")
            buf = io.BytesIO(); im.save(buf, "PNG"); buf.seek(0)
            maxw, maxh = 3.5, 4.3
            scale = min(maxw / (im.width / 96), maxh / (im.height / 96))
            s.shapes.add_picture(buf, Inches(0.55), Inches(1.5),
                                 width=Inches(im.width / 96 * scale), height=Inches(im.height / 96 * scale))

        # ---- estimates ----
        x = 4.35
        txt(s, x, 1.5, 4.0, 0.3, "VALUATION", size=10, bold=True, color=ACCENT)
        txt(s, x, 1.85, 1.9, 0.3, "Roseberys estimate", size=10, color=MUTED)
        txt(s, x, 2.12, 1.9, 0.4, f"{money(cl)} – {money(ch)}", size=15, bold=True)
        txt(s, x + 2.0, 1.85, 2.0, 0.3, "Pipeline estimate", size=10, color=MUTED)
        upside = (pl / cl) if (pl and cl) else None
        txt(s, x + 2.0, 2.12, 2.0, 0.4, f"{money(pl)} – {money(ph)}", size=15, bold=True,
            color=UP if upside and upside > 1 else DOWN)
        if med:
            txt(s, x, 2.62, 4.0, 0.3, f"Median realised, {len(comps)} same-work sales: {money(med)}",
                size=10, color=MUTED)
        if upside:
            txt(s, x, 2.9, 4.0, 0.32,
                f"Pipeline floor is {upside:.2f}× the house low estimate", size=11, bold=True,
                color=UP if upside > 1 else DOWN)

        # ---- the artwork in the artist's career ----
        txt(s, x, 3.42, 8.25, 0.3, "THE WORK", size=10, bold=True, color=ACCENT)
        ctx = (rep.get("historicalContext") or "").strip()
        edn = (rep.get("editionSizeAndPrintNumber") or "").strip()
        body = ctx[:620] + ("…" if len(ctx) > 620 else "")
        if edn:
            body += "\n\nEdition: " + (edn[:240] + ("…" if len(edn) > 240 else ""))
        txt(s, x, 3.72, 8.25, 1.7, body, size=9.5, color=INK, space_after=3)

        # ---- reasoning ----
        txt(s, x, 5.5, 8.25, 0.3, "WHY THIS ESTIMATE", size=10, bold=True, color=ACCENT)
        vc = (est.get("valuationContext") or "").strip()
        txt(s, x, 5.8, 8.25, 1.5, vc[:760] + ("…" if len(vc) > 760 else ""), size=9.5, space_after=3)

        # ---- auction history (own slide when long) ----
        s2 = prs.slides.add_slide(prs.slide_layouts[6])
        txt(s2, 0.55, 0.34, 12.25, 0.4, f"Lot {lot} · {artist} — auction record & risk", size=19, bold=True)
        rule(s2, 0.55, 0.9, 12.25)
        txt(s2, 0.55, 1.05, 12.25, 0.3,
            f"Every catalogued appearance of this work in the knowledge graph ({len(hist)} records). "
            f"The subject lot is excluded from the pipeline's own comparables.", size=9.5, color=MUTED)

        hdr = [("Date", 0.55, 1.1), ("House", 1.75, 2.0), ("Sale / lot", 3.85, 1.5),
               ("Work as catalogued", 5.45, 3.6), ("Estimate", 9.15, 1.7), ("Result", 10.95, 1.8)]
        for label, left, w in hdr:
            txt(s2, left, 1.45, w, 0.28, label, size=9.5, bold=True, color=MUTED)
        rule(s2, 0.55, 1.72, 12.25)
        y = 1.82
        for h in hist[:16]:
            e = f"{money(h.get('estLow'))}–{money(h.get('estHigh'))}" if h.get("estLow") else "—"
            if h.get("sold") and h.get("gbp"):
                result, col = money(h["gbp"]), UP
            elif h.get("sold"):
                result, col = "sold (price n/a)", MUTED
            elif h.get("sold") is False:
                result, col = "bought in", DOWN
            else:
                result, col = "—", MUTED
            txt(s2, 0.55, y, 1.1, 0.24, h.get("date") or "—", size=9)
            txt(s2, 1.75, y, 2.0, 0.24, h.get("house") or "—", size=9)
            txt(s2, 3.85, y, 1.5, 0.24, f"{h.get('sale') or '—'} / {h.get('lot') or '—'}", size=9)
            txt(s2, 5.45, y, 3.6, 0.24, (h.get("work") or "")[:52], size=9, color=MUTED)
            txt(s2, 9.15, y, 1.7, 0.24, e, size=9)
            txt(s2, 10.95, y, 1.8, 0.24, result, size=9, bold=True, color=col)
            y += 0.265
        if len(hist) > 16:
            txt(s2, 0.55, y, 6.0, 0.24, f"… and {len(hist) - 16} further record(s)", size=9, italic=True, color=MUTED)
            y += 0.3

        y = max(y + 0.15, 5.55)
        txt(s2, 0.55, y, 12.25, 0.3, "RISK FACTORS", size=10, bold=True, color=ACCENT)
        risks = risk_factors(hist, comps, res, row)
        txt(s2, 0.55, y + 0.3, 12.25, 1.4, "\n".join("•  " + r for r in risks), size=9.5, space_after=4)

    prs.save(out_path)
    print(f"\nwrote {out_path} ({len(prs.slides.__iter__.__self__._sldIdLst)} slides)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sale", required=True)
    ap.add_argument("--lots", nargs="+", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    build(a.sale, a.lots, a.out or f"/tmp/{a.sale}_opportunities.pptx")
