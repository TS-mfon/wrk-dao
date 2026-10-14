// Shared plumbing for the verify:* gates.
//
// Each gate script prints its success token on the LAST line and only after every
// assertion in it has passed. Anything else exits non-zero with a diagnosis. No
// gate prints a token from a summary line, and no gate copies a count out of the
// fixtures as its own proof — counts are measured at runtime.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
export const FIXTURES = join(REPO_ROOT, "fixtures");

export function loadJson(relativeToRepo) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativeToRepo), "utf8"));
}

export function loadFrozenVectors() {
  const frozen = loadJson("fixtures/canonical-vectors.json");
  const inputs = loadJson("fixtures/canonical-inputs.json");

  if (frozen.algorithm?.canonical_json !== "wrk/canonical-json/v1") {
    throw new Error(
      `frozen vectors declare canonical_json ${JSON.stringify(frozen.algorithm?.canonical_json)}, expected wrk/canonical-json/v1`,
    );
  }
  if (frozen.algorithm?.digest !== "keccak256") {
    throw new Error(`frozen vectors declare digest ${JSON.stringify(frozen.algorithm?.digest)}, expected keccak256`);
  }
  if (!Array.isArray(frozen.vectors) || frozen.vectors.length === 0) {
    throw new Error("frozen vectors file has no vectors");
  }
  if (frozen.vector_count !== frozen.vectors.length) {
    throw new Error(
      `frozen vector_count ${frozen.vector_count} disagrees with the array length ${frozen.vectors.length}`,
    );
  }

  // Pair each frozen vector with its input by name. A frozen vector with no input
  // is unverifiable, and an input with no frozen vector is unpinned; both fail.
  const byName = new Map(inputs.accept.map((entry) => [entry.name, entry]));
  const paired = frozen.vectors.map((vector) => {
    const input = byName.get(vector.name);
    if (input === undefined) {
      throw new Error(`frozen vector ${vector.name} has no matching accept input`);
    }
    byName.delete(vector.name);
    return { name: vector.name, value: input.value, canonical: vector.canonical, keccak256: vector.keccak256 };
  });
  if (byName.size > 0) {
    throw new Error(`accept inputs with no frozen vector: ${[...byName.keys()].join(", ")}`);
  }

  return { paired, inputs, frozen };
}

let failures = 0;

export function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`  FAIL ${message}`);
  }
}

export function checkEqual(actual, expected, message) {
  if (actual !== expected) {
    failures += 1;
    console.error(`  FAIL ${message}\n       expected: ${expected}\n       actual:   ${actual}`);
  }
}

/** Asserts `fn` throws, and that the thrown value is a WrkError with `code` when given. */
export function checkThrows(fn, message, code) {
  let threw = false;
  let thrown;
  try {
    fn();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) {
    failures += 1;
    console.error(`  FAIL ${message}: expected a throw, got a return`);
    return;
  }
  if (code !== undefined && thrown?.code !== code) {
    failures += 1;
    console.error(`  FAIL ${message}: expected code ${code}, got ${thrown?.code ?? thrown?.message}`);
  }
}

export function finish(token) {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(token);
}

export function abort(error) {
  console.error(`ABORTED: ${error?.stack ?? error}`);
  process.exit(1);
}
