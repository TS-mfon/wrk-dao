// Exhaustive escape-boundary probe for WRK canonical JSON.
//
// scripts/verify-hash-parity.mjs proves agreement on a curated vector set. This
// proves agreement on EVERY code point, which is how the U+007F divergence was
// found in the first place -- a curated set only catches what someone thought to
// curate. It is slower, so it is a separate gate.
//
//   node scripts/verify-escape-probe.mjs
//
// Success prints exactly one line: ESCAPE-PROBE OK <n> code points
//
// Surrogates U+D800-U+DFFF are probed separately as lone code units, since
// String.fromCodePoint and Python's chr() disagree about whether they are even
// constructible in isolation.

import { spawnSync } from "node:child_process";

import { canonicalize } from "./canonical-reference.mjs";

const LIMIT = 0x11000; // past the astral boundary at U+10000, well short of U+10FFFF

const PY = `
import json, sys
out = []
for i in range(0, ${LIMIT}):
    if 0xD800 <= i <= 0xDFFF:
        continue
    out.append(json.dumps(chr(i), ensure_ascii=True))
lone = [json.dumps(chr(i), ensure_ascii=True) for i in range(0xD800, 0xE000)]
json.dump({"scalar": out, "lone": lone}, sys.stdout, ensure_ascii=True)
`;

const py = spawnSync("python3", ["-c", PY], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (py.error) {
  console.error(`ESCAPE-PROBE FAILED: could not run python3: ${py.error.message}`);
  process.exit(1);
}
if (py.status !== 0) {
  console.error(`ESCAPE-PROBE FAILED: python3 exited ${py.status}\n${py.stderr.trim()}`);
  process.exit(1);
}

const { scalar, lone } = JSON.parse(py.stdout);
const diffs = [];
let probed = 0;

for (let i = 0, k = 0; i < LIMIT; i++) {
  if (i >= 0xd800 && i <= 0xdfff) continue;
  const theirs = scalar[k++];
  const mine = canonicalize(String.fromCodePoint(i));
  probed++;
  if (mine !== theirs) {
    diffs.push(`U+${i.toString(16).toUpperCase().padStart(4, "0")} js=${mine} py=${theirs}`);
  }
}

// Lone surrogates: legal in a JavaScript string and in a Python str, illegal as
// UTF-8. Both encoders must escape them rather than attempt to encode them, or
// a deliverable title with a truncated emoji becomes an un-hashable payload.
for (let i = 0xd800, k = 0; i < 0xe000; i++, k++) {
  const theirs = lone[k];
  const mine = canonicalize(String.fromCharCode(i));
  probed++;
  if (mine !== theirs) {
    diffs.push(`U+${i.toString(16).toUpperCase()} (lone surrogate) js=${mine} py=${theirs}`);
  }
}

// Every output must be pure ASCII, which is what lets Solidity hash bytes(s)
// without a UTF-8 encoder. Checked here rather than assumed from the rules.
let nonAscii = 0;
for (let i = 0; i < LIMIT; i++) {
  if (i >= 0xd800 && i <= 0xdfff) continue;
  const out = canonicalize(String.fromCodePoint(i));
  for (let j = 0; j < out.length; j++) {
    if (out.charCodeAt(j) > 0x7f) {
      nonAscii++;
      if (nonAscii <= 5) diffs.push(`U+${i.toString(16).toUpperCase()} produced non-ASCII output ${JSON.stringify(out)}`);
      break;
    }
  }
}

if (diffs.length > 0) {
  console.error(`ESCAPE-PROBE FAILED (${diffs.length} divergence${diffs.length === 1 ? "" : "s"})`);
  for (const line of diffs.slice(0, 40)) console.error(`  - ${line}`);
  if (diffs.length > 40) console.error(`  ... and ${diffs.length - 40} more`);
  process.exit(1);
}

console.log(`ESCAPE-PROBE OK ${probed} code points`);
