"""G4: decision-payload validation enforces the docs/ARCHITECTURE.md §7 schema.

Four things must hold, and a payload violating any one of them must be refused before
it can be hashed:

  * release_bp + refund_bp == 10000 exactly
  * allocation shares sum to 10000 exactly
  * the verdict label agrees with the numbers
  * the integer-division remainder goes to the refund leg, so
    sum(payouts) + refund == deposited for every split

The third is the one worth stating plainly: the escrow does not trust the verdict
label, and neither does this. A payload reading FULL_ACCEPTANCE with release_bp 7500
is refused rather than read generously in either direction.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import Checker  # noqa: E402

from lib.money import (  # noqa: E402
    BP_DENOMINATOR,
    assert_allocations,
    assert_bp_pair,
    assert_verdict_matches_release,
    parse_atomic,
    split_release,
    verdict_for_release,
)
from lib.types import Allocation, CriterionFinding, Decision, weighted_release_bp  # noqa: E402
from lib.validation import (  # noqa: E402
    validate_decision,
    validate_deliverable,
    validate_mandate,
    validate_mission,
    validate_proposal,
)

AGENT_A = "agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A"
AGENT_B = "agt_01JQ8ZC1D2E3F4G5H6J7K8M9N0"
DAO = "dao_01JQ8Z1A2B3C4D5E6F7G8H9J0K"
MISSION = "msn_01JQ8Z3X9K2M4N6P8R0T2V4W6Y"
MANDATE = "mnd_01JQ8ZA0B1C2D3E4F5G6H7J8K9"
DECISION = "dec_01JQ8ZB1C2D3E4F5G6H7J8K9M0"
HASH_A = "0x" + "11" * 32
HASH_B = "0x" + "22" * 32

CRITERIA = [
    {"id": "ac_1", "statement": "Adapter refuses a non-finalized decision.", "weight_bp": 4000},
    {"id": "ac_2", "statement": "Adapter is idempotent per decision_id.", "weight_bp": 3500},
    {"id": "ac_3", "statement": "Partial acceptance splits to the basis point.", "weight_bp": 2500},
]
BUDGET = {"asset": "USDC", "chain_id": 84532, "amount_atomic": "250000000", "decimals": 6}


def decision_payload(**overrides) -> dict:
    payload = {
        "schema_version": 1,
        "decision_id": DECISION,
        "mandate_id": MANDATE,
        "verdict": "PARTIAL_ACCEPTANCE",
        "criteria_findings": [
            {"criterion_id": "ac_1", "met": True, "confidence_bp": 9500, "rationale": "Reverts on pending."},
            {"criterion_id": "ac_2", "met": True, "confidence_bp": 9000, "rationale": "Nonce map blocks replay."},
            {"criterion_id": "ac_3", "met": False, "confidence_bp": 7000, "rationale": "Rounds against payee."},
        ],
        "release_bp": 7500,
        "refund_bp": 2500,
        "allocations": [
            {"agent_id": AGENT_A, "share_bp": 6000},
            {"agent_id": AGENT_B, "share_bp": 4000},
        ],
        "adjudicated_at_unix": 1790001234,
        "notes": 'Rounding fixed in follow-up; "as-is" at deadline.',
    }
    payload.update(overrides)
    return payload


def main() -> None:
    checker = Checker()

    # ── the §7 schema accepts a well-formed decision ─────────────────────────
    validate_decision(decision_payload())

    # ── and refuses every documented inconsistency ───────────────────────────
    checker.raises(lambda: validate_decision(decision_payload(refund_bp=2400)), "bp pair below 10000")
    checker.raises(lambda: validate_decision(decision_payload(refund_bp=2600)), "bp pair above 10000")
    checker.raises(
        lambda: validate_decision(decision_payload(verdict="FULL_ACCEPTANCE")),
        "verdict FULL_ACCEPTANCE with release_bp 7500",
    )
    checker.raises(
        lambda: validate_decision(decision_payload(verdict="REJECTION")),
        "verdict REJECTION with release_bp 7500",
    )
    checker.raises(
        lambda: validate_decision(
            decision_payload(allocations=[{"agent_id": AGENT_A, "share_bp": 5999}, {"agent_id": AGENT_B, "share_bp": 4000}])
        ),
        "allocation shares summing to 9999",
    )
    checker.raises(
        lambda: validate_decision(decision_payload(allocations=[])),
        "a release with nobody to pay",
    )
    checker.raises(
        lambda: validate_decision(
            decision_payload(allocations=[{"agent_id": AGENT_A, "share_bp": 6000}, {"agent_id": AGENT_A, "share_bp": 4000}])
        ),
        "a duplicated payee",
    )
    checker.raises(
        lambda: validate_decision(decision_payload(release_bp=7500.0, refund_bp=2500)),
        "a float release_bp",
    )
    checker.raises(lambda: validate_decision(decision_payload(surprise=1)), "an unknown field")
    checker.raises(
        lambda: validate_decision({k: v for k, v in decision_payload().items() if k != "notes"}),
        "a missing field",
    )
    checker.raises(lambda: validate_decision(decision_payload(schema_version=2)), "a future schema_version")
    checker.raises(lambda: validate_decision(decision_payload(verdict="MAYBE")), "an unknown verdict")
    checker.raises(
        lambda: validate_decision(decision_payload(adjudicated_at_unix=1790001234000)),
        "a millisecond timestamp in a seconds field",
    )
    checker.raises(
        lambda: validate_decision(decision_payload(decision_id="dec_01JQ8Z0Q1R2S3T4U5V6W7X8Y9Z")),
        "an id containing U, which is not Crockford base32",
    )
    findings = decision_payload()["criteria_findings"]
    duplicated = [findings[0], dict(findings[1], criterion_id="ac_1"), findings[2]]
    checker.raises(
        lambda: validate_decision(decision_payload(criteria_findings=duplicated)),
        "two findings for one criterion",
    )

    # Legal shapes at the extremes.
    validate_decision(decision_payload(verdict="FULL_ACCEPTANCE", release_bp=10000, refund_bp=0))
    validate_decision(decision_payload(verdict="REJECTION", release_bp=0, refund_bp=10000, allocations=[]))
    # A rejection may still name the workers; each simply receives zero.
    validate_decision(decision_payload(verdict="REJECTION", release_bp=0, refund_bp=10000))
    validate_decision(decision_payload(notes=""))

    # ── the split arithmetic ─────────────────────────────────────────────────
    seven = [
        {"agent_id": f"agt_{i}", "share_bp": share}
        for i, share in enumerate([1429, 1429, 1429, 1429, 1428, 1428, 1428])
    ]
    checker.equal(sum(entry["share_bp"] for entry in seven), BP_DENOMINATOR, "the 7-way split sums to 10000")

    cases = 0
    for deposited in (0, 1, 2, 7, 13, 99, 1000000, 250000000, 10**30, (1 << 200) + 12345):
        for release_bp in (0, 1, 3333, 5000, 7500, 9999, 10000):
            allocations = [] if release_bp == 0 else seven
            result = split_release(deposited, release_bp, 10000 - release_bp, allocations)
            paid = sum(payout["amount_atomic"] for payout in result["payouts"])
            cases += 1
            # The assertion the escrow makes before moving USDC.
            checker.equal(
                paid + result["refund_atomic"], deposited, f"deposit {deposited} at {release_bp}bp: conservation"
            )
            # The remainder is in the refund, never handed to a payee.
            nominal_refund = (deposited * (10000 - release_bp)) // BP_DENOMINATOR
            checker.check(
                result["refund_atomic"] >= nominal_refund,
                f"deposit {deposited} at {release_bp}bp: refund holds the remainder",
            )
            checker.check(
                paid <= result["release_pool_atomic"],
                f"deposit {deposited} at {release_bp}bp: payouts within the pool",
            )
            for payout in result["payouts"]:
                checker.equal(
                    payout["amount_atomic"],
                    (result["release_pool_atomic"] * payout["share_bp"]) // BP_DENOMINATOR,
                    f"deposit {deposited}: payee floor",
                )
    checker.check(cases >= 70, f"expected at least 70 split cases, ran {cases}")

    # 10 units over three near-equal payees: the floors shed one unit and it must land
    # in the refund rather than going to whoever happens to be listed first.
    shed = split_release(10, 10000, 0, [{"agent_id": "a", "share_bp": 3334}, {"agent_id": "b", "share_bp": 3333}, {"agent_id": "c", "share_bp": 3333}])
    checker.equal([p["amount_atomic"] for p in shed["payouts"]], [3, 3, 3], "each payee floors to 3")
    checker.equal(shed["refund_atomic"], 1, "the shed unit goes to the refund")

    # A single atomic unit at half release must pay nobody rather than round up.
    tiny = split_release(1, 5000, 5000, [{"agent_id": "a", "share_bp": 10000}])
    checker.equal(tiny["payouts"][0]["amount_atomic"], 0, "never over-pay when the pool floors to zero")
    checker.equal(tiny["refund_atomic"], 1, "the whole unit refunds")

    checker.raises(lambda: split_release(-1, 10000, 0, [{"agent_id": "a", "share_bp": 10000}]), "negative deposit", "BP_AMOUNT")
    checker.raises(lambda: split_release(1.0, 10000, 0, [{"agent_id": "a", "share_bp": 10000}]), "float deposit", "BP_AMOUNT")
    checker.raises(lambda: split_release(True, 10000, 0, [{"agent_id": "a", "share_bp": 10000}]), "boolean deposit", "BP_AMOUNT")

    # ── basis-point helpers ──────────────────────────────────────────────────
    checker.raises(lambda: assert_bp_pair(7500, 2400), "bp pair", "BP_SUM")
    checker.raises(lambda: assert_bp_pair(-1, 10001), "bp range", "BP_RANGE")
    checker.raises(lambda: assert_bp_pair(7500.0, 2500), "float bp", "BP_RANGE")
    checker.raises(lambda: assert_bp_pair(True, 9999), "boolean bp", "BP_RANGE")
    checker.raises(lambda: assert_allocations([{"agent_id": "a", "share_bp": 9999}], 10000), "shares below 10000", "BP_ALLOCATIONS")
    checker.raises(lambda: assert_allocations([], 1), "release with no payees", "BP_ALLOCATIONS")
    assert_allocations([], 0)
    for verdict, release in (("FULL_ACCEPTANCE", 10000), ("REJECTION", 0), ("PARTIAL_ACCEPTANCE", 1), ("PARTIAL_ACCEPTANCE", 9999)):
        assert_verdict_matches_release(verdict, release)
    for verdict, release in (("FULL_ACCEPTANCE", 9999), ("REJECTION", 1), ("PARTIAL_ACCEPTANCE", 0), ("PARTIAL_ACCEPTANCE", 10000)):
        checker.raises(lambda v=verdict, r=release: assert_verdict_matches_release(v, r), f"{verdict} at {release}bp", "BP_VERDICT_MISMATCH")
    checker.equal(verdict_for_release(10000), "FULL_ACCEPTANCE", "verdict_for_release(10000)")
    checker.equal(verdict_for_release(0), "REJECTION", "verdict_for_release(0)")
    checker.equal(verdict_for_release(5000), "PARTIAL_ACCEPTANCE", "verdict_for_release(5000)")

    for bad in ("", "01", "-1", "1.0", "1e3", " 1", "0x10", "abc", "+1"):
        checker.raises(lambda b=bad: parse_atomic(b), f"parse_atomic must refuse {bad!r}", "BP_AMOUNT")
    checker.equal(parse_atomic("250000000"), 250000000, "parse_atomic USDC amount")
    checker.equal(parse_atomic("0"), 0, "parse_atomic zero")

    # ── the Decision dataclass validates on the way out ──────────────────────
    decision = Decision.from_dict(decision_payload())
    checker.equal(decision.to_dict(), decision_payload(), "Decision round-trips its payload")
    split = decision.split(250000000)
    checker.equal(split["payouts"][0]["amount_atomic"], 112500000, "Decision.split pays the first worker")
    checker.equal(split["refund_atomic"], 62500000, "Decision.split refunds the rest")
    bad_decision = Decision(
        decision_id=DECISION,
        mandate_id=MANDATE,
        verdict="FULL_ACCEPTANCE",
        criteria_findings=[CriterionFinding("ac_1", True, 10000, "ok")],
        release_bp=7500,
        refund_bp=2500,
        allocations=[Allocation(AGENT_A, 10000)],
        adjudicated_at_unix=1790001234,
    )
    checker.raises(bad_decision.to_dict, "a mislabelled Decision cannot reach content_hash")

    # Release is computed from the mission's own weights, never proposed by a model.
    weights = {criterion["id"]: criterion["weight_bp"] for criterion in CRITERIA}
    met_two = [CriterionFinding("ac_1", True, 9500, "x"), CriterionFinding("ac_2", True, 9000, "y"), CriterionFinding("ac_3", False, 7000, "z")]
    checker.equal(weighted_release_bp(met_two, weights), 7500, "two of three criteria met gives 7500bp")
    checker.equal(weighted_release_bp([CriterionFinding(c["id"], True, 10000, "x") for c in CRITERIA], weights), 10000, "all met gives full release")
    checker.equal(weighted_release_bp([CriterionFinding(c["id"], False, 10000, "x") for c in CRITERIA], weights), 0, "none met gives zero")
    checker.raises(lambda: weighted_release_bp([CriterionFinding("ac_9", True, 1, "x")], weights), "a finding for an unknown criterion")

    # ── the other payloads ───────────────────────────────────────────────────
    mission = {
        "schema_version": 1,
        "mission_id": MISSION,
        "dao_id": DAO,
        "creator_agent_id": AGENT_A,
        "title": "Ship a GenLayer settlement adapter",
        "outcome_statement": "A deployed adapter that releases USDC only after finality.",
        "acceptance_criteria": CRITERIA,
        "budget": BUDGET,
        "deadline_unix": 1790000000,
        "evidence_requirements": ["source_repository", "test_output"],
        "allow_teams": True,
        "max_team_size": 3,
    }
    validate_mission(mission)
    checker.raises(lambda: validate_mission({**mission, "allow_teams": False}), "teams disallowed but max_team_size 3")
    validate_mission({**mission, "allow_teams": False, "max_team_size": 1})
    checker.raises(
        lambda: validate_mission({**mission, "acceptance_criteria": [dict(CRITERIA[0], weight_bp=3999), CRITERIA[1], CRITERIA[2]]}),
        "criterion weights summing to 9999",
    )
    checker.raises(
        lambda: validate_mission({**mission, "acceptance_criteria": [CRITERIA[0], dict(CRITERIA[1], id="ac_1"), CRITERIA[2]]}),
        "duplicate criterion ids",
    )
    checker.raises(lambda: validate_mission({**mission, "budget": dict(BUDGET, amount_atomic=250000000)}), "a numeric budget amount")
    checker.raises(lambda: validate_mission({**mission, "budget": dict(BUDGET, asset="DAI")}), "a non-USDC asset")

    proposal = {
        "schema_version": 1,
        "proposal_id": "prp_01JQ8ZE1F2G3H4J5K6M7N8P9Q0",
        "mission_id": MISSION,
        "dao_id": DAO,
        "agent_id": AGENT_A,
        "capabilities": ["smart-contract-analysis"],
        "proposed_strategy": "Build the adapter, then prove it refuses pending decisions.",
        "execution_plan": ["Write the escrow", "Prove the negatives"],
        "deliverables": ["WRKEscrow.sol"],
        "evidence_plan": ["Source repository"],
        "estimated_duration_seconds": 604800,
        "requested_budget": BUDGET,
        "team_members": [{"agent_id": AGENT_A, "share_bp": 6000}, {"agent_id": AGENT_B, "share_bp": 4000}],
        "submitted_at_unix": 1789000000,
    }
    validate_proposal(proposal)
    validate_proposal({**proposal, "team_members": []})
    checker.raises(
        lambda: validate_proposal({**proposal, "team_members": [{"agent_id": AGENT_A, "share_bp": 5000}]}),
        "team shares summing to 5000",
    )

    mandate = {
        "schema_version": 1,
        "mandate_id": MANDATE,
        "dao_id": DAO,
        "mission_id": MISSION,
        "creator_agent_id": AGENT_A,
        "workers": [{"agent_id": AGENT_A, "share_bp": 6000}, {"agent_id": AGENT_B, "share_bp": 4000}],
        "objective": "Deliver the settlement adapter.",
        "deliverables": ["WRKEscrow.sol"],
        "budget": BUDGET,
        "deadline_unix": 1790000000,
        "acceptance_criteria": CRITERIA,
        "evidence_requirements": ["source_repository"],
        "proposal_hash": HASH_A,
        "selection_decision_hash": HASH_B,
        "created_at_unix": 1789500000,
    }
    validate_mandate(mandate)
    checker.raises(lambda: validate_mandate({**mandate, "workers": []}), "a mandate with no workers")
    checker.raises(lambda: validate_mandate({**mandate, "proposal_hash": "0xdead"}), "a malformed proposal hash")
    checker.raises(lambda: validate_mandate({**mandate, "proposal_hash": HASH_A.upper()}), "an uppercase hash")

    evidence = {
        "evidence_id": "evd_01JQ8ZF1G2H3J4K5M6N7P8Q9R0",
        "mandate_id": MANDATE,
        "worker_agent_id": AGENT_A,
        "type": "github_commit",
        "uri": "https://github.com/example/repo/commit/abc123",
        "content_hash": HASH_A,
        "mime_type": "text/plain",
        "description": "Implementation of the requested module.",
        "created_at_unix": 1789900000,
    }
    deliverable = {
        "schema_version": 1,
        "deliverable_id": "dlv_01JQ8ZG1H2J3K4M5N6P7Q8R9S0",
        "mandate_id": MANDATE,
        "worker_agent_id": AGENT_A,
        "title": "Escrow contract",
        "summary": "WRKEscrow.sol with tests.",
        "satisfies_indices": [0],
        "evidence": [evidence],
        "submitted_at_unix": 1789950000,
    }
    validate_deliverable(deliverable)
    checker.raises(
        lambda: validate_deliverable({**deliverable, "evidence": [dict(evidence, mandate_id="mnd_01JQ8ZH1J2K3M4N5P6Q7R8S9T0")]}),
        "evidence belonging to another mandate",
    )
    checker.raises(lambda: validate_deliverable({**deliverable, "evidence": [evidence, evidence]}), "duplicate evidence")
    checker.raises(lambda: validate_deliverable({**deliverable, "satisfies_indices": [0, 0]}), "a repeated satisfies index")
    checker.raises(
        lambda: validate_deliverable({**deliverable, "evidence": [dict(evidence, uri="ipfs://QmSomething")]}),
        "a non-https evidence URI",
    )

    checker.finish("GENLIB-VALIDATION OK")


if __name__ == "__main__":
    main()
