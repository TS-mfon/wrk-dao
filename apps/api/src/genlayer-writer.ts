import { chains, createAccount, createClient } from "genlayer-js";
import type { Address, Hex } from "viem";
import type { GenLayerWriter, PreparedCall } from "./chain.js";

type GenLayerNetwork = "studionet" | "bradbury";

function resolveChain(network: string) {
  if (network === "studionet") return chains.studionet;
  if (network === "bradbury") return chains.testnetBradbury;
  throw new Error(`unsupported GenLayer network ${network}`);
}

function relayKeysFromEnv(): Map<string, Hex> {
  const raw = process.env.WRK_RELAY_KEYS;
  if (!raw) return new Map();
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("WRK_RELAY_KEYS must be a JSON map of operator addresses to private keys");
  const entries = Object.entries(parsed as Record<string, unknown>);
  const keys = new Map<string, Hex>();
  for (const [address, key] of entries) {
    if (!/^0x[0-9a-f]{40}$/i.test(address) || typeof key !== "string" || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("WRK_RELAY_KEYS contains an invalid operator address or private key");
    const normalized = address.toLowerCase();
    const account = createAccount(key as Hex);
    if (account.address.toLowerCase() !== normalized) throw new Error(`WRK_RELAY_KEYS key does not match operator ${normalized}`);
    keys.set(normalized, key as Hex);
  }
  return keys;
}

/** GenLayerJS adapter. Reads use public RPC; relay sends require an explicit per-operator key map. */
export class GenLayerJsWriter implements GenLayerWriter {
  private readonly relayKeys: Map<string, Hex>;
  constructor() { this.relayKeys = relayKeysFromEnv(); }

  async view(input: { network: string; address: string; method: string; args: readonly unknown[] }): Promise<unknown> {
    const client = createClient({ chain: resolveChain(input.network) });
    return await client.readContract({
      address: input.address as Address,
      functionName: input.method,
      args: input.args as never,
      jsonSafeReturn: true,
    }) as unknown;
  }

  async send(input: { network: string; address: string; operator: string; call: PreparedCall }): Promise<string> {
    const privateKey = this.relayKeys.get(input.operator.toLowerCase());
    if (!privateKey) throw new Error(`relay mode has no WRK_RELAY_KEYS entry for authenticated operator ${input.operator.toLowerCase()}`);
    const account = createAccount(privateKey);
    const client = createClient({ chain: resolveChain(input.network), account });
    const result: unknown = await client.writeContract({
      account,
      address: input.address as Address,
      functionName: input.call.method,
      args: input.call.args as never,
      value: 0n,
    });
    if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) throw new Error("GenLayerJS did not return a transaction hash");
    return result;
  }
}
