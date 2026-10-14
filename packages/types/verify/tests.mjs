// G8 evidence: the unit suite ran, every expected file was collected, and nothing
// failed.
//
// `vitest run && echo OK` would pass if a config change silently stopped collecting
// a file — the suite would report zero failures over a shrinking set. This reads the
// JSON reporter output and asserts the file list, so "the tests pass" cannot quietly
// become "the tests that are left pass".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, check, checkEqual, finish, abort } from "./_common.mjs";

const EXPECTED_FILES = [
  "test/canonical.test.ts",
  "test/eip712.test.ts",
  "test/fixtures.test.ts",
  "test/hashing.test.ts",
  "test/ids.test.ts",
  "test/money.test.ts",
  "test/schemas.test.ts",
  "test/states.test.ts",
];

try {
  const raw = readFileSync(join(PACKAGE_ROOT, ".vitest-result.json"), "utf8");
  const report = JSON.parse(raw);

  checkEqual(report.success, true, "vitest must report success");
  checkEqual(report.numFailedTests ?? -1, 0, "no test may fail");
  checkEqual(report.numFailedTestSuites ?? -1, 0, "no suite may fail");
  checkEqual(report.numPendingTests ?? 0, 0, "no test may be skipped");
  check((report.numTotalTests ?? 0) > 0, "the suite must contain tests");
  checkEqual(
    report.numPassedTests,
    report.numTotalTests,
    "every collected test must have passed",
  );

  const ran = new Set(
    (report.testResults ?? []).map((result) =>
      String(result.name ?? "")
        .replace(/\\/g, "/")
        .split("/packages/types/")
        .pop(),
    ),
  );
  for (const file of EXPECTED_FILES) {
    check(ran.has(file), `${file} must have been collected and run`);
  }
  checkEqual(ran.size, EXPECTED_FILES.length, `expected exactly ${EXPECTED_FILES.length} test files`);

  finish("TYPES-TESTS OK");
} catch (error) {
  abort(error);
}
