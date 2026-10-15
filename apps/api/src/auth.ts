/**
 * Request authentication, and invariant I7.
 *
 * I7 is "an agent can only act for itself". Enforcing it needs two facts: who signed the
 * request, and which agent that signer controls. The first comes from an EIP-191
 * signature over the canonical request body; the second comes from the **registry on
 * chain**, never from a database row — a read model is not an authorization source
 * (I10), and an authorization check that consults one is the shape of the bug.
 *
 * The signature covers the canonical JSON of the body plus the network and the path, so a
 * request signed for Studionet cannot be replayed against Bradbury, and a request signed
 * for one endpoint cannot be replayed against another. It carries a nonce and an expiry so
 * a captured request is not valid forever.
 */

import { canonicalize } from "@wrk/types";
import { recoverMessageAddress } from "viem";
import { z } from "zod";

export const signedEnvelopeSchema = z
  .object({
    /** The agent the caller claims to act for. Checked against the registry, not trusted. */
        agent_id: z.string().min(1),
    /** Seconds since the epoch, after which this request is refused. */
    expires_at_unix: z.number().int().positive(),
    /** Unique per agent, so a captured request cannot be replayed before it expires. */
    nonce: z.string().min(8).max(128),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();

export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>;

export class AuthFailed extends Error {
  constructor(
    readonly reason: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(reason);
    this.name = "AuthFailed";
  }
}

/**
 * The exact bytes an agent signs.
 *
 * Network and path are inside the message, so one signature authorises one call on one
 * chain. Leaving them out is how a signature for `POST /studionet/missions` becomes a
 * valid signature for `POST /bradbury/mandates`.
 */
export function messageToSign(input: {
  readonly network: string;
  readonly path: string;
  readonly agentId: string;
  readonly nonce: string;
  readonly expiresAtUnix: number;
  readonly body: unknown;
}): string {
  return canonicalize({
    domain: "wrk/api-request/v1",
    network: input.network,
    path: input.path,
    agent_id: input.agentId,
    nonce: input.nonce,
    expires_at_unix: input.expiresAtUnix,
    body: input.body,
  });
}

/** Resolves which agent an address controls. Backed by the registry on chain. */
export interface AgentDirectory {
  /** The agent this address controls, or "" if none. Reads chain, not the database. */
  agentOfAddress(network: string, address: string): Promise<string>;
}

/** Remembers which nonces an agent has spent, so one request is accepted once. */
export interface NonceLog {
  /** True when this is the first use. False means a replay. */
  claim(agentId: string, nonce: string, expiresAtUnix: number): Promise<boolean>;
}

/** An in-memory nonce log, pruned by expiry. Sufficient for a single API process. */
export class MemoryNonceLog implements NonceLog {
  private readonly seen = new Map<string, number>();

  async claim(agentId: string, nonce: string, expiresAtUnix: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key);
    const key = `${agentId}|${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtUnix);
    return true;
  }
}

export interface AuthenticatedAgent {
  readonly agentId: string;
  readonly operator: string;
}

/**
 * Authenticates a signed write request.
 *
 * Order matters: expiry and replay are checked before the signature, because both are
 * cheap and a flood of expired requests should not cost a recovery each. The registry
 * lookup is last, because it is the only step that touches the network.
 */
export async function authenticate(input: {
  readonly network: string;
  readonly path: string;
  readonly body: unknown;
  readonly envelope: SignedEnvelope;
  readonly directory: AgentDirectory;
  readonly nonces: NonceLog;
  readonly now?: number;
  /** How far ahead an expiry may be, so a signature cannot be valid for a year. */
  readonly maxTtlSeconds?: number;
}): Promise<AuthenticatedAgent> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const maxTtl = input.maxTtlSeconds ?? 300;
  const { envelope } = input;

  if (envelope.expires_at_unix <= now) {
    throw new AuthFailed("the request has expired");
  }
  if (envelope.expires_at_unix - now > maxTtl) {
    throw new AuthFailed(`expires_at_unix is more than ${maxTtl}s ahead`);
  }
  if (!(await input.nonces.claim(envelope.agent_id, envelope.nonce, envelope.expires_at_unix))) {
    throw new AuthFailed("this nonce has already been used");
  }

  const message = messageToSign({
    network: input.network,
    path: input.path,
    agentId: envelope.agent_id,
    nonce: envelope.nonce,
    expiresAtUnix: envelope.expires_at_unix,
    body: input.body,
  });

  let recovered: string;
  try {
    recovered = (
      await recoverMessageAddress({
        message,
        signature: envelope.signature as `0x${string}`,
      })
    ).toLowerCase();
  } catch {
    throw new AuthFailed("the signature could not be recovered");
  }

  // I7. The registry decides which agent this address controls; the request's claim is
  // only a claim until it matches.
  const controlled = await input.directory.agentOfAddress(input.network, recovered);
  if (controlled === "") {
    throw new AuthFailed(`${recovered} controls no registered agent on ${input.network}`, 403);
  }
  if (controlled !== envelope.agent_id) {
    throw new AuthFailed(
      `${recovered} controls ${controlled}, not ${envelope.agent_id}: an agent may only act for itself`,
      403,
    );
  }

  return { agentId: envelope.agent_id, operator: recovered };
}
