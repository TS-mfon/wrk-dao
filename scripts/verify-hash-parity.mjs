// Proves that WRK canonical JSON is byte-identical in TypeScript/JavaScript and
// Python, that its output is pure ASCII (so Solidity's keccak256(bytes(s)) hashes
// the same bytes), and that the frozen vectors in fixtures/canonical-vectors.json
// still describe reality.
//
//   node scripts/verify-hash-parity.mjs           verify against the frozen vectors
//   node scripts/verify-hash-parity.mjs --write   regenerate the frozen vectors
//
// Success prints exactly one line: HASH-PARITY OK <n> vectors
// Any divergence exits non-zero with the first differing vector named.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";

import { canonicalize } from "./canonical-reference.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS = join(ROOT, "fixtures", "canonical-inputs.json");
const FROZEN = join(ROOT, "fixtures", "canonical-vectors.json");
const PY_CLI = join(ROOT, "scripts", "canonical-cli.py");

const write = process.argv.includes("--write");
const failures = [];
const fail = (where, detail) => failures.push(`${where}: ${detail}`);

/**
 * Reject number literals spelled with a decimal point or exponent.
 *
 * The fixture file is a transport, and JSON does not distinguish integers from
 * floats. `2.0` parses to the integer-valued number 2 in JavaScript but to the
 * float 2.0 in Python, so the two languages would disagree about whether the
 * vector is even legal -- a disagreement about the harness, not about the
 * serialisers. Catching the spelling here keeps that confusion out of the proof.
 * Cases that genuinely need a float live in the `reject` list, where
 * disagreement is the expected answer, and are exempted by name.
 */
function assertPlainIntegerLiterals(text) {
  const offenders = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      if (text[j] === "-") j++;
      const start = j;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      if (j === start) continue; // a bare "-" outside a string; JSON.parse will complain
      if (text[j] === "." || text[j] === "e" || text[j] === "E") {
        let end = j;
        while (end < text.length && /[-+.0-9eE]/.test(text[end])) end++;
        offenders.push(text.slice(i, end));
      }
      i = j - 1;
    }
  }
  return offenders;
}

const rawInputs = readFileSync(INPUTS, "utf8");
const fixtures = JSON.parse(rawInputs);

// Strip the reject list before scanning: it is allowed -- required -- to contain
// float spellings, because proving they are refused is its whole job.
const rejectNames = new Set(fixtures.reject.map((v) => v.name));
const acceptOnlyText = JSON.stringify(fixtures.accept);
const offenders = assertPlainIntegerLiterals(acceptOnlyText);
if (offenders.length > 0) {
  fail(
    "fixtures/canonical-inputs.json",
    `accept vectors contain non-integer number spellings (${offenders.join(", ")}). ` +
      `Write plain integer literals, or move the vector to the reject list.`,
  );
}

/** Deep clone with every object's key insertion order reversed. */
function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = reverseKeyOrder(value[key]);
  return out;
}

/** The exact bytes Solidity sees for `bytes(s)` when `s` is ASCII. */
function asciiBytes(text, name) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      fail(name, `canonical output is not ASCII: U+${code.toString(16).toUpperCase()} at index ${i}`);
      return null;
    }
    bytes[i] = code;
  }
  return bytes;
}

// ---------------------------------------------------------------- JavaScript side

const js = new Map();
for (const { name, value } of fixtures.accept) {
  let canonical;
  try {
    canonical = canonicalize(value);
  } catch (error) {
    fail(name, `JavaScript rejected an accept vector: ${error.message}`);
    continue;
  }

  // Idempotence: serialising the same value twice must not drift.
  if (canonicalize(value) !== canonical) {
    fail(name, "JavaScript canonicalize is not deterministic across calls");
  }

  // Key-order independence: the whole point of sorting keys.
  let shuffled;
  try {
    shuffled = canonicalize(reverseKeyOrder(value));
  } catch (error) {
    fail(name, `reversed-key clone failed: ${error.message}`);
    continue;
  }
  if (shuffled !== canonical) {
    fail(name, `key insertion order changed the output\n  original: ${canonical}\n  reversed: ${shuffled}`);
    continue;
  }

  // Round-trip: canonical text must parse back to a value that re-canonicalises
  // identically, so the form is a fixed point rather than merely a projection.
  try {
    if (canonicalize(JSON.parse(canonical)) !== canonical) {
      fail(name, "canonical text is not a fixed point under parse -> canonicalize");
    }
  } catch (error) {
    fail(name, `canonical text did not parse as JSON: ${error.message}`);
  }

  const bytes = asciiBytes(canonical, name);
  if (bytes === null) continue;
  js.set(name, { canonical, keccak256: keccak256(bytes) });
}

for (const { name, value } of fixtures.reject) {
  let result;
  try {
    result = canonicalize(value);
  } catch {
    continue; // rejected, as required
  }
  fail(name, `JavaScript accepted a reject vector and produced ${result}`);
}

// Cases JavaScript accepts because it has no float/int distinction, and Python
// refuses. Pinning the exact JavaScript output keeps the asymmetry from widening
// unnoticed; see the comment block in fixtures/canonical-inputs.json.
for (const { name, value, js_canonical } of fixtures.reject_python_only) {
  let result;
  try {
    result = canonicalize(value);
  } catch (error) {
    fail(`asymmetric:${name}`, `JavaScript now rejects this too: ${error.message}. Move it to the reject list.`);
    continue;
  }
  if (result !== js_canonical) {
    fail(`asymmetric:${name}`, `expected JavaScript to produce ${JSON.stringify(js_canonical)}, got ${JSON.stringify(result)}`);
  }
}

// Values JavaScript can hold but JSON cannot transport.
for (const [name, thunk] of [
  ["undefined_scalar", () => canonicalize(undefined)],
  ["undefined_in_object", () => canonicalize({ a: undefined })],
  ["undefined_in_array", () => canonicalize([1, undefined])],
  ["nan", () => canonicalize(Number.NaN)],
  ["positive_infinity", () => canonicalize(Number.POSITIVE_INFINITY)],
  ["negative_infinity", () => canonicalize(Number.NEGATIVE_INFINITY)],
  ["bigint", () => canonicalize(1n)],
  ["function_value", () => canonicalize(() => {})],
  ["symbol_value", () => canonicalize(Symbol("s"))],
]) {
  try {
    const result = thunk();
    fail(`js-local:${name}`, `expected a rejection, got ${result}`);
  } catch {
    /* rejected, as required */
  }
}

// -0 must normalise rather than throw: it is a legal integer, spelled twice.
if (canonicalize(-0) !== "0") fail("js-local:negative_zero", `expected "0", got ${canonicalize(-0)}`);
if (canonicalize({ a: -0 }) !== '{"a":0}') fail("js-local:negative_zero_nested", "-0 did not normalise inside an object");

// -------------------------------------------------------------------- Python side

const py = spawnSync("python3", [PY_CLI, INPUTS], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (py.error) {
  fail("python3", `could not run ${PY_CLI}: ${py.error.message}`);
} else if (py.status !== 0) {
  fail("python3", `exited ${py.status}\n${py.stderr.trim()}`);
} else {
  const pyOut = JSON.parse(py.stdout);

  const pyAccept = new Map(pyOut.accept.map((row) => [row.name, row]));
  for (const { name } of fixtures.accept) {
    const mine = js.get(name);
    const theirs = pyAccept.get(name);
    if (!theirs) {
      fail(name, "Python produced no result for this vector");
      continue;
    }
    if (theirs.error) {
      fail(name, `Python rejected an accept vector: ${theirs.error}`);
      continue;
    }
    if (!mine) continue; // already reported on the JS side
    if (theirs.canonical !== mine.canonical) {
      const at = [...mine.canonical].findIndex((ch, i) => ch !== theirs.canonical[i]);
      fail(
        name,
        `byte divergence at index ${at}\n` +
          `  javascript: ${JSON.stringify(mine.canonical)}\n` +
          `  python:     ${JSON.stringify(theirs.canonical)}`,
      );
    }
  }

  const pyReject = new Map(pyOut.reject.map((row) => [row.name, row]));
  for (const { name } of fixtures.reject) {
    const row = pyReject.get(name);
    if (!row) fail(name, "Python produced no result for this reject vector");
    else if (!row.rejected) fail(name, "Python accepted a reject vector");
  }

  for (const row of pyOut.local) {
    if (!row.rejected) fail(`py-local:${row.name}`, "expected a rejection, got a canonical string");
  }

  const pyAsym = new Map(pyOut.reject_python_only.map((row) => [row.name, row]));
  for (const { name } of fixtures.reject_python_only) {
    const row = pyAsym.get(name);
    if (!row) fail(`asymmetric:${name}`, "Python produced no result for this vector");
    else if (!row.rejected) {
      fail(
        `asymmetric:${name}`,
        "Python accepted a float spelling. That reopens the silent hash fork this file exists to prevent.",
      );
    }
  }
}

// ------------------------------------------------------------------ frozen vectors

const vectors = fixtures.accept
  .filter(({ name }) => js.has(name))
  .map(({ name }) => ({ name, canonical: js.get(name).canonical, keccak256: js.get(name).keccak256 }));

if (write) {
  if (failures.length > 0) {
    console.error("refusing to freeze vectors while parity is broken:");
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
  const payload = {
    _comment:
      "FROZEN. Generated by `node scripts/verify-hash-parity.mjs --write`. Every canonical " +
      "serialiser in this repo (packages/types, contracts/genlayer/lib, contracts/base tests) " +
      "must reproduce these exact strings and digests. keccak256 is taken over the ASCII bytes " +
      "of `canonical`, which is what Solidity's keccak256(bytes(s)) computes.",
    algorithm: { canonical_json: "wrk/canonical-json/v1", digest: "keccak256" },
    vector_count: vectors.length,
    vectors,
  };
  writeFileSync(FROZEN, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`HASH-PARITY OK ${vectors.length} vectors (frozen)`);
  process.exit(0);
}

let frozen;
try {
  frozen = JSON.parse(readFileSync(FROZEN, "utf8"));
} catch (error) {
  fail("fixtures/canonical-vectors.json", `unreadable: ${error.message}. Run with --write to create it.`);
}

if (frozen) {
  const frozenByName = new Map(frozen.vectors.map((v) => [v.name, v]));
  for (const v of vectors) {
    const f = frozenByName.get(v.name);
    if (!f) {
      fail(v.name, "vector is not in the frozen set. Review the change, then re-freeze with --write.");
      continue;
    }
    if (f.canonical !== v.canonical) {
      fail(v.name, `frozen canonical text changed\n  frozen: ${JSON.stringify(f.canonical)}\n  now:    ${JSON.stringify(v.canonical)}`);
    }
    if (f.keccak256 !== v.keccak256) {
      fail(v.name, `frozen digest changed\n  frozen: ${f.keccak256}\n  now:    ${v.keccak256}`);
    }
  }
  for (const f of frozen.vectors) {
    if (!vectors.some((v) => v.name === f.name)) {
      fail(f.name, "frozen vector disappeared from the input set");
    }
  }
  if (frozen.vector_count !== frozen.vectors.length) {
    fail("fixtures/canonical-vectors.json", `vector_count ${frozen.vector_count} != ${frozen.vectors.length} vectors`);
  }
}

// -------------------------------------------------------------------------- report

if (failures.length > 0) {
  console.error(`HASH-PARITY FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"})`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

if (vectors.length !== fixtures.accept.length || rejectNames.size !== fixtures.reject.length) {
  console.error("HASH-PARITY FAILED: vector accounting mismatch");
  process.exit(1);
}

console.log(`HASH-PARITY OK ${vectors.length} vectors`);
