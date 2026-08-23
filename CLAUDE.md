## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` at root + `docs/adr/`. See `docs/agents/domain.md`.

### Appraisal pipeline architecture

3-stage / 4-stage pipeline (VEA → Triage → Specialist → Valuation), stage
responsibilities, model assignments. See `PIPELINE.md` and `CONTEXT.md`.

### Benchmark & auction-house extractors

Ground-truth data collection (`benchmark/`) for evaluating the pipeline —
Roseberys and Forum Auctions extractors, why they're separate modules, what's
committed vs gitignored, the PDF export/Puppeteer workflow, and git remotes.
See `docs/agents/benchmark.md`.

### VEA trial harness

Run Stage 1a alone against a DB item or local image and get back a readable
HTML report (every field + its confidence, bounding boxes overlaid on the
image) — for fast iteration on VEA prompt/schema changes without running the
full pipeline. `npm run test:vea -- --item <uuid>`. See `tests/vea/README.md`.
