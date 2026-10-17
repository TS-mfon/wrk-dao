// leaf-1.4.4:G2 — every API endpoint has a typed SDK method, and a method whose shape
// disagrees with the API's schema is a failure.
//
// Checked by calling them. A name-matching check would pass a method that sent the wrong
// field names, which is exactly the disagreement that matters.
import { WRITE_ENDPOINTS } from "@wrk/api/dist/writes.js";
import { writeMethodNames, payloads } from "../dist/index.js";
import { harness, stopAll, AGENTS, fail } from "./_harness.mjs";

const problems = [];
const { client, calls, signers, stop } = await harness();

try {
  const api = client({ signer: signers.creator });
  const meta = await api.meta();

  // 1. One SDK write method per API write endpoint.
  if (writeMethodNames.length !== WRITE_ENDPOINTS.length) {
    problems.push(`the API has ${WRITE_ENDPOINTS.length} write endpoint(s), the SDK names ${writeMethodNames.length}`);
  }
  for (const name of writeMethodNames) {
    if (typeof api[name] !== "function") problems.push(`the SDK does not implement ${name}()`);
  }

  // 2. One SDK reader per API read collection.
  for (const collection of meta.reads) {
    const method = collection.replace(/_(.)/g, (_, c) => c.toUpperCase());
    if (typeof api[method] !== "function" && typeof api.list !== "function") {
      problems.push(`no SDK reader for ${collection}`);
    }
    const page = await api.list(collection);
    if (!Array.isArray(page.items)) problems.push(`list("${collection}") returned no items`);
    if (!page.freshness) problems.push(`list("${collection}") dropped freshness`);
  }

  // 3. Every write method actually reaches its endpoint and is accepted. A shape
  //    disagreement shows up as a 400 from the API's own Zod schema.
  const MSN = "msn_01JQ8Z000000000000000000M1";
  const DAO = "dao_01JQ8Z000000000000000000D1";
  const PRP = "prp_01JQ8Z000000000000000000P1";
  const MND = "mnd_01JQ8Z000000000000000000N1";
  const DLV = "dlv_01JQ8Z000000000000000000V1";
  const crit = [{ id: "c0", statement: "It works.", weightBp: 10_000 }];
  const hash = `0x${"ab".repeat(32)}`;

  const invocations = {
    registerAgent: () => api.registerAgent({ agentId: AGENTS.creator, profile: payloads.agentProfile({ agentId: AGENTS.creator, name: "A", operator: `0x${"a1".repeat(20)}`, capabilities: [{ capabilityId: "coding", name: "coding", description: "d", version: "1", evidence: "https://e.com/x" }] }) }),
    updateAgentProfile: () => api.updateAgentProfile({ agentId: AGENTS.creator, profile: { schema_version: 1 } }),
    createDao: () => api.createDao({ daoId: DAO, creatorAgentId: AGENTS.creator, metadata: { a: 1 }, rules: { a: 1 } }),
    updateDaoRules: () => api.updateDaoRules({ daoId: DAO, creatorAgentId: AGENTS.creator, rules: { a: 1 } }),
    joinDao: () => api.joinDao({ daoId: DAO, agentId: AGENTS.creator }),
    inviteAgent: () => api.inviteAgent({ daoId: DAO, creatorAgentId: AGENTS.creator, agentId: AGENTS.worker }),
    createMission: () => api.createMission({ missionId: MSN, daoId: DAO, creatorAgentId: AGENTS.creator, payload: { a: 1 } }),
    updateMission: () => api.updateMission({ missionId: MSN, creatorAgentId: AGENTS.creator, payload: { a: 1 } }),
    openMission: () => api.openMission({ missionId: MSN, creatorAgentId: AGENTS.creator }),
    closeProposals: () => api.closeProposals({ missionId: MSN, creatorAgentId: AGENTS.creator }),
    startSelection: () => api.startSelection({ missionId: MSN, creatorAgentId: AGENTS.creator }),
    cancelMission: () => api.cancelMission({ missionId: MSN, creatorAgentId: AGENTS.creator }),
    submitProposal: () => api.submitProposal({ proposalId: PRP, missionId: MSN, agentId: AGENTS.creator, payload: { a: 1 } }),
    createMandate: () => api.createMandate({ mandateId: MND, missionId: MSN, creatorAgentId: AGENTS.creator, payload: { a: 1 } }),
    acceptMandate: () => api.acceptMandate({ mandateId: MND, agentId: AGENTS.creator }),
    startWork: () => api.startWork({ mandateId: MND, agentId: AGENTS.creator }),
    submitWork: () => api.submitWork({ mandateId: MND, agentId: AGENTS.creator }),
    cancelMandate: () => api.cancelMandate({ mandateId: MND, creatorAgentId: AGENTS.creator }),
    submitDeliverable: () => api.submitDeliverable({ deliverableId: DLV, mandateId: MND, agentId: AGENTS.creator, payload: { a: 1 } }),
  };

  const uninvoked = writeMethodNames.filter((name) => !(name in invocations));
  if (uninvoked.length > 0) problems.push(`no invocation written for ${uninvoked.join(", ")}`);

  for (const [name, invoke] of Object.entries(invocations)) {
    try {
      const result = await invoke();
      if (!result?.tx_hash) problems.push(`${name}() returned no transaction hash`);
    } catch (error) {
      problems.push(`${name}() was rejected: ${error.message}`);
    }
  }

  if (calls.length !== Object.keys(invocations).length) {
    problems.push(`${Object.keys(invocations).length} SDK calls produced ${calls.length} chain call(s)`);
  }

  // 4. A payload builder that would produce an invalid shape must refuse locally.
  try {
    payloads.criteria([{ id: "c0", statement: "x", weightBp: 9000 }]);
    problems.push("criteria() accepted weights that do not sum to 10000");
  } catch {}
  try {
    payloads.mission({ missionId: MSN, daoId: DAO, creatorAgentId: AGENTS.creator, title: "t", outcomeStatement: "o", criteria: crit, budgetAtomic: "1", chainId: 84532, deadlineUnix: 1900000000, evidenceRequirements: ["x"], allowTeams: false, maxTeamSize: 5 });
  } catch (error) {
    problems.push(`mission() threw on a valid input: ${error.message}`);
  }
  const solo = payloads.mission({ missionId: MSN, daoId: DAO, creatorAgentId: AGENTS.creator, title: "t", outcomeStatement: "o", criteria: crit, budgetAtomic: "1", chainId: 84532, deadlineUnix: 1900000000, evidenceRequirements: ["x"], allowTeams: false, maxTeamSize: 5 });
  if (solo.max_team_size !== 1) {
    problems.push("mission() allowed max_team_size > 1 with allow_teams false, which the contract refuses");
  }

  if (problems.length === 0) {
    console.log(`SDK-COVERAGE OK ${writeMethodNames.length} write method(s) each accepted by the API, ${meta.reads.length} read collection(s) readable`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("SDK-COVERAGE", problems);
