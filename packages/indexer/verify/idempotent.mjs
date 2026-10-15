// leaf-1.4.1:G3 — replaying a block range leaves the collections byte-identical, with no
// duplicate and no changed _id.
//
// This is §9 rule 2, and it is what makes the rest of the deviation safe: a crash
// mid-range, a restart, and `rebuild` all re-apply events that were already applied. If
// replay were not a no-op, the read model would drift every time the process died.
//
// Three separate assertions, because they fail independently: the digest (content), the
// _id set (no duplicate, nothing renamed), and the document count.

import { Store, ReplaySource, indexToTip, digestAll, diffDigests, deleteCheckpoint, loadCheckpoint, saveCheckpoint, newCheckpoint, DERIVED_COLLECTIONS } from "../dist/index.js";
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

const config = await testDatabase("idempotent");
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

  const before = await digestAll(store);
  const idsBefore = await collectIds(store);
  const total = before.reduce((sum, entry) => sum + entry.documents, 0);
  if (total === 0) problems.push("the first pass wrote nothing, so there is nothing to replay");

  // ── replay the same range ────────────────────────────────────────────────
  // The checkpoint is rewound rather than deleted, so this replays the *same* blocks
  // through the normal indexing path — which is the situation a crash produces.
  for (const source of sources) {
    const checkpoint = await loadCheckpoint(store, source.chainId);
    if (!checkpoint) {
      problems.push(`chain ${source.chainId} has no checkpoint after indexing`);
      continue;
    }
    await saveCheckpoint(
      store,
      newCheckpoint(source.chainId, 0, `0x${"0".repeat(64)}`, [], 1),
    );
    await indexToTip(store, source, options);
  }

  const after = await digestAll(store);
  const idsAfter = await collectIds(store);

  const differences = diffDigests(before, after);
  if (differences.length > 0) {
    problems.push(`replaying changed the collections: ${differences.join("; ")}`);
  }

  for (const name of DERIVED_COLLECTIONS) {
    const first = idsBefore.get(name) ?? [];
    const second = idsAfter.get(name) ?? [];
    if (second.length !== first.length) {
      problems.push(
        `${name}: ${first.length} document(s) before the replay, ${second.length} after — replay duplicated or dropped documents`,
      );
      continue;
    }
    const added = second.filter((id) => !first.includes(id));
    const removed = first.filter((id) => !second.includes(id));
    if (added.length > 0) problems.push(`${name}: replay invented _id(s) ${added.join(", ")}`);
    if (removed.length > 0) problems.push(`${name}: replay lost _id(s) ${removed.join(", ")}`);
  }

  // ── a third pass, to catch drift that only appears after the first replay ─
  for (const source of sources) {
    await saveCheckpoint(store, newCheckpoint(source.chainId, 0, `0x${"0".repeat(64)}`, [], 1));
    await indexToTip(store, source, options);
  }
  const third = diffDigests(before, await digestAll(store));
  if (third.length > 0) {
    problems.push(`a second replay changed the collections: ${third.join("; ")}`);
  }

  // ── positive control ─────────────────────────────────────────────────────
  // The comparison must notice a real change, or "identical" means nothing.
  await store.collection("agents").updateOne({}, { $set: { profile_hash: `0x${"ee".repeat(32)}` } });
  if (diffDigests(before, await digestAll(store)).length === 0) {
    problems.push("control failed: changing a stored field did not change the digest");
  }

  if (problems.length === 0) {
    console.log(
      `INDEXER-IDEMPOTENT OK ${total} document(s) across ${before.length} collection(s), identical after 2 replays`,
    );
  }
} finally {
  await store.close();
  await dropDatabase(config);
}

if (problems.length > 0) fail("INDEXER-IDEMPOTENT", problems);

async function collectIds(store) {
  const map = new Map();
  for (const name of DERIVED_COLLECTIONS) {
    const documents = await store.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray();
    map.set(name, documents.map((document) => String(document._id)));
  }
  return map;
}
