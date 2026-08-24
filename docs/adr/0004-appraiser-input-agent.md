# ADR-0004: Appraiser Input Agent (AIA) — extracting structured claims from human free text

**Date:** 2026-08-23
**Status:** Implemented (2026-08-24) — see "Implementation notes" at the end for what shipped and where it deviated from this proposal

---

## Context

The app already collects free-text notes from the human appraiser via
`AppraiserNotesInput.tsx`, in four separate boxes:

1. **Inscribed Marks & Monograms** — e.g. *"Pencil numbers bottom-left border
   reading 'Ed. 45/75', artist signature monogram, monotype plate marks..."*
2. **Provenance & Ownership History** — e.g. *"Acquired from Sotheby's
   multiple sale in 1994, originally from the collection of Dr. Julian Smith,
   London..."*
3. **Physical Condition & Framing** — e.g. *"Slight cockling on bottom-right
   margin, minor acid framing lines, linen-backed on acid-free boards..."*
4. **Catalogues & Lit References** — e.g. *"Conforms to Bartsch Bart-105-D
   catalogue reference on 17th Century etching reproductions..."*

Today (`src/App.tsx`, `handleAnalysisSubmit`) these four boxes are concatenated
into one `compiledNotes` string and sent as `userNotes` on `AppraisalInput`,
which reaches Stage 2a (Triage), Stage 2b (Specialist), and Stage 3
(Valuation) as an undifferentiated blob of prose with no structure and no
trust tagging — every claim in it is read with equal weight, whether it's
"accompanied by a certificate of authenticity" or "I think this might be
from the 1968 edition."

**Correction (2026-08-24):** this ADR originally claimed `runStage1VEA` also
passed `userNotes` into `VISUAL_EXTRACTION_SYSTEM_PROMPT` via a `{userNotes}`
placeholder — checked against the actual prompt text while implementing this
ADR, and that placeholder doesn't exist in `VISUAL_EXTRACTION_SYSTEM_PROMPT`.
The `input.userNotes` argument was being passed into `resolveCustomPrompt`
regardless, but had nothing to substitute — it was already inert, not an
active layering violation. The argument has been removed from that call site
for clarity (see Implementation notes), but no behavioural bug existed there
to begin with. The real problem this ADR solves is the one stated above: no
structure, no trust tagging, anywhere the notes were actually being used.

Separately, ADR-0003 (item 3) proposed "Appraiser direct input as a defined
pipeline input" only in sketch form — a `hypothesis` vs `documented_fact`
status tag, no concrete extraction mechanism, no schema, no pipeline slot.
This ADR replaces that sketch with a real design.

### The reusable approach

Yesterday's benchmark work (commit `f324811`, `benchmark/src/roseberys/`)
built a two-tier extraction pattern for turning auction-house catalogue prose
into structured fields:

- **`parse.ts`** — deterministic regex extraction for house-format-specific
  and pattern-matchable fields: `parseDimensions()` (`"image: 22 x 32cm"` →
  `{kind, widthCm, heightCm}`), `extractCatalogueRefs()` (`"[Bloch 1244]"`,
  `"(Vallier 153)"` → ref strings), `detectMultiWork()`, edition-fraction
  detection (`"45/100"` → `editionSize: 100`).
- **`llm_fallback.ts`** — a narrow, single-purpose Claude Haiku call
  (`llmFallbackExtract`), used only when the regex parser can't find an
  artist or medium at all. Strict JSON-only output, three fields, no
  commentary — a scoped extraction call, not a general-purpose agent.

That combination — cheap deterministic parsing for the fields that have a
reliable pattern, a narrow LLM call for the fields that need real language
understanding — is the approach this ADR proposes reusing, adapted for a
different input shape.

---

## Decision

### 1. New pipeline stage: **Stage 1c — Appraiser Input Agent (AIA)**

Runs alongside Stage 1a (VEA) and Stage 1b (Visual Search) — three
independent, parallel Stage-1-level agents, each blind to the others'
inputs and outputs, all feeding Stage 2a (Triage):

```
      images                                   appraiser free text
        │                                             │
        ▼                                             ▼
 Stage 1a — VEA                               Stage 1c — AIA
 (vision only, no                          (text only, no vision;
  appraiser text)                        regex pass + narrow LLM call)
        │                                             │
        │          Stage 1b — Visual Search           │
        │           (image only, Gemini)               │
        │                     │                        │
        └──────────┬──────────┴────────────┬──────────┘
                    ▼ all three run in parallel, no cross-dependencies
             Stage 2a — Triage (ATA)
                    │
                    ▼
             Stage 2b — Specialist (ASA)
                    │
                    ▼
             Stage 3 — Valuation
                    │
                    ▼
             PrintAnalysisReport
```

AIA has no dependency on VEA or Stage 1b, and they have none on it — same
"observe only, don't cross-contaminate" discipline that already separates
VEA (physical observation) from Stage 1b (advisory hypothesis, never
confirmed attribution). Triage is the only stage that ever sees all three
at once, and fusing them is Triage's job, not any Stage-1 agent's — the
same "corroboration vs. contradiction surfaces as a risk flag, never
silently resolved" principle ADR-0003 already established.

### 2. Inputs

The four existing `AppraiserNotesInput.tsx` boxes, unchanged in the UI —
this is a backend-only change. AIA receives up to four optional free-text
blocks, each already labeled by topic (no re-segmentation needed, unlike
Stage 1b's Gemini search input or the supplementary-photo captions, which
had to infer topic from free-form context):

```typescript
interface AppraiserInputRequest {
  inscribedMarksNotes?: string;   // signatures, edition numbers, monograms
  provenanceNotes?: string;       // ownership/sale history
  conditionNotes?: string;        // condition, framing, restoration
  catalogueNotes?: string;        // catalogue raisonné, exhibition, literature
}
```

### 3. Extraction approach — adapted, not ported

Appraiser notes are unstructured prose, not a fixed house format like
Roseberys' `<br>`-delimited catalogue blob — so the balance inverts from
yesterday's pattern: regex-first-with-LLM-fallback becomes **regex-assist
alongside an LLM-first pass**, not regex-first-with-LLM-fallback:

- **Regex pass (reused, not reinvented):** run `parseDimensions()` and
  `extractCatalogueRefs()` from `benchmark/src/roseberys/parse.ts` directly
  against `catalogueNotes` and `inscribedMarksNotes`. Edition-fraction
  detection (`/\b\d+\s*\/\s*(\d+)\b/`) reused the same way. These are cheap,
  deterministic, and exist today — no reason to have an LLM re-derive a
  dimension string it might transcribe wrong.
- **LLM pass (new, narrow, on the `llm_fallback.ts` model):** one Claude
  Haiku call per appraisal (not per-field), strict JSON-only output,
  given all four note blocks plus the regex pass's findings as pre-filled
  hints the model can confirm, correct, or extend — not four separate
  calls, and not a general reasoning agent with tool access. Same
  discipline as `llmFallbackExtract`: extract, don't infer beyond what's
  stated, `null` over fabrication.

**Practical note for implementation (not decided here):** `parse.ts`'s
regex helpers currently live under `benchmark/src/roseberys/`, a directory
whose own docs (`docs/agents/benchmark.md`) describe it as intentionally
separate from `src/appraisal/` for licensing reasons (Roseberys catalogue
text/images have redistribution restrictions the benchmark corpus works
around). The *code* (regex functions) carries no such restriction — only
the *data* it was built to parse does — so extracting `parseDimensions`/
`extractCatalogueRefs`/edition-detection into a shared module (e.g.
`src/shared/text_extraction.ts`) that both `benchmark/` and
`src/appraisal/` import is the likely right move, but is an implementation
decision for whoever builds this, not an architectural one this ADR
needs to settle.

### 4. Trust tagging (fulfills ADR-0003 item 3)

Every extracted claim carries the status ADR-0003 originally sketched:

- `hypothesis` — stated without supporting documentation (e.g. "believed
  to be from the 1968 edition")
- `documented_fact` — the note itself references supporting paperwork
  (e.g. "accompanied by a certificate of authenticity from the Foundation",
  "invoice from Sotheby's dated...") — detecting *that a document is
  referenced* is a text-extraction task the LLM pass handles; AIA does not
  verify the document exists, only that the appraiser's note claims one
  does.

This status travels with every claim into Triage's evidence pool, where — per
ADR-0003 — a `hypothesis` must not outrank contradicting VEA/Stage 1b
evidence, while a `documented_fact` should carry more weight.

### 5. Output schema (proposed, schemaVersion `AIA-1.0`)

```typescript
interface AppraiserInputResult {
  schemaVersion: "AIA-1.0";
  inputReceived: {
    inscribedMarksNotes: boolean;
    provenanceNotes: boolean;
    conditionNotes: boolean;
    catalogueNotes: boolean;
  };

  // Holistic pass — an artist/title/period/technique claim can appear in
  // any of the four boxes (e.g. a provenance note naming the artist's
  // studio), so this scans all four rather than assuming one field only.
  claimedAttribution: {
    artist: string | null;
    title: string | null;
    period: string | null;
    technique: string | null;
    status: "hypothesis" | "documented_fact" | "absent";
    sourceField: "inscribedMarksNotes" | "provenanceNotes" | "conditionNotes" | "catalogueNotes" | null;
    sourceExcerpt: string | null;   // verbatim, for audit
  };

  inscriptionClaims: {
    signatureClaim: string | null;      // e.g. "signed and numbered in pencil"
    editionClaim: string | null;        // e.g. "45/100", "AP"
    editionSizeClaim: number | null;    // regex-assisted
    monogramOrStampClaim: string | null;
    status: "hypothesis" | "documented_fact" | "absent";
  };

  provenanceChain: Array<{
    ownerOrEntity: string;
    dateOrPeriod: string | null;
    status: "hypothesis" | "documented_fact";
    sourceExcerpt: string;
  }>;

  conditionClaims: Array<{
    claim: string;
    status: "hypothesis" | "documented_fact";
    sourceExcerpt: string;
  }>;

  catalogueReferences: Array<{
    ref: string;               // e.g. "Bloch 1244"
    source: "regex" | "llm";   // which pass found it
  }>;
  literatureOrExhibitionClaims: string[];

  dimensionsClaim: {
    widthCm: number | null;
    heightCm: number | null;
    kind: string | null;       // image | sheet | plate | framed | ...
    source: "regex" | "llm" | "both";
  } | null;

  paperOrSupport: string | null;   // e.g. "BFK Rives wove" — LLM-only, no regex hint

  rawNotes: {
    inscribedMarksNotes: string | null;
    provenanceNotes: string | null;
    conditionNotes: string | null;
    catalogueNotes: string | null;
  };

  overallExtractionConfidence: number;
  lowConfidenceFlags: string[];
}
```

The `rawNotes` passthrough is mandatory, not optional — Triage, the
Specialist, and any human reviewer must always be able to see exactly what
the appraiser actually wrote, never only the structured extraction of it.

### 6. Removed from VEA

`VISUAL_EXTRACTION_SYSTEM_PROMPT`'s `{userNotes}` placeholder and
`runStage1VEA`'s `input.userNotes` pass-through are removed. VEA returns to
being strictly vision-only, exactly as its own Section 5 behavioural rules
already claim ("OBSERVE ONLY... record only physical observations") but
don't currently enforce, since user text was being injected into the same
prompt. `AppraisalInput.userNotes` itself is not necessarily removed —
scoping that (see Next Steps) depends on what, if anything, still needs it
in the 3-stage legacy path, which this ADR deliberately does not touch.

---

## Consequences

**Good:**
- VEA's "observe only" discipline becomes structurally true, not just
  stated — it has no text channel left to be influenced by.
- Appraiser claims get the same trust-tagged, verify-don't-trust treatment
  Stage 1b's hypotheses already get, closing the gap ADR-0003 flagged.
- Reuses real, tested extraction logic (`parseDimensions`,
  `extractCatalogueRefs`) instead of asking an LLM to re-derive patterns a
  regex already gets right, for the fields where that matters (dimensions,
  catalogue refs).
- Stage 1a/1b/1c running fully in parallel is strictly faster than any
  design that makes AIA a precondition for VEA or Triage.

**Accepted limitations / open risks:**
- **Detecting "documented_fact" is a text-understanding task, not a
  verification task.** AIA can only tell that a note *claims* a certificate
  exists, never that one actually does. This must stay legible downstream —
  Triage and any human-facing report must not present `documented_fact`
  as "verified."
- **Four free-text boxes still allow contradictory or duplicate claims
  within a single appraiser submission** (e.g. an edition number stated
  differently in the inscribed-marks box vs. the catalogue box). This ADR
  does not propose AIA resolve that — cross-field consistency checking
  within AIA's own output is a reasonable follow-up, not required for v1.
- **One LLM call per appraisal, but always run** (unlike `llm_fallback.ts`,
  which is zero-cost when regex succeeds) — because unlike Roseberys'
  house-format prose, free-text appraiser notes have no format regex alone
  can reliably parse for the semantic fields (provenance narrative,
  condition description). Cost is bounded (Haiku, one call, four short text
  blocks), but it is a real cost on every appraisal that has any notes at
  all, not a safety net.

---

## Implementation notes (2026-08-24)

All seven "next steps" below shipped in one pass, including Triage
integration (originally step 6, expected to wait for ADR-0003's items 2/4) —
it turned out to be a small, self-contained addition once Stage 1c existed,
not worth deferring.

**What shipped, matching the proposal:**
- `src/shared/text_extraction.ts` — `parseDimensions`, `extractCatalogueRefs`,
  `detectEditionSize` moved here from `benchmark/src/roseberys/parse.ts`,
  which now imports and re-exports them. `benchmark/src/forum/parse.ts` was
  deliberately left untouched (its own independent implementations).
- `APPRAISER_INPUT_SYSTEM_PROMPT` (`src/appraisal/prompts.ts`) and
  `APPRAISER_INPUT_SCHEMA` (`src/appraisal/schemas.ts`), following the
  output shape sketched above essentially unchanged.
- `AppraiserInputResult` type and `stage1cResult` field on
  `PrintAnalysisReport`, both in `src/types.ts`.
- `runStage1cAppraiserInput` on `MultiStageAppraiser`, same best-effort
  discipline as `runStage1bVisionSearch` (skips the API call entirely when
  no notes were submitted; returns an empty result on any failure rather
  than failing the pipeline).
- `AppraisalInput` gained `inscribedMarksNotes` / `provenanceNotes` /
  `conditionNotes` / `catalogueNotes` — additive, sent separately from the
  existing compiled `userNotes`. `server.ts` and `App.tsx` updated to pass
  them through; the four `AppraiserNotesInput.tsx` boxes themselves are
  unchanged, exactly as proposed (backend-only change).

**Deviations from the proposal:**
- **Stage 1c launches before Stage 1a even starts**, not merely "alongside"
  it — `FourStageAppraiser.appraise()` kicks off
  `runStage1cAppraiserInput` first, then awaits VEA, so the two genuinely
  overlap for their full duration rather than just being scheduled close
  together.
- **Stage 2a now explicitly awaits Stage 1c's result before running**,
  which the original design didn't quite commit to (it said Triage would
  "see all three at once" without saying whether that meant "wait for all
  three" or "receive whichever have already resolved"). In practice this
  costs nothing when there are no notes (Stage 1c returns immediately) and
  a few seconds when there are — judged worth it for Triage to reliably
  have the claims rather than sometimes not, depending on timing.
- **`{userNotes}` removal turned out to be a no-op fix**, not a behavioural
  one — see the correction in Context above. The `input.userNotes`
  argument was removed from the `runStage1VEA` call site for clarity, but
  it had nothing to substitute in `VISUAL_EXTRACTION_SYSTEM_PROMPT` even
  before this change.
- **Triage integration is a prompt-level addition, not a schema change** —
  `TRIAGE_SCHEMA`/`TriageResult` gained no new fields. Stage 1c's claims are
  appended to Stage 2a's existing user message as a text block with
  explicit trust-weighting instructions (documented_fact > hypothesis;
  hypothesis no higher than VEA's own evidence; conflicts recorded, never
  silently resolved), and Triage's existing free-text fields
  (`traditionNotes`, risk flag notes) are where that reasoning surfaces.
  Deeper structural integration can still happen alongside ADR-0003 items 2
  and 4 if a schema-level change turns out to be needed later.
- **Stage 1c's model is hardcoded** (`STAGE1C_MODEL = "claude-haiku-4-5"`),
  not a per-config field like Stage 1b's `stage1bModel`. No config currently
  needs to vary it; can be promoted to a config field if that changes.
- **3-stage legacy path is untouched**, as the original proposal allowed —
  it has no Stage 2a to feed Stage 1c's output into, so it was left exempt
  rather than given equivalent treatment.
- **Correction (2026-08-24)**: the Stage 2a text block above initially
  serialized only `claimedAttribution`, `inscriptionClaims` (minus
  `editionSizeClaim`), `provenanceChain`, `conditionClaims`, and
  `catalogueReferences` — `dimensionsClaim` was extracted by Stage 1c but
  never included in the block at all, and `editionSizeClaim` (the parsed
  integer, distinct from the string `editionClaim`) was dropped the same
  way. Neither field being present also meant `hasStructuredClaims` could
  be `false`, and the whole block skipped, for a lot where dimensions were
  the only thing extracted. Also added `paperOrSupport` (schema had no
  field for paper/support material at all — `technique` existed but only
  nested inside `claimedAttribution`) since it's exactly the kind of
  physical detail a real catalogue entry states and Triage should see.
  Found via `tests/backtest/` — a real Roseberys lot's dimensions and paper
  type were visibly extracted by Stage 1c but never reached Stage 2a.

**Verification:** ran a real appraisal through the actual pipeline (not a
schema-validation-only check) with realistic notes across all four boxes —
a documented edition claim ("Ed. 45/100... signed"), a provenance claim with
an invoice reference, a condition claim explicitly hedged as unconfirmed
("believed to have been relined... no documentation of this survives"), and
a catalogue reference in plain prose with no brackets ("Bloch 1244", not
"[Bloch 1244]"). Confirmed: the catalogue reference was correctly tagged
`source: "llm"` (the regex pass genuinely can't match unbracketed prose, so
this proves the LLM pass is doing real work, not just deferring to regex);
the hedged relining claim was correctly tagged `hypothesis` while the
Sotheby's/invoice claim was tagged `documented_fact`; and — using a
deliberately blank/featureless test image so VEA would find nothing —
Triage correctly detected the resulting mismatch between the appraiser's
detailed claims and VEA's empty observation, flagged it as a primary
conflict, declined to name an individual artist from the claims alone, and
routed to Tier 3 with mandatory human escalation. That last result is the
actual point of this whole design: conflicting evidence surfacing as a risk
flag instead of being silently resolved in either direction.
