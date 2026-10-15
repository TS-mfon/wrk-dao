/**
 * Per-chain checkpoints.
 *
 * The one rule that matters: **a checkpoint never advances past a block that could still
 * be orphaned.** It stops at `tip - finalityDepth`, and it keeps the recent block hashes
 * it has seen so that a reorg below that bound is detectable rather than invisible.
 *
 * Without the recent-hash window, an indexer that restarts after a reorg has no way to
 * tell that the blocks it recorded are gone: the heights still exist, so a naive
 * "resume from checkpoint + 1" silently keeps documents derived from a history that no
 * longer happened.
 */

import { REORG_WINDOW } from "./config.js";
import { checkpointSchema, type CheckpointDoc } from "./schemas.js";
import type { Store } from "./store.js";

export const CHECKPOINT_COLLECTION = "indexer_checkpoints" as const;

function documentId(chain: number): string {
  return `chain:${chain}`;
}

export async function loadCheckpoint(
  store: Store,
  chain: number,
): Promise<CheckpointDoc | null> {
  const found = await store.collection(CHECKPOINT_COLLECTION).findOne({ _id: documentId(chain) as never });
  if (!found) return null;
  const parsed = checkpointSchema.safeParse(found);
  if (!parsed.success) {
    throw new Error(
      `checkpoint for chain ${chain} is malformed, refusing to resume from it: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

export async function saveCheckpoint(
  store: Store,
  checkpoint: CheckpointDoc,
): Promise<void> {
  const parsed = checkpointSchema.parse(checkpoint);
  const { _id, ...fields } = parsed;
  await store
    .collection(CHECKPOINT_COLLECTION)
    .updateOne({ _id: _id as never }, { $set: fields }, { upsert: true });
}

export function newCheckpoint(
  chain: number,
  block: number,
  blockHash: string,
  recent: ReadonlyArray<{ block: number; hash: string }>,
  window: number = REORG_WINDOW,
): CheckpointDoc {
  return checkpointSchema.parse({
    _id: documentId(chain),
    chain,
    block,
    block_hash: blockHash,
    // Bounded by REORG_WINDOW, not by the finality depth. Bounding it by the depth kept
    // a single hash whenever the indexer was configured to index to the tip, which made
    // the deep reorg -- the only kind that can reach committed documents -- impossible to
    // locate: detection could see that the tip had changed but not how far back the
    // rewrite went. Recorded as BUGS.md BUG-025.
    recent: dedupe(recent).slice(-Math.max(window, 1)),
    updated_at: Math.max(block, 1),
  });
}

/** Keeps one entry per height, newest winning, so a re-index cannot double a block. */
function dedupe(
  recent: ReadonlyArray<{ block: number; hash: string }>,
): Array<{ block: number; hash: string }> {
  const byBlock = new Map<number, string>();
  for (const entry of recent) byBlock.set(entry.block, entry.hash);
  return [...byBlock.entries()]
    .map(([block, hash]) => ({ block, hash }))
    .sort((a, b) => a.block - b.block);
}

export async function deleteCheckpoint(store: Store, chain: number): Promise<void> {
  await store.collection(CHECKPOINT_COLLECTION).deleteOne({ _id: documentId(chain) as never });
}

/**
 * The highest block it is safe to index to.
 *
 * Returns `-1` when the chain has not produced enough blocks to have a finalized region
 * at all, which the caller must treat as "nothing to do" rather than as block 0.
 */
export function safeTarget(tip: number, depth: number): number {
  const target = tip - depth;
  return target < 1 ? -1 : target;
}
