/**
 * The API surface.
 *
 * Reads and writes are assembled from two modules that cannot reach each other's
 * dependencies: `readmodel.ts` has no chain client, `writes.ts`/`chain.ts` have no Store.
 * That is what makes G3 and G5 structural rather than a matter of care.
 */

import { Hono } from "hono";
import type { ChainName, CollectionName } from "@wrk/indexer";
import {
  AuthFailed,
  MemoryNonceLog,
  authenticate,
  signedEnvelopeSchema,
  type AgentDirectory,
  type NonceLog,
} from "./auth.js";
import { ChainRefused, ChainWriteFailed, type ChainWrites } from "./chain.js";
import { UnknownNetwork, resolveNetwork, resolveWritableNetwork, NETWORK_NAMES } from "./networks.js";
import { badRequest, fromZod, notFound, refused, unauthorized, upstream } from "./problem.js";
import type { ReadModel } from "./readmodel.js";
import { WRITE_ENDPOINTS } from "./writes.js";

export interface AppDeps {
  readonly reads: ReadModel;
  readonly writes: ChainWrites;
  readonly directory: AgentDirectory;
  readonly nonces?: NonceLog;
  readonly now?: () => number;
}

/** Read routes: collection, path segment, and the id field a single lookup uses. */
const READ_ROUTES: ReadonlyArray<{
  readonly path: string;
  readonly collection: CollectionName;
  readonly filters: readonly string[];
}> = [
  { path: "agents", collection: "agents", filters: [] },
  { path: "daos", collection: "daos", filters: ["creator_agent_id"] },
  { path: "memberships", collection: "memberships", filters: ["dao_id", "agent_id"] },
  { path: "missions", collection: "missions", filters: ["dao_id", "state", "creator_agent_id"] },
  { path: "proposals", collection: "proposals", filters: ["mission_id", "agent_id"] },
  { path: "mandates", collection: "mandates", filters: ["dao_id", "mission_id", "state"] },
  { path: "deliverables", collection: "deliverables", filters: ["mandate_id", "agent_id"] },
  { path: "evidence", collection: "evidence", filters: ["mandate_id", "deliverable_id"] },
  { path: "decisions", collection: "decisions", filters: ["state", "verdict"] },
  { path: "settlements", collection: "settlements", filters: ["state", "mandate_id"] },
  { path: "payments", collection: "payments", filters: ["settlement_id", "payee"] },
  { path: "reputation", collection: "reputation", filters: ["dao_id", "agent_id"] },
];

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nonces = deps.nonces ?? new MemoryNonceLog(now);

  app.onError((error, context) => {
    if (error instanceof UnknownNetwork) return context.json(badRequest(error.message), 400);
    if (error instanceof AuthFailed) return context.json(unauthorized(error.reason), error.status);
    // 422, not 502: the contract refused a well-formed request, so the caller has to change
    // the request rather than send it again. A 5xx would tell every client to retry a call
    // that can never succeed, which for a relaying API means a transaction per attempt.
    if (error instanceof ChainRefused) return context.json(refused(error.detail), 422);
    if (error instanceof ChainWriteFailed) return context.json(upstream(error.detail), 502);
    return context.json(
      { error: "internal", detail: error instanceof Error ? error.message : String(error) },
      500,
    );
  });

  // ── discovery ─────────────────────────────────────────────────────────────

  app.get("/v1/meta", (context) =>
    context.json({
      protocol: "wrk-dao",
      networks: NETWORK_NAMES,
      write_mode: deps.writes.mode,
      reads: READ_ROUTES.map((route) => route.path),
      writes: WRITE_ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    }),
  );

  app.get("/v1/health", async (context) => {
    // Unscoped health: whether the API is up. Per-network health is below, because a
    // single "ok" across chains would hide one stalled indexer behind another's progress.
    return context.json({ ok: true, networks: NETWORK_NAMES });
  });

  // ── reads ─────────────────────────────────────────────────────────────────

  app.get("/v1/:network/health", async (context) => {
    const network = resolveNetwork(context.req.param("network"));
    return context.json(await deps.reads.health(network.name as ChainName, now()));
  });

  app.get("/v1/:network/settlement-windows", async (context) => {
    const network = resolveNetwork(context.req.param("network"));
    const settlements = await deps.reads.settlementWindows(network.name as ChainName, now());
    return context.json({ network: network.name, now_unix: now(), items: settlements });
  });

  app.get("/v1/:network/lookup/:reference", async (context) => {
    const network = resolveNetwork(context.req.param("network"));
    const reference = context.req.param("reference");
    if (!reference || reference.length > 128) return context.json(badRequest("reference must be 1–128 characters"), 400);
    const items = await deps.reads.lookup(network.name as ChainName, reference);
    return context.json({ network: network.name, freshness: await deps.reads.freshness(network.name as ChainName), reference, items });
  });

  for (const route of READ_ROUTES) {
    app.get(`/v1/:network/${route.path}`, async (context) => {
      const network = resolveNetwork(context.req.param("network"));
      const filter: Record<string, unknown> = {};
      for (const field of route.filters) {
        const value = context.req.query(field);
        if (value !== undefined) filter[field] = value;
      }
      const limit = Number(context.req.query("limit") ?? 50);
      const offset = Number(context.req.query("offset") ?? 0);
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || limit < 1 || offset < 0) {
        return context.json(badRequest("limit must be a positive safe integer and offset a nonnegative safe integer"), 400);
      }
      const page = await deps.reads.list(
        network.name as ChainName,
        route.collection,
        filter,
        limit,
        offset,
      );
      // Freshness travels with every read: a caller acting on a row needs to know how old
      // it is, and a separate endpoint for that is one most callers would never call.
      return context.json({
        network: network.name,
        freshness: await deps.reads.freshness(network.name as ChainName),
        ...page,
      });
    });

    app.get(`/v1/:network/${route.path}/:id`, async (context) => {
      const network = resolveNetwork(context.req.param("network"));
      const found = await deps.reads.get(
        network.name as ChainName,
        route.collection,
        context.req.param("id"),
      );
      if (!found) {
        return context.json(notFound(`no ${route.path} ${context.req.param("id")} on ${network.name}`), 404);
      }
      return context.json({
        network: network.name,
        freshness: await deps.reads.freshness(network.name as ChainName),
        item: found,
      });
    });
  }

  // ── writes ────────────────────────────────────────────────────────────────

  for (const endpoint of WRITE_ENDPOINTS) {
    app.post(`/v1/:network${endpoint.path}`, async (context) => {
      const network = resolveWritableNetwork(context.req.param("network"));

      let raw: unknown;
      try {
        raw = await context.req.json();
      } catch {
        return context.json(badRequest("the request body is not valid JSON"), 400);
      }
      if (typeof raw !== "object" || raw === null) {
        return context.json(badRequest("the request body must be a JSON object"), 400);
      }

      const { auth, ...rest } = raw as Record<string, unknown>;

      const envelope = signedEnvelopeSchema.safeParse(auth);
      if (!envelope.success) {
        return context.json(fromZod(envelope.error), 400);
      }
      const body = endpoint.schema.safeParse(rest);
      if (!body.success) {
        return context.json(fromZod(body.error), 400);
      }

      // I7, on every write endpoint rather than on a sample: the signer must control the
      // agent whose authority this call uses.
      const actsFor = endpoint.actsFor(body.data);
      if (actsFor !== envelope.data.agent_id) {
        return context.json(
          unauthorized(
            `this call acts for ${actsFor} but the request is signed as ${envelope.data.agent_id}`,
          ),
          403,
        );
      }

      const agent = await authenticate({
        network: network.name,
        path: `/v1/:network${endpoint.path}`,
        body: body.data,
        envelope: envelope.data,
        directory: deps.directory,
        nonces,
        now: now(),
        ...(endpoint.bootstrap ? { bootstrap: true } : {}),
      });

      const submitted = await deps.writes.submit({
        network: network.name,
        operator: agent.operator,
        call: endpoint.call(body.data),
      });

      return context.json({ network: network.name, acting_for: agent.agentId, ...submitted }, 202);
    });
  }

  app.notFound((context) => context.json(notFound(`no route for ${context.req.path}`), 404));

  return app;
}
