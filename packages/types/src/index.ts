/**
 * `@wrk/types` — the shared foundation every other WRK package imports.
 *
 * Normative sources: `docs/CANONICAL.md` (hashing) and `docs/ARCHITECTURE.md`
 * §4–§8 (invariants, identifiers, state machines, decision payload, attestation).
 *
 * Nothing in here touches the network, the filesystem or a database. It is pure
 * encoding, validation and arithmetic, so it is safe to import from the escrow
 * adapter — the one component that must never reach for a database client
 * (invariant I10).
 */

export {
  CANONICAL_JSON_VERSION,
  CANONICAL_KEY_PATTERN,
  CANONICAL_MAX_DEPTH,
  MAX_SAFE_CANONICAL_INTEGER,
  MIN_SAFE_CANONICAL_INTEGER,
  canonicalize,
  isCanonicalizable,
} from "./canonical.js";
export type { CanonicalValue } from "./canonical.js";

export {
  asciiBytes,
  assertBytes32,
  contentHash,
  contentHashWithCanonical,
  hashCanonicalText,
  settlementId,
  structHash,
} from "./hashing.js";
export type { Bytes32 } from "./hashing.js";

export {
  ANY_ID_PATTERN,
  ID_PREFIXES,
  fromBytes32,
  idPattern,
  idTime,
  isId,
  newId,
  parseId,
  toBytes32,
} from "./ids.js";
export type {
  AgentId,
  DaoId,
  DecisionId,
  DeliverableId,
  EvidenceId,
  Id,
  IdPrefix,
  MandateId,
  MissionId,
  ParsedId,
  ProposalId,
  SettlementRecordId,
} from "./ids.js";

export {
  BP_DENOMINATOR,
  VERDICTS,
  assertAllocations,
  assertBpPair,
  assertVerdictMatchesRelease,
  parseAtomic,
  splitRelease,
  verdictForRelease,
  verdictMatchesRelease,
} from "./money.js";
export type { Allocation, Payout, SplitResult, Verdict } from "./money.js";

export {
  MACHINES,
  MANDATE_STATES,
  MISSION_STATES,
  SETTLED_PREDECESSORS,
  SETTLEMENT_STATES,
  assertTransition,
  canEditMission,
  canTransition,
  isTerminal,
  mandateMachine,
  missionMachine,
  settlementMachine,
} from "./states.js";
export type { MandateState, MissionState, SettlementState, StateMachine } from "./states.js";

export {
  EIP712_DOMAIN_TYPE_STRING,
  SETTLEMENT_DOMAIN_NAME,
  SETTLEMENT_DOMAIN_VERSION,
  SETTLEMENT_TYPES,
  SETTLEMENT_TYPE_STRING,
  assertAscendingSigners,
  assertSettlementMessage,
  settlementDigest,
  settlementDomain,
} from "./eip712.js";
export type { SettlementMessage } from "./eip712.js";

export {
  acceptanceCriterionSchema,
  allocationSchema,
  atomicAmountSchema,
  bpSchema,
  budgetSchema,
  contentHashSchema,
  criterionFindingSchema,
  decisionPayloadSchema,
  deliverablePayloadSchema,
  evidenceItemSchema,
  evidenceUriSchema,
  idSchema,
  mandatePayloadSchema,
  missionPayloadSchema,
  parseDecisionPayload,
  parseDeliverablePayload,
  parseMandatePayload,
  parseMissionPayload,
  parseProposalPayload,
  proposalPayloadSchema,
  schemaVersionSchema,
  unixSecondsSchema,
  validate,
} from "./schemas.js";
export type {
  AcceptanceCriterion,
  Budget,
  CriterionFinding,
  DecisionPayload,
  DeliverablePayload,
  EvidenceItem,
  MandatePayload,
  MissionPayload,
  ProposalPayload,
} from "./schemas.js";

export { WrkError, describe, fail, isWrkError } from "./errors.js";
export type { WrkErrorCode } from "./errors.js";
