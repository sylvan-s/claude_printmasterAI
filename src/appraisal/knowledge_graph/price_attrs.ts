/**
 * price_attrs — the attribute levels the pricing model was FITTED on, derived from a record
 * the same way knowledge_graph/pricing_ml/train_price_model.py derives them.
 *
 * `adjustmentBetween` (artist_price_profile.ts) multiplies a same-work comp's hammer by the
 * artist's elasticities over the attributes that differ between the comp and the lot. That
 * only means what the model meant if both sides are classified by the SAME rules the trainer
 * used: signature class from the medium text first and the `signed` flag second; proof class
 * from the medium text, then `copyType == "numbered"`; edition size declared-else-parsed;
 * dimensions as the first parseable "W x H" over plate, image, sheet, then the medium text
 * (that order is the trainer's — plate first, not sheet); process as the first of the ten
 * process words found in the technique names plus the medium text.
 *
 * Every function here is a line-for-line port of the Python, quirks included (the proof
 * regexes on "A.P." / "E.A." / "H.C." are case-sensitive in the trainer, so they are here).
 * A level the trainer would have given a record is the level the multiplier is valid for;
 * "improving" a rule on one side would apply a coefficient to a population it was not
 * learned on. Change the Python and this file together, and re-run build_priors.py.
 *
 * Pure: no I/O.
 */
import type { PriceAttrs, ProofClass, SignatureClass } from "./artist_price_profile.js";
import type { AuctionComparable } from "./query_comparables.js";

/** train_price_model.PROCESSES — order matters: first hit wins. */
export const PROCESSES = ["linocut", "aquatint", "drypoint", "etching", "engraving", "lithograph", "woodcut", "pochoir", "screenprint", "collotype"] as const;

const blobOf = (texts: (string | null | undefined)[]): string => texts.filter((t): t is string => typeof t === "string").join(" ").toLowerCase();

/** train_price_model.primary_process */
export function primaryProcess(texts: (string | null | undefined)[]): string {
  const blob = blobOf(texts);
  for (const p of PROCESSES) if (blob.includes(p)) return p;
  return "other";
}

/** train_price_model.signature_class */
export function signatureClass(signed: boolean | string | null | undefined, text: string | null | undefined): SignatureClass {
  const t = (text ?? "").toLowerCase();
  if (/stamped signature|signature stamp|estate stamp/.test(t)) return "stamped";
  if (/signed in the plate|signed in the stone|plate[- ]signed|signed in the block/.test(t)) return "plate";
  if (/\bsigned\b/.test(t) && !/\bunsigned\b/.test(t)) return "hand";
  if (/\binitial(l)?ed\b/.test(t)) return "initialled";
  if (signed === true || String(signed).toLowerCase() === "true") return "hand";
  return "unsigned";
}

/**
 * The ingests' copy type (bonhams_ingest / forum_ingest / roseberys_ingest detect_copy_type,
 * identical keyword tables): the first proof keyword found, else "numbered". Every graph lot the
 * price model and the blend calibration learned from carries this, so a lot described only by
 * catalogue text must be classified through it too, or "numbered from the edition of 100" reads
 * as edition_unnumbered here and numbered in training (measured 2026-09-16: proof class differed
 * on 38 of 40 Forum/Roseberys parity lots). Mirrored faithfully, including the bare "bon" BAT
 * keyword that also matches "carbon" or "ribbon" — logged, not fixed here, so the lot is classed
 * the way its training neighbours were.
 */
const COPY_TYPE_KEYWORDS: Array<[string, string[]]> = [
  ["AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]],
  ["HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]],
  ["PP", ["printer's proof", "printers proof", " pp "]],
  ["BAT", ["bon", " bat "]],
  ["TP", ["trial proof", " tp "]],
];
export function detectCopyType(...texts: (string | null | undefined)[]): string {
  const t = ` ${texts.filter(Boolean).join(" ")} `.toLowerCase();
  for (const [label, kws] of COPY_TYPE_KEYWORDS) if (kws.some((k) => t.includes(k))) return label;
  return "numbered";
}

/** train_price_model.proof_class — the first three tests are case-SENSITIVE, as in the trainer. */
export function proofClass(copyType: string | null | undefined, text: string | null | undefined): ProofClass {
  const raw = text ?? "";
  const t = raw.toLowerCase();
  if (/artist'?s proof|épreuve d'artiste|epreuve d'artiste|\bE\.?A\.?\b|\bA\.?P\.?\b/.test(raw)) return "artist_proof";
  if (/hors commerce|\bH\.?C\.?\b/.test(raw)) return "hors_commerce";
  if (/trial proof|épreuve d'essai|epreuve d'essai|bon à tirer|bon a tirer|\bB\.?A\.?T\.?\b/.test(raw)) return "trial_proof";
  if (NUMBERED_RE.test(t) || String(copyType ?? "").toLowerCase() === "numbered") return "numbered";
  if (/from the edition of|edition of \d/.test(t)) return "edition_unnumbered";
  return "unknown";
}

/**
 * Edition wording, mirroring train_price_model.py (2026-09-17). A bare "n/N" is NOT an edition: in
 * catalogue text it is almost always an inch fraction ("19 1/2 x 15 1/4in"), which gave 6,257
 * training rows editions of 2/4/8/16. Only explicit wording counts, in this order.
 */
const NUMBERED_RE = /\b(?:numbered|no\.)\s*(?:in pencil\s*)?['"\u2018\u2019\u201c\u201d]?\d+\s*\/\s*(\d{1,5})\b(?!\s*(?:mm\b|cm\b|["\u201d]))/i;
const EDITION_OF_RE = /\bedition of\s+(?:approximately\s+|approx\.\s*|about\s+|circa\s+|c\.\s*|ca\.\s*)?(\d{1,5})\b/i;
const ONE_OF_RE = /\bone of\s+(?:approximately\s+|approx\.\s*|about\s+|circa\s+|c\.\s*|ca\.\s*)?(\d{1,5})\s+(?:impressions|copies|examples)\b/i;

/** train_price_model.edition_size — declared when positive, else "numbered n/N", "edition of N", "one of N impressions". */
export function editionSizeOf(declared: number | null | undefined, text: string | null | undefined): number | null {
  if (declared != null && Number.isFinite(declared) && declared > 0) return declared;
  const t = text ?? "";
  for (const rx of [NUMBERED_RE, EDITION_OF_RE, ONE_OF_RE]) {
    const m = t.match(rx);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}

const DIM_RE = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in)?/i;

/** train_price_model.dims_cm — first parseable "W x H" in cm, both sides in (1, 400). */
export function dimsCm(...values: (string | null | undefined)[]): [number, number] | null {
  for (const v of values) {
    if (!v) continue;
    const m = String(v).match(DIM_RE);
    if (!m) continue;
    let a = Number(m[1]), b = Number(m[2]);
    const unit = (m[3] ?? "cm").toLowerCase();
    if (unit === "mm") { a /= 10; b /= 10; }
    else if (unit === "in") { a *= 2.54; b *= 2.54; }
    if (a > 1 && a < 400 && b > 1 && b < 400) return [a, b];
  }
  return null;
}

/** The pricing-model attributes of a graph comparable, classified by the trainer's rules. */
export function priceAttrsOfComparable(c: Pick<AuctionComparable, "techniques" | "signed" | "editionSize" | "rawMedium" | "copyType" | "plateDimensions" | "imageDimensions" | "sheetDimensions">): PriceAttrs {
  const dims = dimsCm(c.plateDimensions, c.imageDimensions, c.sheetDimensions, c.rawMedium);
  return {
    signature: signatureClass(c.signed, c.rawMedium),
    proof: proofClass(c.copyType, c.rawMedium),
    editionSize: editionSizeOf(c.editionSize, c.rawMedium),
    areaCm2: dims ? dims[0] * dims[1] : null,
    process: primaryProcess([...(c.techniques ?? []), c.rawMedium]),
  };
}

/**
 * The same attributes for a lot described by catalogue fields (a house listing, the backtest
 * CSV, or a Stage 1c extraction). `text` is the medium / edition text as printed; explicit
 * width/height in cm win over anything parsed from the text, as the trainer's structured
 * dimension fields did.
 */
export function priceAttrsOfLot(lot: {
  text?: string | null;
  techniques?: string[] | null;
  signed?: boolean | null;
  editionSize?: number | null;
  copyType?: string | null;
  widthCm?: number | null;
  heightCm?: number | null;
}): PriceAttrs {
  let area: number | null = null;
  if (lot.widthCm != null && lot.heightCm != null && lot.widthCm > 1 && lot.widthCm < 400 && lot.heightCm > 1 && lot.heightCm < 400) {
    area = lot.widthCm * lot.heightCm;
  } else {
    const d = dimsCm(lot.text);
    area = d ? d[0] * d[1] : null;
  }
  return {
    signature: signatureClass(lot.signed, lot.text),
    proof: proofClass(lot.copyType, lot.text),
    editionSize: editionSizeOf(lot.editionSize, lot.text),
    areaCm2: area,
    process: primaryProcess([...(lot.techniques ?? []), lot.text]),
  };
}
