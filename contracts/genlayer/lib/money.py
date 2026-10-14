"""Basis-point money math (``docs/ARCHITECTURE.md`` §7, invariant I5).

Must agree exactly with ``packages/types/src/money.ts``. Python's ``int`` is
arbitrary-precision, so atomic amounts are plain ints here where TypeScript needs
``bigint`` — the arithmetic is identical.

The rounding rule is the part worth reading twice:

    Integer division on basis points leaves a remainder. The remainder goes to the
    **refund** leg, never to a payee.

That makes two things true at once. Rounding can never over-pay a worker, and
``sum(payouts) + refund == deposited`` holds exactly for every input — which is the
assertion the escrow makes before it moves a single unit of USDC. Spreading the
remainder across payees would break the second property; giving it to the largest
payee would break the first.
"""

from __future__ import annotations

BP_DENOMINATOR = 10_000

VERDICTS = ("FULL_ACCEPTANCE", "PARTIAL_ACCEPTANCE", "REJECTION")


class MoneyError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _assert_bp(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise MoneyError(
            "BP_RANGE", f"{label} must be an integer number of basis points, got {value!r}"
        )
    if value < 0 or value > BP_DENOMINATOR:
        raise MoneyError("BP_RANGE", f"{label} must be within 0..{BP_DENOMINATOR}, got {value}")
    return value


def assert_bp_pair(release_bp: object, refund_bp: object) -> None:
    """Invariant I5, first half: ``release_bp + refund_bp == 10000`` exactly."""
    release = _assert_bp(release_bp, "release_bp")
    refund = _assert_bp(refund_bp, "refund_bp")
    if release + refund != BP_DENOMINATOR:
        raise MoneyError(
            "BP_SUM",
            f"release_bp + refund_bp must equal {BP_DENOMINATOR} exactly, "
            f"got {release} + {refund} = {release + refund}",
        )


def assert_allocations(allocations: list[dict], release_bp: object) -> None:
    """Invariant I5, second half: allocation shares sum to exactly 10000.

    An empty allocation list is legal **only** when nothing is being released. A
    ``REJECTION`` has no payees, and "shares of zero summing to 10000" would be a
    fiction the escrow would have to special-case. Any non-empty list must sum
    exactly, whatever the verdict.
    """
    release = _assert_bp(release_bp, "release_bp")
    if not allocations:
        if release != 0:
            raise MoneyError(
                "BP_ALLOCATIONS", f"release_bp is {release} but there are no allocations to pay"
            )
        return

    seen: set[str] = set()
    total = 0
    for allocation in allocations:
        if not isinstance(allocation, dict):
            raise MoneyError("BP_ALLOCATIONS", f"allocation must be an object, got {allocation!r}")
        agent_id = allocation.get("agent_id")
        if not isinstance(agent_id, str) or not agent_id:
            raise MoneyError("BP_ALLOCATIONS", f"allocation agent_id must be a string, got {agent_id!r}")
        share = _assert_bp(allocation.get("share_bp"), f"allocation[{agent_id}].share_bp")
        if agent_id in seen:
            # A duplicated payee is how a single worker gets paid twice from one
            # decision.
            raise MoneyError("BP_ALLOCATIONS", f"duplicate allocation for agent {agent_id}")
        seen.add(agent_id)
        total += share
    if total != BP_DENOMINATOR:
        raise MoneyError(
            "BP_ALLOCATIONS", f"allocation shares must sum to {BP_DENOMINATOR} exactly, got {total}"
        )


def assert_verdict_matches_release(verdict: object, release_bp: object) -> None:
    """The verdict label must agree with the numbers (``docs/ARCHITECTURE.md`` §7).

    FULL_ACCEPTANCE ⇒ 10000. REJECTION ⇒ 0. PARTIAL_ACCEPTANCE ⇒ strictly between.
    The escrow re-checks this; it does not trust the label.
    """
    if verdict not in VERDICTS:
        raise MoneyError("BP_VERDICT_MISMATCH", f"unknown verdict {verdict!r}")
    release = _assert_bp(release_bp, "release_bp")
    if verdict == "FULL_ACCEPTANCE":
        ok = release == BP_DENOMINATOR
    elif verdict == "REJECTION":
        ok = release == 0
    else:
        ok = 0 < release < BP_DENOMINATOR
    if not ok:
        raise MoneyError(
            "BP_VERDICT_MISMATCH", f"verdict {verdict} disagrees with release_bp {release}"
        )


def verdict_matches_release(verdict: object, release_bp: object) -> bool:
    try:
        assert_verdict_matches_release(verdict, release_bp)
        return True
    except MoneyError:
        return False


def verdict_for_release(release_bp: object) -> str:
    release = _assert_bp(release_bp, "release_bp")
    if release == BP_DENOMINATOR:
        return "FULL_ACCEPTANCE"
    if release == 0:
        return "REJECTION"
    return "PARTIAL_ACCEPTANCE"


def split_release(
    deposited_atomic: int,
    release_bp: int,
    refund_bp: int,
    allocations: list[dict],
) -> dict:
    """Split a deposit into per-payee amounts plus a refund.

    Two floors happen: ``deposited * release_bp / 10000`` for the pool, then
    ``pool * share_bp / 10000`` for each payee. Both remainders end up in the
    refund, so the result always satisfies ``sum(payouts) + refund == deposited``
    exactly, for any deposit including a single atomic unit.
    """
    if isinstance(deposited_atomic, bool) or not isinstance(deposited_atomic, int):
        raise MoneyError(
            "BP_AMOUNT", f"deposited amount must be an integer of atomic units, got {deposited_atomic!r}"
        )
    if deposited_atomic < 0:
        raise MoneyError("BP_AMOUNT", f"deposited amount cannot be negative: {deposited_atomic}")
    assert_bp_pair(release_bp, refund_bp)
    assert_allocations(allocations, release_bp)

    release_pool = (deposited_atomic * release_bp) // BP_DENOMINATOR

    payouts = []
    paid = 0
    for allocation in allocations:
        amount = (release_pool * allocation["share_bp"]) // BP_DENOMINATOR
        paid += amount
        payouts.append(
            {
                "agent_id": allocation["agent_id"],
                "share_bp": allocation["share_bp"],
                "amount_atomic": amount,
            }
        )

    refund = deposited_atomic - paid
    # Not a test — a runtime assertion on the money path. If this ever fails, the
    # escrow's own balance check would fail too, and it is cheaper to fail here.
    if refund < 0:
        raise MoneyError("BP_AMOUNT", f"payouts {paid} exceed deposit {deposited_atomic}")

    return {
        "deposited_atomic": deposited_atomic,
        "release_pool_atomic": release_pool,
        "payouts": payouts,
        "refund_atomic": refund,
    }


_ATOMIC_OK = frozenset("0123456789")


def parse_atomic(value: object, label: str = "amount_atomic") -> int:
    """Parse a decimal-string atomic amount — the only form allowed to cross a boundary.

    One spelling per value: no sign, no leading zeros, no exponent. Two spellings
    would be two hashes.
    """
    if not isinstance(value, str) or not value:
        raise MoneyError("BP_AMOUNT", f"{label} must be a non-empty decimal string, got {value!r}")
    if not set(value) <= _ATOMIC_OK:
        raise MoneyError("BP_AMOUNT", f"{label} must contain only digits, got {value!r}")
    if len(value) > 1 and value[0] == "0":
        raise MoneyError("BP_AMOUNT", f"{label} must not have leading zeros, got {value!r}")
    if len(value) > 78:
        raise MoneyError("BP_AMOUNT", f"{label} exceeds uint256 width: {len(value)} digits")
    return int(value)
