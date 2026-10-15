// A whole API, assembled against a real mongod and a recording chain writer.
//
// The writer records instead of sending. That is the right seam for these gates: they ask
// whether a write *produces a chain call* and *never touches Mongo*, and a recorder answers
// both while a live chain would only add flakiness. Whether the calls land is leaf-1.6.1's
// question, against real networks.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { Store } from "@wrk/indexer";
import { createApp } from "../dist/app.js";
import { ChainWrites } from "../dist/chain.js";
import { ReadModel } from "../dist/readmodel.js";
import { MemoryNonceLog, messageToSign } from "../dist/auth.js";
import { privateKeyToAccount } from "viem/accounts";

export const API = resolve(import.meta.dirname, "..");
export const REPO = resolve(API, "..", "..");

(function loadEnv() {
  const path = resolve(REPO, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const ADDR = (byte) => `0x${byte.repeat(20)}`;
export const DEPLOYMENTS = {
  studionet: { registry: ADDR("11"), work: ADDR("22"), adjudicator: ADDR("33"), reputation: ADDR("44") },
  bradbury: { registry: ADDR("55"), work: ADDR("66"), adjudicator: ADDR("77"), reputation: ADDR("88") },
};

export function ulid(prefix, tag) {
  const body = (`01JQ8Z${"0".repeat(20)}`).slice(0, 26 - tag.length) + tag;
  return `${prefix}_${body}`;
}

/** Two agents with real keys, so signatures are real signatures. */
export const KEYS = {
  creator: `0x${"11".repeat(32)}`,
  worker: `0x${"22".repeat(32)}`,
  stranger: `0x${"33".repeat(32)}`,
};
export const ACCOUNTS = {
  creator: privateKeyToAccount(KEYS.creator),
  worker: privateKeyToAccount(KEYS.worker),
  stranger: privateKeyToAccount(KEYS.stranger),
};
export const AGENTS = { creator: ulid("agt", "A1"), worker: ulid("agt", "A2") };

let server = null;

export async function harness({ mode = "relay", registry } = {}) {
  server ??= await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const config = { uri: server.getUri(), database: `wrk_api_${Math.random().toString(36).slice(2, 8)}` };
  const store = await Store.open(config);
  await store.ensureIndexes();

  const calls = [];
  const views = [];
  const directoryOf =
    registry ??
    {
      [ACCOUNTS.creator.address.toLowerCase()]: AGENTS.creator,
      [ACCOUNTS.worker.address.toLowerCase()]: AGENTS.worker,
    };

  const writer = {
    async send(input) {
      calls.push(input);
      return `0x${"ab".repeat(32)}`;
    },
    async view(input) {
      views.push(input);
      if (input.method === "agent_of_address") {
        return directoryOf[String(input.args[0]).toLowerCase()] ?? "";
      }
      return "";
    },
  };

  const writes = new ChainWrites({ mode, deployments: DEPLOYMENTS, writer });
  const app = createApp({
    reads: new ReadModel(store),
    writes,
    directory: writes.agentDirectory(),
    nonces: new MemoryNonceLog(),
    now: () => 1_800_000_000,
  });

  return {
    app,
    store,
    calls,
    views,
    async stop() {
      await store.close();
      const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5000 });
      try { await client.connect(); await client.db(config.database).dropDatabase(); } catch {}
      finally { await client.close().catch(() => {}); }
    },
  };
}

export async function stopAll() {
  await server?.stop();
  server = null;
}

let nonceCounter = 0;

/** Signs a write the way an agent would. */
export async function signed(account, { network, path, agentId, body, expiresAtUnix = 1_800_000_060, nonce }) {
  const chosen = nonce ?? `n${(nonceCounter += 1)}${Math.random().toString(36).slice(2, 10)}`;
  const message = messageToSign({ network, path, agentId, nonce: chosen, expiresAtUnix, body });
  const signature = await account.signMessage({ message });
  return { ...body, auth: { agent_id: agentId, nonce: chosen, expires_at_unix: expiresAtUnix, signature } };
}

export const post = (app, url, payload) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

export function fail(token, problems) {
  console.error(`${token} FAILED (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
