/**
 * Payload schemas (Zod) for every structure that crosses a boundary.
 *
 * These validate the shapes that get hashed with canonical JSON, so they are
 * deliberately **strict**: unknown keys are rejected rather than ignored. A
 * silently-ignored field is how `weight_bp` goes missing from an acceptance
 * criterion, and because the payload is hashed, a field you did not intend to
 * send changes the digest the escrow settles against. Adding a field is a
 * `schema_version` bump, not a patch.
 *
 * Large integers are decimal **strings** (`amount_atomic`), never numbers —
 * canonical JSON caps numbers at 2^53-1 and a uint256 USDC amount does not fit
 * (docs/CANONICAL.md §1.1 rule 5).
 *
 * Field names follow the two payloads frozen in `fixtures/canonical-inputs.json`
 * (`wrk_mission_payload`, `wrk_decision_payload`); the decision payload matches
 * docs/ARCHITECTURE.md §7 exactly. The remaining payloads follow SPEC §17 (mission),
 * §19 (proposal), §25 (mandate), §29 (evidence) and §30 (submission), trimmed to
 * the MVP surface in §113 and using this protocol's `_unix` timestamp convention.
 */

import { z } from "zod";
import { BP_DENOMINATOR } from "./money.js";
import { ID_PREFIXES, idPattern } from "./ids.js";
import type { IdPrefix } from "./ids.js";
import { fail } from "./errors.js";

/* ── primitives ──────────────────────────────────────────────────────────── */

/** A validated `<prefix>_<ULID>` identifier. */
export function idSchema(prefix: IdPrefix) {
  return z
    .string()
    .regex(idPattern(prefix), `must be a ${prefix}_ prefixed ULID (Crockford base32, no I/L/O/U)`);
}

const ID_SCHEMAS = Object.fromEntries(
  ID_PREFIXES.map((prefix) => [prefix, idSchema(prefix)]),
) as Record<IdPrefix, ReturnType<typeof idSchema>>;

/** Basis points: an integer in 0..10000. */
export const bpSchema = z
  .number()
  .int("basis points must be an integer")
  .min(0)
  .max(BP_DENOMINATOR);

/**
 * Atomic token amount as a decimal string. No leading zeros, no sign, no
 * exponent — one spelling per value, because two spellings would be two hashes.
 */
export const atomicAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,77})$/, "must be a non-negative decimal integer string, no leading zeros");

/**
 * A Unix timestamp in **seconds**. Bounded to 2001-09-09..2286-11-20 so a
 * millisecond value pasted into a seconds field is rejected rather than
 * interpreted as a date 30 millennia from now.
 */
export const unixSecondsSchema = z
  .number()
  .int("timestamps are integer seconds")
  .min(1_000_000_000)
  .max(9_999_999_999);

export const contentHashSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be a lowercase 0x-prefixed 32-byte hex digest");

export const schemaVersionSchema = z.literal(1);

/** An https:// or GitHub URI. IPFS is deliberately not required for the MVP (SPEC §29). */
export const evidenceUriSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, "evidence URIs must be https:// for the MVP");

/* ── shared sub-objects ──────────────────────────────────────────────────── */

export const acceptanceCriterionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,32}$/, "criterion ids are lowercase snake_case, max 32 chars"),
  statement: z.string().min(1).max(2000),
  weight_bp: bpSchema,
});

export const budgetSchema = z.strictObject({
  asset: z.enum(["USDC"]),
  chain_id: z.number().int().positive(),
  amount_atomic: atomicAmountSchema,
  decimals: z.number().int().min(0).max(18),
});

export const allocationSchema = z.strictObject({
  agent_id: ID_SCHEMAS.agt,
  share_bp: bpSchema,
});

export const criterionFindingSchema = z.strictObject({
  criterion_id: z.string().regex(/^[a-z0-9_]{1,32}$/),
  met: z.boolean(),
  confidence_bp: bpSchema,
  rationale: z.string().min(1).max(4000),
});

/* ── mission (SPEC §17) ──────────────────────────────────────────────────── */

export const missionPayloadSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    mission_id: ID_SCHEMAS.msn,
    dao_id: ID_SCHEMAS.dao,
    creator_agent_id: ID_SCHEMAS.agt,
    title: z.string().min(1).max(200),
    outcome_statement: z.string().min(1).max(4000),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1).max(32),
    budget: budgetSchema,
    deadline_unix: unixSecondsSchema,
    evidence_requirements: z.array(z.string().min(1).max(64)).min(1).max(32),
    allow_teams: z.boolean(),
    max_team_size: z.number().int().min(1).max(16),
  })
  .superRefine((value, ctx) => {
    const total = value.acceptance_criteria.reduce((sum, criterion) => sum + criterion.weight_bp, 0);
    if (total !== BP_DENOMINATOR) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptance_criteria"],
        message: `criterion weights must sum to ${BP_DENOMINATOR} exactly, got ${total}`,
      });
    }
    const ids = new Set<string>();
    for (const criterion of value.acceptance_criteria) {
      if (ids.has(criterion.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["acceptance_criteria"],
          message: `duplicate criterion id ${criterion.id}`,
        });
      }
      ids.add(criterion.id);
    }
    if (!value.allow_teams && value.max_team_size !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["max_team_size"],
        message: "max_team_size must be 1 when allow_teams is false",
      });
    }
  });

/* ── proposal (SPEC §19) ─────────────────────────────────────────────────── */

export const proposalPayloadSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    proposal_id: ID_SCHEMAS.prp,
    mission_id: ID_SCHEMAS.msn,
    dao_id: ID_SCHEMAS.dao,
    agent_id: ID_SCHEMAS.agt,
    capabilities: z.array(z.string().min(1).max(64)).min(1).max(32),
    proposed_strategy: z.string().min(1).max(8000),
    execution_plan: z.array(z.string().min(1).max(2000)).min(1).max(64),
    deliverables: z.array(z.string().min(1).max(500)).min(1).max(32),
    evidence_plan: z.array(z.string().min(1).max(500)).min(1).max(32),
    estimated_duration_seconds: z.number().int().min(1).max(31_536_000),
    requested_budget: budgetSchema,
    team_members: z.array(allocationSchema).max(16),
    submitted_at_unix: unixSecondsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.team_members.length === 0) return;
    const total = value.team_members.reduce((sum, member) => sum + member.share_bp, 0);
    if (total !== BP_DENOMINATOR) {
      ctx.addIssue({
        code: "custom",
        path: ["team_members"],
        message: `team shares must sum to ${BP_DENOMINATOR} exactly, got ${total}`,
      });
    }
    const seen = new Set<string>();
    for (const member of value.team_members) {
      if (seen.has(member.agent_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["team_members"],
          message: `duplicate team member ${member.agent_id}`,
        });
      }
      seen.add(member.agent_id);
    }
  });

/* ── mandate (SPEC §25) ──────────────────────────────────────────────────── */

export const mandatePayloadSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    mandate_id: ID_SCHEMAS.mnd,
    dao_id: ID_SCHEMAS.dao,
    mission_id: ID_SCHEMAS.msn,
    creator_agent_id: ID_SCHEMAS.agt,
    workers: z.array(allocationSchema).min(1).max(16),
    objective: z.string().min(1).max(4000),
    deliverables: z.array(z.string().min(1).max(500)).min(1).max(32),
    budget: budgetSchema,
    deadline_unix: unixSecondsSchema,
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1).max(32),
    evidence_requirements: z.array(z.string().min(1).max(64)).min(1).max(32),
    /** Content hash of the selected proposal — binds the mandate to what was chosen. */
    proposal_hash: contentHashSchema,
    /** Content hash of the GenLayer selection decision that produced this mandate. */
    selection_decision_hash: contentHashSchema,
    created_at_unix: unixSecondsSchema,
  })
  .superRefine((value, ctx) => {
    const total = value.workers.reduce((sum, worker) => sum + worker.share_bp, 0);
    if (total !== BP_DENOMINATOR) {
      ctx.addIssue({
        code: "custom",
        path: ["workers"],
        message: `worker shares must sum to ${BP_DENOMINATOR} exactly, got ${total}`,
      });
    }
    const seen = new Set<string>();
    for (const worker of value.workers) {
      if (seen.has(worker.agent_id)) {
        ctx.addIssue({ code: "custom", path: ["workers"], message: `duplicate worker ${worker.agent_id}` });
      }
      seen.add(worker.agent_id);
    }
    const weights = value.acceptance_criteria.reduce((sum, c) => sum + c.weight_bp, 0);
    if (weights !== BP_DENOMINATOR) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptance_criteria"],
        message: `criterion weights must sum to ${BP_DENOMINATOR} exactly, got ${weights}`,
      });
    }
  });

/* ── evidence (SPEC §29) and deliverables (SPEC §30) ─────────────────────── */

export const evidenceItemSchema = z.strictObject({
  evidence_id: ID_SCHEMAS.evd,
  mandate_id: ID_SCHEMAS.mnd,
  worker_agent_id: ID_SCHEMAS.agt,
  type: z.enum([
    "github_commit",
    "github_pull_request",
    "source_repository",
    "test_output",
    "deployed_address",
    "transaction_hash",
    "document",
    "dataset",
    "screenshot",
    "other",
  ]),
  uri: evidenceUriSchema,
  content_hash: contentHashSchema,
  mime_type: z.string().min(3).max(128),
  description: z.string().min(1).max(2000),
  created_at_unix: unixSecondsSchema,
});

export const deliverablePayloadSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    deliverable_id: ID_SCHEMAS.dlv,
    mandate_id: ID_SCHEMAS.mnd,
    worker_agent_id: ID_SCHEMAS.agt,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(8000),
    /** Which mandate deliverable this satisfies, by index into `mandate.deliverables`. */
    satisfies_indices: z.array(z.number().int().min(0).max(31)).min(1).max(32),
    evidence: z.array(evidenceItemSchema).min(1).max(64),
    submitted_at_unix: unixSecondsSchema,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const item of value.evidence) {
      if (item.mandate_id !== value.mandate_id) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: `evidence ${item.evidence_id} belongs to mandate ${item.mandate_id}, not ${value.mandate_id}`,
        });
      }
      if (seen.has(item.evidence_id)) {
        ctx.addIssue({ code: "custom", path: ["evidence"], message: `duplicate evidence ${item.evidence_id}` });
      }
      seen.add(item.evidence_id);
    }
    const indices = new Set(value.satisfies_indices);
    if (indices.size !== value.satisfies_indices.length) {
      ctx.addIssue({
        code: "custom",
        path: ["satisfies_indices"],
        message: "satisfies_indices must not repeat an index",
      });
    }
  });

/* ── decision (docs/ARCHITECTURE.md §7) ──────────────────────────────────── */

/**
 * The only structure that crosses from GenLayer to Base. Pinned exactly, because
 * its content hash is what the escrow settles against.
 */
export const decisionPayloadSchema = z
  .strictObject({
    schema_version: schemaVersionSchema,
    decision_id: ID_SCHEMAS.dec,
    mandate_id: ID_SCHEMAS.mnd,
    verdict: z.enum(["FULL_ACCEPTANCE", "PARTIAL_ACCEPTANCE", "REJECTION"]),
    criteria_findings: z.array(criterionFindingSchema).min(1).max(32),
    release_bp: bpSchema,
    refund_bp: bpSchema,
    allocations: z.array(allocationSchema).max(16),
    adjudicated_at_unix: unixSecondsSchema,
    notes: z.string().max(8000),
  })
  .superRefine((value, ctx) => {
    if (value.release_bp + value.refund_bp !== BP_DENOMINATOR) {
      ctx.addIssue({
        code: "custom",
        path: ["release_bp"],
        message: `release_bp + refund_bp must equal ${BP_DENOMINATOR} exactly, got ${value.release_bp + value.refund_bp}`,
      });
    }

    // The escrow re-checks this; it does not trust the label to match the numbers.
    const expected =
      value.verdict === "FULL_ACCEPTANCE"
        ? value.release_bp === BP_DENOMINATOR
        : value.verdict === "REJECTION"
          ? value.release_bp === 0
          : value.release_bp > 0 && value.release_bp < BP_DENOMINATOR;
    if (!expected) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: `verdict ${value.verdict} disagrees with release_bp ${value.release_bp}`,
      });
    }

    if (value.allocations.length === 0) {
      if (value.release_bp !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: `release_bp is ${value.release_bp} but there are no allocations to pay`,
        });
      }
    } else {
      const total = value.allocations.reduce((sum, allocation) => sum + allocation.share_bp, 0);
      if (total !== BP_DENOMINATOR) {
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: `allocation shares must sum to ${BP_DENOMINATOR} exactly, got ${total}`,
        });
      }
      const seen = new Set<string>();
      for (const allocation of value.allocations) {
        if (seen.has(allocation.agent_id)) {
          ctx.addIssue({
            code: "custom",
            path: ["allocations"],
            message: `duplicate allocation for ${allocation.agent_id}`,
          });
        }
        seen.add(allocation.agent_id);
      }
    }

    const ids = new Set<string>();
    for (const finding of value.criteria_findings) {
      if (ids.has(finding.criterion_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria_findings"],
          message: `duplicate finding for criterion ${finding.criterion_id}`,
        });
      }
      ids.add(finding.criterion_id);
    }
  });

/* ── inferred types ──────────────────────────────────────────────────────── */

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type CriterionFinding = z.infer<typeof criterionFindingSchema>;
export type MissionPayload = z.infer<typeof missionPayloadSchema>;
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type MandatePayload = z.infer<typeof mandatePayloadSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type DeliverablePayload = z.infer<typeof deliverablePayloadSchema>;
export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;

/* ── validation helper ───────────────────────────────────────────────────── */

/**
 * Parses with a schema, converting a Zod failure into a `WrkError` carrying every
 * issue. Callers get one error type across the whole package rather than having
 * to know which validator rejected them.
 */
export function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "$";
      return `${path}: ${issue.message}`;
    });
    fail("SCHEMA_INVALID", `${label} failed validation: ${issues.join("; ")}`, {
      label,
      issues,
    });
  }
  return result.data;
}

export const parseMissionPayload = (value: unknown): MissionPayload =>
  validate(missionPayloadSchema, value, "mission payload");
export const parseProposalPayload = (value: unknown): ProposalPayload =>
  validate(proposalPayloadSchema, value, "proposal payload");
export const parseMandatePayload = (value: unknown): MandatePayload =>
  validate(mandatePayloadSchema, value, "mandate payload");
export const parseDeliverablePayload = (value: unknown): DeliverablePayload =>
  validate(deliverablePayloadSchema, value, "deliverable payload");
export const parseDecisionPayload = (value: unknown): DecisionPayload =>
  validate(decisionPayloadSchema, value, "decision payload");
