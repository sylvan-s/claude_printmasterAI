# VEA Trial Harness

Runs Stage 1a (Visual Extraction Agent) alone, against a real DB item or a
local image file, and writes back a JSON result plus a readable HTML report.
Built for fast iteration on VEA prompt/schema changes — see
[ADR-0003](../../docs/adr/0003-knowledge-graph-grounded-triage.md) for the
"every VEA field needs a confidence score" work this was built to validate.

This is a manual trial harness, not an automated assertion suite — it doesn't
pass/fail anything, it runs the real agent and gives you something to read.
`tests/test-connection.js` and friends in the parent directory are the
project's other loose diagnostic scripts; this one just has its own
sub-folder because it has supporting code (`build_report.ts`) alongside it.

## Usage

```bash
# A DB item, by items.id (fetches its primary image)
npm run test:vea -- --item 76af658c-658d-482c-bc8a-fa12464f3eeb

# A local image file
npm run test:vea -- --image ~/Desktop/some_print.jpg

# Several targets in one run (each processed independently)
npm run test:vea -- --item <uuid-1> --item <uuid-2> --image ~/Desktop/print.jpg

# Override the model (default: claude-opus-4-8, matching claude-4stage's
# production stage1Model)
npm run test:vea -- --item <uuid> --model gemini-2.5-pro
```

Finding an item id: query the DB directly, e.g.

```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query(\`
    SELECT i.id, im.original_filename
    FROM items i JOIN images im ON im.item_id = i.id AND im.image_type = 'primary'
    WHERE im.original_filename ILIKE '%<search term>%'
  \`);
  console.log(r.rows);
  await pool.end();
})();
"
```

## Output

Each target writes to `tests/vea/output/<slug>/` (gitignored — regenerate,
don't commit):

- `result.json` — the raw `VisualExtractionResult`
- `report.html` — a self-contained HTML report: every field grouped by VEA
  section, a confidence bar per field, and every `box_2d` overlaid on the
  primary image (dashed = boundary/region box, solid = discrete evidence
  point). Open directly in a browser — no server needed.

## How it works

`run_vea_trial.ts` instantiates the real `FourStageAppraiser` (from
`src/appraisal/appraiser.ts`, config `claude-4stage`) and calls its
`runStage1VEA` method directly — the actual production code path, not a
reimplementation. `runStage1VEA` is `protected`; this harness deliberately
reaches past that with a cast rather than re-deriving the prompt-building,
schema-translation, and API-call logic by hand, so a trial run can never
silently drift from what the live pipeline actually does.

`build_report.ts` is a generic renderer over `VisualExtractionResult` — it
reads whatever the result actually contains (empty arrays render as an empty
state, missing sections render as "not present"), so it doesn't need updating
when VEA's schema gains or drops fields, only when a genuinely new *kind* of
section is added.

## Known limitations

- Supplementary scans (`SIGNATURE_SCAN`, `DAMAGE_SCAN`, `SCALE_SCAN`) aren't
  wired into the CLI yet — only the primary scan is sent. Extending
  `parseArgs`/`AppraisalInput` construction to accept `--signature <path>`
  etc. is a follow-up, not a design constraint.
- `--item` only supports items whose `storage_key` is a base64 data URI
  (the current storage scheme). If the project moves to external blob
  storage, `loadFromDb` will need a fetch path added.
- Gemini models are supported via `--model` but untested by this harness so
  far — only the Claude branch has been run end-to-end.
