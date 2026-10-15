// Shared scaffolding for the indexer's verification scripts.
//
// The fixture below is a whole protocol lifecycle expressed as replay blocks. It exists so
// the idempotence, rebuild and reorg gates exercise the *entire* event catalogue rather
// than the three events a smaller fixture would reach — a rebuild that reproduces two
// collections and silently drops the other ten would otherwise pass.

import { MongoClient } from "mongodb";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PKG = resolve(import.meta.dirname, "..");
export const REPO = resolve(PKG, "..", "..");

/**
 * Loads the repository's gitignored `.env` into `process.env`, without overwriting
 * anything already set.
 *
 * A gate that only runs when the caller happens to have exported MONGODB_URI by hand is a
 * gate that fails for the wrong reason in CI and on a fresh clone. Existing values win so
 * an explicit override still works.
 */
export function loadEnv() {
  const path = resolve(REPO, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

loadEnv();

export const GENLAYER_CHAIN = 61999;
export const BASE_CHAIN = 84532;

const ulid = (prefix, tag) => {
  const body = ("01JQ8Z" + "0".repeat(20)).slice(0, 26 - tag.length) + tag;
  return `${prefix}_${body}`;
};

export const IDS = {
  dao: ulid("dao", "D1"),
  creator: ulid("agt", "A1"),
  worker: ulid("agt", "A2"),
  mission: ulid("msn", "M1"),
  proposal: ulid("prp", "P1"),
  mandate: ulid("mnd", "N1"),
  deliverable: ulid("dlv", "V1"),
  evidence: ulid("evd", "E1"),
  decision: ulid("dec", "C1"),
};

const HASH = (byte) => "0x" + byte.repeat(32);
const MANDATE_B32 = HASH("77");

const gl = (name, indexed, blob = {}) => ({ name, source: "genlayer", indexed, blob });
const base = (name, indexed, blob = {}) => ({ name, source: "base", indexed, blob });

/**
 * The GenLayer side of a complete lifecycle, one array per block.
 *
 * Shaped to match what the contracts actually emit, including that creation events carry
 * the initial state and the two `*StateChanged` events carry every transition after it.
 */
export function genlayerBlocks() {
  return [
    [
      gl("AgentRegistered", { agent_id: IDS.creator }, {
        operator: "0x" + "a1".repeat(20),
        profile_hash: HASH("11"),
        registered_at: 1800000000,
      }),
      gl("AgentRegistered", { agent_id: IDS.worker }, {
        operator: "0x" + "a2".repeat(20),
        profile_hash: HASH("12"),
        registered_at: 1800000000,
      }),
    ],
    [
      gl("DaoCreated", { dao_id: IDS.dao }, {
        creator_agent_id: IDS.creator,
        metadata_hash: HASH("21"),
        rules_hash: HASH("22"),
        rules_version: 1,
      }),
      gl("MemberJoined", { agent_id: IDS.creator, dao_id: IDS.dao }, { mode: "created" }),
      gl("MemberJoined", { agent_id: IDS.worker, dao_id: IDS.dao }, { mode: "joined" }),
    ],
    [
      gl("MissionCreated", { mission_id: IDS.mission }, {
        dao_id: IDS.dao,
        creator_agent_id: IDS.creator,
        mission_hash: HASH("31"),
        rules_version: 1,
        budget_atomic: "1000000",
        deadline_unix: 1900000000,
        state: "DRAFT",
      }),
      gl("MissionUpdated", { mission_id: IDS.mission }, {
        mission_hash: HASH("32"),
        version: 2,
        budget_atomic: "1000000",
        deadline_unix: 1900000000,
      }),
      gl("MissionStateChanged", { mission_id: IDS.mission }, { state: "OPEN", previous: "DRAFT" }),
    ],
    [
      gl("ProposalSubmitted", { proposal_id: IDS.proposal }, {
        mission_id: IDS.mission,
        dao_id: IDS.dao,
        agent_id: IDS.worker,
        proposal_hash: HASH("41"),
        requested_budget_atomic: "1000000",
        team_size: 0,
      }),
      gl("MissionStateChanged", { mission_id: IDS.mission }, { state: "PROPOSALS_CLOSED", previous: "OPEN" }),
      gl("MissionStateChanged", { mission_id: IDS.mission }, { state: "SELECTING", previous: "PROPOSALS_CLOSED" }),
    ],
    [
      gl("SelectionDecided", { mission_id: IDS.mission }, {
        proposal_id: IDS.proposal,
        runner_up_proposal_id: "",
        decision_hash: HASH("51"),
        confidence_bp: 8500,
        candidate_count: 1,
      }),
      gl("SelectionRecorded", { mission_id: IDS.mission }, {
        proposal_id: IDS.proposal,
        decision_hash: HASH("51"),
      }),
      gl("MissionStateChanged", { mission_id: IDS.mission }, { state: "SELECTED", previous: "SELECTING" }),
    ],
    [
      gl("MandateCreated", { mandate_id: IDS.mandate }, {
        mission_id: IDS.mission,
        dao_id: IDS.dao,
        mandate_hash: HASH("61"),
        rules_version: 1,
        proposal_hash: HASH("41"),
        selection_decision_hash: HASH("51"),
        budget_atomic: "1000000",
        deadline_unix: 1900000000,
        worker_count: 1,
        state: "CREATED",
      }),
      gl("MissionStateChanged", { mission_id: IDS.mission }, { state: "MANDATED", previous: "SELECTED" }),
      gl("MandateAccepted", { agent_id: IDS.worker, mandate_id: IDS.mandate }, { accepted: 1, total: 1 }),
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "ACCEPTED", previous: "CREATED" }),
    ],
    [
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "FUNDED", previous: "ACCEPTED" }),
      gl("CustodyRelayed", { mandate_id: IDS.mandate }, { state: "FUNDED", base_tx_hash: HASH("1a") }),
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "IN_PROGRESS", previous: "FUNDED" }),
    ],
    [
      gl("EvidenceRecorded", { evidence_id: IDS.evidence }, {
        deliverable_id: IDS.deliverable,
        mandate_id: IDS.mandate,
        worker_agent_id: IDS.worker,
        evidence_type: "source_repository",
        uri: "https://example.com/repo",
        content_hash: HASH("ab"),
      }),
      gl("DeliverableSubmitted", { deliverable_id: IDS.deliverable }, {
        mandate_id: IDS.mandate,
        agent_id: IDS.worker,
        deliverable_hash: HASH("71"),
        evidence_count: 1,
      }),
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "SUBMITTED", previous: "IN_PROGRESS" }),
    ],
    [
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "ADJUDICATING", previous: "SUBMITTED" }),
      gl("DecisionRecorded", { mandate_id: IDS.mandate }, {
        decision_id: IDS.decision,
        decision_hash: HASH("81"),
        verdict: "PARTIAL_ACCEPTANCE",
        release_bp: 6000,
        refund_bp: 4000,
        criteria_met: 1,
        criteria_total: 2,
        state: "ADJUDICATED",
      }),
      gl("AdjudicationRecorded", { mandate_id: IDS.mandate }, { decision_hash: HASH("81") }),
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "ADJUDICATED", previous: "ADJUDICATING" }),
    ],
    [
      gl("DecisionFinalized", { mandate_id: IDS.mandate }, {
        decision_hash: HASH("81"),
        finalized_at: 1800007200,
        state: "FINALIZED",
      }),
      gl("AgentProfileUpdated", { agent_id: IDS.worker }, { profile_hash: HASH("13") }),
      gl("DaoRulesUpdated", { dao_id: IDS.dao }, { rules_hash: HASH("23"), rules_version: 2 }),
    ],
    [
      gl("MandateStateChanged", { mandate_id: IDS.mandate }, { state: "SETTLED", previous: "ADJUDICATED" }),
      gl("CustodyRelayed", { mandate_id: IDS.mandate }, { state: "SETTLED", base_tx_hash: HASH("2b") }),
      gl("ReputationRecorded", { agent_id: IDS.worker, dao_id: IDS.dao }, {
        mandate_id: IDS.mandate,
        verdict: "PARTIAL_ACCEPTANCE",
        release_bp: 6000,
        settled_mandates: 1,
        total_release_bp: 6000,
        score_bp: 6000,
        recorded_at: 1800007200,
      }),
    ],
  ];
}

/** The Base side: funding, posting, the window, execution and the payout. */
export function baseBlocks() {
  return [
    [
      base("MandateFunded", { mandateId: MANDATE_B32, funder: "0x" + "a1".repeat(20) }, {
        amount: "1000000",
      }),
    ],
    [
      base("SettlementPosted", { settlementId: HASH("91"), mandateId: MANDATE_B32 }, {
        decisionHash: HASH("81"),
        releaseBp: 6000,
        refundBp: 4000,
        postedAt: 1800003600,
        executableAt: 1800007200,
      }),
    ],
    [
      base("SettlementExecuted", { settlementId: HASH("91"), mandateId: MANDATE_B32 }, {
        released: "600000",
        refunded: "400000",
        executedAt: 1800007201,
      }),
      base("PayeePaid", { settlementId: HASH("91"), payee: "0x" + "a2".repeat(20) }, {
        shareBp: 10000,
        amount: "600000",
      }),
    ],
  ];
}

/** A second settlement that is challenged, then an expiry refund, so both paths are covered. */
export function baseAlternateBlocks() {
  const other = HASH("66");
  return [
    [
      base("MandateFunded", { mandateId: other, funder: "0x" + "a1".repeat(20) }, { amount: "500000" }),
    ],
    [
      base("SettlementPosted", { settlementId: HASH("92"), mandateId: other }, {
        decisionHash: HASH("82"),
        releaseBp: 10000,
        refundBp: 0,
        postedAt: 1800003600,
        executableAt: 1800007200,
      }),
    ],
    [
      base("SettlementChallenged", { settlementId: HASH("92"), mandateId: other, challenger: "0x" + "c0".repeat(20) }, {
        reason: "transcription mismatch",
      }),
    ],
    [
      base("ExpiredRefund", { mandateId: other, funder: "0x" + "a1".repeat(20) }, { amount: "500000" }),
    ],
  ];
}

/**
 * A reachable MongoDB and a database nobody else is using.
 *
 * Prefers `MONGODB_URI` when something is actually listening there, and otherwise starts
 * a `mongodb-memory-server` replica set — which is a **real mongod**, downloaded and run,
 * not a mock. That distinction is the whole point: leaf-1.4.1's note says an unreachable
 * database is a failed verification rather than evidence, and the way to honour that is to
 * make the gate provision a real server rather than to skip when an operator forgot to
 * start one.
 *
 * A replica set rather than a standalone because transactions need one, and because the
 * live deployment is one — a gate that passes only against a standalone would be testing a
 * configuration nobody runs.
 */
export async function testDatabase(label) {
  const database = `wrk_verify_${label}_${process.pid}`;
  const configured = process.env.MONGODB_URI;

  if (configured && (await reachable(configured))) {
    return { uri: configured, database, stop: async () => {} };
  }

  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  return {
    uri: server.getUri(),
    database,
    provisioned: true,
    stop: async () => {
      await server.stop();
    },
  };
}

async function reachable(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_500 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function dropDatabase(config) {
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    await client.db(config.database).dropDatabase();
  } catch {
    // The server may already be gone when a provisioned one is stopped first; the
    // database goes with it either way.
  } finally {
    await client.close().catch(() => {});
  }
  if (config.stop) await config.stop();
}

export function fail(token, problems) {
  console.error(`${token} FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
