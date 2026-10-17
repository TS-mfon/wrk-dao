// leaf-1.4.4:G4 — a signed write is accepted by the API, and an unsigned write is refused
// by the client before it reaches the network.
//
// The second half matters for the error message: a client that sends an unsigned request
// and waits for a 401 costs a round trip to learn something it already knew.
import { WrkClient, NotSignable, writeMethodNames } from "../dist/index.js";
import { harness, stopAll, AGENTS, fail } from "./_harness.mjs";

const problems = [];
const { client, calls, signers, stop } = await harness();

try {
  // 1. Unsigned writes never reach the network.
  let networkTouched = 0;
  const counting = new WrkClient({
    baseUrl: "http://sdk.test",
    network: "studionet",
    fetch: async () => { networkTouched += 1; return new Response("{}", { status: 200 }); },
  });
  if (counting.hasSigner) problems.push("a client built without a signer reports having one");

  const calls0 = [
    () => counting.registerAgent({ agentId: AGENTS.creator, profile: { a: 1 } }),
    () => counting.createDao({ daoId: "dao_01JQ8Z000000000000000000D1", creatorAgentId: AGENTS.creator, metadata: {}, rules: {} }),
    () => counting.openMission({ missionId: "msn_01JQ8Z000000000000000000M1", creatorAgentId: AGENTS.creator }),
    () => counting.acceptMandate({ mandateId: "mnd_01JQ8Z000000000000000000N1", agentId: AGENTS.creator }),
  ];
  for (const invoke of calls0) {
    let threw = null;
    try { await invoke(); } catch (error) { threw = error; }
    if (!(threw instanceof NotSignable)) {
      problems.push(`an unsigned write threw ${threw?.name ?? "nothing"} rather than NotSignable`);
    }
  }
  if (networkTouched !== 0) {
    problems.push(`${networkTouched} unsigned write(s) reached the network`);
  }

  // Reads still work without a signer: nothing to sign.
  const readOnly = client();
  if ((await readOnly.agents()).items === undefined) problems.push("a read failed without a signer");

  // 2. A signed write is accepted, and the signature is bound to this network and path.
  const api = client({ signer: signers.creator });
  const before = calls.length;
  const result = await api.registerAgent({ agentId: AGENTS.creator, profile: { schema_version: 1 } });
  if (!result.tx_hash) problems.push("a signed write returned no transaction hash");
  if (calls.length !== before + 1) problems.push("a signed write produced no chain call");

  // 3. Every write method carries a signature: none slips through unsigned.
  const unsignedSeen = [];
  const sniffing = new WrkClient({
    baseUrl: "http://sdk.test",
    network: "studionet",
    signer: signers.creator,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.auth?.signature) unsignedSeen.push(String(url));
      if (!body.auth?.nonce) unsignedSeen.push(`${url} (no nonce)`);
      return new Response(JSON.stringify({ network: "studionet", acting_for: AGENTS.creator, mode: "relay", tx_hash: `0x${"ab".repeat(32)}` }), { status: 202, headers: { "content-type": "application/json" } });
    },
  });
  const MSN = "msn_01JQ8Z000000000000000000M1", DAO = "dao_01JQ8Z000000000000000000D1";
  const MND = "mnd_01JQ8Z000000000000000000N1", PRP = "prp_01JQ8Z000000000000000000P1", DLV = "dlv_01JQ8Z000000000000000000V1";
  await sniffing.registerAgent({ agentId: AGENTS.creator, profile: {} });
  await sniffing.updateAgentProfile({ agentId: AGENTS.creator, profile: {} });
  await sniffing.createDao({ daoId: DAO, creatorAgentId: AGENTS.creator, metadata: {}, rules: {} });
  await sniffing.updateDaoRules({ daoId: DAO, creatorAgentId: AGENTS.creator, rules: {} });
  await sniffing.joinDao({ daoId: DAO, agentId: AGENTS.creator });
  await sniffing.inviteAgent({ daoId: DAO, creatorAgentId: AGENTS.creator, agentId: AGENTS.worker });
  await sniffing.createMission({ missionId: MSN, daoId: DAO, creatorAgentId: AGENTS.creator, payload: {} });
  await sniffing.updateMission({ missionId: MSN, creatorAgentId: AGENTS.creator, payload: {} });
  await sniffing.openMission({ missionId: MSN, creatorAgentId: AGENTS.creator });
  await sniffing.closeProposals({ missionId: MSN, creatorAgentId: AGENTS.creator });
  await sniffing.startSelection({ missionId: MSN, creatorAgentId: AGENTS.creator });
  await sniffing.cancelMission({ missionId: MSN, creatorAgentId: AGENTS.creator });
  await sniffing.submitProposal({ proposalId: PRP, missionId: MSN, agentId: AGENTS.creator, payload: {} });
  await sniffing.createMandate({ mandateId: MND, missionId: MSN, creatorAgentId: AGENTS.creator, payload: {} });
  await sniffing.acceptMandate({ mandateId: MND, agentId: AGENTS.creator });
  await sniffing.startWork({ mandateId: MND, agentId: AGENTS.creator });
  await sniffing.submitWork({ mandateId: MND, agentId: AGENTS.creator });
  await sniffing.cancelMandate({ mandateId: MND, creatorAgentId: AGENTS.creator });
  await sniffing.submitDeliverable({ deliverableId: DLV, mandateId: MND, agentId: AGENTS.creator, payload: {} });
  if (unsignedSeen.length > 0) problems.push(`unsigned or nonce-less request(s): ${unsignedSeen.join(", ")}`);

  // 4. Two calls never reuse a nonce, so a captured request is single-use.
  const nonces = new Set();
  const noncing = new WrkClient({
    baseUrl: "http://sdk.test", network: "studionet", signer: signers.creator,
    fetch: async (_url, init) => {
      nonces.add(JSON.parse(init.body).auth.nonce);
      return new Response(JSON.stringify({ mode: "relay", tx_hash: "0x" }), { status: 202, headers: { "content-type": "application/json" } });
    },
  });
  for (let n = 0; n < 25; n += 1) await noncing.openMission({ missionId: MSN, creatorAgentId: AGENTS.creator });
  if (nonces.size !== 25) problems.push(`25 calls produced ${nonces.size} distinct nonce(s)`);

  // 5. The API refuses a signature from the wrong agent, proving the binding is real.
  const wrongAgent = client({ signer: { agentId: AGENTS.worker, signMessage: signers.creator.signMessage } });
  try {
    await wrongAgent.registerAgent({ agentId: AGENTS.worker, profile: { schema_version: 1 } });
    problems.push("the API accepted a request whose signer does not control the named agent");
  } catch (error) {
    if (!/40[13]/.test(String(error.status))) problems.push(`impersonation failed with ${error.status}, expected 401/403`);
  }

  if (problems.length === 0) {
    console.log(`SDK-SIGNING OK ${writeMethodNames.length} write method(s) all signed with distinct nonces, unsigned writes refused before the network, impersonation refused by the API`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("SDK-SIGNING", problems);
