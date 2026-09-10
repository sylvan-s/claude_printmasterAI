/**
 * Free pre-screen of a whole auction catalogue for mispriced lots.
 *
 * Costs NOTHING in LLM spend: the catalogue CSV supplies artist, title, medium and estimate,
 * and the ACKG supplies realised prices. The full pipeline is ~$0.40/lot, so appraising a
 * 534-lot sale outright is ~£160. This ranks candidates so the LLM budget goes on the few
 * lots worth appraising, not on all of them.
 *
 * WHAT THE FIRST VERSION GOT WRONG, and why this one is shaped as it is.
 *
 * It ranked purely on (median same_work comp) / (low estimate), and both lots deep-checked
 * against the full pipeline deflated:
 *
 *   494 Ai Weiwei "Cats (Pink)"   screen 2.99x -> pipeline GBP 550-900 vs catalogue 300-500.
 *                                 Directionally right, but the graph also holds SEVEN
 *                                 bought-in attempts against five sales — the comp median is
 *                                 survivorship-filtered and the house has failed to sell this
 *                                 exact print twice.
 *   238 Shrigley "I hate humans"  screen 2.56x -> pipeline GBP 900-1800 vs catalogue 1000-1500.
 *                                 No opportunity at all. The screen's image route matched
 *                                 "I Hate Human Beings" at dino 0.958 and counted comps for
 *                                 THAT print as same-work. They are two different prints in
 *                                 one series idiom — black text on white — which is exactly
 *                                 where a visual embedding is least able to separate identity
 *                                 from style.
 *
 * So this version:
 *
 *   1. SEPARATES IDENTITY FROM PRICE. A comp counts as same-work only when the work was
 *      identified. Identification is "title" when the catalogue title matches a catalogued
 *      work, and "image" only when the catalogue title is USELESS (a medium description, or
 *      low-information like "Untitled") — the Freud case, lot 98, whose catalogue title is
 *      literally "Etching on Somerset wove, signed with initials" and which no title method
 *      can reach. An image match that merely DISAGREES with a serviceable catalogue title is
 *      a sibling, not this work, and is reported as such rather than priced.
 *   2. REPORTS SELL-THROUGH. queryAuctionComparables filters sold = true, which is correct
 *      for computing a price and wrong for judging liquidity. A work that fails to sell more
 *      often than it sells is not underpriced at a low estimate; it is marked to clear.
 *   3. DOES NOT COLLAPSE TO ONE NUMBER. Ratio, comp count, sell-through and identity basis
 *      are all shown, because the two deflations above were both invisible in the ratio.
 *
 * This is a CANDIDATE GENERATOR, not a valuation. Every ratio here ignores condition,
 * impression quality and edition position, which is what the pipeline exists to weigh.
 *
 * Usage:
 *   npx tsx tests/backtest/screen_sale.ts --sale A0793
 *   npx tsx tests/backtest/screen_sale.ts --sale A0793 --min-comps 3 --json /tmp/out.json
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getImageEmbeddings } from "../../src/appraisal/embedding_client";
import {
  queryAuctionComparables,
  queryImageEmbeddingMatches,
  closeDriver,
  normalizeTitleKey,
  isLowInformationTitle,
} from "../../src/appraisal/knowledge_graph/index";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’",
  eacute: "é", egrave: "è", ecirc: "ê", Eacute: "É", agrave: "à", acirc: "â", ccedil: "ç",
  uuml: "ü", ouml: "ö", auml: "ä", oacute: "ó", iacute: "í", uacute: "ú", ntilde: "ñ",
};
const unesc = (s: string) =>
  s.replace(/&([a-zA-Z]+);/g, (m, c) => ENT[c] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Post-nominals and honorifics keep catalogue names from matching the graph's. */
const POST = /\b(FBA|RA|RE|RBA|RWS|ARA|ARE|OM|CH|CBE|OBE|MBE|DBE|PRA|RSA|RSW|NEAC|RCA|FRSA|PPRWS|Hon|R\.A|R\.E)\b\.?/g;
const cleanArtist = (s: string) =>
  unesc(s).replace(POST, "").replace(/^(Dame|Sir|Lord|Lady)\s+/i, "").replace(/\s+/g, " ").trim();

/**
 * A catalogue "title" that is really a medium description — the parser captured the wrong
 * field. Only for these (and genuinely low-information titles) is an image match allowed to
 * establish identity, because nothing else can.
 */
const MEDIUM_WORDS = /\b(etching|lithograph|screenprint|serigraph|woodcut|linocut|aquatint|drypoint|engraving|giclee|photogravure|wove|laid|somerset|arches|signed|numbered|framed|paper)\b/i;
function titleIsUnusable(t: string): boolean {
  const s = t.trim();
  if (!s || s.length < 3) return true;
  if (isLowInformationTitle(s)) return true;
  // Two or more medium/support words and no other content: a medium string, not a title.
  const hits = s.match(new RegExp(MEDIUM_WORDS.source, "gi")) ?? [];
  return hits.length >= 2;
}

function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let f = "", row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/**
 * Sold AND unsold appearances of one work. queryAuctionComparables deliberately returns only
 * sold records; this is the other half — a work bought in more often than sold is not a
 * bargain at a low estimate, it is being marked to clear.
 */
const SELL_THROUGH = `
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE toLower(a.name) = toLower($artist) AND s.sourceType = 'auction'
  AND ($excludeSaleId IS NULL OR s.saleId IS NULL OR s.saleId <> $excludeSaleId)
WITH cw, s
WHERE $titleKey IS NULL OR $titleKey = '' OR
      replace(replace(replace(toLower(trim(cw.name)),'(',' '),')',' '),'-',' ') CONTAINS $titleKey
RETURN count(CASE WHEN s.sold THEN 1 END) AS sold,
       count(CASE WHEN s.sold = false THEN 1 END) AS unsold
`;

async function sellThrough(artist: string, titleKey: string | null, excludeSaleId: string) {
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = await s.run(SELL_THROUGH, { artist, titleKey, excludeSaleId });
    const rec = r.records[0];
    const n = (v: any) => v?.toNumber?.() ?? Number(v ?? 0);
    return { sold: n(rec?.get("sold")), unsold: n(rec?.get("unsold")) };
  } catch { return { sold: 0, unsold: 0 }; }
  finally { await s.close(); }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const sale = arg("sale");
  if (!sale) { console.error("Usage: --sale A0793 [--min-comps 2] [--json PATH]"); process.exit(1); }
  const minComps = Number(arg("min-comps", "2"));
  const jsonOut = arg("json", `/tmp/${sale}_screen.json`);

  const csv = `benchmark/data/${sale}/catalogue.csv`;
  if (!existsSync(csv)) { console.error(`No catalogue at ${csv}`); process.exit(1); }
  const rows = parseCsv(readFileSync(csv, "utf8").replace(/^﻿/, ""));
  const h = rows[0], ix = (n: string) => h.indexOf(n);

  const out: any[] = [];
  let n = 0;
  for (const r of rows.slice(1)) {
    if (r.length < h.length - 2) continue;
    const lot = r[ix("lot_number")];
    const artist = cleanArtist(r[ix("artist")] || "");
    if (!artist) continue;
    const title = unesc(r[ix("title")] || "").trim();
    const lowEst = Number(r[ix("low_estimate")] || 0);
    if (!lowEst) continue;
    if ((r[ix("multi_work")] || "").trim()) continue;  // same exclusion the ingest applies

    // --- identity ------------------------------------------------------------------
    const usable = !titleIsUnusable(title);
    let identity: "title" | "image" | "none" = "none";
    let workTitle: string | null = usable ? title : null;
    let dino: number | null = null, imgWork: string | null = null, sibling: string | null = null;

    const imgPath = `benchmark/data/${sale}/images/RB-${sale}-${lot}.webp`;
    if (existsSync(imgPath)) {
      try {
        const v = await getImageEmbeddings(readFileSync(imgPath).toString("base64"), "image/webp");
        if (v?.dinov2?.vector) {
          const m = await queryImageEmbeddingMatches(v.dinov2.vector, v.clip?.vector ?? null,
            { topKPerIndex: 25, limit: 3, excludeSaleId: sale });
          const t = m[0];
          if (t?.dinov2Similarity != null) { dino = +t.dinov2Similarity.toFixed(3); imgWork = t.conceptualWorkTitle ?? null; }
        }
      } catch { /* image evidence is optional */ }
    }

    if (usable) {
      identity = "title";
      // An image match that disagrees with a serviceable catalogue title is a SIBLING work,
      // not this one — the Shrigley failure. Recorded, never priced as same-work.
      if (imgWork && dino != null && dino >= 0.88 && normalizeTitleKey(imgWork) !== normalizeTitleKey(title)) {
        sibling = imgWork;
      }
    } else if (imgWork && dino != null && dino >= 0.88) {
      // Catalogue title unusable — the image is the only identity signal there is.
      identity = "image";
      workTitle = imgWork;
    }

    // --- price + liquidity ---------------------------------------------------------
    let nComps = 0, median: number | null = null, st = { sold: 0, unsold: 0 };
    if (identity !== "none" && workTitle) {
      try {
        const c = await queryAuctionComparables({
          artistName: artist, workTitle, sinceDate: "2015-01-01", limit: 40,
        });
        const sw = c.comparables.filter(x => x.tier === "same_work").map(x => x.priceRealisedGBP).sort((a, b) => a - b);
        nComps = sw.length;
        if (sw.length) median = Math.round(sw[Math.floor(sw.length / 2)]);
      } catch { /* graph hiccup — lot simply gets no price signal */ }
      st = await sellThrough(artist, normalizeTitleKey(workTitle).slice(0, 24) || null, sale);
    }

    if (nComps >= minComps && median) {
      const attempts = st.sold + st.unsold;
      out.push({
        lot, artist, title: title.slice(0, 44), lowEst,
        highEst: Number(r[ix("high_estimate")] || 0),
        identity, dino, sibling, nComps, median,
        ratio: +(median / lowEst).toFixed(2),
        sold: st.sold, unsold: st.unsold,
        sellThrough: attempts ? +(st.sold / attempts).toFixed(2) : null,
      });
    }
    if (++n % 100 === 0) console.log(`  …${n} lots`);
  }

  // Rank by ratio, but a work that mostly fails to sell is not a bargain — sell-through
  // below half demotes rather than being silently averaged into the ratio.
  out.sort((a, b) => {
    const grade = (o: any) => (o.sellThrough == null ? 0.5 : o.sellThrough) >= 0.5 ? 1 : 0;
    return grade(b) - grade(a) || b.ratio - a.ratio;
  });

  console.log(`\n${out.length} candidate(s) with >=${minComps} same-work comps\n`);
  console.log("lot   ratio  lowEst  median  n   sell   id     artist / title");
  console.log("-".repeat(104));
  for (const o of out.slice(0, 30)) {
    const st = o.sellThrough == null ? " -  " : `${o.sold}/${o.sold + o.unsold} `;
    console.log(
      `${String(o.lot).padEnd(5)} ${String(o.ratio).padEnd(6)} £${String(o.lowEst).padEnd(6)} £${String(o.median).padEnd(6)} ` +
      `${String(o.nComps).padEnd(3)} ${st.padEnd(6)} ${o.identity.padEnd(6)} ${o.artist.slice(0, 20)} — ${o.title.slice(0, 30)}` +
      (o.sibling ? `  [sibling: ${o.sibling.slice(0, 24)}]` : ""),
    );
  }
  const flagged = out.filter(o => o.sibling).length;
  console.log(`\nwith a disagreeing image match (sibling risk): ${flagged}`);
  console.log(`identified by image because the catalogue title was unusable: ${out.filter(o => o.identity === "image").length}`);
  writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  console.log(`-> ${jsonOut}`);
  await closeDriver();
}

main();
