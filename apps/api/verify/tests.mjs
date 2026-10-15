import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const file = resolve(import.meta.dirname, "..", ".vitest-result.json");
if (!existsSync(file)) { console.error("API-TESTS FAILED: no result file"); process.exit(1); }
const r = JSON.parse(readFileSync(file, "utf8"));
const problems = [];
if ((r.numTotalTests ?? 0) === 0) problems.push("no tests collected");
if ((r.numFailedTests ?? 0) > 0) problems.push(`${r.numFailedTests} failed`);
if ((r.numPendingTests ?? 0) + (r.numTodoTests ?? 0) > 0) problems.push("tests were skipped");
if (problems.length) { console.error(`API-TESTS FAILED (${problems.length})`); for (const p of problems) console.error(`  - ${p}`); process.exit(1); }
console.log(`API-TESTS OK ${r.numPassedTests} test(s)`);
