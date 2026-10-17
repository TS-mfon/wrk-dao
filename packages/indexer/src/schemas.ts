/**
 * Read-model document schemas (docs/ARCHITECTURE.md §9).
 *
 * Zod validates on **write and on read**. That asymmetry-free rule is the mitigation for
 * dropping PostgreSQL's schema enforcement (§3.2): there is no database-level constraint,
 * so a document that does not conform must be rejected at both boundaries or the next
 * reader has to defend itself.
 *
 * Validating on read also catches the case a write-only check cannot: a document written
 * by an older version of this package, or by hand.
 */

import { z } from "zod";

/** Rule 1: every document carries where on chain it came from. */
export const chainRefSchema = z
  .object({
    chain: z.number().int().positive(),
    tx_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    block: z.number().int().nonnegative(),
    log_index: z.number().int().nonnegative(),
    block_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();

export type ChainRef = z.infer<typeof chainRefSchema>;

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$`));

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
/** Atomic amounts stay decimal strings end to end: one spelling per value. */
const atomic = z.string().regex(/^(0|[1-9][0-9]*)$/);
const bp = z.number().int().min(0).max(10_000);

/** Fields every document has, so a reader can always find provenance and ordering. */
const base = {
  _id: z.string().min(1),
  chain_ref: chainRefSchema,
  /** Monotonic within a chain: `block * 1e6 + log_index`. Orders a replay. */
  seq: z.number().int().nonnegative(),
  updated_at: z.number().int().positive(),
};

export const agentSchema = z
  .object({
    ...base,
    agent_id: id("agt"),
    operator: address,
    profile_hash: bytes32,
    /**
     * The canonical profile, exactly as hashed on chain.
     *
     * Stored for the same reason a mission's payload is: a digest cannot answer "what can
     * this agent do?", and that question decides DAO membership. Without it a worker has
     * to send a `join_dao` and have it refused to discover it lacks a required
     * capability. Re-hashed by the indexer, so it is self-verifying rather than trusted.
     */
    profile: z.string().min(2),
    registered_at: z.number().int().positive(),
    /** Projected from `profile`, so a capability query needs no JSON parsing per row. */
    capabilities: z.array(z.string()).default([]),
    dao_ids: z.array(id("dao")).default([]),
  })
  .strict();

export const daoSchema = z
  .object({
    ...base,
    dao_id: id("dao"),
    creator_agent_id: id("agt"),
    metadata_hash: bytes32,
    rules_hash: bytes32,
    /** The canonical metadata, as hashed on chain. */
    metadata: z.string().min(2),
    /**
     * The canonical rules, as hashed on chain.
     *
     * `required_capabilities` decides who may join and `max_mission_budget_atomic` decides
     * what may be commissioned. An agent that can see only a digest has to guess at both,
     * or send a transaction to find out — so the terms travel with the event.
     */
    rules: z.string().min(2),
    rules_version: z.number().int().positive(),
    // No member_count here on purpose. Maintaining a counter needs `$inc`, and `$inc` is
    // not idempotent — replaying a block would double it, which is exactly what G3
    // forbids. Member count is a `memberships` count query instead, so every write in
    // this read model stays single-document and replay-safe.
  })
  .strict();

export const membershipSchema = z
  .object({
    ...base,
    dao_id: id("dao"),
    agent_id: id("agt"),
    mode: z.enum(["created", "joined", "invited"]),
  })
  .strict();

export const missionSchema = z
  .object({
    ...base,
    mission_id: id("msn"),
    dao_id: id("dao"),
    creator_agent_id: id("agt"),
    mission_hash: bytes32,
    /**
     * The canonical payload, exactly as hashed on chain.
     *
     * Stored because a digest alone is not usable: an agent deciding whether to propose
     * needs the acceptance criteria, and a UI showing a mission needs its text. The
     * indexer re-hashes this and refuses a mismatch, so the stored content is
     * self-verifying rather than trusted.
     */
    payload: z.string().min(2),
    state: z.enum([
      "DRAFT",
      "OPEN",
      "PROPOSALS_CLOSED",
      "SELECTING",
      "SELECTED",
      "MANDATED",
      "CANCELLED",
      "EXPIRED",
    ]),
    version: z.number().int().positive(),
    rules_version: z.number().int().positive(),
    budget_atomic: atomic,
    deadline_unix: z.number().int().positive(),
    selected_proposal_id: id("prp").nullable().default(null),
    selection_decision_hash: bytes32.nullable().default(null),
  })
  .strict();

export const proposalSchema = z
  .object({
    ...base,
    proposal_id: id("prp"),
    mission_id: id("msn"),
    dao_id: id("dao"),
    agent_id: id("agt"),
    proposal_hash: bytes32,
    /**
     * The canonical payload, exactly as hashed on chain.
     *
     * Stored because a digest alone is not usable: an agent deciding whether to propose
     * needs the acceptance criteria, and a UI showing a mission needs its text. The
     * indexer re-hashes this and refuses a mismatch, so the stored content is
     * self-verifying rather than trusted.
     */
    payload: z.string().min(2),
    requested_budget_atomic: atomic,
    team_size: z.number().int().nonnegative(),
    selected: z.boolean().default(false),
  })
  .strict();

export const mandateSchema = z
  .object({
    ...base,
    mandate_id: id("mnd"),
    mission_id: id("msn"),
    dao_id: id("dao"),
    mandate_hash: bytes32,
    /**
     * The canonical payload, exactly as hashed on chain.
     *
     * Stored because a digest alone is not usable: an agent deciding whether to propose
     * needs the acceptance criteria, and a UI showing a mission needs its text. The
     * indexer re-hashes this and refuses a mismatch, so the stored content is
     * self-verifying rather than trusted.
     */
    payload: z.string().min(2),
    state: z.enum([
      "CREATED",
      "ACCEPTED",
      "FUNDED",
      "IN_PROGRESS",
      "SUBMITTED",
      "ADJUDICATING",
      "ADJUDICATED",
      "SETTLED",
      "REFUNDED",
      "EXPIRED",
      "CANCELLED",
    ]),
    rules_version: z.number().int().positive(),
    proposal_hash: bytes32,
    selection_decision_hash: bytes32,
    budget_atomic: atomic,
    deadline_unix: z.number().int().positive(),
    worker_count: z.number().int().positive(),
    accepted_count: z.number().int().nonnegative(),
    decision_hash: bytes32.nullable().default(null),
    /**
     * The Base transactions this mandate's custody facts were relayed from.
     *
     * Stored so the claim is auditable: `wrk_work` cannot verify Base state, so a
     * reader comparing these against Base is the check that a relay was honest.
     */
    funding_tx: bytes32.nullable().default(null),
    settlement_tx: bytes32.nullable().default(null),
  })
  .strict();

export const deliverableSchema = z
  .object({
    ...base,
    deliverable_id: id("dlv"),
    mandate_id: id("mnd"),
    agent_id: id("agt"),
    deliverable_hash: bytes32,
    /**
     * The canonical payload, exactly as hashed on chain.
     *
     * Stored because a digest alone is not usable: an agent deciding whether to propose
     * needs the acceptance criteria, and a UI showing a mission needs its text. The
     * indexer re-hashes this and refuses a mismatch, so the stored content is
     * self-verifying rather than trusted.
     */
    payload: z.string().min(2),
    evidence_count: z.number().int().positive(),
  })
  .strict();

export const evidenceSchema = z
  .object({
    ...base,
    evidence_id: id("evd"),
    deliverable_id: id("dlv"),
    mandate_id: id("mnd"),
    worker_agent_id: id("agt"),
    evidence_type: z.string().min(1),
    uri: z.string().regex(/^https:\/\/\S+$/),
    content_hash: bytes32,
  })
  .strict();

export const decisionSchema = z
  .object({
    ...base,
    mandate_id: id("mnd"),
    decision_id: id("dec"),
    decision_hash: bytes32,
    verdict: z.enum(["FULL_ACCEPTANCE", "PARTIAL_ACCEPTANCE", "REJECTION"]),
    release_bp: bp,
    refund_bp: bp,
    criteria_met: z.number().int().nonnegative(),
    criteria_total: z.number().int().positive(),
    state: z.enum(["ADJUDICATED", "FINALIZED"]),
    finalized_at: z.number().int().nonnegative().default(0),
  })
  .strict()
  // I5 restated at the read boundary. The escrow checks it too; a read model that can
  // display an impossible split would misreport a settlement that cannot happen.
  .refine((d) => d.release_bp + d.refund_bp === 10_000, {
    message: "release_bp + refund_bp must equal 10000",
  });

export const settlementSchema = z
  .object({
    ...base,
    settlement_id: bytes32,
    mandate_id: bytes32,
    state: z.enum(["POSTED", "CHALLENGED", "EXECUTED"]),
    decision_hash: bytes32,
    release_bp: bp,
    refund_bp: bp,
    deposited_atomic: atomic,
    released_atomic: atomic.nullable().default(null),
    refunded_atomic: atomic.nullable().default(null),
    posted_at_unix: z.number().int().nonnegative(),
    executable_at_unix: z.number().int().nonnegative(),
    executed_at_unix: z.number().int().nonnegative().default(0),
    challenged: z.boolean().default(false),
  })
  .strict();

export const paymentSchema = z
  .object({
    ...base,
    settlement_id: bytes32,
    payee: address,
    share_bp: bp,
    amount_atomic: atomic,
  })
  .strict();

export const reputationSchema = z
  .object({
    ...base,
    dao_id: id("dao"),
    agent_id: id("agt"),
    settled_mandates: z.number().int().positive(),
    total_release_bp: z.number().int().nonnegative(),
    score_bp: bp,
    rejections: z.number().int().nonnegative(),
    last_mandate_id: id("mnd"),
  })
  .strict();

export const checkpointSchema = z
  .object({
    _id: z.string().min(1),
    chain: z.number().int().positive(),
    /** The highest block whose events are fully written. */
    block: z.number().int().nonnegative(),
    block_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    /**
     * Recent block hashes, newest last, used to detect a reorg by comparing what the
     * chain now reports against what was recorded. Bounded by finality depth.
     */
    recent: z
      .array(
        z
          .object({
            block: z.number().int().nonnegative(),
            hash: z.string().regex(/^0x[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .default([]),
    updated_at: z.number().int().positive(),
  })
  .strict();

export type AgentDoc = z.infer<typeof agentSchema>;
export type DaoDoc = z.infer<typeof daoSchema>;
export type MembershipDoc = z.infer<typeof membershipSchema>;
export type MissionDoc = z.infer<typeof missionSchema>;
export type ProposalDoc = z.infer<typeof proposalSchema>;
export type MandateDoc = z.infer<typeof mandateSchema>;
export type DeliverableDoc = z.infer<typeof deliverableSchema>;
export type EvidenceDoc = z.infer<typeof evidenceSchema>;
export type DecisionDoc = z.infer<typeof decisionSchema>;
export type SettlementDoc = z.infer<typeof settlementSchema>;
export type PaymentDoc = z.infer<typeof paymentSchema>;
export type ReputationDoc = z.infer<typeof reputationSchema>;
export type CheckpointDoc = z.infer<typeof checkpointSchema>;
