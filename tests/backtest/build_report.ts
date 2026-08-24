// Renders a backtest run as a self-contained, side-by-side HTML report: the app's
// blind PrintAnalysisReport next to the withheld Roseberys catalogue facts, with
// the comparison verdict called out up top. Used by run_backtest.ts.

import type { PrintAnalysisReport } from "../../src/types";
import type { ParsedLot } from "../../benchmark/src/roseberys/parse";
import type { RawLot } from "../../benchmark/src/roseberys/api";
import type { BacktestComparison, NameMatch, TitleMatch } from "./compare";

export interface AppraiserInputNotes {
  inscribedMarksNotes: string | null;
  provenanceNotes: string | null;
  conditionNotes: string | null;
  catalogueNotes: string | null;
}

export interface BacktestReportInput {
  lotId: string;
  lotUrl: string;
  imageDataUrl: string;
  method: string;
  appraiserInputNotes: AppraiserInputNotes;
  report: PrintAnalysisReport;
  groundTruth: ParsedLot;
  rawLot: RawLot;
  comparison: BacktestComparison;
}

const CSS = `
:root {
  --bg: #E7E5DD; --panel: #F7F6F1; --panel-2: #FDFCF9;
  --ink: #1B2430; --ink-soft: #5B6472; --ink-faint: #848C97;
  --line: rgba(27,36,48,0.14); --line-strong: rgba(27,36,48,0.28);
  --accent: #2C4A6E; --accent-soft: rgba(44,74,110,0.09);
  --ok: #3C8577; --ok-soft: rgba(60,133,119,0.10);
  --bad: #B4402E; --bad-soft: rgba(180,64,46,0.10);
  --warn: #93752E; --warn-soft: rgba(147,117,46,0.10);
  --font-display: 'Fraunces', Georgia, 'Times New Roman', serif;
  --font-body: 'Public Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14171D; --panel: #1B1F27; --panel-2: #20242D;
    --ink: #E8E6DF; --ink-soft: #A3ACB8; --ink-faint: #6E7885;
    --line: rgba(232,230,223,0.12); --line-strong: rgba(232,230,223,0.24);
    --accent: #8FB4E0; --accent-soft: rgba(143,180,224,0.12);
    --ok: #63B7A2; --ok-soft: rgba(99,183,162,0.12);
    --bad: #E08268; --bad-soft: rgba(224,130,104,0.12);
    --warn: #CBAA63; --warn-soft: rgba(203,170,99,0.12);
  }
}
:root[data-theme="dark"] {
  --bg: #14171D; --panel: #1B1F27; --panel-2: #20242D;
  --ink: #E8E6DF; --ink-soft: #A3ACB8; --ink-faint: #6E7885;
  --line: rgba(232,230,223,0.12); --line-strong: rgba(232,230,223,0.24);
  --accent: #8FB4E0; --accent-soft: rgba(143,180,224,0.12);
  --ok: #63B7A2; --ok-soft: rgba(99,183,162,0.12);
  --bad: #E08268; --bad-soft: rgba(224,130,104,0.12);
  --warn: #CBAA63; --warn-soft: rgba(203,170,99,0.12);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 40px 24px 80px; }
.masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; margin-bottom: 16px; flex-wrap: wrap; }
.masthead h1 { font-family: var(--font-display); font-weight: 600; font-size: 28px; letter-spacing: -0.01em; margin: 0; }
.masthead a { color: var(--accent); }
.badge { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.02em; border: 1px solid var(--line-strong); border-radius: 3px; padding: 3px 8px; color: var(--ink-soft); white-space: nowrap; }
.verdict { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-radius: 4px; margin-bottom: 28px; font-family: var(--font-mono); font-size: 13px; }
.verdict.consistent { background: var(--ok-soft); border: 1px solid var(--ok); color: var(--ok); }
.verdict.material_differences_found { background: var(--bad-soft); border: 1px solid var(--bad); color: var(--bad); }
.verdict .big { font-family: var(--font-display); font-size: 17px; font-weight: 600; }
.diffs { list-style: none; margin: 0 0 28px; padding: 0; }
.diffs li { background: var(--bad-soft); border-left: 3px solid var(--bad); padding: 8px 14px; margin-bottom: 6px; font-size: 13.5px; border-radius: 0 4px 4px 0; }
.exhibit { display: grid; grid-template-columns: minmax(240px, 340px) 1fr; gap: 28px; margin-bottom: 36px; align-items: start; }
@media (max-width: 800px) { .exhibit { grid-template-columns: 1fr; } }
.plate { border: 1px solid var(--line-strong); background: var(--panel-2); }
.plate img { display: block; width: 100%; height: auto; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--line); background: var(--panel); }
@media (max-width: 800px) { .compare-grid { grid-template-columns: 1fr; } }
.compare-col { padding: 16px 20px; }
.compare-col + .compare-col { border-left: 1px solid var(--line); }
@media (max-width: 800px) { .compare-col + .compare-col { border-left: none; border-top: 1px solid var(--line); } }
.compare-col h2 { font-family: var(--font-display); font-weight: 600; font-size: 16px; margin: 0 0 12px; }
.compare-col .sub { font-size: 11px; color: var(--ink-faint); font-family: var(--font-mono); margin: -8px 0 14px; }
.field { padding: 9px 0; border-top: 1px solid var(--line); }
.field:first-of-type { border-top: none; }
.field .label { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 3px; }
.field .value { font-size: 14px; }
.field .conf { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); margin-left: 6px; }
.match-tag { display: inline-block; font-family: var(--font-mono); font-size: 10.5px; padding: 2px 7px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }
.match-tag.exact, .match-tag.high, .match-tag.match { background: var(--ok-soft); color: var(--ok); }
.match-tag.partial { background: var(--warn-soft); color: var(--warn); }
.match-tag.none, .match-tag.low, .match-tag.material_difference { background: var(--bad-soft); color: var(--bad); }
.match-tag.no_data { background: var(--line); color: var(--ink-faint); }
.section { margin-top: 28px; }
.section h2 { font-family: var(--font-display); font-weight: 600; font-size: 18px; margin: 0 0 10px; }
.prose { border: 1px solid var(--line); background: var(--panel); padding: 14px 18px; font-size: 13.5px; color: var(--ink-soft); white-space: pre-wrap; }
.footer { margin-top: 40px; font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); }
`;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function matchTag(label: string, cls: NameMatch | TitleMatch | string): string {
  return `<span class="match-tag ${esc(cls)}">${esc(label)}</span>`;
}

function money(v: number | null, currency: string): string {
  if (v == null) return "—";
  return `${currency} ${v.toLocaleString()}`;
}

const NOTES_LABELS: Record<keyof AppraiserInputNotes, string> = {
  inscribedMarksNotes: "Inscribed marks & text",
  provenanceNotes: "Provenance & ownership",
  conditionNotes: "Condition",
  catalogueNotes: "Catalogue / literature refs",
};

function notesGivenHtml(notes: AppraiserInputNotes): string {
  const entries = (Object.keys(NOTES_LABELS) as (keyof AppraiserInputNotes)[])
    .map((k) => [NOTES_LABELS[k], notes[k]] as const)
    .filter(([, v]) => v);
  if (entries.length === 0) {
    return `<span style="color:var(--ink-faint);font-style:italic;">Nothing extracted from this lot's catalogue text — Stage 1c ran with no notes.</span>`;
  }
  return entries.map(([label, v]) => `<strong>${esc(label)}:</strong> ${esc(v)}`).join("\n\n");
}

/** Stage 1c's own extraction, if the pipeline ran it (only FourStageAppraiser does).
 *  Interesting mainly for claimedAttribution — did text evidence alone (inscriptions/
 *  provenance/catalogue refs, never the artist's name itself) let it guess the artist? */
function stage1cSectionHtml(report: PrintAnalysisReport): string {
  const s1c = report.stage1cResult as any;
  if (!s1c) return "";
  const attr = s1c.claimedAttribution;
  const attrLine =
    attr && attr.status !== "absent"
      ? `${esc(attr.artist ?? "—")} / ${esc(attr.title ?? "—")} <span class="match-tag ${attr.status === "documented_fact" ? "match" : "partial"}">${esc(attr.status)}</span> <span class="conf">from ${esc(attr.sourceField ?? "?")}</span>`
      : `<span style="color:var(--ink-faint);font-style:italic;">no attribution claim found in the notes</span>`;
  const refs = (s1c.catalogueReferences ?? []).map((r: any) => r.ref).join(", ") || "—";
  return `
<div class="section">
  <h2>Stage 1c extraction (from the notes above, text-only)</h2>
  <div class="prose">
    <strong>Claimed attribution:</strong> ${attrLine}
    <br><strong>Catalogue references:</strong> ${esc(refs)}
    <br><strong>Extraction confidence:</strong> ${((s1c.overallExtractionConfidence ?? 0) * 100).toFixed(0)}%
  </div>
</div>`;
}

export function buildBacktestReport(input: BacktestReportInput): string {
  const { lotId, lotUrl, imageDataUrl, method, appraiserInputNotes, report, groundTruth, rawLot, comparison } = input;

  const verdictLabel =
    comparison.overallVerdict === "consistent" ? "Consistent with catalogue" : "Material differences found";

  const diffsHtml =
    comparison.materialDifferences.length > 0
      ? `<ul class="diffs">${comparison.materialDifferences.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
      : "";

  const appEstimate = report.auctionEstimate
    ? `${money(report.auctionEstimate.lowEstimate, report.auctionEstimate.currency)} – ${money(report.auctionEstimate.highEstimate, report.auctionEstimate.currency)}`
    : "—";
  const auctionEstimate = `${money(rawLot.low_estimate, "GBP")} – ${money(rawLot.high_estimate, "GBP")}`;

  const techniquesHtml = (report.techniques ?? [])
    .map((t) => `${esc(t.technique)} <span class="conf">${t.confidence}%</span>`)
    .join(", ") || "—";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Backtest — ${esc(lotId)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">

<div class="masthead">
  <h1>Backtest — ${esc(lotId)}</h1>
  <span class="badge">method: ${esc(method)}</span>
</div>
<div class="item-line" style="font-size:13px;color:var(--ink-soft);margin-bottom:20px;">
  Catalogue: <a href="${esc(lotUrl)}" target="_blank">${esc(lotUrl)}</a>
</div>

<div class="verdict ${esc(comparison.overallVerdict)}">
  <span class="big">${esc(verdictLabel)}</span>
</div>
${diffsHtml}

<div class="exhibit">
  <div class="plate"><img src="${imageDataUrl}" alt="Lot image"></div>
  <div class="compare-grid">
    <div class="compare-col">
      <h2>App output</h2>
      <div class="sub">image + appraiser notes below — never told the artist/title/estimate</div>

      <div class="field">
        <div class="label">Artist</div>
        <div class="value">${esc(report.likelyArtist)} <span class="conf">${report.artistConfidence}%</span></div>
      </div>
      <div class="field">
        <div class="label">Title</div>
        <div class="value">${esc(report.artworkTitle)} <span class="conf">${report.titleConfidence}%</span></div>
      </div>
      <div class="field">
        <div class="label">Period</div>
        <div class="value">${esc(report.creationPeriod)}</div>
      </div>
      <div class="field">
        <div class="label">Technique(s)</div>
        <div class="value">${techniquesHtml}</div>
      </div>
      <div class="field">
        <div class="label">Estimate</div>
        <div class="value">${esc(appEstimate)}</div>
      </div>
      <div class="field">
        <div class="label">Reproduction/poster?</div>
        <div class="value">${report.isLikelyReproductionOrPoster ? "Yes — " + esc(report.reproductionExplanation) : "No"}</div>
      </div>
    </div>

    <div class="compare-col">
      <h2>Roseberys catalogue (withheld from app)</h2>
      <div class="sub">ground truth, used only for comparison</div>

      <div class="field">
        <div class="label">Artist ${matchTag(comparison.artist.match, comparison.artist.match)}</div>
        <div class="value">${esc(groundTruth.artist ?? "(unattributed)")}${groundTruth.artistQualifier !== "certain" ? ` <span class="conf">(${esc(groundTruth.artistQualifier)})</span>` : ""}</div>
      </div>
      <div class="field">
        <div class="label">Title ${matchTag(comparison.title.match, comparison.title.match)} <span class="conf">sim ${(comparison.title.similarity * 100).toFixed(0)}%</span></div>
        <div class="value">${esc(groundTruth.title ?? "(untitled)")}</div>
      </div>
      <div class="field">
        <div class="label">Date</div>
        <div class="value">${esc(groundTruth.year ?? "—")}</div>
      </div>
      <div class="field">
        <div class="label">Medium / support</div>
        <div class="value">${esc(groundTruth.medium ?? "—")}${groundTruth.support ? ` on ${esc(groundTruth.support)}` : ""}</div>
      </div>
      <div class="field">
        <div class="label">Estimate ${matchTag(comparison.estimate.verdict, comparison.estimate.verdict)}</div>
        <div class="value">${esc(auctionEstimate)}</div>
      </div>
      <div class="field">
        <div class="label">Edition</div>
        <div class="value">${esc(groundTruth.edition ?? "—")}</div>
      </div>
    </div>
  </div>
</div>

<div class="section">
  <h2>Appraiser Input Agent (Stage 1c) — notes given to the app</h2>
  <div class="prose">${notesGivenHtml(appraiserInputNotes)}</div>
</div>

${stage1cSectionHtml(report)}

<div class="section">
  <h2>App visual description</h2>
  <div class="prose">${esc(report.visualDescription)}</div>
</div>

<div class="section">
  <h2>Catalogue description (raw)</h2>
  <div class="prose">${esc(rawLot.description.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))}</div>
</div>

<div class="footer">Generated by tests/backtest/run_backtest.ts — model: ${esc(report.modelUsed ?? method)}</div>

</div></body></html>`;
}
