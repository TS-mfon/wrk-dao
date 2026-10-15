/**
 * `rebuild --from-block 0`.
 *
 * This is the gate that justifies the whole MongoDB deviation (§3.2): the read model is
 * disposable because it can always be re-derived from chain state. If this stops working,
 * the justification collapses — so it is verified rather than asserted, and the
 * comparison is a digest over every document rather than a spot check.
 *
 * `rebuild` is also the migration story. There are no schema migrations for the read
 * model; there is this.
 */

import { deleteCheckpoint } from "./checkpoint.js";
import { digestAll, diffDigests, type CollectionDigest } from "./digest.js";
import { indexToTip, type IndexOptions } from "./indexer.js";
import type { ChainSource } from "./sources/source.js";
import type { Store } from "./store.js";

export interface RebuildResult {
  readonly before: CollectionDigest[];
  readonly after: CollectionDigest[];
  readonly identical: boolean;
  readonly differences: string[];
  readonly events: number;
}

/**
 * Captures the current read model, drops it, re-derives it from block zero, and compares.
 *
 * Takes every source, not one: a read model derived from two chains is only reproducible
 * if both are replayed, and rebuilding from one would silently drop the other's documents
 * and then report a difference that looks like a bug in the indexer.
 */
export async function rebuildAndCompare(
  store: Store,
  sources: readonly ChainSource[],
  options: IndexOptions = {},
): Promise<RebuildResult> {
  const before = await digestAll(store);

  await store.clearDerived();
  for (const source of sources) await deleteCheckpoint(store, source.chainId);

  let events = 0;
  for (const source of sources) {
    for (const pass of await indexToTip(store, source, options)) events += pass.events;
  }

  const after = await digestAll(store);
  const differences = diffDigests(before, after);
  return { before, after, identical: differences.length === 0, differences, events };
}

/** Derives the read model from scratch without comparing. Used on a cold start. */
export async function rebuildFromZero(
  store: Store,
  sources: readonly ChainSource[],
  options: IndexOptions = {},
): Promise<number> {
  await store.clearDerived();
  for (const source of sources) await deleteCheckpoint(store, source.chainId);
  let events = 0;
  for (const source of sources) {
    for (const pass of await indexToTip(store, source, options)) events += pass.events;
  }
  return events;
}
