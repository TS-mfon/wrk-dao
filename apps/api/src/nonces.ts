import { createHash } from "node:crypto";
import { MongoServerError, type Db, type Collection } from "mongodb";
import type { NonceLog } from "./auth.js";

interface NonceDocument {
  _id: string;
  expires_at: Date;
}

/** Shared replay protection, retained across restarts and read-model rebuilds.
 * This records already authenticated requests and never establishes authority.
 */
export class MongoNonceLog implements NonceLog {
  private readonly collection: Collection<NonceDocument>;

  constructor(db: Db) {
    this.collection = db.collection<NonceDocument>("api_request_nonces");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  }

  async claim(agentId: string, nonce: string, expiresAtUnix: number, namespace = ""): Promise<boolean> {
    const id = createHash("sha256").update(JSON.stringify([namespace, agentId, nonce])).digest("hex");
    try {
      await this.collection.insertOne({ _id: id, expires_at: new Date(expiresAtUnix * 1000) });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return false;
      throw error;
    }
  }
}
