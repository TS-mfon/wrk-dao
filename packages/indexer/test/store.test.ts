import { afterAll, describe, expect, it } from "vitest";
import { ValidationFailed } from "../src/store.js";
import { freshStore, stopMongo, HASH, operatorFor, ulid, ref } from "./helpers.js";

afterAll(stopMongo);

const agent = (id: string, block = 1) => ({
  collection: "agents" as const,
  id,
  set: {
    chain_ref: ref(block),
    seq: block * 1_000_000,
    updated_at: block,
    agent_id: id,
    operator: operatorFor(id),
    profile_hash: HASH("11"),
    registered_at: 1800000000,
  },
  setOnInsert: { capabilities: [], dao_ids: [] },
});

describe("the store", () => {
  it("validates the merged document, not the patch", async () => {
    const { store } = await freshStore("merged");
    try {
      // A state transition is a sensible patch on its own and an invalid document when
      // there is nothing to apply it to.
      await expect(
        store.apply({
          collection: "missions",
          id: ulid("msn", "M1"),
          set: { chain_ref: ref(1), seq: 1_000_000, updated_at: 1, state: "OPEN" },
        }),
      ).rejects.toThrow(ValidationFailed);
      expect(await store.count("missions")).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("refuses to write over a document corrupted outside the store, rather than normalising it away", async () => {
    const { store } = await freshStore("whole");
    try {
      const id = ulid("agt", "A1");
      await store.apply(agent(id));
      // Something wrote to the collection that was not the indexer: a hand edit, or an
      // older version of this package.
      await store.collection("agents").updateOne({ _id: id as never }, { $set: { smuggled: true } });

      // The next write fails loudly and names the offending key. Silently dropping it
      // would be friendlier and wrong: it would hide the fact that something outside the
      // indexer is writing to the read model. The remedy is `rebuild --from-block 0`,
      // which is cheap precisely because this database is disposable.
      await expect(store.apply(agent(id, 2))).rejects.toThrow(/Unrecognized key: "smuggled"/);
      await expect(store.read("agents", id)).rejects.toThrow(ValidationFailed);
    } finally {
      await store.close();
    }
  });

  it("writes the validated document whole, so a dropped field does not linger", async () => {
    const { store } = await freshStore("dropped");
    try {
      const id = ulid("agt", "A1");
      await store.apply(agent(id));
      await store.apply({ collection: "agents", id, set: {}, addToSet: { capabilities: "coding" } });
      expect((await store.read("agents", id))?.capabilities).toEqual(["coding"]);

      // A later event for the same document carries no capabilities, and must not erase
      // them: the merge is over the existing document, so absent is "unchanged", not
      // "cleared".
      await store.apply(agent(id, 3));
      expect((await store.read("agents", id))?.capabilities).toEqual(["coding"]);
    } finally {
      await store.close();
    }
  });

  it("applies setOnInsert only on insert", async () => {
    const { store } = await freshStore("oninsert");
    try {
      const id = ulid("agt", "A1");
      await store.apply(agent(id));
      await store.apply({
        collection: "agents",
        id,
        set: {},
        addToSet: { dao_ids: ulid("dao", "D1") },
      });
      await store.apply(agent(id, 3));
      const stored = await store.read("agents", id);
      // The dao list survives a later write that carries setOnInsert again.
      expect(stored?.dao_ids).toEqual([ulid("dao", "D1")]);
    } finally {
      await store.close();
    }
  });

  it("makes addToSet idempotent", async () => {
    const { store } = await freshStore("addtoset");
    try {
      const id = ulid("agt", "A1");
      const dao = ulid("dao", "D1");
      await store.apply(agent(id));
      for (let n = 0; n < 3; n += 1) {
        await store.apply({ collection: "agents", id, set: {}, addToSet: { dao_ids: dao } });
      }
      expect((await store.read("agents", id))?.dao_ids).toEqual([dao]);
    } finally {
      await store.close();
    }
  });

  it("refuses to return a stored document that does not validate", async () => {
    const { store } = await freshStore("readvalidate");
    try {
      await store.collection("agents").insertOne({ _id: "agt_bad" as never, agent_id: "agt_bad" });
      await expect(store.read("agents", "agt_bad")).rejects.toThrow(ValidationFailed);
    } finally {
      await store.close();
    }
  });

  it("drops only documents above a block, and only for that chain", async () => {
    const { store } = await freshStore("dropabove");
    try {
      await store.apply(agent(ulid("agt", "A1"), 1));
      await store.apply(agent(ulid("agt", "A2"), 5));
      await store.apply({
        ...agent(ulid("agt", "A3"), 7),
        set: { ...agent(ulid("agt", "A3"), 7).set, chain_ref: ref(7, 0, 84532) },
      });
      const removed = await store.dropAbove(61999, 3);
      expect(removed).toBe(1);
      const left = (await store.readAll("agents")).map((d) => d.agent_id);
      expect(left).toContain(ulid("agt", "A1"));
      expect(left).toContain(ulid("agt", "A3")); // other chain, untouched
      expect(left).not.toContain(ulid("agt", "A2"));
    } finally {
      await store.close();
    }
  });

  it("creates the declared indexes and enforces the unique ones", async () => {
    const { store } = await freshStore("indexes");
    try {
      const names = (await store.collection("agents").indexes()).map((index) => index.name);
      expect(names).toContain("operator");
      // One operator controls one agent; the registry enforces it on chain and the read
      // model must not be able to represent a violation. Two ids, deliberately the same
      // operator.
      const first = ulid("agt", "A1");
      const second = ulid("agt", "A2");
      await store.apply(agent(first));
      const collision = agent(second);
      await expect(
        store.apply({ ...collision, set: { ...collision.set, operator: operatorFor(first) } }),
      ).rejects.toThrow(/duplicate key/i);
    } finally {
      await store.close();
    }
  });
});
