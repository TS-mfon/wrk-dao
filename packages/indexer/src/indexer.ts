/**
 * The indexing loop.
 *
 * One pass does four things in this order, and the order is the design:
 *
 *   1. heal any reorg, so nothing below is derived from history that no longer happened;
 *   2. compute a safe target, so the checkpoint cannot reach a block that may still be
 *      orphaned;
 *   3. apply every event in `(block, log_index)` order — the same order a rebuild uses,
 *      which is what makes a rebuild reproduce rather than approximate;
 *   4. advance the checkpoint only after every event in the range is written.
 *
 * Step 4 is the one worth stating plainly: the checkpoint is advanced last, so a crash
 * mid-range re-applies that range on the next pass. Re-applying is safe because every
 * write is an idempotent upsert, and that is the whole reason rule 2 exists.
 */

import { chainConfig, type ChainName } from "./config.js";
import { loadCheckpoint, newCheckpoint, safeTarget, saveCheckpoint } from "./checkpoint.js";
import { project } from "./events.js";
import { detectAndHeal, type ReorgOutcome } from "./reorg.js";
import { byChainOrder, type ChainSource } from "./sources/source.js";
import type { Store } from "./store.js";

export interface PassResult {
  readonly chain: number;
  readonly from: number;
  readonly to: number;
  readonly events: number;
  readonly upserts: number;
  readonly reorg: ReorgOutcome;
  /** True when there was nothing finalized to index. */
  readonly idle: boolean;
}

export interface IndexOptions {
  /** Maximum blocks per pass, so one call cannot read an unbounded range. */
  readonly batch?: number;
  /** Overrides the chain's configured finality depth. Tests use it; nothing else should. */
  readonly finalityDepth?: number;
}

export async function indexOnce(
  store: Store,
  source: ChainSource,
  options: IndexOptions = {},
): Promise<PassResult> {
  const depth = options.finalityDepth ?? depthFor(source.chainId);
  const batch = options.batch ?? 500;

  const reorg = await detectAndHeal(store, source, depth);

  const tip = await source.tip();
  const target = safeTarget(tip, depth);
  const checkpoint = await loadCheckpoint(store, source.chainId);
  const from = (checkpoint?.block ?? 0) + 1;

  if (target < from) {
    return {
      chain: source.chainId,
      from,
      to: checkpoint?.block ?? 0,
      events: 0,
      upserts: 0,
      reorg,
      idle: true,
    };
  }

  const to = Math.min(target, from + batch - 1);
  const events = (await source.logs(from, to)).sort(byChainOrder);

  let upserts = 0;
  for (const event of events) {
    // `project` throws on an unknown event rather than skipping it: an event the model
    // does not understand means every later document is derived from an incomplete
    // picture, which is a condition to stop on.
    for (const upsert of project(event)) {
      await store.apply(upsert);
      upserts += 1;
    }
  }

  const recorded = [...(checkpoint?.recent ?? [])];
  for (let block = from; block <= to; block += 1) {
    const hash = await source.blockHash(block);
    if (!hash) throw new Error(`block ${block} on chain ${source.chainId} has no hash`);
    recorded.push({ block, hash });
  }

  const head = recorded[recorded.length - 1]!;
  await saveCheckpoint(
    store,
    newCheckpoint(source.chainId, to, head.hash, recorded),
  );

  return { chain: source.chainId, from, to, events: events.length, upserts, reorg, idle: false };
}

/** Runs passes until the chain's finalized region is fully indexed. */
export async function indexToTip(
  store: Store,
  source: ChainSource,
  options: IndexOptions = {},
): Promise<PassResult[]> {
  const passes: PassResult[] = [];
  for (;;) {
    const pass = await indexOnce(store, source, options);
    passes.push(pass);
    if (pass.idle) return passes;
    // Guard against a source that reports progress without making any.
    if (passes.length > 10_000) throw new Error("indexToTip made no progress in 10000 passes");
  }
}

function depthFor(chainId: number): number {
  for (const name of Object.keys(
    // Imported lazily through chainConfig to keep this function side-effect free.
    { "base-sepolia": 0, studionet: 0, bradbury: 0 } satisfies Record<ChainName, number>,
  ) as ChainName[]) {
    const config = chainConfig(name);
    if (config.chainId === chainId) return config.finalityDepth;
  }
  throw new Error(`no finality depth configured for chain ${chainId}`);
}
