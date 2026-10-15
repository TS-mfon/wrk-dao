// leaf-1.4.3:G4 — invariant I7, on EVERY write endpoint.
//
// The gate's own note says why: sampling three of them is how the fourth ships unguarded.
// So the loop below runs the same four attacks against all 19.

import { WRITE_ENDPOINTS } from "../dist/writes.js";
import { harness, stopAll, post, signed, ACCOUNTS, AGENTS, fail } from "./_harness.mjs";

const problems = [];
const { app, stop } = await harness();

/**
 * A body that satisfies exactly one endpoint's schema.
 *
 * Built from the schema's own shape rather than from a superset: every write schema is
 * `.strict()`, so an extra key is a 400 before authorization ever runs — which would make
 * every refusal below pass for the wrong reason.
 */
function bodyFor(endpoint, actingAgent) {
  const values = {
    agent_id: actingAgent,
    creator_agent_id: actingAgent,
    dao_id: "dao_01JQ8Z000000000000000000D1",
    mission_id: "msn_01JQ8Z000000000000000000M1",
    proposal_id: "prp_01JQ8Z000000000000000000P1",
    mandate_id: "mnd_01JQ8Z000000000000000000N1",
    deliverable_id: "dlv_01JQ8Z000000000000000000V1",
    profile: '{"schema_version":1}',
    metadata: '{"schema_version":1}',
    rules: '{"schema_version":1}',
    payload: '{"schema_version":1}',
  };
  const shape = endpoint.schema.shape ?? {};
  const body = {};
  for (const key of Object.keys(shape)) {
    if (!(key in values)) throw new Error(`no fixture value for ${endpoint.path} field ${key}`);
    body[key] = values[key];
  }
  const parsed = endpoint.schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `fixture body for ${endpoint.path} does not satisfy its own schema: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

try {
  let checked = 0;

  for (const endpoint of WRITE_ENDPOINTS) {
    const path = `/v1/:network${endpoint.path}`;
    const url = `/v1/studionet${endpoint.path.replace(/:[A-Za-z]+/g, "x")}`;
    const body = bodyFor(endpoint, AGENTS.creator);
    const actsFor = endpoint.actsFor(body);

    // 1. An unsigned request is refused.
    const unsigned = await post(app, url, body);
    if (unsigned.status === 202) problems.push(`${endpoint.path}: accepted an unsigned request`);

    // 2. The worker signs a call that acts for the creator. I7 refuses it.
    const impersonation = await signed(ACCOUNTS.worker, {
      network: "studionet",
      path,
      agentId: AGENTS.worker,
      body,
    });
    const impersonated = await post(app, url, impersonation);
    if (impersonated.status === 202) {
      problems.push(`${endpoint.path}: ${AGENTS.worker} acted for ${actsFor}`);
    } else if (![401, 403].includes(impersonated.status)) {
      problems.push(`${endpoint.path}: impersonation returned ${impersonated.status}, expected 401/403`);
    }

    // 3. The right agent id, signed by the wrong key.
    const forged = await signed(ACCOUNTS.stranger, {
      network: "studionet",
      path,
      agentId: actsFor,
      body,
    });
    const forgedResponse = await post(app, url, forged);
    if (forgedResponse.status === 202) {
      problems.push(`${endpoint.path}: a signature from an unregistered key was accepted`);
    }

    // 4. A signature for a different network must not work here.
    const crossNetwork = await signed(ACCOUNTS.creator, {
      network: "bradbury",
      path,
      agentId: actsFor,
      body,
    });
    const replayed = await post(app, url, crossNetwork);
    if (replayed.status === 202) {
      problems.push(`${endpoint.path}: a signature bound to bradbury was accepted on studionet`);
    }

    // 5. A signature for a different endpoint must not work here.
    const crossPath = await signed(ACCOUNTS.creator, {
      network: "studionet",
      path: "/v1/:network/somewhere-else",
      agentId: actsFor,
      body,
    });
    if ((await post(app, url, crossPath)).status === 202) {
      problems.push(`${endpoint.path}: a signature bound to another path was accepted`);
    }

    // 6. The correct caller succeeds, or the endpoint is unreachable and the five
    //    refusals above would prove nothing.
    const honest = await signed(ACCOUNTS.creator, {
      network: "studionet",
      path,
      agentId: actsFor,
      body,
    });
    const accepted = await post(app, url, honest);
    if (accepted.status !== 202) {
      problems.push(
        `${endpoint.path}: the correct caller was refused with ${accepted.status} — ${JSON.stringify(await accepted.json()).slice(0, 160)}`,
      );
    }

    // 7. Replaying the honest request is refused, so a captured call is single-use.
    if ((await post(app, url, honest)).status === 202) {
      problems.push(`${endpoint.path}: the same signed request was accepted twice`);
    }

    checked += 1;
  }

  // 8. An expired signature is refused.
  const expired = await signed(ACCOUNTS.creator, {
    network: "studionet",
    path: "/v1/:network/agents",
    agentId: AGENTS.creator,
    body: { agent_id: AGENTS.creator, profile: '{"schema_version":1}' },
    expiresAtUnix: 1_799_999_999,
  });
  if ((await post(app, "/v1/studionet/agents", expired)).status === 202) {
    problems.push("an expired signature was accepted");
  }

  // 9. An address that controls no agent is refused even with a valid signature.
  const nobody = await harness({ registry: {} });
  try {
    const orphan = await signed(ACCOUNTS.creator, {
      network: "studionet",
      path: "/v1/:network/agents",
      agentId: AGENTS.creator,
      body: { agent_id: AGENTS.creator, profile: '{"schema_version":1}' },
    });
    const response = await post(nobody.app, "/v1/studionet/agents", orphan);
    if (response.status === 202) {
      problems.push("a signature from an address that controls no agent was accepted");
    }
  } finally {
    await nobody.stop();
  }

  if (problems.length === 0) {
    console.log(
      `API-AUTHZ OK ${checked} write endpoint(s), each refusing an unsigned, impersonating, forged, cross-network, cross-path and replayed request while accepting the agent's own`,
    );
  }
} finally {
  await stop();
  await stopAll();
}

if (problems.length > 0) fail("API-AUTHZ", problems);
