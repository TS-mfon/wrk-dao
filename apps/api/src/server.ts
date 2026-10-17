#!/usr/bin/env node
/** Entry point. Wiring only; every decision lives in the module that owns it. */

import { serve } from "@hono/node-server";
import { Store, mongoConfigFromEnv } from "@wrk/indexer";
import { createApp } from "./app.js";
import { ChainWrites, deploymentSchema, type Deployment, type WriteMode } from "./chain.js";
import { ReadModel } from "./readmodel.js";
import { GENLAYER_NETWORKS } from "./networks.js";
import { GenLayerJsWriter } from "./genlayer-writer.js";
import { MongoNonceLog } from "./nonces.js";

function deployments(): Record<string, Deployment> {
  const out: Record<string, Deployment> = {};
  for (const network of GENLAYER_NETWORKS) {
    const raw = process.env[`WRK_${network.toUpperCase()}_CONTRACTS`];
    if (!raw) continue;
    out[network] = deploymentSchema.parse(JSON.parse(raw));
  }
  return out;
}

async function main(): Promise<void> {
  const store = await Store.open(mongoConfigFromEnv());
  await store.ensureIndexes();
  const nonces = new MongoNonceLog(store.db);
  await nonces.ensureIndexes();
  const mode = (process.env.WRK_WRITE_MODE ?? "prepare") as WriteMode;
  if (mode !== "prepare" && mode !== "relay") {
    throw new Error(`WRK_WRITE_MODE must be "prepare" or "relay", got ${JSON.stringify(mode)}`);
  }

  const writes = new ChainWrites({ mode, deployments: deployments(), writer: new GenLayerJsWriter() });
  const app = createApp({
    reads: new ReadModel(store),
    writes,
    directory: writes.agentDirectory(),
    nonces,
  });

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });
  console.log(`wrk api listening on :${port} (write mode ${mode})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
