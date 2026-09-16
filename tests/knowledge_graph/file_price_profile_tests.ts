/**
 * profileFromBuild: own entries, segment fallback, and the committed Stage 3a build loads. `npm run test:file-price-profile`
 */
import { profileFromBuild, loadPriorsBuild, type PriorsBuild } from "../../src/appraisal/knowledge_graph/file_price_profile";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } }
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

const build: PriorsBuild = {
  version: "TEST", built_at: "2026-09-16T00:00:00Z", reference_levels: { area_band: "1800-7500" }, continuous_medians: { edition_log: 4.2 }, year_effects: { "2024": 0.1 },
  artists: { "A Artist": { earlier_sales: 40, basis: "shrunk", price_level_log: 6.5, elasticities: { signature_hand: { value: 0.7 }, area_log_xl: { value: 0.4 }, bad: { value: NaN } }, neighbours: { "B": 0.2, "C": 0.8 } } },
  segment_defaults: { "british|modern": { price_level_log: 5.5, elasticities: { signature_hand: 0.5 } }, "any|any": { price_level_log: 5.0, elasticities: { signature_hand: 0.4 } } },
};
{
  const own = profileFromBuild(build, "A Artist", null, null)!;
  eq("own entry: level, basis, run", [own.level, own.basis, own.earlierSales, own.run], [6.5, "shrunk", 40, "TEST@2026-09-16T00:00:00Z"]);
  eq("own entry: non-finite coefficients dropped", Object.keys(own.elasticities).sort(), ["area_log_xl", "signature_hand"]);
  eq("own entry: neighbours sorted by weight", own.neighbours.map((n) => n.name), ["C", "B"]);
  ok("xl term's multiplier is per doubling", Math.abs(own.multipliers.area_log_xl - Math.exp(0.4 * Math.LN2)) < 1e-12);
  const seg = profileFromBuild(build, "New Artist", "British", 1900)!;
  eq("no own entry: nationality x period segment", [seg.basis, seg.segment, seg.level], ["segment", "british|modern", 5.5]);
  eq("no facts: global segment", profileFromBuild(build, "Unknown", null, null)!.segment, "any|any");
  const committed = loadPriorsBuild();
  ok("the committed Stage 3a build loads, with shape bands and the extra-large term", !!committed && committed.reference_levels.area_band === "1800-7500" && Object.values(committed.artists).some((a) => "area_log_xl" in a.elasticities));
}
console.log(`\nfile price profile tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
