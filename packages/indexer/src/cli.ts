#!/usr/bin/env node
/**
 * `wrk-indexer` — index, rebuild, or report on the read model.
 *
 *   wrk-indexer index   [--chain <name>] [--once]
 *   wrk-indexer rebuild --from-block 0 [--chain <name>]
 *   wrk-indexer digest  [--json]
 *   wrk-indexer status
 *
 * `rebuild` insists on `--from-block 0`. A partial rebuild sounds useful and is not: the
 * property §9 rule 4 asks for is that the collection set is reproducible from chain state,
 * and rebuilding part of it leaves documents nobody re-derived while reporting success.
 */

import { CHAINS, chainNameOf, mongoConfigFromEnv, rpcUrl, type ChainName } from "./config.js";
import { digestAll, digestOfReadModel } from "./digest.js";
import { indexOnce, indexToTip } from "./indexer.js";
import { loadCheckpoint } from "./checkpoint.js";
import { rebuildFromZero } from "./rebuild.js";
import { Store } from "./store.js";
import { BaseSource } from "./sources/base.js";
import { GenLayerSource } from "./sources/genlayer.js";
import type { ChainSource } from "./sources/source.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function addressesFor(name: ChainName): string[] {
  const key = {
    "base-sepolia": "WRK_BASE_ADDRESSES",
    studionet: "WRK_STUDIONET_ADDRESSES",
    bradbury: "WRK_BRADBURY_ADDRESSES",
  }[name];
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set, so chain ${name} has no contracts to watch`);
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function sourceFor(name: ChainName): ChainSource {
  const config = CHAINS[name];
  const addresses = addressesFor(name);
  if (config.kind === "evm") {
    return new BaseSource({
      chainId: config.chainId,
      rpcUrl: rpcUrl(name),
      addresses: addresses as `0x${string}`[],
    });
  }
  return new GenLayerSource({ chainId: config.chainId, rpcUrl: rpcUrl(name), addresses });
}

function selectedChains(): ChainName[] {
  const requested = flag("chain");
  if (!requested) return Object.keys(CHAINS) as ChainName[];
  if (!(requested in CHAINS)) throw new Error(`unknown chain ${requested}`);
  return [requested as ChainName];
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const store = await Store.open(mongoConfigFromEnv());
  try {
    await store.ensureIndexes();

    if (command === "index") {
      const sources = selectedChains().map(sourceFor);
      for (const source of sources) {
        const passes = has("once")
          ? [await indexOnce(store, source)]
          : await indexToTip(store, source);
        const events = passes.reduce((total, pass) => total + pass.events, 0);
        const last = passes[passes.length - 1]!;
        const reorgs = passes.filter((pass) => pass.reorg.detected).length;
        console.log(
          `chain ${source.chainId}: ${events} event(s) to block ${last.to}` +
            (reorgs ? `, ${reorgs} reorg(s) healed` : ""),
        );
      }
      return 0;
    }

    if (command === "rebuild") {
      if (flag("from-block") !== "0") {
        console.error("rebuild requires --from-block 0; a partial rebuild is not a rebuild");
        return 2;
      }
      const sources = selectedChains().map(sourceFor);
      const events = await rebuildFromZero(store, sources);
      console.log(`rebuilt from block 0: ${events} event(s) applied`);
      console.log(`read model digest ${await digestOfReadModel(store)}`);
      return 0;
    }

    if (command === "digest") {
      const digests = await digestAll(store);
      if (has("json")) {
        console.log(JSON.stringify({ collections: digests, digest: await digestOfReadModel(store) }, null, 2));
      } else {
        for (const entry of digests) {
          console.log(`${entry.collection.padEnd(22)} ${String(entry.documents).padStart(6)}  ${entry.digest}`);
        }
        console.log(`\nread model digest ${await digestOfReadModel(store)}`);
      }
      return 0;
    }

    if (command === "status") {
      for (const name of Object.keys(CHAINS) as ChainName[]) {
        const config = CHAINS[name];
        const checkpoint = await loadCheckpoint(store, config.chainId);
        console.log(
          `${name.padEnd(14)} chain ${String(config.chainId).padStart(6)}  ` +
            (checkpoint ? `block ${checkpoint.block}` : "not indexed"),
        );
      }
      return 0;
    }

    console.error("usage: wrk-indexer <index|rebuild|digest|status> [options]");
    return 2;
  } finally {
    await store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

export { chainNameOf };
