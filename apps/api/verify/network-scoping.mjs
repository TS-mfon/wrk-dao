// leaf-1.4.3:G6 — the network is explicit: a Studionet request never returns Bradbury
// data, and an unknown network is a 400.
//
// The gate exists because the owner asked for a UI network selector. The moment one API
// serves two chains, "which chain is this row from?" is a correctness question, and an
// endpoint that defaults silently renders one network's data under another's heading.

import { CHAINS } from "@wrk/indexer";
import { harness, stopAll, post, signed, ACCOUNTS, AGENTS, ulid, fail } from "./_harness.mjs";

const problems = [];
const { app, store, stop } = await harness();

const agentDoc = (tag, chain, operatorByte) => ({
  _id: ulid("agt", tag),
  agent_id: ulid("agt", tag),
  operator: `0x${operatorByte.repeat(20)}`,
  profile_hash: `0x${"11".repeat(32)}`,
  registered_at: 1800000000,
  capabilities: [],
  dao_ids: [],
  chain_ref: { chain, tx_hash: `0x${"1".repeat(64)}`, block: 3, log_index: 0, block_hash: `0x${"2".repeat(64)}` },
  seq: 3_000_000,
  updated_at: 3,
});

try {
  // One agent on each GenLayer network, plus one on Base Sepolia.
  await store.collection("agents").insertMany([
    agentDoc("S1", CHAINS.studionet.chainId, "a1"),
    agentDoc("B1", CHAINS.bradbury.chainId, "b1"),
    agentDoc("E1", CHAINS["base-sepolia"].chainId, "c1"),
  ]);

  for (const [network, expected] of [["studionet", "S1"], ["bradbury", "B1"], ["base-sepolia", "E1"]]) {
    const body = await (await app.request(`/v1/${network}/agents`)).json();
    const ids = body.items.map((item) => item.agent_id);
    if (ids.length !== 1 || ids[0] !== ulid("agt", expected)) {
      problems.push(`GET /v1/${network}/agents returned ${JSON.stringify(ids)}, expected only ${ulid("agt", expected)}`);
    }
    if (body.network !== network) problems.push(`${network} response labelled itself ${body.network}`);
    if (body.freshness?.chain !== CHAINS[network].chainId) {
      problems.push(`${network} reported freshness for chain ${body.freshness?.chain}`);
    }
  }

  // A single lookup is scoped too: the Bradbury agent must be invisible on Studionet.
  const crossLookup = await app.request(`/v1/studionet/agents/${ulid("agt", "B1")}`);
  if (crossLookup.status !== 404) {
    problems.push(`a Bradbury agent was readable on Studionet with status ${crossLookup.status}`);
  }

  // Unknown networks are 400, on reads and writes.
  for (const bogus of ["mainnet", "ethereum", "STUDIONET", "", "studionet2"]) {
    const read = await app.request(`/v1/${encodeURIComponent(bogus)}/agents`);
    if (read.status !== 400 && read.status !== 404) {
      problems.push(`GET with network ${JSON.stringify(bogus)} returned ${read.status}, expected 400`);
    }
  }
  const unknownWrite = await post(app, "/v1/mainnet/agents", { auth: {} });
  if (unknownWrite.status !== 400) {
    problems.push(`POST to an unknown network returned ${unknownWrite.status}, expected 400`);
  }

  // Writes against a settlement chain are refused: the ICs live on GenLayer.
  const body = { agent_id: AGENTS.creator, profile: '{"a":1}' };
  const payload = await signed(ACCOUNTS.creator, {
    network: "base-sepolia", path: "/v1/:network/agents", agentId: AGENTS.creator, body,
  });
  const onBase = await post(app, "/v1/base-sepolia/agents", payload);
  if (onBase.status !== 400) {
    problems.push(`a protocol write against base-sepolia returned ${onBase.status}, expected 400`);
  }

  // Health is per network, so one stalled indexer cannot hide behind another's progress.
  const studio = await (await app.request("/v1/studionet/health")).json();
  const brad = await (await app.request("/v1/bradbury/health")).json();
  if (studio.agents !== 1 || brad.agents !== 1) {
    problems.push(`per-network health leaked: studionet ${studio.agents}, bradbury ${brad.agents}`);
  }
  if (studio.freshness?.network !== "studionet") problems.push("health did not name its network");

  if (problems.length === 0) {
    console.log(`API-NETWORK-SCOPING OK 3 network(s) each return only their own rows, 6 unknown-network requests refused with 400`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-NETWORK-SCOPING", problems);
