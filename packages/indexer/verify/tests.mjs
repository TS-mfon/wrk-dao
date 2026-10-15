// Turns vitest's result file into a gate token.
//
// `vitest run` exiting zero is not enough on its own: a run that collected nothing also
// exits zero. So this requires a non-empty suite with no failures and no skips — a skipped
// read-model test is a claim nobody checked.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const result = resolve(import.meta.dirname, "..", ".vitest-result.json");
if (!existsSync(result)) {
  console.error("INDEXER-TESTS FAILED: vitest wrote no result file");
  process.exit(1);
}

const report = JSON.parse(readFileSync(result, "utf8"));
const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const pending = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;

const problems = [];
if (total === 0) problems.push("the suite collected no tests");
if (failed > 0) problems.push(`${failed} test(s) failed`);
if (pending + todo > 0) problems.push(`${pending + todo} test(s) were skipped or marked todo`);
if (passed !== total) problems.push(`${passed} of ${total} passed`);

if (problems.length > 0) {
  console.error(`INDEXER-TESTS FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`INDEXER-TESTS OK ${passed} test(s)`);
