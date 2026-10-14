// G4: basis-point money math is exact.
//
// The property that matters is not "the numbers look right" but
//
//     sum(payouts) + refund == deposited          for every input, exactly
//
// together with its companion: the rounding remainder always lands in the refund
// leg, so rounding can never over-pay a worker. Both are asserted on every case
// below, including the 7-payee split where 10000/7 has a remainder and the
// 1-atomic-unit deposit where the release pool floors to zero.
//
// The random cases use a fixed-seed PRNG. A money gate that fails one run in fifty
// is worse than no gate, because it trains you to re-run it.

import { check, checkEqual, checkThrows, finish, abort } from "./_common.mjs";

const DENOM = 10000n;

// mulberry32 — small, fast, deterministic.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random shares over `n` payees summing to exactly 10000. */
function randomShares(random, n) {
  const cuts = [0, 10000];
  for (let i = 0; i < n - 1; i++) cuts.push(Math.floor(random() * 10001));
  cuts.sort((x, y) => x - y);
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(cuts[i + 1] - cuts[i]);
  return shares;
}

try {
  const {
    splitRelease,
    assertBpPair,
    assertAllocations,
    assertVerdictMatchesRelease,
    verdictForRelease,
    verdictMatchesRelease,
    parseAtomic,
    BP_DENOMINATOR,
  } = await import("../dist/index.js");

  checkEqual(BP_DENOMINATOR, 10000, "BP_DENOMINATOR");

  let cases = 0;

  /** The full assertion battery for one split. */
  const exercise = (deposited, releaseBp, shares, label) => {
    cases += 1;
    const refundBp = 10000 - releaseBp;
    const allocations = shares.map((share_bp, i) => ({ agent_id: `agt_payee_${i}`, share_bp }));
    const result = splitRelease(deposited, releaseBp, refundBp, allocations);

    let paid = 0n;
    for (const payout of result.payouts) paid += payout.amount_atomic;

    // The balance identity. This is the assertion the escrow makes before moving USDC.
    checkEqual(
      (paid + result.refund_atomic).toString(),
      deposited.toString(),
      `${label}: sum(payouts) + refund == deposited`,
    );

    // The release pool is a floor of the deposit, never more.
    checkEqual(
      result.release_pool_atomic.toString(),
      ((deposited * BigInt(releaseBp)) / DENOM).toString(),
      `${label}: release pool is floor(deposited * releaseBp / 10000)`,
    );
    check(result.release_pool_atomic <= deposited, `${label}: release pool cannot exceed the deposit`);

    // Each payee gets exactly the floor of their share — never a rounded-up unit.
    for (const payout of result.payouts) {
      checkEqual(
        payout.amount_atomic.toString(),
        ((result.release_pool_atomic * BigInt(payout.share_bp)) / DENOM).toString(),
        `${label}: payee ${payout.agent_id} gets floor(pool * share / 10000)`,
      );
      check(payout.amount_atomic >= 0n, `${label}: no negative payout`);
    }

    // "The remainder goes to the refund leg" stated as an inequality: the refund is
    // never below its nominal share, and holds every unit the floors shed.
    const nominalRefund = (deposited * BigInt(refundBp)) / DENOM;
    check(
      result.refund_atomic >= nominalRefund,
      `${label}: refund ${result.refund_atomic} must be at least its nominal share ${nominalRefund}`,
    );
    check(paid <= result.release_pool_atomic, `${label}: payouts cannot exceed the release pool`);
    check(result.refund_atomic >= 0n, `${label}: refund cannot be negative`);
  };

  /* ── explicit edge cases ──────────────────────────────────────────────── */

  exercise(1n, 10000, [10000], "1 unit, full release, 1 payee");
  exercise(1n, 0, [], "1 unit, rejection, no payees");
  exercise(1n, 5000, [10000], "1 unit, half release (pool floors to 0)");
  exercise(0n, 10000, [10000], "zero deposit, full release");
  exercise(0n, 0, [], "zero deposit, rejection");
  exercise(1000000n, 10000, [10000], "1 USDC, full release");
  exercise(250000000n, 7500, [6000, 4000], "the frozen decision payload's numbers");

  // 10000 / 7 does not divide: every payee floors and the remainder must accumulate
  // in the refund rather than vanish or be handed to someone.
  const sevenWays = [1429, 1429, 1429, 1429, 1428, 1428, 1428];
  checkEqual(
    sevenWays.reduce((a, b) => a + b, 0),
    10000,
    "the 7-way split must itself sum to 10000",
  );
  for (const deposit of [1n, 7n, 13n, 100n, 999n, 1000001n, 123456789n]) {
    exercise(deposit, 10000, sevenWays, `7-way split of ${deposit}`);
    exercise(deposit, 3333, sevenWays, `7-way split of ${deposit} at 33.33%`);
  }

  // A worst case for flooring: 16 payees, 1 bp each except one, tiny deposit.
  const sixteen = [10000 - 15, ...Array.from({ length: 15 }, () => 1)];
  exercise(31n, 10000, sixteen, "16 payees, 1bp each, 31 units");

  // Maximum realistic magnitude: a uint256-ish deposit must not lose a unit.
  const huge = (1n << 200n) + 12345n;
  exercise(huge, 6667, [3334, 3333, 3333], "2^200 deposit, 3 payees");

  /* ── randomised property test ─────────────────────────────────────────── */

  const random = prng(0x5745524b);
  for (let i = 0; i < 20000; i++) {
    const payees = 1 + Math.floor(random() * 7);
    const releaseBp = Math.floor(random() * 10001);
    const magnitude = Math.floor(random() * 30);
    const deposited = BigInt(Math.floor(random() * 1000)) * (1n << BigInt(magnitude));
    const shares = releaseBp === 0 && random() < 0.5 ? [] : randomShares(random, payees);
    if (shares.length === 0 && releaseBp !== 0) continue;
    exercise(deposited, releaseBp, shares, `random #${i}`);
  }
  check(cases > 20000, `expected more than 20000 exercised splits, ran ${cases}`);

  /* ── refusals ─────────────────────────────────────────────────────────── */

  checkThrows(() => assertBpPair(7500, 2000), "release+refund must equal 10000", "BP_SUM");
  checkThrows(() => assertBpPair(7500, 3000), "release+refund over 10000", "BP_SUM");
  checkThrows(() => assertBpPair(-1, 10001), "negative basis points", "BP_RANGE");
  checkThrows(() => assertBpPair(7500.5, 2499.5), "fractional basis points", "BP_RANGE");
  checkThrows(() => assertBpPair(10001, -1), "basis points above 10000", "BP_RANGE");

  const one = (share) => [{ agent_id: "agt_a", share_bp: share }];
  checkThrows(() => assertAllocations(one(9999), 10000), "shares below 10000", "BP_ALLOCATIONS");
  checkThrows(() => assertAllocations(one(10001), 10000), "share above 10000", "BP_RANGE");
  checkThrows(() => assertAllocations([], 10000), "no payees but release is non-zero", "BP_ALLOCATIONS");
  checkThrows(
    () =>
      assertAllocations(
        [
          { agent_id: "agt_a", share_bp: 5000 },
          { agent_id: "agt_a", share_bp: 5000 },
        ],
        10000,
      ),
    "duplicate payee",
    "BP_ALLOCATIONS",
  );
  // Legal: a rejection may still name the workers; each simply receives zero.
  assertAllocations(one(10000), 0);

  checkThrows(() => splitRelease(-1n, 10000, 0, one(10000)), "negative deposit", "BP_AMOUNT");
  checkThrows(() => splitRelease(100, 10000, 0, one(10000)), "number instead of bigint", "BP_AMOUNT");

  /* ── verdict / release agreement ──────────────────────────────────────── */

  assertVerdictMatchesRelease("FULL_ACCEPTANCE", 10000);
  assertVerdictMatchesRelease("REJECTION", 0);
  assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 1);
  assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 9999);
  checkThrows(() => assertVerdictMatchesRelease("FULL_ACCEPTANCE", 9999), "full but not 10000", "BP_VERDICT_MISMATCH");
  checkThrows(() => assertVerdictMatchesRelease("REJECTION", 1), "rejection but non-zero", "BP_VERDICT_MISMATCH");
  checkThrows(() => assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 0), "partial at zero", "BP_VERDICT_MISMATCH");
  checkThrows(
    () => assertVerdictMatchesRelease("PARTIAL_ACCEPTANCE", 10000),
    "partial at full",
    "BP_VERDICT_MISMATCH",
  );
  checkEqual(verdictForRelease(10000), "FULL_ACCEPTANCE", "verdictForRelease(10000)");
  checkEqual(verdictForRelease(0), "REJECTION", "verdictForRelease(0)");
  checkEqual(verdictForRelease(5000), "PARTIAL_ACCEPTANCE", "verdictForRelease(5000)");
  checkEqual(verdictMatchesRelease("REJECTION", 5000), false, "verdictMatchesRelease is total");

  /* ── atomic amount strings ────────────────────────────────────────────── */

  checkEqual(parseAtomic("0").toString(), "0", "parseAtomic zero");
  checkEqual(parseAtomic("250000000").toString(), "250000000", "parseAtomic USDC amount");
  for (const bad of ["", "-1", "01", "1.0", "1e3", " 1", "1 ", "0x10", "abc", "+1"]) {
    checkThrows(() => parseAtomic(bad), `parseAtomic must reject ${JSON.stringify(bad)}`, "BP_AMOUNT");
  }

  finish("TYPES-BP OK");
} catch (error) {
  abort(error);
}
