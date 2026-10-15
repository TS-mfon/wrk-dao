/**
 * Collection digests, for the rebuild comparison (§9 rule 4).
 *
 * "Byte for byte" needs a definition, because MongoDB does not guarantee a document's
 * field order and a rebuild writes documents in a different physical order. So the digest
 * is taken over the *canonical* form of each document, sorted by `_id` — the same
 * canonicalisation the protocol already uses for content hashes, which means a digest
 * mismatch is a real difference in content rather than an artefact of storage order.
 *
 * Spot-checking three documents would not do: the gate's whole point is that a rebuild
 * reproduces the collection set, and a difference in the hundredth document matters as
 * much as one in the first.
 */

import { canonicalize, contentHash } from "@wrk/types";
import type { Store } from "./store.js";
import { DERIVED_COLLECTIONS, type CollectionName } from "./collections.js";

export interface CollectionDigest {
  readonly collection: string;
  readonly documents: number;
  readonly digest: string;
}

export async function digestCollection(
  store: Store,
  name: CollectionName,
): Promise<CollectionDigest> {
  const documents = await store.readAll(name);
  // Canonical JSON over the whole sorted array: order within the array is `_id` order,
  // which a rebuild reproduces, and field order inside each document is canonicalised.
  return {
    collection: name,
    documents: documents.length,
    digest: contentHash(documents),
  };
}

export async function digestAll(store: Store): Promise<CollectionDigest[]> {
  const digests: CollectionDigest[] = [];
  for (const name of DERIVED_COLLECTIONS) {
    digests.push(await digestCollection(store, name));
  }
  return digests;
}

/** One digest over every derived collection, for a single-value comparison. */
export async function digestOfReadModel(store: Store): Promise<string> {
  return contentHash(await digestAll(store));
}

/** A human-readable diff of two digest sets, naming only what differs. */
export function diffDigests(
  before: CollectionDigest[],
  after: CollectionDigest[],
): string[] {
  const problems: string[] = [];
  const byName = new Map(after.map((entry) => [entry.collection, entry]));
  for (const entry of before) {
    const other = byName.get(entry.collection);
    if (!other) {
      problems.push(`${entry.collection}: missing after`);
      continue;
    }
    if (other.documents !== entry.documents) {
      problems.push(
        `${entry.collection}: ${entry.documents} document(s) before, ${other.documents} after`,
      );
    } else if (other.digest !== entry.digest) {
      problems.push(
        `${entry.collection}: ${entry.documents} document(s) both times but content differs (${entry.digest.slice(0, 12)}… vs ${other.digest.slice(0, 12)}…)`,
      );
    }
  }
  return problems;
}

export { canonicalize };
