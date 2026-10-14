import { describe, expect, it } from "vitest";
import {
  canonicalize,
  contentHash,
  parseDecisionPayload,
  parseDeliverablePayload,
  parseMandatePayload,
  parseMissionPayload,
  parseProposalPayload,
  validate,
  atomicAmountSchema,
  unixSecondsSchema,
  evidenceUriSchema,
  idSchema,
} from "../src/index.js";
import type { DecisionPayload, MissionPayload } from "../src/index.js";

/* Valid sample payloads, built here rather than imported, so a schema change is
   visible as a diff in this file. Ids use real Crockford base32. */

const AGENT_A = "agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A";
const AGENT_B = "agt_01JQ8ZC1D2E3F4G5H6J7K8M9N0";
const DAO = "dao_01JQ8Z1A2B3C4D5E6F7G8H9J0K";
const MISSION = "msn_01JQ8Z3X9K2M4N6P8R0T2V4W6Y";
const MANDATE = "mnd_01JQ8ZA0B1C2D3E4F5G6H7J8K9";
const DECISION = "dec_01JQ8ZB1C2D3E4F5G6H7J8K9M0";
const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;

const mission = (): MissionPayload => ({
  schema_version: 1,
  mission_id: MISSION,
  dao_id: DAO,
  creator_agent_id: AGENT_A,
  title: "Ship a GenLayer settlement adapter",
  outcome_statement: "A deployed adapter that releases USDC only after finality.",
  acceptance_criteria: [
    { id: "ac_1", statement: "Adapter refuses a non-finalized decision.", weight_bp: 4000 },
    { id: "ac_2", statement: "Adapter is idempotent per decision_id.", weight_bp: 3500 },
    { id: "ac_3", statement: "Partial acceptance splits to the basis point.", weight_bp: 2500 },
  ],
  budget: { asset: "USDC", chain_id: 84_532, amount_atomic: "250000000", decimals: 6 },
  deadline_unix: 1_790_000_000,
  evidence_requirements: ["source_repository", "test_output", "deployed_address"],
  allow_teams: true,
  max_team_size: 3,
});

const decision = (): DecisionPayload => ({
  schema_version: 1,
  decision_id: DECISION,
  mandate_id: MANDATE,
  verdict: "PARTIAL_ACCEPTANCE",
  criteria_findings: [
    { criterion_id: "ac_1", met: true, confidence_bp: 9500, rationale: "Reverts on pending." },
    { criterion_id: "ac_2", met: true, confidence_bp: 9000, rationale: "Nonce map blocks replay." },
    { criterion_id: "ac_3", met: false, confidence_bp: 7000, rationale: "Rounds against payee." },
  ],
  release_bp: 7500,
  refund_bp: 2500,
  allocations: [
    { agent_id: AGENT_A, share_bp: 6000 },
    { agent_id: AGENT_B, share_bp: 4000 },
  ],
  adjudicated_at_unix: 1_790_001_234,
  notes: 'Rounding fixed in follow-up; "as-is" at deadline.',
});

describe("payload schemas", () => {
  describe("mission (SPEC §17)", () => {
    it("accepts a well-formed mission", () => {
      expect(parseMissionPayload(mission())).toEqual(mission());
    });

    it("requires criterion weights to sum to 10000", () => {
      const bad = mission();
      bad.acceptance_criteria[0]!.weight_bp = 3999;
      expect(() => parseMissionPayload(bad)).toThrow(/weights must sum to 10000/);
    });

    it("rejects duplicate criterion ids, which would make a finding ambiguous", () => {
      const bad = mission();
      bad.acceptance_criteria[1]!.id = "ac_1";
      expect(() => parseMissionPayload(bad)).toThrow(/duplicate criterion id/);
    });

    it("requires max_team_size of 1 when teams are not allowed", () => {
      expect(() => parseMissionPayload({ ...mission(), allow_teams: false })).toThrow(/max_team_size must be 1/);
      expect(() =>
        parseMissionPayload({ ...mission(), allow_teams: false, max_team_size: 1 }),
      ).not.toThrow();
    });

    it("rejects an unknown key rather than ignoring it", () => {
      // A silently-ignored field changes the hash the escrow settles against.
      expect(() => parseMissionPayload({ ...mission(), surprise: 1 })).toThrow(/SCHEMA_INVALID/);
    });

    it("rejects an id with an invalid Crockford character", () => {
      expect(() => parseMissionPayload({ ...mission(), creator_agent_id: "agt_01JQ8Z0Q1R2S3T4U5V6W7X8Y9Z" })).toThrow(
        /SCHEMA_INVALID/,
      );
    });

    it("rejects a budget amount sent as a number", () => {
      const bad = mission();
      expect(() =>
        parseMissionPayload({ ...bad, budget: { ...bad.budget, amount_atomic: 250_000_000 } }),
      ).toThrow(/SCHEMA_INVALID/);
    });

    it("canonicalises and hashes cleanly", () => {
      const canonical = canonicalize(mission());
      expect(canonical.startsWith('{"acceptance_criteria":')).toBe(true);
      expect(contentHash(mission())).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("decision (docs/ARCHITECTURE.md §7)", () => {
    it("accepts the pinned example", () => {
      expect(parseDecisionPayload(decision())).toEqual(decision());
    });

    it("requires release_bp + refund_bp == 10000", () => {
      expect(() => parseDecisionPayload({ ...decision(), refund_bp: 2400 })).toThrow(/must equal 10000/);
    });

    it("requires the verdict label to agree with the numbers", () => {
      expect(() => parseDecisionPayload({ ...decision(), verdict: "FULL_ACCEPTANCE" })).toThrow(/disagrees with/);
      expect(() => parseDecisionPayload({ ...decision(), verdict: "REJECTION" })).toThrow(/disagrees with/);
    });

    it("accepts a full acceptance and a rejection with matching numbers", () => {
      expect(() =>
        parseDecisionPayload({ ...decision(), verdict: "FULL_ACCEPTANCE", release_bp: 10_000, refund_bp: 0 }),
      ).not.toThrow();
      expect(() =>
        parseDecisionPayload({
          ...decision(),
          verdict: "REJECTION",
          release_bp: 0,
          refund_bp: 10_000,
          allocations: [],
        }),
      ).not.toThrow();
    });

    it("requires allocation shares to sum to 10000", () => {
      const bad = decision();
      bad.allocations[0]!.share_bp = 5999;
      expect(() => parseDecisionPayload(bad)).toThrow(/shares must sum to 10000/);
    });

    it("rejects a release with no allocations", () => {
      expect(() => parseDecisionPayload({ ...decision(), allocations: [] })).toThrow(/no allocations to pay/);
    });

    it("rejects a duplicated payee", () => {
      expect(() =>
        parseDecisionPayload({
          ...decision(),
          allocations: [
            { agent_id: AGENT_A, share_bp: 6000 },
            { agent_id: AGENT_A, share_bp: 4000 },
          ],
        }),
      ).toThrow(/duplicate allocation/);
    });

    it("rejects duplicate criterion findings", () => {
      const bad = decision();
      bad.criteria_findings[1]!.criterion_id = "ac_1";
      expect(() => parseDecisionPayload(bad)).toThrow(/duplicate finding/);
    });

    it("hashes to a stable digest — this is the value the escrow settles against", () => {
      expect(contentHash(decision())).toBe(contentHash(decision()));
      const reordered = { ...decision() };
      expect(contentHash(reordered)).toBe(contentHash(decision()));
    });
  });

  describe("proposal (SPEC §19)", () => {
    const proposal = {
      schema_version: 1 as const,
      proposal_id: "prp_01JQ8ZE1F2G3H4J5K6M7N8P9Q0",
      mission_id: MISSION,
      dao_id: DAO,
      agent_id: AGENT_A,
      capabilities: ["smart-contract-analysis", "coding"],
      proposed_strategy: "Build the adapter, then prove it refuses pending decisions.",
      execution_plan: ["Write the escrow", "Write the verifier", "Prove the negatives"],
      deliverables: ["WRKEscrow.sol", "WRKSettlementVerifier.sol"],
      evidence_plan: ["Source repository", "forge test output"],
      estimated_duration_seconds: 604_800,
      requested_budget: { asset: "USDC" as const, chain_id: 84_532, amount_atomic: "250000000", decimals: 6 },
      team_members: [
        { agent_id: AGENT_A, share_bp: 6000 },
        { agent_id: AGENT_B, share_bp: 4000 },
      ],
      submitted_at_unix: 1_789_000_000,
    };

    it("accepts a solo proposal with no team", () => {
      expect(() => parseProposalPayload({ ...proposal, team_members: [] })).not.toThrow();
    });

    it("requires team shares to sum to 10000 when a team is named", () => {
      expect(() =>
        parseProposalPayload({ ...proposal, team_members: [{ agent_id: AGENT_A, share_bp: 5000 }] }),
      ).toThrow(/team shares must sum to 10000/);
    });

    it("accepts the full sample", () => {
      expect(() => parseProposalPayload(proposal)).not.toThrow();
    });
  });

  describe("mandate (SPEC §25)", () => {
    const mandate = {
      schema_version: 1 as const,
      mandate_id: MANDATE,
      dao_id: DAO,
      mission_id: MISSION,
      creator_agent_id: AGENT_A,
      workers: [
        { agent_id: AGENT_A, share_bp: 6000 },
        { agent_id: AGENT_B, share_bp: 4000 },
      ],
      objective: "Deliver the settlement adapter.",
      deliverables: ["WRKEscrow.sol", "WRKSettlementVerifier.sol"],
      budget: { asset: "USDC" as const, chain_id: 84_532, amount_atomic: "250000000", decimals: 6 },
      deadline_unix: 1_790_000_000,
      acceptance_criteria: mission().acceptance_criteria,
      evidence_requirements: ["source_repository"],
      proposal_hash: HASH_A,
      selection_decision_hash: HASH_B,
      created_at_unix: 1_789_500_000,
    };

    it("accepts a well-formed mandate", () => {
      expect(() => parseMandatePayload(mandate)).not.toThrow();
    });

    it("requires at least one worker", () => {
      expect(() => parseMandatePayload({ ...mandate, workers: [] })).toThrow(/SCHEMA_INVALID/);
    });

    it("requires worker shares to sum to 10000", () => {
      expect(() =>
        parseMandatePayload({ ...mandate, workers: [{ agent_id: AGENT_A, share_bp: 9999 }] }),
      ).toThrow(/worker shares must sum to 10000/);
    });

    it("binds the mandate to the selected proposal and decision by hash", () => {
      expect(() => parseMandatePayload({ ...mandate, proposal_hash: "0xdead" })).toThrow(/SCHEMA_INVALID/);
      expect(() => parseMandatePayload({ ...mandate, selection_decision_hash: HASH_A.toUpperCase() })).toThrow(
        /SCHEMA_INVALID/,
      );
    });
  });

  describe("deliverable and evidence (SPEC §29, §30)", () => {
    const evidence = {
      evidence_id: "evd_01JQ8ZF1G2H3J4K5M6N7P8Q9R0",
      mandate_id: MANDATE,
      worker_agent_id: AGENT_A,
      type: "github_commit" as const,
      uri: "https://github.com/example/repo/commit/abc123",
      content_hash: HASH_A,
      mime_type: "text/plain",
      description: "Implementation of the requested module.",
      created_at_unix: 1_789_900_000,
    };
    const deliverable = {
      schema_version: 1 as const,
      deliverable_id: "dlv_01JQ8ZG1H2J3K4M5N6P7Q8R9S0",
      mandate_id: MANDATE,
      worker_agent_id: AGENT_A,
      title: "Escrow contract",
      summary: "WRKEscrow.sol with tests.",
      satisfies_indices: [0],
      evidence: [evidence],
      submitted_at_unix: 1_789_950_000,
    };

    it("accepts a well-formed deliverable", () => {
      expect(() => parseDeliverablePayload(deliverable)).not.toThrow();
    });

    it("rejects evidence belonging to another mandate", () => {
      expect(() =>
        parseDeliverablePayload({
          ...deliverable,
          evidence: [{ ...evidence, mandate_id: "mnd_01JQ8ZH1J2K3M4N5P6Q7R8S9T0" }],
        }),
      ).toThrow(/belongs to mandate/);
    });

    it("rejects duplicate evidence", () => {
      expect(() => parseDeliverablePayload({ ...deliverable, evidence: [evidence, evidence] })).toThrow(
        /duplicate evidence/,
      );
    });

    it("rejects a repeated satisfies index", () => {
      expect(() => parseDeliverablePayload({ ...deliverable, satisfies_indices: [0, 0] })).toThrow(
        /must not repeat an index/,
      );
    });

    it("requires https evidence URIs for the MVP", () => {
      expect(() =>
        parseDeliverablePayload({
          ...deliverable,
          evidence: [{ ...evidence, uri: "ipfs://QmSomething" }],
        }),
      ).toThrow(/SCHEMA_INVALID/);
    });
  });

  describe("primitives", () => {
    it("accepts only one spelling of an atomic amount", () => {
      expect(() => validate(atomicAmountSchema, "250000000", "amount")).not.toThrow();
      for (const bad of ["", "01", "-1", "1.0", "1e3"]) {
        expect(() => validate(atomicAmountSchema, bad, "amount")).toThrow(/SCHEMA_INVALID/);
      }
    });

    it("rejects a millisecond timestamp pasted into a seconds field", () => {
      expect(() => validate(unixSecondsSchema, 1_790_000_000, "ts")).not.toThrow();
      expect(() => validate(unixSecondsSchema, 1_790_000_000_000, "ts")).toThrow(/SCHEMA_INVALID/);
    });

    it("requires https evidence URIs", () => {
      expect(() => validate(evidenceUriSchema, "https://example.com/x", "uri")).not.toThrow();
      expect(() => validate(evidenceUriSchema, "http://example.com/x", "uri")).toThrow(/SCHEMA_INVALID/);
    });

    it("builds a per-prefix id schema", () => {
      expect(() => validate(idSchema("agt"), AGENT_A, "id")).not.toThrow();
      expect(() => validate(idSchema("agt"), MANDATE, "id")).toThrow(/SCHEMA_INVALID/);
    });
  });

  it("collects every base-level failure into one error", () => {
    try {
      parseDecisionPayload({ ...decision(), notes: 1, adjudicated_at_unix: "soon" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SCHEMA_INVALID");
      expect(message).toContain("notes");
      expect(message).toContain("adjudicated_at_unix");
    }
  });

  it("skips cross-field checks while the object is still malformed", () => {
    // Zod runs superRefine only after the base shape parses. That is the right order —
    // "release_bp + refund_bp" is meaningless if refund_bp is a string — but it means
    // a malformed payload reports its type errors first and its arithmetic errors on
    // the next attempt. Pinned so the two-pass behaviour is expected, not surprising.
    try {
      parseDecisionPayload({ ...decision(), refund_bp: 2400, notes: 1 });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("notes");
      expect(message).not.toContain("must equal 10000");
    }
    // With the type error fixed, the arithmetic error surfaces.
    expect(() => parseDecisionPayload({ ...decision(), refund_bp: 2400 })).toThrow(/must equal 10000/);
  });
});
