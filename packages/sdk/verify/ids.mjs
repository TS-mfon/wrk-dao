// leaf-1.4.4:G3 — id conversion round-trips for every prefix, and the SDK is the only
// package that performs it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ID_PREFIXES, toBytes32, fromBytes32, isId, assertId, IdError } from "../dist/index.js";
import { newId } from "@wrk/types";
import { fail, REPO } from "./_harness.mjs";

const problems = [];

// 1. Round-trip for every prefix, repeatedly, so a padding error cannot hide in one case.
for (const prefix of ID_PREFIXES) {
  for (let n = 0; n < 50; n += 1) {
    const id = newId(prefix);
    const bytes = toBytes32(id);
    if (!/^0x[0-9a-f]{64}$/.test(bytes)) {
      problems.push(`${prefix}: toBytes32 produced ${bytes}`);
      break;
    }
    const back = fromBytes32(bytes, prefix);
    if (back !== id) {
      problems.push(`${prefix}: ${id} -> ${bytes} -> ${back}`);
      break;
    }
  }
}

// 2. Malformed input is refused rather than silently padded.
for (const bad of ["", "agt_", "agt_short", "nope_01JQ8Z000000000000000000A1", "0x1234"]) {
  let threw = false;
  try { toBytes32(bad); } catch (error) { threw = error instanceof IdError; }
  if (!threw) problems.push(`toBytes32 accepted ${JSON.stringify(bad)}`);
}
for (const bad of ["0x", "0xzz", `0x${"a".repeat(63)}`]) {
  let threw = false;
  try { fromBytes32(bad, "agt"); } catch (error) { threw = error instanceof IdError; }
  if (!threw) problems.push(`fromBytes32 accepted ${JSON.stringify(bad)}`);
}

// 3. A bytes32 read back under the wrong prefix must not pass as a valid id.
const agent = newId("agt");
const asMission = fromBytes32(toBytes32(agent), "msn");
if (asMission === agent) problems.push("reading an agt_ id as msn_ returned the agt_ id");
if (!asMission.startsWith("msn_")) problems.push(`reading under a wrong prefix produced ${asMission}`);

// 4. isId / assertId agree with the prefix they are given.
if (isId(agent, "msn")) problems.push("isId accepted an agt_ id as msn_");
if (!isId(agent, "agt")) problems.push("isId rejected a valid agt_ id");
try { assertId("nope", "agt"); problems.push("assertId accepted an invalid id"); } catch {}

// 5. The SDK is the only package that converts.
//
// Checked across the workspace rather than asserted: two packages converting
// independently is how one of them gets the padding wrong and keys a settlement to
// something nobody can map back.
const offenders = [];
const skip = new Set(["node_modules", "dist", ".next", "out", "coverage", ".git", "lib"]);
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      const relative = path.slice(REPO.length + 1);
      // The SDK owns conversion; @wrk/types owns the primitive it wraps; verify scripts
      // and tests are allowed to call it in order to check it.
      if (relative.startsWith("packages/sdk/") || relative.startsWith("packages/types/")) continue;
      if (/\/(verify|test|tests)\//.test(`/${relative}`)) continue;
      const source = readFileSync(path, "utf8");
      if (/\b(toBytes32|fromBytes32)\s*\(/.test(source)) offenders.push(relative);
    }
  }
}
walk(REPO);
for (const file of offenders) {
  problems.push(`${file} converts ids itself; conversion belongs to @wrk/sdk`);
}

// 6. Positive control: the scan must fire on a file that does convert.
if (!/\b(toBytes32|fromBytes32)\s*\(/.test('const x = toBytes32("agt_1");')) {
  problems.push("control failed: the conversion scan did not match an obvious call");
}

if (problems.length === 0) {
  console.log(`SDK-IDS OK ${ID_PREFIXES.length} prefix(es) round-trip 50x each, malformed input refused, no other package converts`);
}

if (problems.length > 0) fail("SDK-IDS", problems);
