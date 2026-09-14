/**
 * Cache breakpoints for Stage 2b's tool loop (withRollingCache).
 *
 * Anthropic caches a PREFIX and permits at most four breakpoints. Stage 2b uses all four: tools,
 * system, the first user message (this lot's evidence), and one that ROLLS to the last user turn
 * so each round trip reads what the previous one sent. The invariant that matters is that the
 * rolling one MOVES — an implementation that adds a breakpoint per turn passes a casual eye and
 * then fails the fifth request of a long loop.
 *
 *   npm run test:rolling-cache
 */
import { withRollingCache } from "../../src/appraisal/appraiser";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);
const marks = (ms: any[]) => ms.flatMap((m: any) => m.content).filter((b: any) => b?.cache_control).length;
const markedOn = (ms: any[]) => ms.map((m: any, i: number) => (m.content.some((b: any) => b?.cache_control) ? i : -1)).filter((i) => i >= 0);

console.log("the first user message is marked, and string content is normalised to blocks");
{
  const r = withRollingCache([{ role: "user", content: "TRIAGE OUTPUT ..." }]);
  eq("one breakpoint on a single-message conversation", marks(r), 1);
  eq("content became a block array", r[0].content[0].type, "text");
  eq("carrying the original text", r[0].content[0].text, "TRIAGE OUTPUT ...");
  ok("and the breakpoint is on it", !!r[0].content[0].cache_control);
}

console.log("the breakpoint rolls rather than accumulating");
{
  // Four turns of a real loop: user text, assistant tool_use, user tool_result, assistant, user.
  const convo = [
    { role: "user", content: "lot evidence" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "web_search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "5 results" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "b", name: "web_search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "5 results" }] },
  ];
  const r = withRollingCache(convo);
  eq("exactly two message breakpoints, never one per turn", marks(r), 2);
  eq("on the first user turn and the last, nothing in between", markedOn(r), [0, 4]);
  // Four is the hard limit: tools + system + these two.
  ok("leaves room for the tools and system breakpoints", marks(r) + 2 <= 4);
}

console.log("assistant turns are never edited");
{
  const assistant = { type: "tool_use", id: "a", name: "web_search", input: { query: "x" } };
  const r = withRollingCache([
    { role: "user", content: "evidence" },
    { role: "assistant", content: [assistant] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
  ]);
  ok("no breakpoint on the assistant turn", !r[1].content.some((b: any) => b?.cache_control));
  eq("its blocks survive verbatim", r[1].content[0], assistant);
}

console.log("the input is not mutated");
{
  const original = [{ role: "user", content: "evidence" }];
  withRollingCache(original);
  eq("caller's messages are untouched", original[0].content, "evidence");
}

console.log("degenerate shapes never throw");
{
  eq("no messages", withRollingCache([]), []);
  eq("assistant only, nothing to mark", marks(withRollingCache([{ role: "assistant", content: [{ type: "text", text: "x" }] }])), 0);
  const empty = withRollingCache([{ role: "user", content: [] }]);
  eq("an empty content array is left alone rather than indexed at -1", marks(empty), 0);
  eq("null content becomes an empty array", withRollingCache([{ role: "user", content: null }])[0].content, []);
}

console.log("the breakpoint lands on the LAST block, which is where the prefix ends");
{
  const r = withRollingCache([{ role: "user", content: [
    { type: "tool_result", tool_use_id: "a", content: "first" },
    { type: "tool_result", tool_use_id: "b", content: "second" },
  ] }]);
  ok("not the first block", !r[0].content[0].cache_control);
  ok("the last one", !!r[0].content[1].cache_control);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
