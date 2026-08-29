# Two-pass attribution classifier tests

Unit tests for `src/appraisal/two_pass_attribution.ts` — the deterministic half of
ADR-0010 (`docs/adr/0010-two-pass-attribution-artist-then-work.md`).

```
npm run test:two-pass
```

Plain `node:assert` run via `tsx` — no LLM, no network, no test framework (matches
`tests/routing/`). 56 cases:

- **Pass 1 (Artist)** — one per A1..A11 row, plus the layered rules: hypothesis is not a
  vote, Stage 1b dropped when inconsistent with VEA or below the sim floor, the
  documented-fact-vs-signature conflict override, subject corroboration carried through
  without affecting the verdict, Tate reversed-name agreement.
- **Pass-2 gate** — opens on an attributed / MEDIUM+ candidate artist, blocks a LOW
  candidate, opens via the in-image-title exception regardless of the artist verdict.
- **Pass 2 (Conceptual Work)** — one per T1..T7 row.
- **Impression divergence (5b)** — none / variant_sheet / later_edition / medium_divergence
  / reproduction, plus the dimension rules (plate-mark primary, `UNASSESSABLE` without a
  scale scan or a like-for-like pair).
- **Scenario mapping (Decision 8)** — the structured verdicts to ADR-0006's six scenarios,
  including the ordering guarantee (divergence / conflict checked before a clean match).
- **`classifyTwoPass` end-to-end** — including the bounded work→artist back-propagation.

## What this does NOT cover

The Sonnet "evidence agent" (ADR-0010 Decision 9.2) that fills the evidence cells, and the
embedding-based fuzzy name/title matcher (Decision 9.1) — this module ships a token-set
placeholder for the latter (`nameSimilarity` / `titleSimilarity`), deliberately loose, to be
replaced before production.
