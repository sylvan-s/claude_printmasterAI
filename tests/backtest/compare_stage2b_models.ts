/**
 * Stage 2b, Haiku against Sonnet, on the same lots and the same code.
 *
 * The question is not "is the cheaper model cheaper" — it is 5x cheaper by the rate card and
 * that needs no experiment. The question is whether Stage 2b's job survives the swap, and that
 * job is research: go and find things that are true, and say so honestly when you cannot.
 *
 * So the comparison scores behaviour, not prose similarity:
 *   SEARCHED      — did it actually use the tool? The failure this stage was built around is a
 *                   model that accepts a search tool and then answers from memory (ADR: qwen3-max
 *                   invented a GBP 3,486,000 sale for a print trading at 800-1,430).
 *   CITED         — every comp and catalogue-raisonné finding must carry a URL (ADR-0007
 *                   Decision 3). No URL is an assertion, not a record.
 *   URL LIVE      — the cited URLs are HEAD-requested. A citation that 404s is the signature of
 *                   a fabricated source and is the single most important number here.
 *   AGREED        — same attributed artist, same attribution level, same catalogue raisonné.
 *   HONEST        — did it record what it could NOT resolve (unresolvedQuestions), or paper over
 *                   the gap? A model that finds less but says so is safer than one that fills in.
 *   STORABLE      — how many comps pass the write-back gates (basis, key, price).
 *
 *   npx tsx tests/backtest/compare_stage2b_models.ts
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { gateComp } from "../../src/appraisal/knowledge_graph/write_research_comps";

const DIR = `${import.meta.dirname}/output`;

interface Arm {
  lot: string; model: string; costUsd: number; elapsed: number;
  searches: number; artist: string | null; level: string | null;
  crFound: boolean; crName: string | null; crUrl: string | null;
  comps: { url: string | null; basis: string | null; house: string | null; price: number | null; title: string | null }[];
  unresolved: number; storable: number;
  estimate: [number, number] | null;
}

function armFrom(dir: string): Arm | null {
  const p = `${DIR}/${dir}/result.json`;
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const s2 = j.report?.stage2Result ?? {};
  const est = j.report?.auctionEstimate;
  const comps = Array.isArray(s2.auctionComps) ? s2.auctionComps : [];
  return {
    lot: dir.replace(/_attrpath.*/, ""),
    model: j.stage2bModel ?? "?",
    costUsd: j.tokenUsage?.totalUsd ?? 0,
    elapsed: j.elapsedSeconds ?? 0,
    searches: j.tokenUsage?.byLabel?.["Claude web-search"]?.calls ?? 0,
    artist: s2.attributionConclusion?.attributedArtist ?? null,
    level: s2.attributionConclusion?.attributionLevel ?? null,
    crFound: s2.catalogueRaisonne?.referenceFound === true,
    crName: s2.catalogueRaisonne?.catalogueName ?? null,
    crUrl: s2.catalogueRaisonne?.sourceUrl ?? null,
    comps: comps.map((c: any) => ({ url: c.listingUrl ?? null, basis: c.priceBasis ?? null, house: c.auctionHouse ?? null, price: c.priceAmount ?? null, title: c.artworkTitle ?? null })),
    unresolved: Array.isArray(s2.unresolvedQuestions) ? s2.unresolvedQuestions.length : 0,
    storable: comps.filter((c: any) => gateComp(c).ok).length,
    estimate: est?.lowEstimate ? [est.lowEstimate, est.highEstimate] : null,
  };
}

/** A citation that does not resolve is the signature of a fabricated source. */
async function urlLive(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12_000);
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: c.signal, headers: { "user-agent": "Mozilla/5.0" } });
    // Some hosts refuse HEAD but serve GET.
    if (r.status === 405 || r.status === 403) r = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: { "user-agent": "Mozilla/5.0" } });
    clearTimeout(t);
    return r.status < 400;
  } catch { return false; }
}

async function main() {
  // slugify() strips the hyphen, so the directories end _2b_claudesonnet46 / _2b_claudehaiku45.
  const dirs = readdirSync(DIR).filter((d) => /_2b_claude(sonnet46|haiku45)$/.test(d));
  const arms = dirs.map(armFrom).filter((a): a is Arm => !!a);
  const lots = [...new Set(arms.map((a) => a.lot))].sort();
  if (!lots.length) { console.log("No paired runs found under", DIR); return; }

  // One HEAD per distinct URL across both arms, so the check is fair and not double-charged.
  const urls = [...new Set(arms.flatMap((a) => [...a.comps.map((c) => c.url), a.crUrl]).filter((u): u is string => !!u && /^https?:\/\//.test(u)))];
  console.log(`checking ${urls.length} distinct cited URL(s)…`);
  const live = new Map<string, boolean>();
  for (let i = 0; i < urls.length; i += 6) {
    const batch = urls.slice(i, i + 6);
    const res = await Promise.all(batch.map(urlLive));
    batch.forEach((u, n) => live.set(u, res[n]));
  }
  const liveOf = (a: Arm) => {
    const us = [...a.comps.map((c) => c.url), a.crUrl].filter((u): u is string => !!u && /^https?:\/\//.test(u));
    return { total: us.length, ok: us.filter((u) => live.get(u)).length, dead: us.filter((u) => !live.get(u)) };
  };

  const H = (s: string, n: number) => s.padEnd(n);
  console.log(`\n══ Stage 2b: Haiku 4.5 against Sonnet 4.6, same lots, same code ══\n`);
  console.log(`${H("lot", 22)} ${H("2b model", 9)} ${H("cost", 7)} ${H("s", 5)} ${H("srch", 5)} ${H("comps", 6)} ${H("stor", 5)} ${H("cited", 6)} ${H("live", 6)} ${H("CR", 4)} ${H("unres", 6)} estimate`);
  for (const lot of lots) {
    for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const a = arms.find((x) => x.lot === lot && x.model === model);
      if (!a) { console.log(`${H(lot, 22)} ${H(model.includes("haiku") ? "haiku" : "sonnet", 9)} (missing)`); continue; }
      const l = liveOf(a);
      const cited = a.comps.filter((c) => c.url).length;
      console.log(
        `${H(lot, 22)} ${H(model.includes("haiku") ? "haiku" : "sonnet", 9)} ${H("$" + a.costUsd.toFixed(3), 7)} ${H(String(Math.round(a.elapsed)), 5)} ` +
        `${H(String(a.searches), 5)} ${H(String(a.comps.length), 6)} ${H(String(a.storable), 5)} ${H(`${cited}/${a.comps.length}`, 6)} ${H(`${l.ok}/${l.total}`, 6)} ` +
        `${H(a.crFound ? "yes" : "no", 4)} ${H(String(a.unresolved), 6)} ${a.estimate ? `${a.estimate[0]}-${a.estimate[1]}` : "—"}`);
    }
  }

  console.log(`\n── Agreement, per lot ──`);
  for (const lot of lots) {
    const s = arms.find((x) => x.lot === lot && x.model === "claude-sonnet-4-6");
    const h = arms.find((x) => x.lot === lot && x.model === "claude-haiku-4-5");
    if (!s || !h) continue;
    const same = (a: unknown, b: unknown) => (String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase() ? "same" : `DIFFER (${a ?? "—"} / ${b ?? "—"})`);
    console.log(`  ${lot}`);
    console.log(`    artist            ${same(s.artist, h.artist)}`);
    console.log(`    attribution level ${same(s.level, h.level)}`);
    console.log(`    catalogue raisonné ${same(s.crName, h.crName)}`);
    const sd = liveOf(s).dead, hd = liveOf(h).dead;
    if (sd.length) console.log(`    sonnet DEAD citations: ${sd.join(" ")}`);
    if (hd.length) console.log(`    haiku  DEAD citations: ${hd.join(" ")}`);
  }

  console.log(`\n── Totals ──`);
  for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5"]) {
    const g = arms.filter((a) => a.model === model);
    if (!g.length) continue;
    const l = g.map(liveOf);
    const tot = (f: (a: Arm) => number) => g.reduce((t, a) => t + f(a), 0);
    console.log(
      `  ${model.includes("haiku") ? "haiku " : "sonnet"}  n=${g.length}  $${tot((a) => a.costUsd).toFixed(3)} total, $${(tot((a) => a.costUsd) / g.length).toFixed(3)}/lot  ` +
      `| ${tot((a) => a.searches)} searches | ${tot((a) => a.comps.length)} comps, ${tot((a) => a.storable)} storable | ` +
      `citations live ${l.reduce((t, x) => t + x.ok, 0)}/${l.reduce((t, x) => t + x.total, 0)} | ${tot((a) => a.unresolved)} unresolved questions recorded`);
  }
  const s = arms.filter((a) => a.model === "claude-sonnet-4-6"), h = arms.filter((a) => a.model === "claude-haiku-4-5");
  if (s.length && h.length) {
    const cs = s.reduce((t, a) => t + a.costUsd, 0) / s.length, ch = h.reduce((t, a) => t + a.costUsd, 0) / h.length;
    console.log(`\n  cost per lot: sonnet $${cs.toFixed(3)} -> haiku $${ch.toFixed(3)}  (${((1 - ch / cs) * 100).toFixed(0)}% cheaper)`);
  }
  console.log(`\nNB: a dead citation is the number that decides this. Everything else is a preference;`);
  console.log(`    a fabricated source written into the graph is unrepairable later.\n`);
}
main();
