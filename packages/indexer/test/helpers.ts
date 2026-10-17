import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store, type MongoConfig } from "../src/index.js";
import { canonicalize, contentHash } from "@wrk/types";

let server: MongoMemoryReplSet | null = null;

/** One real mongod for the whole file, torn down after. */
export async function startMongo(): Promise<string> {
  server ??= await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  return server.getUri();
}

export async function stopMongo(): Promise<void> {
  await server?.stop();
  server = null;
}

export async function freshStore(label: string): Promise<{ store: Store; config: MongoConfig }> {
  const uri = await startMongo();
  const config = { uri, database: `wrk_test_${label}_${Math.random().toString(36).slice(2, 8)}` };
  const store = await Store.open(config);
  await store.ensureIndexes();
  return { store, config };
}

export const HASH = (byte: string): string => `0x${byte.repeat(32)}`;

export function profileFields(agentId: string, operator: string) {
  const value = { schema_version: 1, agent_id: agentId, operator, name: "Test agent", capabilities: [] };
  return { profile: canonicalize(value), profile_hash: contentHash(value) };
}

export function ulid(prefix: string, tag: string): string {
  const body = (`01JQ8Z${"0".repeat(20)}`).slice(0, 26 - tag.length) + tag;
  return `${prefix}_${body}`;
}

export const ref = (block: number, logIndex = 0, chain = 61999, nonce = "a") => ({
  chain,
  tx_hash: `0x${`${nonce}`.repeat(1).padEnd(2, "0").repeat(32)}`.slice(0, 66),
  block,
  log_index: logIndex,
  block_hash: `0x${`${block}`.padStart(2, "0").repeat(32)}`.slice(0, 66),
});

/**
 * A distinct operator address per agent id.
 *
 * One operator controls exactly one agent — `wrk_registry` enforces it, and the read
 * model carries a unique index so it cannot even represent a violation. A fixture that
 * reuses an address therefore fails on the index rather than on what it meant to test,
 * so the address is derived from the id.
 */
export function operatorFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `0x${hash.toString(16).padStart(8, "0").repeat(5)}`.slice(0, 42);
}
