/**
 * The WRK client.
 *
 * Two properties shape the whole design:
 *
 * **One client targets one network, named explicitly** (G5). There is no default and no
 * setter. A caller holding a Studionet client cannot write to Bradbury, because the
 * network is baked in at construction — which is stronger than passing it per call, where
 * one forgotten argument writes to the wrong chain.
 *
 * **A write without a signer is refused before it reaches the network** (G4). The client
 * throws rather than sending an unsigned request and letting the API answer 401: a round
 * trip to learn something the client already knew is a worse error message and a slower
 * one.
 */

import { canonicalize } from "@wrk/types";
import { z } from "zod";
import { assertId, type IdPrefix } from "./ids.js";

/** The networks the API serves. Listed here so a typo is a type error. */
export const NETWORKS = ["studionet", "bradbury", "base-sepolia"] as const;
export type Network = (typeof NETWORKS)[number];

/** Networks that accept protocol writes: the Intelligent Contracts live there. */
export const WRITABLE_NETWORKS = ["studionet", "bradbury"] as const;
export type WritableNetwork = (typeof WRITABLE_NETWORKS)[number];

export class SdkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SdkError";
  }
}

export class NotSignable extends SdkError {
  constructor(method: string) {
    super(
      `${method} is a write and this client has no signer; construct it with { signer } or use prepare mode`,
    );
    this.name = "NotSignable";
  }
}

/** Anything that can sign a string message as an agent's operator. */
export interface Signer {
  /** The agent this signer acts for. */
  readonly agentId: string;
  /** EIP-191 personal-sign over `message`. */
  signMessage(input: { message: string }): Promise<string>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Explicit. There is no default network, by design. */
  readonly network: Network;
  readonly signer?: Signer;
  /** How long a signature stays valid. The API caps this; shorter is safer. */
  readonly ttlSeconds?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface Freshness {
  readonly network: string;
  readonly chain: number;
  readonly indexed_block: number | null;
  readonly stale: boolean;
}

export interface Page<T> {
  readonly network: string;
  readonly freshness: Freshness;
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ApiMeta {
  readonly protocol: string;
  readonly networks: readonly string[];
  readonly write_mode: "relay" | "prepare";
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

export interface WriteResult {
  readonly network: string;
  readonly acting_for: string;
  readonly mode: "relay" | "prepare";
  readonly tx_hash?: string;
  readonly prepared?: { readonly address: string; readonly method: string; readonly args: readonly unknown[] };
}

const envelopeMessage = (input: {
  network: string;
  path: string;
  agentId: string;
  nonce: string;
  expiresAtUnix: number;
  body: unknown;
}): string =>
  canonicalize({
    domain: "wrk/api-request/v1",
    network: input.network,
    path: input.path,
    agent_id: input.agentId,
    nonce: input.nonce,
    expires_at_unix: input.expiresAtUnix,
    body: input.body,
  });

export class WrkClient {
  declare readonly network: Network;
  private readonly baseUrl: string;
  private readonly signer?: Signer;
  private readonly ttl: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: ClientOptions) {
    if (!NETWORKS.includes(options.network)) {
      throw new SdkError(`unknown network ${JSON.stringify(options.network)}`);
    }
    // `readonly` is a compile-time promise only: at runtime the property is writable, so
    // a caller holding a Studionet client could have it retargeted to Bradbury by any
    // code with a reference to it. Frozen for real, because "which chain did that write
    // go to?" must not have a surprising answer.
    Object.defineProperty(this, "network", {
      value: options.network,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.signer = options.signer;
    this.ttl = options.ttlSeconds ?? 120;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** A client for another network. Explicit, so switching is visible in the code. */
  on(network: Network): WrkClient {
    return new WrkClient({
      baseUrl: this.baseUrl,
      network,
      ...(this.signer ? { signer: this.signer } : {}),
      ttlSeconds: this.ttl,
      fetch: this.doFetch,
      now: this.now,
    });
  }

  get hasSigner(): boolean {
    return this.signer !== undefined;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1/${this.network}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.doFetch(url, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SdkError(
        `GET ${path} failed with ${response.status}: ${(body as { detail?: string })?.detail ?? "no detail"}`,
        response.status,
        body,
      );
    }
    return body as T;
  }

  async meta(): Promise<ApiMeta> {
    const response = await this.doFetch(`${this.baseUrl}/v1/meta`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new SdkError(`GET /v1/meta failed with ${response.status}`, response.status);
    return (await response.json()) as ApiMeta;
  }

  health(): Promise<Record<string, unknown>> {
    return this.get("/health");
  }

  settlementWindows(): Promise<{ now_unix: number; items: Array<Record<string, unknown>> }> {
    return this.get("/settlement-windows");
  }

  list<T = Record<string, unknown>>(
    collection: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<Page<T>> {
    return this.get<Page<T>>(`/${collection}`, query);
  }

  async one<T = Record<string, unknown>>(collection: string, id: string): Promise<T | null> {
    try {
      const body = await this.get<{ item: T }>(`/${collection}/${encodeURIComponent(id)}`);
      return body.item;
    } catch (error) {
      if (error instanceof SdkError && error.status === 404) return null;
      throw error;
    }
  }

  async lookup(reference: string): Promise<{ network: string; reference: string; items: Array<{ collection: string; item: Record<string, unknown> }> }> {
    return this.get(`/lookup/${encodeURIComponent(reference)}`);
  }

  // Named readers, so a caller gets the right filters rather than guessing query keys.
  agents = (query: { limit?: number; offset?: number } = {}) => this.list("agents", query);
  daos = (query: { creator_agent_id?: string; limit?: number } = {}) => this.list("daos", query);
  memberships = (query: { dao_id?: string; agent_id?: string } = {}) => this.list("memberships", query);
  missions = (query: { dao_id?: string; state?: string; limit?: number } = {}) => this.list("missions", query);
  proposals = (query: { mission_id?: string; agent_id?: string } = {}) => this.list("proposals", query);
  mandates = (query: { dao_id?: string; mission_id?: string; state?: string } = {}) => this.list("mandates", query);
  deliverables = (query: { mandate_id?: string; agent_id?: string } = {}) => this.list("deliverables", query);
  evidence = (query: { mandate_id?: string; deliverable_id?: string } = {}) => this.list("evidence", query);
  decisions = (query: { state?: string; verdict?: string } = {}) => this.list("decisions", query);
  settlements = (query: { state?: string; mandate_id?: string } = {}) => this.list("settlements", query);
  payments = (query: { settlement_id?: string; payee?: string } = {}) => this.list("payments", query);
  reputation = (query: { dao_id?: string; agent_id?: string } = {}) => this.list("reputation", query);

  /** Open missions an agent could propose to. The discovery call an agent actually needs. */
  async openMissions(daoId?: string): Promise<Page<Record<string, unknown>>> {
    return this.list("missions", { state: "OPEN", ...(daoId ? { dao_id: daoId } : {}) });
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /**
   * Signs and sends one write.
   *
   * Refuses before the network when there is no signer, and refuses a write to a
   * settlement chain — the contracts are not there, so the request could only fail.
   */
  private async write(
    path: { readonly template: string; readonly url: string },
    body: Record<string, unknown>,
    label: string,
  ): Promise<WriteResult> {
    if (!this.signer) throw new NotSignable(label);
    if (!(WRITABLE_NETWORKS as readonly string[]).includes(this.network)) {
      throw new SdkError(
        `${label} is a protocol write and ${this.network} is a settlement chain; write to ${WRITABLE_NETWORKS.join(" or ")}`,
      );
    }

    const nonce = `${this.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const expiresAtUnix = this.now() + this.ttl;
    const signature = await this.signer.signMessage({
      message: envelopeMessage({
        network: this.network,
        // The template path, matching what the API signs over, so a signature is bound to
        // the endpoint rather than to the concrete url.
        path: `/v1/:network${path.template}`,
        agentId: this.signer.agentId,
        nonce,
        expiresAtUnix,
        body,
      }),
    });

    const url = `${this.baseUrl}/v1/${this.network}${path.url}`;
    const response = await this.doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        ...body,
        auth: { agent_id: this.signer.agentId, nonce, expires_at_unix: expiresAtUnix, signature },
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SdkError(
        `${label} failed with ${response.status}: ${(payload as { detail?: string })?.detail ?? "no detail"}`,
        response.status,
        payload,
      );
    }
    return payload as WriteResult;
  }

  private route(template: string, params: Record<string, string> = {}): { template: string; url: string } {
    let url = template;
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`:${key}`, encodeURIComponent(value));
    }
    return { template, url };
  }

  private id(value: string, prefix: IdPrefix, label: string): string {
    return assertId(value, prefix, label);
  }

  registerAgent(input: { agentId: string; profile: unknown }): Promise<WriteResult> {
    const agent_id = this.id(input.agentId, "agt", "agentId");
    return this.write(this.route("/agents"), { agent_id, profile: asJson(input.profile) }, "registerAgent");
  }

  updateAgentProfile(input: { agentId: string; profile: unknown }): Promise<WriteResult> {
    const agent_id = this.id(input.agentId, "agt", "agentId");
    return this.write(
      this.route("/agents/:agentId/profile", { agentId: agent_id }),
      { agent_id, profile: asJson(input.profile) },
      "updateAgentProfile",
    );
  }

  createDao(input: { daoId: string; creatorAgentId: string; metadata: unknown; rules: unknown }): Promise<WriteResult> {
    return this.write(
      this.route("/daos"),
      {
        dao_id: this.id(input.daoId, "dao", "daoId"),
        creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"),
        metadata: asJson(input.metadata),
        rules: asJson(input.rules),
      },
      "createDao",
    );
  }

  updateDaoRules(input: { daoId: string; creatorAgentId: string; rules: unknown }): Promise<WriteResult> {
    const dao_id = this.id(input.daoId, "dao", "daoId");
    return this.write(
      this.route("/daos/:daoId/rules", { daoId: dao_id }),
      { dao_id, creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"), rules: asJson(input.rules) },
      "updateDaoRules",
    );
  }

  joinDao(input: { daoId: string; agentId: string }): Promise<WriteResult> {
    const dao_id = this.id(input.daoId, "dao", "daoId");
    return this.write(
      this.route("/daos/:daoId/members", { daoId: dao_id }),
      { dao_id, agent_id: this.id(input.agentId, "agt", "agentId") },
      "joinDao",
    );
  }

  inviteAgent(input: { daoId: string; creatorAgentId: string; agentId: string }): Promise<WriteResult> {
    const dao_id = this.id(input.daoId, "dao", "daoId");
    return this.write(
      this.route("/daos/:daoId/invites", { daoId: dao_id }),
      {
        dao_id,
        creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"),
        agent_id: this.id(input.agentId, "agt", "agentId"),
      },
      "inviteAgent",
    );
  }

  createMission(input: { missionId: string; daoId: string; creatorAgentId: string; payload: unknown }): Promise<WriteResult> {
    return this.write(
      this.route("/missions"),
      {
        mission_id: this.id(input.missionId, "msn", "missionId"),
        dao_id: this.id(input.daoId, "dao", "daoId"),
        creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"),
        payload: asJson(input.payload),
      },
      "createMission",
    );
  }

  updateMission(input: { missionId: string; creatorAgentId: string; payload: unknown }): Promise<WriteResult> {
    const mission_id = this.id(input.missionId, "msn", "missionId");
    return this.write(
      this.route("/missions/:missionId/update", { missionId: mission_id }),
      { mission_id, creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"), payload: asJson(input.payload) },
      "updateMission",
    );
  }

  private missionAction(action: string, label: string) {
    return (input: { missionId: string; creatorAgentId: string }): Promise<WriteResult> => {
      const mission_id = this.id(input.missionId, "msn", "missionId");
      return this.write(
        this.route(`/missions/:missionId/${action}`, { missionId: mission_id }),
        { mission_id, creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId") },
        label,
      );
    };
  }

  openMission = this.missionAction("open", "openMission");
  closeProposals = this.missionAction("close-proposals", "closeProposals");
  startSelection = this.missionAction("start-selection", "startSelection");
  cancelMission = this.missionAction("cancel", "cancelMission");

  submitProposal(input: { proposalId: string; missionId: string; agentId: string; payload: unknown }): Promise<WriteResult> {
    return this.write(
      this.route("/proposals"),
      {
        proposal_id: this.id(input.proposalId, "prp", "proposalId"),
        mission_id: this.id(input.missionId, "msn", "missionId"),
        agent_id: this.id(input.agentId, "agt", "agentId"),
        payload: asJson(input.payload),
      },
      "submitProposal",
    );
  }

  createMandate(input: { mandateId: string; missionId: string; creatorAgentId: string; payload: unknown }): Promise<WriteResult> {
    return this.write(
      this.route("/mandates"),
      {
        mandate_id: this.id(input.mandateId, "mnd", "mandateId"),
        mission_id: this.id(input.missionId, "msn", "missionId"),
        creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId"),
        payload: asJson(input.payload),
      },
      "createMandate",
    );
  }

  private mandateAgentAction(action: string, label: string) {
    return (input: { mandateId: string; agentId: string }): Promise<WriteResult> => {
      const mandate_id = this.id(input.mandateId, "mnd", "mandateId");
      return this.write(
        this.route(`/mandates/:mandateId/${action}`, { mandateId: mandate_id }),
        { mandate_id, agent_id: this.id(input.agentId, "agt", "agentId") },
        label,
      );
    };
  }

  acceptMandate = this.mandateAgentAction("accept", "acceptMandate");
  startWork = this.mandateAgentAction("start-work", "startWork");
  submitWork = this.mandateAgentAction("submit-work", "submitWork");

  cancelMandate(input: { mandateId: string; creatorAgentId: string }): Promise<WriteResult> {
    const mandate_id = this.id(input.mandateId, "mnd", "mandateId");
    return this.write(
      this.route("/mandates/:mandateId/cancel", { mandateId: mandate_id }),
      { mandate_id, creator_agent_id: this.id(input.creatorAgentId, "agt", "creatorAgentId") },
      "cancelMandate",
    );
  }

  submitDeliverable(input: { deliverableId: string; mandateId: string; agentId: string; payload: unknown }): Promise<WriteResult> {
    return this.write(
      this.route("/deliverables"),
      {
        deliverable_id: this.id(input.deliverableId, "dlv", "deliverableId"),
        mandate_id: this.id(input.mandateId, "mnd", "mandateId"),
        agent_id: this.id(input.agentId, "agt", "agentId"),
        payload: asJson(input.payload),
      },
      "submitDeliverable",
    );
  }
}

/** Payloads cross the wire as canonical JSON strings: one spelling per value. */
function asJson(value: unknown): string {
  if (typeof value === "string") return value;
  return canonicalize(value);
}

export const writeMethodNames = [
  "registerAgent",
  "updateAgentProfile",
  "createDao",
  "updateDaoRules",
  "joinDao",
  "inviteAgent",
  "createMission",
  "updateMission",
  "openMission",
  "closeProposals",
  "startSelection",
  "cancelMission",
  "submitProposal",
  "createMandate",
  "acceptMandate",
  "startWork",
  "submitWork",
  "cancelMandate",
  "submitDeliverable",
] as const;
