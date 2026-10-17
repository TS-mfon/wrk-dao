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
    agent_id: z.string().regex(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/),
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
  claim(agentId: string, nonce: string, expiresAtUnix: number, namespace?: string): Promise<boolean>;
}

/** An in-memory nonce log, pruned by expiry. Sufficient for a single API process. */
export class MemoryNonceLog implements NonceLog {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async claim(agentId: string, nonce: string, expiresAtUnix: number, namespace = ""): Promise<boolean> {
    const now = this.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    const key = JSON.stringify([namespace, agentId, nonce]);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtUnix);
    return true;
  }
}

export interface AuthenticatedAgent {
  readonly agentId: string;
  readonly operator: string;
  /** True when the registry confirmed this address controls this agent. */
  readonly registered: boolean;
}

/**
 * Authenticates a signed write request.
 *
 * Expiry is checked first. A nonce is claimed atomically only after signature and
 * authority verification: unauthenticated traffic must never spend another caller's
 * nonce. The claim is scoped to the network and recovered operator as well as agent id.
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
  /**
   * Skips the registry lookup, for the one call that creates the registry entry.
   *
   * `register_agent` is the bootstrap: requiring the registry to already know the caller
   * would make onboarding impossible, because the lookup can only succeed after the call
   * it is gating has already happened. The agents found exactly that — see BUGS.md
   * BUG-029.
   *
   * I7 still holds, in two places. Here, the envelope's `agent_id` must equal the agent
   * the call registers, which `app.ts` checks before this runs. On chain, the contract
   * refuses a profile whose declared operator is not the transaction sender and refuses
   * an id that is already taken — so a bootstrap signature can only ever register the
   * signer, under an unclaimed id.
   */
  readonly bootstrap?: boolean;
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

  if (input.bootstrap) {
    // The recovered address must be the operator the profile declares.
    //
    // Without this the bootstrap path accepts any signature at all: recovering a
    // signature against a message it was not made for yields a *different* valid-looking
    // address, and with no registry lookup there was nothing left to compare it to — so a
    // signature bound to Bradbury was accepted on Studionet, and one bound to another
    // endpoint was accepted here. The gate caught it. Comparing against the declared
    // operator restores the binding, and it is the same check the contract makes before
    // it will store the profile.
    const declared = declaredOperator(input.body);
    if (declared === null) {
      throw new AuthFailed("the profile does not declare an operator address", 403);
    }
    if (declared !== recovered) {
      throw new AuthFailed(
        `the profile declares operator ${declared} but the request was signed by ${recovered}`,
        403,
      );
    }
  } else {
    // Registry state, never the read model, establishes authority.
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
  }

  if (!(await input.nonces.claim(
    envelope.agent_id, envelope.nonce, envelope.expires_at_unix,
    `${input.network}:${recovered}`,
  ))) {
    throw new AuthFailed("this nonce has already been used");
  }

  return { agentId: envelope.agent_id, operator: recovered, registered: !input.bootstrap };
}

/**
 * The operator address a registration payload declares, lowercased.
 *
 * Returns null when the body carries no readable profile, so the caller refuses rather
 * than treating an unparseable payload as a match.
 */
function declaredOperator(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const profile = (body as { profile?: unknown }).profile;
  if (typeof profile !== "string") return null;
  try {
    const parsed = JSON.parse(profile) as { operator?: unknown };
    return typeof parsed.operator === "string" ? parsed.operator.toLowerCase() : null;
  } catch {
    return null;
  }
}
