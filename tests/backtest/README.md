# Backtest Harness

Runs the real appraisal pipeline blind against a live Roseberys auction lot,
then diffs the result against the withheld catalogue facts. Two parts:

1. **Fetch + run** — given a sale reference and lot number, pull the primary
   lot image and the catalogue description from Roseberys, and feed both
   through the actual production pipeline (`getAppraiserFromConfig`, same
   entry point `server.ts` uses): the image as the primary scan, the
   description as the Appraiser Input Agent's (Stage 1c) notes — exactly
   as a human appraiser transcribing the catalogue into the app's four
   notes boxes would. The artist name, title, and estimate are **never**
   sent to the app — `parseDescription()` splits off the artist/
   nationality/title header from the rest of the catalogue body, and none
   of Stage 1c's four boxes (`AppraiserNotesInput.tsx`) is "who is the
   artist" in the real UI either — that's an assessment the pipeline is
   meant to reach on its own, not a field an appraiser types in. Everything
   else — medium, support, dimensions, edition markings, printer/publisher,
   inscriptions — goes in verbatim, raw, as typed by Roseberys.
2. **Compare** — parses the catalogue description (`parseDescription()`,
   already used by `benchmark/src/roseberys/`) to recover the withheld
   artist, title, and estimate, then flags material differences: different
   artist, different artwork/title, or an estimate range that doesn't
   plausibly overlap.

This is a manual trial harness, not an automated assertion suite — it
doesn't pass/fail a test run, it runs the real agent against a real lot and
gives you something to read. Built the same way as `tests/vea/`.

## Usage

```bash
# Sale code + lot number (most common)
npm run test:backtest -- --sale A0800 --lot 123

# Bare auction_id also works
npm run test:backtest -- --sale 665 --lot 45A

# Override the appraiser config (default: claude-4stage, the production default)
npm run test:backtest -- --sale A0800 --lot 123 --method claude-4stage-fast
```

`--sale` accepts anything `resolveSaleRef()` understands: a bare
`auction_id`, a sale code (`"A0800"`, case-insensitive), or a slug fragment
(`"prints-multiples"`). `--lot` matches against both `lot_number` and
`total_lot_number`, so lettered/split lots (`"45A"`) work.

`--method` must be an id from `appraiserConfigs` in
`src/appraisal/appraiser.ts` — that's the same registry the app's method
picker uses, so anything selectable in the UI is selectable here.

## Output

Each run writes to `tests/backtest/output/<SaleCode-LotNumber>/` (gitignored
— regenerate, don't commit):

- `result.json` — full run record: sale/lot metadata, the exact
  `appraiserInputNotes` sent to Stage 1c, the app's `PrintAnalysisReport`,
  the parsed ground truth (`ParsedLot`), the raw lot record, and the
  comparison verdict.
- `report.html` — a self-contained side-by-side report: the lot image, the
  notes given to the Appraiser Input Agent and what it extracted from them,
  the app's output next to the catalogue's withheld facts, match/mismatch
  tags on artist/title/estimate, and the material-differences list called
  out at the top. Open directly in a browser — no server needed.

## How it works

`run_backtest.ts`:
1. `resolveSaleRef()` + `fetchLotByNumber()` (both in
   `benchmark/src/roseberys/`) locate the `RawLot`.
2. Downloads the primary image (`imageUrl(lot)`) and base64-encodes it.
3. Runs `parseDescription(lot.description)` to get `ParsedLot` — used two
   ways: its fields become the `AppraisalInput`'s Stage 1c notes, and the
   whole object is also the answer key for Part 2 comparison.
   `catalogueNotes` gets `bodyLines` joined verbatim (the raw, unprocessed
   catalogue text between the title line and the "Provenance" heading —
   medium, support, dimensions, edition markings, printer/publisher,
   inscriptions, all as typed) plus any catalogue-raisonné refs found
   (those sit in the title line by house convention, so `bodyLines` alone
   would miss them). `inscribedMarksNotes` and `provenanceNotes` additionally
   get `parseDescription()`'s cleanly-split inscription and provenance
   lines — some overlap with what's already in `catalogueNotes` is expected
   and fine; Stage 1c's prompt is explicitly designed to scan all four
   blocks holistically. `artist` and `title` are read only for comparison —
   parsed but never plumbed into any notes field, since neither has a
   corresponding notes box in the real UI to go into.
4. Builds the `AppraisalInput` — image + those four notes fields +
   `currency: "GBP"`, no `userNotes`, no supplementary images, no
   estimate — and calls `getAppraiserFromConfig(config).appraise(input)`.
5. `compare.ts` diffs the resulting `PrintAnalysisReport` against the
   `ParsedLot` and the raw estimate fields.

`compare.ts` has no I/O — it's pure comparison logic, kept separate so the
matching rules (name normalization, title token-overlap threshold, estimate
range/midpoint tolerance) can be read and adjusted without touching the
fetch/run orchestration.

`currency` is hardcoded to `"GBP"` in the harness because Roseberys
estimates are always GBP-denominated — this keeps the estimate comparison
apples-to-apples regardless of what currency a given appraiser config
defaults to.

## Match logic (what counts as a "material difference")

- **Artist** — exact/partial/none. Partial covers surname-only matches and
  "Picasso" vs "Pablo Picasso"; only `none` is flagged as a difference.
  Qualifiers (`attributed to`, `circle of`, etc.) are surfaced but don't
  affect the match itself.
- **Title** — token-overlap similarity score (not exact match — translated
  or reworded titles are common and not a real disagreement). Below the
  threshold is flagged.
- **Estimate** — flagged only if the app's range and the catalogue's range
  don't overlap *and* the midpoints aren't within 2x of each other. Auction
  estimates are themselves a range, not a point value, so adjacent
  non-contradictory ranges shouldn't read as a material difference.

## Known limitations

- One lot per invocation — no batch/sweep-a-sale mode yet. For a larger
  backtest corpus, `benchmark/src/roseberys/extract.ts --benchmark` already
  builds blind-mode records at scale; this harness is for looking closely at
  one lot at a time.
- `leakRisks` from `parseDescription()` includes "printer/publisher named"
  and "catalogue ref(s)" even though both are now deliberately sent (they
  double as genuinely useful appraiser-note content, not just leaks) — the
  flag that still matters here is the artist-surname check, which would
  mean the surname appears somewhere in the body text *outside* the title
  line this harness excludes. That's logged as a warning but doesn't block
  the run. It's also surfaced in case the *image itself* carries a visible
  signature/label that would leak the same information regardless.
- `condition` is populated by `parseDescription()`'s LLM fallback only —
  the regex pass used here (no `--llm-fallback` flag, unlike
  `benchmark/src/roseberys/extract.ts`) leaves it `null` for most lots, so
  `conditionNotes` is often empty. That matches reality: Roseberys'
  catalogue prose rarely states condition explicitly.
- No automated pass/fail threshold across a batch of lots — each run is
  read individually via the HTML report.
