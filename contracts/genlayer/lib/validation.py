"""Payload validation — the shapes that get hashed, checked before they are hashed.

Mirrors ``packages/types/src/schemas.ts``. Zod is not available inside the GenVM, so
the checks are written out; the field names, bounds and cross-field rules are the
same, and ``verify_validation.py`` pins the ones that matter.

Validation is **strict**: an unknown key is an error, not something to ignore.
Because the payload is hashed, a field you did not intend to send changes the digest
the escrow settles against, and a field silently dropped changes it the other way.
Adding a field is a ``schema_version`` bump, not a patch.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from .ids import id_pattern
from .money import (
    BP_DENOMINATOR,
    VERDICTS,
    assert_allocations,
    assert_bp_pair,
    assert_verdict_matches_release,
    parse_atomic,
)

SCHEMA_VERSION = 1

#: Bounded so a millisecond value pasted into a seconds field is rejected rather
#: than read as a date 30 millennia out.
MIN_UNIX_SECONDS = 1_000_000_000
MAX_UNIX_SECONDS = 9_999_999_999

CRITERION_ID = re.compile(r"^[a-z0-9_]{1,32}$")
CONTENT_HASH = re.compile(r"^0x[0-9a-f]{64}$")
HTTPS_URI = re.compile(r"^https://\S+$")

EVIDENCE_TYPES = (
    "github_commit",
    "github_pull_request",
    "source_repository",
    "test_output",
    "deployed_address",
    "transaction_hash",
    "document",
    "dataset",
    "screenshot",
    "other",
)


class ValidationError(ValueError):
    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__(f"SCHEMA_INVALID: {path}: {message}")
        self.code = "SCHEMA_INVALID"
        self.path = path


def _require_keys(value: Any, required: Iterable[str], path: str) -> dict:
    if not isinstance(value, dict):
        raise ValidationError(f"expected an object, got {type(value).__name__}", path)
    required_set = set(required)
    present = set(value.keys())
    missing = sorted(required_set - present)
    if missing:
        raise ValidationError(f"missing required field(s): {', '.join(missing)}", path)
    unknown = sorted(present - required_set)
    if unknown:
        # Strict on purpose: see the module docstring.
        raise ValidationError(f"unknown field(s): {', '.join(unknown)}", path)
    return value


def _string(value: Any, path: str, *, min_len: int = 1, max_len: int = 4000) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"expected a string, got {type(value).__name__}", path)
    if not min_len <= len(value) <= max_len:
        raise ValidationError(f"length must be {min_len}..{max_len}, got {len(value)}", path)
    return value


def _integer(value: Any, path: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"expected an integer, got {type(value).__name__}", path)
    if not minimum <= value <= maximum:
        raise ValidationError(f"must be {minimum}..{maximum}, got {value}", path)
    return value


def _bool(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        raise ValidationError(f"expected a boolean, got {type(value).__name__}", path)
    return value


def _list(value: Any, path: str, *, min_len: int = 0, max_len: int = 64) -> list:
    if not isinstance(value, list):
        raise ValidationError(f"expected an array, got {type(value).__name__}", path)
    if not min_len <= len(value) <= max_len:
        raise ValidationError(f"length must be {min_len}..{max_len}, got {len(value)}", path)
    return value


def _id(value: Any, prefix: str, path: str) -> str:
    text = _string(value, path, max_len=64)
    if not re.match(id_pattern(prefix), text):
        raise ValidationError(
            f"must be a {prefix}_ prefixed ULID in Crockford base32 (no I/L/O/U), got {text!r}", path
        )
    return text


def _unix_seconds(value: Any, path: str) -> int:
    return _integer(value, path, minimum=MIN_UNIX_SECONDS, maximum=MAX_UNIX_SECONDS)


def _bp(value: Any, path: str) -> int:
    return _integer(value, path, minimum=0, maximum=BP_DENOMINATOR)


def _schema_version(value: Any, path: str) -> int:
    if value != SCHEMA_VERSION:
        raise ValidationError(f"expected schema_version {SCHEMA_VERSION}, got {value!r}", path)
    return SCHEMA_VERSION


def _content_hash(value: Any, path: str) -> str:
    text = _string(value, path, min_len=66, max_len=66)
    if not CONTENT_HASH.match(text):
        raise ValidationError("must be a lowercase 0x-prefixed 32-byte hex digest", path)
    return text


def _budget(value: Any, path: str) -> dict:
    budget = _require_keys(value, ("asset", "chain_id", "amount_atomic", "decimals"), path)
    if budget["asset"] != "USDC":
        raise ValidationError(f"only USDC is supported in the MVP, got {budget['asset']!r}", f"{path}.asset")
    _integer(budget["chain_id"], f"{path}.chain_id", minimum=1, maximum=2**63 - 1)
    parse_atomic(budget["amount_atomic"], f"{path}.amount_atomic")
    _integer(budget["decimals"], f"{path}.decimals", minimum=0, maximum=18)
    return budget


def _allocation(value: Any, path: str) -> dict:
    allocation = _require_keys(value, ("agent_id", "share_bp"), path)
    _id(allocation["agent_id"], "agt", f"{path}.agent_id")
    _bp(allocation["share_bp"], f"{path}.share_bp")
    return allocation


def _acceptance_criteria(value: Any, path: str) -> list:
    criteria = _list(value, path, min_len=1, max_len=32)
    seen: set[str] = set()
    total = 0
    for index, item in enumerate(criteria):
        item_path = f"{path}[{index}]"
        criterion = _require_keys(item, ("id", "statement", "weight_bp"), item_path)
        identifier = _string(criterion["id"], f"{item_path}.id", max_len=32)
        if not CRITERION_ID.match(identifier):
            raise ValidationError("criterion ids are lowercase snake_case, max 32 chars", f"{item_path}.id")
        if identifier in seen:
            raise ValidationError(f"duplicate criterion id {identifier}", path)
        seen.add(identifier)
        _string(criterion["statement"], f"{item_path}.statement", max_len=2000)
        total += _bp(criterion["weight_bp"], f"{item_path}.weight_bp")
    if total != BP_DENOMINATOR:
        raise ValidationError(f"criterion weights must sum to {BP_DENOMINATOR} exactly, got {total}", path)
    return criteria


def _shares_sum_to_denominator(entries: list, path: str, label: str) -> None:
    total = sum(entry["share_bp"] for entry in entries)
    if total != BP_DENOMINATOR:
        raise ValidationError(f"{label} must sum to {BP_DENOMINATOR} exactly, got {total}", path)
    seen: set[str] = set()
    for entry in entries:
        if entry["agent_id"] in seen:
            raise ValidationError(f"duplicate {label.split()[0]} {entry['agent_id']}", path)
        seen.add(entry["agent_id"])


# ── mission (SPEC §17) ───────────────────────────────────────────────────────

MISSION_FIELDS = (
    "schema_version",
    "mission_id",
    "dao_id",
    "creator_agent_id",
    "title",
    "outcome_statement",
    "acceptance_criteria",
    "budget",
    "deadline_unix",
    "evidence_requirements",
    "allow_teams",
    "max_team_size",
)


def validate_mission(payload: Any) -> dict:
    mission = _require_keys(payload, MISSION_FIELDS, "mission")
    _schema_version(mission["schema_version"], "mission.schema_version")
    _id(mission["mission_id"], "msn", "mission.mission_id")
    _id(mission["dao_id"], "dao", "mission.dao_id")
    _id(mission["creator_agent_id"], "agt", "mission.creator_agent_id")
    _string(mission["title"], "mission.title", max_len=200)
    _string(mission["outcome_statement"], "mission.outcome_statement", max_len=4000)
    _acceptance_criteria(mission["acceptance_criteria"], "mission.acceptance_criteria")
    _budget(mission["budget"], "mission.budget")
    _unix_seconds(mission["deadline_unix"], "mission.deadline_unix")
    requirements = _list(mission["evidence_requirements"], "mission.evidence_requirements", min_len=1, max_len=32)
    for index, requirement in enumerate(requirements):
        _string(requirement, f"mission.evidence_requirements[{index}]", max_len=64)
    allow_teams = _bool(mission["allow_teams"], "mission.allow_teams")
    max_team = _integer(mission["max_team_size"], "mission.max_team_size", minimum=1, maximum=16)
    if not allow_teams and max_team != 1:
        raise ValidationError("max_team_size must be 1 when allow_teams is false", "mission.max_team_size")
    return mission


# ── proposal (SPEC §19) ──────────────────────────────────────────────────────

PROPOSAL_FIELDS = (
    "schema_version",
    "proposal_id",
    "mission_id",
    "dao_id",
    "agent_id",
    "capabilities",
    "proposed_strategy",
    "execution_plan",
    "deliverables",
    "evidence_plan",
    "estimated_duration_seconds",
    "requested_budget",
    "team_members",
    "submitted_at_unix",
)


def validate_proposal(payload: Any) -> dict:
    proposal = _require_keys(payload, PROPOSAL_FIELDS, "proposal")
    _schema_version(proposal["schema_version"], "proposal.schema_version")
    _id(proposal["proposal_id"], "prp", "proposal.proposal_id")
    _id(proposal["mission_id"], "msn", "proposal.mission_id")
    _id(proposal["dao_id"], "dao", "proposal.dao_id")
    _id(proposal["agent_id"], "agt", "proposal.agent_id")
    for field, bounds in (
        ("capabilities", (1, 32, 64)),
        ("execution_plan", (1, 64, 2000)),
        ("deliverables", (1, 32, 500)),
        ("evidence_plan", (1, 32, 500)),
    ):
        low, high, item_max = bounds
        items = _list(proposal[field], f"proposal.{field}", min_len=low, max_len=high)
        for index, item in enumerate(items):
            _string(item, f"proposal.{field}[{index}]", max_len=item_max)
    _string(proposal["proposed_strategy"], "proposal.proposed_strategy", max_len=8000)
    _integer(
        proposal["estimated_duration_seconds"],
        "proposal.estimated_duration_seconds",
        minimum=1,
        maximum=31_536_000,
    )
    _budget(proposal["requested_budget"], "proposal.requested_budget")
    team = _list(proposal["team_members"], "proposal.team_members", max_len=16)
    for index, member in enumerate(team):
        _allocation(member, f"proposal.team_members[{index}]")
    if team:
        _shares_sum_to_denominator(team, "proposal.team_members", "team shares")
    _unix_seconds(proposal["submitted_at_unix"], "proposal.submitted_at_unix")
    return proposal


# ── mandate (SPEC §25) ───────────────────────────────────────────────────────

MANDATE_FIELDS = (
    "schema_version",
    "mandate_id",
    "dao_id",
    "mission_id",
    "creator_agent_id",
    "workers",
    "objective",
    "deliverables",
    "budget",
    "deadline_unix",
    "acceptance_criteria",
    "evidence_requirements",
    "proposal_hash",
    "selection_decision_hash",
    "created_at_unix",
)


def validate_mandate(payload: Any) -> dict:
    mandate = _require_keys(payload, MANDATE_FIELDS, "mandate")
    _schema_version(mandate["schema_version"], "mandate.schema_version")
    _id(mandate["mandate_id"], "mnd", "mandate.mandate_id")
    _id(mandate["dao_id"], "dao", "mandate.dao_id")
    _id(mandate["mission_id"], "msn", "mandate.mission_id")
    _id(mandate["creator_agent_id"], "agt", "mandate.creator_agent_id")
    workers = _list(mandate["workers"], "mandate.workers", min_len=1, max_len=16)
    for index, worker in enumerate(workers):
        _allocation(worker, f"mandate.workers[{index}]")
    _shares_sum_to_denominator(workers, "mandate.workers", "worker shares")
    _string(mandate["objective"], "mandate.objective", max_len=4000)
    deliverables = _list(mandate["deliverables"], "mandate.deliverables", min_len=1, max_len=32)
    for index, item in enumerate(deliverables):
        _string(item, f"mandate.deliverables[{index}]", max_len=500)
    _budget(mandate["budget"], "mandate.budget")
    _unix_seconds(mandate["deadline_unix"], "mandate.deadline_unix")
    _acceptance_criteria(mandate["acceptance_criteria"], "mandate.acceptance_criteria")
    requirements = _list(mandate["evidence_requirements"], "mandate.evidence_requirements", min_len=1, max_len=32)
    for index, requirement in enumerate(requirements):
        _string(requirement, f"mandate.evidence_requirements[{index}]", max_len=64)
    _content_hash(mandate["proposal_hash"], "mandate.proposal_hash")
    _content_hash(mandate["selection_decision_hash"], "mandate.selection_decision_hash")
    _unix_seconds(mandate["created_at_unix"], "mandate.created_at_unix")
    return mandate


# ── evidence and deliverables (SPEC §29, §30) ────────────────────────────────

EVIDENCE_FIELDS = (
    "evidence_id",
    "mandate_id",
    "worker_agent_id",
    "type",
    "uri",
    "content_hash",
    "mime_type",
    "description",
    "created_at_unix",
)


def validate_evidence(payload: Any, path: str = "evidence") -> dict:
    evidence = _require_keys(payload, EVIDENCE_FIELDS, path)
    _id(evidence["evidence_id"], "evd", f"{path}.evidence_id")
    _id(evidence["mandate_id"], "mnd", f"{path}.mandate_id")
    _id(evidence["worker_agent_id"], "agt", f"{path}.worker_agent_id")
    if evidence["type"] not in EVIDENCE_TYPES:
        raise ValidationError(f"unknown evidence type {evidence['type']!r}", f"{path}.type")
    uri = _string(evidence["uri"], f"{path}.uri", max_len=2048)
    if not HTTPS_URI.match(uri):
        # SPEC §29: HTTPS/GitHub plus hashes for the MVP. IPFS is deliberately not
        # a requirement for the first version.
        raise ValidationError("evidence URIs must be https:// for the MVP", f"{path}.uri")
    _content_hash(evidence["content_hash"], f"{path}.content_hash")
    _string(evidence["mime_type"], f"{path}.mime_type", min_len=3, max_len=128)
    _string(evidence["description"], f"{path}.description", max_len=2000)
    _unix_seconds(evidence["created_at_unix"], f"{path}.created_at_unix")
    return evidence


DELIVERABLE_FIELDS = (
    "schema_version",
    "deliverable_id",
    "mandate_id",
    "worker_agent_id",
    "title",
    "summary",
    "satisfies_indices",
    "evidence",
    "submitted_at_unix",
)


def validate_deliverable(payload: Any) -> dict:
    deliverable = _require_keys(payload, DELIVERABLE_FIELDS, "deliverable")
    _schema_version(deliverable["schema_version"], "deliverable.schema_version")
    _id(deliverable["deliverable_id"], "dlv", "deliverable.deliverable_id")
    mandate_id = _id(deliverable["mandate_id"], "mnd", "deliverable.mandate_id")
    _id(deliverable["worker_agent_id"], "agt", "deliverable.worker_agent_id")
    _string(deliverable["title"], "deliverable.title", max_len=200)
    _string(deliverable["summary"], "deliverable.summary", max_len=8000)

    indices = _list(deliverable["satisfies_indices"], "deliverable.satisfies_indices", min_len=1, max_len=32)
    seen_indices: set[int] = set()
    for position, index in enumerate(indices):
        value = _integer(index, f"deliverable.satisfies_indices[{position}]", minimum=0, maximum=31)
        if value in seen_indices:
            raise ValidationError("satisfies_indices must not repeat an index", "deliverable.satisfies_indices")
        seen_indices.add(value)

    items = _list(deliverable["evidence"], "deliverable.evidence", min_len=1, max_len=64)
    seen_evidence: set[str] = set()
    for index, item in enumerate(items):
        evidence = validate_evidence(item, f"deliverable.evidence[{index}]")
        if evidence["mandate_id"] != mandate_id:
            raise ValidationError(
                f"evidence {evidence['evidence_id']} belongs to mandate {evidence['mandate_id']}, "
                f"not {mandate_id}",
                "deliverable.evidence",
            )
        if evidence["evidence_id"] in seen_evidence:
            raise ValidationError(f"duplicate evidence {evidence['evidence_id']}", "deliverable.evidence")
        seen_evidence.add(evidence["evidence_id"])

    _unix_seconds(deliverable["submitted_at_unix"], "deliverable.submitted_at_unix")
    return deliverable


# ── decision (docs/ARCHITECTURE.md §7) ───────────────────────────────────────

DECISION_FIELDS = (
    "schema_version",
    "decision_id",
    "mandate_id",
    "verdict",
    "criteria_findings",
    "release_bp",
    "refund_bp",
    "allocations",
    "adjudicated_at_unix",
    "notes",
)


def validate_decision(payload: Any) -> dict:
    """Validate the one structure that crosses from GenLayer to Base.

    Its content hash is what the escrow settles against, so every rule here is also
    re-checked on-chain. The escrow does not trust the verdict label to match the
    numbers, and neither does this.
    """
    decision = _require_keys(payload, DECISION_FIELDS, "decision")
    _schema_version(decision["schema_version"], "decision.schema_version")
    _id(decision["decision_id"], "dec", "decision.decision_id")
    _id(decision["mandate_id"], "mnd", "decision.mandate_id")

    verdict = decision["verdict"]
    if verdict not in VERDICTS:
        raise ValidationError(f"unknown verdict {verdict!r}", "decision.verdict")

    findings = _list(decision["criteria_findings"], "decision.criteria_findings", min_len=1, max_len=32)
    seen: set[str] = set()
    for index, item in enumerate(findings):
        path = f"decision.criteria_findings[{index}]"
        finding = _require_keys(item, ("criterion_id", "met", "confidence_bp", "rationale"), path)
        criterion_id = _string(finding["criterion_id"], f"{path}.criterion_id", max_len=32)
        if not CRITERION_ID.match(criterion_id):
            raise ValidationError("criterion ids are lowercase snake_case, max 32 chars", f"{path}.criterion_id")
        if criterion_id in seen:
            raise ValidationError(
                f"duplicate finding for criterion {criterion_id}", "decision.criteria_findings"
            )
        seen.add(criterion_id)
        _bool(finding["met"], f"{path}.met")
        _bp(finding["confidence_bp"], f"{path}.confidence_bp")
        _string(finding["rationale"], f"{path}.rationale", max_len=4000)

    release_bp = _bp(decision["release_bp"], "decision.release_bp")
    refund_bp = _bp(decision["refund_bp"], "decision.refund_bp")
    try:
        assert_bp_pair(release_bp, refund_bp)
        assert_verdict_matches_release(verdict, release_bp)
    except ValueError as error:
        raise ValidationError(str(error), "decision") from error

    allocations = _list(decision["allocations"], "decision.allocations", max_len=16)
    for index, allocation in enumerate(allocations):
        _allocation(allocation, f"decision.allocations[{index}]")
    try:
        assert_allocations(allocations, release_bp)
    except ValueError as error:
        raise ValidationError(str(error), "decision.allocations") from error

    _unix_seconds(decision["adjudicated_at_unix"], "decision.adjudicated_at_unix")
    _string(decision["notes"], "decision.notes", min_len=0, max_len=8000)
    return decision


# ── agent profile (SPEC §19 agents, §20 capabilities) ────────────────────────

CAPABILITY_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")

CAPABILITY_FIELDS = ("capability_id", "name", "description", "version", "evidence")


def _capability(value: Any, path: str) -> dict:
    """One capability. SPEC §20 is explicit that capabilities are not bare strings.

    `evidence` is required and must be a real URI. A capability an agent merely claims is
    a claim; GenLayer can only evaluate whether a proposal demonstrates a capability if
    there is something to point at.
    """
    capability = _require_keys(value, CAPABILITY_FIELDS, path)
    identifier = _string(capability["capability_id"], f"{path}.capability_id", max_len=64)
    if not CAPABILITY_ID.match(identifier):
        raise ValidationError("capability ids are lowercase kebab-case, max 63 chars", f"{path}.capability_id")
    _string(capability["name"], f"{path}.name", max_len=120)
    _string(capability["description"], f"{path}.description", max_len=2000)
    _string(capability["version"], f"{path}.version", max_len=32)
    uri = _string(capability["evidence"], f"{path}.evidence", max_len=2048)
    if not HTTPS_URI.match(uri):
        raise ValidationError("capability evidence must be an https:// URI", f"{path}.evidence")
    return capability


AGENT_PROFILE_FIELDS = (
    "schema_version",
    "agent_id",
    "name",
    "operator",
    "capabilities",
    "created_at_unix",
)


def validate_agent_profile(payload: Any) -> dict:
    profile = _require_keys(payload, AGENT_PROFILE_FIELDS, "agent")
    _schema_version(profile["schema_version"], "agent.schema_version")
    _id(profile["agent_id"], "agt", "agent.agent_id")
    _string(profile["name"], "agent.name", max_len=120)
    operator = _string(profile["operator"], "agent.operator", min_len=42, max_len=42)
    if not EVM_ADDRESS.match(operator):
        raise ValidationError("operator must be a 0x-prefixed 20-byte address", "agent.operator")

    capabilities = _list(profile["capabilities"], "agent.capabilities", min_len=1, max_len=32)
    seen: set[str] = set()
    for index, item in enumerate(capabilities):
        capability = _capability(item, f"agent.capabilities[{index}]")
        if capability["capability_id"] in seen:
            raise ValidationError(
                f"duplicate capability {capability['capability_id']}", "agent.capabilities"
            )
        seen.add(capability["capability_id"])

    _unix_seconds(profile["created_at_unix"], "agent.created_at_unix")
    return profile


# ── DAO metadata and rules (SPEC §305) ───────────────────────────────────────

DAO_METADATA_FIELDS = (
    "schema_version",
    "dao_id",
    "name",
    "purpose",
    "creator_agent_id",
    "created_at_unix",
)


def validate_dao_metadata(payload: Any) -> dict:
    dao = _require_keys(payload, DAO_METADATA_FIELDS, "dao")
    _schema_version(dao["schema_version"], "dao.schema_version")
    _id(dao["dao_id"], "dao", "dao.dao_id")
    _string(dao["name"], "dao.name", max_len=120)
    _string(dao["purpose"], "dao.purpose", max_len=4000)
    _id(dao["creator_agent_id"], "agt", "dao.creator_agent_id")
    _unix_seconds(dao["created_at_unix"], "dao.created_at_unix")
    return dao


MEMBERSHIP_MODES = ("open", "invite")

DAO_RULES_FIELDS = (
    "schema_version",
    "dao_id",
    "version",
    "membership",
    "required_capabilities",
    "max_mission_budget_atomic",
    "min_acceptance_criteria",
)


def validate_dao_rules(payload: Any) -> dict:
    """A DAO's rules.

    `version` increments on every change. The version matters because a mandate records
    the rules it was created under: changing rules must never retroactively alter an
    existing mandate (invariant I8 in another costume), and a version is how a reader
    tells which rules applied.
    """
    rules = _require_keys(payload, DAO_RULES_FIELDS, "rules")
    _schema_version(rules["schema_version"], "rules.schema_version")
    _id(rules["dao_id"], "dao", "rules.dao_id")
    _integer(rules["version"], "rules.version", minimum=1, maximum=2**31 - 1)

    if rules["membership"] not in MEMBERSHIP_MODES:
        raise ValidationError(
            f"membership must be one of {MEMBERSHIP_MODES}, got {rules['membership']!r}",
            "rules.membership",
        )

    required = _list(rules["required_capabilities"], "rules.required_capabilities", max_len=32)
    for index, item in enumerate(required):
        identifier = _string(item, f"rules.required_capabilities[{index}]", max_len=64)
        if not CAPABILITY_ID.match(identifier):
            raise ValidationError(
                "capability ids are lowercase kebab-case", f"rules.required_capabilities[{index}]"
            )

    parse_atomic(rules["max_mission_budget_atomic"], "rules.max_mission_budget_atomic")
    _integer(rules["min_acceptance_criteria"], "rules.min_acceptance_criteria", minimum=1, maximum=32)
    return rules
