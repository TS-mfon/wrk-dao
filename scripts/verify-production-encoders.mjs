// Branch gate for node-1.1: the two PRODUCTION canonical encoders reproduce the
// frozen vectors exactly.
//
// scripts/verify-hash-parity.mjs proves the driver's *reference* encoders agree.
// That is necessary and not sufficient: what ships is packages/types (TypeScript)
// and contracts/genlayer/lib/canonical.py (Python), and a leaf can easily produce
// an encoder that passes its own unit tests while disagreeing with the frozen
// bytes. This closes that gap.
//
//   node scripts/verify-production-encoders.mjs
//
// Success prints exactly one line: PRODUCTION-ENCODERS OK <n> vectors x2

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const frozen = JSON.parse(readFileSync(join(ROOT, "fixtures", "canonical-vectors.json"), "utf8"));
const inputs = JSON.parse(readFileSync(join(ROOT, "fixtures", "canonical-inputs.json"), "utf8"));
const inputByName = new Map(inputs.accept.map((v) => [v.name, v.value]));

const failures = [];
const fail = (where, detail) => failures.push(`${where}: ${detail}`);

// ── TypeScript side: packages/types must export canonicalize + contentHash ────
const TS_ENTRY = join(ROOT, "packages", "types", "dist", "index.js");
const TS_SRC = join(ROOT, "packages", "types", "src", "canonical.ts");

if (!existsSync(TS_SRC)) {
  fail("packages/types", "src/canonical.ts does not exist; leaf-1.1.1 has not landed");
} else if (!existsSync(TS_ENTRY)) {
  fail("packages/types", `dist/index.js does not exist; run \`pnpm --filter @wrk/types build\` (expected ${TS_ENTRY})`);
} else {
  let mod;
  try {
    mod = await import(TS_ENTRY);
  } catch (error) {
    fail("packages/types", `dist/index.js failed to import: ${error.message}`);
  }
  if (mod) {
    if (typeof mod.canonicalize !== "function") {
      fail("packages/types", "does not export canonicalize()");
    }
    if (typeof mod.contentHash !== "function") {
      fail("packages/types", "does not export contentHash()");
    }
    if (typeof mod.canonicalize === "function") {
      for (const v of frozen.vectors) {
        const value = inputByName.get(v.name);
        let got;
        try {
          got = mod.canonicalize(value);
        } catch (error) {
          fail(`ts:${v.name}`, `threw on a frozen accept vector: ${error.message}`);
          continue;
        }
        if (got !== v.canonical) {
          fail(`ts:${v.name}`, `canonical text differs\n  frozen: ${JSON.stringify(v.canonical)}\n  got:    ${JSON.stringify(got)}`);
        }
      }
    }
    if (typeof mod.contentHash === "function") {
      for (const v of frozen.vectors) {
        let got;
        try {
          got = mod.contentHash(inputByName.get(v.name));
        } catch (error) {
          fail(`ts-hash:${v.name}`, `threw: ${error.message}`);
          continue;
        }
        if (String(got).toLowerCase() !== v.keccak256.toLowerCase()) {
          fail(`ts-hash:${v.name}`, `digest differs\n  frozen: ${v.keccak256}\n  got:    ${got}`);
        }
      }
    }
  }
}

// ── Python side: contracts/genlayer/lib/canonical.py ──────────────────────────
const PY_SRC = join(ROOT, "contracts", "genlayer", "lib", "canonical.py");
if (!existsSync(PY_SRC)) {
  fail("contracts/genlayer/lib", "canonical.py does not exist; leaf-1.1.2 has not landed");
} else {
  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(ROOT, "contracts", "genlayer"))})
from lib.canonical import canonicalize
frozen = json.loads(pathlib.Path(${JSON.stringify(join(ROOT, "fixtures", "canonical-vectors.json"))}).read_text())
inputs = json.loads(pathlib.Path(${JSON.stringify(join(ROOT, "fixtures", "canonical-inputs.json"))}).read_text())
by_name = {v["name"]: v["value"] for v in inputs["accept"]}
out = []
for v in frozen["vectors"]:
    try:
        out.append({"name": v["name"], "canonical": canonicalize(by_name[v["name"]])})
    except Exception as exc:
        out.append({"name": v["name"], "error": f"{type(exc).__name__}: {exc}"})
json.dump(out, sys.stdout, ensure_ascii=True)
`;
  const py = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (py.status !== 0) {
    fail("contracts/genlayer/lib", `python3 exited ${py.status}\n${py.stderr.trim().split("\n").slice(-6).join("\n")}`);
  } else {
    const rows = new Map(JSON.parse(py.stdout).map((r) => [r.name, r]));
    for (const v of frozen.vectors) {
      const row = rows.get(v.name);
      if (!row) fail(`py:${v.name}`, "no result");
      else if (row.error) fail(`py:${v.name}`, `threw on a frozen accept vector: ${row.error}`);
      else if (row.canonical !== v.canonical) {
        fail(`py:${v.name}`, `canonical text differs\n  frozen: ${JSON.stringify(v.canonical)}\n  got:    ${JSON.stringify(row.canonical)}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`PRODUCTION-ENCODERS FAILED (${failures.length})`);
  for (const line of failures.slice(0, 25)) console.error(`  - ${line}`);
  if (failures.length > 25) console.error(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}

console.log(`PRODUCTION-ENCODERS OK ${frozen.vectors.length} vectors x2`);
