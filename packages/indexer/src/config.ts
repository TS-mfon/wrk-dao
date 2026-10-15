/**
 * Indexer configuration.
 *
 * Every chain this indexer watches is declared here with the finality depth at which
 * its checkpoint is allowed to advance. That depth is the whole reorg story: a
 * checkpoint that advances to the chain tip will, on the next reorg, have recorded
 * documents for blocks that no longer exist and have no way to know which ones.
 */

/**
 * How many recent block hashes a checkpoint retains, for reorg detection.
 *
 * Deliberately **not** the finality depth. Those are opposite concerns: the finality depth
 * limits how far *forward* the checkpoint may advance, while this limits how far *back* a
 * rewrite can be detected. Bounding the retained window by the finality depth makes a
 * reorg deeper than that depth undetectable — which is precisely the reorg that matters,
 * because a shallower one was never committed to in the first place.
 *
 * 64 blocks is far deeper than either chain reorganises in practice, and the cost is 64
 * hashes in one document per chain.
 */
export const REORG_WINDOW = 64;

/** Chains the read model covers. Chain id is the primary key of a `chain_ref`. */
export const CHAINS = {
  "base-sepolia": { chainId: 84532, kind: "evm", finalityDepth: 8 },
  studionet: { chainId: 61999, kind: "genlayer", finalityDepth: 4 },
  bradbury: { chainId: 4221, kind: "genlayer", finalityDepth: 4 },
} as const satisfies Record<string, ChainConfig>;

export type ChainName = keyof typeof CHAINS;

export interface ChainConfig {
  readonly chainId: number;
  readonly kind: "evm" | "genlayer";
  /**
   * How far behind the tip a checkpoint may advance.
   *
   * The checkpoint never passes `tip - finalityDepth`, so a reorg shallower than this
   * is re-derived from blocks the indexer has not yet committed to. `reorg.ts` handles
   * the deeper case by rewinding; this bound is what makes the deeper case rare rather
   * than routine.
   */
  readonly finalityDepth: number;
}

export function chainConfig(name: ChainName): ChainConfig {
  return CHAINS[name];
}

export function chainNameOf(chainId: number): ChainName {
  for (const [name, config] of Object.entries(CHAINS)) {
    if (config.chainId === chainId) return name as ChainName;
  }
  throw new Error(`no chain configured with id ${chainId}`);
}

export interface MongoConfig {
  readonly uri: string;
  readonly database: string;
}

/**
 * Reads the Mongo connection from the environment.
 *
 * Throws rather than defaulting to localhost. A silent default is how a verification
 * run ends up writing to, or reading from, a database nobody meant to use — and for a
 * read model the symptom is wrong data rather than an error.
 */
export function mongoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  const uri = env.MONGODB_URI;
  const database = env.MONGODB_DB;
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!database) throw new Error("MONGODB_DB is not set");
  return { uri, database };
}

/** RPC endpoints, read from the environment, with no defaults for the same reason. */
export function rpcUrl(name: ChainName, env: NodeJS.ProcessEnv = process.env): string {
  const key = {
    "base-sepolia": "BASE_SEPOLIA_RPC_URL",
    studionet: "GENLAYER_STUDIONET_RPC_URL",
    bradbury: "GENLAYER_BRADBURY_RPC_URL",
  }[name];
  const value = env[key];
  if (!value) throw new Error(`${key} is not set, so chain ${name} cannot be indexed`);
  return value;
}
