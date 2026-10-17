// leaf-1.4.4:G5 — the SDK targets one network explicitly, with no implicit default, so a
// caller cannot write to Bradbury while believing they are on Studionet.
import { WrkClient, SdkError, NETWORKS, WRITABLE_NETWORKS } from "../dist/index.js";
import { harness, stopAll, AGENTS, fail } from "./_harness.mjs";

const problems = [];
const { client, signers, stop, fetchImpl } = await harness();

try {
  // 1. There is no default: omitting the network is a construction error.
  for (const bad of [undefined, "", "mainnet", "STUDIONET", "studio"]) {
    let threw = false;
    try { new WrkClient({ baseUrl: "http://x", network: bad }); } catch (error) { threw = error instanceof SdkError; }
    if (!threw) problems.push(`the client accepted network ${JSON.stringify(bad)}`);
  }

  // 2. The network is fixed at construction, with no setter to change it underneath a
  //    caller holding the client.
  const api = client({ signer: signers.creator });
  if (api.network !== "studionet") problems.push(`network is ${api.network}`);
  const descriptor = Object.getOwnPropertyDescriptor(api, "network");
  if (descriptor && descriptor.writable === true) {
    problems.push("network is writable, so a caller's client can be retargeted");
  }
  if (typeof api.setNetwork === "function" || typeof api.useNetwork === "function") {
    problems.push("the client exposes a network setter");
  }

  // 3. Switching is explicit and produces a different client.
  const other = api.on("bradbury");
  if (other === api) problems.push("on() returned the same client");
  if (other.network !== "bradbury" || api.network !== "studionet") {
    problems.push("on() mutated the original client");
  }

  // 4. Every request carries the network in its URL.
  const urls = [];
  const sniffing = new WrkClient({
    baseUrl: "http://sdk.test", network: "bradbury", signer: signers.creator,
    fetch: async (url, init) => { urls.push(String(url)); return fetchImpl(url, init); },
  });
  await sniffing.agents().catch(() => {});
  await sniffing.openMission({ missionId: "msn_01JQ8Z000000000000000000M1", creatorAgentId: AGENTS.creator }).catch(() => {});
  for (const url of urls) {
    if (!url.includes("/v1/bradbury/")) problems.push(`a request from a bradbury client went to ${url}`);
  }
  if (urls.length < 2) problems.push("the sniffing client made no requests");

  // 5. A protocol write against a settlement chain is refused locally, with a message
  //    naming where to write instead.
  const onBase = client({ signer: signers.creator, network: "base-sepolia" });
  let refusal = null;
  try {
    await onBase.openMission({ missionId: "msn_01JQ8Z000000000000000000M1", creatorAgentId: AGENTS.creator });
  } catch (error) { refusal = error; }
  if (!(refusal instanceof SdkError)) problems.push("a protocol write to base-sepolia was not refused");
  else if (!/settlement chain/.test(refusal.message)) {
    problems.push(`the refusal did not explain why: ${refusal.message}`);
  }

  // Reads on a settlement chain are fine: settlements and payments live there.
  const settlements = await onBase.settlements();
  if (!Array.isArray(settlements.items)) problems.push("reads on base-sepolia were refused");

  // 6. The SDK's network list agrees with the API's.
  const meta = await api.meta();
  const missing = meta.networks.filter((name) => !NETWORKS.includes(name));
  const extra = NETWORKS.filter((name) => !meta.networks.includes(name));
  if (missing.length || extra.length) {
    problems.push(`network lists disagree: API has ${meta.networks.join(",")}, SDK has ${NETWORKS.join(",")}`);
  }

  // 7. Data from one network never arrives through a client for another.
  const studio = await api.agents();
  if (studio.network !== "studionet") problems.push(`a studionet client received ${studio.network} data`);
  const brad = await api.on("bradbury").agents();
  if (brad.network !== "bradbury") problems.push(`a bradbury client received ${brad.network} data`);

  if (problems.length === 0) {
    console.log(`SDK-NETWORK OK ${NETWORKS.length} network(s), no default and no setter, ${WRITABLE_NETWORKS.length} writable, every request carrying its network`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("SDK-NETWORK", problems);
