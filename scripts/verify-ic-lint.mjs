// Runs genvm-lint over every Intelligent Contract and refuses to accept a partial pass.
//
//   node scripts/verify-ic-lint.mjs
//
// Success prints exactly one line: IC-LINT OK <n> contract(s)
//
// Why this wrapper exists
// -----------------------
// `genvm-lint check` does two things — a lint pass and an SDK validation pass — and
// **exits 0 even when validation fails**. Observed directly:
//
//     ✓ Lint passed (3 checks)
//     ✗ Validation failed
//       Failed to load SDK: No module named 'genlayer.py'
//     exit=0
//
// So the obvious gate, `genvm-lint check ... && echo IC-LINT OK`, prints its success
// token while half the tool is reporting failure. That is precisely the shape of a
// gate that cannot fail, and it was in this repository's root ledger until this script
// replaced it.
//
// This wrapper therefore ignores the exit code as an oracle and reads the output:
// every contract must print a lint pass, and no contract may print a failure line of
// either kind. One contract silently skipped is a failure too, so the count is
// measured per file rather than assumed.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const CONTRACTS = [
  "contracts/genlayer/wrk_registry.py",
  "contracts/genlayer/wrk_work.py",
  "contracts/genlayer/wrk_adjudicator.py",
  "contracts/genlayer/wrk_reputation.py",
];

const LINT_PASS = /✓\s*Lint passed/;
const VALIDATION_PASS = /✓\s*Validation passed/;
const ANY_FAILURE = /✗|Lint failed|Validation failed|Traceback/;

/**
 * Validation needs the GenVM Python SDK importable. When it is absent the tool still
 * runs its lint checks, which are the ones that catch a misplaced nondet block — but
 * "validation was skipped" must be visible rather than silently tolerated, so it is
 * reported and, unless explicitly allowed, fails.
 */
const ALLOW_MISSING_SDK = process.argv.includes("--allow-missing-sdk");

const failures = [];
const skippedValidation = [];
let linted = 0;

for (const rel of CONTRACTS) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    failures.push(`${rel}: does not exist`);
    continue;
  }

  let output;
  try {
    output = execFileSync("uvx", ["--from", "genvm-linter", "genvm-lint", "check", path], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      // The contracts import `lib/`, and the linter's validation step does not put the
      // contract's own directory on sys.path. Without this it reports
      // "Import error: No module named 'lib'" and validation never runs, which is how
      // a lint-only pass gets mistaken for a clean contract.
      env: { ...process.env, PYTHONPATH: "contracts/genlayer" },
    });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message);
  }

  if (!LINT_PASS.test(output)) {
    failures.push(`${rel}: no lint pass in output\n      ${output.trim().split("\n").join("\n      ")}`);
    continue;
  }

  const sdkMissing = /Failed to load SDK/.test(output) || /Import error/.test(output);
  if (sdkMissing) {
    skippedValidation.push(rel);
  } else if (!VALIDATION_PASS.test(output)) {
    failures.push(`${rel}: lint passed but validation did not\n      ${output.trim()}`);
    continue;
  } else if (ANY_FAILURE.test(output.replace(LINT_PASS, "").replace(VALIDATION_PASS, ""))) {
    failures.push(`${rel}: a failure line accompanied the lint pass\n      ${output.trim()}`);
    continue;
  }

  linted += 1;
}

if (failures.length > 0) {
  console.error(`IC-LINT FAILED (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

if (skippedValidation.length > 0) {
  const note =
    `genvm-lint could not run its SDK validation pass for ${skippedValidation.length} contract(s): ` +
    `the GenVM Python SDK is not importable in this environment.`;
  if (!ALLOW_MISSING_SDK) {
    console.error(`IC-LINT FAILED: ${note}`);
    console.error("  The lint checks passed, but validation was skipped, and a gate that");
    console.error("  accepts a skipped half is the gate this script exists to replace.");
    console.error("  Install the SDK, or re-run with --allow-missing-sdk to record the gap");
    console.error("  explicitly in the gate's evidence.");
    process.exit(1);
  }
  console.error(`  NOTE: ${note}`);
  console.error("  Accepted because --allow-missing-sdk was passed. This is a recorded gap.");
}

console.log(`IC-LINT OK ${linted} contract(s), lint and validation both passed`);
