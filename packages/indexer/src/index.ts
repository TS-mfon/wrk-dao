/**
 * `@wrk/indexer` — the read model.
 *
 * **Invariant I10: nothing here can authorize a settlement.** This package writes and
 * reads a projection of chain state and exposes no signer, no private key, no transaction
 * builder, and no function that returns a settlement input. The settlement adapter takes
 * its mandate id, amount and payees from the chain, never from a database row — and
 * `verify/read-only.mjs` asserts that from this package's built surface rather than
 * trusting the sentence above.
 *
 * Deleting this package would leave the escrow settling exactly as before, only without
 * anything pleasant to look at.
 */

export {
  CHAINS,
  chainConfig,
  chainNameOf,
  mongoConfigFromEnv,
  rpcUrl,
  type ChainConfig,
  type ChainName,
  type MongoConfig,
} from "./config.js";

export {
  COLLECTIONS,
  DERIVED_COLLECTIONS,
  collectionSpec,
  type CollectionName,
  type CollectionSpec,
} from "./collections.js";

export * from "./schemas.js";

export {
  HANDLERS,
  coveredEvents,
  handlerFor,
  project,
  sequenceOf,
  type DecodedEvent,
  type EventHandler,
  type Upsert,
} from "./events.js";

export { Store, ValidationFailed, storageKey, objectQuery, validateDocument } from "./store.js";

export {
  CHECKPOINT_COLLECTION,
  deleteCheckpoint,
  loadCheckpoint,
  newCheckpoint,
  safeTarget,
  saveCheckpoint,
} from "./checkpoint.js";

export { detectAndHeal, type ReorgOutcome } from "./reorg.js";

export { indexOnce, indexToTip, type IndexOptions, type PassResult } from "./indexer.js";

export {
  rebuildAndCompare,
  rebuildFromZero,
  type RebuildResult,
} from "./rebuild.js";

export {
  diffDigests,
  digestAll,
  digestCollection,
  digestOfReadModel,
  type CollectionDigest,
} from "./digest.js";

export { byChainOrder, type ChainSource } from "./sources/source.js";
export { ReplaySource, type ReplayEvent } from "./sources/replay.js";
export { BASE_EVENT_ABI, BaseSource, decodeBaseLog, type BaseSourceOptions } from "./sources/base.js";
export {
  GENLAYER_EVENT_INDEXED,
  GenLayerSource,
  decodeGenLayerLog,
  signatureOf,
  topic0Of,
  type GenLayerRawLog,
  type GenLayerSourceOptions,
} from "./sources/genlayer.js";
