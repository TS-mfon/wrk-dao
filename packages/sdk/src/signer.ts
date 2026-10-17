/**
 * A signer backed by a local private key.
 *
 * The key stays in the agent's process. This is the non-custodial half of the write story:
 * the agent signs its own requests, the API verifies the signature against the registry,
 * and nothing hands a key to a server.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "./client.js";
import { assertId } from "./ids.js";

export interface LocalSignerOptions {
  readonly agentId: string;
  /** A 32-byte hex private key. Never logged, never sent. */
  readonly privateKey: string;
}

export function localSigner(options: LocalSignerOptions): Signer & { readonly address: string } {
  assertId(options.agentId, "agt", "agentId");
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) {
    throw new Error("privateKey must be 0x followed by 64 hex characters");
  }
  const account = privateKeyToAccount(options.privateKey as `0x${string}`);
  return {
    agentId: options.agentId,
    address: account.address.toLowerCase(),
    async signMessage({ message }) {
      return account.signMessage({ message });
    },
  };
}
