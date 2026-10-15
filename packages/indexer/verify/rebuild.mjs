// leaf-1.4.1:G6 — `rebuild --from-block 0` reproduces the collections byte for byte.
//
// This is the gate that justifies the whole MongoDB deviation (docs/ARCHITECTURE.md
// §3.2). PostgreSQL's transactional integrity, foreign keys and schema enforcement were
// given up on the grounds that the chain already provides them and the read model is
// disposable. "Disposable" is only true if it can be re-derived, so this is verified
// rather than asserted — and if it ever stops working the justification collapses.
//
// The comparison is a digest over every document in every collection, not a spot check.

import { Store, ReplaySource, indexToTip, rebuildAndCompare, digestAll, digestOfReadModel } from "../dist/index.js";
import {
  fail,
  testDatabase,
  dropDatabase,
  genlayerBlocks,
  baseBlocks,
  baseAlternateBlocks,
  GENLAYER_CHAIN,
  BASE_CHAIN,
} from "./_common.mjs";

const config = await testDatabase("rebuild");
const problems = [];
const store = await Store.open(config);
const options = { finalityDepth: 0, batch: 50 };

try {
  await store.ensureIndexes();

  const genlayer = new ReplaySource(GENLAYER_CHAIN, "genlayer");
  for (const block of genlayerBlocks()) genlayer.append(block);
  const base = new ReplaySource(BASE_CHAIN, "evm");
  for (const block of [...baseBlocks(), ...baseAlternateBlocks()]) base.append(block);
  const sources = [genlayer, base];

  for (const source of sources) await indexToTip(store, source, options);

  const original = await digestAll(store);
  const documents = original.reduce((sum, entry) => sum + entry.documents, 0);
  const populated = original.filter((entry) => entry.documents > 0).length;
  if (documents === 0) problems.push("nothing was indexed, so a rebuild would compare two empty sets");
  if (populated < 8) {
    // A rebuild that reproduces two collections and drops ten would otherwise pass.
    problems.push(`only ${populated} collection(s) hold documents; the fixture should reach at least 8`);
  }

  const digestBefore = await digestOfReadModel(store);

  const result = await rebuildAndCompare(store, sources, options);
  if (!result.identical) {
    problems.push(`the rebuild differed: ${result.differences.join("; ")}`);
  }
  if (result.events === 0) problems.push("the rebuild applied no events");

  const digestAfter = await digestOfReadModel(store);
  if (digestBefore !== digestAfter) {
    problems.push(`the single read-model digest changed: ${digestBefore} -> ${digestAfter}`);
  }

  // ── positive control ─────────────────────────────────────────────────────
  // Rebuild from a source missing a block must NOT compare as identical, or "identical"
  // is not measuring anything.
  const truncated = new ReplaySource(GENLAYER_CHAIN, "genlayer");
  for (const block of genlayerBlocks().slice(0, -1)) truncated.append(block);
  const control = await rebuildAndCompare(store, [truncated, base], options);
  if (control.identical) {
    problems.push("control failed: rebuilding from a source missing its last block compared as identical");
  }

  if (problems.length === 0) {
    console.log(
      `REBUILD OK identical — ${documents} document(s) across ${populated} populated collection(s), ${result.events} event(s) replayed from block 0, read-model digest ${digestAfter.slice(0, 18)}…`,
    );
  }
} finally {
  await store.close();
  await dropDatabase(config);
}

if (problems.length > 0) fail("REBUILD", problems);
