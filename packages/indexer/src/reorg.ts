/**
 * Reorg detection and healing.
 *
 * A read model that drifts after a reorg reports a settlement that did not happen, and
 * because the database is never authoritative the error surfaces as a confusing UI rather
 * than a crash — which makes it harder to notice, not less important.
 *
 * Detection compares the hashes recorded in the checkpoint against what the chain now
 * reports for those same heights. Healing rewinds to the last height that still agrees,
 * deletes every document derived above it, and lets the normal indexing path re-derive
 * them from the replacement blocks.
 */

import { loadCheckpoint, newCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { REORG_WINDOW } from "./config.js";
import type { ChainSource } from "./sources/source.js";
import type { Store } from "./store.js";

export interface ReorgOutcome {
  readonly detected: boolean;
  /** The last height whose hash still matches what was recorded. */
  readonly commonAncestor: number;
  readonly documentsRemoved: number;
  readonly orphanedBlocks: number[];
}

export async function detectAndHeal(
  store: Store,
  source: ChainSource,
  _depth: number = 0,
): Promise<ReorgOutcome> {
  const checkpoint = await loadCheckpoint(store, source.chainId);
  if (!checkpoint || checkpoint.recent.length === 0) {
    return { detected: false, commonAncestor: checkpoint?.block ?? 0, documentsRemoved: 0, orphanedBlocks: [] };
  }

  // Walk the recorded window newest-first and find the first height that still agrees.
  const orphaned: number[] = [];
  let ancestor = -1;
  for (let index = checkpoint.recent.length - 1; index >= 0; index -= 1) {
    const recorded = checkpoint.recent[index]!;
    const current = await source.blockHash(recorded.block);
    if (current !== null && current === recorded.hash) {
      ancestor = recorded.block;
      break;
    }
    orphaned.unshift(recorded.block);
  }

  if (orphaned.length === 0) {
    return { detected: false, commonAncestor: checkpoint.block, documentsRemoved: 0, orphanedBlocks: [] };
  }

  // Every recorded hash disagrees: rewind to before the whole window rather than guess.
  const rewindTo = ancestor === -1 ? Math.max(checkpoint.recent[0]!.block - 1, 0) : ancestor;

  const documentsRemoved = await store.dropAbove(source.chainId, rewindTo);

  if (rewindTo === 0) {
    // Nothing of this chain's history survives; the checkpoint has to go too, or a
    // resume would start above blocks that were never indexed.
    await saveCheckpoint(
      store,
      newCheckpoint(source.chainId, 0, `0x${"0".repeat(64)}`, [], REORG_WINDOW),
    );
  } else {
    const hash = await source.blockHash(rewindTo);
    if (!hash) {
      throw new Error(
        `block ${rewindTo} on chain ${source.chainId} vanished while healing a reorg`,
      );
    }
    await saveCheckpoint(
      store,
      newCheckpoint(
        source.chainId,
        rewindTo,
        hash,
        checkpoint.recent.filter((entry) => entry.block <= rewindTo),
        REORG_WINDOW,
      ),
    );
  }

  return {
    detected: true,
    commonAncestor: rewindTo,
    documentsRemoved,
    orphanedBlocks: orphaned,
  };
}
