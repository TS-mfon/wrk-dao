import { afterAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { privateKeyToAccount } from "viem/accounts";
import { Store } from "@wrk/indexer";
import { createApp } from "../src/app.js";
import { ChainWrites } from "../src/chain.js";
import { ReadModel } from "../src/readmodel.js";
import { MemoryNonceLog, authenticate, messageToSign, signedEnvelopeSchema } from "../src/auth.js";
import { resolveNetwork, resolveWritableNetwork, UnknownNetwork } from "../src/networks.js";

let server: MongoMemoryReplSet | null = null;
afterAll(async () => {
  await server?.stop();
  server = null;
});

const ADDR = (byte: string) => `0x${byte.repeat(20)}`;
const AGENT = "agt_01JQ8Z000000000000000000A1";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

async function app(mode: "relay" | "prepare" = "relay") {
  server ??= await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const store = await Store.open({ uri: server.getUri(), database: `t${Math.random().toString(36).slice(2, 8)}` });
  await store.ensureIndexes();
  const calls: unknown[] = [];
  const writer = {
    async send(input: unknown) { calls.push(input); return `0x${"ab".repeat(32)}`; },
    async view(input: { method: string; args: readonly unknown[] }) {
      return input.method === "agent_of_address" && String(input.args[0]).toLowerCase() === account.address.toLowerCase()
        ? AGENT
        : "";
    },
  };
  const writes = new ChainWrites({
    mode,
    deployments: { studionet: { registry: ADDR("11"), work: ADDR("22"), adjudicator: ADDR("33"), reputation: ADDR("44") } },
    writer,
  });
  return {
    instance: createApp({ reads: new ReadModel(store), writes, directory: writes.agentDirectory(), nonces: new MemoryNonceLog(), now: () => 1_800_000_000 }),
    store, calls,
    close: () => store.close(),
  };
}

async function sign(body: unknown, overrides: Partial<{ network: string; path: string; agentId: string; nonce: string; expiresAtUnix: number }> = {}) {
  const input = {
    network: overrides.network ?? "studionet",
    path: overrides.path ?? "/v1/:network/agents",
    agentId: overrides.agentId ?? AGENT,
    nonce: overrides.nonce ?? `n${Math.random().toString(36).slice(2, 12)}`,
    expiresAtUnix: overrides.expiresAtUnix ?? 1_800_000_060,
    body,
  };
  const signature = await account.signMessage({ message: messageToSign(input) });
  return { ...(body as object), auth: { agent_id: input.agentId, nonce: input.nonce, expires_at_unix: input.expiresAtUnix, signature } };
}

describe("network resolution", () => {
  it("has no default", () => {
    expect(() => resolveNetwork(undefined)).toThrow(UnknownNetwork);
    expect(() => resolveNetwork("mainnet")).toThrow(/unknown network/);
  });

  it("refuses a protocol write against a settlement chain", () => {
    // The Intelligent Contracts live on GenLayer; a write to Base would have no target.
    expect(() => resolveWritableNetwork("base-sepolia")).toThrow(/settlement chain/);
    expect(resolveWritableNetwork("studionet").chainId).toBe(61999);
  });
});

describe("the signed envelope", () => {
  it("binds a signature to one network and one path", () => {
    const a = messageToSign({ network: "studionet", path: "/p", agentId: AGENT, nonce: "n1", expiresAtUnix: 1, body: {} });
    const b = messageToSign({ network: "bradbury", path: "/p", agentId: AGENT, nonce: "n1", expiresAtUnix: 1, body: {} });
    const c = messageToSign({ network: "studionet", path: "/q", agentId: AGENT, nonce: "n1", expiresAtUnix: 1, body: {} });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("refuses a malformed signature at the schema", () => {
    expect(signedEnvelopeSchema.safeParse({ agent_id: AGENT, nonce: "n1234567", expires_at_unix: 1, signature: "0xshort" }).success).toBe(false);
  });

  it("refuses a signature valid for longer than the ceiling", async () => {
    await expect(
      authenticate({
        network: "studionet", path: "/p", body: {},
        envelope: { agent_id: AGENT, nonce: "nonce1234", expires_at_unix: 1_800_999_999, signature: `0x${"1".repeat(130)}` },
        directory: { async agentOfAddress() { return AGENT; } },
        nonces: new MemoryNonceLog(), now: 1_800_000_000,
      }),
    ).rejects.toThrow(/more than 300s ahead/);
  });
});

describe("the API", () => {
  it("reports its own surface", async () => {
    const { instance, close } = await app();
    try {
      const meta = await (await instance.request("/v1/meta")).json();
      expect(meta.protocol).toBe("wrk-dao");
      expect(meta.networks).toContain("studionet");
      expect(meta.write_mode).toBe("relay");
      expect(meta.writes.length).toBeGreaterThan(15);
    } finally { await close(); }
  });

  it("accepts a correctly signed write and turns it into a chain call", async () => {
    const { instance, calls, close } = await app();
    try {
      const payload = await sign({ agent_id: AGENT, profile: '{"a":1}' });
      const response = await instance.request("/v1/studionet/agents", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.acting_for).toBe(AGENT);
      expect(calls).toHaveLength(1);
    } finally { await close(); }
  });

  it("returns calldata and sends nothing in prepare mode", async () => {
    const { instance, calls, close } = await app("prepare");
    try {
      const payload = await sign({ agent_id: AGENT, profile: '{"a":1}' });
      const body = await (await instance.request("/v1/studionet/agents", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      })).json();
      expect(body.mode).toBe("prepare");
      expect(body.tx_hash).toBeUndefined();
      expect(body.prepared.method).toBe("register_agent");
      expect(calls).toHaveLength(0);
    } finally { await close(); }
  });

  it("never answers an unconfigured network with a 500", async () => {
    const { instance, close } = await app();
    try {
      const response = await instance.request("/v1/bradbury/agents", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(await sign({ agent_id: AGENT, profile: '{"a":1}' }, { network: "bradbury" })),
      });
      // bradbury is a real network with no deployment configured here, so its registry
      // reports that nobody controls any agent and authentication fails first: 403. That
      // is the right answer and the right order — the caller is told their authority does
      // not hold on this network rather than being handed a 500 that reads as "retry".
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "unauthorized" });

      // The property that actually matters across every misconfiguration: never a 500.
      for (const path of ["/v1/bradbury/agents", "/v1/studionet/agents"]) {
        const probe = await instance.request(path, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        expect(probe.status).toBeLessThan(500);
      }
    } finally { await close(); }
  });

  it("serves settlement windows with an overdue flag", async () => {
    const { instance, store, close } = await app();
    try {
      await store.collection("settlements").insertOne({
        _id: `0x${"77".repeat(32)}`, settlement_id: `0x${"91".repeat(32)}`, mandate_id: `0x${"77".repeat(32)}`,
        state: "POSTED", decision_hash: `0x${"81".repeat(32)}`, release_bp: 6000, refund_bp: 4000,
        deposited_atomic: "1000000", released_atomic: null, refunded_atomic: null,
        posted_at_unix: 1_799_999_000, executable_at_unix: 1_799_999_900, executed_at_unix: 0, challenged: false,
        chain_ref: { chain: 61999, tx_hash: `0x${"1".repeat(64)}`, block: 2, log_index: 0, block_hash: `0x${"2".repeat(64)}` },
        seq: 2_000_000, updated_at: 2,
      } as never);
      const body = await (await instance.request("/v1/studionet/settlement-windows")).json();
      expect(body.items).toHaveLength(1);
      // A keeper is best-effort and cron can be delayed, so overdue must be visible.
      expect(body.items[0].overdue).toBe(true);
      expect(body.items[0].seconds_until_executable).toBeLessThan(0);
    } finally { await close(); }
  });
});
