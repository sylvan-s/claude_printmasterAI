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

/**
 * train_price_model.PHOTOMECH_RE / POSTER_RE (2026-09-17). Offset prints and photolithographs are
 * their own technique, "offset", unless a hand process is named first; a poster is the object,
 * not a word in an inscription or a publisher's name.
 */
const PHOTOMECH_RE = /\boffset\b|photo-?lithograph|photo-?mechanical/;
const POSTER_RE = new RegExp(
  "(?:lithographic|offset|screenprint(?:ed)?|silkscreen|exhibition|film|travel|advertising|olympic)\\s+posters?\\b"
  + "|\\bposters?\\s+(?:in colou?rs?|printed|for\\b|designed)|^\\s*posters?\\b|\\bposters?\\s*/\\s*lithograph"
  + "|lithograph(?:ic)?\\s+posters?\\b|\\bfrom the (?:unsigned |unnumbered )?poster edition");

/**
 * The attribution is the artist's own work: no qualifier, the house's unqualified "certain", the
 * graph's "direct", or "unknown". Anything else ("after", "manner of", "attributed to", "circle of",
 * "school of", "follower of", "studio of") is priced with the model's per-artist "after" column and
 * compared only with other such lots (build_priors.not_direct_mask, 2026-09-17).
 */
export function isDirectQualifier(q: string | null | undefined): boolean {
  const t = (q ?? "").trim().toLowerCase();
  return t === "" || t === "certain" || t === "direct" || t === "unknown";
}

/** train_price_model.INCISED_RE / OBJECT_RE, copied from the Python patterns verbatim (2026-09-17). */
const INCISED_RE = new RegExp("incised (?:signature|initials|with (?:the )?(?:artist's )?(?:signature|initials))|(?:signature|initials) incised");
const OBJECT_RE = new RegExp("(?:print|screenprint|serigraph|lithograph|gicl[e\u00e9]e|inkjet|pigment|multiple|relief|embroidery)\\b[^.;]{0,60}?(?<!laid )(?<!mounted )(?<!backed )(?<!lined )\\bon (?:two |three |four )?(?:cut |brushed |polished |anodi[sz]ed |powder[- ]coated |galvani[sz]ed )?(?:aluminium|aluminum|plexiglass?|perspex|acrylic (?:sheet|glass|block)|stainless steel|steel|metal|wood(?:en)? (?:panel|board|block)|plywood|mdf|glass|mirror|ceramic|porcelain|enamel|vinyl|canvas|felt|leather|silk|resin)\\b|^\\s*(?:porcelain|ceramic|enamel|bronze|cast resin|resin|painted wood|wooden block|vinyl|skateboard)\\b");

/** train_price_model.is_object: printed or made ON a non-paper object or panel, or a cast / ceramic object. */
export function isObject(text: string | null | undefined): boolean {
  return typeof text === "string" && OBJECT_RE.test(text.toLowerCase());
}

/** train_price_model.is_poster */
export function isPoster(text: string | null | undefined): boolean {
  return typeof text === "string" && POSTER_RE.test(text.toLowerCase());
}

/** train_price_model.primary_process */
export function primaryProcess(texts: (string | null | undefined)[]): string {
  const blob = blobOf(texts);
  const first = PROCESSES.find((p) => blob.includes(p)) ?? "other";
  if ((first === "lithograph" || first === "collotype" || first === "other") && PHOTOMECH_RE.test(blob)) return "offset";
  return first;
}

/** train_price_model.signature_class */
export function signatureClass(signed: boolean | string | null | undefined, text: string | null | undefined): SignatureClass {
  const t = (text ?? "").toLowerCase();
  if (/stamped signature|signature stamp|estate stamp/.test(t)) return "stamped";
  if (/signed in the plate|signed in the stone|plate[- ]signed|signed in the block/.test(t)) return "plate";
  if (/\bsigned\b/.test(t) && !/\bunsigned\b/.test(t)) return "hand";
  if (INCISED_RE.test(t)) return "hand";   // an incised signature on Plexiglas / metal / resin (2026-09-17)
  if (/\binitial(l)?ed\b/.test(t)) return "initialled";
  if (signed === true || String(signed).toLowerCase() === "true") return "hand";
  return "unsigned";
}

/**
 * The ingests' copy type — knowledge_graph/copy_type.py detect_copy_type (COPY-TYPE-1.1), shared
 * by the bonhams / forum / roseberys / swann ingests: the first proof rule matched, else
 * "numbered". Every graph lot the price model and the blend calibration learned from carries this,
 * so a lot described only by catalogue text must be classified through it too, or "numbered from
 * the edition of 100" reads as edition_unnumbered here and numbered in training (measured
 * 2026-09-16: proof class differed on 38 of 40 Forum/Roseberys parity lots). Change the two
 * together. Through COPY-TYPE-1.0 the BAT keyword was the bare substring "bon", which made 353 of
 * 512 graph BATs false (Bonnard, bonnet, Dibond, ribbon...); repaired by repair_copy_type_bat.py.
 */
const COPY_TYPE_KEYWORDS: Array<[string, string[] | null]> = [
  ["AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]],
  ["HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]],
  ["PP", ["printer's proof", "printers proof", " pp "]],
  ["BAT", null], // BAT_PATTERNS, on the original-case text
  ["TP", ["trial proof", " tp "]],
];
// Python's (?<!\w)/(?!\w) are Unicode-aware; JS \b is not, so the boundaries are spelled out.
const W = "[\\p{L}\\p{N}_]";
const BAT_PATTERNS = [
  new RegExp(`(?<!${W})bon[\\s-]*[àáâa][\\s-]*tir(?:er|é|e)(?!${W})`, "iu"),
  // "B.A.T. Suisse SA" is a Geneva publisher, not an annotation.
  new RegExp(`(?<!${W})B\\.\\s?A\\.\\s?T(?!${W})(?!\\.?\\s*Suisse)\\.?`, "iu"),
  new RegExp(`(?<!${W})(?:BAT|BaT)(?!${W})`, "u"),
];
export function detectCopyType(...texts: (string | null | undefined)[]): string {
  const raw = texts.filter(Boolean).join(" ");
  const t = ` ${raw} `.toLowerCase();
  for (const [label, kws] of COPY_TYPE_KEYWORDS) {
    if (kws === null ? BAT_PATTERNS.some((re) => re.test(raw)) : kws.some((k) => t.includes(k))) return label;
  }
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
const NUMBERED_RE = /\b(?:numbered|no\.)\s*(?:in pencil\s*)?['"\u2018\u2019\u201c\u201d]?\d+\s*\/\s*(\d{1,3}(?:,\d{3})+|\d{1,5})\b(?!\s*(?:mm\b|cm\b|["\u201d]))/i;
const EDITION_OF_RE = /\bedition of\s+(?:approximately\s+|approx\.\s*|about\s+|circa\s+|c\.\s*|ca\.\s*)?(\d{1,3}(?:,\d{3})+|\d{1,5})\b/i;
const ONE_OF_RE = /\bone of\s+(?:approximately\s+|approx\.\s*|about\s+|circa\s+|c\.\s*|ca\.\s*)?(\d{1,3}(?:,\d{3})+|\d{1,5})\s+(?:impressions|copies|examples)\b/i;

/** train_price_model.edition_size — declared when positive, else "numbered n/N", "edition of N", "one of N impressions". */
export function editionSizeOf(declared: number | null | undefined, text: string | null | undefined): number | null {
  if (declared != null && Number.isFinite(declared) && declared > 0) return declared;
  const t = text ?? "";
  for (const rx of [NUMBERED_RE, EDITION_OF_RE, ONE_OF_RE]) {
    const m = t.match(rx);
    const n = m ? Number(m[1].replace(/,/g, "")) : 0;   // "edition of 1,000" is 1000, not 1
    if (n > 0) return n;
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
    poster: isPoster(c.rawMedium),
    object: isObject(c.rawMedium),
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
    poster: isPoster(lot.text),
    object: isObject(lot.text),
  };
}
