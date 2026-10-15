// leaf-1.4.3:G5 — reads serve the read model and never block on chain RPC.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { harness, stopAll, fail, API } from "./_harness.mjs";

const problems = [];
// A writer that hangs forever: if any read awaited chain RPC, the read would never return.
const { app, views, stop } = await harness();

try {
  const paths = (await (await app.request("/v1/meta")).json()).reads;
  const viewsBefore = views.length;

  for (const path of paths) {
    const response = await Promise.race([
      app.request(`/v1/studionet/${path}`),
      new Promise((resolve) => setTimeout(() => resolve({ status: 599 }), 2_000)),
    ]);
    if (response.status === 599) problems.push(`GET ${path} did not return within 2s`);
    else if (response.status !== 200) problems.push(`GET ${path} returned ${response.status}`);
  }

  for (const path of ["health", "settlement-windows"]) {
    const response = await app.request(`/v1/studionet/${path}`);
    if (response.status !== 200) problems.push(`GET ${path} returned ${response.status}`);
  }

  if (views.length !== viewsBefore) {
    problems.push(`reads made ${views.length - viewsBefore} chain view call(s); they must make none`);
  }

  // Structural: the read module must not import a chain client.
  const source = readFileSync(resolve(API, "dist/readmodel.js"), "utf8");
  for (const needle of ["viem", "createPublicClient", "GenLayerSource", "BaseSource", "rpc", "fetch("]) {
    if (source.includes(needle)) {
      problems.push(`readmodel.js references ${needle}; a read that can reach a chain eventually will`);
    }
  }

  // Every read carries freshness, so a caller knows how stale the row is.
  const body = await (await app.request("/v1/studionet/missions")).json();
  if (body.freshness?.indexed_block !== null) {
    problems.push("an unindexed network reported an indexed block");
  }
  if (body.freshness?.stale !== true) {
    problems.push("an unindexed network did not report itself stale");
  }

  if (problems.length === 0) {
    console.log(`API-READS OK ${paths.length + 2} read endpoint(s) answered from the read model with 0 chain call(s), each carrying freshness`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-READS", problems);
