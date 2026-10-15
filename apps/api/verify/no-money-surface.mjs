// leaf-1.4.3:G7 — no endpoint could authorize a settlement, and none writes reputation.
//
// §118's authority separation at the API boundary. The escrow on Base is the custody
// authority and the adjudicator is the judgment authority; an API that could post a
// settlement or a decision would route around both. Reputation is absent because it is
// written only after final settlement, by the keeper, and an endpoint for it would be a
// way to write standing through this surface.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { WRITE_ENDPOINTS, FORBIDDEN_WRITE_PATHS } from "../dist/writes.js";
import { harness, stopAll, post, fail, API } from "./_harness.mjs";

const problems = [];
const { app, stop } = await harness();

try {
  // 1. No write endpoint targets the reputation contract or a money method.
  for (const endpoint of WRITE_ENDPOINTS) {
    const sample = {};
    for (const key of Object.keys(endpoint.schema.shape ?? {})) sample[key] = "x";
    let call;
    try { call = endpoint.call(sample); } catch { call = null; }
    if (!call) continue;
    if (call.contract === "reputation") {
      problems.push(`${endpoint.path} targets wrk_reputation; reputation is the keeper's to write`);
    }
    if (/^(mark_funded|mark_settled|mark_refunded|record_adjudication|record_selection|record_outcome)$/.test(call.method)) {
      problems.push(`${endpoint.path} calls ${call.method}, which is a custody or judgment relay and not an API action`);
    }
  }

  // 2. The forbidden paths really are absent, each answering 404.
  for (const { path, reason } of FORBIDDEN_WRITE_PATHS) {
    const url = `/v1/studionet${path.replace(/:[A-Za-z]+/g, "x")}`;
    const response = await post(app, url, {});
    if (response.status !== 404) {
      problems.push(`POST ${path} exists (status ${response.status}) — ${reason}`);
    }
    if (WRITE_ENDPOINTS.some((endpoint) => endpoint.path === path)) {
      problems.push(`${path} is in the write table but must not be — ${reason}`);
    }
  }

  // 3. No signer, key or token-transfer surface anywhere in the built API.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) files.push(path);
    }
  };
  walk(resolve(API, "dist"));
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const needle of ["privateKeyToAccount", "mnemonicToAccount", "createWalletClient", "PRIVATE_KEY", "transferFrom", "safeTransfer"]) {
      if (source.includes(needle)) {
        problems.push(`${path.slice(API.length + 1)} contains ${needle}`);
      }
    }
  }

  // 4. Positive control: the forbidden-path list must be able to fire.
  if (FORBIDDEN_WRITE_PATHS.length < 5) {
    problems.push("the forbidden-path list is too short to be a meaningful check");
  }
  const control = WRITE_ENDPOINTS.some((endpoint) => endpoint.path === "/settlements");
  if (control) problems.push("control: /settlements is present in the write table");

  if (problems.length === 0) {
    console.log(`API-NO-MONEY-SURFACE OK ${WRITE_ENDPOINTS.length} write endpoint(s) touch no money or reputation, ${FORBIDDEN_WRITE_PATHS.length} forbidden path(s) absent, no signer in ${files.length} built file(s)`);
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-NO-MONEY-SURFACE", problems);
