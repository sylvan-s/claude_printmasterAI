/**
 * price_attrs.ts must classify a record exactly as train_price_model.py does — the elasticities
 * were fitted on the Python's levels. Hand cases first (each one pins a rule or a quirk), then,
 * when the trainer's export CSV is present, every row of it is classified by both sides and
 * any disagreement fails the run.
 *
 *   npm run test:price-attrs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  signatureClass, proofClass, editionSizeOf, dimsCm, primaryProcess, isPoster, isObject, priceAttrsOfComparable, priceAttrsOfLot,
} from "../../src/appraisal/knowledge_graph/price_attrs";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log("signatureClass");
eq("stamped beats signed", signatureClass(true, "Signed with the estate stamp"), "stamped");
eq("plate-signed", signatureClass(true, "etching, signed in the plate"), "plate");
eq("hand from text", signatureClass(null, "lithograph, signed and numbered 12/50 in pencil"), "hand");
eq("unsigned word blocks hand", signatureClass(true, "unsigned, as issued"), "hand"); // flag wins after the text test — trainer quirk
eq("unsigned word, flag false", signatureClass(false, "unsigned, as issued"), "unsigned");
eq("initialled", signatureClass(false, "initialled in pencil"), "initialled");
eq("flag only", signatureClass(true, null), "hand");
eq("nothing", signatureClass(null, ""), "unsigned");
eq("incised signature is hand (2026-09-17)", signatureClass(null, "screenprint on Plexiglas, with incised signature and date"), "hand");
eq("signature incised is hand", signatureClass(null, "screenprint on stainless steel, with the artist's signature incised"), "hand");

console.log("proofClass");
eq("A.P. case-sensitive hit", proofClass(null, "lithograph, A.P."), "artist_proof");
eq("a.p. lower-case misses (trainer quirk)", proofClass(null, "lithograph, a.p. aside from the edition"), "unknown");
eq("Artist's proof capitalised misses (trainer quirk)", proofClass(null, "Artist's proof"), "unknown");
eq("artist's proof lower hits", proofClass(null, "an artist's proof aside from the edition of 50"), "artist_proof");
eq("HC", proofClass(null, "screenprint, H.C."), "hors_commerce");
eq("BAT", proofClass(null, "bon à tirer"), "trial_proof");
eq("numbered by numbered fraction", proofClass(null, "numbered 3/75"), "numbered");
eq("numbered by copyType", proofClass("numbered", "lithograph"), "numbered");
eq("AP copyType alone is NOT read (trainer reads text only)", proofClass("AP", "lithograph"), "unknown");
eq("edition unnumbered", proofClass(null, "from the edition of 200"), "edition_unnumbered");

console.log("editionSizeOf");
eq("declared wins", editionSizeOf(50, "numbered 3/75"), 50);
eq("numbered fraction", editionSizeOf(null, "numbered 3/75"), 75);
eq("edition of", editionSizeOf(0, "from the edition of approximately 300"), 300);
eq("none", editionSizeOf(null, "lithograph"), null);
// 2026-09-17: a bare fraction is dimensions, never an edition
eq("inch fraction is not an edition", editionSizeOf(null, "Offset lithographic poster, 1966, 735 x 545mm (29 x 21 1/2in)"), null);
eq("fraction before 'one of approximately 50'", editionSizeOf(null, "Etching, signed, 5/8 plate mark, one of approximately 50 impressions"), 50);
eq("numbered beats a later edition of", editionSizeOf(null, "signed and numbered 12/50 in pencil (there was also an unsigned edition of 500)"), 50);
eq("numbered in pencil n/N", editionSizeOf(null, "numbered in pencil 3/8, 250 x 200mm (9 7/8 x 7 7/8in)"), 8);
eq("No. n/N", editionSizeOf(null, "screenprint, No. 45/250"), 250);
eq("edition of approximately", editionSizeOf(null, "from an edition of approximately 50, printed by Ron Fuller"), 50);
eq("edition of c.", editionSizeOf(null, "from the edition of c. 100"), 100);
eq("zero is not an edition", editionSizeOf(null, "numbered 0/0"), null);
// 2026-09-17: thousands separators
eq("edition of 1,000", editionSizeOf(null, "an artist's proof, aside from the edition of 1,000"), 1000);
eq("numbered n/1,000", editionSizeOf(null, "signed and numbered 441/1,000 in pencil"), 1000);
eq("comma after a small number is punctuation", editionSizeOf(null, "from the edition of 50, printed by Mourlot"), 50);
eq("numbering beats a later edition of 5,000", editionSizeOf(null, "numbered 12/50 (there was also an unsigned edition of 5,000)"), 50);
eq("dims fraction is not 'numbered'", proofClass(null, "offset poster, 735 x 545mm (29 x 21 1/2in)"), "unknown");
eq("numbered wording is numbered", proofClass(null, "signed and numbered 21/30 in pencil"), "numbered");

console.log("dimsCm");
eq("cm string", dimsCm("30.0x34.0cm"), [30, 34]);
eq("mm", dimsCm("300 x 340 mm"), [30, 34]);
eq("inches", dimsCm("10 x 12 in"), [25.4, 30.48]);
eq("first parseable wins (plate before sheet)", dimsCm(null, "20x25cm", "50x60cm"), [20, 25]);
eq("out of range skipped", dimsCm("500x600cm", "50x60cm"), [50, 60]);
eq("nothing", dimsCm("etching"), null);

console.log("primaryProcess");
eq("first of PROCESSES wins", primaryProcess(["Etching and aquatint"]), "aquatint");
eq("technique names count", primaryProcess(["Screenprint", "lithograph"]), "lithograph");
eq("other", primaryProcess(["Mixed media"]), "other");
// 2026-09-17: photomechanical prints are their own technique unless a hand process is named first
eq("offset lithograph is offset", primaryProcess(["Offset lithograph"], ), "offset");
eq("graph technique + text", primaryProcess(["Lithograph", "offset lithograph printed in colours"]), "offset");
eq("photolithograph is offset", primaryProcess(["Photo-lithograph printed in colours"]), "offset");
eq("etching with photolithograph stays etching", primaryProcess(["Etching with photolithograph printed in colours"]), "etching");
eq("hand lithograph stays lithograph", primaryProcess(["Lithograph printed in colours, printed by Mourlot"]), "lithograph");

console.log("isPoster");
eq("offset lithographic poster", isPoster("offset lithographic poster in colours"), true);
eq("color lithograph poster", isPoster("Color lithograph poster, signed in ink, from the edition of 5000"), true);
eq("from the poster edition", isPoster("Lithograph printed in colours, 1974, from the poster edition, numbered 867/1500"), true);
eq("another poster edition mentioned", isPoster("Screenprint, signed and numbered 31/200 (there was also an unsigned poster edition of 3999)"), false);
eq("publisher named Poster", isPoster("Screenprint, published by List Art Poster and H.K.L. Ltd."), false);
eq("inscription", isPoster("Lithograph, inscribed 'BAM poster HAMLET'"), false);
eq("null", isPoster(null), false);

console.log("isObject");
eq("giclee on aluminium panel", isObject("Laminated giclée print in colours, 2021, on aluminium composite panel"), true);
eq("screenprint on canvas", isObject("Screenprint in colors on canvas, signed in ink"), true);
eq("porcelain plate", isObject("Porcelain plate with screenprint in colours"), true);
eq("paper print laid on linen", isObject("Lithograph in colors on two sheets on wove paper, laid on linen"), false);
eq("photograph mounted on aluminum", isObject("Platinum-palladium print, flush-mounted on aluminum"), false);
eq("painting on canvas", isObject("Acrylic and spraypaint on canvas"), false);
eq("print on paper", isObject("Lithograph in colours on Arches wove paper"), false);

console.log("priceAttrsOfComparable / priceAttrsOfLot");
eq("comp", priceAttrsOfComparable({
  techniques: ["Etching"], signed: true, editionSize: null, rawMedium: "etching, signed and numbered 12/50, sheet 30x40cm",
  copyType: "numbered", plateDimensions: null, imageDimensions: null, sheetDimensions: "30.0x40.0cm",
}), { signature: "hand", proof: "numbered", editionSize: 50, areaCm2: 1200, process: "etching", poster: false, object: false });
eq("lot with structured dims", priceAttrsOfLot({ text: "lithograph in colours, signed", signed: true, editionSize: 75, widthCm: 20, heightCm: 30 }),
  { signature: "hand", proof: "unknown", editionSize: 75, areaCm2: 600, process: "lithograph", poster: false, object: false });
eq("lot falls back to text dims", priceAttrsOfLot({ text: "woodcut, 10 x 12 cm", signed: false }),
  { signature: "unsigned", proof: "unknown", editionSize: null, areaCm2: 120, process: "woodcut", poster: false, object: false });

// ── cross-check against the Python on the trainer's own export, when present ──
const EXPORT = "knowledge_graph/pricing_ml/data/all_sales.csv";
if (existsSync(EXPORT)) {
  console.log(`cross-check vs train_price_model.py on ${EXPORT}`);
  const py = `
import sys, json, pandas as pd
sys.path.insert(0, "knowledge_graph/pricing_ml")
import train_price_model as m
df = pd.read_csv("${EXPORT}")
for c in ["rawMedium","copyType","plateDims","imageDims","sheetDims"]:
    df[c] = df[c].where(df[c].notna(), None)
out = []
for _, r in df.iterrows():
    techs = json.loads(r["techniques"]) if isinstance(r["techniques"], str) else []
    ed = m.edition_size(r["editionSize"], r["rawMedium"])
    d = m.dims_cm(r["plateDims"], r["imageDims"], r["sheetDims"], r["rawMedium"])
    out.append({"id": r["sourceId"], "signature": m.signature_class(r["signed"], r["rawMedium"]), "proof": m.proof_class(r["copyType"], r["rawMedium"]),
                "editionSize": None if ed != ed else ed, "areaCm2": None if d is None else d[0]*d[1], "process": m.primary_process(techs + [r["rawMedium"]]), "poster": bool(m.is_poster(r["rawMedium"])), "object": bool(m.is_object(r["rawMedium"]))})
print(json.dumps(out))
`;
  // The trainer's own venv (scikit-learn 1.6, per pricing_ml/README.md); the system python3 is too old to import it.
  const PY = existsSync("knowledge_graph/venv-embeddings/bin/python") ? "knowledge_graph/venv-embeddings/bin/python" : "python3";
  const want = JSON.parse(execFileSync(PY, ["-c", py], { maxBuffer: 1 << 28 }).toString()) as any[];
  const rows = parseCsv(readFileSync(EXPORT, "utf8"));
  const h = rows[0];
  const byId = new Map(rows.slice(1).map((r) => [r[h.indexOf("sourceId")], Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))]));
  let mismatches = 0;
  for (const w of want) {
    const r = byId.get(String(w.id)); if (!r) continue;
    const techs = r.techniques ? JSON.parse(r.techniques) : [];
    const signed = r.signed === "True" ? true : r.signed === "False" ? false : null;
    const got = priceAttrsOfComparable({
      techniques: techs, signed, editionSize: r.editionSize ? Number(r.editionSize) : null, rawMedium: r.rawMedium || null,
      copyType: r.copyType || null, plateDimensions: r.plateDims || null, imageDimensions: r.imageDims || null, sheetDimensions: r.sheetDims || null,
    });
    const near = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
    if (got.signature !== w.signature || got.proof !== w.proof || got.process !== w.process || got.poster !== w.poster || got.object !== w.object || !near(got.editionSize, w.editionSize) || !near(got.areaCm2, w.areaCm2)) {
      if (mismatches++ < 10) console.log(`  MISMATCH ${w.id}: ts=${JSON.stringify(got)} py=${JSON.stringify(w)}`);
    }
  }
  if (mismatches) { failed++; console.log(`  FAIL ${mismatches} of ${want.length} rows classified differently from the Python`); }
  else { passed++; console.log(`  ${want.length} rows agree`); }
} else {
  console.log(`(no ${EXPORT} — Python cross-check skipped)`);
}

function parseCsv(t: string): string[][] {
  const rows: string[][] = []; let f = "", row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
