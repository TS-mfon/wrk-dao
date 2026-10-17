import { describe, expect, it } from "vitest";
import { HANDLERS, coveredEvents, handlerFor, project, sequenceOf } from "../src/events.js";
import { HASH, ulid, ref, profileFields } from "./helpers.js";

describe("the event catalogue", () => {
  it("refuses an event it does not know, rather than skipping it", () => {
    // Skipping would leave every later document derived from an incomplete picture, and
    // the read model would look healthy while being wrong.
    expect(() =>
      project({ name: "SomethingNew", source: "genlayer", indexed: {}, blob: {}, ref: ref(1) }),
    ).toThrow(/no handler for event SomethingNew/);
  });

  it("refuses an event arriving from the wrong chain", () => {
    expect(() =>
      project({
        name: "AgentRegistered",
        source: "base",
        indexed: { agent_id: ulid("agt", "A1") },
        blob: {},
        ref: ref(1),
      }),
    ).toThrow(/catalogue expects genlayer/);
  });

  it("orders events by block then log index", () => {
    expect(sequenceOf(ref(2, 0))).toBeGreaterThan(sequenceOf(ref(1, 999_999)));
    expect(sequenceOf(ref(1, 5))).toBeGreaterThan(sequenceOf(ref(1, 4)));
  });

  it("derives updated_at from the chain, never from the clock", () => {
    // A rebuild must reproduce the collections byte for byte; Date.now() would make that
    // impossible, so this is asserted rather than assumed.
    const [upsert] = project({
      name: "AgentRegistered",
      source: "genlayer",
      indexed: { agent_id: ulid("agt", "A1") },
      blob: { operator: `0x${"a1".repeat(20)}`, ...profileFields(ulid("agt", "A1"), `0x${"a1".repeat(20)}`), registered_at: 1800000000 },
      ref: ref(42),
    });
    expect(upsert!.set.updated_at).toBe(42);
  });

  it("lowercases every address and hash it stores", () => {
    const [upsert] = project({
      name: "AgentRegistered",
      source: "genlayer",
      indexed: { agent_id: ulid("agt", "A1") },
      blob: { operator: `0x${"A1".repeat(20)}`, ...profileFields(ulid("agt", "A1"), `0x${"A1".repeat(20)}`), registered_at: 1800000000 },
      ref: ref(1),
    });
    expect(upsert!.set.operator).toBe(`0x${"a1".repeat(20)}`);
    expect(String(upsert!.set.profile_hash)).toBe(profileFields(ulid("agt", "A1"), `0x${"A1".repeat(20)}`).profile_hash);
  });

  it("keys a membership on the pair, so the same membership is one document", () => {
    const dao = ulid("dao", "D1");
    const agent = ulid("agt", "A2");
    const upserts = project({
      name: "MemberJoined",
      source: "genlayer",
      indexed: { agent_id: agent, dao_id: dao },
      blob: { mode: "joined" },
      ref: ref(3),
    });
    expect(upserts[0]!.id).toBe(`${dao}|${agent}`);
    // And the agent's dao list grows by a replay-safe operator.
    expect(upserts[1]!.addToSet).toEqual({ dao_ids: dao });
  });

  it("routes a custody relay to the leg it refers to", () => {
    const mandate = ulid("mnd", "N1");
    const funded = project({
      name: "CustodyRelayed",
      source: "genlayer",
      indexed: { mandate_id: mandate },
      blob: { state: "FUNDED", base_tx_hash: HASH("1a") },
      ref: ref(5),
    });
    expect(funded[0]!.set.funding_tx).toBe(HASH("1a"));
    const settled = project({
      name: "CustodyRelayed",
      source: "genlayer",
      indexed: { mandate_id: mandate },
      blob: { state: "SETTLED", base_tx_hash: HASH("2b") },
      ref: ref(6),
    });
    expect(settled[0]!.set.settlement_tx).toBe(HASH("2b"));
  });

  it("declares a handler for every event and nothing more", () => {
    expect(coveredEvents()).toHaveLength(HANDLERS.length);
    expect(new Set(coveredEvents()).size).toBe(HANDLERS.length);
    expect(handlerFor("AgentRegistered")?.creates).toBe(true);
    expect(handlerFor("MissionStateChanged")?.creates).toBe(false);
  });

  it("uses no operator that a replay would apply twice", () => {
    for (const handler of HANDLERS) {
      const source = handler.handle.toString();
      for (const forbidden of ["$inc", "$push", "$pull"]) {
        expect(source, `${handler.event} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
