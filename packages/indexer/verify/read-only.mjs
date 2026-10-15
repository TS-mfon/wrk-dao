// leaf-1.4.1:G5 — invariant I10. This package cannot authorize a settlement.
//
// The claim is not "we were careful". It is that the built surface contains no way to
// sign, send, or assemble a settlement, so deleting this package would leave the escrow
// settling exactly as before. docs/ARCHITECTURE.md §4 calls I10 the invariant most likely
// to be violated by well-meaning code — a convenience function that returns "the mandate
// and amount to settle" from a database row is all it takes.
//
// Checked against `dist`, not `src`: what ships is what matters, and a re-export can
// widen a surface that looked narrow in source.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fail, PKG } from "./_common.mjs";

const problems = [];

/** Signing and sending. Any of these in the built output is a way to move money. */
const MONEY_MOVERS = [
  "createWalletClient",
  "privateKeyToAccount",
  "mnemonicToAccount",
  "signTypedData",
  "signTransaction",
  "sendTransaction",
  "sendRawTransaction",
  "writeContract",
  "eth_sendTransaction",
  "eth_sign",
  "PRIVATE_KEY",
  "Wallet(",
];

/**
 * Exported names that would hand a caller settlement inputs.
 *
 * The adapter must take the mandate id, amount and payees from the chain. An export here
 * that returns them from a row is the violation, whatever it is called — so the check is
 * on shape (a settlement-ish noun paired with a producing verb) rather than on one name.
 */
const SETTLEMENT_SHAPED = [
  /^(build|make|prepare|create|assemble|sign|post|execute)(Settlement|Payout|Release|Transfer)/i,
  /^settlementInputs?$/i,
  /^payoutFor/i,
  /^(release|refund)Amounts?For/i,
];

function builtFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...builtFiles(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

const dist = resolve(PKG, "dist");
const files = builtFiles(dist);
if (files.length === 0) problems.push("dist holds no JavaScript — build before running this gate");

function scan(sources, label) {
  const found = [];
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    for (const needle of MONEY_MOVERS) {
      if (source.includes(needle)) {
        found.push(`${label}${path.slice(dist.length + 1)}: ${needle}`);
      }
    }
  }
  return found;
}

problems.push(...scan(files, ""));

// ── the exported surface ────────────────────────────────────────────────────

const surface = await import(resolve(dist, "index.js"));
const exported = Object.keys(surface);
if (exported.length === 0) problems.push("the package exports nothing — the import failed silently");

for (const name of exported) {
  for (const pattern of SETTLEMENT_SHAPED) {
    if (pattern.test(name)) {
      problems.push(`export ${name} is shaped like a settlement producer`);
    }
  }
}

// Nothing exported may be a class with a value-moving METHOD, which a name check over
// top-level exports would miss. Only callable members count: `COLLECTIONS.payments` is
// the name of a collection of payment records, and a read model is supposed to have one.
for (const name of exported) {
  const value = surface[name];
  if (typeof value !== "function") continue;
  const prototype = value.prototype;
  if (!prototype || typeof prototype !== "object") continue;
  for (const member of Object.getOwnPropertyNames(prototype)) {
    if (member === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, member);
    if (typeof descriptor?.value !== "function") continue;
    if (/^(sign|send|write|transfer|pay|release|withdraw|execute)/i.test(member)) {
      problems.push(`export ${name} has a method ${member}() that could move value`);
    }
  }
}

// ── positive control ────────────────────────────────────────────────────────
// An absence check that has never fired proves nothing.

const scratch = mkdtempSync(resolve(tmpdir(), "wrk-readonly-control-"));
try {
  const planted = resolve(scratch, "planted.js");
  writeFileSync(
    planted,
    "import { createWalletClient } from 'viem';\nexport const send = () => createWalletClient({});\n",
  );
  const caught = [];
  const source = readFileSync(planted, "utf8");
  for (const needle of MONEY_MOVERS) if (source.includes(needle)) caught.push(needle);
  if (caught.length === 0) {
    problems.push("control failed: a module importing createWalletClient was not detected");
  }

  // The method check must still fire on a class that really does have one.
  class Planted {
    signSettlement() {}
  }
  const methodHits = Object.getOwnPropertyNames(Planted.prototype).filter(
    (member) =>
      member !== "constructor" &&
      typeof Object.getOwnPropertyDescriptor(Planted.prototype, member)?.value === "function" &&
      /^(sign|send|write|transfer|pay|release|withdraw|execute)/i.test(member),
  );
  if (methodHits.length === 0) {
    problems.push("control failed: a class with signSettlement() was not detected");
  }

  const shaped = ["buildSettlement", "prepareRelease", "settlementInputs", "payoutForMandate"];
  for (const name of shaped) {
    if (!SETTLEMENT_SHAPED.some((pattern) => pattern.test(name))) {
      problems.push(`control failed: ${name} was not recognised as settlement-shaped`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) fail("INDEXER-READ-ONLY", problems);

console.log(
  `INDEXER-READ-ONLY OK ${files.length} built file(s) and ${exported.length} export(s) carry no way to sign, send or assemble a settlement`,
);
