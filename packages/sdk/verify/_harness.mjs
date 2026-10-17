// A real API in-process, so the SDK is verified against the thing it wraps.
//
// Verifying a client against a mock server proves the client agrees with the mock. These
// gates stand the SDK up against `createApp` from @wrk/api with a real mongod behind it,
// so a shape disagreement between the two is what fails.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { Store } from "@wrk/indexer";
import { createApp } from "@wrk/api/dist/app.js";
import { ChainWrites } from "@wrk/api/dist/chain.js";
import { ReadModel } from "@wrk/api/dist/readmodel.js";
import { MemoryNonceLog } from "@wrk/api/dist/auth.js";
import { WrkClient, localSigner } from "../dist/index.js";

export const SDK = resolve(import.meta.dirname, "..");
export const REPO = resolve(SDK, "..", "..");

const ADDR = (b) => `0x${b.repeat(20)}`;
export const AGENTS = {
  creator: "agt_01JQ8Z000000000000000000A1",
  worker: "agt_01JQ8Z000000000000000000A2",
};
export const KEYS = { creator: `0x${"11".repeat(32)}`, worker: `0x${"22".repeat(32)}` };

let server = null;

export async function harness({ mode = "relay" } = {}) {
  server ??= await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const config = { uri: server.getUri(), database: `wrk_sdk_${Math.random().toString(36).slice(2, 8)}` };
  const store = await Store.open(config);
  await store.ensureIndexes();

  const creator = localSigner({ agentId: AGENTS.creator, privateKey: KEYS.creator });
  const worker = localSigner({ agentId: AGENTS.worker, privateKey: KEYS.worker });
  const directory = { [creator.address]: AGENTS.creator, [worker.address]: AGENTS.worker };

  const calls = [];
  const writer = {
    async send(input) { calls.push(input); return `0x${"ab".repeat(32)}`; },
    async view(input) {
      return input.method === "agent_of_address" ? (directory[String(input.args[0]).toLowerCase()] ?? "") : "";
    },
  };
  const writes = new ChainWrites({
    mode,
    deployments: {
      studionet: { registry: ADDR("11"), work: ADDR("22"), adjudicator: ADDR("33"), reputation: ADDR("44") },
      bradbury: { registry: ADDR("55"), work: ADDR("66"), adjudicator: ADDR("77"), reputation: ADDR("88") },
    },
    writer,
  });
  const app = createApp({
    reads: new ReadModel(store), writes, directory: writes.agentDirectory(), nonces: new MemoryNonceLog(),
  });

  // The SDK's fetch, pointed at the in-process app.
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    return app.request(url.replace("http://sdk.test", ""), init);
  };

  const client = (options = {}) =>
    new WrkClient({ baseUrl: "http://sdk.test", network: "studionet", fetch: fetchImpl, ...options });

  return {
    app, store, calls, client, signers: { creator, worker }, fetchImpl,
    async stop() {
      await store.close();
      const mongo = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5000 });
      try { await mongo.connect(); await mongo.db(config.database).dropDatabase(); } catch {}
      finally { await mongo.close().catch(() => {}); }
    },
  };
}

export async function stopAll() { await server?.stop(); server = null; }

export function fail(token, problems) {
  console.error(`${token} FAILED (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
