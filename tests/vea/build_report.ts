// Renders a VisualExtractionResult (VEA-1.1+) as a self-contained, human-readable
// HTML report: one confidence bar per field, plus every box_2d overlaid on the
// primary image. Generic over whatever the result actually contains — no
// hardcoded artwork-specific values.
//
// Used by run_vea_trial.ts. See README.md for the CLI.

import type { VisualExtractionResult } from "../../src/types";

export interface ReportMeta {
  title: string;           // e.g. "LOT43 — item on file"
  itemNote: string;        // e.g. "catalogued as Julian Trevelyan, “Windsor Castle” (auction record, not asserted by VEA)"
  model: string;           // e.g. "claude-opus-4-8"
  usage?: { input_tokens?: number; output_tokens?: number; stop_reason?: string };
}

const CSS = `
:root {
  --bg: #E7E5DD; --panel: #F7F6F1; --panel-2: #FDFCF9;
  --ink: #1B2430; --ink-soft: #5B6472; --ink-faint: #848C97;
  --line: rgba(27,36,48,0.14); --line-strong: rgba(27,36,48,0.28);
  --accent: #2C4A6E; --accent-soft: rgba(44,74,110,0.09);
  --conf-low: #B4652E; --conf-mid: #93752E; --conf-high: #3C8577;
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
    --conf-low: #DB935B; --conf-mid: #CBAA63; --conf-high: #63B7A2;
  }
}
:root[data-theme="dark"] {
  --bg: #14171D; --panel: #1B1F27; --panel-2: #20242D;
  --ink: #E8E6DF; --ink-soft: #A3ACB8; --ink-faint: #6E7885;
  --line: rgba(232,230,223,0.12); --line-strong: rgba(232,230,223,0.24);
  --accent: #8FB4E0; --accent-soft: rgba(143,180,224,0.12);
  --conf-low: #DB935B; --conf-mid: #CBAA63; --conf-high: #63B7A2;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }
.masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; margin-bottom: 6px; flex-wrap: wrap; }
.masthead h1 { font-family: var(--font-display); font-weight: 600; font-size: 28px; letter-spacing: -0.01em; margin: 0; text-wrap: balance; }
.badge { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.02em; border: 1px solid var(--line-strong); border-radius: 3px; padding: 3px 8px; color: var(--ink-soft); white-space: nowrap; }
.badge.accent { border-color: var(--accent); color: var(--accent); }
.item-line { font-size: 13.5px; color: var(--ink-soft); margin: 10px 0 28px; }
.item-line strong { color: var(--ink); font-weight: 600; }
.callout { display: flex; gap: 10px; align-items: flex-start; background: var(--accent-soft); border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 0 4px 4px 0; font-size: 13px; color: var(--ink-soft); margin-bottom: 32px; }
.callout b { color: var(--ink); }
.exhibit { display: grid; grid-template-columns: minmax(260px, 420px) 1fr; gap: 28px; margin-bottom: 36px; align-items: start; }
@media (max-width: 720px) { .exhibit { grid-template-columns: 1fr; } }
.plate { position: relative; border: 1px solid var(--line-strong); background: var(--panel-2); overflow: hidden; }
.plate img { display: block; width: 100%; height: auto; }
.box { position: absolute; border: 1.5px solid var(--accent); box-shadow: 0 0 0 1px rgba(0,0,0,0.15); }
.box.region { border-style: dashed; border-color: var(--ink-faint); }
.box .tag { position: absolute; top: -1px; left: -1px; transform: translateY(-100%); background: var(--accent); color: var(--panel-2); font-family: var(--font-mono); font-size: 10px; padding: 1px 4px; line-height: 1.4; white-space: nowrap; }
.box.region .tag { background: var(--ink-faint); }
.plate-caption { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); padding: 6px 2px 0; }
.summary { display: flex; flex-direction: column; gap: 14px; }
.stat-row { display: flex; gap: 10px; flex-wrap: wrap; }
.stat { flex: 1 1 140px; border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; }
.stat .label { font-size: 10.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 6px; }
.stat .value { font-family: var(--font-mono); font-size: 18px; color: var(--ink); }
.flags { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; }
.flags .label { font-size: 10.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px; }
.flags ul { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-soft); }
.flags li { margin-bottom: 3px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 18px; }
.card { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px 20px; }
.card h2 { font-family: var(--font-display); font-weight: 600; font-size: 16.5px; margin: 0 0 3px; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.card h2 .schema-key { font-family: var(--font-mono); font-size: 10.5px; font-weight: 400; color: var(--ink-faint); letter-spacing: 0.02em; }
.card .empty { font-size: 13px; color: var(--ink-faint); font-style: italic; padding: 10px 0 2px; }
.field { padding: 10px 0; border-top: 1px solid var(--line); }
.field:first-of-type { border-top: none; margin-top: 8px; }
.field-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 5px; }
.field-name { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }
.field-val { font-size: 13.5px; color: var(--ink); text-align: right; }
.field-note { font-size: 12.5px; color: var(--ink-soft); margin-top: 3px; }
.conf { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.conf-track { flex: 1; height: 5px; background: var(--line); border-radius: 2px; overflow: hidden; }
.conf-fill { height: 100%; border-radius: 2px; }
.conf-num { font-family: var(--font-mono); font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--ink-soft); width: 32px; text-align: right; }
.conf-label { font-family: var(--font-mono); font-size: 9.5px; color: var(--ink-faint); letter-spacing: 0.03em; }
.sub-item { border: 1px solid var(--line); padding: 10px 12px; margin-bottom: 10px; background: var(--panel-2); }
.sub-item:last-child { margin-bottom: 0; }
.sub-item .sub-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.pill-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.pill { font-family: var(--font-mono); font-size: 10.5px; border: 1px solid var(--line-strong); padding: 2px 7px; border-radius: 2px; color: var(--ink-soft); }
.foot { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
`;

function esc(s: unknown): string {
  if (s === null || s === undefined) return "&mdash;";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function confColor(v: number): string {
  if (v < 0.4) return "var(--conf-low)";
  if (v < 0.7) return "var(--conf-mid)";
  return "var(--conf-high)";
}
function confTier(v: number): string {
  if (v < 0.4) return "low";
  if (v < 0.7) return "moderate";
  return "high";
}
function confBar(value: number | undefined | null, label: string): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "";
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return `<div class="conf">
      <div class="conf-track"><div class="conf-fill" style="width:${pct}%;background:${confColor(value)}"></div></div>
      <div class="conf-num">${value.toFixed(2)}</div>
    </div><div class="conf-label">${esc(label)} &middot; ${confTier(value)}</div>`;
}

function field(name: string, value: unknown, confidence?: number | null, confLabel?: string, note?: string): string {
  let html = `<div class="field"><div class="field-head"><div class="field-name">${esc(name)}</div><div class="field-val">${value}</div></div>`;
  if (note) html += `<div class="field-note">${esc(note)}</div>`;
  if (confidence !== undefined) html += confBar(confidence ?? undefined, confLabel || name.toLowerCase());
  html += "</div>";
  return html;
}

function card(title: string, schemaKey: string, inner: string): string {
  return `<div class="card"><h2>${esc(title)}<span class="schema-key">${esc(schemaKey)}</span></h2>${inner}</div>`;
}

function emptyCard(title: string, schemaKey: string, message: string): string {
  return card(title, schemaKey, `<div class="empty">${esc(message)}</div>`);
}

// ---- overlay boxes ---------------------------------------------------------

interface OverlayBox {
  box_2d: number[];
  label: string;
  region?: boolean; // dashed style for boundary/region boxes vs discrete evidence points
}

function collectOverlayBoxes(vea: VisualExtractionResult): OverlayBox[] {
  const boxes: OverlayBox[] = [];
  const onPrimary = (sourceImage?: string) => !sourceImage || sourceImage === "PRIMARY_SCAN";

  for (const s of vea.titleInscriptions || []) {
    if (s.box_2d && onPrimary(s.sourceImage)) boxes.push({ box_2d: s.box_2d, label: `${s.id} title` });
  }
  for (const s of vea.signatures || []) {
    if (s.box_2d && onPrimary(s.sourceImage)) boxes.push({ box_2d: s.box_2d, label: `${s.id} signature` });
  }
  for (const e of vea.editionInfo || []) {
    if (e.box_2d && onPrimary(e.sourceImage)) boxes.push({ box_2d: e.box_2d, label: `${e.id} edition` });
  }
  for (const d of (vea.condition?.defects || [])) {
    if (d.box_2d && onPrimary(d.sourceImage)) boxes.push({ box_2d: d.box_2d, label: `${d.id} defect` });
  }
  for (const st of vea.stampsAndLabels || []) {
    if (st.box_2d && onPrimary(st.sourceImage)) boxes.push({ box_2d: st.box_2d, label: `${st.id} stamp` });
  }
  for (const h of vea.visualEvidenceHighlights || []) {
    if (h.box_2d && onPrimary(h.sourceImage)) {
      const isRegion = /boundary|plate edge|region/i.test(h.label || "");
      boxes.push({ box_2d: h.box_2d, label: `${h.id ?? "VEH"} ${h.label}`, region: isRegion });
    }
  }
  return boxes;
}

function renderOverlay(boxes: OverlayBox[]): string {
  return boxes
    .map((b) => {
      const [ymin, xmin, ymax, xmax] = b.box_2d;
      const left = (xmin / 10).toFixed(1);
      const top = (ymin / 10).toFixed(1);
      const width = ((xmax - xmin) / 10).toFixed(1);
      const height = ((ymax - ymin) / 10).toFixed(1);
      return `<div class="box${b.region ? " region" : ""}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"><span class="tag">${esc(b.label)}</span></div>`;
    })
    .join("\n");
}

// ---- section renderers ------------------------------------------------------

function renderImageAuthenticity(vea: VisualExtractionResult): string {
  const a = vea.imageAuthenticity;
  if (!a) return emptyCard("Image Authenticity", "imageAuthenticity", "Not present in result.");
  let inner = field("Classification", esc(a.classification), a.classificationConfidence, "classificationConfidence");
  inner += field("Confidence penalty applied", `&minus;${a.confidencePenaltyApplied ?? 0}`);
  const indicators = [...(a.physicalPrintIndicatorsFound || []), ...(a.reproductionIndicatorsFound || [])];
  if (indicators.length) {
    inner += `<div class="field-note"><b>Indicators:</b> ${indicators.map((i: any) => esc(`${i.indicator} (${i.description})`)).join("; ")}</div>`;
  }
  if (a.reliabilityStatement) inner += `<div class="field-note"><b>Reliability:</b> ${esc(a.reliabilityStatement)}</div>`;
  inner += field("Halt / human review required", `${a.haltRecommended} / ${a.humanReviewRequired}`);
  return card("Image Authenticity", "imageAuthenticity", inner);
}

function renderTitleInscriptions(vea: VisualExtractionResult): string {
  const items = vea.titleInscriptions || [];
  if (!items.length) return emptyCard("Title Inscriptions", "titleInscriptions[]", "No title inscription found in margin, cartouche, or label.");
  const inner = items
    .map((t: any) => {
      let s = `<div class="sub-item"><div class="sub-title">${esc(t.id)} &middot; ${esc(t.classification)}</div>`;
      s += `<div class="field-note">&ldquo;${esc(t.transcription)}&rdquo; &middot; ${esc(t.medium)} &middot; ${esc(t.location)}</div>`;
      s += confBar(t.titleConfidence, "titleConfidence");
      s += "</div>";
      return s;
    })
    .join("\n");
  return card("Title Inscriptions", "titleInscriptions[]", inner);
}

function renderSignatures(vea: VisualExtractionResult): string {
  const items = vea.signatures || [];
  if (!items.length) return emptyCard("Signatures", "signatures[]", "No signature, monogram, or stamp found.");
  const inner = items
    .map((s: any) => {
      let h = `<div class="sub-item"><div class="sub-title">${esc(s.id)} &middot; ${esc(s.type)}</div>`;
      h += `<div class="field-note">Transcription: <code>${esc(s.transcription)}</code> &middot; Medium: ${esc(s.medium)} &middot; Location: ${esc(s.location)}</div>`;
      if (s.authenticityNotes) h += `<div class="field-note">${esc(s.authenticityNotes)}</div>`;
      h += confBar(s.signatureConfidence, "signatureConfidence");
      h += "</div>";
      return h;
    })
    .join("\n");
  return card("Signatures", "signatures[]", inner);
}

function renderEditionInfo(vea: VisualExtractionResult): string {
  const items = vea.editionInfo || [];
  if (!items.length) {
    return emptyCard(
      "Edition & Numbering",
      "editionInfo[]",
      vea.editionInfoAbsent ? "editionInfoAbsent: true — no edition marks found anywhere on the sheet." : "No edition marks found."
    );
  }
  const inner = items
    .map((e: any) => {
      let h = `<div class="sub-item"><div class="sub-title">${esc(e.id)} &middot; ${esc(e.type)}</div>`;
      h += `<div class="field-note">&ldquo;${esc(e.transcription)}&rdquo; &middot; ${esc(e.inscriptionMethod)} &middot; ${esc(e.location)}</div>`;
      h += confBar(e.editionConfidence, "editionConfidence");
      h += "</div>";
      return h;
    })
    .join("\n");
  return card("Edition & Numbering", "editionInfo[]", inner);
}

function renderTechniques(vea: VisualExtractionResult): string {
  const items = vea.printingTechniques || [];
  if (!items.length) return emptyCard("Printing Technique", "printingTechniques[]", "No technique identified.");
  const inner = items
    .map((t: any) => {
      let h = `<div class="sub-item"><div class="sub-title">${esc(t.technique)} &middot; ${esc(t.family)}</div>`;
      if (t.visualEvidence?.length) h += `<div class="field-note">Evidence: ${t.visualEvidence.map(esc).join("; ")}</div>`;
      if (t.conflictingEvidence) h += `<div class="field-note"><b>Conflicting:</b> ${esc(t.conflictingEvidence)}</div>`;
      h += confBar(t.techniqueConfidence, "techniqueConfidence");
      h += "</div>";
      return h;
    })
    .join("\n");
  return card("Printing Technique", "printingTechniques[]", inner);
}

function renderPlateMarkDimensions(vea: VisualExtractionResult): string {
  const p = vea.plateMark;
  const d = vea.dimensions;
  let inner = "";
  if (p) {
    inner += field("Plate mark", `${p.present} &middot; clarity: ${esc(p.clarity)} &middot; margins: ${p.marginsEven}`, p.plateMarkConfidence, "plateMarkConfidence", p.observationNotes || undefined);
  }
  if (d) {
    const printed = d.printedImageMM ? `${d.printedImageMM.width ?? "?"} &times; ${d.printedImageMM.height ?? "?"} mm` : "&mdash;";
    const sheet = d.fullSheetMM ? `${d.fullSheetMM.width ?? "?"} &times; ${d.fullSheetMM.height ?? "?"} mm` : "&mdash;";
    inner += field("Printed image", printed);
    inner += field("Full sheet", `${sheet} (${esc(d.sourceImage)})`, d.dimensionsConfidence, "dimensionsConfidence");
  }
  if (!inner) return emptyCard("Plate Mark & Dimensions", "plateMark / dimensions", "Not present in result.");
  return card("Plate Mark & Dimensions", "plateMark / dimensions", inner);
}

function renderPaper(vea: VisualExtractionResult): string {
  const p = vea.paper;
  if (!p) return emptyCard("Paper & Support", "paper", "Not present in result.");
  let inner = field("Surface / tone / weight", `${esc(p.surfaceType)} &middot; ${esc(p.tone)} &middot; ${esc(p.weight)}`);
  inner += field("Chain lines / watermark / mounting", `${p.chainLinesVisible} / ${p.watermarkVisible} &middot; ${esc(p.mountingStatus)}`, p.paperConfidence, "paperConfidence");
  return card("Paper & Support", "paper", inner);
}

function renderCondition(vea: VisualExtractionResult): string {
  const c = vea.condition;
  if (!c) return emptyCard("Condition", "condition", "Not present in result.");
  let inner = field("Overall grade", esc(c.overallGrade), c.conditionConfidence, "conditionConfidence");
  if (c.defects?.length) {
    inner += c.defects
      .map((d: any) => {
        let h = `<div class="sub-item"><div class="sub-title">${esc(d.id)} &middot; ${esc(d.category)} &middot; ${esc(d.severity)}</div>`;
        h += `<div class="field-note">${esc(d.type)} &mdash; ${esc(d.location)}</div>`;
        h += confBar(d.defectConfidence, "defectConfidence");
        h += "</div>";
        return h;
      })
      .join("\n");
  } else {
    inner += `<div class="field-note">No defects rated above NONE severity.</div>`;
  }
  inner += field("Restoration evidence", String(c.restorationEvidence));
  return card("Condition", "condition", inner);
}

function renderInkAndColour(vea: VisualExtractionResult): string {
  const i = vea.inkAndColour;
  if (!i) return emptyCard("Ink & Colour", "inkAndColour", "Not present in result.");
  let inner = "";
  if (i.coloursPresent?.length) {
    inner += `<div class="pill-row">${i.coloursPresent.map((c: string) => `<span class="pill">${esc(c)}</span>`).join("")}</div>`;
  }
  inner += field("Mode / surface / coverage", `${esc(i.colourMode)} &middot; ${esc(i.inkSurface)} &middot; ${esc(i.inkCoverageEvenness)}`, i.inkAndColourConfidence, "inkAndColourConfidence", i.unevennesDescription || undefined);
  return card("Ink & Colour", "inkAndColour", inner);
}

function renderStamps(vea: VisualExtractionResult): string {
  const items = vea.stampsAndLabels || [];
  if (!items.length) return emptyCard("Stamps & Labels", "stampsAndLabels[]", "No gallery, publisher, or collector marks found.");
  const inner = items
    .map((s: any) => {
      let h = `<div class="sub-item"><div class="sub-title">${esc(s.id)} &middot; ${esc(s.type)}</div>`;
      h += `<div class="field-note">&ldquo;${esc(s.transcription)}&rdquo; &middot; ${esc(s.location)}</div>`;
      h += confBar(s.stampConfidence, "stampConfidence");
      h += "</div>";
      return h;
    })
    .join("\n");
  return card("Stamps & Labels", "stampsAndLabels[]", inner);
}

function renderComposition(vea: VisualExtractionResult): string {
  const c = vea.composition;
  if (!c) return emptyCard("Composition", "composition", "Not present in result.");
  let inner = field("Subject", esc(c.subjectMatter), c.compositionConfidence, "compositionConfidence");
  inner += field("Style / palette", `${esc(c.visualStyle)} &middot; ${c.numberOfColours ?? "?"} colours &mdash; ${esc(c.colourPaletteSummary)}`);
  inner += field("Boundary", `${esc(c.imageBoundary)} &middot; ${esc(c.imageToSheetRatio)}`);
  return card("Composition", "composition", inner);
}

function renderPhotographicQuality(vea: VisualExtractionResult): string {
  const q = vea.photographicQuality;
  if (!q) return emptyCard("Photographic Quality", "photographicQuality", "Not present in result.");
  let inner = field("Focus / lighting / flatness", `${esc(q.focusUniformity)} &middot; ${esc(q.lightingEvenness)} &middot; ${q.printFlat}`, q.qualityAssessmentConfidence, "qualityAssessmentConfidence");
  inner += field("Resolution", esc(q.estimatedResolution));
  if (q.additionalScansRecommended?.length) {
    inner += `<div class="field-note"><b>Recommended scans:</b> ${q.additionalScansRecommended.map((s: any) => `${esc(s.scanType)} (${esc(s.reason)})`).join("; ")}</div>`;
  }
  return card("Photographic Quality", "photographicQuality", inner);
}

// ---- entry point ------------------------------------------------------------

export function buildVeaReport(vea: VisualExtractionResult, imageDataUri: string, meta: ReportMeta): string {
  const boxes = collectOverlayBoxes(vea);
  const flags = vea.lowConfidenceFlags || [];

  const cards = [
    renderImageAuthenticity(vea),
    renderTitleInscriptions(vea),
    renderSignatures(vea),
    renderEditionInfo(vea),
    renderTechniques(vea),
    renderPlateMarkDimensions(vea),
    renderPaper(vea),
    renderCondition(vea),
    renderInkAndColour(vea),
    renderStamps(vea),
    renderComposition(vea),
    renderPhotographicQuality(vea),
  ].join("\n");

  const usageLine = meta.usage
    ? `<span>input ${meta.usage.input_tokens ?? "?"} tok &middot; output ${meta.usage.output_tokens ?? "?"} tok &middot; stop_reason: ${esc(meta.usage.stop_reason)}</span>`
    : "";

  return `<title>${esc(meta.title)} &mdash; ${esc(vea.schemaVersion)}</title>
<style>${CSS}</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<div class="wrap">
  <div class="masthead">
    <h1>${esc(meta.title)}</h1>
    <span class="badge accent">schemaVersion ${esc(vea.schemaVersion)}</span>
  </div>
  <div class="item-line">
    ${esc(meta.itemNote)} &nbsp;&middot;&nbsp; Model: <strong>${esc(meta.model)}</strong> &nbsp;&middot;&nbsp; Stage: 1a
  </div>

  <div class="exhibit">
    <div>
      <div class="plate">
        <img src="${imageDataUri}" alt="Primary scan" />
        ${renderOverlay(boxes)}
      </div>
      <div class="plate-caption">PRIMARY_SCAN &mdash; solid boxes = discrete evidence points, dashed = image-boundary region</div>
    </div>
    <div class="summary">
      <div class="stat-row">
        <div class="stat"><div class="label">Overall extraction confidence</div><div class="value">${(vea.overallExtractionConfidence ?? 0).toFixed(2)}</div></div>
        <div class="stat"><div class="label">Image classification</div><div class="value" style="font-size:13px">${esc(vea.imageAuthenticity?.classification)}</div></div>
        <div class="stat"><div class="label">Halt / human review</div><div class="value" style="font-size:13px">${vea.imageAuthenticity?.haltRecommended} / ${vea.imageAuthenticity?.humanReviewRequired}</div></div>
      </div>
      ${flags.length ? `<div class="flags"><div class="label">Low-confidence flags (${flags.length})</div><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
    </div>
  </div>

  <div class="grid">
    ${cards}
  </div>

  <div class="foot">
    <span>claude_printmasterAI &middot; VEA trial harness &middot; ${esc(vea.inspectionTimestamp)}</span>
    ${usageLine}
  </div>
</div>`;
}
