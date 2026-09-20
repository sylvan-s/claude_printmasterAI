/**
 * How often does the Stage 2b gate escalate, and does gating pay?
 *
 * The gated design (stage2b_gate.ts) runs Haiku first and redoes the stage on Sonnet when the
 * result cannot be checked. Its economics are entirely decided by the escalation rate E: the
 * stage costs about $0.04 on Haiku and $0.157 on Sonnet, so a gated lot costs 0.04 + E x 0.157
 * against 0.157 for always-Sonnet, and the design pays while E stays under about 75%.
 *
 * This reads stored runs rather than re-running anything, so the rate can be re-checked for free
 * as more lots accumulate. It reports the DENOMINATOR explicitly: a lot where routing skipped
 * Stage 2b never reached the gate and must not be counted as a pass.
 *
 *   npx tsx tests/backtest/stage2b_gate_rate.ts [--dir tests/backtest/output]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const DIR = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : `${import.meta.dirname}/output`;
/** Measured 2026-09-14: Stage 2b alone, not the whole lot. */
const COST_2B_CHEAP = 0.04, COST_2B_STRONG = 0.157;

interface Row { lot: string; reachedGate: boolean; escalated: boolean; reasons: string[]; detail: string; cost: number; skipped2b: boolean }

const rows: Row[] = [];
for (const d of readdirSync(DIR)) {
  const p = `${DIR}/${d}/result.json`;
  if (!existsSync(p)) continue;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const al = j.attributedLot;
  if (!al) continue;
  const g = al.stage2bGate;
  rows.push({
    lot: d, reachedGate: !!g, escalated: !!g?.escalate, reasons: g?.reasons ?? [], detail: g?.detail ?? "",
    cost: j.tokenUsage?.totalUsd ?? 0, skipped2b: !!al.routing?.stage2bSkipped,
  });
}
const gated = rows.filter((r) => r.reachedGate);
if (!gated.length) {
  console.log(`No gated runs found under ${DIR}. Only runs made with stage2bEscalationModel set record a gate decision.`);
  process.exit(0);
}
const esc = gated.filter((r) => r.escalated);
const E = esc.length / gated.length;

console.log(`\n══ Stage 2b escalation rate ══\n`);
console.log(`${"lot".padEnd(34)} ${"gate".padEnd(10)} ${"cost".padStart(7)}  reason`);
for (const r of rows.sort((a, b) => a.lot.localeCompare(b.lot))) {
  const state = !r.reachedGate ? (r.skipped2b ? "2b skipped" : "ungated") : r.escalated ? "ESCALATED" : "passed";
  console.log(`${r.lot.slice(0, 34).padEnd(34)} ${state.padEnd(10)} ${("$" + r.cost.toFixed(3)).padStart(7)}  ${r.escalated ? r.reasons.join(",") : ""}`);
}

console.log(`\n── Rate ──`);
console.log(`  ${rows.length} stored run(s); ${rows.length - gated.length} never reached the gate (Stage 2b skipped, or run before gating existed)`);
console.log(`  ${gated.length} reached the gate; ${esc.length} escalated  ->  E = ${(E * 100).toFixed(0)}%`);
if (esc.length) {
  const counts: Record<string, number> = {};
  for (const r of esc) for (const x of r.reasons) counts[x] = (counts[x] ?? 0) + 1;
  console.log(`  reasons: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

const gatedCost = COST_2B_CHEAP + E * COST_2B_STRONG;
const breakEven = (COST_2B_STRONG - COST_2B_CHEAP) / COST_2B_STRONG;
console.log(`\n── Does it pay? (Stage 2b only, measured $${COST_2B_CHEAP} cheap / $${COST_2B_STRONG} strong) ──`);
console.log(`  always-Sonnet      $${COST_2B_STRONG.toFixed(3)}/lot`);
console.log(`  gated at E=${(E * 100).toFixed(0)}%       $${gatedCost.toFixed(3)}/lot  ->  ${gatedCost < COST_2B_STRONG ? `${((1 - gatedCost / COST_2B_STRONG) * 100).toFixed(0)}% CHEAPER` : `${((gatedCost / COST_2B_STRONG - 1) * 100).toFixed(0)}% MORE EXPENSIVE`}`);
console.log(`  break-even at      E = ${(breakEven * 100).toFixed(0)}%`);
console.log(`\n  ${gated.length} lots is ${gated.length < 10 ? "not yet" : "barely"} a rate — treat the interval, not the point estimate.\n`);
