// leaf-1.4.3:G3 — writes go to chain, and no write endpoint mutates MongoDB.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { WRITE_ENDPOINTS } from "../dist/writes.js";
import { harness, stopAll, post, signed, ACCOUNTS, AGENTS, fail, API } from "./_harness.mjs";

const problems = [];
const { app, store, calls, stop } = await harness({ mode: "relay" });

function bodyFor(endpoint, agent) {
  const values = {
    agent_id: agent, creator_agent_id: agent,
    dao_id: "dao_01JQ8Z000000000000000000D1", mission_id: "msn_01JQ8Z000000000000000000M1",
    proposal_id: "prp_01JQ8Z000000000000000000P1", mandate_id: "mnd_01JQ8Z000000000000000000N1",
    deliverable_id: "dlv_01JQ8Z000000000000000000V1",
    profile: '{"a":1}', metadata: '{"a":1}', rules: '{"a":1}', payload: '{"a":1}',
  };
  const body = {};
  for (const key of Object.keys(endpoint.schema.shape ?? {})) body[key] = values[key];
  return endpoint.schema.parse(body);
}

try {
  // The read model must be untouched by writes. Counted before and after.
  const collections = ["agents", "daos", "missions", "proposals", "mandates", "deliverables", "evidence", "decisions", "settlements", "payments", "reputation", "memberships"];
  const before = {};
  for (const name of collections) before[name] = await store.count(name);

  for (const endpoint of WRITE_ENDPOINTS) {
    const body = bodyFor(endpoint, AGENTS.creator);
    const payload = await signed(ACCOUNTS.creator, {
      network: "studionet", path: `/v1/:network${endpoint.path}`, agentId: endpoint.actsFor(body), body,
    });
    const url = `/v1/studionet${endpoint.path.replace(/:[A-Za-z]+/g, "x")}`;
    const response = await post(app, url, payload);
    if (response.status !== 202) {
      problems.push(`${endpoint.path}: returned ${response.status}, so it produced no chain call`);
      continue;
    }
    const json = await response.json();
    if (json.mode !== "relay" || !json.tx_hash) {
      problems.push(`${endpoint.path}: answered 202 without a transaction hash`);
    }
  }

  if (calls.length !== WRITE_ENDPOINTS.length) {
    problems.push(`${WRITE_ENDPOINTS.length} writes produced ${calls.length} chain call(s)`);
  }
  for (const call of calls) {
    if (!call.address || !call.call?.method) problems.push(`a chain call had no address or method`);
    if (!call.operator) problems.push(`a chain call was sent with no operator`);
  }

  for (const name of collections) {
    const after = await store.count(name);
    if (after !== before[name]) {
      problems.push(`${name} changed from ${before[name]} to ${after}: a write touched the read model`);
    }
  }

  // Structural: the write path must not be able to reach the store at all.
  //
  // Checked on IMPORTS rather than on text. Both modules discuss the read model in prose
  // -- explaining that they must not touch it -- and a substring search would flag the
  // explanation while missing an import written as `import * as m from "@wrk/indexer"`.
  for (const file of ["dist/writes.js", "dist/chain.js"]) {
    const source = readFileSync(resolve(API, file), "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const dynamic = [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    for (const specifier of [...specifiers, ...dynamic]) {
      if (/@wrk\/indexer|mongodb/.test(specifier)) {
        problems.push(`${file} imports ${specifier}; a write path that can reach the read model eventually will`);
      }
    }
  }

  // prepare mode must not send anything.
  const prepared = await harness({ mode: "prepare" });
  try {
    const endpoint = WRITE_ENDPOINTS[0];
    const body = bodyFor(endpoint, AGENTS.creator);
    const payload = await signed(ACCOUNTS.creator, {
      network: "studionet", path: `/v1/:network${endpoint.path}`, agentId: endpoint.actsFor(body), body,
    });
    const response = await post(prepared.app, "/v1/studionet/agents", payload);
    const json = await response.json();
    if (json.mode !== "prepare" || json.tx_hash) {
      problems.push("prepare mode returned a transaction hash, which a caller would read as sent");
    }
    if (!json.prepared?.address || !json.prepared?.method) {
      problems.push("prepare mode returned no calldata for the agent to sign");
    }
    if (prepared.calls.length !== 0) problems.push("prepare mode sent a transaction");
  } finally {
    await prepared.stop();
  }

  if (problems.length === 0) {
    console.log(`API-WRITES-TO-CHAIN OK ${calls.length} write(s) produced ${calls.length} chain call(s), read model unchanged, prepare mode sent nothing`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-WRITES-TO-CHAIN", problems);
