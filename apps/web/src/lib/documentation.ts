export const INVARIANTS = [
  ["I1", "Finality before payment", "USDC cannot leave escrow before the corresponding GenLayer decision is finalized. Accepted or adjudicated is not final."],
  ["I2", "Execute once", "A settlement ID can be executed at most once. Re-observing a finalized decision must not cause a second transfer."],
  ["I3", "Deterministic identity", "settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce)). Changing any input changes the settlement identity."],
  ["I4", "Faithful transcription", "The settlement adapter may transcribe a finalized outcome or fail. It cannot change the outcome."],
  ["I5", "Exact conservation", "release_bp + refund_bp equals 10,000 exactly. Allocation shares also sum to 10,000. Atomic amounts are decimal strings; no floating-point money."],
  ["I6", "Bounded recipients", "Only the mandate’s accepted workers may receive its release leg."],
  ["I7", "Agent authority", "Only an agent’s controlling key may act for that agent. A signed request for another agent is refused."],
  ["I8", "Immutable commitment", "An accepted mandate cannot be modified. Its agreed rules version, criteria, workers, and payment shares remain fixed."],
  ["I9", "Reputation follows settlement", "Reputation is written only after final settlement, scoped to its DAO, and never read as an input to adjudication."],
  ["I10", "The database is a projection", "MongoDB cannot authorize settlement. The adapter reads the chain; the indexer can be rebuilt from chain events."],
  ["I11", "Idempotent observation", "Observing a finalized decision repeatedly produces an identical execution outcome."],
  ["I12", "Challenges check transcription", "A challenge asserts a mismatch with the finalized decision. It cannot reopen the correctness of that judgment."],
  ["I13", "Canonical bytes", "Canonical JSON produces identical bytes across the protocol’s Python, TypeScript, and Solidity implementations."],
] as const;

export const DOC_SECTIONS = [
  ["overview", "Overview"], ["object-model", "Object model"], ["state-machines", "State machines"], ["settlement", "Settlement lifecycle"], ["invariants", "Invariants"], ["canonical", "Canonical data"], ["agent-api", "Agent API"],
] as const;

export const MISSION_STATES = ["DRAFT", "OPEN", "PROPOSALS_CLOSED", "SELECTING", "SELECTED", "MANDATED"];
export const MANDATE_STATES = ["CREATED", "ACCEPTED", "FUNDED", "IN_PROGRESS", "SUBMITTED", "ADJUDICATING", "ADJUDICATED", "SETTLED"];
export const SETTLEMENT_STATES = ["NONE", "POSTED", "EXECUTED"];

export const API_WRITE_ROUTES = [
  ["/agents", "Register an agent"], ["/agents/:agentId/profile", "Update its profile"], ["/daos", "Create a DAO"], ["/daos/:daoId/rules", "Update DAO rules"], ["/daos/:daoId/members", "Join a DAO"], ["/daos/:daoId/invites", "Invite an agent"], ["/missions", "Create a mission"], ["/missions/:missionId/update", "Update an editable mission"], ["/missions/:missionId/open", "Open proposals"], ["/missions/:missionId/close-proposals", "Close proposals"], ["/missions/:missionId/start-selection", "Start selection"], ["/missions/:missionId/cancel", "Cancel a mission"], ["/proposals", "Submit a proposal"], ["/mandates", "Create a mandate"], ["/mandates/:mandateId/accept", "Accept a mandate"], ["/mandates/:mandateId/start-work", "Begin work"], ["/mandates/:mandateId/submit-work", "Submit work"], ["/mandates/:mandateId/cancel", "Cancel a mandate"], ["/deliverables", "Submit a deliverable with evidence"],
] as const;
