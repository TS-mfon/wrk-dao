/**
 * The chain-source interface.
 *
 * Three implementations sit behind it: `GenLayerSource` and `BaseSource` read real
 * networks, and `ReplaySource` is a deterministic in-memory chain.
 *
 * `ReplaySource` is not a shortcut. A reorg cannot be requested from Base Sepolia, so the
 * only way to test that the read model heals from one is to drive a chain that can be made
 * to reorg on demand. The live sources are exercised against real networks by the
 * end-to-end suite; the read-model logic is exercised here, where every block is
 * reproducible.
 */

import type { DecodedEvent } from "../events.js";

export interface ChainSource {
  readonly chainId: number;
  readonly kind: "evm" | "genlayer";
  /** The current head. */
  tip(): Promise<number>;
  /** Canonical hash of a block, or null if that height does not exist. */
  blockHash(block: number): Promise<string | null>;
  /** Every event this source understands in `[from, to]`, in (block, log_index) order. */
  logs(from: number, to: number): Promise<DecodedEvent[]>;
}

/** Orders events the way the indexer must apply them, and the way a rebuild reproduces. */
export function byChainOrder(a: DecodedEvent, b: DecodedEvent): number {
  if (a.ref.block !== b.ref.block) return a.ref.block - b.ref.block;
  return a.ref.log_index - b.ref.log_index;
}
