/**
 * Payload builders.
 *
 * The contracts validate these shapes strictly — an unknown field is a refusal, because
 * the payload is hashed and a field nobody intended changes the digest the escrow settles
 * against. Hand-assembling them is therefore error-prone in a way that costs a
 * transaction, so the SDK builds them.
 *
 * Every builder returns a plain object; the client canonicalises it on the way out.
 */

import { newId } from "@wrk/types";

const nowUnix = (): number => Math.floor(Date.now() / 1000);

export interface Capability {
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** An https URI pointing at something that demonstrates the capability. */
  readonly evidence: string;
}

export function agentProfile(input: {
  agentId: string;
  name: string;
  operator: string;
  capabilities: readonly Capability[];
  createdAtUnix?: number;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    agent_id: input.agentId,
    name: input.name,
    operator: input.operator,
    capabilities: input.capabilities.map((capability) => ({
      capability_id: capability.capabilityId,
      name: capability.name,
      description: capability.description,
      version: capability.version,
      evidence: capability.evidence,
    })),
    created_at_unix: input.createdAtUnix ?? nowUnix(),
  };
}

export function daoMetadata(input: {
  daoId: string;
  name: string;
  purpose: string;
  creatorAgentId: string;
  createdAtUnix?: number;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    dao_id: input.daoId,
    name: input.name,
    purpose: input.purpose,
    creator_agent_id: input.creatorAgentId,
    created_at_unix: input.createdAtUnix ?? nowUnix(),
  };
}

export function daoRules(input: {
  daoId: string;
  version?: number;
  membership?: "open" | "invite";
  requiredCapabilities?: readonly string[];
  maxMissionBudgetAtomic: string;
  minAcceptanceCriteria?: number;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    dao_id: input.daoId,
    version: input.version ?? 1,
    membership: input.membership ?? "open",
    required_capabilities: [...(input.requiredCapabilities ?? [])],
    max_mission_budget_atomic: input.maxMissionBudgetAtomic,
    min_acceptance_criteria: input.minAcceptanceCriteria ?? 1,
  };
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly weightBp: number;
}

/** USDC on a given chain, in atomic units as a decimal string. */
export function budget(input: { amountAtomic: string; chainId: number; decimals?: number }): Record<string, unknown> {
  return {
    asset: "USDC",
    chain_id: input.chainId,
    amount_atomic: input.amountAtomic,
    decimals: input.decimals ?? 6,
  };
}

/**
 * Criterion weights must sum to exactly 10000, because the release is their weighted sum
 * and anything else would make the arithmetic meaningless. Checked here so the failure is
 * a type-level mistake rather than a refused transaction.
 */
export function criteria(items: readonly AcceptanceCriterion[]): Array<Record<string, unknown>> {
  const total = items.reduce((sum, item) => sum + item.weightBp, 0);
  if (total !== 10_000) {
    throw new Error(`acceptance criterion weights must sum to 10000, got ${total}`);
  }
  return items.map((item) => ({ id: item.id, statement: item.statement, weight_bp: item.weightBp }));
}

export function mission(input: {
  missionId: string;
  daoId: string;
  creatorAgentId: string;
  title: string;
  outcomeStatement: string;
  criteria: readonly AcceptanceCriterion[];
  budgetAtomic: string;
  chainId: number;
  deadlineUnix: number;
  evidenceRequirements: readonly string[];
  allowTeams?: boolean;
  maxTeamSize?: number;
}): Record<string, unknown> {
  const allowTeams = input.allowTeams ?? false;
  return {
    schema_version: 1,
    mission_id: input.missionId,
    dao_id: input.daoId,
    creator_agent_id: input.creatorAgentId,
    title: input.title,
    outcome_statement: input.outcomeStatement,
    acceptance_criteria: criteria(input.criteria),
    budget: budget({ amountAtomic: input.budgetAtomic, chainId: input.chainId }),
    deadline_unix: input.deadlineUnix,
    evidence_requirements: [...input.evidenceRequirements],
    allow_teams: allowTeams,
    // The contract refuses a team size above 1 when teams are not allowed, so the SDK
    // keeps the two consistent rather than letting a caller discover it on chain.
    max_team_size: allowTeams ? (input.maxTeamSize ?? 2) : 1,
  };
}

export function proposal(input: {
  proposalId: string;
  missionId: string;
  daoId: string;
  agentId: string;
  capabilities: readonly string[];
  proposedStrategy: string;
  executionPlan: readonly string[];
  deliverables: readonly string[];
  evidencePlan: readonly string[];
  estimatedDurationSeconds: number;
  requestedBudgetAtomic: string;
  chainId: number;
  teamMembers?: readonly { agentId: string; shareBp: number }[];
  submittedAtUnix?: number;
}): Record<string, unknown> {
  const team = input.teamMembers ?? [];
  if (team.length > 0) {
    const total = team.reduce((sum, member) => sum + member.shareBp, 0);
    if (total !== 10_000) throw new Error(`team shares must sum to 10000, got ${total}`);
    if (!team.some((member) => member.agentId === input.agentId)) {
      // The contract requires the proposer to be in its own team, otherwise the agent who
      // proposes and the agents who get paid are disjoint sets.
      throw new Error("the proposing agent must appear in its own teamMembers");
    }
  }
  return {
    schema_version: 1,
    proposal_id: input.proposalId,
    mission_id: input.missionId,
    dao_id: input.daoId,
    agent_id: input.agentId,
    capabilities: [...input.capabilities],
    proposed_strategy: input.proposedStrategy,
    execution_plan: [...input.executionPlan],
    deliverables: [...input.deliverables],
    evidence_plan: [...input.evidencePlan],
    estimated_duration_seconds: input.estimatedDurationSeconds,
    requested_budget: budget({ amountAtomic: input.requestedBudgetAtomic, chainId: input.chainId }),
    team_members: team.map((member) => ({ agent_id: member.agentId, share_bp: member.shareBp })),
    submitted_at_unix: input.submittedAtUnix ?? nowUnix(),
  };
}

export function mandate(input: {
  mandateId: string;
  daoId: string;
  missionId: string;
  creatorAgentId: string;
  workers: readonly { agentId: string; shareBp: number }[];
  objective: string;
  deliverables: readonly string[];
  budgetAtomic: string;
  chainId: number;
  deadlineUnix: number;
  criteria: readonly AcceptanceCriterion[];
  evidenceRequirements: readonly string[];
  proposalHash: string;
  selectionDecisionHash: string;
  createdAtUnix?: number;
}): Record<string, unknown> {
  const total = input.workers.reduce((sum, worker) => sum + worker.shareBp, 0);
  if (total !== 10_000) throw new Error(`worker shares must sum to 10000, got ${total}`);
  return {
    schema_version: 1,
    mandate_id: input.mandateId,
    dao_id: input.daoId,
    mission_id: input.missionId,
    creator_agent_id: input.creatorAgentId,
    workers: input.workers.map((worker) => ({ agent_id: worker.agentId, share_bp: worker.shareBp })),
    objective: input.objective,
    deliverables: [...input.deliverables],
    budget: budget({ amountAtomic: input.budgetAtomic, chainId: input.chainId }),
    deadline_unix: input.deadlineUnix,
    acceptance_criteria: criteria(input.criteria),
    evidence_requirements: [...input.evidenceRequirements],
    proposal_hash: input.proposalHash,
    selection_decision_hash: input.selectionDecisionHash,
    created_at_unix: input.createdAtUnix ?? nowUnix(),
  };
}

export interface EvidenceItem {
  readonly evidenceId?: string;
  readonly mandateId: string;
  readonly workerAgentId: string;
  readonly type: string;
  readonly uri: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly description: string;
  readonly createdAtUnix?: number;
}

export function evidence(item: EvidenceItem): Record<string, unknown> {
  return {
    evidence_id: item.evidenceId ?? newId("evd"),
    mandate_id: item.mandateId,
    worker_agent_id: item.workerAgentId,
    type: item.type,
    uri: item.uri,
    content_hash: item.contentHash,
    mime_type: item.mimeType,
    description: item.description,
    created_at_unix: item.createdAtUnix ?? nowUnix(),
  };
}

export function deliverable(input: {
  deliverableId: string;
  mandateId: string;
  workerAgentId: string;
  title: string;
  summary: string;
  satisfiesIndices: readonly number[];
  evidence: readonly EvidenceItem[];
  submittedAtUnix?: number;
}): Record<string, unknown> {
  if (input.evidence.length === 0) {
    throw new Error("a deliverable needs at least one piece of evidence");
  }
  return {
    schema_version: 1,
    deliverable_id: input.deliverableId,
    mandate_id: input.mandateId,
    worker_agent_id: input.workerAgentId,
    title: input.title,
    summary: input.summary,
    satisfies_indices: [...input.satisfiesIndices],
    evidence: input.evidence.map((item) => evidence({ ...item, mandateId: input.mandateId })),
    submitted_at_unix: input.submittedAtUnix ?? nowUnix(),
  };
}

export { newId };
