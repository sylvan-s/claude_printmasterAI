# Backtest Harness

Runs the real appraisal pipeline blind against a live Roseberys auction lot,
then diffs the result against the withheld catalogue facts. Two parts:

1. **Fetch + run** — given a sale reference and lot number, pull the primary
   lot image from Roseberys and feed it through the actual production
   pipeline (`getAppraiserFromConfig`, same entry point `server.ts` uses).
   The catalogue's own description, artist, and estimate are **never** sent
   to the app — only the image. This is what makes it a genuine test of
   independent attribution rather than a check that the app echoes back
   what it was told.
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

- `result.json` — full run record: sale/lot metadata, the app's
  `PrintAnalysisReport`, the parsed ground truth (`ParsedLot`), the raw lot
  record, and the comparison verdict.
- `report.html` — a self-contained side-by-side report: the lot image, the
  app's blind output next to the catalogue's withheld facts, match/mismatch
  tags on artist/title/estimate, and the material-differences list called
  out at the top. Open directly in a browser — no server needed.

## How it works

`run_backtest.ts`:
1. `resolveSaleRef()` + `fetchLotByNumber()` (both in
   `benchmark/src/roseberys/`) locate the `RawLot`.
2. Downloads the primary image (`imageUrl(lot)`) and base64-encodes it.
3. Runs `parseDescription(lot.description)` to get the ground truth
   (`ParsedLot`) — held aside, never passed into the pipeline call.
4. Builds a minimal `AppraisalInput` — image + `currency: "GBP"` only, no
   `userNotes`, no supplementary images, no catalogue text — and calls
   `getAppraiserFromConfig(config).appraise(input)`.
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
- `leakRisks` from `parseDescription()` (e.g. the artist's surname also
  appearing in the body text) are logged as a warning but don't block the
  run — they're a property of the *catalogue prose*, which is never sent to
  the app anyway. They're surfaced in case the *image itself* also carries
  a visible signature/label that would leak the same information.
- No automated pass/fail threshold across a batch of lots — each run is
  read individually via the HTML report.
