// leaf-1.4.1:G7 — a reorg is handled: documents from an orphaned block are removed and
// re-derived, and the checkpoint never advances past a block that was later orphaned.
//
// The gate's own note calls this the one most likely to be skipped, and explains why that
// is backwards: a read model that drifts after a reorg reports a settlement that did not
// happen, and because the database is never authoritative the error surfaces as a
// confusing UI rather than a crash — which makes it harder to notice, not less important.
//
// A reorg cannot be requested from a live network, so this drives `ReplaySource`, whose
// block hashes are derived from block contents. Rewriting history therefore really does
// change the hashes the indexer compares against, which is what makes the detection path
// real rather than simulated.

import {
  Store,
  ReplaySource,
  indexToTip,
  indexOnce,
  loadCheckpoint,
  digestAll,
  diffDigests,
} from "../dist/index.js";
import { fail, testDatabase, dropDatabase, GENLAYER_CHAIN, IDS } from "./_common.mjs";

const config = await testDatabase("reorg");
const problems = [];
const store = await Store.open(config);

const HASH = (byte) => "0x" + byte.repeat(32);
const gl = (name, indexed, blob = {}) => ({ name, source: "genlayer", indexed, blob });

const agent = (tag, operatorByte) =>
  gl("AgentRegistered", { agent_id: `agt_${("01JQ8Z" + "0".repeat(20)).slice(0, 24)}${tag}` }, {
    operator: "0x" + operatorByte.repeat(20),
    profile_hash: HASH("11"),
    registered_at: 1800000000,
  });

try {
  await store.ensureIndexes();

  // Blocks 1-2 are the history that survives; 3-5 are the history that gets rewritten.
  const source = new ReplaySource(GENLAYER_CHAIN, "genlayer");
  source.append([agent("A1", "a1")]);
  source.append([agent("A2", "a2")]);
  source.append([agent("A3", "a3")]);
  source.append([agent("A4", "a4")]);
  source.append([agent("A5", "a5")]);

  // finalityDepth 0 indexes to the tip, which is the hostile case: the checkpoint is as
  // far forward as it can be when history is rewritten underneath it.
  const options = { finalityDepth: 0, batch: 10 };
  await indexToTip(store, source, options);

  const beforeCount = await store.count("agents");
  if (beforeCount !== 5) problems.push(`expected 5 agents indexed, found ${beforeCount}`);
  const checkpointBefore = await loadCheckpoint(store, GENLAYER_CHAIN);
  if (checkpointBefore?.block !== 5) {
    problems.push(`checkpoint should be at block 5, is at ${checkpointBefore?.block}`);
  }
  if ((checkpointBefore?.recent.length ?? 0) === 0) {
    problems.push("the checkpoint recorded no recent block hashes, so a reorg is undetectable");
  }

  // ── rewrite history from block 3 ─────────────────────────────────────────
  // A3/A4/A5 never happened; B3/B4 did. Same heights, different contents, so different
  // hashes — exactly what a reorg presents.
  source.reorg(3, [[agent("B3", "b3")], [agent("B4", "b4")]], "b");

  const pass = await indexOnce(store, source, options);
  if (!pass.reorg.detected) problems.push("the reorg was not detected");
  if (pass.reorg.commonAncestor !== 2) {
    problems.push(`the common ancestor should be block 2, got ${pass.reorg.commonAncestor}`);
  }
  if (pass.reorg.documentsRemoved !== 3) {
    problems.push(
      `3 documents came from orphaned blocks but ${pass.reorg.documentsRemoved} were removed`,
    );
  }

  await indexToTip(store, source, options);

  // ── the orphaned documents are gone and the replacements are present ─────
  const operators = (await store.readAll("agents")).map((document) => document.operator);
  const expected = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "b3".repeat(20), "0x" + "b4".repeat(20)];
  const unexpected = operators.filter((operator) => !expected.includes(operator));
  const missing = expected.filter((operator) => !operators.includes(operator));
  if (unexpected.length > 0) {
    problems.push(`documents from orphaned blocks survived: ${unexpected.join(", ")}`);
  }
  if (missing.length > 0) {
    problems.push(`replacement blocks were not re-derived: ${missing.join(", ")}`);
  }

  // ── the checkpoint never claims an orphaned block ────────────────────────
  const checkpointAfter = await loadCheckpoint(store, GENLAYER_CHAIN);
  if (!checkpointAfter) {
    problems.push("the checkpoint vanished");
  } else {
    if (checkpointAfter.block !== 4) {
      problems.push(`checkpoint should be at the new tip (4), is at ${checkpointAfter.block}`);
    }
    // Every hash it still claims must be one the chain currently reports.
    for (const entry of checkpointAfter.recent) {
      const current = await source.blockHash(entry.block);
      if (current !== entry.hash) {
        problems.push(
          `the checkpoint still claims block ${entry.block} with an orphaned hash`,
        );
      }
    }
  }

  // ── a reorg deeper than everything recorded ──────────────────────────────
  const healed = await digestAll(store);
  source.reorg(1, [[agent("C1", "c1")]], "c");
  await indexToTip(store, source, options);
  const afterDeep = await store.readAll("agents");
  if (afterDeep.length !== 1 || afterDeep[0]?.operator !== "0x" + "c1".repeat(20)) {
    problems.push(
      `a reorg from block 1 should leave exactly the one replacement agent, found ${afterDeep.length}`,
    );
  }
  if (diffDigests(healed, await digestAll(store)).length === 0) {
    problems.push("control failed: a reorg of the entire chain did not change the read model");
  }

  // ── a pass with no reorg must not report one ─────────────────────────────
  const quiet = await indexOnce(store, source, options);
  if (quiet.reorg.detected) {
    problems.push("a pass over unchanged history reported a reorg");
  }

  if (problems.length === 0) {
    console.log(
      "INDEXER-REORG OK 3 orphaned document(s) removed and 2 re-derived, checkpoint rewound to the common ancestor, deep reorg healed, quiet pass reported none",
    );
  }
} finally {
  await store.close();
  await dropDatabase(config);
}

if (problems.length > 0) fail("INDEXER-REORG", problems);

export { IDS };
