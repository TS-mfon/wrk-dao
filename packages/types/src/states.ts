/**
 * State machines (docs/ARCHITECTURE.md §6).
 *
 * Every transition is an on-chain event; the read model derives state and never
 * decides it. These tables exist so that "is this transition legal" has exactly
 * one answer shared by the API, the indexer and the SDK.
 *
 * The transition sets are exhaustive: anything not listed is illegal, and the
 * verifier checks every ordered pair of states in the product, not a happy path.
 * The illegal pairs are the ones that matter — `MANDATED → SETTLED` without
 * `ADJUDICATED` is invariant I1 violated, and it is a single missing guard away.
 *
 * ── Where the tables go beyond the document ──────────────────────────────────
 * §6 gives the linear spine and names the terminal states, but does not enumerate
 * which states may reach them. Those edges are a design decision, made here with
 * one rule per machine and recorded so the driver's manual review (node-1.1:N6)
 * can accept or amend it:
 *
 *   Mission:  a mission may be cancelled or expire at any point before it is
 *             mandated. After `MANDATED` the mandate machine owns the lifecycle.
 *
 *   Mandate:  before escrow is funded, exit is `CANCELLED` or `EXPIRED`. Once
 *             funded, the only non-settling exit is `REFUNDED`, because escrowed
 *             USDC must be accounted for and a terminal state with money still
 *             locked would be unrecoverable. `ADJUDICATED` reaches `SETTLED`
 *             (full or partial acceptance) or `REFUNDED` (rejection).
 *
 *   Settlement: exactly as documented; §6 enumerates it fully.
 */

import { fail, describe } from "./errors.js";

/* ── mission ─────────────────────────────────────────────────────────────── */

export const MISSION_STATES = [
  "DRAFT",
  "OPEN",
  "PROPOSALS_CLOSED",
  "SELECTING",
  "SELECTED",
  "MANDATED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  DRAFT: ["OPEN", "CANCELLED", "EXPIRED"],
  OPEN: ["PROPOSALS_CLOSED", "CANCELLED", "EXPIRED"],
  PROPOSALS_CLOSED: ["SELECTING", "CANCELLED", "EXPIRED"],
  SELECTING: ["SELECTED", "CANCELLED", "EXPIRED"],
  SELECTED: ["MANDATED", "CANCELLED", "EXPIRED"],
  MANDATED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/* ── mandate ─────────────────────────────────────────────────────────────── */

export const MANDATE_STATES = [
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
] as const;
export type MandateState = (typeof MANDATE_STATES)[number];

const MANDATE_TRANSITIONS: Readonly<Record<MandateState, readonly MandateState[]>> = {
  CREATED: ["ACCEPTED", "CANCELLED", "EXPIRED"],
  ACCEPTED: ["FUNDED", "CANCELLED", "EXPIRED"],
  FUNDED: ["IN_PROGRESS", "REFUNDED"],
  IN_PROGRESS: ["SUBMITTED", "REFUNDED"],
  SUBMITTED: ["ADJUDICATING", "REFUNDED"],
  ADJUDICATING: ["ADJUDICATED", "REFUNDED"],
  ADJUDICATED: ["SETTLED", "REFUNDED"],
  SETTLED: [],
  REFUNDED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/* ── settlement ──────────────────────────────────────────────────────────── */

export const SETTLEMENT_STATES = ["NONE", "POSTED", "CHALLENGED", "EXECUTED"] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

const SETTLEMENT_TRANSITIONS: Readonly<Record<SettlementState, readonly SettlementState[]>> = {
  // A challenge returns to NONE so the adapter can re-post correctly. It never
  // destroys the escrow balance: voiding a posting is cheap, wrongly releasing
  // is not (docs/ARCHITECTURE.md §3.3).
  NONE: ["POSTED"],
  POSTED: ["CHALLENGED", "EXECUTED"],
  CHALLENGED: ["NONE"],
  EXECUTED: [],
};

/* ── machine surface ─────────────────────────────────────────────────────── */

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: S;
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  readonly terminal: readonly S[];
}

function machine<S extends string>(
  name: string,
  states: readonly S[],
  initial: S,
  transitions: Readonly<Record<S, readonly S[]>>,
): StateMachine<S> {
  const terminal = states.filter((state) => transitions[state].length === 0);
  return { name, states, initial, transitions, terminal };
}

export const missionMachine = machine<MissionState>(
  "mission",
  MISSION_STATES,
  "DRAFT",
  MISSION_TRANSITIONS,
);
export const mandateMachine = machine<MandateState>(
  "mandate",
  MANDATE_STATES,
  "CREATED",
  MANDATE_TRANSITIONS,
);
export const settlementMachine = machine<SettlementState>(
  "settlement",
  SETTLEMENT_STATES,
  "NONE",
  SETTLEMENT_TRANSITIONS,
);

export const MACHINES = [missionMachine, mandateMachine, settlementMachine] as const;

function assertState<S extends string>(machineDef: StateMachine<S>, value: string, label: string): S {
  if (!(machineDef.states as readonly string[]).includes(value)) {
    fail("STATE_UNKNOWN", `${machineDef.name} has no state ${describe(value)} (${label})`, {
      machine: machineDef.name,
      value,
      label,
    });
  }
  return value as S;
}

/** True when `from → to` is a legal transition. Unknown states throw. */
export function canTransition<S extends string>(
  machineDef: StateMachine<S>,
  from: string,
  to: string,
): boolean {
  const start = assertState(machineDef, from, "from");
  const end = assertState(machineDef, to, "to");
  return machineDef.transitions[start].includes(end);
}

/** Throws unless `from → to` is legal. Use on every write path. */
export function assertTransition<S extends string>(
  machineDef: StateMachine<S>,
  from: string,
  to: string,
): void {
  if (!canTransition(machineDef, from, to)) {
    fail(
      "STATE_ILLEGAL_TRANSITION",
      `${machineDef.name}: ${from} -> ${to} is not a legal transition`,
      { machine: machineDef.name, from, to },
    );
  }
}

export function isTerminal<S extends string>(machineDef: StateMachine<S>, state: string): boolean {
  return machineDef.transitions[assertState(machineDef, state, "state")].length === 0;
}

/**
 * Mission editability (SPEC §102): a mission may be edited — incrementing its
 * version — only while it is `DRAFT` or `OPEN` **and** has zero proposals. The
 * first proposal freezes it, because a worker's proposal is an answer to a
 * specific set of acceptance criteria.
 */
export function canEditMission(state: string, proposalCount: number): boolean {
  const current = assertState(missionMachine, state, "state");
  if (!Number.isInteger(proposalCount) || proposalCount < 0) {
    fail("STATE_UNKNOWN", `proposalCount must be a non-negative integer, got ${proposalCount}`);
  }
  return (current === "DRAFT" || current === "OPEN") && proposalCount === 0;
}

/**
 * Invariant I1, expressed directly: the only route into `SETTLED` is from
 * `ADJUDICATED`. Asserted as data so the verifier can check the claim against
 * the table rather than against a second copy of the rule.
 */
export const SETTLED_PREDECESSORS: readonly MandateState[] = MANDATE_STATES.filter(
  (state) => MANDATE_TRANSITIONS[state].includes("SETTLED"),
);
