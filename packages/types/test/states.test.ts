import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canEditMission,
  canTransition,
  isTerminal,
  MANDATE_STATES,
  mandateMachine,
  MISSION_STATES,
  missionMachine,
  SETTLED_PREDECESSORS,
  SETTLEMENT_STATES,
  settlementMachine,
} from "../src/index.js";

describe("state machines (docs/ARCHITECTURE.md §6)", () => {
  it("walks the documented mission spine", () => {
    const spine = ["DRAFT", "OPEN", "PROPOSALS_CLOSED", "SELECTING", "SELECTED", "MANDATED"] as const;
    for (let i = 0; i < spine.length - 1; i++) {
      expect(canTransition(missionMachine, spine[i]!, spine[i + 1]!)).toBe(true);
    }
    expect(isTerminal(missionMachine, "MANDATED")).toBe(true);
  });

  it("walks the documented mandate spine", () => {
    const spine = [
      "CREATED",
      "ACCEPTED",
      "FUNDED",
      "IN_PROGRESS",
      "SUBMITTED",
      "ADJUDICATING",
      "ADJUDICATED",
      "SETTLED",
    ] as const;
    for (let i = 0; i < spine.length - 1; i++) {
      expect(canTransition(mandateMachine, spine[i]!, spine[i + 1]!)).toBe(true);
    }
    expect(isTerminal(mandateMachine, "SETTLED")).toBe(true);
  });

  describe("invariant I1 — no settlement without adjudication", () => {
    it("allows SETTLED only from ADJUDICATED", () => {
      expect([...SETTLED_PREDECESSORS]).toEqual(["ADJUDICATED"]);
    });

    it("blocks every shortcut into SETTLED", () => {
      for (const from of MANDATE_STATES) {
        if (from === "ADJUDICATED") continue;
        expect(canTransition(mandateMachine, from, "SETTLED")).toBe(false);
      }
      // The specific shortcut a missing guard would create.
      expect(() => assertTransition(mandateMachine, "FUNDED", "SETTLED")).toThrow(/STATE_ILLEGAL_TRANSITION/);
      expect(() => assertTransition(mandateMachine, "SUBMITTED", "SETTLED")).toThrow(/STATE_ILLEGAL_TRANSITION/);
    });
  });

  describe("escrowed money always has an exit", () => {
    it("lets every funded state reach REFUNDED", () => {
      for (const state of ["FUNDED", "IN_PROGRESS", "SUBMITTED", "ADJUDICATING", "ADJUDICATED"] as const) {
        expect(canTransition(mandateMachine, state, "REFUNDED")).toBe(true);
      }
    });

    it("keeps CANCELLED and EXPIRED to the pre-funding states", () => {
      // A terminal state reached with USDC still locked would be unrecoverable.
      for (const state of ["FUNDED", "IN_PROGRESS", "SUBMITTED", "ADJUDICATING", "ADJUDICATED"] as const) {
        expect(canTransition(mandateMachine, state, "CANCELLED")).toBe(false);
        expect(canTransition(mandateMachine, state, "EXPIRED")).toBe(false);
      }
      for (const state of ["CREATED", "ACCEPTED"] as const) {
        expect(canTransition(mandateMachine, state, "CANCELLED")).toBe(true);
        expect(canTransition(mandateMachine, state, "EXPIRED")).toBe(true);
        expect(canTransition(mandateMachine, state, "REFUNDED")).toBe(false);
      }
    });
  });

  describe("settlement", () => {
    it("returns a challenged posting to NONE so the adapter can re-post", () => {
      expect(canTransition(settlementMachine, "POSTED", "CHALLENGED")).toBe(true);
      expect(canTransition(settlementMachine, "CHALLENGED", "NONE")).toBe(true);
      expect(canTransition(settlementMachine, "CHALLENGED", "EXECUTED")).toBe(false);
    });

    it("makes EXECUTED irreversible", () => {
      for (const to of SETTLEMENT_STATES) {
        expect(canTransition(settlementMachine, "EXECUTED", to)).toBe(false);
      }
    });

    it("requires a posting before execution", () => {
      expect(canTransition(settlementMachine, "NONE", "EXECUTED")).toBe(false);
      expect(canTransition(settlementMachine, "NONE", "POSTED")).toBe(true);
    });
  });

  it("forbids self-transitions in every machine", () => {
    // Written as three loops rather than one over a machine array: the machines have
    // different state parameters, so a union would erase the type that makes
    // canTransition reject an unknown state at compile time.
    for (const state of MISSION_STATES) {
      expect(canTransition(missionMachine, state, state)).toBe(false);
    }
    for (const state of MANDATE_STATES) {
      expect(canTransition(mandateMachine, state, state)).toBe(false);
    }
    for (const state of SETTLEMENT_STATES) {
      expect(canTransition(settlementMachine, state, state)).toBe(false);
    }
  });

  it("treats an unknown state as an error, not a quiet false", () => {
    expect(() => canTransition(missionMachine, "NOPE", "OPEN")).toThrow(/STATE_UNKNOWN/);
    expect(() => canTransition(missionMachine, "DRAFT", "NOPE")).toThrow(/STATE_UNKNOWN/);
    expect(() => isTerminal(mandateMachine, "NOPE")).toThrow(/STATE_UNKNOWN/);
  });

  describe("mission editability (SPEC §102)", () => {
    it("freezes a mission on its first proposal", () => {
      expect(canEditMission("DRAFT", 0)).toBe(true);
      expect(canEditMission("OPEN", 0)).toBe(true);
      expect(canEditMission("DRAFT", 1)).toBe(false);
      expect(canEditMission("OPEN", 1)).toBe(false);
    });

    it("allows edits only in DRAFT and OPEN", () => {
      for (const state of MISSION_STATES) {
        const editable = state === "DRAFT" || state === "OPEN";
        expect(canEditMission(state, 0)).toBe(editable);
      }
    });
  });
});
