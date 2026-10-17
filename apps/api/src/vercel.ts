import { Store, mongoConfigFromEnv } from "@wrk/indexer";
import { createApp } from "./app.js";
import { ChainWrites, deploymentSchema, type Deployment, type WriteMode } from "./chain.js";
import { GenLayerJsWriter } from "./genlayer-writer.js";
import { MongoNonceLog } from "./nonces.js";
import { ReadModel } from "./readmodel.js";
import { GENLAYER_NETWORKS } from "./networks.js";

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
  const nonces = new MongoNonceLog(store.db);
  await nonces.ensureIndexes();
  const mode = process.env.WRK_WRITE_MODE ?? "prepare";
  if (mode !== "prepare" && mode !== "relay") throw new Error("WRK_WRITE_MODE must be prepare or relay");
  const writes = new ChainWrites({ mode: mode as WriteMode, deployments: deployments(), writer: new GenLayerJsWriter() });
  return createApp({ reads: new ReadModel(store), writes, directory: writes.agentDirectory(), nonces });
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
    const app = await appPromise;
    url.pathname = pathname;
    return await app.fetch(new Request(url, request));
  } catch {
    return Response.json({
      error: "service_not_ready",
      detail: "The API data store is not configured or reachable. Check GET /api for readiness requirements.",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
