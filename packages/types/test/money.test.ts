import { describe, expect, it } from "vitest";
import {
  assertAllocations,
  assertBpPair,
  assertVerdictMatchesRelease,
  BP_DENOMINATOR,
  parseAtomic,
  splitRelease,
  verdictForRelease,
  VERDICTS,
} from "../src/index.js";
import type { Allocation } from "../src/index.js";

const payees = (...shares: number[]): Allocation[] =>
  shares.map((share_bp, i) => ({ agent_id: `agt_${i}`, share_bp }));

const sum = (values: bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

describe("basis-point money math (docs/ARCHITECTURE.md §7)", () => {
  it("uses basis points, never percentages", () => {
    expect(BP_DENOMINATOR).toBe(10_000);
    expect([...VERDICTS]).toEqual(["FULL_ACCEPTANCE", "PARTIAL_ACCEPTANCE", "REJECTION"]);
  });

  it("splits the frozen decision payload's numbers", () => {
    const result = splitRelease(250_000_000n, 7500, 2500, payees(6000, 4000));
    expect(result.release_pool_atomic).toBe(187_500_000n);
    expect(result.payouts.map((p) => p.amount_atomic)).toEqual([112_500_000n, 75_000_000n]);
    expect(result.refund_atomic).toBe(62_500_000n);
  });

  it("conserves the deposit exactly, which is the assertion the escrow makes", () => {
    for (const deposited of [0n, 1n, 2n, 7n, 99n, 1_000_000n, 10n ** 30n]) {
      for (const releaseBp of [0, 1, 3333, 5000, 7500, 9999, 10_000]) {
        const allocation = releaseBp === 0 ? [] : payees(1429, 1429, 1429, 1429, 1428, 1428, 1428);
        const result = splitRelease(deposited, releaseBp, 10_000 - releaseBp, allocation);
        expect(sum(result.payouts.map((p) => p.amount_atomic)) + result.refund_atomic).toBe(deposited);
      }
    }
  });

  it("sends every rounding remainder to the refund, never to a payee", () => {
    // 10 units at 100% over 3 equal-ish payees: floors shed a unit, and it must land
    // in the refund rather than being handed to whoever is listed first.
    const result = splitRelease(10n, 10_000, 0, payees(3334, 3333, 3333));
    expect(result.payouts.map((p) => p.amount_atomic)).toEqual([3n, 3n, 3n]);
    expect(result.refund_atomic).toBe(1n);
  });

  it("never over-pays when the pool floors to zero", () => {
    const result = splitRelease(1n, 5000, 5000, payees(10_000));
    expect(result.release_pool_atomic).toBe(0n);
    expect(result.payouts[0]?.amount_atomic).toBe(0n);
    expect(result.refund_atomic).toBe(1n);
  });

  it("refunds the whole deposit on a rejection", () => {
    const result = splitRelease(1_000_000n, 0, 10_000, []);
    expect(result.payouts).toEqual([]);
    expect(result.refund_atomic).toBe(1_000_000n);
  });

  it("allows a rejection that still names the workers, paying each zero", () => {
    const result = splitRelease(1_000_000n, 0, 10_000, payees(6000, 4000));
    expect(result.payouts.map((p) => p.amount_atomic)).toEqual([0n, 0n]);
    expect(result.refund_atomic).toBe(1_000_000n);
  });

  describe("invariant I5", () => {
    it("requires release + refund to be exactly 10000", () => {
      expect(() => assertBpPair(7500, 2400)).toThrow(/BP_SUM/);
      expect(() => assertBpPair(7500, 2600)).toThrow(/BP_SUM/);
      expect(() => assertBpPair(0, 10_000)).not.toThrow();
      expect(() => assertBpPair(10_000, 0)).not.toThrow();
    });

    it("requires allocation shares to be exactly 10000", () => {
      expect(() => assertAllocations(payees(5000, 4999), 10_000)).toThrow(/BP_ALLOCATIONS/);
      expect(() => assertAllocations(payees(5000, 5001), 10_000)).toThrow(/BP_ALLOCATIONS/);
      expect(() => assertAllocations(payees(5000, 5000), 10_000)).not.toThrow();
    });

    it("rejects fractional or out-of-range basis points", () => {
      expect(() => assertBpPair(7500.5, 2499.5)).toThrow(/BP_RANGE/);
      expect(() => assertBpPair(-1, 10_001)).toThrow(/BP_RANGE/);
    });

    it("rejects a duplicated payee, which is how one worker gets paid twice", () => {
      expect(() =>
        assertAllocations(
          [
            { agent_id: "agt_a", share_bp: 5000 },
            { agent_id: "agt_a", share_bp: 5000 },
          ],
          10_000,
        ),
      ).toThrow(/BP_ALLOCATIONS/);
    });

    it("rejects a release with nobody to pay", () => {
      expect(() => assertAllocations([], 1)).toThrow(/BP_ALLOCATIONS/);
      expect(() => assertAllocations([], 0)).not.toThrow();
    });
  });

  describe("verdict and numbers must agree", () => {
    it("holds the escrow's rule", () => {
      expect(() => assertVerdictMatchesRelease("FULL_ACCEPTANCE", 10_000)).not.toThrow();
      expect(() => assertVerdictMatchesRelease("REJECTION", 0)).not.toThrow();
      expect(() => assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 5000)).not.toThrow();
    });

    it("refuses a label that flatters the numbers", () => {
      expect(() => assertVerdictMatchesRelease("FULL_ACCEPTANCE", 9999)).toThrow(/BP_VERDICT_MISMATCH/);
      expect(() => assertVerdictMatchesRelease("REJECTION", 1)).toThrow(/BP_VERDICT_MISMATCH/);
      expect(() => assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 0)).toThrow(/BP_VERDICT_MISMATCH/);
      expect(() => assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 10_000)).toThrow(/BP_VERDICT_MISMATCH/);
    });

    it("inverts cleanly", () => {
      expect(verdictForRelease(10_000)).toBe("FULL_ACCEPTANCE");
      expect(verdictForRelease(0)).toBe("REJECTION");
      expect(verdictForRelease(1)).toBe("PARTIAL_ACCEPTANCE");
      expect(verdictForRelease(9999)).toBe("PARTIAL_ACCEPTANCE");
    });
  });

  describe("atomic amounts", () => {
    it("accepts one spelling per value", () => {
      expect(parseAtomic("0")).toBe(0n);
      expect(parseAtomic("250000000")).toBe(250_000_000n);
      expect(parseAtomic("1".padEnd(78, "0"))).toBe(BigInt("1".padEnd(78, "0")));
    });

    it("rejects any second spelling", () => {
      for (const bad of ["", "00", "01", "-0", "+1", "1.0", "1e3", " 1", "0x1"]) {
        expect(() => parseAtomic(bad)).toThrow(/BP_AMOUNT/);
      }
    });
  });

  it("refuses a deposit that is not a non-negative bigint", () => {
    expect(() => splitRelease(-1n, 10_000, 0, payees(10_000))).toThrow(/BP_AMOUNT/);
    // @ts-expect-error a number amount is a rounding hazard and is refused at runtime
    expect(() => splitRelease(1, 10_000, 0, payees(10_000))).toThrow(/BP_AMOUNT/);
  });
});
