# Benchmark & Auction-House Extractors

Ground-truth data collection for evaluating the appraisal pipeline (GitHub issue
#12), plus a spin-off gift/utility for auction houses (better search over their
own catalogue). Lives under `benchmark/`, separate from `src/appraisal/`.

## Why this exists

Every pipeline-quality issue (#1, #7, #8, #11...) is unfalsifiable without real
auction results to score against. This directory builds that corpus by pulling
public catalogue data — descriptions, images, estimates, hammer prices — from
auction houses whose print/multiples sales overlap PrintMaster AI's domain.

## Directory layout

```
benchmark/
├── .gitignore              # data/ and runs/ — see "What's committed" below
├── src/
│   ├── roseberys/           # Roseberys London extractor
│   │   ├── api.ts             fetch + auction discovery via getLots endpoint
│   │   ├── discover.ts        sitemap-based auction enumeration
│   │   ├── parse.ts           catalogue-prose → structured fields
│   │   ├── llm_fallback.ts    narrow LLM re-extraction for regex failures
│   │   ├── extract.ts         CLI: produces catalogue.csv + benchmark lots/*.json
│   │   └── build_workbook.py  catalogue.csv → search-friendly .xlsx (Excel Table + formulas)
│   └── forum/                # Forum Auctions extractor — DISTINCT module, see below
│       ├── api.ts
│       ├── discover.ts
│       ├── parse.ts
│       └── extract.ts
└── data/                    # gitignored — regenerate with the npm scripts below
    ├── roseberys/ or all-prints/
    │   ├── catalogue.csv
    │   ├── lots/*.json        benchmark records (facts only, per #12 schema)
    │   ├── raw/                transient API dumps, deleted after each run unless --keep-raw
    │   └── images/              gitignored image cache, never committed
    └── forum/
        └── catalogue.csv
```

## Roseberys vs Forum: two auction houses, two modules, one output schema

Both houses run the same underlying platform (Auction Marketer / Joomla), so the
*shape* of the work is identical — sitemap discovery, a `commission.getLots` JSON
endpoint, prose descriptions to parse. But field **semantics** differ enough
between the two that a shared config would have silently corrupted data, so
they're separate modules under `benchmark/src/{roseberys,forum}/`:

| | Roseberys | Forum Auctions |
|---|---|---|
| `lot_order` param | `"lot_asc"` | `"ASC"` — wrong value throws a raw SQL error |
| `hammer_price` field | **Premium-inclusive** (buyer's premium baked in, ~1.30–1.312x) | **True hammer** — no reconstruction needed |
| True hammer source | `rostrum_hammer`, only populated on **recent** sales; older sales need premium backed out — see `inferSalePremium()` in `roseberys/api.ts` | `hammer_price` directly |
| Sold signal | `sold` field (0/1, reliable) | `sold` is an **unreliable string** `"0"`/`"1"` — use `hammer_price > 0` instead |
| Description format | `<br>`-delimited, nationality on its own line, dims in cm | `<p>`-delimited, life dates inline `(b.1938)`, dims in **mm** |
| Sale date | Not needed (sale-scoped fetch) | Not in API — scraped from the sale page; two title formats need two fallback regexes |
| robots.txt crawl-delay | Not stated — throttled at 700ms as a courtesy | **`crawl-delay: 15`, explicit — honoured on every request** (`DELAY_MS` in `forum/api.ts`) |
| AI-bot blocks in robots.txt | ClaudeBot, GPTBot, etc. explicitly blocked | None |

**If a future session needs a third auction house**: copy the module pattern
(`api.ts` / `discover.ts` / `parse.ts` / `extract.ts`), don't try to generalise
Roseberys and Forum into one shared config first — the two houses only agree on
the *endpoint shape*, not on what any given field means.

Both extractors emit the **same CSV column schema** deliberately, so
`roseberys/data/*/catalogue.csv` and `forum/data/catalogue.csv` concatenate
directly for a merged valuation corpus. Forum's rows carry `source` and
`sale_date` columns Roseberys's don't need (Roseberys extracts are already
sale-scoped per run).

## What's committed vs regenerated

**Code is committed. Data is not** (`benchmark/.gitignore`). This is a deliberate
posture, not an oversight:

- Roseberys' terms assert copyright over catalogue text and images; robots.txt
  blocks AI crawlers by name. Written permission has been requested but is not
  yet in hand as of this writing.
- Every dataset here is **fully regenerable** from the public APIs — nothing is
  lost by not committing it, and nothing goes out on a limb before permission is
  confirmed.
- When permission lands, `benchmark/data/*/lots/*.json` (facts only — artist,
  medium, dimensions, estimate, hammer — never raw catalogue prose) can be
  committed per #12's design; images stay gitignored regardless.

Regenerate with:
```bash
npm run bench:fetch  -- --auction <id>          # one Roseberys sale
npm run bench:fetch  -- --all-prints             # every Roseberys Prints & Multiples sale
npm run bench:fetch  -- --auction <id> --benchmark --images   # + benchmark lots + image cache
npm run forum:fetch  -- --auction <id>           # one Forum sale
npm run forum:fetch  -- --all-prints             # every Forum prints/editions sale (respects 15s crawl-delay)
```

## Known data-quality gotchas (don't "fix" these back)

- **Roseberys `hammer_price` is NOT the hammer price** — it's premium-inclusive.
  `hammerOf(lot, premiumRatio)` in `roseberys/api.ts` handles this; the premium
  ratio is inferred per-sale by checking which candidate ratio makes realised
  prices land back on standard auction bid increments (see `inferSalePremium`).
- **Forum's `sold` field lies** — it's a string, and `"1"` doesn't reliably mean
  sold. `isSold()` in `forum/api.ts` checks `hammer_price > 0` instead.
- **Unclosed/future sales must be excluded**, not just flagged — an upcoming
  sale with 0 lots sold isn't "everything passed", it hasn't happened yet.
  `forum/extract.ts` excludes on `sale_date > today` OR (`≥20 live lots` AND
  `0 sold`) — the second catches sales whose date couldn't be parsed.
- **Non-print media leaks into nominally-print sales** — some Forum "editions
  and..." sales also carry drawings, ceramics, sculpture. Flagged via
  `is_print_medium`, not silently dropped (a downstream user should decide the
  cutoff, not the extractor).
- **Artist name fragmentation** — e.g. "Julian Trevelyan RA" vs "Julian Otto
  Trevelyan RA" as separate strings for the same person. Not yet resolved by
  either extractor; matters for any per-artist rollup or cross-house merge.

## PDF certificate export (Puppeteer)

`scripts/export_pdfs.mjs` drives the **live running app** (not a hand-built HTML
clone) via a global `window.__pdfExportLoad(itemId, email)` function exposed
from `App.tsx`, so exported PDFs are pixel-identical to what a user sees via
Cmd+P. Requires the dev server running on `localhost:3000` first.

```bash
npm run dev &                    # server must be up first
node scripts/export_pdfs.mjs     # ITEMS list inside the script — see below
```

The `ITEMS` array at the top of the script is a **hardcoded snapshot** of one
catalogue's live item IDs — it does not query the DB itself. Before running, if
the catalogue may have changed, check it against the actual DB state:

```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query(\`SELECT id, name FROM catalogues WHERE name ILIKE '%<search term>%'\`);
  console.log(r.rows);
  await pool.end();
})();
"
```
then join `items` → `appraisals` filtered to that `catalogue_id` with
`deleted_at IS NULL` (soft-deleted items must stay excluded) to get the current
live item list, and update `ITEMS` to match before exporting.

## Git remotes

- `origin` → `github.com/sylvan-s/claude_printmasterAI` — the active repo, all
  work pushes here.
- `upstream` → `github.com/sylvan-s/Fine-Art-Print-Analyzer` — the project's
  earlier name/location. Present for history; don't push there by default.
- Working branch: `new_prompting_strategy`.

Issues referenced in this doc (#1, #7, #8, #9, #10, #11, #12) live in GitHub
Issues on `origin` — see `docs/agents/issue-tracker.md`.
