/**
 * Basis-point money math (docs/ARCHITECTURE.md §7, invariant I5).
 *
 * Money is basis points over `bigint` atomic units. Never percentages, never
 * floats — canonical JSON rejects floats (docs/CANONICAL.md §1.1 rule 5) exactly
 * so that an amount cannot be represented in a type that rounds.
 *
 * The rounding rule is the part worth reading twice:
 *
 *   Integer division on basis points leaves a remainder. The remainder goes to
 *   the **refund** leg, never to a payee.
 *
 * That makes two things true at once. Rounding can never over-pay a worker, and
 * `sum(payouts) + refund == deposited` holds exactly for every input — which is
 * the assertion the escrow makes before it moves a single unit of USDC. A scheme
 * that spread the remainder across payees would break the second property, and
 * one that gave it to the largest payee would break the first.
 */

import { fail } from "./errors.js";

/** Basis-point denominator. 10000 bp == 100%. */
export const BP_DENOMINATOR = 10_000;

export type Verdict = "FULL_ACCEPTANCE" | "PARTIAL_ACCEPTANCE" | "REJECTION";

export const VERDICTS: readonly Verdict[] = ["FULL_ACCEPTANCE", "PARTIAL_ACCEPTANCE", "REJECTION"];

/** A worker's share of the release leg. Shares sum to exactly 10000. */
export interface Allocation {
  readonly agent_id: string;
  readonly share_bp: number;
}

export interface Payout {
  readonly agent_id: string;
  readonly share_bp: number;
  readonly amount_atomic: bigint;
}

export interface SplitResult {
  readonly deposited_atomic: bigint;
  /** What the release leg is worth before per-payee division. */
  readonly release_pool_atomic: bigint;
  readonly payouts: readonly Payout[];
  /** Refund leg plus every rounding remainder. */
  readonly refund_atomic: bigint;
}

function assertBpValue(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    fail("BP_RANGE", `${label} must be an integer number of basis points, got ${value}`, { label, value });
  }
  if (value < 0 || value > BP_DENOMINATOR) {
    fail("BP_RANGE", `${label} must be within 0..${BP_DENOMINATOR}, got ${value}`, { label, value });
  }
}

/** Invariant I5, first half: `releaseBp + refundBp == 10000` exactly. */
export function assertBpPair(releaseBp: number, refundBp: number): void {
  assertBpValue(releaseBp, "release_bp");
  assertBpValue(refundBp, "refund_bp");
  if (releaseBp + refundBp !== BP_DENOMINATOR) {
    fail(
      "BP_SUM",
      `release_bp + refund_bp must equal ${BP_DENOMINATOR} exactly, got ${releaseBp} + ${refundBp} = ${releaseBp + refundBp}`,
      { releaseBp, refundBp },
    );
  }
}

/**
 * Invariant I5, second half: allocation shares sum to exactly 10000.
 *
 * An empty allocation list is legal **only** when nothing is being released. A
 * `REJECTION` has no payees, and "shares of zero summing to 10000" would be a
 * fiction the escrow would have to special-case. Any non-empty list must sum
 * exactly, whatever the verdict.
 */
export function assertAllocations(allocations: readonly Allocation[], releaseBp: number): void {
  assertBpValue(releaseBp, "release_bp");
  if (allocations.length === 0) {
    if (releaseBp !== 0) {
      fail("BP_ALLOCATIONS", `release_bp is ${releaseBp} but there are no allocations to pay`, {
        releaseBp,
      });
    }
    return;
  }

  const seen = new Set<string>();
  let total = 0;
  for (const allocation of allocations) {
    assertBpValue(allocation.share_bp, `allocation[${allocation.agent_id}].share_bp`);
    if (seen.has(allocation.agent_id)) {
      // A duplicated payee is how a single worker is paid twice from one decision.
      fail("BP_ALLOCATIONS", `duplicate allocation for agent ${allocation.agent_id}`, {
        agent_id: allocation.agent_id,
      });
    }
    seen.add(allocation.agent_id);
    total += allocation.share_bp;
  }
  if (total !== BP_DENOMINATOR) {
    fail(
      "BP_ALLOCATIONS",
      `allocation shares must sum to ${BP_DENOMINATOR} exactly, got ${total}`,
      { total },
    );
  }
}

/**
 * Invariant checked by the escrow rather than trusted: the verdict label must
 * agree with the numbers (docs/ARCHITECTURE.md §7).
 *
 *   FULL_ACCEPTANCE    ⇒ release_bp == 10000
 *   REJECTION          ⇒ release_bp == 0
 *   PARTIAL_ACCEPTANCE ⇒ 0 < release_bp < 10000
 */
export function assertVerdictMatchesRelease(verdict: Verdict, releaseBp: number): void {
  assertBpValue(releaseBp, "release_bp");
  const ok =
    verdict === "FULL_ACCEPTANCE"
      ? releaseBp === BP_DENOMINATOR
      : verdict === "REJECTION"
        ? releaseBp === 0
        : releaseBp > 0 && releaseBp < BP_DENOMINATOR;
  if (!ok) {
    fail(
      "BP_VERDICT_MISMATCH",
      `verdict ${verdict} disagrees with release_bp ${releaseBp}`,
      { verdict, releaseBp },
    );
  }
}

/** True when the label and the number agree. Never throws. */
export function verdictMatchesRelease(verdict: Verdict, releaseBp: number): boolean {
  try {
    assertVerdictMatchesRelease(verdict, releaseBp);
    return true;
  } catch {
    return false;
  }
}

/** The verdict implied by a release figure. Inverse of the rule above. */
export function verdictForRelease(releaseBp: number): Verdict {
  assertBpValue(releaseBp, "release_bp");
  if (releaseBp === BP_DENOMINATOR) return "FULL_ACCEPTANCE";
  if (releaseBp === 0) return "REJECTION";
  return "PARTIAL_ACCEPTANCE";
}

/**
 * Splits a deposit into per-payee amounts plus a refund.
 *
 * Two floors happen: `deposited * releaseBp / 10000` for the pool, then
 * `pool * shareBp / 10000` for each payee. Both remainders end up in the refund,
 * so the returned figures always satisfy
 *
 *   sum(payouts) + refund == deposited
 *
 * exactly, for any deposit including 1 atomic unit.
 */
export function splitRelease(
  depositedAtomic: bigint,
  releaseBp: number,
  refundBp: number,
  allocations: readonly Allocation[],
): SplitResult {
  if (typeof depositedAtomic !== "bigint") {
    fail("BP_AMOUNT", `deposited amount must be a bigint of atomic units`);
  }
  if (depositedAtomic < 0n) {
    fail("BP_AMOUNT", `deposited amount cannot be negative: ${depositedAtomic}`, {
      deposited: depositedAtomic.toString(),
    });
  }
  assertBpPair(releaseBp, refundBp);
  assertAllocations(allocations, releaseBp);

  const denominator = BigInt(BP_DENOMINATOR);
  const releasePool = (depositedAtomic * BigInt(releaseBp)) / denominator;

  const payouts: Payout[] = [];
  let paid = 0n;
  for (const allocation of allocations) {
    const amount = (releasePool * BigInt(allocation.share_bp)) / denominator;
    paid += amount;
    payouts.push({
      agent_id: allocation.agent_id,
      share_bp: allocation.share_bp,
      amount_atomic: amount,
    });
  }

  const refund = depositedAtomic - paid;

  // Not a test — a runtime assertion on the money path. If this ever fails the
  // escrow's own balance check would fail too, and it is cheaper to fail here.
  if (refund < 0n) {
    fail("BP_AMOUNT", `payouts ${paid} exceed deposit ${depositedAtomic}`, {
      paid: paid.toString(),
      deposited: depositedAtomic.toString(),
    });
  }

  return {
    deposited_atomic: depositedAtomic,
    release_pool_atomic: releasePool,
    payouts,
    refund_atomic: refund,
  };
}

/** Parses a decimal-string atomic amount, the only form allowed to cross a boundary. */
export function parseAtomic(value: string, label = "amount_atomic"): bigint {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(value)) {
    fail(
      "BP_AMOUNT",
      `${label} must be a non-negative decimal integer string with no leading zeros, got ${JSON.stringify(value)}`,
      { label },
    );
  }
  return BigInt(value);
}
