/**
 * The read model's only writer.
 *
 * Two rules are enforced here rather than trusted:
 *
 * **Validate on write and on read.** There is no database-level schema (§3.2), so a
 * document that does not conform is rejected at both boundaries. Validating on read is
 * not redundant: it catches a document written by an older version of this package, or by
 * hand, which a write-side check never sees.
 *
 * **Idempotent upserts only.** The write API offers `$set`, `$setOnInsert` and
 * `$addToSet`. It deliberately does not offer `$inc`, `$push` or a raw update, because
 * each would make replaying a block change the result — and `indexer rebuild` replaying
 * every block is the property the whole MongoDB deviation rests on (§3.2).
 */

import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import {
  COLLECTIONS,
  DERIVED_COLLECTIONS,
  collectionSpec,
  type CollectionName,
} from "./collections.js";
import type { Upsert } from "./events.js";
import type { MongoConfig } from "./config.js";

export const storageKey = (chain: number, id: string): string => `${chain}:${id}`;

/** Includes legacy keys while an existing read model is being rebuilt. */
export function objectQuery(id: string, chain?: number): Document {
  if (chain !== undefined) {
    return { _id: { $in: [storageKey(chain, id), id] }, "chain_ref.chain": chain };
  }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { _id: { $regex: `^(?:[0-9]+:)?${escaped}$` } };
}

export function validateDocument(name: CollectionName, document: Document): Record<string, unknown> {
  const parsed = collectionSpec(name).schema.safeParse(document);
  if (!parsed.success) {
    throw new ValidationFailed(name, String(document._id), "read",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data as Record<string, unknown>;
}

export class ValidationFailed extends Error {
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly direction: "write" | "read",
    readonly detail: string,
  ) {
    super(`${collection}/${id} failed validation on ${direction}: ${detail}`);
    this.name = "ValidationFailed";
  }
}

export class Store {
  private constructor(
    private readonly client: MongoClient,
    readonly db: Db,
  ) {}

  static async open(config: MongoConfig): Promise<Store> {
    const client = new MongoClient(config.uri, {
      // Fail fast and loudly. A read model that blocks for 30s on an unreachable server
      // turns a configuration error into a timeout nobody attributes correctly.
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    await client.connect();
    return new Store(client, client.db(config.database));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  collection(name: CollectionName): Collection<Document> {
    return this.db.collection(COLLECTIONS[name].name);
  }

  /** Creates every declared index. Idempotent, so it is safe on every start. */
  async ensureIndexes(): Promise<void> {
    for (const name of Object.keys(COLLECTIONS) as CollectionName[]) {
      // Through the accessor, not COLLECTIONS[name]: `as const satisfies` narrows each
      // entry to its own literal type, on which an absent optional field does not exist.
      const spec = collectionSpec(name);
      for (const index of spec.indexes) {
        const keys = name === "indexer_checkpoints" ? index.keys : { "chain_ref.chain": 1 as const, ...index.keys };
        const indexes = await this.collection(name).listIndexes().toArray().catch((error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === 26) return [];
          throw error;
        });
        const existing = indexes.find((candidate) => candidate.name === index.name);
        if (existing && JSON.stringify(existing.key) !== JSON.stringify(keys)) {
          await this.collection(name).dropIndex(index.name);
        }
        await this.collection(name).createIndex(keys, {
          name: index.name,
          unique: index.unique ?? false,
        });
      }
    }
  }

  /**
   * Applies one upsert, validating the resulting document before it is committed.
   *
   * Validation runs against the *merged* document, not against the patch, because a
   * patch can be individually sensible and still produce an invalid document — a state
   * transition arriving for a mission that was never created is the common case.
   */
  async apply(upsert: Upsert): Promise<void> {
    const spec = collectionSpec(upsert.collection);
    const collection = this.collection(upsert.collection);
    const chain = (upsert.set.chain_ref as { chain?: number } | undefined)?.chain;
    const matches = await collection.find(objectQuery(upsert.id, chain)).limit(2).toArray();
    if (matches.length > 1) throw new Error(`chain is required for ambiguous ${upsert.collection}/${upsert.id}`);
    const existing = matches[0];
    const resolvedChain = chain ?? (existing?.chain_ref as { chain?: number } | undefined)?.chain;
    const key = existing?._id ?? (resolvedChain === undefined ? upsert.id : storageKey(resolvedChain, upsert.id));
    // A crashed indexer can replay an old range; do not regress newer object state.
    if (existing && typeof upsert.set.seq === "number" && Number(existing.seq) > upsert.set.seq) return;

    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      ...(existing ? {} : (upsert.setOnInsert ?? {})),
      ...upsert.set,
      _id: key,
    };

    for (const [field, value] of Object.entries(upsert.addToSet ?? {})) {
      const current = Array.isArray(merged[field]) ? (merged[field] as unknown[]) : [];
      merged[field] = current.includes(value) ? current : [...current, value];
    }

    const parsed = spec.schema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationFailed(
        spec.name,
        upsert.id,
        "write",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }

    // The validated document is written whole. Writing the patch instead would let an
    // unvalidated field survive from the existing document into the stored one.
    const document = parsed.data as Record<string, unknown>;
    const { _id, ...fields } = document;
    const guard = existing ? { _id: key, seq: existing.seq } : { _id: key };
    const result = await collection.updateOne(
      guard as never,
      { $set: fields as Document },
      { upsert: !existing },
    );
    if (existing && result.matchedCount === 0) await this.apply(upsert);
  }

  /** Reads one document, validating it. An invalid stored document is an error. */
  async read(name: CollectionName, id: string, chain?: number): Promise<Record<string, unknown> | null> {
    const matches = await this.collection(name).find(objectQuery(id, chain)).limit(2).toArray();
    if (matches.length > 1) throw new Error(`chain is required for ambiguous ${name}/${id}`);
    const found = matches[0];
    if (!found) return null;
    const parsed = collectionSpec(name).schema.safeParse(found);
    if (!parsed.success) {
      throw new ValidationFailed(
        collectionSpec(name).name,
        id,
        "read",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  /** Every document in a collection, in `_id` order, validated. */
  async readAll(name: CollectionName): Promise<Record<string, unknown>[]> {
    const documents = await this.collection(name).find({}).sort({ _id: 1 }).toArray();
    return documents.map((document) => {
      const parsed = collectionSpec(name).schema.safeParse(document);
      if (!parsed.success) {
        throw new ValidationFailed(
          collectionSpec(name).name,
          String(document._id),
          "read",
          parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        );
      }
      return parsed.data as Record<string, unknown>;
    });
  }

  async count(name: CollectionName, filter: Document = {}): Promise<number> {
    return this.collection(name).countDocuments(filter);
  }

  /**
   * Removes every document derived from blocks above `block` on `chain`.
   *
   * Used by the reorg path. It deletes rather than patches because a document derived
   * from an orphaned block has no correct value to patch to — it is re-derived from the
   * replacement blocks instead.
   */
  async dropAbove(chain: number, block: number): Promise<number> {
    let removed = 0;
    for (const name of DERIVED_COLLECTIONS) {
      const result = await this.collection(name).deleteMany({
        "chain_ref.chain": chain,
        "chain_ref.block": { $gt: block },
      });
      removed += result.deletedCount;
    }
    return removed;
  }

  /** Drops every derived collection. The rebuild path's starting point. */
  async clearDerived(): Promise<void> {
    for (const name of DERIVED_COLLECTIONS) {
      await this.collection(name).deleteMany({});
    }
  }
}
