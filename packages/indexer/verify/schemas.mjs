// leaf-1.4.1:G4 — Zod validates on write AND on read, and an invalid document is
// rejected rather than stored.
//
// The second half is the one worth being careful about. "Validation exists" is cheap to
// claim; what matters is that a rejected write leaves nothing behind, because a
// half-written document is what the next reader trips over. So every negative case here
// asserts the collection is still empty afterwards.

import { Store } from "../dist/store.js";
import { COLLECTIONS } from "../dist/collections.js";
import { fail, testDatabase, dropDatabase, IDS } from "./_common.mjs";

const config = await testDatabase("schemas");
const problems = [];
const store = await Store.open(config);

const ref = {
  chain: 61999,
  tx_hash: "0x" + "1".repeat(64),
  block: 7,
  log_index: 0,
  block_hash: "0x" + "2".repeat(64),
};
const provenance = { chain_ref: ref, seq: 7_000_000, updated_at: 7 };

const good = {
  collection: "agents",
  id: IDS.creator,
  set: {
    ...provenance,
    agent_id: IDS.creator,
    operator: "0x" + "a1".repeat(20),
    profile_hash: "0x" + "11".repeat(32),
    registered_at: 1800000000,
  },
  setOnInsert: { capabilities: [], dao_ids: [] },
};

try {
  // ── write-side validation ────────────────────────────────────────────────
  await store.apply(good);
  if ((await store.count("agents")) !== 1) problems.push("a valid document was not stored");

  const rejections = [
    {
      name: "an unknown field",
      upsert: { ...good, id: IDS.worker, set: { ...good.set, agent_id: IDS.worker, nonsense: 1 } },
    },
    {
      name: "a malformed id",
      upsert: { ...good, id: "agt_nope", set: { ...good.set, agent_id: "agt_nope" } },
    },
    {
      name: "an uppercase address",
      upsert: {
        ...good,
        id: IDS.worker,
        set: { ...good.set, agent_id: IDS.worker, operator: "0x" + "A1".repeat(20) },
      },
    },
    {
      name: "a missing required field",
      upsert: { ...good, id: IDS.worker, set: { ...provenance, agent_id: IDS.worker } },
    },
    {
      name: "a chain_ref with no tx_hash",
      upsert: {
        ...good,
        id: IDS.worker,
        set: {
          ...good.set,
          agent_id: IDS.worker,
          chain_ref: { chain: 1, block: 1, log_index: 0, block_hash: "0x" + "2".repeat(64) },
        },
      },
    },
    {
      name: "a state outside the machine",
      upsert: {
        collection: "mandates",
        id: IDS.mandate,
        set: {
          ...provenance,
          mandate_id: IDS.mandate,
          mission_id: IDS.mission,
          dao_id: IDS.dao,
          mandate_hash: "0x" + "61".repeat(32),
          state: "VIBING",
          rules_version: 1,
          proposal_hash: "0x" + "41".repeat(32),
          selection_decision_hash: "0x" + "51".repeat(32),
          budget_atomic: "1000000",
          deadline_unix: 1900000000,
          worker_count: 1,
        },
        setOnInsert: { accepted_count: 0, decision_hash: null, funding_tx: null, settlement_tx: null },
      },
    },
    {
      name: "basis points that do not sum to 10000",
      upsert: {
        collection: "decisions",
        id: IDS.mandate,
        set: {
          ...provenance,
          mandate_id: IDS.mandate,
          decision_id: IDS.decision,
          decision_hash: "0x" + "81".repeat(32),
          verdict: "PARTIAL_ACCEPTANCE",
          release_bp: 6000,
          refund_bp: 5000,
          criteria_met: 1,
          criteria_total: 2,
          state: "ADJUDICATED",
        },
        setOnInsert: { finalized_at: 0 },
      },
    },
    {
      name: "a state transition for a document that does not exist",
      upsert: {
        collection: "missions",
        id: IDS.mission,
        set: { ...provenance, state: "OPEN" },
      },
    },
  ];

  for (const { name, upsert } of rejections) {
    const before = await store.count(upsert.collection);
    let threw = false;
    try {
      await store.apply(upsert);
    } catch (error) {
      threw = error?.name === "ValidationFailed";
      if (!threw) problems.push(`${name}: threw ${error?.name ?? "something"} rather than ValidationFailed`);
    }
    if (!threw) problems.push(`${name}: was accepted`);
    const after = await store.count(upsert.collection);
    if (after !== before) {
      problems.push(`${name}: was rejected but left ${after - before} document(s) behind`);
    }
  }

  // ── read-side validation ─────────────────────────────────────────────────
  // Written past the store, the way a hand edit or an older version would.
  await store.db.collection(COLLECTIONS.agents.name).insertOne({
    _id: "agt_handwritten",
    agent_id: "agt_handwritten",
    operator: "nope",
  });
  let readThrew = false;
  try {
    await store.read("agents", "agt_handwritten");
  } catch (error) {
    readThrew = error?.name === "ValidationFailed" && error.direction === "read";
  }
  if (!readThrew) {
    problems.push("a document written past the store was returned by read() without complaint");
  }

  let readAllThrew = false;
  try {
    await store.readAll("agents");
  } catch (error) {
    readAllThrew = error?.name === "ValidationFailed";
  }
  if (!readAllThrew) problems.push("readAll() returned an invalid stored document");

  // Every collection must have a schema, or one could be written unvalidated.
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (!spec.schema || typeof spec.schema.safeParse !== "function") {
      problems.push(`collection ${name} has no usable schema`);
    }
  }
} finally {
  await store.close();
  await dropDatabase(config);
}

if (problems.length > 0) fail("INDEXER-SCHEMAS", problems);

console.log(
  `INDEXER-SCHEMAS OK ${Object.keys(COLLECTIONS).length} collection(s), 8 invalid write(s) refused with nothing stored, 2 invalid read(s) refused`,
);
