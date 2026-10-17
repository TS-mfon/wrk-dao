import { afterAll, describe, expect, it } from "vitest";
import { ReplaySource } from "../src/sources/replay.js";
import { indexOnce, indexToTip } from "../src/indexer.js";
import { loadCheckpoint } from "../src/checkpoint.js";
import { digestAll, diffDigests } from "../src/digest.js";
import { freshStore, stopMongo, HASH, operatorFor, ulid, profileFields } from "./helpers.js";

afterAll(stopMongo);

const CHAIN = 61999;
const registration = (tag: string, variant = "a") => ({
  name: "AgentRegistered",
  source: "genlayer" as const,
  indexed: { agent_id: ulid("agt", tag) },
  blob: {
    // Derived per (tag, variant): each agent needs its own operator, and a reorg
    // replacement needs a different one from the block it replaces.
    operator: operatorFor(`${tag}:${variant}`),
    ...profileFields(ulid("agt", tag), operatorFor(`${tag}:${variant}`)),
    registered_at: 1800000000,
  },
});

describe("the indexing loop", () => {
  it("does not advance past the finality bound", async () => {
    const { store } = await freshStore("finality");
    try {
      const source = new ReplaySource(CHAIN);
      for (const tag of ["A1", "A2", "A3", "A4", "A5"]) source.append([registration(tag)]);
      // Depth 2 over a 5-block chain: blocks 4 and 5 are still orphan-able.
      await indexToTip(store, source, { finalityDepth: 2 });
      expect((await loadCheckpoint(store, CHAIN))?.block).toBe(3);
      expect(await store.count("agents")).toBe(3);
    } finally {
      await store.close();
    }
  });

  it("reports idle rather than failing when nothing is finalized", async () => {
    const { store } = await freshStore("idle");
    try {
      const source = new ReplaySource(CHAIN);
      source.append([registration("A1")]);
      const pass = await indexOnce(store, source, { finalityDepth: 8 });
      expect(pass.idle).toBe(true);
      expect(pass.events).toBe(0);
      expect(await store.count("agents")).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("re-applies a range safely after a crash before the checkpoint advanced", async () => {
    const { store } = await freshStore("crash");
    try {
      const source = new ReplaySource(CHAIN);
      for (const tag of ["A1", "A2", "A3"]) source.append([registration(tag)]);
      await indexToTip(store, source, { finalityDepth: 0 });
      const before = await digestAll(store);
      // The checkpoint is written last, so a crash mid-range means the range runs again.
      await indexOnce(store, source, { finalityDepth: 0 });
      expect(diffDigests(before, await digestAll(store))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("stops on an event it does not understand instead of indexing past it", async () => {
    const { store } = await freshStore("unknown");
    try {
      const source = new ReplaySource(CHAIN);
      source.append([registration("A1")]);
      source.append([{ name: "FromTheFuture", source: "genlayer", indexed: {}, blob: {} }]);
      source.append([registration("A2")]);
      await expect(indexToTip(store, source, { finalityDepth: 0 })).rejects.toThrow(
        /no handler for event FromTheFuture/,
      );
      // Block 1 landed; nothing after the unknown event did.
      expect(await store.count("agents")).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("records a hash for every block it indexed", async () => {
    const { store } = await freshStore("hashes");
    try {
      const source = new ReplaySource(CHAIN);
      for (const tag of ["A1", "A2", "A3"]) source.append([registration(tag)]);
      await indexToTip(store, source, { finalityDepth: 0 });
      const checkpoint = await loadCheckpoint(store, CHAIN);
      expect(checkpoint?.recent.map((entry) => entry.block)).toEqual([1, 2, 3]);
      for (const entry of checkpoint!.recent) {
        expect(await source.blockHash(entry.block)).toBe(entry.hash);
      }
    } finally {
      await store.close();
    }
  });

  it("gives a rewritten block a different hash, so a reorg is visible at all", async () => {
    const source = new ReplaySource(CHAIN);
    source.append([registration("A1")]);
    const before = await source.blockHash(1);
    source.reorg(1, [[registration("A1", "b")]], "b");
    expect(await source.blockHash(1)).not.toBe(before);
  });
});
