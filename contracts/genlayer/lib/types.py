"""Domain structures for building payloads that are about to be hashed.

Plain frozen dataclasses. The GenLayer documentation lists dataclasses as a
supported type inside Intelligent Contracts, and `to_dict()` is what makes the
difference between "we built a dict by hand at four call sites" and one shape that
canonicalises the same way every time.

Nothing here touches storage. GenVM storage uses its own annotated class fields
with `DynArray` / `TreeMap` / sized integers; these are in-memory values that get
validated, hashed, and discarded.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .money import BP_DENOMINATOR, split_release
from .validation import validate_decision


@dataclass(frozen=True)
class Allocation:
    agent_id: str
    share_bp: int

    def to_dict(self) -> dict:
        return {"agent_id": self.agent_id, "share_bp": self.share_bp}


@dataclass(frozen=True)
class CriterionFinding:
    criterion_id: str
    met: bool
    confidence_bp: int
    rationale: str

    def to_dict(self) -> dict:
        return {
            "criterion_id": self.criterion_id,
            "met": self.met,
            "confidence_bp": self.confidence_bp,
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class Decision:
    """The adjudication decision — the only structure that crosses to Base.

    `to_dict()` runs the full §7 validation before returning, so a malformed
    decision cannot reach `content_hash` and become a digest the escrow would try
    to settle.
    """

    decision_id: str
    mandate_id: str
    verdict: str
    criteria_findings: list[CriterionFinding]
    release_bp: int
    refund_bp: int
    allocations: list[Allocation] = field(default_factory=list)
    adjudicated_at_unix: int = 0
    notes: str = ""
    schema_version: int = 1

    def to_dict(self) -> dict:
        payload = {
            "schema_version": self.schema_version,
            "decision_id": self.decision_id,
            "mandate_id": self.mandate_id,
            "verdict": self.verdict,
            "criteria_findings": [finding.to_dict() for finding in self.criteria_findings],
            "release_bp": self.release_bp,
            "refund_bp": self.refund_bp,
            "allocations": [allocation.to_dict() for allocation in self.allocations],
            "adjudicated_at_unix": self.adjudicated_at_unix,
            "notes": self.notes,
        }
        return validate_decision(payload)

    def split(self, deposited_atomic: int) -> dict:
        """What this decision pays out of a given deposit."""
        return split_release(
            deposited_atomic,
            self.release_bp,
            self.refund_bp,
            [allocation.to_dict() for allocation in self.allocations],
        )

    @staticmethod
    def from_dict(payload: dict) -> "Decision":
        validated = validate_decision(payload)
        return Decision(
            decision_id=validated["decision_id"],
            mandate_id=validated["mandate_id"],
            verdict=validated["verdict"],
            criteria_findings=[
                CriterionFinding(
                    criterion_id=item["criterion_id"],
                    met=item["met"],
                    confidence_bp=item["confidence_bp"],
                    rationale=item["rationale"],
                )
                for item in validated["criteria_findings"]
            ],
            release_bp=validated["release_bp"],
            refund_bp=validated["refund_bp"],
            allocations=[
                Allocation(agent_id=item["agent_id"], share_bp=item["share_bp"])
                for item in validated["allocations"]
            ],
            adjudicated_at_unix=validated["adjudicated_at_unix"],
            notes=validated["notes"],
            schema_version=validated["schema_version"],
        )


def weighted_release_bp(findings: list[CriterionFinding], weights: dict[str, int]) -> int:
    """Release basis points implied by which criteria were met.

    Sums the weight of every met criterion. This is the deterministic arithmetic the
    adjudicator applies **after** the language model has judged each criterion
    individually — the model never proposes a payout figure directly.

    That split matters. A model asked "how much should they be paid?" produces a
    number nobody can audit. A model asked "was criterion ac_2 met, yes or no, and
    why?" produces a finding that can be checked against the evidence, and the money
    follows from weights the mission fixed in advance.
    """
    total = 0
    for finding in findings:
        if finding.criterion_id not in weights:
            raise ValueError(f"finding references unknown criterion {finding.criterion_id!r}")
        if finding.met:
            total += weights[finding.criterion_id]
    if total > BP_DENOMINATOR:
        raise ValueError(f"criterion weights sum to {total}, above {BP_DENOMINATOR}")
    return total
