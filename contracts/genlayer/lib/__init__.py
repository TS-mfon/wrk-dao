"""WRK shared library for GenLayer Intelligent Contracts.

Imported by all four ICs: `wrk_registry`, `wrk_work`, `wrk_adjudicator`,
`wrk_reputation`.

**This package is pure.** No `gl.nondet` blocks, no `gl.eq_principle` wrappers, no
storage declarations, no `@gl.public` decorators. Every non-deterministic operation
belongs in `wrk_adjudicator.py` (`docs/ARCHITECTURE.md` §3.1), so that "which code can
be non-deterministic" is answerable by looking at one file and `genvm-lint` has one
file to be strict about. `contracts/genlayer/tests/lib/verify_purity.py` enforces
this, and proves its own scanner works against a positive control before trusting a
clean result.

Normative sources: `docs/CANONICAL.md` (hashing) and `docs/ARCHITECTURE.md` §4–§7
(invariants, identifiers, state machines, decision payload).
"""

from __future__ import annotations

from .canonical import (
    CANONICAL_JSON_VERSION,
    KEY_PATTERN,
    MAX_DEPTH,
    MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER,
    CanonicalError,
    canonicalize,
    is_canonicalizable,
)
from .hashing import (
    HashError,
    ascii_bytes,
    content_hash,
    content_hash_with_canonical,
    hash_canonical_text,
    normalize_bytes32,
    settlement_id,
    struct_hash,
)
from .ids import (
    ID_PREFIXES,
    IdError,
    from_bytes32,
    id_pattern,
    is_id,
    new_id,
    parse_id,
    to_bytes32,
)
from .keccak import keccak256, keccak256_hex
from .money import (
    BP_DENOMINATOR,
    VERDICTS,
    MoneyError,
    assert_allocations,
    assert_bp_pair,
    assert_verdict_matches_release,
    parse_atomic,
    split_release,
    verdict_for_release,
    verdict_matches_release,
)
from .prompts import (
    CRITERION_EQUIVALENCE_PRINCIPLE,
    SELECTION_EQUIVALENCE_PRINCIPLE,
    criterion_adjudication_prompt,
    evidence_digest,
    selection_prompt,
)
from .states import (
    MACHINES,
    MANDATE,
    MANDATE_STATES,
    MISSION,
    MISSION_STATES,
    SETTLED_PREDECESSORS,
    SETTLEMENT,
    SETTLEMENT_STATES,
    StateError,
    can_edit_mission,
)
from .types import Allocation, CriterionFinding, Decision, weighted_release_bp
from .validation import (
    ValidationError,
    validate_decision,
    validate_deliverable,
    validate_evidence,
    validate_mandate,
    validate_mission,
    validate_proposal,
)

__all__ = [
    "Allocation",
    "BP_DENOMINATOR",
    "CANONICAL_JSON_VERSION",
    "CRITERION_EQUIVALENCE_PRINCIPLE",
    "CanonicalError",
    "CriterionFinding",
    "Decision",
    "HashError",
    "ID_PREFIXES",
    "IdError",
    "KEY_PATTERN",
    "MACHINES",
    "MANDATE",
    "MANDATE_STATES",
    "MAX_DEPTH",
    "MAX_SAFE_INTEGER",
    "MIN_SAFE_INTEGER",
    "MISSION",
    "MISSION_STATES",
    "MoneyError",
    "SELECTION_EQUIVALENCE_PRINCIPLE",
    "SETTLED_PREDECESSORS",
    "SETTLEMENT",
    "SETTLEMENT_STATES",
    "StateError",
    "VERDICTS",
    "ValidationError",
    "ascii_bytes",
    "assert_allocations",
    "assert_bp_pair",
    "assert_verdict_matches_release",
    "can_edit_mission",
    "canonicalize",
    "content_hash",
    "content_hash_with_canonical",
    "criterion_adjudication_prompt",
    "evidence_digest",
    "from_bytes32",
    "hash_canonical_text",
    "id_pattern",
    "is_canonicalizable",
    "is_id",
    "keccak256",
    "keccak256_hex",
    "new_id",
    "normalize_bytes32",
    "parse_atomic",
    "parse_id",
    "selection_prompt",
    "settlement_id",
    "split_release",
    "struct_hash",
    "to_bytes32",
    "validate_decision",
    "validate_deliverable",
    "validate_evidence",
    "validate_mandate",
    "validate_mission",
    "validate_proposal",
    "verdict_for_release",
    "verdict_matches_release",
    "weighted_release_bp",
]
