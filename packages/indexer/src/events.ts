/**
 * The event catalogue: every chain event this read model understands.
 *
 * This is the file §9 rules 2 and 3 live in.
 *
 * **Rule 3** — no document without a chain event — holds because a document can only be
 * produced here, and every entry below is keyed on an event.
 *
 * **Rule 2** — every write is an idempotent upsert keyed by on-chain id — constrains what
 * a handler may do. `$set` of absolute values is replay-safe; `$addToSet` is replay-safe;
 * `$inc` is **not**, so no handler uses one. Any count a reader wants is a count query,
 * not a maintained counter. That is why `daos` has no `member_count`.
 *
 * Handlers are pure: event in, upsert description out. Nothing here touches a database,
 * so `verify/events.mjs` can exercise the whole catalogue without one.
 */

import { contentHash } from "@wrk/types";
import type { ChainRef } from "./schemas.js";
import type { CollectionName } from "./collections.js";

/** A decoded chain event, independent of which chain produced it. */
export interface DecodedEvent {
  readonly name: string;
  readonly source: "genlayer" | "base";
  /** Indexed fields (log topics), by name. */
  readonly indexed: Readonly<Record<string, string>>;
  /** Non-indexed fields, by name. */
  readonly blob: Readonly<Record<string, string | number | boolean>>;
  readonly ref: ChainRef;
}

/** What a handler asks the store to do. Deliberately narrow. */
export interface Upsert {
  readonly collection: CollectionName;
  readonly id: string;
  /** Absolute values only. */
  readonly set: Record<string, unknown>;
  /** Replay-safe array appends. */
  readonly addToSet?: Record<string, unknown>;
  /** Applied only when the document is created, never on replay of a later event. */
  readonly setOnInsert?: Record<string, unknown>;
}

export interface EventHandler {
  readonly event: string;
  readonly source: "genlayer" | "base";
  readonly collection: CollectionName;
  /**
   * Whether this event *creates* its document or only updates one an earlier event
   * created. Declared so `verify/events.mjs` can check that every updating event has a
   * creating sibling — an update whose document never exists writes a half-document that
   * fails schema validation on read.
   */
  readonly creates: boolean;
  readonly handle: (event: DecodedEvent) => Upsert[];
}

const num = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, got ${String(value)}`);
  return parsed;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
};
const lower = (value: unknown): string => str(value).toLowerCase();

/**
 * A canonical payload, checked against the digest the same event carries.
 *
 * The check is what makes storing the content safe: an event claiming a payload that does
 * not hash to its own stated hash is refused, so the read model cannot be fed text that
 * disagrees with what the contract committed to. Re-hashing costs a keccak per document
 * and removes the need to trust the blob.
 */
const payloadMatching = (value: unknown, expectedHash: unknown, label: string): string => {
  const canonical = str(value);
  const actual = contentHash(JSON.parse(canonical));
  const expected = str(expectedHash).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `${label}: the payload hashes to ${actual} but the event states ${expected}; refusing to store content that disagrees with the chain`,
    );
  }
  return canonical;
};

/**
 * The capability ids out of a verified agent profile.
 *
 * Kept as a projection rather than asking readers to parse the profile, because "which
 * agents can do X?" is a query an agent assembling a team runs constantly, and the answer
 * gates DAO membership.
 */
const capabilitiesOf = (profile: string): string[] => {
  const parsed = JSON.parse(profile) as { capabilities?: Array<{ capability_id?: unknown }> };
  return (parsed.capabilities ?? []).map((capability) => str(capability.capability_id));
};

/** `block * 1e6 + log_index`: a monotonic order for a chain, stable across a rebuild. */
export function sequenceOf(ref: ChainRef): number {
  return ref.block * 1_000_000 + ref.log_index;
}

/** Fields every document carries. `updated_at` comes from the event, never from now(). */
function provenance(event: DecodedEvent): Record<string, unknown> {
  return {
    chain_ref: event.ref,
    seq: sequenceOf(event.ref),
    // Derived from the chain, not the clock: a rebuild must reproduce the collections
    // byte for byte (rule 4), and `Date.now()` would make that impossible.
    updated_at: event.ref.block === 0 ? 1 : event.ref.block,
  };
}

const handler = (
  event: string,
  source: "genlayer" | "base",
  collection: CollectionName,
  creates: boolean,
  handle: (event: DecodedEvent) => Upsert[],
): EventHandler => ({ event, source, collection, creates, handle });

// ── wrk_registry ────────────────────────────────────────────────────────────

const registryHandlers: EventHandler[] = [
  handler("AgentRegistered", "genlayer", "agents", true, (e) => {
    const profile = payloadMatching(e.blob.profile, e.blob.profile_hash, "AgentRegistered");
    return [
      {
        collection: "agents",
        id: str(e.indexed.agent_id),
        set: {
          ...provenance(e),
          agent_id: str(e.indexed.agent_id),
          operator: lower(e.blob.operator),
          profile_hash: lower(e.blob.profile_hash),
          profile,
          // Derived from the profile the hash check just verified, so a capability query
          // is answerable without parsing JSON on every read. `$set` of the whole array
          // rather than `$addToSet`, because a profile update that drops a capability
          // must drop it here too.
          capabilities: capabilitiesOf(profile),
          registered_at: num(e.blob.registered_at),
        },
        setOnInsert: { dao_ids: [] },
      },
    ];
  }),

  handler("AgentProfileUpdated", "genlayer", "agents", false, (e) => {
    const profile = payloadMatching(e.blob.profile, e.blob.profile_hash, "AgentProfileUpdated");
    return [
      {
        collection: "agents",
        id: str(e.indexed.agent_id),
        set: {
          ...provenance(e),
          profile_hash: lower(e.blob.profile_hash),
          profile,
          capabilities: capabilitiesOf(profile),
        },
      },
    ];
  }),

  handler("DaoCreated", "genlayer", "daos", true, (e) => [
    {
      collection: "daos",
      id: str(e.indexed.dao_id),
      set: {
        ...provenance(e),
        dao_id: str(e.indexed.dao_id),
        creator_agent_id: str(e.blob.creator_agent_id),
        metadata_hash: lower(e.blob.metadata_hash),
        rules_hash: lower(e.blob.rules_hash),
        metadata: payloadMatching(e.blob.metadata, e.blob.metadata_hash, "DaoCreated.metadata"),
        rules: payloadMatching(e.blob.rules, e.blob.rules_hash, "DaoCreated.rules"),
        rules_version: num(e.blob.rules_version),
      },
    },
  ]),

  handler("DaoRulesUpdated", "genlayer", "daos", false, (e) => [
    {
      collection: "daos",
      id: str(e.indexed.dao_id),
      set: {
        ...provenance(e),
        rules_hash: lower(e.blob.rules_hash),
        rules: payloadMatching(e.blob.rules, e.blob.rules_hash, "DaoRulesUpdated"),
        rules_version: num(e.blob.rules_version),
      },
    },
  ]),

  handler("MemberJoined", "genlayer", "memberships", true, (e) => {
    const daoId = str(e.indexed.dao_id);
    const agentId = str(e.indexed.agent_id);
    return [
      {
        collection: "memberships",
        // Keyed on the pair, so the same membership re-emitted is the same document.
        id: `${daoId}|${agentId}`,
        set: {
          ...provenance(e),
          dao_id: daoId,
          agent_id: agentId,
          mode: str(e.blob.mode),
        },
      },
      {
        // `$addToSet` rather than a counter: idempotent under replay.
        collection: "agents",
        id: agentId,
        set: {},
        addToSet: { dao_ids: daoId },
      },
    ];
  }),
];

// ── wrk_work ────────────────────────────────────────────────────────────────

const workHandlers: EventHandler[] = [
  handler("MissionCreated", "genlayer", "missions", true, (e) => [
    {
      collection: "missions",
      id: str(e.indexed.mission_id),
      set: {
        ...provenance(e),
        mission_id: str(e.indexed.mission_id),
        dao_id: str(e.blob.dao_id),
        creator_agent_id: str(e.blob.creator_agent_id),
        mission_hash: lower(e.blob.mission_hash),
        payload: payloadMatching(e.blob.payload, e.blob.mission_hash, "MissionCreated"),
        state: str(e.blob.state),
        rules_version: num(e.blob.rules_version),
        budget_atomic: str(e.blob.budget_atomic),
        deadline_unix: num(e.blob.deadline_unix),
        version: 1,
      },
      setOnInsert: { selected_proposal_id: null, selection_decision_hash: null },
    },
  ]),

  handler("MissionUpdated", "genlayer", "missions", false, (e) => [
    {
      collection: "missions",
      id: str(e.indexed.mission_id),
      set: {
        ...provenance(e),
        mission_hash: lower(e.blob.mission_hash),
        payload: payloadMatching(e.blob.payload, e.blob.mission_hash, "MissionUpdated"),
        version: num(e.blob.version),
        budget_atomic: str(e.blob.budget_atomic),
        deadline_unix: num(e.blob.deadline_unix),
      },
    },
  ]),

  handler("MissionStateChanged", "genlayer", "missions", false, (e) => [
    {
      collection: "missions",
      id: str(e.indexed.mission_id),
      set: { ...provenance(e), state: str(e.blob.state) },
    },
  ]),

  handler("ProposalSubmitted", "genlayer", "proposals", true, (e) => [
    {
      collection: "proposals",
      id: str(e.indexed.proposal_id),
      set: {
        ...provenance(e),
        proposal_id: str(e.indexed.proposal_id),
        mission_id: str(e.blob.mission_id),
        dao_id: str(e.blob.dao_id),
        agent_id: str(e.blob.agent_id),
        proposal_hash: lower(e.blob.proposal_hash),
        payload: payloadMatching(e.blob.payload, e.blob.proposal_hash, "ProposalSubmitted"),
        requested_budget_atomic: str(e.blob.requested_budget_atomic),
        team_size: num(e.blob.team_size),
      },
      setOnInsert: { selected: false },
    },
  ]),

  handler("SelectionRecorded", "genlayer", "missions", false, (e) => [
    {
      collection: "missions",
      id: str(e.indexed.mission_id),
      set: {
        ...provenance(e),
        selected_proposal_id: str(e.blob.proposal_id),
        selection_decision_hash: lower(e.blob.decision_hash),
      },
    },
    {
      collection: "proposals",
      id: str(e.blob.proposal_id),
      set: { selected: true },
    },
  ]),

  handler("MandateCreated", "genlayer", "mandates", true, (e) => [
    {
      collection: "mandates",
      id: str(e.indexed.mandate_id),
      set: {
        ...provenance(e),
        mandate_id: str(e.indexed.mandate_id),
        mission_id: str(e.blob.mission_id),
        dao_id: str(e.blob.dao_id),
        mandate_hash: lower(e.blob.mandate_hash),
        payload: payloadMatching(e.blob.payload, e.blob.mandate_hash, "MandateCreated"),
        state: str(e.blob.state),
        rules_version: num(e.blob.rules_version),
        proposal_hash: lower(e.blob.proposal_hash),
        selection_decision_hash: lower(e.blob.selection_decision_hash),
        budget_atomic: str(e.blob.budget_atomic),
        deadline_unix: num(e.blob.deadline_unix),
        worker_count: num(e.blob.worker_count),
      },
      setOnInsert: {
        accepted_count: 0,
        decision_hash: null,
        funding_tx: null,
        settlement_tx: null,
      },
    },
  ]),

  handler("MandateAccepted", "genlayer", "mandates", false, (e) => [
    {
      collection: "mandates",
      id: str(e.indexed.mandate_id),
      // `accepted` is an absolute count in the event, not a delta, so this is replay-safe.
      set: { ...provenance(e), accepted_count: num(e.blob.accepted) },
    },
  ]),

  handler("MandateStateChanged", "genlayer", "mandates", false, (e) => [
    {
      collection: "mandates",
      id: str(e.indexed.mandate_id),
      set: { ...provenance(e), state: str(e.blob.state) },
    },
  ]),

  handler("DeliverableSubmitted", "genlayer", "deliverables", true, (e) => [
    {
      collection: "deliverables",
      id: str(e.indexed.deliverable_id),
      set: {
        ...provenance(e),
        deliverable_id: str(e.indexed.deliverable_id),
        mandate_id: str(e.blob.mandate_id),
        agent_id: str(e.blob.agent_id),
        deliverable_hash: lower(e.blob.deliverable_hash),
        payload: payloadMatching(e.blob.payload, e.blob.deliverable_hash, "DeliverableSubmitted"),
        evidence_count: num(e.blob.evidence_count),
      },
    },
  ]),

  handler("EvidenceRecorded", "genlayer", "evidence", true, (e) => [
    {
      collection: "evidence",
      id: str(e.indexed.evidence_id),
      set: {
        ...provenance(e),
        evidence_id: str(e.indexed.evidence_id),
        deliverable_id: str(e.blob.deliverable_id),
        mandate_id: str(e.blob.mandate_id),
        worker_agent_id: str(e.blob.worker_agent_id),
        evidence_type: str(e.blob.evidence_type),
        uri: str(e.blob.uri),
        content_hash: lower(e.blob.content_hash),
      },
    },
  ]),

  handler("AdjudicationRecorded", "genlayer", "mandates", false, (e) => [
    {
      collection: "mandates",
      id: str(e.indexed.mandate_id),
      set: { ...provenance(e), decision_hash: lower(e.blob.decision_hash) },
    },
  ]),

  handler("CustodyRelayed", "genlayer", "mandates", false, (e) => {
    const state = str(e.blob.state);
    const tx = lower(e.blob.base_tx_hash);
    // RELAYED, NOT PROVEN. Recorded under the leg it refers to so a reader can check it
    // against Base rather than take wrk_work's word for it.
    const field = state === "FUNDED" ? "funding_tx" : "settlement_tx";
    return [
      {
        collection: "mandates",
        id: str(e.indexed.mandate_id),
        set: { ...provenance(e), [field]: tx },
      },
    ];
  }),
];

// ── wrk_adjudicator ─────────────────────────────────────────────────────────

const adjudicatorHandlers: EventHandler[] = [
  handler("SelectionDecided", "genlayer", "missions", false, (e) => [
    {
      collection: "missions",
      id: str(e.indexed.mission_id),
      // The adjudicator's own record. wrk_work's SelectionRecorded arrives separately,
      // only after finality, and the two must agree — `verify/events.mjs` checks that
      // both write the same field so a disagreement is visible rather than last-wins.
      set: { ...provenance(e), selection_decision_hash: lower(e.blob.decision_hash) },
    },
  ]),

  handler("DecisionRecorded", "genlayer", "decisions", true, (e) => [
    {
      collection: "decisions",
      id: str(e.indexed.mandate_id),
      set: {
        ...provenance(e),
        mandate_id: str(e.indexed.mandate_id),
        decision_id: str(e.blob.decision_id),
        decision_hash: lower(e.blob.decision_hash),
        verdict: str(e.blob.verdict),
        release_bp: num(e.blob.release_bp),
        refund_bp: num(e.blob.refund_bp),
        criteria_met: num(e.blob.criteria_met),
        criteria_total: num(e.blob.criteria_total),
        state: str(e.blob.state),
      },
      setOnInsert: { finalized_at: 0 },
    },
  ]),

  handler("DecisionFinalized", "genlayer", "decisions", false, (e) => [
    {
      collection: "decisions",
      id: str(e.indexed.mandate_id),
      set: {
        ...provenance(e),
        state: str(e.blob.state),
        finalized_at: num(e.blob.finalized_at),
      },
    },
  ]),
];

// ── wrk_reputation ──────────────────────────────────────────────────────────

const reputationHandlers: EventHandler[] = [
  handler("ReputationRecorded", "genlayer", "reputation", true, (e) => {
    const daoId = str(e.indexed.dao_id);
    const agentId = str(e.indexed.agent_id);
    return [
      {
        collection: "reputation",
        id: `${daoId}|${agentId}`,
        // Every field is an absolute value the contract computed, so a replay converges
        // rather than accumulating. The score is recomputable from the two totals, which
        // is why both travel in the event.
        set: {
          ...provenance(e),
          dao_id: daoId,
          agent_id: agentId,
          settled_mandates: num(e.blob.settled_mandates),
          total_release_bp: num(e.blob.total_release_bp),
          score_bp: num(e.blob.score_bp),
          rejections: num(e.blob.verdict === "REJECTION" ? 1 : 0),
          last_mandate_id: str(e.blob.mandate_id),
        },
      },
    ];
  }),
];

// ── Base: WRKEscrow and WRKSettlementVerifier ───────────────────────────────

const baseHandlers: EventHandler[] = [
  handler("MandateFunded", "base", "settlements", true, (e) => [
    {
      collection: "settlements",
      id: str(e.indexed.mandateId).toLowerCase(),
      set: {
        ...provenance(e),
        settlement_id: lower(e.indexed.mandateId),
        mandate_id: lower(e.indexed.mandateId),
        state: "POSTED",
        deposited_atomic: str(e.blob.amount),
        posted_at_unix: 0,
        executable_at_unix: 0,
        decision_hash: `0x${"0".repeat(64)}`,
        release_bp: 0,
        refund_bp: 10_000,
      },
      setOnInsert: {
        released_atomic: null,
        refunded_atomic: null,
        executed_at_unix: 0,
        challenged: false,
      },
    },
  ]),

  handler("SettlementPosted", "base", "settlements", false, (e) => [
    {
      collection: "settlements",
      id: lower(e.indexed.mandateId),
      set: {
        ...provenance(e),
        settlement_id: lower(e.indexed.settlementId),
        state: "POSTED",
        decision_hash: lower(e.blob.decisionHash),
        release_bp: num(e.blob.releaseBp),
        refund_bp: num(e.blob.refundBp),
        posted_at_unix: num(e.blob.postedAt),
        executable_at_unix: num(e.blob.executableAt),
        challenged: false,
      },
    },
  ]),

  handler("SettlementChallenged", "base", "settlements", false, (e) => [
    {
      collection: "settlements",
      id: lower(e.indexed.mandateId),
      // A challenge voids the posting and returns the escrow to NONE so the adapter can
      // re-post. The read model records that it happened; it must not look executable.
      set: { ...provenance(e), state: "CHALLENGED", challenged: true },
    },
  ]),

  handler("SettlementExecuted", "base", "settlements", false, (e) => [
    {
      collection: "settlements",
      id: lower(e.indexed.mandateId),
      set: {
        ...provenance(e),
        state: "EXECUTED",
        released_atomic: str(e.blob.released),
        refunded_atomic: str(e.blob.refunded),
        executed_at_unix: num(e.blob.executedAt),
      },
    },
  ]),

  handler("PayeePaid", "base", "payments", true, (e) => [
    {
      collection: "payments",
      // One payment per (settlement, payee): the key a replay reproduces.
      id: `${lower(e.indexed.settlementId)}|${lower(e.indexed.payee)}`,
      set: {
        ...provenance(e),
        settlement_id: lower(e.indexed.settlementId),
        payee: lower(e.indexed.payee),
        share_bp: num(e.blob.shareBp),
        amount_atomic: str(e.blob.amount),
      },
    },
  ]),

  handler("ExpiredRefund", "base", "settlements", false, (e) => [
    {
      collection: "settlements",
      id: lower(e.indexed.mandateId),
      set: {
        ...provenance(e),
        state: "EXECUTED",
        released_atomic: "0",
        refunded_atomic: str(e.blob.amount),
        executed_at_unix: num(e.ref.block),
      },
    },
  ]),
];

export const HANDLERS: readonly EventHandler[] = [
  ...registryHandlers,
  ...workHandlers,
  ...adjudicatorHandlers,
  ...reputationHandlers,
  ...baseHandlers,
];

const BY_NAME = new Map(HANDLERS.map((entry) => [entry.event, entry]));

export function handlerFor(name: string): EventHandler | undefined {
  return BY_NAME.get(name);
}

/** Every event name this catalogue covers. */
export function coveredEvents(): string[] {
  return HANDLERS.map((entry) => entry.event).sort();
}

/**
 * Turn one decoded event into its upserts.
 *
 * An unknown event is an error, not a skip. Rule 3 cuts both ways: a document must come
 * from an event, and an event the read model does not understand means the model is
 * behind the contracts — which is a condition to stop on, not to log and continue past,
 * because every later document would be derived from an incomplete picture.
 */
export function project(event: DecodedEvent): Upsert[] {
  const found = BY_NAME.get(event.name);
  if (!found) {
    throw new Error(
      `no handler for event ${event.name} from ${event.source}: the read model is behind the contracts`,
    );
  }
  if (found.source !== event.source) {
    throw new Error(
      `event ${event.name} arrived from ${event.source} but the catalogue expects ${found.source}`,
    );
  }
  return found.handle(event);
}
