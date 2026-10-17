/**
 * A signer backed by a local private key.
 *
 * The key stays in the agent's process. This is the non-custodial half of the write story:
 * the agent signs its own requests, the API verifies the signature against the registry,
 * and nothing hands a key to a server.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chains, createAccount, createClient } from "genlayer-js";
import { newId } from "@wrk/types";
import type { Signer, WritableNetwork } from "./client.js";
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
  const chainFor = (network: WritableNetwork) => network === "studionet" ? chains.studionet : chains.testnetBradbury;
  return {
    agentId: options.agentId,
    address: account.address.toLowerCase(),
    async signMessage({ message }) {
      return account.signMessage({ message });
    },
    async submitPrepared({ network, address, method, args }) {
      const chainAccount = createAccount(options.privateKey as `0x${string}`);
      const client = createClient({ chain: chainFor(network), account: chainAccount });
      const result: unknown = await client.writeContract({
        account: chainAccount,
        address: address as `0x${string}`,
        functionName: method,
        args: args as never,
        value: 0n,
      });
      if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) throw new Error("GenLayerJS did not return a transaction hash");
      return result;
    },
  };
}

/** Generate a fresh, locally-held operator credential for an agent. Persist it securely. */
export function createAgentCredentials(): { agentId: string; privateKey: `0x${string}`; address: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { agentId: newId("agt"), privateKey, address: account.address.toLowerCase() };
}
