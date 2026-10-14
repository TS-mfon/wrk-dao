// G6: the state machines accept every documented transition and reject every other
// ordered pair, checked exhaustively over the full state product.
//
// The expected edge sets below are a SECOND, hand-transcribed copy of the tables in
// docs/ARCHITECTURE.md §6. That duplication is the point: comparing the
// implementation to itself proves nothing, so this gate holds its own copy and any
// divergence fails. Keep this file and src/states.ts in step by editing both from
// the document, never by copying one into the other.

import { check, checkEqual, checkThrows, finish, abort } from "./_common.mjs";

/* Transcribed from docs/ARCHITECTURE.md §6. */

const EXPECTED = {
  mission: {
    states: ["DRAFT", "OPEN", "PROPOSALS_CLOSED", "SELECTING", "SELECTED", "MANDATED", "CANCELLED", "EXPIRED"],
    initial: "DRAFT",
    edges: [
      ["DRAFT", "OPEN"],
      ["OPEN", "PROPOSALS_CLOSED"],
      ["PROPOSALS_CLOSED", "SELECTING"],
      ["SELECTING", "SELECTED"],
      ["SELECTED", "MANDATED"],
      // A mission may be cancelled or expire at any point before it is mandated.
      ["DRAFT", "CANCELLED"],
      ["OPEN", "CANCELLED"],
      ["PROPOSALS_CLOSED", "CANCELLED"],
      ["SELECTING", "CANCELLED"],
      ["SELECTED", "CANCELLED"],
      ["DRAFT", "EXPIRED"],
      ["OPEN", "EXPIRED"],
      ["PROPOSALS_CLOSED", "EXPIRED"],
      ["SELECTING", "EXPIRED"],
      ["SELECTED", "EXPIRED"],
    ],
    terminal: ["MANDATED", "CANCELLED", "EXPIRED"],
  },

  mandate: {
    states: [
      "CREATED",
      "ACCEPTED",
      "FUNDED",
      "IN_PROGRESS",
      "SUBMITTED",
      "ADJUDICATING",
      "ADJUDICATED",
      "SETTLED",
      "REFUNDED",
      "EXPIRED",
      "CANCELLED",
    ],
    initial: "CREATED",
    edges: [
      ["CREATED", "ACCEPTED"],
      ["ACCEPTED", "FUNDED"],
      ["FUNDED", "IN_PROGRESS"],
      ["IN_PROGRESS", "SUBMITTED"],
      ["SUBMITTED", "ADJUDICATING"],
      ["ADJUDICATING", "ADJUDICATED"],
      ["ADJUDICATED", "SETTLED"],
      // Before escrow is funded, exit is CANCELLED or EXPIRED.
      ["CREATED", "CANCELLED"],
      ["ACCEPTED", "CANCELLED"],
      ["CREATED", "EXPIRED"],
      ["ACCEPTED", "EXPIRED"],
      // Once funded, the only non-settling exit is REFUNDED: a terminal state with
      // USDC still locked would be unrecoverable.
      ["FUNDED", "REFUNDED"],
      ["IN_PROGRESS", "REFUNDED"],
      ["SUBMITTED", "REFUNDED"],
      ["ADJUDICATING", "REFUNDED"],
      ["ADJUDICATED", "REFUNDED"],
    ],
    terminal: ["SETTLED", "REFUNDED", "EXPIRED", "CANCELLED"],
  },

  settlement: {
    states: ["NONE", "POSTED", "CHALLENGED", "EXECUTED"],
    initial: "NONE",
    edges: [
      ["NONE", "POSTED"],
      ["POSTED", "CHALLENGED"],
      ["POSTED", "EXECUTED"],
      ["CHALLENGED", "NONE"],
    ],
    terminal: ["EXECUTED"],
  },
};

try {
  const {
    missionMachine,
    mandateMachine,
    settlementMachine,
    MACHINES,
    canTransition,
    assertTransition,
    isTerminal,
    canEditMission,
    SETTLED_PREDECESSORS,
    MISSION_STATES,
    MANDATE_STATES,
    SETTLEMENT_STATES,
  } = await import("../dist/index.js");

  const machines = { mission: missionMachine, mandate: mandateMachine, settlement: settlementMachine };
  checkEqual(MACHINES.length, 3, "three machines are exported");

  let pairs = 0;

  for (const [name, expected] of Object.entries(EXPECTED)) {
    const machine = machines[name];
    check(machine !== undefined, `machine ${name} must be exported`);
    if (machine === undefined) continue;

    // The state set itself, in order.
    checkEqual(machine.states.join(","), expected.states.join(","), `${name}: state set and order`);
    checkEqual(machine.initial, expected.initial, `${name}: initial state`);
    checkEqual(
      [...machine.terminal].sort().join(","),
      [...expected.terminal].sort().join(","),
      `${name}: terminal states`,
    );

    const legal = new Set(expected.edges.map(([from, to]) => `${from}>${to}`));

    // The exhaustive part: every ordered pair in states x states.
    for (const from of expected.states) {
      for (const to of expected.states) {
        pairs += 1;
        const shouldBeLegal = legal.has(`${from}>${to}`);
        const actual = canTransition(machine, from, to);
        if (actual !== shouldBeLegal) {
          check(
            false,
            `${name}: ${from} -> ${to} is ${actual ? "allowed" : "rejected"} but should be ${shouldBeLegal ? "allowed" : "rejected"}`,
          );
        }
        if (shouldBeLegal) {
          assertTransition(machine, from, to);
        } else {
          checkThrows(
            () => assertTransition(machine, from, to),
            `${name}: assertTransition must refuse ${from} -> ${to}`,
            "STATE_ILLEGAL_TRANSITION",
          );
        }
      }
    }

    // No state may transition to itself. A self-loop would let a write handler
    // "advance" a mandate without changing anything and still emit an event.
    for (const state of expected.states) {
      checkEqual(canTransition(machine, state, state), false, `${name}: ${state} must not self-transition`);
    }

    // Terminal states have no outgoing edges, and every state is reachable from the
    // initial one — an orphan state is a typo, not a design.
    for (const state of expected.terminal) {
      checkEqual(isTerminal(machine, state), true, `${name}: ${state} is terminal`);
    }
    for (const state of expected.states) {
      if (!expected.terminal.includes(state)) {
        checkEqual(isTerminal(machine, state), false, `${name}: ${state} is not terminal`);
      }
    }

    const reachable = new Set([expected.initial]);
    const queue = [expected.initial];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of machine.transitions[current]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const state of expected.states) {
      check(reachable.has(state), `${name}: ${state} is unreachable from ${expected.initial}`);
    }

    // Unknown states are an error, never a quiet false.
    checkThrows(() => canTransition(machine, "NOT_A_STATE", expected.initial), `${name}: unknown from`, "STATE_UNKNOWN");
    checkThrows(() => canTransition(machine, expected.initial, "NOT_A_STATE"), `${name}: unknown to`, "STATE_UNKNOWN");
  }

  checkEqual(pairs, 8 * 8 + 11 * 11 + 4 * 4, "every ordered pair of every machine was checked");

  /* ── the invariants these tables exist to protect ─────────────────────── */

  // I1: the only route into SETTLED is from ADJUDICATED. Stated directly, because
  // the whole spec turns on it.
  checkEqual(SETTLED_PREDECESSORS.join(","), "ADJUDICATED", "SETTLED has exactly one predecessor: ADJUDICATED");
  for (const from of MANDATE_STATES) {
    if (from === "ADJUDICATED") continue;
    checkEqual(canTransition(mandateMachine, from, "SETTLED"), false, `${from} must not reach SETTLED directly`);
  }

  // Settlement can never leave EXECUTED: it is irreversible by design.
  for (const to of SETTLEMENT_STATES) {
    checkEqual(canTransition(settlementMachine, "EXECUTED", to), false, `EXECUTED must not reach ${to}`);
  }

  // A challenge returns to NONE, not to EXECUTED. Getting this edge wrong would let
  // a challenged posting settle anyway.
  checkEqual(canTransition(settlementMachine, "CHALLENGED", "EXECUTED"), false, "a challenged posting cannot execute");
  checkEqual(canTransition(settlementMachine, "CHALLENGED", "NONE"), true, "a challenged posting returns to NONE");

  /* ── mission editability (SPEC §102) ──────────────────────────────────── */

  checkEqual(canEditMission("DRAFT", 0), true, "a draft with no proposals is editable");
  checkEqual(canEditMission("OPEN", 0), true, "an open mission with no proposals is editable");
  checkEqual(canEditMission("DRAFT", 1), false, "the first proposal freezes the mission");
  checkEqual(canEditMission("OPEN", 1), false, "the first proposal freezes an open mission");
  for (const state of MISSION_STATES) {
    if (state === "DRAFT" || state === "OPEN") continue;
    checkEqual(canEditMission(state, 0), false, `${state} is not editable even with no proposals`);
  }
  checkThrows(() => canEditMission("DRAFT", -1), "negative proposal count", "STATE_UNKNOWN");
  checkThrows(() => canEditMission("NOPE", 0), "unknown mission state", "STATE_UNKNOWN");

  finish("TYPES-STATES OK");
} catch (error) {
  abort(error);
}
