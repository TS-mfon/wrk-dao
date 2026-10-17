import { describe, expect, it } from "vitest";
import { WrkClient, SdkError, NotSignable, localSigner, toBytes32, fromBytes32, assertId, IdError, payloads, ID_PREFIXES } from "../src/index.js";
import { newId } from "@wrk/types";

const AGENT = "agt_01JQ8Z000000000000000000A1";
const KEY = `0x${"11".repeat(32)}`;

describe("ids", () => {
  it("round-trips every prefix", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(fromBytes32(toBytes32(id), prefix)).toBe(id);
    }
  });

  it("refuses a malformed id rather than padding it", () => {
    expect(() => toBytes32("agt_short")).toThrow(IdError);
    expect(() => assertId("nope", "agt", "agentId")).toThrow(/agentId must be a agt_/);
  });
});

describe("the signer", () => {
  it("keeps the key local and exposes only an address", () => {
    const signer = localSigner({ agentId: AGENT, privateKey: KEY });
    expect(signer.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(JSON.stringify(signer)).not.toContain("11111111");
  });

  it("refuses a malformed key", () => {
    expect(() => localSigner({ agentId: AGENT, privateKey: "0x1" })).toThrow(/64 hex/);
  });
});

describe("the client", () => {
  it("has no default network", () => {
    // @ts-expect-error deliberately omitting the network
    expect(() => new WrkClient({ baseUrl: "http://x" })).toThrow(SdkError);
  });

  it("refuses a write with no signer before touching the network", async () => {
    let touched = 0;
    const client = new WrkClient({
      baseUrl: "http://x",
      network: "studionet",
      fetch: async () => { touched += 1; return new Response("{}"); },
    });
    await expect(client.registerAgent({ agentId: AGENT, profile: {} })).rejects.toThrow(NotSignable);
    expect(touched).toBe(0);
  });

  it("refuses a protocol write to a settlement chain, and says where to write instead", async () => {
    const client = new WrkClient({
      baseUrl: "http://x",
      network: "base-sepolia",
      signer: localSigner({ agentId: AGENT, privateKey: KEY }),
      fetch: async () => new Response("{}"),
    });
    await expect(client.openMission({ missionId: newId("msn"), creatorAgentId: AGENT })).rejects.toThrow(
      /settlement chain; write to studionet or bradbury/,
    );
  });

  it("binds a signature to the endpoint template, not the concrete url", async () => {
    const seen: string[] = [];
    const client = new WrkClient({
      baseUrl: "http://x",
      network: "studionet",
      signer: { agentId: AGENT, async signMessage({ message }) { seen.push(message); return `0x${"1".repeat(130)}`; } },
      fetch: async () => new Response(JSON.stringify({ mode: "relay", tx_hash: "0x" }), { status: 202, headers: { "content-type": "application/json" } }),
    });
    const mission = newId("msn");
    await client.openMission({ missionId: mission, creatorAgentId: AGENT });
    // The template, so one signature authorises one endpoint rather than one url.
    expect(seen[0]).toContain("/v1/:network/missions/:missionId/open");
    expect(seen[0]).not.toContain(mission.toLowerCase() + "/open");
  });
});

describe("payload builders", () => {
  it("refuses criterion weights that do not sum to 10000", () => {
    expect(() => payloads.criteria([{ id: "c0", statement: "x", weightBp: 5000 }])).toThrow(/sum to 10000/);
  });

  it("keeps max_team_size consistent with allow_teams", () => {
    const solo = payloads.mission({
      missionId: newId("msn"), daoId: newId("dao"), creatorAgentId: AGENT, title: "t", outcomeStatement: "o",
      criteria: [{ id: "c0", statement: "x", weightBp: 10_000 }], budgetAtomic: "1", chainId: 84532,
      deadlineUnix: 1_900_000_000, evidenceRequirements: ["x"], allowTeams: false, maxTeamSize: 4,
    });
    expect(solo.max_team_size).toBe(1);
  });

  it("requires the proposer to be in its own team", () => {
    expect(() =>
      payloads.proposal({
        proposalId: newId("prp"), missionId: newId("msn"), daoId: newId("dao"), agentId: AGENT,
        capabilities: ["coding"], proposedStrategy: "s", executionPlan: ["a"], deliverables: ["d"],
        evidencePlan: ["e"], estimatedDurationSeconds: 60, requestedBudgetAtomic: "1", chainId: 84532,
        teamMembers: [{ agentId: newId("agt"), shareBp: 10_000 }],
      }),
    ).toThrow(/must appear in its own teamMembers/);
  });

  it("requires a deliverable to carry evidence", () => {
    expect(() =>
      payloads.deliverable({
        deliverableId: newId("dlv"), mandateId: newId("mnd"), workerAgentId: AGENT,
        title: "t", summary: "s", satisfiesIndices: [0], evidence: [],
      }),
    ).toThrow(/at least one piece of evidence/);
  });
});
