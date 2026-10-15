/**
 * A deterministic in-memory chain.
 *
 * Exists for the one property that cannot be tested against a live network: a reorg.
 * Base Sepolia will not reorganise on request, so a read model's healing path can only be
 * driven by a chain whose history can be rewritten deliberately.
 *
 * Every block has a hash derived from its contents, so rewriting history changes the
 * hashes the indexer will compare against — which is what makes the detection path real
 * rather than simulated.
 */

import { contentHash } from "@wrk/types";
import type { DecodedEvent } from "../events.js";
import { byChainOrder, type ChainSource } from "./source.js";

export interface ReplayEvent {
  readonly name: string;
  readonly source: "genlayer" | "base";
  readonly indexed: Record<string, string>;
  readonly blob: Record<string, string | number | boolean>;
}

interface ReplayBlock {
  readonly number: number;
  readonly events: ReplayEvent[];
  /** Distinguishes two blocks with identical contents at the same height. */
  readonly nonce: string;
}

export class ReplaySource implements ChainSource {
  readonly kind: "evm" | "genlayer";
  private blocks: ReplayBlock[] = [];

  constructor(
    readonly chainId: number,
    kind: "evm" | "genlayer" = "genlayer",
  ) {
    this.kind = kind;
  }

  /** Appends a block holding `events`. Returns its height. */
  append(events: ReplayEvent[], nonce = "a"): number {
    const number = this.blocks.length + 1;
    this.blocks.push({ number, events, nonce });
    return number;
  }

  /**
   * Rewrites history from `fromBlock` onward, replacing it with `replacement`.
   *
   * The returned heights keep their numbers but get new hashes, which is precisely the
   * situation a reorg presents to an indexer that recorded the old ones.
   */
  reorg(fromBlock: number, replacement: ReplayEvent[][], nonce = "b"): void {
    if (fromBlock < 1) throw new Error("cannot reorg below block 1");
    this.blocks = this.blocks.slice(0, fromBlock - 1);
    for (const events of replacement) this.append(events, nonce);
  }

  async tip(): Promise<number> {
    return this.blocks.length;
  }

  async blockHash(block: number): Promise<string | null> {
    const found = this.blocks[block - 1];
    if (!found) return null;
    // Derived from contents, so a rewritten block cannot keep its old hash.
    return contentHash({
      chain: this.chainId,
      block: found.number,
      nonce: found.nonce,
      events: found.events,
    });
  }

  async logs(from: number, to: number): Promise<DecodedEvent[]> {
    const out: DecodedEvent[] = [];
    for (let number = Math.max(1, from); number <= Math.min(to, this.blocks.length); number += 1) {
      const block = this.blocks[number - 1];
      if (!block) continue;
      const hash = (await this.blockHash(number))!;
      block.events.forEach((event, logIndex) => {
        out.push({
          name: event.name,
          source: event.source,
          indexed: event.indexed,
          blob: event.blob,
          ref: {
            chain: this.chainId,
            tx_hash: contentHash({ block: number, logIndex, nonce: block.nonce }),
            block: number,
            log_index: logIndex,
            block_hash: hash,
          },
        });
      });
    }
    return out.sort(byChainOrder);
  }
}
