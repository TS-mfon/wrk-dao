/**
 * Collection names, their schema, and their indexes.
 *
 * One collection per on-chain object (§9), plus `memberships` and `payments`, which are
 * one-row-per-event facts rather than objects with a lifecycle. Keeping them separate
 * matters for rule 2: an upsert must be keyed by something a replay produces identically,
 * and "the agents in this DAO" is not such a key — the membership *event* is.
 */

import type { ZodType } from "zod";
import {
  agentSchema,
  checkpointSchema,
  daoSchema,
  decisionSchema,
  deliverableSchema,
  evidenceSchema,
  mandateSchema,
  membershipSchema,
  missionSchema,
  paymentSchema,
  proposalSchema,
  reputationSchema,
  settlementSchema,
} from "./schemas.js";

export interface CollectionSpec {
  readonly name: string;
  readonly schema: ZodType;
  /** Secondary indexes. `_id` is always the on-chain key, so it needs none. */
  readonly indexes: ReadonlyArray<{
    readonly keys: Record<string, 1 | -1>;
    readonly unique?: boolean;
    readonly name: string;
  }>;
}

export const COLLECTIONS = {
  agents: {
    name: "agents",
    schema: agentSchema,
    indexes: [
      { name: "operator", keys: { operator: 1 }, unique: true },
      { name: "seq", keys: { seq: 1 } },
    ],
  },
  daos: {
    name: "daos",
    schema: daoSchema,
    indexes: [
      { name: "creator", keys: { creator_agent_id: 1 } },
      { name: "seq", keys: { seq: 1 } },
    ],
  },
  memberships: {
    name: "memberships",
    schema: membershipSchema,
    indexes: [
      { name: "dao_agent", keys: { dao_id: 1, agent_id: 1 }, unique: true },
      { name: "agent", keys: { agent_id: 1 } },
    ],
  },
  missions: {
    name: "missions",
    schema: missionSchema,
    indexes: [
      { name: "dao_state", keys: { dao_id: 1, state: 1 } },
      { name: "state_deadline", keys: { state: 1, deadline_unix: 1 } },
      { name: "seq", keys: { seq: 1 } },
    ],
  },
  proposals: {
    name: "proposals",
    schema: proposalSchema,
    indexes: [
      { name: "mission", keys: { mission_id: 1 } },
      { name: "agent", keys: { agent_id: 1 } },
    ],
  },
  mandates: {
    name: "mandates",
    schema: mandateSchema,
    indexes: [
      { name: "dao_state", keys: { dao_id: 1, state: 1 } },
      { name: "mission", keys: { mission_id: 1 }, unique: true },
      { name: "state", keys: { state: 1 } },
      { name: "seq", keys: { seq: 1 } },
    ],
  },
  deliverables: {
    name: "deliverables",
    schema: deliverableSchema,
    indexes: [{ name: "mandate", keys: { mandate_id: 1 } }],
  },
  evidence: {
    name: "evidence",
    schema: evidenceSchema,
    indexes: [
      { name: "mandate", keys: { mandate_id: 1 } },
      { name: "deliverable", keys: { deliverable_id: 1 } },
    ],
  },
  decisions: {
    name: "decisions",
    schema: decisionSchema,
    indexes: [
      { name: "decision_hash", keys: { decision_hash: 1 } },
      { name: "state", keys: { state: 1 } },
    ],
  },
  settlements: {
    name: "settlements",
    schema: settlementSchema,
    indexes: [
      { name: "mandate", keys: { mandate_id: 1 } },
      // The monitoring page's primary query: what is posted and past its window.
      { name: "state_executable", keys: { state: 1, executable_at_unix: 1 } },
    ],
  },
  payments: {
    name: "payments",
    schema: paymentSchema,
    indexes: [
      { name: "settlement", keys: { settlement_id: 1 } },
      { name: "payee", keys: { payee: 1 } },
    ],
  },
  reputation: {
    name: "reputation",
    schema: reputationSchema,
    indexes: [
      { name: "dao_agent", keys: { dao_id: 1, agent_id: 1 }, unique: true },
      { name: "dao_score", keys: { dao_id: 1, score_bp: -1 } },
    ],
  },
  indexer_checkpoints: {
    name: "indexer_checkpoints",
    schema: checkpointSchema,
    indexes: [{ name: "chain", keys: { chain: 1 }, unique: true }],
  },
} as const satisfies Record<string, CollectionSpec>;

export type CollectionName = keyof typeof COLLECTIONS;

/** Collections the read model derives from chain events, checkpoints excluded. */
export const DERIVED_COLLECTIONS = (
  Object.keys(COLLECTIONS) as CollectionName[]
).filter((name) => name !== "indexer_checkpoints");

export function collectionSpec(name: CollectionName): CollectionSpec {
  return COLLECTIONS[name];
}
