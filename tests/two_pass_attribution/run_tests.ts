/**
 * Pass/fail unit tests for src/appraisal/two_pass_attribution.ts — ADR-0010.
 *
 * No LLM calls, no network, no test framework (matches tests/routing/). Plain
 * node:assert, run via tsx.
 *
 * Run: npm run test:two-pass
 */
import assert from "node:assert/strict";
import {
  classifyArtistPass,
  passTwoGate,
  classifyWorkPass,
  sourceConfidence,
  D_VOTE_FLOOR,
  D_T_DINO_FLOOR,
  KOEUVRE_DISCRIMINATING_MIN,
  classifyImpression,
  classifyDimensionMatch,
  classifyTechniqueMatch,
  techniqueFamily,
  classifyTwoPass,
  mapTwoPassToScenario,
  normalizeName,
  nameSimilarity,
  titleSimilarity,
  titleContainment,
  TAU_TITLE_AGREE,
  SIM_ARTIST_VOTE,
} from "../../src/appraisal/two_pass_attribution";
import { Scenario } from "../../src/appraisal/routing";
import * as f from "./fixtures";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
  }
}

// ── name / title normalization ───────────────────────────────────────────────
console.log("Name & title normalization\n");

test("normalizeName flips 'Surname, First' and strips honorifics/nationality/dates", () => {
  assert.equal(normalizeName("Trevelyan, Julian Otto").key, normalizeName("Julian Otto Trevelyan").key);
  assert.equal(normalizeName("Julian Trevelyan RA").key, normalizeName("Julian Trevelyan").key);
  assert.equal(normalizeName("Julian Trevelyan (British, 1910-1988)").key, normalizeName("Julian Trevelyan").key);
});

test("nameSimilarity: reversed form matches natural form >= threshold", () => {
  assert.ok(nameSimilarity("Trevelyan, Julian Otto", "Julian Trevelyan RA") >= 0.9);
  assert.ok(nameSimilarity("Pablo Picasso", "Georges Braque") < 0.5);
});

test("titleSimilarity: cross-form title match", () => {
  assert.ok(titleSimilarity("The Great Wave off Kanagawa", "Great Wave off Kanagawa") >= 0.8);
  assert.ok(titleSimilarity("The Bathers", "The Cardplayers") < 0.5);
});

// ── PASS 1: artist decision table ────────────────────────────────────────────
console.log("\nPass 1 — Artist (A1..A11)\n");

test("A1 — V+R+A agree -> ATTRIBUTED HIGH", () => {
  const v = classifyArtistPass(f.a1_threeAgree);
  assert.equal(v.evidenceBasis, "A1");
  assert.equal(v.verdict, "attributed");
  assert.equal(v.confidence, "HIGH");
  assert.deepEqual(v.agreementSet.sort(), ["A", "R", "V"]);
});

test("A2 — n=2, ACKG corroborates on technique AND subject -> ATTRIBUTED HIGH", () => {
  const v = classifyArtistPass(f.a2_twoAgreeAckgSupport);
  assert.equal(v.evidenceBasis, "A2");
  assert.equal(v.confidence, "HIGH");
  assert.ok(v.flags.includes("corroboration:moderate:ackgOeuvreAndSubject"), v.flags.join(","));
});

test("A3 — n=2, only technique corroborates (weak) -> MEDIUM_HIGH", () => {
  const v = classifyArtistPass(f.a3_recognisedNoOeuvre);
  assert.equal(v.evidenceBasis, "A3");
  assert.equal(v.confidence, "MEDIUM_HIGH");
  assert.ok(v.flags.includes("corroboration:weak:ackgOeuvre"), v.flags.join(","));
});

test("A4 — n=2, ACKG corroborates nothing -> MEDIUM (held one band below a corroborated pair)", () => {
  const v = classifyArtistPass(f.a4_notInAckg);
  assert.equal(v.evidenceBasis, "A4");
  assert.equal(v.confidence, "MEDIUM");
  assert.ok(v.flags.includes("corroboration:none:ackgSilent"), v.flags.join(","));
  // absence lowers certainty; it must not change the verdict or unname the artist
  assert.equal(v.verdict, "attributed");
  assert.equal(v.artistName, "Obscure Printmaker");
});

test("A5 — single VEA signature -> CANDIDATE MEDIUM", () => {
  const v = classifyArtistPass(f.a5_singleVeaSignature);
  assert.equal(v.evidenceBasis, "A5");
  assert.equal(v.verdict, "candidate");
  // K_oeuvre=1 is < KOEUVRE_DISCRIMINATING_MIN, so no lift
  assert.equal(v.confidence, "MEDIUM");
});

test("A5 — low-confidence signature -> CANDIDATE LOW", () => {
  const v = classifyArtistPass(f.a5_lowConfidenceSignature);
  assert.equal(v.evidenceBasis, "A5");
  assert.equal(v.confidence, "LOW");
});

test("A6 — strong image match only -> CANDIDATE MEDIUM", () => {
  const v = classifyArtistPass(f.a6_strongImageOnly);
  assert.equal(v.evidenceBasis, "A6");
  assert.equal(v.confidence, "MEDIUM");
});

test("A7 — weak image match only -> CANDIDATE LOW", () => {
  const v = classifyArtistPass(f.a7_weakImageOnly);
  assert.equal(v.evidenceBasis, "A7");
  assert.equal(v.confidence, "LOW");
});

test("A8 — documented appraiser claim only -> CANDIDATE (lifted one band by discriminating K_oeuvre? no, count=1) MEDIUM", () => {
  const v = classifyArtistPass(f.a8_documentedAppraiserOnly);
  assert.equal(v.evidenceBasis, "A8");
  assert.equal(v.verdict, "candidate");
  assert.equal(v.confidence, "MEDIUM");
});

test("A9 — appraiser hypothesis only -> NOT ATTRIBUTED LOW", () => {
  const v = classifyArtistPass(f.a9_appraiserHypothesisOnly);
  assert.equal(v.evidenceBasis, "A9");
  assert.equal(v.verdict, "not_attributed");
});

test("A10 — V and R name different artists -> CONFLICT", () => {
  const v = classifyArtistPass(f.a10_conflict);
  assert.equal(v.evidenceBasis, "A10");
  assert.equal(v.verdict, "conflict");
  assert.ok(v.contradictingIdentities.length >= 1);
});

test("A10 — documented_fact appraiser claim vs legible VEA signature -> CONFLICT (override)", () => {
  const v = classifyArtistPass(f.a10_documentedFactVsSignature);
  assert.equal(v.evidenceBasis, "A10");
  assert.equal(v.verdict, "conflict");
});

test("A11 — no signal -> NOT ATTRIBUTED, no confidence", () => {
  const v = classifyArtistPass(f.a11_nothing);
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
  assert.equal(v.confidence, null);
});

console.log("\nPass 1 — layered rules\n");

test("hypothesis contradicting VEA does NOT force a conflict (VEA wins, n=1 -> A5)", () => {
  const v = classifyArtistPass(f.hypothesisVsVeaNotConflict);
  assert.notEqual(v.verdict, "conflict");
  assert.equal(v.artistName, "Barbara Hepworth");
});

test("Stage 1b hit inconsistent with VEA is dropped from the vote (V-only -> A5, not A1/A2)", () => {
  const v = classifyArtistPass(f.rInconsistentDropped);
  assert.equal(v.evidenceBasis, "A5");
  assert.ok(v.ruleTrace.some((l) => l.includes("R dropped from vote")));
});

test(`Stage 1b hit below sim floor (${SIM_ARTIST_VOTE}) is dropped from the vote`, () => {
  const v = classifyArtistPass(f.rBelowThresholdDropped);
  assert.equal(v.evidenceBasis, "A5");
});

test("subject ATYPICAL withholds corroboration but does NOT change the attribution", () => {
  // Pre-2026-09-09 kSubject was annotation-only and this scored A2/HIGH. Subject is now a
  // corroboration dimension, so an atypical subject leaves only technique corroborating.
  const v = classifyArtistPass(f.subjectAtypicalFlag);
  assert.equal(v.evidenceBasis, "A3");
  assert.equal(v.confidence, "MEDIUM_HIGH");
  assert.equal(v.verdict, "attributed");
  assert.equal(v.artistName, "Bridget Riley");
  assert.equal(v.subjectCorroboration, "atypical");
  assert.ok(v.flags.includes("subjectAtypicalForArtist"));
});

test("subject corroboration is carried through to the verdict (typical + note)", () => {
  const v = classifyArtistPass(f.a1_threeAgree);
  assert.equal(v.subjectCorroboration, "typical");
  assert.ok(v.subjectNote.length > 0);
});

test("Tate reversed-name form still agrees (n=3 -> A1)", () => {
  const v = classifyArtistPass(f.reversedNameStillAgrees);
  assert.equal(v.evidenceBasis, "A1");
});

// ── per-source confidence modulates the band (2026-09-09) ──────────────────────

test("sourceConfidence: V reports its signature confidence, capped when the mark is illegible", () => {
  const legible = f.artistEv({ vea: { kind: "names", raw: "X" }, veaAuthorshipSignalLegible: true, veaSignatureConfidence: 0.9 });
  const guessed = f.artistEv({ vea: { kind: "names", raw: "X" }, veaAuthorshipSignalLegible: false, veaSignatureConfidence: 0.9 });
  const v = { source: "V" as const, raw: "X", identityKey: null };
  assert.equal(sourceConfidence(v, legible), 0.9);
  assert.equal(sourceConfidence(v, guessed), 0.5); // reconstructed mark
});

test("two agreeing but weak sources are demoted below a confident pair", () => {
  const mk = (sig: number, sim: number) =>
    f.artistEv({
      vea: { kind: "names", raw: "Marc Chagall" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: sig,
      reverseImageSearch: { kind: "names", raw: "Marc Chagall", sim },
      stage1bConsistentWithVea: true,
      kOeuvreMatchCount: KOEUVRE_DISCRIMINATING_MIN,
      kSubject: "TYPICAL",
    });
  const confident = classifyArtistPass(mk(0.85, 0.9));
  const weak = classifyArtistPass(mk(0.45, 0.78));
  assert.equal(confident.confidence, "HIGH");
  assert.equal(weak.confidence, "MEDIUM_HIGH", weak.ruleTrace.join(" | "));
  assert.ok(weak.ruleTrace.some((t) => t.includes("only just cleared their gates")), weak.ruleTrace.join(" | "));
  // same sources, same agreement, same corroboration — only their own confidence differs
  assert.equal(confident.evidenceBasis, weak.evidenceBasis);
});

test("REGRESSION: the A0793 dino scores separate same-work from different-work", () => {
  // The whole reason the work vote is dino-only. Same-work matches (Blake's Tate P04038 was
  // visually confirmed) all sit above every different-work match; the dino/clip MEAN does
  // not order them correctly, because Blake had no clip score and the wrong matches had
  // high ones.
  const votesForWork = (dino: number) =>
    classifyWorkPass({
      ...f.workEv(),
      titleEmbeddingMatch: { kind: "names", raw: "Some Work", matchConfidence: "MEDIUM", dinoSimilarity: dino },
    }).agreementSet.includes("D_t");

  for (const [label, dino] of [["Banksy", 0.991], ["Frink", 0.974], ["Blake", 0.886]] as const) {
    assert.equal(votesForWork(dino), true, `${label} (${dino}) is the same work and must vote`);
  }
  for (const [label, dino] of [["Villon", 0.876], ["Picasso", 0.851]] as const) {
    assert.equal(votesForWork(dino), false, `${label} (${dino}) is a different work and must not`);
  }
});

// ── Stage 1c as a physical-evidence source (2026-09-09) ────────────────────────

test("sheet dimensions are compared, at a wider tolerance than plate", () => {
  const sheet = (obs: { w: number; h: number }, cat: { w: number; h: number }) =>
    classifyDimensionMatch({ observedSource: "appraiser", workIsIntaglio: false, observedSheetMm: obs, catalogueSheetMm: cat });

  // 600x830 vs 620x845 — 3.3% / 1.8%, well inside sheet tolerance, outside plate tolerance
  const close = sheet({ w: 600, h: 830 }, { w: 620, h: 845 });
  assert.equal(close.match, "true");
  assert.equal(close.comparedOn, "sheet");
  assert.ok(close.note.includes("weakest dimension"), close.note);

  // a genuinely different sheet still fails
  assert.equal(sheet({ w: 600, h: 830 }, { w: 400, h: 500 }).match, "false");
});

test("plate is still preferred over sheet when both are available", () => {
  const r = classifyDimensionMatch({
    observedSource: "appraiser",
    workIsIntaglio: true,
    observedPlateMm: { w: 320, h: 240 },
    cataloguePlateMm: { w: 320, h: 240 },
    observedSheetMm: { w: 600, h: 830 },
    catalogueSheetMm: { w: 400, h: 500 }, // would fail, must not be reached
  });
  assert.equal(r.comparedOn, "plate");
  assert.equal(r.match, "true");
});

test("a CLAIMED technique corroborates a work but cannot establish a reproduction", () => {
  const base = {
    observedTechniques: ["giclee print"],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Etching"],
    catalogueMediumRaw: "etching",
    dimensions: { observedSource: "none" as const, workIsIntaglio: true },
  };
  // VEA actually saw halftone dots -> reproduction is a fair verdict
  const observed = classifyImpression({ ...base, observedTechniqueSource: "vea" });
  assert.equal(observed.divergence, "reproduction");

  // the same words, but only because the appraiser wrote them -> capped at medium_divergence
  const claimed = classifyImpression({ ...base, observedTechniqueSource: "appraiser" });
  assert.equal(claimed.divergence, "medium_divergence");
  assert.ok(claimed.ruleTrace.some((t) => t.includes("CLAIMED technique")), claimed.ruleTrace.join(" | "));
});

test("a Stage 1c technique still corroborates the work in Pass 2", () => {
  // The A0793 shape: VEA skipped, Stage 1c said "lithograph in colours", ACKG says Lithograph.
  const v = classifyWorkPass(f.t4_twoAgreeNoKwork, {
    impression: {
      observedTechniques: ["lithograph in colours"],
      observedTechniqueSource: "appraiser",
      observedIsPhotomechanical: false,
      catalogueTechniques: ["Lithograph"],
      catalogueMediumRaw: "lithograph",
      dimensions: { observedSource: "appraiser", workIsIntaglio: false },
    },
  });
  assert.ok(v.ruleTrace.some((t) => t.includes("work corroboration MODERATE")), v.ruleTrace.join(" | "));
  assert.equal(v.evidenceBasis, "T2");
});

// ── style consistency: exclusion only (2026-09-09) ─────────────────────────────

const style = (mean: number, n = 300, artistName = "Marc Chagall") => ({
  artistName, comparedWorks: n, meanTopSimilarity: mean, supportingText: [] as string[],
});

/** n=2 agreeing sources with full ACKG corroboration — HIGH before any style check. */
const corroboratedPair = (extra: Partial<Parameters<typeof f.artistEv>[0]> = {}) =>
  f.artistEv({
    vea: { kind: "names", raw: "Marc Chagall" },
    veaAuthorshipSignalLegible: true,
    veaSignatureConfidence: 0.85,
    reverseImageSearch: { kind: "names", raw: "Marc Chagall", sim: 0.9 },
    stage1bConsistentWithVea: true,
    kOeuvreMatchCount: KOEUVRE_DISCRIMINATING_MIN,
    kSubject: "TYPICAL",
    ...extra,
  });

test("a stylistically alien candidate has its corroboration withheld", () => {
  const ok = classifyArtistPass(corroboratedPair({ styleConsistency: style(0.79) }));
  const alien = classifyArtistPass(corroboratedPair({ styleConsistency: style(0.64) }));
  assert.equal(ok.confidence, "HIGH");
  assert.equal(alien.confidence, "MEDIUM"); // moderate lift withheld, then "none" lowers it
  assert.ok(alien.flags.some((x) => x.startsWith("styleInconsistentWithCandidate")), alien.flags.join(","));
  assert.ok(alien.ruleTrace.some((t) => t.includes("style EXCLUSION")), alien.ruleTrace.join(" | "));
  // it withholds support; it must not rename or un-attribute
  assert.equal(alien.verdict, "attributed");
  assert.equal(alien.artistName, "Marc Chagall");
});

test("style never LIFTS — a high style score adds a note, not a band", () => {
  const plain = classifyArtistPass(corroboratedPair({ kOeuvreMatchCount: 0, kSubject: "UNASSESSABLE" }));
  const styled = classifyArtistPass(
    corroboratedPair({ kOeuvreMatchCount: 0, kSubject: "UNASSESSABLE", styleConsistency: style(0.95) }),
  );
  assert.equal(styled.confidence, plain.confidence);
  assert.ok(styled.flags.some((x) => x.startsWith("styleConsistent:")), styled.flags.join(","));
});

test("a catalogued title match is not overridden by stylistic distance", () => {
  const v = classifyArtistPass(
    corroboratedPair({
      ackgWorkAnchor: { artist: "Marc Chagall", titleSim: 0.95 },
      styleConsistency: style(0.60),
    }),
  );
  assert.equal(v.confidence, "HIGH"); // strong corroboration stands
  assert.ok(v.flags.some((x) => x.startsWith("styleInconsistentWithCandidate")), v.flags.join(",")); // ...but is flagged
});

test("too few embedded works -> the style check is skipped, not guessed", () => {
  const v = classifyArtistPass(corroboratedPair({ styleConsistency: style(0.40, 3) }));
  assert.equal(v.confidence, "HIGH");
  assert.ok(v.ruleTrace.some((t) => t.includes("style check skipped")), v.ruleTrace.join(" | "));
});

test("style evidence for a DIFFERENT artist is ignored", () => {
  const v = classifyArtistPass(corroboratedPair({ styleConsistency: style(0.40, 500, "Someone Else") }));
  assert.equal(v.confidence, "HIGH");
});

// ── ACKG corroborates, it does not witness (2026-09-09, supersedes Decision 4a) ─────

test("an ACKG title match ALONE names nobody — no source spoke, so A11", () => {
  // Was A8K candidate/MEDIUM. The anchor's artist is back-propagated from a title that came
  // from V_t/R_t/A_t/D_t, so letting it vote double-counted the sources it derives from.
  const v = classifyArtistPass(
    f.artistEv({ ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.95 } }),
  );
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
  assert.equal(v.artistName, null);
  assert.deepEqual(v.agreementSet, []);
});

test("K below TAU_TITLE contributes nothing either (stays NOT ATTRIBUTED)", () => {
  const v = classifyArtistPass(
    f.artistEv({ ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.5 } }),
  );
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
});

test("a title match CORROBORATING the source's artist lifts the band, still n=1", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Rembrandt van Rijn" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      kOeuvreMatchCount: 240,
      ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.95 },
    }),
  );
  // one witness (V), not two — but strongly corroborated
  assert.equal(v.verdict, "candidate");
  assert.equal(v.evidenceBasis, "A5");
  assert.deepEqual(v.agreementSet, ["V"]);
  assert.equal(v.confidence, "MEDIUM_HIGH"); // MEDIUM base, lifted by strong corroboration
  assert.ok(v.flags.includes("corroboration:strong:ackgTitleMatch"), v.flags.join(","));
});

test("a title match naming a DIFFERENT artist is recorded, but cannot create a conflict", () => {
  // Was A10 conflict. A reference disagreeing with the only witness is not a second witness;
  // it is a reason to look harder, surfaced as a flag rather than manufactured into a verdict.
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Joan Miró" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      ackgWorkAnchor: { artist: "Marc Chagall", titleSim: 0.9 },
    }),
  );
  assert.equal(v.verdict, "candidate");
  assert.equal(v.artistName, "Joan Miró");
  assert.ok(
    v.flags.some((fl) => fl.startsWith("ackgTitleMatchNamesDifferentArtist:Marc Chagall")),
    v.flags.join(","),
  );
});

// ── D vote — Stage 1d DINOv2 match, 2026-09-06 amendment to ADR-0013 ────────

test("D alone at HIGH confidence -> CANDIDATE MEDIUM (A6D)", () => {
  const v = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "HIGH" } }),
  );
  assert.equal(v.evidenceBasis, "A6D");
  assert.equal(v.verdict, "candidate");
  assert.equal(v.confidence, "MEDIUM");
  assert.equal(v.artistName, "Henry Moore");
  assert.deepEqual(v.agreementSet, ["D"]);
});

test("DINOv2 alone carries the artist vote — CLIP is not required", () => {
  // A0793/122: Blake's clip was depressed to 0.863 by a colour-balance shift while dino
  // still recognised the work at 0.886. Requiring both would have discarded a correct artist.
  const v = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "Peter Blake", dinoSimilarity: 0.886, clipSimilarity: 0.863 } }),
  );
  assert.equal(v.evidenceBasis, "A6D");
  assert.equal(v.artistName, "Peter Blake");
  assert.ok(v.ruleTrace.some((l) => l.includes("DINOv2 only")), v.ruleTrace.join(" | "));
});

test("both measures agreeing scores higher than either alone", () => {
  const both = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "X", dinoSimilarity: 0.97, clipSimilarity: 0.97 } }),
  );
  const dinoOnly = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "X", dinoSimilarity: 0.97, clipSimilarity: 0.90 } }),
  );
  const clipOnly = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "X", dinoSimilarity: 0.70, clipSimilarity: 0.97 } }),
  );
  assert.ok(both.ruleTrace.some((l) => l.includes("both measures agree")), both.ruleTrace.join(" | "));
  assert.ok(dinoOnly.ruleTrace.some((l) => l.includes("DINOv2 only")));
  assert.ok(clipOnly.ruleTrace.some((l) => l.includes("CLIP only")));
  // CLIP alone is the weakest witness — it scores wrong artists at 0.94
  assert.equal(clipOnly.confidence, "LOW");
});

test("confidence is ordered: both measures > DINOv2 alone > CLIP alone", () => {
  const conf = (dino: number, clip: number) =>
    sourceConfidence(
      { source: "D", raw: "X", identityKey: null },
      f.artistEv({ embeddingMatch: { kind: "names", raw: "X", dinoSimilarity: dino, clipSimilarity: clip } }),
    );
  const both = conf(0.97, 0.97);
  const dinoOnly = conf(0.97, 0.90); // clip below its own floor
  const clipOnly = conf(0.70, 0.97); // dino below its own floor
  assert.ok(both > dinoOnly, `both ${both} should beat dino-only ${dinoOnly}`);
  assert.ok(dinoOnly > clipOnly, `dino-only ${dinoOnly} should beat clip-only ${clipOnly}`);
  // and nothing clearing either floor is not a vote at all
  assert.equal(conf(0.70, 0.90), 0);
});

test("neither measure clearing its own floor -> D does not vote at all", () => {
  // Stage 1d has no null result: it always hands back a top candidate. Whistler sat at
  // dino 0.801 / clip 0.940 as a rival row on the Hockney lot — wrong artist, and CLIP
  // alone at 0.940 must not be enough to name him.
  const v = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "Whistler", dinoSimilarity: 0.801, clipSimilarity: 0.940 } }),
  );
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
  assert.ok(v.ruleTrace.some((l) => l.includes("neither clears its own floor")), v.ruleTrace.join(" | "));
});

test("just over the floor votes; just under does not", () => {
  const over = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "LOW", dinoSimilarity: 0.85, clipSimilarity: 0.90 } }),
  );
  const under = classifyArtistPass(
    f.artistEv({ embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "HIGH", dinoSimilarity: 0.70, clipSimilarity: 0.90 } }),
  );
  assert.equal(over.evidenceBasis, "A6D");
  // the measurement governs, not the band the source labelled itself with
  assert.equal(under.evidenceBasis, "A11");
});

test("every correct A0793 match clears the floor", () => {
  // Frink 0.974, Banksy 0.985, Villon 0.911, Picasso 0.894, Blake 0.886 (clip was null).
  for (const measured of [0.974, 0.985, 0.911, 0.894, 0.886]) {
    const v = classifyArtistPass(
      f.artistEv({ embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "MEDIUM", dinoSimilarity: measured, clipSimilarity: 0.90 } }),
    );
    assert.equal(v.evidenceBasis, "A6D", `measured ${measured} should vote`);
  }
});

test("D (HIGH) + a consistent VEA signature -> n=2 (A2/A3/A4 depending on K_oeuvre)", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Henry Moore" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "HIGH" },
    }),
  );
  assert.equal(v.verdict, "attributed");
  assert.ok(["A2", "A3", "A4"].includes(v.evidenceBasis));
  assert.ok(v.agreementSet.includes("D") && v.agreementSet.includes("V"));
});

test("D (HIGH) + V + R all agree -> n=3, A1 HIGH", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Henry Moore" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      reverseImageSearch: { kind: "names", raw: "Henry Moore", sim: 0.9 },
      stage1bConsistentWithVea: true,
      embeddingMatch: { kind: "names", raw: "Henry Moore", matchConfidence: "HIGH" },
    }),
  );
  assert.equal(v.evidenceBasis, "A1");
  assert.equal(v.confidence, "HIGH");
  assert.deepEqual(v.agreementSet.sort(), ["D", "R", "V"]);
});

test("D (HIGH) naming a different identity than VEA -> CONFLICT (A10)", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Joan Miró" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      embeddingMatch: { kind: "names", raw: "Marc Chagall", matchConfidence: "HIGH" },
    }),
  );
  assert.equal(v.verdict, "conflict");
  assert.equal(v.evidenceBasis, "A10");
});

// ── GATE ─────────────────────────────────────────────────────────────────────
console.log("\nPass-2 gate\n");

test("gate opens for an ATTRIBUTED artist", () => {
  assert.equal(passTwoGate(classifyArtistPass(f.a2_twoAgreeAckgSupport), false).runPass2, true);
});

test("gate opens for a MEDIUM candidate", () => {
  assert.equal(passTwoGate(classifyArtistPass(f.a6_strongImageOnly), false).runPass2, true);
});

test("gate BLOCKS a LOW candidate with no in-image title", () => {
  const g = passTwoGate(classifyArtistPass(f.a7_weakImageOnly), false);
  assert.equal(g.runPass2, false);
});

test("gate opens via the in-image-title exception even when the artist verdict is weak", () => {
  const g = passTwoGate(classifyArtistPass(f.a9_appraiserHypothesisOnly), true);
  assert.equal(g.runPass2, true);
  assert.equal(g.mode, "in_image_title");
});

// ── PASS 2: work decision table ─────────────────────────────────────────────
console.log("\nPass 2 — Conceptual Work (T1..T7)\n");

test("T1 — all three title sources agree -> IDENTIFIED HIGH", () => {
  const v = classifyWorkPass(f.t1_allTitlesAgree);
  assert.equal(v.evidenceBasis, "T1");
  assert.equal(v.confidence, "HIGH");
});

test("2 agree + a K_work TITLE match only -> MEDIUM_HIGH; matching words is not matching the object", () => {
  // Pre-2026-09-09 a title-string match alone gave HIGH. Physical corroboration is what
  // earns HIGH now — see the technique/dimensions test below.
  const v = classifyWorkPass(f.t2_twoAgreeKworkFullMatch);
  assert.equal(v.evidenceBasis, "T4");
  assert.equal(v.confidence, "MEDIUM_HIGH");
});

test("T2 — 2 agree + catalogued technique AND dimensions match -> IDENTIFIED HIGH", () => {
  const v = classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_cleanMatch });
  assert.equal(v.evidenceBasis, "T2");
  assert.equal(v.confidence, "HIGH");
  assert.ok(v.ruleTrace.some((t) => t.includes("work corroboration STRONG")), v.ruleTrace.join(" | "));
});

test("a catalogued work whose technique CONTRADICTS the object loses a band at any n", () => {
  const v = classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_techniqueContradicts });
  assert.ok(v.ruleTrace.some((t) => t.includes("work corroboration CONTRADICTED")), v.ruleTrace.join(" | "));
  assert.equal(v.confidence, "MEDIUM"); // MEDIUM_HIGH base, contradiction -1
});

test("T4 — 2 agree, ACKG corroborates nothing -> IDENTIFIED MEDIUM", () => {
  const v = classifyWorkPass(f.t4_twoAgreeNoKwork);
  assert.equal(v.evidenceBasis, "T4");
  assert.equal(v.confidence, "MEDIUM");
});

test("T4 — 2 agree, weak K_work titleSim -> IDENTIFIED MEDIUM (not T2)", () => {
  const v = classifyWorkPass(f.t4_twoAgreeWeakKwork);
  assert.equal(v.evidenceBasis, "T4");
});

test("T5 — single title source -> CANDIDATE", () => {
  const v = classifyWorkPass(f.t5_singleTitleSource);
  assert.equal(v.evidenceBasis, "T5");
  assert.equal(v.verdict, "candidate");
});

test("T8K — no source consensus but a strong K_work embedding match -> IDENTIFIED MEDIUM", () => {
  const v = classifyWorkPass(f.t8k_kworkAnchorNoConsensus);
  assert.equal(v.evidenceBasis, "T8K");
  assert.equal(v.verdict, "identified");
  assert.equal(v.confidence, "MEDIUM");
  assert.equal(v.conceptualWorkTitle, "H10-1 Wu Zetian, from The Empresses");
});

test("titleContainment tolerates a series suffix where Jaccard does not", () => {
  const plain = "Cold water about to hit the Prince";
  const catalogued = "Cold Water about to Hit the Prince, from 'Illustrations for Six Fairy Tales from the Brothers Grimm'";
  assert.ok(titleSimilarity(plain, catalogued) < TAU_TITLE_AGREE, "Jaccard should fall short here");
  assert.ok(titleContainment(plain, catalogued) >= TAU_TITLE_AGREE, "containment should not");
});

test("titleContainment still separates two genuinely different works", () => {
  assert.ok(titleContainment("Reclining Figure", "Cold Water about to Hit the Prince") < TAU_TITLE_AGREE);
});

test("titleContainment falls back to Jaccard for a one-token title", () => {
  // "Untitled" is contained by half the catalogue; overlap would score it 1.0.
  assert.equal(
    titleContainment("Untitled", "Untitled Composition No. 5 from the Blue Series"),
    titleSimilarity("Untitled", "Untitled Composition No. 5 from the Blue Series"),
  );
  assert.ok(titleContainment("Untitled", "Untitled Composition No. 5 from the Blue Series") < TAU_TITLE_AGREE);
});

// ── K_work corroboration must point at the same work (2026-09-08) ───────────────

test("K_work matching a DIFFERENT work does not lift 2 agreeing sources to T2 -> T4 MEDIUM", () => {
  const v = classifyWorkPass(f.t4_kworkMatchedADifferentWork);
  assert.equal(v.evidenceBasis, "T4");
  assert.equal(v.confidence, "MEDIUM");
  assert.ok(
    v.ruleTrace.some((t) => t.includes("not counted as corroboration") && t.includes("Reclining Figure")),
    v.ruleTrace.join(" | "),
  );
});

test("K_work matching a DIFFERENT work leaves a single source at T5 LOW, not MEDIUM", () => {
  const v = classifyWorkPass(f.t5_kworkMatchedADifferentWork);
  assert.equal(v.evidenceBasis, "T5");
  assert.equal(v.confidence, "LOW");
});

test("a K_work hit with no matchedWorkTitle is unverifiable and does not corroborate", () => {
  const v = classifyWorkPass(f.t4_kworkUnverifiable);
  assert.equal(v.evidenceBasis, "T4");
  assert.ok(v.ruleTrace.some((t) => t.includes("no matchedWorkTitle recorded")), v.ruleTrace.join(" | "));
});

test("a catalogued title carrying a series suffix still corroborates (via containment)", () => {
  // No impression evidence, so this exercises the kWork title fallback — where the
  // containment measure matters. Weak corroboration holds the band at MEDIUM_HIGH.
  const v = classifyWorkPass(f.t2_kworkSeriesSuffixStillAgrees);
  assert.equal(v.evidenceBasis, "T4");
  assert.equal(v.confidence, "MEDIUM_HIGH");
});

// ── the runner-up ratio gate (2026-09-11) ──────────────────────────────────────

test("D_t needs to beat its nearest RIVAL work, not just the floor", () => {
  const votes = (dino: number, runnerUpDinoSimilarity?: number) =>
    classifyWorkPass({
      ...f.workEv(),
      titleEmbeddingMatch: { kind: "names", raw: "Some Work", matchConfidence: "HIGH", dinoSimilarity: dino, runnerUpDinoSimilarity },
    }).agreementSet.includes("D_t");

  // A repetitive series: the best and second-best DIFFERENT works score alike, so the top one
  // names a work no more than the runner-up does. Height alone would have accepted it.
  assert.equal(votes(0.96, 0.94), false, "0.94/0.96 = 0.979 — no clear winner");
  assert.equal(votes(0.96, 0.91), true, "0.91/0.96 = 0.948 — the top match is clear");
  // A decisive match stays decisive however high the absolute score is.
  assert.equal(votes(0.99, 0.62), true);
  // Below the floor, the ratio cannot rescue it: nothing here is plausibly this image.
  assert.equal(votes(0.70, 0.20), false, "a huge gap below the floor is still a weak match");
});

test("no rival candidate means the ratio gate cannot apply, and must not block", () => {
  const votes = (dino: number, runnerUpDinoSimilarity?: number) =>
    classifyWorkPass({
      ...f.workEv(),
      titleEmbeddingMatch: { kind: "names", raw: "Some Work", matchConfidence: "HIGH", dinoSimilarity: dino, runnerUpDinoSimilarity },
    }).agreementSet.includes("D_t");
  // Stage 1d returns a rival only when the index holds one. Absence is a coverage fact and
  // must leave the pre-existing behaviour untouched.
  assert.equal(votes(0.95, undefined), true, "no runner-up returned -> floor alone decides");
  assert.equal(votes(0.95), true);
});

// ── the per-artist DINOv2 floor (2026-09-11) ───────────────────────────────────

test("the D_t floor is the artist's own when the graph has one, and global otherwise", () => {
  const votes = (dino: number, artistDinoFloor?: number | null) =>
    classifyWorkPass({
      ...f.workEv(),
      artistDinoFloor,
      titleEmbeddingMatch: { kind: "names", raw: "Some Work", matchConfidence: "MEDIUM", dinoSimilarity: dino },
    }).agreementSet.includes("D_t");

  // Damien Hirst: measured p99 0.919. His catalogued works resemble one another more than
  // most, so 0.90 is ORDINARY for him and must not identify a work — the global 0.88 lets it.
  assert.equal(votes(0.90), true, "0.90 clears the global floor");
  assert.equal(votes(0.90, 0.919), false, "but is ordinary similarity for this artist");
  assert.equal(votes(0.93, 0.919), true, "genuinely exceptional for this artist still votes");

  // Peter Blake: measured p99 0.735, so 0.80 is plainly exceptional for him even though the
  // global floor would refuse it. His real A0793/122 match sits at 0.886 and the REGRESSION
  // test above verifies it as the same work against Tate P04038.
  assert.equal(votes(0.80), false, "0.80 is below the global floor");
  assert.equal(votes(0.80, 0.735), true, "but is exceptional for this artist");
  assert.equal(votes(0.886, 0.735), true, "and the verified same-work match still votes");
});

test("an absent or nonsense artist floor falls back to the global one, never blocks", () => {
  const votes = (dino: number, artistDinoFloor?: number | null) =>
    classifyWorkPass({
      ...f.workEv(),
      artistDinoFloor,
      titleEmbeddingMatch: { kind: "names", raw: "Some Work", matchConfidence: "MEDIUM", dinoSimilarity: dino },
    }).agreementSet.includes("D_t");
  // 977 of 8,033 artists have a background; the rest must behave exactly as before.
  for (const bad of [null, undefined, 0, -1, NaN]) {
    assert.equal(votes(0.95, bad as any), true, `floor ${String(bad)} must fall back to global`);
    assert.equal(votes(0.80, bad as any), false, `floor ${String(bad)} must fall back to global`);
  }
});

// ── D_t — Stage 1d's catalogued title as a title vote (2026-09-08) ──────────────

test("D_t — a lone HIGH Stage 1d title votes, and beats the K_work anchor to a different work", () => {
  const v = classifyWorkPass(f.dt_embeddingTitleOnly_high);
  assert.equal(v.evidenceBasis, "T5");
  assert.equal(v.verdict, "candidate");
  assert.equal(v.conceptualWorkTitle, "Cold Water about to Hit the Prince");
  assert.deepEqual(v.agreementSet, ["D_t"]);
});

test("D_t below the DINO work floor does not vote — CLIP does not speak to work identity", () => {
  // dino 0.851 clears the artist floor but not the work floor. On A0793 this exact value was
  // a Picasso print by the right artist and the wrong work, which CLIP scored 0.937.
  const v = classifyWorkPass(f.dt_embeddingTitleOnly_medium);
  assert.ok(v.ruleTrace.some((t) => t.includes(`< ${D_T_DINO_FLOOR}`)), v.ruleTrace.join(" | "));
  assert.notEqual(v.evidenceBasis, "T5");
});

test("a sub-floor D_t leaves T8K to answer for the work", () => {
  const v = classifyWorkPass(f.dt_mediumButKworkAgrees);
  assert.equal(v.evidenceBasis, "T8K");
  assert.equal(v.confidence, "MEDIUM"); // T8K's own evidence is the anchor; silence does not demote it
  assert.equal(v.verdict, "identified");
});

test("T8K is LIFTED when the catalogued record also matches", () => {
  const v = classifyWorkPass(f.dt_mediumButKworkAgrees, { impression: f.imp_cleanMatch });
  assert.equal(v.evidenceBasis, "T8K");
  assert.equal(v.confidence, "MEDIUM_HIGH");
});

test("T8K is withheld entirely when the catalogued record contradicts the object", () => {
  const v = classifyWorkPass(f.dt_mediumButKworkAgrees, { impression: f.imp_techniqueContradicts });
  assert.notEqual(v.evidenceBasis, "T8K");
  assert.ok(v.ruleTrace.some((t) => t.includes("T8K withheld")), v.ruleTrace.join(" | "));
});

test("...and a D_t measuring ABOVE the work floor does vote", () => {
  const v = classifyWorkPass({
    ...f.dt_mediumButKworkAgrees,
    titleEmbeddingMatch: {
      kind: "names",
      raw: "Cold Water about to Hit the Prince",
      matchConfidence: "HIGH",
      embeddingConfidence: 0.974,
      dinoSimilarity: 0.974, // clears D_T_DINO_FLOOR
    },
  });
  assert.equal(v.evidenceBasis, "T5");
  assert.deepEqual(v.agreementSet, ["D_t"]);
});

test("D_t — agreeing with the appraiser makes two sources, and the record confirms it -> T2 HIGH", () => {
  const v = classifyWorkPass(f.dt_agreesWithAppraiser, { impression: f.imp_cleanMatch });
  assert.equal(v.evidenceBasis, "T2");
  assert.equal(v.verdict, "identified");
  assert.equal(v.confidence, "HIGH");
  assert.deepEqual(v.agreementSet.sort(), ["A_t", "D_t"]);
});

test("D_t — as a fourth agreeing source, T1 still fires (n >= 3, not === 3)", () => {
  const v = classifyWorkPass(f.dt_fourSourcesAgree);
  assert.equal(v.evidenceBasis, "T1");
  assert.equal(v.verdict, "identified");
  assert.equal(v.confidence, "HIGH");
  assert.equal(v.agreementSet.length, 4);
});

test("D_t — contradicting the only other source with no anchor -> T6 CONFLICT", () => {
  const v = classifyWorkPass(f.dt_contradictsAppraiser);
  assert.equal(v.evidenceBasis, "T6");
  assert.equal(v.verdict, "conflict");
});

test("T6 — title sources conflict -> CONFLICT", () => {
  const v = classifyWorkPass(f.t6_titlesConflict);
  assert.equal(v.evidenceBasis, "T6");
  assert.equal(v.verdict, "conflict");
});

test("T7 — no title evidence -> UNRESOLVED", () => {
  const v = classifyWorkPass(f.t7_noTitleEvidence);
  assert.equal(v.evidenceBasis, "T7");
  assert.equal(v.verdict, "unresolved");
});

// ── IMPRESSION ──────────────────────────────────────────────────────────────
console.log("\nImpression divergence (5b) + dimension rules\n");

test("dimensions: no usable observed measurement -> UNASSESSABLE (not a mismatch)", () => {
  const d = classifyDimensionMatch({ observedSource: "none", workIsIntaglio: true });
  assert.equal(d.match, "UNASSESSABLE");
});

test("dimensions: VEA-scaled widens tolerance to swallow ±15-20% noise", () => {
  const d = classifyDimensionMatch({
    observedSource: "vea_scaled",
    workIsIntaglio: true,
    observedPlateMm: { w: 352, h: 264 }, // +10% — a real mismatch at 3% tol, within the 18% VEA-scaled band
    cataloguePlateMm: { w: 320, h: 240 },
  });
  assert.equal(d.match, "true");
});

test("dimensions: plate mark is the primary comparison for intaglio", () => {
  const d = classifyDimensionMatch(f.imp_laterEdition.dimensions);
  assert.equal(d.comparedOn, "plate");
  assert.equal(d.match, "false");
  assert.equal(d.direction, "larger");
});

test("dimensions: plate vs sheet (no like-for-like pair) -> UNASSESSABLE", () => {
  const d = classifyDimensionMatch(f.imp_plateVsSheetNoComparison.dimensions);
  assert.equal(d.match, "UNASSESSABLE");
});

test("impression: technique matches, dims within tol -> none", () => {
  assert.equal(classifyImpression(f.imp_none).divergence, "none");
});

test("impression: technique matches, dims minor over -> variant_sheet", () => {
  assert.equal(classifyImpression(f.imp_variantSheetMinor).divergence, "variant_sheet");
});

test("impression: technique matches, dims materially larger -> later_edition", () => {
  assert.equal(classifyImpression(f.imp_laterEdition).divergence, "later_edition");
});

test("impression: technique differs -> medium_divergence", () => {
  assert.equal(classifyImpression(f.imp_mediumDivergence).divergence, "medium_divergence");
});

test("impression: photomechanical vs expected original -> reproduction", () => {
  assert.equal(classifyImpression(f.imp_reproduction).divergence, "reproduction");
});

test("impression: no scale scan, technique matches -> none (UNASSESSABLE dims don't create divergence)", () => {
  assert.equal(classifyImpression(f.imp_noScaleScanUnassessable).divergence, "none");
});

// ── technique family matching (Decision 9.1 rules table) ─────────────────────

test("techniqueFamily buckets the common processes", () => {
  assert.equal(techniqueFamily("Etching"), "intaglio");
  assert.equal(techniqueFamily("soft-ground etching and engraving"), "intaglio");
  assert.equal(techniqueFamily("Lithograph"), "planographic");
  assert.equal(techniqueFamily("Offset lithograph"), "photomechanical");
  assert.equal(techniqueFamily("Woodcut"), "relief");
  assert.equal(techniqueFamily("Screenprint / Serigraphy"), "screen");
  assert.equal(techniqueFamily("Giclée"), "photomechanical");
  assert.equal(techniqueFamily("laminated giclée print"), "photomechanical");
  assert.equal(techniqueFamily("something odd"), "other");
});

test("classifyTechniqueMatch: same family -> true", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: ["Etching", "Drypoint"],
    observedIsPhotomechanical: false,
    catalogueTechniques: ["Etching", "Aquatint", "Drypoint"],
  });
  assert.equal(r.match, "true");
});

test("classifyTechniqueMatch: no catalogue technique -> unassessable", () => {
  const r = classifyTechniqueMatch({ observedTechniques: ["Etching"], observedIsPhotomechanical: false, catalogueTechniques: [] });
  assert.equal(r.match, "unassessable");
});

test("classifyTechniqueMatch: observed photomechanical vs catalogued etching -> false + catalogueIsOriginalProcess", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: ["Offset lithograph"],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Etching"],
    catalogueMediumRaw: "etching with drypoint",
  });
  assert.equal(r.match, "false");
  assert.equal(r.catalogueIsOriginalProcess, true);
});

test("classifyTechniqueMatch: giclée observed AND giclée catalogued (Hirst Empresses) -> true, no divergence", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: [],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Giclée"],
    catalogueMediumRaw: "laminated giclée print",
  });
  assert.equal(r.match, "true");
  assert.equal(r.catalogueIsOriginalProcess, false);
  const imp = classifyImpression({
    observedTechniques: [],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Giclée"],
    catalogueMediumRaw: "laminated giclée print",
    dimensions: { observedSource: "none", workIsIntaglio: false },
  });
  assert.equal(imp.divergence, "none");
});

test("classifyDimensionMatch: parses via the real ACKG-style values (appraiser cm vs catalogue mm)", () => {
  const d = classifyDimensionMatch({
    observedSource: "appraiser",
    workIsIntaglio: true,
    observedPlateMm: { w: 410, h: 324 },
    cataloguePlateMm: { w: 412, h: 322 },
  });
  assert.equal(d.match, "true");
});

// ── SCENARIO MAPPING ────────────────────────────────────────────────────────
console.log("\nScenario mapping (Decision 8)\n");

test("artist HIGH (A2) + work HIGH + no divergence -> Scenario 1", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a2_twoAgreeAckgSupport),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_cleanMatch }),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ConfirmedClean);
});

test("single-source MEDIUM candidate (A5) + weak work candidate (T5) -> Scenario 3, NOT Scenario 1", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a5_singleVeaSignature), // A5 candidate/MEDIUM
    work: classifyWorkPass(f.t5_singleTitleSource), // T5 candidate/LOW-MEDIUM
    impression: null,
    traditionConfidence: 0.7,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("attributed HIGH but only A3 (not A1/A2) + work identified HIGH -> Scenario 3, not clean-fast-pathed", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a3_recognisedNoOeuvre),
    work: classifyWorkPass(f.t1_allTitlesAgree),
    impression: null,
    traditionConfidence: 0.7,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("medium_divergence -> Scenario 2 (elevated authentication risk), checked before a clean match", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a2_twoAgreeAckgSupport),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_cleanMatch }),
    impression: classifyImpression(f.imp_mediumDivergence),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("artist conflict -> Scenario 5", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a10_conflict),
    work: null,
    impression: null,
    traditionConfidence: 0.6,
  });
  assert.equal(s.scenario, Scenario.CompetingCandidates);
});

test("A3 recognisedArtist_noMatchingOeuvre -> Scenario 3", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a3_recognisedNoOeuvre),
    work: classifyWorkPass(f.t7_noTitleEvidence),
    impression: null,
    traditionConfidence: 0.5,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("not attributed + confident tradition -> Scenario 4", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a11_nothing),
    work: null,
    impression: null,
    traditionConfidence: 0.6,
  });
  assert.equal(s.scenario, Scenario.MovementOnly);
});

test("not attributed + weak tradition -> Scenario 6", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a11_nothing),
    work: null,
    impression: null,
    traditionConfidence: 0.1,
  });
  assert.equal(s.scenario, Scenario.LowSignalEverywhere);
});

test("riskFlags.forgeryRisk carries forward -> Scenario 2, even with an otherwise-clean A1/HIGH match", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a1_threeAgree),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_cleanMatch }),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
    riskFlags: { forgeryRisk: true, misattributionRisk: false },
  });
  assert.equal(s.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("riskFlags absent -> risk path is skipped (no crash on undefined)", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a1_threeAgree),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch, { impression: f.imp_cleanMatch }),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ConfirmedClean);
});

// ── END-TO-END ──────────────────────────────────────────────────────────────
console.log("\nclassifyTwoPass — end to end\n");

test("e2e: confirmed, clean -> Scenario 1, both passes ran", () => {
  const r = classifyTwoPass(f.e2e_confirmedClean);
  assert.equal(r.pass2Ran, true);
  assert.equal(r.artistAttribution.confidence, "HIGH");
  assert.equal(r.workIdentification?.confidence, "HIGH");
  assert.equal(r.scenario, Scenario.ConfirmedClean);
});

test("e2e: reproduction routes to Scenario 2", () => {
  const r = classifyTwoPass(f.e2e_reproductionRoutesToScenario2);
  assert.equal(r.impressionAssessment?.divergence, "reproduction");
  assert.equal(r.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("e2e: artist conflict routes to Scenario 5", () => {
  const r = classifyTwoPass(f.e2e_artistConflictRoutesToScenario5);
  assert.equal(r.artistAttribution.verdict, "conflict");
  assert.equal(r.scenario, Scenario.CompetingCandidates);
});

test("e2e: weak artist + no in-image title -> Pass 2 blocked, work stays null", () => {
  const r = classifyTwoPass(f.e2e_gateBlocksPass2);
  assert.equal(r.pass2Ran, false);
  assert.equal(r.workIdentification, null);
});

test("e2e: back-propagation — in-image title identifies the artist, Pass 1 re-run lifts the verdict", () => {
  const r = classifyTwoPass(f.backProp_workIdentifiesArtist);
  assert.equal(r.pass2Mode, "in_image_title");
  assert.equal(r.workIdentification?.verdict, "identified");
  assert.ok(
    r.artistAttribution.flags.includes("backPropagatedFromWork"),
    `expected back-prop to lift the artist verdict, got ${r.artistAttribution.evidenceBasis}/${r.artistAttribution.verdict}`,
  );
  assert.equal(r.artistAttribution.artistName, "Katsushika Hokusai");
});

test("e2e: movement only -> Scenario 4", () => {
  assert.equal(classifyTwoPass(f.e2e_movementOnly).scenario, Scenario.MovementOnly);
});

test("e2e: low signal -> Scenario 6", () => {
  assert.equal(classifyTwoPass(f.e2e_lowSignal).scenario, Scenario.LowSignalEverywhere);
});

test("VEA halt short-circuits both passes -> not_attributed, Scenario 6, even with a clean-looking match", () => {
  const r = classifyTwoPass({ ...f.e2e_confirmedClean, veaHaltRecommended: true });
  assert.equal(r.artistAttribution.verdict, "not_attributed");
  assert.equal(r.artistAttribution.evidenceBasis, "VEA-halt");
  assert.equal(r.pass2Ran, false);
  assert.equal(r.workIdentification, null);
  assert.equal(r.scenario, Scenario.LowSignalEverywhere);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
