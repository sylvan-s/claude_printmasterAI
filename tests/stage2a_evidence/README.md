# tests/stage2a_evidence

Unit tests for `src/appraisal/stage2a_evidence.ts` — the glue between the ADR-0010
Attribution Evidence Agent and the deterministic two-pass tree.

```
npm run test:stage2a-evidence
```

No LLM, no network. `fixtures.ts` holds hand-built `EvidenceAgentOutput` objects (what the
`report_attribution_evidence` tool call returns); the tests push them through
`evidenceToTwoPassInput` → `classifyTwoPass` → `assembleTriageResult` and assert on the
verdicts, the mapped `TwoPassInput` cells, and the assembled `TriageResult` (scenario, tier,
`candidateArtists`, `evidenceCorroboration`, and the Decision 7 `artistAttribution` /
`workIdentification` / `impressionAssessment` fields).

The two-pass **tree** itself is tested separately in `tests/two_pass_attribution/`. To run the
real evidence agent (live Claude + `query_ackg`) against the stored Stage 1 fixture:

```
npm run test:pool:triage -- --evidence --limit 3
```
