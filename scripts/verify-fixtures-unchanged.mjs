// Pins fixtures/canonical-vectors.json by digest.
//
// The cheapest way to make a failing hash gate green is to re-freeze the
// vectors. That turns the whole three-language contract into a tautology: the
// encoder agrees with the file because the file was generated from the encoder.
// This check makes the frozen set immovable without a deliberate, visible act.
//
//   node scripts/verify-fixtures-unchanged.mjs        verify
//   node scripts/verify-fixtures-unchanged.mjs --pin  record the current digests
//
// Success prints exactly one line: FIXTURES UNCHANGED <n> files
//
// Re-pinning is legitimate only alongside a canonical-JSON version bump
// (docs/CANONICAL.md §3). It is a protocol change, not a fix.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "fixtures", "FIXTURES.lock.json");

const PINNED = ["fixtures/canonical-vectors.json", "fixtures/canonical-inputs.json"];

const digests = {};
for (const rel of PINNED) {
  const bytes = readFileSync(join(ROOT, rel));
  digests[rel] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (process.argv.includes("--pin")) {
  writeFileSync(
    LOCK,
    `${JSON.stringify(
      {
        _comment:
          "Digests of the frozen canonical fixtures. Changing these is a protocol " +
          "change requiring a canonical-JSON version bump (docs/CANONICAL.md §3), " +
          "never a way to make a failing gate pass.",
        canonical_json_version: "wrk/canonical-json/v1",
        digests,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`FIXTURES UNCHANGED ${PINNED.length} files (pinned)`);
  process.exit(0);
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, "utf8"));
} catch (error) {
  console.error(`FIXTURES CHANGED: cannot read ${LOCK}: ${error.message}`);
  process.exit(1);
}

const problems = [];
for (const rel of PINNED) {
  if (lock.digests[rel] !== digests[rel]) {
    problems.push(`${rel}\n      pinned: ${lock.digests[rel]}\n      now:    ${digests[rel]}`);
  }
}
for (const rel of Object.keys(lock.digests)) {
  if (!PINNED.includes(rel)) problems.push(`${rel}: pinned but no longer checked`);
}

if (problems.length > 0) {
  console.error(`FIXTURES CHANGED (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  If this was deliberate, it is a canonical-JSON version change: bump the version in\n" +
      "  docs/CANONICAL.md, migrate stored hashes, then re-pin with --pin.",
  );
  process.exit(1);
}

console.log(`FIXTURES UNCHANGED ${PINNED.length} files`);
