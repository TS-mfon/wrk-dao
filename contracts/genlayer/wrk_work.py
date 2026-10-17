# {
#   "Seq": [
#     { "Depends": "py-genlayer-multi:06zyvrlivjga0d5jlpdbprksc0pa6jmllxvp8s20hq1l512vh5yk" },
#     { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
#   ]
# }
#
# Two runners in a Seq, both pinned to concrete hashes — `py-genlayer-multi` because this
# contract imports `lib/`, `py-genlayer` because the multi runner is an addition and not a
# replacement. See wrk_registry.py's header for the full reasoning and for why every
# network rejects `:test`, `:latest` and unversioned aliases.
"""wrk_work — missions, proposals, mandates, deliverables, evidence.

One state machine over one object graph. Absorbs §96's `mission_engine`,
`proposal_engine` and `mandate_engine` (contract inventory C8, C9, C10, C13, C15, C16).

Authority: **organizational**. This contract sequences work. It holds no value, forms no
judgment, and has no function that can move money — `scripts/verify-ic-discipline.py
payment` enforces that structurally, because "the contract that tracks the work" is the
most tempting place to add a convenient payout.

Authorization is delegated, not duplicated
------------------------------------------
Every "may this caller act for this agent" and "is this agent a member" question is
answered by `wrk_registry` over a cross-contract view call. Caching those answers here
would create a second copy of authorization state, and a stale copy is an authorization
bug. The cost is one view call per check; the benefit is that there is exactly one place
where agent ownership is defined.

The one trust boundary in this file, stated plainly
---------------------------------------------------
`mark_funded`, `mark_settled` and `mark_refunded` record facts that live on **Base**, and
this contract cannot verify Base state. A GenLayer contract can only reach another chain
through a non-deterministic web block, and every such block in this protocol lives in
`wrk_adjudicator` by design (`docs/ARCHITECTURE.md` §3.1).

So those three transitions are **relayed, not proven**. They are callable only by the
`settlement_observer` address fixed at construction, and each one requires the Base
transaction hash, which is stored. That makes the claim *auditable*: the read model, and
anyone else, can check the recorded hash against Base and detect a false relay.

What a false relay cannot do is move money. The escrow on Base is the custody authority
and does not consult this contract at all — a lying observer corrupts this contract's view
of a mandate and cannot cause one unit of USDC to move. That asymmetry is §118's authority
separation doing its job, and it is why a relayed input is tolerable here and would not be
tolerable in the escrow.
"""

from genlayer import *

from lib.canonical import canonicalize
from lib.hashing import content_hash
from lib.ids import id_pattern
from lib.states import MANDATE, MISSION, can_edit_mission
from lib.validation import (
    ValidationError,
    validate_deliverable,
    validate_mandate,
    validate_mission,
    validate_proposal,
)

import json
import re
from datetime import datetime, timezone

#: Every refusal here is deterministic business logic, so every message carries
#: [EXPECTED] and a re-executing validator sees the identical string. The other classes
#: ([EXTERNAL], [TRANSIENT], [LLM_ERROR]) belong to contracts that touch the outside
#: world; this one never does.
ERROR_EXPECTED = "[EXPECTED]"

BYTES32 = re.compile(r"^0x[0-9a-f]{64}$")
EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")

#: Basis points denominator, mirrored from lib.money so this module's import surface
#: stays limited to what it actually uses. lib.money owns the arithmetic.
BP_DENOMINATOR = 10_000


# ── events (docs/ARCHITECTURE.md §9) ────────────────────────────────────────
#
# The read model is event-sourced. Every state change the indexer must see is emitted, so
# each document it writes has a real `chain_ref` and rule 3 ("no document without a
# corresponding chain event") holds. The two state-machine helpers below emit on every
# transition, which is what makes "exactly one event per change" structural rather than a
# thing to remember at seventeen call sites.
#
# Fields before `/` are indexed and become log topics; the rest travel in the blob.
#
# NOTE ON INDEXED FIELD ORDER: the SDK sorts indexed field names alphabetically and binds
# positional arguments to that SORTED order, not to declaration order
# (`indexed_args = tuple(sorted(...))` then `zip(indexed_args, args)`). So an event
# declared `(dao_id, agent_id, /)` and called with `(dao_id, agent_id)` silently files the
# dao id under `agent_id`. Every multi-indexed event below is therefore declared in
# alphabetical order, and `test_cross_contract_events_declare_indexed_fields_in_sorted_order`
# fails the build if a future one is not.


class MissionCreated(gl.Event):
    def __init__(self, mission_id: str, /, **blob): ...


class MissionUpdated(gl.Event):
    def __init__(self, mission_id: str, /, **blob): ...


class MissionStateChanged(gl.Event):
    def __init__(self, mission_id: str, /, **blob): ...


class ProposalSubmitted(gl.Event):
    def __init__(self, proposal_id: str, /, **blob): ...


class SelectionRecorded(gl.Event):
    def __init__(self, mission_id: str, /, **blob): ...


class MandateCreated(gl.Event):
    def __init__(self, mandate_id: str, /, **blob): ...


class MandateAccepted(gl.Event):
    def __init__(self, agent_id: str, mandate_id: str, /, **blob): ...


class MandateStateChanged(gl.Event):
    def __init__(self, mandate_id: str, /, **blob): ...


class DeliverableSubmitted(gl.Event):
    def __init__(self, deliverable_id: str, /, **blob): ...


class EvidenceRecorded(gl.Event):
    def __init__(self, evidence_id: str, /, **blob): ...


class AdjudicationRecorded(gl.Event):
    def __init__(self, mandate_id: str, /, **blob): ...


class CustodyRelayed(gl.Event):
    """A Base custody fact relayed into this contract. RELAYED, NOT PROVEN.

    Emitted with the Base transaction hash so the read model can verify the claim against
    Base independently instead of taking this contract's word for it.
    """

    def __init__(self, mandate_id: str, /, **blob): ...


def _reject(message: str):
    """Raises a classified, consensus-safe error.

    `gl.vm.UserError` rather than a bare `Exception`: a bare exception surfaces as an
    unrecoverable VMError, which a validator cannot compare and which tells the caller
    nothing actionable.
    """
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {message}")


def _now() -> int:
    """Transaction time in Unix seconds.

    `datetime.now(timezone.utc)` inside the GenVM is the deterministic **transaction**
    datetime, identical for every re-executing validator — not host wall-clock. There is
    no block timestamp or block number in the GenLayer execution context.
    """
    return int(datetime.now(timezone.utc).timestamp())


class WrkWork(gl.Contract):
    # ── wiring ──────────────────────────────────────────────────────────────
    registry: str
    adjudicator: str
    settlement_observer: str
    deployer: str

    # ── missions ────────────────────────────────────────────────────────────
    mission_payload: TreeMap[str, str]
    mission_hash: TreeMap[str, str]
    mission_state: TreeMap[str, str]
    mission_dao: TreeMap[str, str]
    mission_creator: TreeMap[str, str]
    mission_version: TreeMap[str, u256]
    mission_proposal_count: TreeMap[str, u256]
    mission_rules_version: TreeMap[str, u256]
    mission_deadline: TreeMap[str, u256]
    mission_selected_proposal: TreeMap[str, str]
    mission_selection_hash: TreeMap[str, str]
    mission_ids: DynArray[str]
    #: dao_id -> JSON array of mission_ids. An index, not a scan.
    dao_missions: TreeMap[str, str]
    #: mission_id -> True while OPEN. Discovery reads the flag rather than re-parsing
    #: every mission's state.
    open_missions: TreeMap[str, bool]
    open_mission_ids: DynArray[str]

    # ── proposals ───────────────────────────────────────────────────────────
    proposal_payload: TreeMap[str, str]
    proposal_hash: TreeMap[str, str]
    proposal_mission: TreeMap[str, str]
    proposal_agent: TreeMap[str, str]
    proposal_ids: DynArray[str]
    mission_proposals: TreeMap[str, str]
    #: "mission_id|agent_id" -> True. One proposal per agent per mission.
    mission_proposer: TreeMap[str, bool]

    # ── mandates ────────────────────────────────────────────────────────────
    mandate_payload: TreeMap[str, str]
    mandate_hash: TreeMap[str, str]
    mandate_state: TreeMap[str, str]
    mandate_mission: TreeMap[str, str]
    mandate_dao: TreeMap[str, str]
    mandate_deadline: TreeMap[str, u256]
    #: Which DAO rules version applied when this mandate was created. A later rules
    #: change cannot reach back and alter it — invariant I8 in another costume.
    mandate_rules_version: TreeMap[str, u256]
    mandate_worker_count: TreeMap[str, u256]
    mandate_accepted_count: TreeMap[str, u256]
    #: "mandate_id|agent_id" -> True once that worker accepted.
    mandate_accepted: TreeMap[str, bool]
    #: "mandate_id|agent_id" -> True if named as a worker at creation.
    mandate_is_worker: TreeMap[str, bool]
    mandate_decision_hash: TreeMap[str, str]
    mandate_ids: DynArray[str]
    mission_mandate: TreeMap[str, str]
    #: Base transaction hashes for each relayed custody fact, kept so the claim is
    #: auditable against Base rather than merely asserted.
    mandate_funding_tx: TreeMap[str, str]
    mandate_settlement_tx: TreeMap[str, str]

    # ── deliverables ────────────────────────────────────────────────────────
    deliverable_payload: TreeMap[str, str]
    deliverable_hash: TreeMap[str, str]
    deliverable_mandate: TreeMap[str, str]
    deliverable_agent: TreeMap[str, str]
    deliverable_ids: DynArray[str]
    mandate_deliverables: TreeMap[str, str]
    #: evidence_id -> deliverable_id. Evidence is carried inside a deliverable payload;
    #: this index exists so one evidence id resolves without a scan, and so the same
    #: evidence cannot be re-submitted under a second deliverable.
    evidence_deliverable: TreeMap[str, str]

    def __init__(self, registry: str, adjudicator: str, settlement_observer: str) -> None:
        """Wire the three addresses this contract trusts.

        All three are fixed at construction and there is no setter. A rotatable registry
        address would let whoever can rotate it substitute a registry that answers "yes,
        this caller owns that agent" to everything — which is every authorization check in
        this contract defeated at once.
        """
        for label, value in (
            ("registry", registry),
            ("adjudicator", adjudicator),
            ("settlement_observer", settlement_observer),
        ):
            if not EVM_ADDRESS.match(value):
                _reject(f"{label} must be a 0x-prefixed 20-byte address, got {value!r}")

        self.registry = registry.lower()
        self.adjudicator = adjudicator.lower()
        self.settlement_observer = settlement_observer.lower()
        self.deployer = gl.message.sender_address.as_hex.lower()

    # ── internal helpers ────────────────────────────────────────────────────

    def _sender(self) -> str:
        """The caller's address as a lowercase hex string.

        A string rather than `Address` so the value round-trips through canonical JSON and
        the read model unchanged.
        """
        return gl.message.sender_address.as_hex.lower()

    def _registry(self):
        """A handle on wrk_registry for deterministic view calls."""
        return gl.get_contract_at(Address(self.registry))

    def _require_agent_owner(self, agent_id: str) -> str:
        """Invariant I7, delegated to the registry. Returns the caller."""
        sender = self._sender()
        operator = self._registry().view().get_agent_operator(agent_id)
        if operator.lower() != sender:
            _reject(
                f"only agent {agent_id}'s own operator may act for it: "
                f"caller {sender} is not {operator.lower()}"
            )
        return sender

    def _require_member(self, dao_id: str, agent_id: str) -> None:
        if not self._registry().view().is_member(dao_id, agent_id):
            _reject(f"agent {agent_id} is not a member of dao {dao_id}")

    def _calling_agent(self) -> str:
        """The agent the caller controls, refusing an address that controls none."""
        sender = self._sender()
        agent_id = self._registry().view().agent_of_address(sender)
        if agent_id == "":
            _reject(f"caller {sender} controls no registered agent")
        return agent_id

    def _parse_json(self, raw: str, label: str) -> dict:
        try:
            value = json.loads(raw)
        except Exception as error:
            _reject(f"{label} is not valid JSON: {error}")
        if not isinstance(value, dict):
            _reject(f"{label} must be a JSON object")
        return value

    def _append_index(self, index: TreeMap[str, str], key: str, value: str) -> None:
        bucket = json.loads(index[key]) if key in index else []
        if value not in bucket:
            bucket.append(value)
            index[key] = json.dumps(bucket)

    def _require_mission(self, mission_id: str) -> None:
        if mission_id not in self.mission_state:
            _reject(f"unknown mission {mission_id}")

    def _require_mission_state(self, mission_id: str, expected: str) -> None:
        self._require_mission(mission_id)
        actual = self.mission_state[mission_id]
        if actual != expected:
            _reject(f"mission {mission_id} is {actual}, not {expected}")

    def _require_mandate(self, mandate_id: str) -> None:
        if mandate_id not in self.mandate_state:
            _reject(f"unknown mandate {mandate_id}")

    def _require_mandate_state(self, mandate_id: str, expected: str) -> None:
        self._require_mandate(mandate_id)
        actual = self.mandate_state[mandate_id]
        if actual != expected:
            _reject(f"mandate {mandate_id} is {actual}, not {expected}")

    def _set_mission_state(self, mission_id: str, target: str) -> None:
        """Every mission transition goes through lib.states.

        A transition table written inline here would be a second copy to keep in step with
        `docs/ARCHITECTURE.md` §6, and the illegal transitions are the ones that matter.
        """
        current = self.mission_state[mission_id]
        if not MISSION.can_transition(current, target):
            _reject(f"mission {mission_id}: {current} -> {target} is not a legal transition")
        self.mission_state[mission_id] = target
        MissionStateChanged(mission_id, state=target, previous=current).emit()

        if target == "OPEN":
            self.open_missions[mission_id] = True
            self.open_mission_ids.append(mission_id)
        elif mission_id in self.open_missions and self.open_missions[mission_id]:
            # Leaving OPEN clears the discovery flag. Forgetting this half is how a closed
            # mission keeps appearing as open and agents waste work proposing to something
            # that can no longer accept a proposal.
            self.open_missions[mission_id] = False

    def _set_mandate_state(self, mandate_id: str, target: str) -> None:
        current = self.mandate_state[mandate_id]
        if not MANDATE.can_transition(current, target):
            _reject(f"mandate {mandate_id}: {current} -> {target} is not a legal transition")
        self.mandate_state[mandate_id] = target
        MandateStateChanged(mandate_id, state=target, previous=current).emit()

    def _require_observer(self, what: str) -> None:
        """The relayed-custody trust boundary. See the module docstring."""
        sender = self._sender()
        if sender != self.settlement_observer:
            _reject(
                f"only the settlement observer may record {what}: "
                f"caller {sender} is not {self.settlement_observer}"
            )

    def _require_adjudicator(self, what: str) -> None:
        sender = self._sender()
        if sender != self.adjudicator:
            _reject(f"only the adjudicator may {what}: caller {sender} is not {self.adjudicator}")

    def _require_tx_hash(self, tx_hash: str, what: str) -> str:
        """A relayed custody fact must carry the Base transaction that evidences it.

        Stored, never checked here — this contract cannot read Base. The point is that a
        false relay becomes *detectable* by anyone comparing the recorded hash to Base.
        """
        value = tx_hash.lower()
        if not BYTES32.match(value):
            _reject(f"{what} requires the Base transaction hash as 0x + 64 lowercase hex")
        return value

    def _require_decision_hash(self, decision_hash: str) -> str:
        value = decision_hash.lower()
        if not BYTES32.match(value):
            _reject("decision_hash must be 0x + 64 lowercase hex")
        return value

    def _budget_atomic(self, payload: dict, field: str) -> int:
        """An atomic amount as an integer. Validation has already proved the spelling."""
        return int(payload[field]["amount_atomic"])

    def _mission_budget(self, mission_id: str) -> int:
        return self._budget_atomic(json.loads(self.mission_payload[mission_id]), "budget")

    def _proposal_workers(self, proposal_id: str) -> dict:
        """The agent -> share_bp map a proposal commits to.

        A solo proposal takes the whole release; a team proposal carries explicit shares
        that validation has already proved sum to the denominator. This is the map a
        mandate's workers must match, which is what stops a creator from selecting one
        proposal and then writing a mandate that pays somebody else.
        """
        payload = json.loads(self.proposal_payload[proposal_id])
        team = payload["team_members"]
        if not team:
            return {payload["agent_id"]: BP_DENOMINATOR}
        return {member["agent_id"]: member["share_bp"] for member in team}

    # ── missions: C8, C9 ────────────────────────────────────────────────────

    @gl.public.write
    def create_mission(
        self, mission_id: str, dao_id: str, creator_agent_id: str, payload_json: str
    ) -> str:
        """Create a mission in DRAFT. The creator must be a member of the DAO.

        The DAO's rules are read and applied here — budget cap and minimum acceptance
        criteria — and the rules *version* is recorded, so a later rules change is visible
        as a change rather than silently reinterpreting this mission.
        """
        if not re.match(id_pattern("msn"), mission_id):
            _reject(f"{mission_id} is not an msn_ prefixed ULID")
        if mission_id in self.mission_state:
            _reject(f"mission {mission_id} already exists")

        self._require_agent_owner(creator_agent_id)
        self._require_member(dao_id, creator_agent_id)

        payload = self._parse_json(payload_json, "mission")
        try:
            validate_mission(payload)
        except ValidationError as error:
            _reject(str(error))

        if payload["mission_id"] != mission_id:
            _reject("payload declares a different mission_id")
        if payload["dao_id"] != dao_id:
            _reject("payload declares a different dao_id")
        if payload["creator_agent_id"] != creator_agent_id:
            _reject("payload declares a different creator_agent_id")

        rules = json.loads(self._registry().view().get_dao_rules(dao_id))
        budget = self._budget_atomic(payload, "budget")
        cap = int(rules["max_mission_budget_atomic"])
        if budget > cap:
            _reject(f"mission budget {budget} exceeds the DAO's cap of {cap}")
        minimum = rules["min_acceptance_criteria"]
        if len(payload["acceptance_criteria"]) < minimum:
            _reject(
                f"dao {dao_id} requires at least {minimum} acceptance criteria, "
                f"got {len(payload['acceptance_criteria'])}"
            )

        self.mission_payload[mission_id] = canonicalize(payload)
        self.mission_hash[mission_id] = content_hash(payload)
        self.mission_state[mission_id] = "DRAFT"
        self.mission_dao[mission_id] = dao_id
        self.mission_creator[mission_id] = creator_agent_id
        self.mission_version[mission_id] = u256(1)
        self.mission_proposal_count[mission_id] = u256(0)
        self.mission_deadline[mission_id] = u256(payload["deadline_unix"])
        self.mission_rules_version[mission_id] = u256(
            self._registry().view().get_dao_rules_version(dao_id)
        )
        self.mission_ids.append(mission_id)
        self._append_index(self.dao_missions, dao_id, mission_id)
        MissionCreated(
            mission_id,
            # The canonical payload travels with its hash. Without it the read model holds
            # only a digest, so no agent could read the acceptance criteria it is being
            # asked to satisfy -- which the two agent participants found immediately. The
            # indexer re-hashes this and refuses a mismatch, so carrying it adds no trust.
            payload=self.mission_payload[mission_id],
            dao_id=dao_id,
            creator_agent_id=creator_agent_id,
            mission_hash=self.mission_hash[mission_id],
            rules_version=self.mission_rules_version[mission_id],
            budget_atomic=str(budget),
            deadline_unix=u256(payload["deadline_unix"]),
            state="DRAFT",
        ).emit()
        return self.mission_hash[mission_id]

    @gl.public.write
    def update_mission(self, mission_id: str, payload_json: str) -> int:
        """Edit a mission, incrementing its version.

        SPEC §102: editable only in DRAFT or OPEN **and** with zero proposals. The first
        proposal freezes it permanently, because a proposal is an answer to a specific set
        of acceptance criteria and changing them afterwards changes what was agreed.
        """
        self._require_mission(mission_id)
        self._require_agent_owner(self.mission_creator[mission_id])

        state = self.mission_state[mission_id]
        count = int(self.mission_proposal_count[mission_id])
        if not can_edit_mission(state, count):
            _reject(f"mission {mission_id} is not editable: state {state} with {count} proposal(s)")

        payload = self._parse_json(payload_json, "mission")
        try:
            validate_mission(payload)
        except ValidationError as error:
            _reject(str(error))
        if payload["mission_id"] != mission_id:
            _reject("payload declares a different mission_id")
        if payload["dao_id"] != self.mission_dao[mission_id]:
            _reject("a mission cannot be moved to another DAO")
        if payload["creator_agent_id"] != self.mission_creator[mission_id]:
            _reject("a mission's creator cannot be changed by an edit")

        dao_id = self.mission_dao[mission_id]
        rules = json.loads(self._registry().view().get_dao_rules(dao_id))
        budget = self._budget_atomic(payload, "budget")
        cap = int(rules["max_mission_budget_atomic"])
        if budget > cap:
            # Re-checked on edit, not only on create: a DAO that lowered its cap must not
            # be editable back up past it.
            _reject(f"mission budget {budget} exceeds the DAO's cap of {cap}")

        self.mission_payload[mission_id] = canonicalize(payload)
        self.mission_hash[mission_id] = content_hash(payload)
        self.mission_deadline[mission_id] = u256(payload["deadline_unix"])
        self.mission_version[mission_id] = u256(int(self.mission_version[mission_id]) + 1)
        MissionUpdated(
            mission_id,
            payload=self.mission_payload[mission_id],
            mission_hash=self.mission_hash[mission_id],
            version=self.mission_version[mission_id],
            budget_atomic=str(budget),
            deadline_unix=u256(payload["deadline_unix"]),
        ).emit()
        return int(self.mission_version[mission_id])

    @gl.public.write
    def open_mission(self, mission_id: str) -> str:
        """Open a mission for proposals. Refused once its deadline has passed."""
        self._require_mission_state(mission_id, "DRAFT")
        self._require_agent_owner(self.mission_creator[mission_id])
        deadline = int(self.mission_deadline[mission_id])
        if _now() >= deadline:
            _reject(f"mission {mission_id} cannot be opened: its deadline {deadline} has passed")
        self._set_mission_state(mission_id, "OPEN")
        return "OPEN"

    @gl.public.write
    def close_proposals(self, mission_id: str) -> str:
        self._require_mission_state(mission_id, "OPEN")
        self._require_agent_owner(self.mission_creator[mission_id])
        self._set_mission_state(mission_id, "PROPOSALS_CLOSED")
        return "PROPOSALS_CLOSED"

    @gl.public.write
    def cancel_mission(self, mission_id: str) -> str:
        """Cancel a mission. Legal until it is MANDATED; after that the mandate owns it."""
        self._require_mission(mission_id)
        self._require_agent_owner(self.mission_creator[mission_id])
        self._set_mission_state(mission_id, "CANCELLED")
        return "CANCELLED"

    @gl.public.write
    def expire_mission(self, mission_id: str) -> str:
        """Retire a mission whose deadline has passed. Permissionless on purpose.

        If only the creator could expire a mission, an abandoned one would sit in the
        discovery index forever and workers would keep proposing to it. Anyone may call
        this, and the deadline is what authorizes it — there is no discretion to abuse.
        """
        self._require_mission(mission_id)
        deadline = int(self.mission_deadline[mission_id])
        now = _now()
        if now < deadline:
            _reject(
                f"mission {mission_id} is not expired: deadline {deadline} is {deadline - now}s away"
            )
        self._set_mission_state(mission_id, "EXPIRED")
        return "EXPIRED"

    # ── proposals: C10 ──────────────────────────────────────────────────────

    @gl.public.write
    def submit_proposal(
        self, proposal_id: str, mission_id: str, agent_id: str, payload_json: str
    ) -> str:
        """Submit a proposal. Only while the mission is OPEN.

        **A proposal is never paid** (SPEC §35–37). Submitting costs the proposer nothing
        and earns nothing; there is no value transfer anywhere in this contract.
        """
        if not re.match(id_pattern("prp"), proposal_id):
            _reject(f"{proposal_id} is not a prp_ prefixed ULID")
        if proposal_id in self.proposal_mission:
            _reject(f"proposal {proposal_id} already exists")

        self._require_mission_state(mission_id, "OPEN")
        self._require_agent_owner(agent_id)
        dao_id = self.mission_dao[mission_id]
        self._require_member(dao_id, agent_id)

        proposer_key = f"{mission_id}|{agent_id}"
        if proposer_key in self.mission_proposer and self.mission_proposer[proposer_key]:
            _reject(f"agent {agent_id} has already proposed to mission {mission_id}")

        payload = self._parse_json(payload_json, "proposal")
        try:
            validate_proposal(payload)
        except ValidationError as error:
            _reject(str(error))
        if payload["proposal_id"] != proposal_id:
            _reject("payload declares a different proposal_id")
        if payload["mission_id"] != mission_id:
            _reject("payload declares a different mission_id")
        if payload["agent_id"] != agent_id:
            _reject("payload declares a different agent_id")
        if payload["dao_id"] != dao_id:
            _reject(f"payload declares dao {payload['dao_id']} but the mission belongs to {dao_id}")

        mission = json.loads(self.mission_payload[mission_id])
        requested = self._budget_atomic(payload, "requested_budget")
        available = self._budget_atomic(mission, "budget")
        if requested > available:
            # A proposal asking for more than the mission holds can never be funded, so
            # refusing it here is cheaper than discovering it at funding time.
            _reject(f"requested budget {requested} exceeds the mission budget {available}")

        team = payload["team_members"]
        if not mission["allow_teams"] and team:
            _reject(f"mission {mission_id} does not allow teams")
        if len(team) > mission["max_team_size"]:
            _reject(
                f"team of {len(team)} exceeds the mission's max_team_size "
                f"of {mission['max_team_size']}"
            )
        if team and agent_id not in [member["agent_id"] for member in team]:
            # The submitting agent must appear in its own team, otherwise the proposer and
            # the agents who would be paid are disjoint sets.
            _reject(f"agent {agent_id} must appear in its own team_members")
        for member in team:
            self._require_member(dao_id, member["agent_id"])

        self.proposal_payload[proposal_id] = canonicalize(payload)
        self.proposal_hash[proposal_id] = content_hash(payload)
        self.proposal_mission[proposal_id] = mission_id
        self.proposal_agent[proposal_id] = agent_id
        self.proposal_ids.append(proposal_id)
        self.mission_proposer[proposer_key] = True
        self.mission_proposal_count[mission_id] = u256(
            int(self.mission_proposal_count[mission_id]) + 1
        )
        self._append_index(self.mission_proposals, mission_id, proposal_id)
        ProposalSubmitted(
            proposal_id,
            payload=self.proposal_payload[proposal_id],
            mission_id=mission_id,
            dao_id=dao_id,
            agent_id=agent_id,
            proposal_hash=self.proposal_hash[proposal_id],
            requested_budget_atomic=str(requested),
            team_size=u256(len(team)),
        ).emit()
        return self.proposal_hash[proposal_id]

    # ── selection, recorded by the adjudicator ──────────────────────────────

    @gl.public.write
    def start_selection(self, mission_id: str) -> str:
        self._require_mission_state(mission_id, "PROPOSALS_CLOSED")
        self._require_agent_owner(self.mission_creator[mission_id])
        if int(self.mission_proposal_count[mission_id]) == 0:
            _reject(f"mission {mission_id} has no proposals to select from")
        self._set_mission_state(mission_id, "SELECTING")
        return "SELECTING"

    @gl.public.write
    def record_selection(self, mission_id: str, proposal_id: str, decision_hash: str) -> str:
        """Record which proposal GenLayer selected. Callable only by the adjudicator.

        The judgment happens in `wrk_adjudicator`, the only contract permitted a
        non-deterministic block. This contract stores the outcome and the decision's
        content hash; it never re-decides and has no way to.
        """
        self._require_adjudicator("record a selection")
        self._require_mission_state(mission_id, "SELECTING")
        if proposal_id not in self.proposal_mission:
            _reject(f"unknown proposal {proposal_id}")
        if self.proposal_mission[proposal_id] != mission_id:
            _reject(f"proposal {proposal_id} does not belong to mission {mission_id}")

        self.mission_selected_proposal[mission_id] = proposal_id
        self.mission_selection_hash[mission_id] = self._require_decision_hash(decision_hash)
        SelectionRecorded(
            mission_id,
            proposal_id=proposal_id,
            decision_hash=self.mission_selection_hash[mission_id],
        ).emit()
        self._set_mission_state(mission_id, "SELECTED")
        return "SELECTED"

    # ── mandates: C13 ───────────────────────────────────────────────────────

    @gl.public.write
    def create_mandate(self, mandate_id: str, mission_id: str, payload_json: str) -> str:
        """Create the execution agreement from the selected proposal.

        The mandate is checked *against the selection*, not merely against the schema: its
        workers and their shares must be exactly what the selected proposal committed to.
        Without that check a creator could run a genuine selection and then write a mandate
        paying entirely different agents, which would make selection decorative.
        """
        if not re.match(id_pattern("mnd"), mandate_id):
            _reject(f"{mandate_id} is not an mnd_ prefixed ULID")
        if mandate_id in self.mandate_state:
            _reject(f"mandate {mandate_id} already exists")

        self._require_mission_state(mission_id, "SELECTED")
        self._require_agent_owner(self.mission_creator[mission_id])

        payload = self._parse_json(payload_json, "mandate")
        try:
            validate_mandate(payload)
        except ValidationError as error:
            _reject(str(error))
        if payload["mandate_id"] != mandate_id:
            _reject("payload declares a different mandate_id")
        if payload["mission_id"] != mission_id:
            _reject("payload declares a different mission_id")

        dao_id = self.mission_dao[mission_id]
        if payload["dao_id"] != dao_id:
            _reject(f"payload declares dao {payload['dao_id']} but the mission belongs to {dao_id}")
        if payload["creator_agent_id"] != self.mission_creator[mission_id]:
            _reject("payload declares a different creator_agent_id than the mission's")

        selected = self.mission_selected_proposal[mission_id]
        if payload["proposal_hash"] != self.proposal_hash[selected]:
            _reject(
                "mandate.proposal_hash must be the content hash of the SELECTED proposal; "
                f"expected {self.proposal_hash[selected]}"
            )
        if payload["selection_decision_hash"] != self.mission_selection_hash[mission_id]:
            _reject("mandate.selection_decision_hash must be the recorded selection decision")

        committed = self._proposal_workers(selected)
        workers = {worker["agent_id"]: worker["share_bp"] for worker in payload["workers"]}
        if workers != committed:
            _reject(
                "mandate workers and shares must match the selected proposal exactly: "
                f"expected {json.dumps(committed, sort_keys=True)}, "
                f"got {json.dumps(workers, sort_keys=True)}"
            )

        budget = self._budget_atomic(payload, "budget")
        available = self._mission_budget(mission_id)
        if budget > available:
            _reject(f"mandate budget {budget} exceeds the mission budget {available}")

        deadline = payload["deadline_unix"]
        now = _now()
        if deadline <= now:
            # A mandate born already expired is nonsense: workers would be asked to accept
            # a commitment that anyone could immediately expire out from under them.
            _reject(f"mandate deadline {deadline} is not in the future (now {now})")

        for agent_id in workers:
            self._require_member(dao_id, agent_id)

        self.mandate_payload[mandate_id] = canonicalize(payload)
        self.mandate_hash[mandate_id] = content_hash(payload)
        self.mandate_state[mandate_id] = "CREATED"
        self.mandate_mission[mandate_id] = mission_id
        self.mandate_dao[mandate_id] = dao_id
        self.mandate_deadline[mandate_id] = u256(payload["deadline_unix"])
        # The rules version in force now. A later rules change cannot reach back (I8).
        self.mandate_rules_version[mandate_id] = u256(int(self.mission_rules_version[mission_id]))
        self.mandate_worker_count[mandate_id] = u256(len(workers))
        self.mandate_accepted_count[mandate_id] = u256(0)
        for agent_id in workers:
            self.mandate_is_worker[f"{mandate_id}|{agent_id}"] = True
        self.mandate_ids.append(mandate_id)
        self.mission_mandate[mission_id] = mandate_id
        MandateCreated(
            mandate_id,
            payload=self.mandate_payload[mandate_id],
            mission_id=mission_id,
            dao_id=dao_id,
            mandate_hash=self.mandate_hash[mandate_id],
            rules_version=self.mandate_rules_version[mandate_id],
            proposal_hash=payload["proposal_hash"],
            selection_decision_hash=payload["selection_decision_hash"],
            budget_atomic=str(budget),
            deadline_unix=u256(deadline),
            worker_count=u256(len(workers)),
            state="CREATED",
        ).emit()
        self._set_mission_state(mission_id, "MANDATED")
        return self.mandate_hash[mandate_id]

    @gl.public.write
    def accept_mandate(self, mandate_id: str, agent_id: str) -> str:
        """A named worker accepts. The mandate advances only when every worker has.

        Partial acceptance is not acceptance: funding a mandate one worker never agreed to
        would commit the DAO's USDC against labour nobody promised.
        """
        self._require_mandate_state(mandate_id, "CREATED")
        self._require_agent_owner(agent_id)

        worker_key = f"{mandate_id}|{agent_id}"
        if worker_key not in self.mandate_is_worker or not self.mandate_is_worker[worker_key]:
            _reject(f"agent {agent_id} is not a worker on mandate {mandate_id}")
        if worker_key in self.mandate_accepted and self.mandate_accepted[worker_key]:
            _reject(f"agent {agent_id} has already accepted mandate {mandate_id}")

        self.mandate_accepted[worker_key] = True
        accepted = int(self.mandate_accepted_count[mandate_id]) + 1
        self.mandate_accepted_count[mandate_id] = u256(accepted)
        MandateAccepted(
            agent_id,
            mandate_id,
            accepted=u256(accepted),
            total=self.mandate_worker_count[mandate_id],
        ).emit()

        if accepted == int(self.mandate_worker_count[mandate_id]):
            self._set_mandate_state(mandate_id, "ACCEPTED")
            return "ACCEPTED"
        return "CREATED"

    @gl.public.write
    def cancel_mandate(self, mandate_id: str) -> str:
        """Cancel before funding.

        Legal from CREATED and ACCEPTED only — `lib.states` enforces that, because once
        escrow is funded the only non-settling exit is REFUNDED. A terminal state reached
        with USDC still locked would be unrecoverable.
        """
        self._require_mandate(mandate_id)
        self._require_agent_owner(self.mission_creator[self.mandate_mission[mandate_id]])
        self._set_mandate_state(mandate_id, "CANCELLED")
        return "CANCELLED"

    @gl.public.write
    def expire_mandate(self, mandate_id: str) -> str:
        """Retire an unfunded mandate past its deadline. Permissionless, deadline-gated.

        Only reachable from CREATED and ACCEPTED: after funding, `lib.states` offers no
        route to EXPIRED, so money can never be stranded in a terminal state.
        """
        self._require_mandate(mandate_id)
        deadline = int(self.mandate_deadline[mandate_id])
        now = _now()
        if now < deadline:
            _reject(
                f"mandate {mandate_id} is not expired: deadline {deadline} is {deadline - now}s away"
            )
        self._set_mandate_state(mandate_id, "EXPIRED")
        return "EXPIRED"

    # ── relayed custody facts (see the module docstring) ────────────────────

    @gl.public.write
    def mark_funded(self, mandate_id: str, base_tx_hash: str) -> str:
        """Record that the DAO funded this mandate's escrow on Base. RELAYED, NOT PROVEN."""
        self._require_mandate(mandate_id)
        self._require_observer("funding")
        tx = self._require_tx_hash(base_tx_hash, "mark_funded")
        self._set_mandate_state(mandate_id, "FUNDED")
        self.mandate_funding_tx[mandate_id] = tx
        CustodyRelayed(mandate_id, state="FUNDED", base_tx_hash=tx).emit()
        return "FUNDED"

    @gl.public.write
    def mark_settled(self, mandate_id: str, base_tx_hash: str) -> str:
        """Record that Base executed the settlement. RELAYED, NOT PROVEN.

        Reachable only from ADJUDICATED, which is invariant I1 written into this contract's
        state machine: no settled mandate without a finalized decision.
        """
        self._require_mandate(mandate_id)
        self._require_observer("settlement")
        tx = self._require_tx_hash(base_tx_hash, "mark_settled")
        if mandate_id not in self.mandate_decision_hash:
            # Belt and braces over the transition table. I1 is the invariant that most
            # deserves two independent guards.
            _reject(f"mandate {mandate_id} has no recorded decision to settle against")
        self._set_mandate_state(mandate_id, "SETTLED")
        self.mandate_settlement_tx[mandate_id] = tx
        CustodyRelayed(mandate_id, state="SETTLED", base_tx_hash=tx).emit()
        return "SETTLED"

    @gl.public.write
    def mark_refunded(self, mandate_id: str, base_tx_hash: str) -> str:
        """Record that Base returned the escrow to its funder. RELAYED, NOT PROVEN."""
        self._require_mandate(mandate_id)
        self._require_observer("refund")
        tx = self._require_tx_hash(base_tx_hash, "mark_refunded")
        self._set_mandate_state(mandate_id, "REFUNDED")
        self.mandate_settlement_tx[mandate_id] = tx
        CustodyRelayed(mandate_id, state="REFUNDED", base_tx_hash=tx).emit()
        return "REFUNDED"

    # ── execution: C15, C16 ─────────────────────────────────────────────────

    @gl.public.write
    def start_work(self, mandate_id: str) -> str:
        """Begin work. Any accepted worker may start the clock; they are the ones doing it."""
        self._require_mandate_state(mandate_id, "FUNDED")
        agent_id = self._calling_agent()
        key = f"{mandate_id}|{agent_id}"
        if key not in self.mandate_accepted or not self.mandate_accepted[key]:
            _reject(f"agent {agent_id} is not an accepted worker on mandate {mandate_id}")
        self._set_mandate_state(mandate_id, "IN_PROGRESS")
        return "IN_PROGRESS"

    @gl.public.write
    def submit_deliverable(
        self, deliverable_id: str, mandate_id: str, agent_id: str, payload_json: str
    ) -> str:
        """Submit work plus evidence. Only an accepted worker, only while IN_PROGRESS.

        Evidence ids are claimed globally: the same artefact cannot be presented under two
        deliverables, which is how one piece of work would otherwise be made to look like
        two.
        """
        if not re.match(id_pattern("dlv"), deliverable_id):
            _reject(f"{deliverable_id} is not a dlv_ prefixed ULID")
        if deliverable_id in self.deliverable_mandate:
            _reject(f"deliverable {deliverable_id} already exists")
        self._require_mandate_state(mandate_id, "IN_PROGRESS")

        self._require_agent_owner(agent_id)
        key = f"{mandate_id}|{agent_id}"
        if key not in self.mandate_accepted or not self.mandate_accepted[key]:
            _reject(f"agent {agent_id} is not an accepted worker on mandate {mandate_id}")

        payload = self._parse_json(payload_json, "deliverable")
        try:
            validate_deliverable(payload)
        except ValidationError as error:
            _reject(str(error))
        if payload["deliverable_id"] != deliverable_id:
            _reject("payload declares a different deliverable_id")
        if payload["mandate_id"] != mandate_id:
            _reject("payload declares a different mandate_id")
        if payload["worker_agent_id"] != agent_id:
            _reject("payload declares a different worker_agent_id")

        mandate = json.loads(self.mandate_payload[mandate_id])
        declared = len(mandate["deliverables"])
        for index in payload["satisfies_indices"]:
            if index >= declared:
                _reject(
                    f"satisfies_indices references deliverable {index} but the mandate "
                    f"names only {declared}"
                )

        for item in payload["evidence"]:
            evidence_id = item["evidence_id"]
            if evidence_id in self.evidence_deliverable:
                _reject(
                    f"evidence {evidence_id} was already submitted under deliverable "
                    f"{self.evidence_deliverable[evidence_id]}"
                )
            self.evidence_deliverable[evidence_id] = deliverable_id
            EvidenceRecorded(
                evidence_id,
                deliverable_id=deliverable_id,
                mandate_id=mandate_id,
                worker_agent_id=agent_id,
                evidence_type=item["type"],
                uri=item["uri"],
                content_hash=item["content_hash"],
            ).emit()

        self.deliverable_payload[deliverable_id] = canonicalize(payload)
        self.deliverable_hash[deliverable_id] = content_hash(payload)
        self.deliverable_mandate[deliverable_id] = mandate_id
        self.deliverable_agent[deliverable_id] = agent_id
        self.deliverable_ids.append(deliverable_id)
        self._append_index(self.mandate_deliverables, mandate_id, deliverable_id)
        DeliverableSubmitted(
            deliverable_id,
            payload=self.deliverable_payload[deliverable_id],
            mandate_id=mandate_id,
            agent_id=agent_id,
            deliverable_hash=self.deliverable_hash[deliverable_id],
            evidence_count=u256(len(payload["evidence"])),
        ).emit()
        return self.deliverable_hash[deliverable_id]

    @gl.public.write
    def submit_work(self, mandate_id: str) -> str:
        """Declare the work complete, moving the mandate to SUBMITTED for adjudication."""
        self._require_mandate_state(mandate_id, "IN_PROGRESS")
        agent_id = self._calling_agent()
        key = f"{mandate_id}|{agent_id}"
        if key not in self.mandate_accepted or not self.mandate_accepted[key]:
            _reject(f"agent {agent_id} is not an accepted worker on mandate {mandate_id}")
        if mandate_id not in self.mandate_deliverables:
            _reject(f"mandate {mandate_id} has no deliverable to adjudicate")
        self._set_mandate_state(mandate_id, "SUBMITTED")
        return "SUBMITTED"

    # ── adjudication handoff ────────────────────────────────────────────────

    @gl.public.write
    def start_adjudication(self, mandate_id: str) -> str:
        """Hand the mandate to the adjudicator. Callable by the adjudicator only."""
        self._require_mandate(mandate_id)
        self._require_adjudicator("start adjudication")
        self._require_mandate_state(mandate_id, "SUBMITTED")
        self._set_mandate_state(mandate_id, "ADJUDICATING")
        return "ADJUDICATING"

    @gl.public.write
    def record_adjudication(self, mandate_id: str, decision_hash: str) -> str:
        """Record the decision's content hash. Callable by the adjudicator only.

        This is the value the Base escrow settles against, stored here so the read model
        can tie a settlement on Base back to the decision that authorized it.
        """
        self._require_mandate(mandate_id)
        self._require_adjudicator("record an adjudication")
        self._require_mandate_state(mandate_id, "ADJUDICATING")
        self.mandate_decision_hash[mandate_id] = self._require_decision_hash(decision_hash)
        AdjudicationRecorded(
            mandate_id, decision_hash=self.mandate_decision_hash[mandate_id]
        ).emit()
        self._set_mandate_state(mandate_id, "ADJUDICATED")
        return "ADJUDICATED"

    # ── reads ───────────────────────────────────────────────────────────────

    @gl.public.view
    def get_mission(self, mission_id: str) -> str:
        self._require_mission(mission_id)
        return self.mission_payload[mission_id]

    @gl.public.view
    def get_mission_hash(self, mission_id: str) -> str:
        self._require_mission(mission_id)
        return self.mission_hash[mission_id]

    @gl.public.view
    def get_mission_state(self, mission_id: str) -> str:
        self._require_mission(mission_id)
        return self.mission_state[mission_id]

    @gl.public.view
    def get_mission_version(self, mission_id: str) -> int:
        self._require_mission(mission_id)
        return int(self.mission_version[mission_id])

    @gl.public.view
    def get_mission_proposal_count(self, mission_id: str) -> int:
        self._require_mission(mission_id)
        return int(self.mission_proposal_count[mission_id])

    @gl.public.view
    def get_mission_rules_version(self, mission_id: str) -> int:
        self._require_mission(mission_id)
        return int(self.mission_rules_version[mission_id])

    @gl.public.view
    def get_mission_dao(self, mission_id: str) -> str:
        self._require_mission(mission_id)
        return self.mission_dao[mission_id]

    @gl.public.view
    def list_open_missions(self) -> list[str]:
        """Only OPEN missions, in the order they were opened.

        Cost is O(missions ever opened) — and it is still a walk. That is acceptable
        because this exists so the read model can be **rebuilt from chain alone**; agents
        and the UI should read the indexer, which maintains this projection off-chain
        without a per-query walk. Stated rather than hidden, because the honest bound is
        what tells a caller which path to use.
        """
        return [m for m in self.open_mission_ids if self.open_missions[m]]

    @gl.public.view
    def list_dao_missions(self, dao_id: str) -> list[str]:
        return json.loads(self.dao_missions[dao_id]) if dao_id in self.dao_missions else []

    @gl.public.view
    def mission_count(self) -> int:
        return len(self.mission_ids)

    @gl.public.view
    def get_proposal(self, proposal_id: str) -> str:
        if proposal_id not in self.proposal_payload:
            _reject(f"unknown proposal {proposal_id}")
        return self.proposal_payload[proposal_id]

    @gl.public.view
    def get_proposal_hash(self, proposal_id: str) -> str:
        if proposal_id not in self.proposal_hash:
            _reject(f"unknown proposal {proposal_id}")
        return self.proposal_hash[proposal_id]

    @gl.public.view
    def get_proposal_agent(self, proposal_id: str) -> str:
        if proposal_id not in self.proposal_agent:
            _reject(f"unknown proposal {proposal_id}")
        return self.proposal_agent[proposal_id]

    @gl.public.view
    def list_mission_proposals(self, mission_id: str) -> list[str]:
        if mission_id not in self.mission_proposals:
            return []
        return json.loads(self.mission_proposals[mission_id])

    @gl.public.view
    def get_selected_proposal(self, mission_id: str) -> str:
        if mission_id not in self.mission_selected_proposal:
            return ""
        return self.mission_selected_proposal[mission_id]

    @gl.public.view
    def get_selection_hash(self, mission_id: str) -> str:
        if mission_id not in self.mission_selection_hash:
            return ""
        return self.mission_selection_hash[mission_id]

    @gl.public.view
    def get_mandate(self, mandate_id: str) -> str:
        self._require_mandate(mandate_id)
        return self.mandate_payload[mandate_id]

    @gl.public.view
    def get_mandate_hash(self, mandate_id: str) -> str:
        self._require_mandate(mandate_id)
        return self.mandate_hash[mandate_id]

    @gl.public.view
    def get_mandate_state(self, mandate_id: str) -> str:
        self._require_mandate(mandate_id)
        return self.mandate_state[mandate_id]

    @gl.public.view
    def get_mandate_rules_version(self, mandate_id: str) -> int:
        self._require_mandate(mandate_id)
        return int(self.mandate_rules_version[mandate_id])

    @gl.public.view
    def get_mandate_dao(self, mandate_id: str) -> str:
        self._require_mandate(mandate_id)
        return self.mandate_dao[mandate_id]

    @gl.public.view
    def get_mandate_decision_hash(self, mandate_id: str) -> str:
        if mandate_id not in self.mandate_decision_hash:
            return ""
        return self.mandate_decision_hash[mandate_id]

    @gl.public.view
    def get_mandate_base_txs(self, mandate_id: str) -> list[str]:
        """The relayed Base transaction hashes, so the claim can be audited against Base.

        Returns `[funding_tx, settlement_tx]`, each "" when not yet recorded.
        """
        funding = self.mandate_funding_tx[mandate_id] if mandate_id in self.mandate_funding_tx else ""
        settlement = (
            self.mandate_settlement_tx[mandate_id] if mandate_id in self.mandate_settlement_tx else ""
        )
        return [funding, settlement]

    @gl.public.view
    def is_mandate_worker(self, mandate_id: str, agent_id: str) -> bool:
        key = f"{mandate_id}|{agent_id}"
        return key in self.mandate_is_worker and self.mandate_is_worker[key]

    @gl.public.view
    def is_accepted_worker(self, mandate_id: str, agent_id: str) -> bool:
        key = f"{mandate_id}|{agent_id}"
        return key in self.mandate_accepted and self.mandate_accepted[key]

    @gl.public.view
    def get_mandate_acceptance(self, mandate_id: str) -> list[int]:
        """`[accepted, total]`, so a caller can see how many workers still have to agree."""
        self._require_mandate(mandate_id)
        return [
            int(self.mandate_accepted_count[mandate_id]),
            int(self.mandate_worker_count[mandate_id]),
        ]

    @gl.public.view
    def get_mission_mandate(self, mission_id: str) -> str:
        return self.mission_mandate[mission_id] if mission_id in self.mission_mandate else ""

    @gl.public.view
    def get_mandate_mission(self, mandate_id: str) -> str:
        self._require_mandate(mandate_id)
        return self.mandate_mission[mandate_id]

    @gl.public.view
    def mandate_count(self) -> int:
        return len(self.mandate_ids)

    @gl.public.view
    def get_deliverable(self, deliverable_id: str) -> str:
        if deliverable_id not in self.deliverable_payload:
            _reject(f"unknown deliverable {deliverable_id}")
        return self.deliverable_payload[deliverable_id]

    @gl.public.view
    def get_deliverable_hash(self, deliverable_id: str) -> str:
        if deliverable_id not in self.deliverable_hash:
            _reject(f"unknown deliverable {deliverable_id}")
        return self.deliverable_hash[deliverable_id]

    @gl.public.view
    def list_mandate_deliverables(self, mandate_id: str) -> list[str]:
        if mandate_id not in self.mandate_deliverables:
            return []
        return json.loads(self.mandate_deliverables[mandate_id])

    @gl.public.view
    def find_evidence(self, evidence_id: str) -> str:
        """The deliverable an evidence id was submitted under, or "" if unknown."""
        if evidence_id not in self.evidence_deliverable:
            return ""
        return self.evidence_deliverable[evidence_id]

    @gl.public.view
    def wiring(self) -> list[str]:
        """The addresses this contract trusts: registry, adjudicator, observer, deployer."""
        return [self.registry, self.adjudicator, self.settlement_observer, self.deployer]
