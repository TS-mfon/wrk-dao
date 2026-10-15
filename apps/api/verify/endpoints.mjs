// leaf-1.4.3:G2 — every endpoint exists, is Zod-validated, and answers a malformed body
// with 400 rather than 500.
//
// The 400-not-500 half is the one that matters operationally: a 500 tells an agent "we
// broke, retry", and an agent retrying a request that can never succeed is a loop.

import { WRITE_ENDPOINTS } from "../dist/writes.js";
import { harness, stopAll, post, signed, ACCOUNTS, AGENTS, ulid, fail } from "./_harness.mjs";

const problems = [];
const { app, stop } = await harness();

try {
  // ── discovery lists what exists ───────────────────────────────────────────
  const meta = await (await app.request("/v1/meta")).json();
  if (meta.writes.length !== WRITE_ENDPOINTS.length) {
    problems.push(`/v1/meta lists ${meta.writes.length} writes, the table has ${WRITE_ENDPOINTS.length}`);
  }
  if (!Array.isArray(meta.reads) || meta.reads.length < 12) {
    problems.push(`/v1/meta lists ${meta.reads?.length} read collections, expected at least 12`);
  }

  // ── every read route answers ──────────────────────────────────────────────
  for (const path of meta.reads) {
    const response = await app.request(`/v1/studionet/${path}`);
    if (response.status !== 200) {
      problems.push(`GET /v1/studionet/${path} returned ${response.status}`);
      continue;
    }
    const body = await response.json();
    if (!Array.isArray(body.items)) problems.push(`GET ${path} returned no items array`);
    if (!body.freshness) problems.push(`GET ${path} returned no freshness, so a caller cannot tell how old it is`);
  }

  // A read for a thing that does not exist is a 404, not an empty 200.
  const missing = await app.request(`/v1/studionet/missions/${ulid("msn", "ZZ")}`);
  if (missing.status !== 404) problems.push(`a read of an absent mission returned ${missing.status}, expected 404`);

  // ── every write route exists, and validates ───────────────────────────────
  for (const endpoint of WRITE_ENDPOINTS) {
    const url = `/v1/studionet${endpoint.path.replace(/:[A-Za-z]+/g, "x")}`;

    // Not JSON at all.
    const notJson = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    if (notJson.status !== 400) {
      problems.push(`POST ${endpoint.path} answered a malformed body with ${notJson.status}, expected 400`);
    }

    // JSON, but the wrong shape: must be 400 with the offending field named.
    const wrongShape = await post(app, url, { auth: {}, nonsense: true });
    if (wrongShape.status !== 400) {
      problems.push(`POST ${endpoint.path} answered a bad shape with ${wrongShape.status}, expected 400`);
    } else {
      const body = await wrongShape.json();
      if (body.error !== "bad_request" || !body.fields) {
        problems.push(`POST ${endpoint.path} returned a 400 without naming a field`);
      }
    }

    // A valid envelope with an invalid body must still be 400, never 500.
    const payload = await signed(ACCOUNTS.creator, {
      network: "studionet",
      path: `/v1/:network${endpoint.path}`,
      agentId: AGENTS.creator,
      body: { bogus_field: "x" },
    });
    const invalidBody = await post(app, url, payload);
    if (invalidBody.status !== 400) {
      problems.push(
        `POST ${endpoint.path} with a signed but invalid body returned ${invalidBody.status}, expected 400`,
      );
    }

    if (!endpoint.schema || typeof endpoint.schema.safeParse !== "function") {
      problems.push(`POST ${endpoint.path} has no Zod schema`);
    }
    if (typeof endpoint.actsFor !== "function") {
      problems.push(`POST ${endpoint.path} does not declare whose authority it uses`);
    }
  }

  // An unknown route is a 404 with a reason, not an empty 200.
  const unknown = await app.request("/v1/studionet/not-a-thing");
  if (unknown.status !== 404) problems.push(`an unknown route returned ${unknown.status}`);

  if (problems.length === 0) {
    console.log(
      `API-ENDPOINTS OK ${meta.reads.length} read collection(s) and ${WRITE_ENDPOINTS.length} write endpoint(s), every malformed body answered 400 with a named field`,
    );
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-ENDPOINTS", problems);
