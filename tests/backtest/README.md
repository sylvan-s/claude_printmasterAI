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

## Degraded copies of the pool (robustness runs)

The pool's images are the auction house's studio shots — square-on, evenly lit, sharp.
Real appraiser input is not. `knowledge_graph/build_noisy_pool.py` makes degraded copies of
every pool image and writes one pool JSON per degradation, identical to
`test_pool_100.json` except that `imageUrl` points at the local degraded file. Same lots,
same ground truth, same Stage 1c notes — so anything that moves between the clean run and
a degraded run is attributable to the image alone.

```bash
# all 8 recipes over the whole pool (downloads each source image once, into _source/)
knowledge_graph/venv-embeddings/bin/python knowledge_graph/build_noisy_pool.py

knowledge_graph/venv-embeddings/bin/python knowledge_graph/build_noisy_pool.py --list
knowledge_graph/venv-embeddings/bin/python knowledge_graph/build_noisy_pool.py \
    --recipes angle,glare --limit 10 --contact-sheet
```

| recipe | what it simulates |
| --- | --- |
| `pristine` | control — same decode/re-encode path, no degradation |
| `lowres` | a small image: 340-430px long edge, JPEG q58-72 |
| `defocus` | out of focus — Gaussian blur at 0.35-0.75% of the long edge |
| `glare` | specular hot spots + a light streak, geometry untouched |
| `angle` | shot off-axis — yaw ±26°, pitch ±13°, roll ±5°, keystoned onto a surface |
| `framed` | mount board + moulding around the print, straight on |
| `framed_glass` | framed on a wall, tilted, behind glass with a window reflection |
| `phone_snap` | the composite worst case — tilt, uneven light, colour cast, mild defocus, glare, downscale, sensor noise, q40-55 |
| `mixed` | a random *combination* per lot rather than one named effect — see below |

`mixed` is the one to use for a robustness run. Every lot draws its own subset of the
primitives and its own severity (0-1, scaling every magnitude), so the 99 images span the
space of real-world bad photography instead of testing one axis at a time: 1-9 filters per
image, median 5. Across the built pool that came out as tilt 78%, JPEG 69%, glare 62%,
uneven light 58%, defocus 45%, downscale 44%, sensor noise 39%, frame 36%, colour cast
35%, window reflection 26%. `MANIFEST.json` records the exact draw per lot (`severity`,
`applied`), so any result can be regressed against what was actually done to the image.

Each lot's degradation is seeded from `(saleId_lot, recipe)`: random across the pool,
identical on every re-run. `--contact-sheet` writes `contact_sheets/<id>.jpg`, the source
next to every variant, for eyeballing what the model is being given.

Output (all gitignored — regenerate, don't commit):

```
tests/backtest/noisy_pool/
  _source/<id>.<ext>                    downloaded originals, reused across recipes
  images/<recipe>/<id>.jpg              the degraded copies
  pools/test_pool_100_<recipe>.json     drop-in replacement pool JSON
  contact_sheets/<id>.jpg               --contact-sheet only
  MANIFEST.json                         per-variant seed, size, quality, dimensions
```

Run one through the pipeline with `--pool`, and `--out` so the clean baseline in
`pool_output/` survives:

```bash
npm run test:pool -- --pool tests/backtest/noisy_pool/pools/test_pool_100_angle.json \
                     --out tests/backtest/pool_output_angle --limit 99
npm run test:pool:triage -- --dir tests/backtest/pool_output_angle
```

`run_pool.ts` reads `file://` image URLs directly, so a degraded run needs no network
beyond the model calls.

## Measuring Stage 1b / 1d against the degraded pool

`run_noise_robustness.ts` runs Stage 1b (Gemini reverse image search) and Stage 1d
(DINOv2/CLIP embedding match) **twice per lot** — once on the auction house's original
studio shot, once on the degraded copy — from the same pool JSON, which carries both.
Pairing is the point: an absolute hit rate on degraded images means nothing without the
clean number from the identical lot on the identical day.

```bash
npx tsx tests/backtest/run_noise_robustness.ts \
    --pool tests/backtest/noisy_pool/pools/test_pool_100_mixed.json --concurrency 5
npx tsx tests/backtest/run_noise_robustness.ts --limit 10 --skip-1b   # 1d only, no Gemini spend
```

Needs the embedding service (`knowledge_graph/embedding_service.py` on :8008), Neo4j, and
`GEMINI_API_KEY` unless `--skip-1b`. Writes `output/noise_robustness{.json,.md}`.

**Reading the two stages differently.** Stage 1b searches the open web, so the pool's
ground-truth artist/title is genuinely findable and clean-vs-degraded artist hit rate is a
real accuracy measurement. Stage 1d searches the ACKG image-embedding index, which covers
Bonhams + Tate + British Museum (52,939 images) and **no Roseberys or Forum** — the two
houses the pool is drawn from. The lot's own image file is never in the index, so there is
no self-match — but the exact *work* is still often reachable, because prints are editions
and Bonhams/Tate/BM frequently hold another impression of the same `ConceptualWork`
(measured: correct work in the top 3 for 24.2% of lots). Artist hits can also come from
that artist's other prints (3,717 artists, 35,972 works in the Bonhams corpus). The
coverage-independent signal is **retrieval stability** — how much of the clean top-3 the
degraded image still returns — which separates the lots that had a real match to lose from
the ones merely ranking stylistic neighbours.
