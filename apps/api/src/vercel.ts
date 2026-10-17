import { Store, mongoConfigFromEnv, indexOnce, GenLayerSource, BaseSource, chainConfig, type ChainName, type ChainSource } from "@wrk/indexer";
import { createApp } from "./app.js";
import { ChainWrites, deploymentSchema, type Deployment, type WriteMode } from "./chain.js";
import { GenLayerJsWriter } from "./genlayer-writer.js";
import { MongoNonceLog } from "./nonces.js";
import { ReadModel } from "./readmodel.js";
import { GENLAYER_NETWORKS } from "./networks.js";
import { randomUUID } from "node:crypto";

let appPromise: ReturnType<typeof buildApp> | undefined;

function deployments(): Record<string, Deployment> {
  const out: Record<string, Deployment> = {};
  for (const network of GENLAYER_NETWORKS) {
    const raw = process.env[`WRK_${network.toUpperCase()}_CONTRACTS`];
    if (raw) out[network] = deploymentSchema.parse(JSON.parse(raw));
  }
  return out;
}

async function buildApp() {
  const store = await Store.open(mongoConfigFromEnv());
  await store.ensureIndexes();
  const nonces = new MongoNonceLog(store.db);
  await nonces.ensureIndexes();
  const mode = process.env.WRK_WRITE_MODE ?? "prepare";
  if (mode !== "prepare" && mode !== "relay") throw new Error("WRK_WRITE_MODE must be prepare or relay");
  const writes = new ChainWrites({ mode: mode as WriteMode, deployments: deployments(), writer: new GenLayerJsWriter() });
  return { app: createApp({ reads: new ReadModel(store), writes, directory: writes.agentDirectory(), nonces }), store };
}

function sourceFor(network: ChainName): { source: ChainSource; startBlock: number } {
  const upper = network.toUpperCase();
  const key = network === "base-sepolia" ? "BASE" : upper;
  const addressValue = process.env[`WRK_${key}_ADDRESSES`];
  if (!addressValue) throw new Error(`WRK_${key}_ADDRESSES is not set`);
  const addresses = addressValue.split(",").map((address) => address.trim()).filter(Boolean);
  const startBlock = Number(process.env[`WRK_${key}_START_BLOCK`] ?? "1");
  if (!Number.isSafeInteger(startBlock) || startBlock < 1) throw new Error(`invalid WRK_${key}_START_BLOCK`);
  const chainId = chainConfig(network).chainId;
  if (network === "base-sepolia") {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL is not set");
    return { source: new BaseSource({ chainId, rpcUrl, addresses: addresses as `0x${string}`[] }), startBlock };
  }
  const rpcUrl = process.env[`GENLAYER_${upper}_RPC_URL`];
  if (!rpcUrl) throw new Error(`GENLAYER_${upper}_RPC_URL is not set`);
  return { source: new GenLayerSource({ chainId, rpcUrl, addresses }), startBlock };
}

/** Vercel requests advance their own Mongo-backed projection; no always-on indexer host is required. */
async function refreshNetwork(store: Store, network: ChainName): Promise<void> {
  const { source, startBlock } = sourceFor(network);
  const lockCollection = store.db.collection<{ _id: string; token: string; expires_at: Date }>("serverless_indexer_locks");
  const id = `chain:${source.chainId}`;
  const token = randomUUID();
  const now = Date.now();
  try {
    await lockCollection.insertOne({ _id: id, token, expires_at: new Date(now + 55_000) });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const taken = await lockCollection.updateOne(
      { _id: id, expires_at: { $lte: new Date(now) } },
      { $set: { token, expires_at: new Date(now + 55_000) } },
    );
    if (!taken.modifiedCount) return;
  }
  try {
    await indexOnce(store, source, { startBlock, batch: 2_000 });
  } finally {
    await lockCollection.deleteOne({ _id: id, token });
  }
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 11000;
}

function configurationStatus() {
  const missing = ["MONGODB_URI", "MONGODB_DB"].filter((key) => !process.env[key]);
  const networks = Object.fromEntries(GENLAYER_NETWORKS.map((network) => {
    const raw = process.env[`WRK_${network.toUpperCase()}_CONTRACTS`];
    let contracts = false;
    try { if (raw) { deploymentSchema.parse(JSON.parse(raw)); contracts = true; } } catch { /* status only; runtime reports config error */ }
    return [network, { contracts_configured: contracts, indexer_addresses_configured: Boolean(process.env[`WRK_${network.toUpperCase()}_ADDRESSES`]) }];
  }));
  return { missing, networks };
}

/** Vercel serverless handler shared by all `/api/*` requests in a warm function instance. */
export async function handleVercelApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  if (pathname === "/" && request.method === "GET") {
    const config = configurationStatus();
    const network_configuration_present = Object.values(config.networks).some((network) => network.contracts_configured && network.indexer_addresses_configured);
    const configuration_complete = config.missing.length === 0 && network_configuration_present;
    return Response.json({
      service: "wrk-dao-api",
      api_version: "v1",
      status: configuration_complete ? "configured" : "not_ready",
      protocol_ready: null,
      configuration_complete,
      network_configuration_present,
      readiness_basis: "environment_presence_only; live database, RPC, contract, and indexer checks are separate",
      required_environment: { mongodb_uri: !config.missing.includes("MONGODB_URI"), mongodb_db: !config.missing.includes("MONGODB_DB") },
      networks: config.networks,
      endpoints: ["/api/v1/meta", "/api/v1/health", "/api/v1/{network}/health", "/api/v1/{network}/{collection}"],
    }, { status: configuration_complete ? 200 : 503, headers: { "cache-control": "no-store" } });
  }

  try {
    if (!appPromise) appPromise = buildApp().catch((error: unknown) => { appPromise = undefined; throw error; });
    const runtime = await appPromise;
    const readNetwork = networkForRead(pathname, request.method);
    if (readNetwork) await refreshNetwork(runtime.store, readNetwork);
    url.pathname = pathname;
    return await runtime.app.fetch(new Request(url, request));
  } catch (error) {
    if (error instanceof Error) {
      // Keep public errors generic while leaving enough redacted detail in server logs to
      // distinguish a Mongo, RPC, or deployment configuration failure during operations.
      const message = error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[redacted]").slice(0, 500);
      console.error("[wrk-api] request failed", { name: error.name, message });
    } else {
      console.error("[wrk-api] request failed", { name: "UnknownError" });
    }
    return Response.json({
      error: "service_not_ready",
      detail: "The API data store is not configured or reachable. Check GET /api for readiness requirements.",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

function networkForRead(path: string, method: string): ChainName | null {
  if (method !== "GET") return null;
  const match = /^\/v1\/([^/]+)\/(?:health|settlement-windows|lookup|agents|daos|memberships|missions|proposals|mandates|deliverables|evidence|decisions|settlements|payments|reputation)(?:\/|$)/.exec(path);
  if (!match) return null;
  const network = match[1];
  return network === "studionet" || network === "bradbury" || network === "base-sepolia" ? network : null;
}
