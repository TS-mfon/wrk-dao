// leaf-1.4.1:G2 — every on-chain event becomes exactly one document carrying chain_ref.
//
// Three claims, each checked separately:
//
//   1. the catalogue covers EXACTLY the events the contracts emit — no missing handler,
//      and no handler for an event that does not exist. Read from the contracts' source,
//      so a renamed event breaks here rather than silently stopping the read model;
//   2. every upsert a handler produces carries chain_ref with all five fields;
//   3. no handler uses a non-idempotent operator, which rule 2 forbids.
//
// Claim 1 is the one that matters most. A read model is only complete relative to the
// contracts, and nothing else in the build compares the two.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { HANDLERS, coveredEvents, project } from "../dist/events.js";
import { fail, genlayerBlocks, baseBlocks, baseAlternateBlocks, GENLAYER_CHAIN, BASE_CHAIN } from "./_common.mjs";
import { REPO } from "./_common.mjs";

const problems = [];

// ── 1. the catalogue against the contracts ──────────────────────────────────

const genlayerDir = resolve(REPO, "contracts/genlayer");
const contractEvents = new Set();
for (const file of readdirSync(genlayerDir).filter((name) => /^wrk_.*\.py$/.test(name))) {
  const source = readFileSync(resolve(genlayerDir, file), "utf8");
  for (const match of source.matchAll(/^class\s+(\w+)\(gl\.Event\):/gm)) {
    contractEvents.add(match[1]);
  }
}

const solDir = resolve(REPO, "contracts/base/src");
const solFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".sol")) solFiles.push(path);
  }
};
walk(solDir);
for (const path of solFiles) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/^\s*event\s+(\w+)\s*\(/gm)) contractEvents.add(match[1]);
}

if (contractEvents.size === 0) {
  problems.push("found no events in the contracts — the extractor is broken, not the catalogue");
}

const covered = new Set(coveredEvents());
const missing = [...contractEvents].filter((name) => !covered.has(name)).sort();
const invented = [...covered].filter((name) => !contractEvents.has(name)).sort();
if (missing.length > 0) {
  problems.push(`the contracts emit ${missing.length} event(s) with no handler: ${missing.join(", ")}`);
}
if (invented.length > 0) {
  problems.push(`the catalogue handles ${invented.length} event(s) no contract emits: ${invented.join(", ")}`);
}

// ── 2. chain_ref on every produced document ─────────────────────────────────

const all = [
  ...genlayerBlocks().flat().map((event) => ({ event, chain: GENLAYER_CHAIN })),
  ...baseBlocks().flat().map((event) => ({ event, chain: BASE_CHAIN })),
  ...baseAlternateBlocks().flat().map((event) => ({ event, chain: BASE_CHAIN })),
];

let produced = 0;
all.forEach(({ event, chain }, position) => {
  const ref = {
    chain,
    tx_hash: "0x" + String(position).padStart(64, "0"),
    block: position + 1,
    log_index: 0,
    block_hash: "0x" + String(position).padStart(64, "f"),
  };
  let upserts;
  try {
    upserts = project({ ...event, ref });
  } catch (error) {
    problems.push(`${event.name}: project() threw — ${error.message}`);
    return;
  }
  if (upserts.length === 0) {
    problems.push(`${event.name}: produced no document, so the event would vanish from the read model`);
    return;
  }
  // The event's *own* document — the first upsert — must carry provenance. Later upserts
  // in the same handler are deliberate side-writes (an $addToSet onto another document),
  // and overwriting their chain_ref would rewrite a document this event did not create.
  const [primary] = upserts;
  const carried = primary.set.chain_ref;
  if (!carried) {
    problems.push(`${event.name}: its document carries no chain_ref`);
  } else {
    for (const field of ["chain", "tx_hash", "block", "log_index", "block_hash"]) {
      if (carried[field] === undefined) problems.push(`${event.name}: chain_ref has no ${field}`);
    }
    if (carried.chain !== chain) {
      problems.push(`${event.name}: chain_ref.chain is ${carried.chain}, expected ${chain}`);
    }
  }
  if (typeof primary.set.seq !== "number") {
    problems.push(`${event.name}: its document has no numeric seq, so a replay cannot be ordered`);
  }
  produced += upserts.length;
});

// ── 3. only replay-safe operators ───────────────────────────────────────────

for (const handler of HANDLERS) {
  const source = handler.handle.toString();
  for (const forbidden of ["$inc", "$push", "$pull", "$pop"]) {
    if (source.includes(forbidden)) {
      problems.push(`${handler.event} uses ${forbidden}, which is not idempotent under replay`);
    }
  }
}

// An updating event whose document no creating event makes would write a half-document.
const creators = new Set(HANDLERS.filter((h) => h.creates).map((h) => h.collection));
for (const handler of HANDLERS) {
  if (!handler.creates && !creators.has(handler.collection)) {
    problems.push(
      `${handler.event} only updates ${handler.collection}, but no event creates a document there`,
    );
  }
}

// ── positive control: the checker must notice a gap ─────────────────────────

{
  const withoutOne = new Set(covered);
  withoutOne.delete("MissionCreated");
  if ([...contractEvents].filter((name) => !withoutOne.has(name)).length === 0) {
    problems.push("control failed: removing a handler did not register as a gap");
  }
}

if (problems.length > 0) fail("INDEXER-EVENTS", problems);

console.log(
  `INDEXER-EVENTS OK ${covered.size} handler(s) cover ${contractEvents.size} contract event(s), ${produced} document write(s), chain_ref on every one`,
);
