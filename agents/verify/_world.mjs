// A whole protocol in one process, so two agents can be driven end to end.
//
// Real API, real read model, real indexer, real contracts' event shapes. The two things
// that cannot run here are the GenLayer VM and the Base chain, so this world plays the
// parts those would: a chain writer that applies a call to an in-memory protocol state and
// emits the events the contracts would emit, and an indexer run that projects them.
//
// That is the honest seam for these gates. They ask whether the two AGENTS can drive the
// product through its API -- not whether GenLayer executes, which node-1.2's 566 tests and
// leaf-1.6.3's live deployment answer. The agents cannot tell the difference: they see an
// API, and everything they learn comes from its responses.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { Store, ReplaySource, indexToTip } from "@wrk/indexer";
import { createApp } from "@wrk/api/dist/app.js";
import { ChainWrites } from "@wrk/api/dist/chain.js";
import { ReadModel } from "@wrk/api/dist/readmodel.js";
import { MemoryNonceLog } from "@wrk/api/dist/auth.js";
import { WrkClient, localSigner, payloads, newId } from "@wrk/sdk";
import { contentHash } from "@wrk/types";

export const AGENTS_DIR = resolve(import.meta.dirname, "..");
export const REPO = resolve(AGENTS_DIR, "..");

const ADDR = (b) => `0x${b.repeat(20)}`;
const HASH = (seed) => contentHash({ seed });
/** The real content hash of a canonical payload string, as the contracts compute it. */
const PAYLOAD_HASH = (json) => contentHash(JSON.parse(json));
const GENLAYER_CHAIN = 61999;

let server = null;

/**
 * The protocol, as the Intelligent Contracts would behave.
 *
 * Mirrors the contracts' refusals, not just their happy paths: a mission cannot be opened
 * twice, a proposal needs an OPEN mission, a mandate's workers must match the selected
 * proposal, and a mandate reaches SETTLED only from ADJUDICATED. Without those, an agent
 * that skipped a step would appear to work.
 */
class ProtocolState {
  constructor() {
    this.agents = new Map();
    this.operators = new Map();
    this.daos = new Map();
    this.members = new Set();
    this.missions = new Map();
    this.proposals = new Map();
    this.mandates = new Map();
    this.deliverables = new Map();
    this.decisions = new Map();
    this.blocks = [];
  }

  emit(events) {
    this.blocks.push(events);
  }

  reject(message) {
    const error = new Error(`[EXPECTED] ${message}`);
    error.expected = true;
    throw error;
  }

  apply(operator, call) {
    const method = call.method;
    const [a, b, c, d] = call.args;
    const gl = (name, indexed, blob = {}) => ({ name, source: "genlayer", indexed, blob });

    switch (method) {
      case "register_agent": {
        if (this.agents.has(a)) this.reject(`agent ${a} is already registered`);
        if (this.operators.has(operator)) this.reject(`address ${operator} already controls an agent`);
        this.agents.set(a, { operator, profile: JSON.parse(b) });
        this.operators.set(operator, a);
        this.emit([gl("AgentRegistered", { agent_id: a }, {
          operator, profile_hash: PAYLOAD_HASH(b), profile: b, registered_at: 1800000000,
        })]);
        return;
      }
      case "update_agent_profile": {
        if (!this.agents.has(a)) this.reject(`unknown agent ${a}`);
        this.emit([gl("AgentProfileUpdated", { agent_id: a }, { profile_hash: PAYLOAD_HASH(b), profile: b })]);
        return;
      }
      case "create_dao": {
        if (this.daos.has(a)) this.reject(`dao ${a} already exists`);
        const rules = JSON.parse(d);
        this.daos.set(a, { creator: b, rules });
        this.members.add(`${a}|${b}`);
        this.emit([
          gl("DaoCreated", { dao_id: a }, {
            creator_agent_id: b, metadata_hash: PAYLOAD_HASH(c), rules_hash: PAYLOAD_HASH(d),
            metadata: c, rules: d, rules_version: rules.version ?? 1,
          }),
          gl("MemberJoined", { agent_id: b, dao_id: a }, { mode: "created" }),
        ]);
        return;
      }
      case "update_dao_rules": {
        const dao = this.daos.get(a);
        if (!dao) this.reject(`unknown dao ${a}`);
        const rules = JSON.parse(b);
        dao.rules = rules;
        this.emit([gl("DaoRulesUpdated", { dao_id: a }, { rules_hash: PAYLOAD_HASH(b), rules: b, rules_version: rules.version ?? 1 })]);
        return;
      }
      case "join_dao": {
        const dao = this.daos.get(a);
        if (!dao) this.reject(`unknown dao ${a}`);
        if (this.members.has(`${a}|${b}`)) this.reject(`agent ${b} is already a member of ${a}`);
        const required = dao.rules.required_capabilities ?? [];
        const held = (this.agents.get(b)?.profile.capabilities ?? []).map((cap) => cap.capability_id);
        const missing = required.filter((cap) => !held.includes(cap));
        if (missing.length) this.reject(`agent ${b} lacks required capabilit(ies): ${missing.join(", ")}`);
        this.members.add(`${a}|${b}`);
        this.emit([gl("MemberJoined", { agent_id: b, dao_id: a }, { mode: "joined" })]);
        return;
      }
      case "invite_agent": {
        if (!this.daos.has(a)) this.reject(`unknown dao ${a}`);
        this.members.add(`${a}|${b}`);
        this.emit([gl("MemberJoined", { agent_id: b, dao_id: a }, { mode: "invited" })]);
        return;
      }
      case "create_mission": {
        if (this.missions.has(a)) this.reject(`mission ${a} already exists`);
        const dao = this.daos.get(b);
        if (!dao) this.reject(`unknown dao ${b}`);
        if (!this.members.has(`${b}|${c}`)) this.reject(`agent ${c} is not a member of dao ${b}`);
        const payload = JSON.parse(d);
        const budget = BigInt(payload.budget.amount_atomic);
        const cap = BigInt(dao.rules.max_mission_budget_atomic);
        if (budget > cap) this.reject(`mission budget ${budget} exceeds the DAO's cap of ${cap}`);
        if (payload.acceptance_criteria.length < (dao.rules.min_acceptance_criteria ?? 1)) {
          this.reject(`dao ${b} requires at least ${dao.rules.min_acceptance_criteria} acceptance criteria`);
        }
        this.missions.set(a, { dao: b, creator: c, payload, state: "DRAFT", version: 1, proposals: [], selected: null, selectionHash: null });
        this.emit([gl("MissionCreated", { mission_id: a }, {
          dao_id: b, creator_agent_id: c, mission_hash: PAYLOAD_HASH(d), payload: d,
          rules_version: dao.rules.version ?? 1,
          budget_atomic: payload.budget.amount_atomic, deadline_unix: payload.deadline_unix, state: "DRAFT",
        })]);
        return;
      }
      case "update_mission": {
        const mission = this.missions.get(a);
        if (!mission) this.reject(`unknown mission ${a}`);
        if (!["DRAFT", "OPEN"].includes(mission.state) || mission.proposals.length > 0) {
          this.reject(`mission ${a} is not editable: state ${mission.state} with ${mission.proposals.length} proposal(s)`);
        }
        mission.payload = JSON.parse(b);
        mission.version += 1;
        this.emit([gl("MissionUpdated", { mission_id: a }, {
          mission_hash: PAYLOAD_HASH(b), payload: b, version: mission.version,
          budget_atomic: mission.payload.budget.amount_atomic, deadline_unix: mission.payload.deadline_unix,
        })]);
        return;
      }
      case "open_mission":
        return this.transitionMission(a, "DRAFT", "OPEN");
      case "close_proposals":
        return this.transitionMission(a, "OPEN", "PROPOSALS_CLOSED");
      case "start_selection": {
        const mission = this.missions.get(a);
        if (!mission) this.reject(`unknown mission ${a}`);
        if (mission.proposals.length === 0) this.reject(`mission ${a} has no proposals to select from`);
        return this.transitionMission(a, "PROPOSALS_CLOSED", "SELECTING");
      }
      case "cancel_mission": {
        const mission = this.missions.get(a);
        if (!mission) this.reject(`unknown mission ${a}`);
        mission.state = "CANCELLED";
        this.emit([gl("MissionStateChanged", { mission_id: a }, { state: "CANCELLED", previous: mission.state })]);
        return;
      }
      case "submit_proposal": {
        const mission = this.missions.get(b);
        if (!mission) this.reject(`unknown mission ${b}`);
        if (mission.state !== "OPEN") this.reject(`mission ${b} is ${mission.state}, not OPEN`);
        if (!this.members.has(`${mission.dao}|${c}`)) this.reject(`agent ${c} is not a member of dao ${mission.dao}`);
        if (mission.proposals.some((id) => this.proposals.get(id)?.agent === c)) {
          this.reject(`agent ${c} has already proposed to mission ${b}`);
        }
        const payload = JSON.parse(d);
        if (BigInt(payload.requested_budget.amount_atomic) > BigInt(mission.payload.budget.amount_atomic)) {
          this.reject(`requested budget exceeds the mission budget`);
        }
        this.proposals.set(a, { mission: b, agent: c, payload, hash: PAYLOAD_HASH(d) });
        mission.proposals.push(a);
        this.emit([gl("ProposalSubmitted", { proposal_id: a }, {
          mission_id: b, dao_id: mission.dao, agent_id: c, proposal_hash: PAYLOAD_HASH(d), payload: d,
          requested_budget_atomic: payload.requested_budget.amount_atomic, team_size: payload.team_members.length,
        })]);
        return;
      }
      case "create_mandate": {
        if (this.mandates.has(a)) this.reject(`mandate ${a} already exists`);
        const mission = this.missions.get(b);
        if (!mission) this.reject(`unknown mission ${b}`);
        if (mission.state !== "SELECTED") this.reject(`mission ${b} is ${mission.state}, not SELECTED`);
        const payload = JSON.parse(c);
        const selected = this.proposals.get(mission.selected);
        if (payload.proposal_hash !== selected.hash) {
          this.reject("mandate.proposal_hash must be the content hash of the SELECTED proposal");
        }
        if (payload.selection_decision_hash !== mission.selectionHash) {
          this.reject("mandate.selection_decision_hash must be the recorded selection decision");
        }
        const committed = selected.payload.team_members.length
          ? Object.fromEntries(selected.payload.team_members.map((m) => [m.agent_id, m.share_bp]))
          : { [selected.agent]: 10000 };
        const workers = Object.fromEntries(payload.workers.map((w) => [w.agent_id, w.share_bp]));
        if (JSON.stringify(workers) !== JSON.stringify(committed)) {
          this.reject("mandate workers and shares must match the selected proposal exactly");
        }
        this.mandates.set(a, { mission: b, dao: mission.dao, payload, state: "CREATED", accepted: 0, workers: Object.keys(workers), decisionHash: null });
        mission.state = "MANDATED";
        this.emit([
          gl("MandateCreated", { mandate_id: a }, {
            mission_id: b, dao_id: mission.dao, mandate_hash: PAYLOAD_HASH(c), payload: c, rules_version: 1,
            proposal_hash: payload.proposal_hash, selection_decision_hash: payload.selection_decision_hash,
            budget_atomic: payload.budget.amount_atomic, deadline_unix: payload.deadline_unix,
            worker_count: payload.workers.length, state: "CREATED",
          }),
          gl("MissionStateChanged", { mission_id: b }, { state: "MANDATED", previous: "SELECTED" }),
        ]);
        return;
      }
      case "accept_mandate": {
        const mandate = this.mandates.get(a);
        if (!mandate) this.reject(`unknown mandate ${a}`);
        if (mandate.state !== "CREATED") this.reject(`mandate ${a} is ${mandate.state}, not CREATED`);
        if (!mandate.workers.includes(b)) this.reject(`agent ${b} is not a worker on mandate ${a}`);
        mandate.accepted += 1;
        const events = [gl("MandateAccepted", { agent_id: b, mandate_id: a }, { accepted: mandate.accepted, total: mandate.workers.length })];
        if (mandate.accepted === mandate.workers.length) {
          mandate.state = "ACCEPTED";
          events.push(gl("MandateStateChanged", { mandate_id: a }, { state: "ACCEPTED", previous: "CREATED" }));
        }
        this.emit(events);
        return;
      }
      case "start_work": {
        const mandate = this.mandates.get(a);
        if (!mandate) this.reject(`unknown mandate ${a}`);
        if (mandate.state !== "FUNDED") this.reject(`mandate ${a} is ${mandate.state}, not FUNDED`);
        mandate.state = "IN_PROGRESS";
        this.emit([gl("MandateStateChanged", { mandate_id: a }, { state: "IN_PROGRESS", previous: "FUNDED" })]);
        return;
      }
      case "submit_deliverable": {
        const mandate = this.mandates.get(b);
        if (!mandate) this.reject(`unknown mandate ${b}`);
        if (mandate.state !== "IN_PROGRESS") this.reject(`mandate ${b} is ${mandate.state}, not IN_PROGRESS`);
        const payload = JSON.parse(d);
        this.deliverables.set(a, { mandate: b, agent: c, payload });
        mandate.deliverable = a;
        const events = payload.evidence.map((item) =>
          gl("EvidenceRecorded", { evidence_id: item.evidence_id }, {
            deliverable_id: a, mandate_id: b, worker_agent_id: c,
            evidence_type: item.type, uri: item.uri, content_hash: item.content_hash,
          }),
        );
        events.push(gl("DeliverableSubmitted", { deliverable_id: a }, {
          mandate_id: b, agent_id: c, deliverable_hash: PAYLOAD_HASH(d), payload: d,
          evidence_count: payload.evidence.length,
        }));
        this.emit(events);
        return;
      }
      case "submit_work": {
        const mandate = this.mandates.get(a);
        if (!mandate) this.reject(`unknown mandate ${a}`);
        if (mandate.state !== "IN_PROGRESS") this.reject(`mandate ${a} is ${mandate.state}, not IN_PROGRESS`);
        if (!mandate.deliverable) this.reject(`mandate ${a} has no deliverable to adjudicate`);
        mandate.state = "SUBMITTED";
        this.emit([gl("MandateStateChanged", { mandate_id: a }, { state: "SUBMITTED", previous: "IN_PROGRESS" })]);
        return;
      }
      case "cancel_mandate": {
        const mandate = this.mandates.get(a);
        if (!mandate) this.reject(`unknown mandate ${a}`);
        if (!["CREATED", "ACCEPTED"].includes(mandate.state)) {
          this.reject(`mandate ${a}: ${mandate.state} -> CANCELLED is not a legal transition`);
        }
        const previous = mandate.state;
        mandate.state = "CANCELLED";
        this.emit([gl("MandateStateChanged", { mandate_id: a }, { state: "CANCELLED", previous })]);
        return;
      }
      default:
        this.reject(`the protocol has no method ${method}`);
    }
  }

  transitionMission(id, from, to) {
    const mission = this.missions.get(id);
    if (!mission) this.reject(`unknown mission ${id}`);
    if (mission.state !== from) this.reject(`mission ${id} is ${mission.state}, not ${from}`);
    mission.state = to;
    const gl = (name, indexed, blob) => ({ name, source: "genlayer", indexed, blob });
    this.emit([gl("MissionStateChanged", { mission_id: id }, { state: to, previous: from })]);
  }

  // ── the parts the keeper and adjudicator play ────────────────────────────

  /** The adjudicator selects, and the selection reaches wrk_work on finality. */
  select(missionId) {
    const mission = this.missions.get(missionId);
    if (!mission || mission.state !== "SELECTING") return false;
    const proposalId = mission.proposals[0];
    const decisionHash = HASH(`selection:${missionId}`);
    mission.selected = proposalId;
    mission.selectionHash = decisionHash;
    mission.state = "SELECTED";
    const gl = (name, indexed, blob) => ({ name, source: "genlayer", indexed, blob });
    this.emit([
      gl("SelectionDecided", { mission_id: missionId }, { proposal_id: proposalId, runner_up_proposal_id: "", decision_hash: decisionHash, confidence_bp: 8500, candidate_count: mission.proposals.length }),
      gl("SelectionRecorded", { mission_id: missionId }, { proposal_id: proposalId, decision_hash: decisionHash }),
      gl("MissionStateChanged", { mission_id: missionId }, { state: "SELECTED", previous: "SELECTING" }),
    ]);
    return true;
  }

  /** The DAO funds the escrow on Base and the observer relays it. */
  fund(mandateId) {
    const mandate = this.mandates.get(mandateId);
    if (!mandate || mandate.state !== "ACCEPTED") return false;
    mandate.state = "FUNDED";
    const gl = (name, indexed, blob) => ({ name, source: "genlayer", indexed, blob });
    this.emit([
      gl("MandateStateChanged", { mandate_id: mandateId }, { state: "FUNDED", previous: "ACCEPTED" }),
      gl("CustodyRelayed", { mandate_id: mandateId }, { state: "FUNDED", base_tx_hash: HASH(`fund:${mandateId}`) }),
    ]);
    return true;
  }

  /** Adjudication, then finality, then settlement and reputation. */
  adjudicateAndSettle(mandateId, metCriteria) {
    const mandate = this.mandates.get(mandateId);
    if (!mandate || mandate.state !== "SUBMITTED") return null;
    const criteria = mandate.payload.acceptance_criteria;
    const met = metCriteria ?? criteria.map((criterion) => criterion.id);
    const releaseBp = criteria.filter((criterion) => met.includes(criterion.id)).reduce((sum, criterion) => sum + criterion.weight_bp, 0);
    const verdict = releaseBp === 10000 ? "FULL_ACCEPTANCE" : releaseBp === 0 ? "REJECTION" : "PARTIAL_ACCEPTANCE";
    const decisionHash = HASH(`decision:${mandateId}:${releaseBp}`);
    const gl = (name, indexed, blob) => ({ name, source: "genlayer", indexed, blob });

    mandate.state = "ADJUDICATED";
    mandate.decisionHash = decisionHash;
    this.emit([
      gl("MandateStateChanged", { mandate_id: mandateId }, { state: "ADJUDICATING", previous: "SUBMITTED" }),
      gl("DecisionRecorded", { mandate_id: mandateId }, {
        decision_id: `dec_01JQ8Z${"0".repeat(19)}1`, decision_hash: decisionHash, verdict,
        release_bp: releaseBp, refund_bp: 10000 - releaseBp,
        criteria_met: met.length, criteria_total: criteria.length, state: "ADJUDICATED",
      }),
      gl("AdjudicationRecorded", { mandate_id: mandateId }, { decision_hash: decisionHash }),
      gl("MandateStateChanged", { mandate_id: mandateId }, { state: "ADJUDICATED", previous: "ADJUDICATING" }),
    ]);

    mandate.state = "SETTLED";
    const worker = mandate.workers[0];
    this.emit([
      gl("DecisionFinalized", { mandate_id: mandateId }, { decision_hash: decisionHash, finalized_at: 1800007200, state: "FINALIZED" }),
      gl("MandateStateChanged", { mandate_id: mandateId }, { state: "SETTLED", previous: "ADJUDICATED" }),
      gl("CustodyRelayed", { mandate_id: mandateId }, { state: "SETTLED", base_tx_hash: HASH(`settle:${mandateId}`) }),
      gl("ReputationRecorded", { agent_id: worker, dao_id: mandate.dao }, {
        mandate_id: mandateId, verdict, release_bp: releaseBp,
        settled_mandates: 1, total_release_bp: releaseBp, score_bp: releaseBp, recorded_at: 1800007200,
      }),
    ]);
    return { verdict, releaseBp, decisionHash };
  }
}

export async function world({ failAt } = {}) {
  server ??= await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const config = { uri: server.getUri(), database: `wrk_agents_${Math.random().toString(36).slice(2, 8)}` };
  const store = await Store.open(config);
  await store.ensureIndexes();

  const protocol = new ProtocolState();
  const source = new ReplaySource(GENLAYER_CHAIN, "genlayer");
  const requests = [];
  let injected = 0;

  /**
   * Projects whatever the protocol has emitted into the read model.
   *
   * Serialized. Two agents and a keeper all write concurrently here, and `indexToTip`
   * reads a checkpoint, indexes, then writes it back: two overlapping runs can both read
   * the same checkpoint and the later write can lose the earlier one's progress, leaving a
   * block projected nowhere. The real indexer is one process and never does this, so the
   * race is the harness's, but an intermittent gate is worse than a slow one.
   */
  let settling = Promise.resolve();
  const settle = () => {
    settling = settling.then(async () => {
      while (protocol.blocks.length > 0) source.append(protocol.blocks.shift());
      await indexToTip(store, source, { finalityDepth: 0, batch: 200 });
    });
    return settling;
  };

  const writer = {
    async send({ operator, call }) {
      requests.push({ method: call.method, operator });
      // G7's injection point: one call site is made to fail, so the agent's handling of a
      // transport failure is exercised rather than described.
      if (failAt && failAt.method === call.method && injected < (failAt.times ?? 1)) {
        injected += 1;
        const error = new Error(`injected ${failAt.kind ?? "transport"} failure on ${call.method}`);
        if (failAt.kind === "refusal") error.expected = true;
        throw error;
      }
      protocol.apply(operator, call);
      await settle();
      return HASH(`tx:${requests.length}`);
    },
    async view({ method, args }) {
      if (method === "agent_of_address") return protocol.operators.get(String(args[0]).toLowerCase()) ?? "";
      return "";
    },
  };

  const writes = new ChainWrites({
    mode: "relay",
    deployments: { studionet: { registry: ADDR("11"), work: ADDR("22"), adjudicator: ADDR("33"), reputation: ADDR("44") } },
    writer,
  });
  const app = createApp({ reads: new ReadModel(store), writes, directory: writes.agentDirectory(), nonces: new MemoryNonceLog() });

  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    return app.request(url.replace("http://wrk.test", ""), init);
  };

  const clientFor = (agentId, privateKey) =>
    new WrkClient({
      baseUrl: "http://wrk.test",
      network: "studionet",
      signer: localSigner({ agentId, privateKey }),
      fetch: fetchImpl,
    });

  return {
    app, store, protocol, requests, clientFor, settle,
    operatorOf: (privateKey) => localSigner({ agentId: "agt_01JQ8Z000000000000000000A1", privateKey }).address,
    async stop() {
      await store.close();
      const mongo = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5000 });
      try { await mongo.connect(); await mongo.db(config.database).dropDatabase(); } catch {}
      finally { await mongo.close().catch(() => {}); }
    },
  };
}

export async function stopAll() { await server?.stop(); server = null; }

export const KEYS = {
  commissioner: `0x${"11".repeat(32)}`,
  worker: `0x${"22".repeat(32)}`,
  // Two further parties the single-agent gates need. `verify/commissioner.mjs` must have a
  // proposal arrive from someone, and `verify/worker.mjs` must have work to find; using the
  // other Agent class for that would make each gate measure both agents, which is G4's job.
  bystander: `0x${"33".repeat(32)}`,
  counterparty: `0x${"44".repeat(32)}`,
};
export const IDS = {
  commissioner: "agt_01JQ8Z000000000000000000A1",
  worker: "agt_01JQ8Z000000000000000000A2",
  bystander: "agt_01JQ8Z000000000000000000A3",
  counterparty: "agt_01JQ8Z000000000000000000A4",
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The keeper and the adjudicator, as a background loop.
 *
 * Driven entirely off the read model: it watches for a state and acts, with no knowledge of
 * which agents exist. That is what a real GitHub Actions keeper plus the adjudicator IC do
 * between them, and running it this way is what lets an agent gate wait on protocol
 * progress rather than on another agent's internals.
 *
 * `metCriteria` lets a gate decide a partial verdict; omitted, every criterion is met.
 */
export function keeper(w, { metCriteria } = {}) {
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const [missionId, mission] of w.protocol.missions) {
        if (mission.state === "SELECTING") { w.protocol.select(missionId); await w.settle(); }
      }
      for (const [mandateId, mandate] of w.protocol.mandates) {
        if (mandate.state === "ACCEPTED") { w.protocol.fund(mandateId); await w.settle(); }
        if (mandate.state === "SUBMITTED") { w.protocol.adjudicateAndSettle(mandateId, metCriteria); await w.settle(); }
      }
      await sleep(10);
    }
  })();
  return { async stop() { running = false; await loop; await w.settle(); } };
}

/** Polls a read until it satisfies `predicate`, or gives up with a stated reason. */
export async function until(label, read, predicate, { attempts = 120, intervalMs = 15 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label}: never satisfied after ${attempts} polls; last was ${JSON.stringify(last)}`);
}

/** The acceptance criteria out of a stored mission document, as an agent reads them. */
export function criteriaOf(mission) {
  if (!mission || typeof mission.payload !== "string") return [];
  try { return JSON.parse(mission.payload).acceptance_criteria ?? []; } catch { return []; }
}

// ── the harness's own parties, driven through the same public API ────────────
//
// These are raw SDK calls, not agents. A gate asserting the commissioner's behaviour needs
// a counterparty to exist, and the honest way to supply one is through the public API that
// everything else uses -- not by reaching into protocol state, which would let a gate pass
// over an API that could not actually express the step.

/** Registers an agent through the API's one bootstrap endpoint. */
export async function registerParty(client, { agentId, name, operator, capabilities }) {
  await client.registerAgent({
    agentId,
    profile: payloads.agentProfile({ agentId, name, operator, capabilities }),
  });
}

/** Creates a DAO and returns its id. */
export async function createDaoAs(client, { agentId, daoId, maxBudgetAtomic, minAcceptanceCriteria = 1 }) {
  await client.createDao({
    daoId,
    creatorAgentId: agentId,
    metadata: payloads.daoMetadata({ daoId, name: `${daoId} DAO`, purpose: "Harness DAO", creatorAgentId: agentId }),
    rules: payloads.daoRules({ daoId, maxMissionBudgetAtomic: maxBudgetAtomic, minAcceptanceCriteria, membership: "open" }),
  });
  return daoId;
}

/** Publishes an OPEN mission and returns its id. */
export async function publishMissionAs(client, { agentId, daoId, brief, chainId = 84532, deadlineUnix = 1_900_000_000 }) {
  const missionId = newId("msn");
  await client.createMission({
    missionId,
    daoId,
    creatorAgentId: agentId,
    payload: payloads.mission({
      missionId, daoId, creatorAgentId: agentId,
      title: brief.title,
      outcomeStatement: brief.outcome,
      criteria: brief.criteria,
      budgetAtomic: brief.budgetAtomic,
      chainId, deadlineUnix,
      evidenceRequirements: brief.evidenceRequirements,
    }),
  });
  await client.openMission({ missionId, creatorAgentId: agentId });
  return missionId;
}

/** Proposes to a mission, answering whatever criteria it published. */
export async function proposeAs(client, { agentId, mission, capabilities }) {
  const missionId = String(mission.mission_id);
  const criteria = criteriaOf(mission);
  const proposalId = newId("prp");
  await client.submitProposal({
    proposalId, missionId, agentId,
    payload: payloads.proposal({
      proposalId, missionId, daoId: String(mission.dao_id), agentId,
      capabilities,
      proposedStrategy: `Answer each of the ${criteria.length} published criteria.`,
      executionPlan: criteria.map((criterion) => `Address ${criterion.id}`),
      deliverables: criteria.map((criterion) => `Evidence for ${criterion.id}`),
      evidencePlan: criteria.map((criterion) => `Publish an artefact for ${criterion.id}`),
      estimatedDurationSeconds: 3600,
      requestedBudgetAtomic: String(mission.budget_atomic ?? "0"),
      chainId: 84532,
    }),
  });
  return proposalId;
}

/** Creates a mandate from the proposal the adjudicator actually selected. */
export async function createMandateAs(client, { agentId, missionId, daoId, brief, chainId = 84532, deadlineUnix = 1_900_000_000 }) {
  const mission = await client.one("missions", missionId);
  const proposalId = String(mission.selected_proposal_id);
  const proposal = await client.one("proposals", proposalId);
  const mandateId = newId("mnd");
  await client.createMandate({
    mandateId, missionId, creatorAgentId: agentId,
    payload: payloads.mandate({
      mandateId, daoId, missionId, creatorAgentId: agentId,
      workers: [{ agentId: String(proposal.agent_id), shareBp: 10_000 }],
      objective: brief.outcome,
      deliverables: brief.criteria.map((criterion) => criterion.statement),
      budgetAtomic: String(proposal.requested_budget_atomic),
      chainId, deadlineUnix,
      criteria: brief.criteria,
      evidenceRequirements: brief.evidenceRequirements,
      proposalHash: String(proposal.proposal_hash),
      selectionDecisionHash: String(mission.selection_decision_hash),
    }),
  });
  return mandateId;
}

/**
 * The worker side of a mandate, driven raw: accept, start once funded, deliver, submit.
 *
 * `verify/commissioner.mjs` uses this so the commissioner's `awaitSettlement` is watching
 * real protocol progress rather than a state the gate wrote for it.
 */
export async function performAs(client, { agentId, mandateId, workspaceUri = "https://example.com/harness" }) {
  await client.acceptMandate({ mandateId, agentId });
  await until(`mandate ${mandateId} funded`, () => client.one("mandates", mandateId), (m) => m?.state === "FUNDED");
  await client.startWork({ mandateId, agentId });

  const mandate = await client.one("mandates", mandateId);
  const mission = await client.one("missions", String(mandate.mission_id));
  const criteria = criteriaOf(mission);
  const deliverableId = newId("dlv");
  await client.submitDeliverable({
    deliverableId, mandateId, agentId,
    payload: payloads.deliverable({
      deliverableId, mandateId, workerAgentId: agentId,
      title: `Work for ${mandate.mission_id}`,
      summary: `Addressed ${criteria.length} acceptance criteria.`,
      satisfiesIndices: criteria.map((_, index) => index),
      evidence: criteria.map((criterion) => ({
        mandateId, workerAgentId: agentId,
        type: "source_repository",
        uri: `${workspaceUri}/${criterion.id}`,
        contentHash: HASH(`${mandateId}:${criterion.id}`),
        mimeType: "text/plain",
        description: `Artefact for ${criterion.id}`,
      })),
    }),
  });
  await client.submitWork({ mandateId, agentId });
  return deliverableId;
}

export const BRIEF = {
  title: "Ship a canonical-JSON conformance suite",
  outcome: "A test suite proving canonical JSON byte parity across three languages.",
  criteria: [
    { id: "vectors_pass", statement: "All 41 frozen vectors reproduce their digests.", weightBp: 6000 },
    { id: "three_languages", statement: "Parity is demonstrated in Python, TypeScript and Solidity.", weightBp: 4000 },
  ],
  budgetAtomic: "1000000",
  evidenceRequirements: ["source_repository", "test_output"],
};

/**
 * A second, deliberately different brief.
 *
 * `verify/reactive.mjs` runs the same two agents against this and requires the transcripts
 * to differ in the places the inputs differ: three criteria instead of two, a different
 * budget, and different criterion ids. A hardcoded script would produce identical
 * transcripts for both.
 */
export const OTHER_BRIEF = {
  title: "Build a reorg-healing indexer checkpoint",
  outcome: "A checkpoint that heals a 64-block reorg without orphaning a document.",
  criteria: [
    { id: "heals_reorg", statement: "A 64-block rewrite leaves no orphaned document.", weightBp: 5000 },
    { id: "rebuild_from_zero", statement: "The read model rebuilds from block 0 to the same digest.", weightBp: 3000 },
    { id: "idempotent_replay", statement: "Replaying a block twice changes nothing.", weightBp: 2000 },
  ],
  budgetAtomic: "2500000",
  evidenceRequirements: ["source_repository", "test_output", "benchmark"],
};

/** A mission priced below a worker's floor, so declining is a decision the gate can see. */
export const CHEAP_BRIEF = {
  title: "Rename a variable in a comment block",
  outcome: "One comment reads slightly better.",
  criteria: [{ id: "reads_better", statement: "The comment reads better.", weightBp: 10000 }],
  budgetAtomic: "50000",
  evidenceRequirements: ["source_repository"],
};

export function fail(token, problems) {
  console.error(`${token} FAILED (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
