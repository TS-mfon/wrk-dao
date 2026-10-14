# {
#   "Seq": [
#     { "Depends": "py-genlayer-multi:06zyvrlivjga0d5jlpdbprksc0pa6jmllxvp8s20hq1l512vh5yk" },
#     { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
#   ]
# }
#
# Two runners in a Seq, both pinned to concrete hashes. See wrk_registry.py's header.
"""wrk_adjudicator — proposal selection and work adjudication.

**The only contract in this protocol that may contain a non-deterministic block.**
`scripts/verify-ic-discipline.py nondet` enforces that across all four ICs: if a
`gl.nondet` or `gl.eq_principle` call appears anywhere else, the check fails. Contracts
C12 and C17.

Authority: **judgment**. This contract forms opinions and nothing else. It holds no
value, moves no value, and cannot authorize a release — `verify-ic-discipline.py payment`
enforces that structurally (SPEC §33).

Why the model never names a number
----------------------------------
A model asked *"how much should they be paid?"* produces a figure nobody can audit. A
model asked *"was criterion ac_2 met, yes or no, and why?"* produces a finding that can be
checked against the evidence. So adjudication runs **one prompt per acceptance criterion**,
and `release_bp` is then computed by `lib.types.weighted_release_bp` from weights the
mission fixed before the work began. The verdict label is derived from that number, not
read from the response.

That is the whole defence-in-depth story, and prompt fencing is the least of it. A
successful prompt injection can at worst flip one criterion's finding — the same exposure
as a mistaken human reviewer. It cannot invent a payee (allocations come from the
mandate's accepted workers), exceed the budget (basis points are bounded and re-checked
on Base), or skip finality (below).

Reputation is never read here
-----------------------------
Invariant I9. A worker's past must not bias the judgment of their present work, so this
contract has no access to reputation at all — `verify-ic-discipline.py reputation`
enforces the absence rather than trusting the author to remember.

Finality is observed, not asserted
----------------------------------
SPEC §34: *accepted is not finalized*. A contract cannot read its own finality, so this
one does not claim to. Instead it relies on the platform guarantee that
`ContractProxy.emit(on='finalized')` holds an outbound message until **this** transaction
is finalized. `adjudicate` emits `wrk_work.record_adjudication` that way, so the mandate
can only reach `ADJUDICATED` in `wrk_work` after this adjudication is final.

`confirm_finality` then *observes* that: it reads the mandate's state from `wrk_work`, and
the state being `ADJUDICATED` there is proof the emission landed, which is proof this
adjudication was finalized. Only then does `get_settlement_payload` return anything. The
settlement adapter therefore cannot obtain a settlement-shaped payload from an adjudication
that has merely been accepted — which is invariant I1 at its source.
"""

from genlayer import *

from lib.canonical import canonicalize
from lib.hashing import content_hash
from lib.ids import encode_ulid, id_pattern
from lib.keccak import keccak256
from lib.money import BP_DENOMINATOR
from lib.prompts import (
    CRITERION_EQUIVALENCE_PRINCIPLE,
    SELECTION_EQUIVALENCE_PRINCIPLE,
    criterion_adjudication_prompt,
    evidence_digest,
    selection_prompt,
)
from lib.types import CriterionFinding, Decision, weighted_release_bp
from lib.validation import ValidationError

import json
import re
from datetime import datetime, timezone

#: Deterministic business refusals. A validator re-executing sees the identical string.
ERROR_EXPECTED = "[EXPECTED]"
#: The model returned something this contract will not parse. Classified separately so the
#: network can tell "the worker's submission was bad" from "the model misbehaved" — they
#: call for different responses, and collapsing them hides a model regression as a
#: business outcome.
ERROR_LLM = "[LLM_ERROR]"

BYTES32 = re.compile(r"^0x[0-9a-f]{64}$")
EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")

#: Bounds on a model response, so a runaway generation cannot be stored.
MAX_RATIONALE = 4000
MAX_REASONING = 4000

FINDING_FIELDS = ("criterion_id", "met", "confidence_bp", "rationale")


# ── events (docs/ARCHITECTURE.md §9) ────────────────────────────────────────
#
# The read model is event-sourced. `DecisionRecorded` carries the verdict and the release
# basis points so the indexer never has to re-derive a payout -- and `DecisionFinalized` is
# separate from it on purpose, because "adjudicated" and "finalized" are different facts
# (SPEC §34) and collapsing them into one event would let a reader treat an accepted
# decision as settleable.


class SelectionDecided(gl.Event):
    def __init__(self, mission_id: str, /, **blob): ...


class DecisionRecorded(gl.Event):
    def __init__(self, mandate_id: str, /, **blob): ...


class DecisionFinalized(gl.Event):
    def __init__(self, mandate_id: str, /, **blob): ...

SELECTION_FIELDS = (
    "selected_proposal_id",
    "reasoning",
    "runner_up_proposal_id",
    "confidence_bp",
)


def _reject(message: str):
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {message}")


def _reject_llm(message: str):
    raise gl.vm.UserError(f"{ERROR_LLM} {message}")


def _now() -> int:
    """Transaction time in Unix seconds — deterministic across re-execution."""
    return int(datetime.now(timezone.utc).timestamp())


class WrkAdjudicator(gl.Contract):
    # ── wiring ──────────────────────────────────────────────────────────────
    work: str
    deployer: str

    # ── selection ───────────────────────────────────────────────────────────
    selection_payload: TreeMap[str, str]
    selection_hash: TreeMap[str, str]
    selection_proposal: TreeMap[str, str]
    selection_ids: DynArray[str]

    # ── adjudication ────────────────────────────────────────────────────────
    decision_payload: TreeMap[str, str]
    decision_hash: TreeMap[str, str]
    decision_id_of: TreeMap[str, str]
    #: "ADJUDICATED" once judged, "FINALIZED" once finality has been observed.
    decision_state: TreeMap[str, str]
    decision_finalized_at: TreeMap[str, u256]
    decision_ids: DynArray[str]

    def __init__(self, work: str) -> None:
        """Wire the work contract. Fixed at construction; there is no setter.

        A rotatable `work` address would let whoever can rotate it point this contract at
        a substitute that reports any mandate as ready to adjudicate.
        """
        if not EVM_ADDRESS.match(work):
            _reject(f"work must be a 0x-prefixed 20-byte address, got {work!r}")
        self.work = work.lower()
        self.deployer = gl.message.sender_address.as_hex.lower()

    # ── internal: wiring and plumbing ───────────────────────────────────────

    def _work(self):
        return gl.get_contract_at(Address(self.work))

    def _sender(self) -> str:
        return gl.message.sender_address.as_hex.lower()

    def _decision_id(self, mandate_id: str) -> str:
        """A deterministic `dec_` ULID derived from the mandate.

        Derived rather than generated: a ULID's random half would differ between the
        leader and a re-executing validator, and the id goes into the decision's content
        hash, so a random one would make every adjudication fail consensus. One mandate
        therefore has exactly one possible decision id, which also makes the decision
        addressable by anyone who knows the mandate.
        """
        digest = keccak256(f"wrk/decision/v1|{mandate_id}".encode("ascii"))
        return "dec_" + encode_ulid(int.from_bytes(digest[:16], "big"))

    # ── internal: the two non-deterministic seams ───────────────────────────
    #
    # Every nondet call in this protocol is one of the two below. Each wraps its prompt in
    # an equivalence principle, so a validator re-derives the answer and compares it on the
    # fields that matter rather than on wording. Neither writes storage, calls a contract,
    # or emits anything — a side effect inside a nondet block is not re-executed
    # identically and would split consensus.

    def _ask_criterion(self, prompt: str) -> str:
        def leader() -> str:
            return gl.nondet.exec_prompt(prompt)

        return gl.eq_principle.prompt_comparative(leader, CRITERION_EQUIVALENCE_PRINCIPLE)

    def _ask_selection(self, prompt: str) -> str:
        def leader() -> str:
            return gl.nondet.exec_prompt(prompt)

        return gl.eq_principle.prompt_comparative(leader, SELECTION_EQUIVALENCE_PRINCIPLE)

    # ── internal: strict response parsing ───────────────────────────────────

    def _parse_object(self, raw: object, label: str) -> dict:
        """Parse a model response into a JSON object, or refuse.

        Whitespace is stripped; nothing else is. A code fence is **not** stripped and prose
        around the JSON is **not** salvaged, because that is precisely "parsing hopefully"
        — and a model that ignores the output contract on the easy part has given no reason
        to be trusted on the judgment.
        """
        if not isinstance(raw, str):
            _reject_llm(f"{label}: expected a text response, got {type(raw).__name__}")
        text = raw.strip()
        if not text:
            _reject_llm(f"{label}: response was empty")
        if not text.startswith("{") or not text.endswith("}"):
            _reject_llm(
                f"{label}: response is not a single bare JSON object "
                f"(starts {text[:24]!r}, ends {text[-24:]!r})"
            )
        try:
            value = json.loads(text)
        except Exception as error:
            _reject_llm(f"{label}: response is not valid JSON: {error}")
        if not isinstance(value, dict):
            _reject_llm(f"{label}: response is {type(value).__name__}, not a JSON object")
        return value

    def _exact_fields(self, value: dict, fields: tuple, label: str) -> None:
        present = set(value.keys())
        expected = set(fields)
        missing = sorted(expected - present)
        if missing:
            _reject_llm(f"{label}: response is missing field(s): {', '.join(missing)}")
        unknown = sorted(present - expected)
        if unknown:
            # Strict, as everywhere else in this protocol: an unexpected field means the
            # model answered a different question than the one asked.
            _reject_llm(f"{label}: response has unexpected field(s): {', '.join(unknown)}")

    def _bp(self, value: object, label: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            _reject_llm(f"{label}: must be an integer number of basis points, got {value!r}")
        if value < 0 or value > BP_DENOMINATOR:
            _reject_llm(f"{label}: must be within 0..{BP_DENOMINATOR}, got {value}")
        return value

    def _text(self, value: object, label: str, maximum: int) -> str:
        if not isinstance(value, str):
            _reject_llm(f"{label}: must be a string, got {type(value).__name__}")
        if not value.strip():
            _reject_llm(f"{label}: must not be empty")
        if len(value) > maximum:
            _reject_llm(f"{label}: must be at most {maximum} characters, got {len(value)}")
        return value

    def _parse_finding(self, raw: object, criterion_id: str) -> dict:
        """One criterion's finding, strictly.

        `met` must be a real boolean, not 1/0 or "true": the whole payout follows from this
        field and a truthy string would be read as acceptance.
        """
        label = f"criterion {criterion_id}"
        value = self._parse_object(raw, label)
        self._exact_fields(value, FINDING_FIELDS, label)

        if value["criterion_id"] != criterion_id:
            # A model that answers about a different criterion must not have its answer
            # silently attributed to this one — that would misroute the weight.
            _reject_llm(
                f"{label}: response is about criterion {value['criterion_id']!r}, "
                f"not {criterion_id!r}"
            )
        if not isinstance(value["met"], bool):
            _reject_llm(f"{label}: 'met' must be a JSON boolean, got {value['met']!r}")

        return {
            "criterion_id": criterion_id,
            "met": value["met"],
            "confidence_bp": self._bp(value["confidence_bp"], f"{label}.confidence_bp"),
            "rationale": self._text(value["rationale"], f"{label}.rationale", MAX_RATIONALE),
        }

    def _parse_selection(self, raw: object, allowed: list[str]) -> dict:
        label = "selection"
        value = self._parse_object(raw, label)
        self._exact_fields(value, SELECTION_FIELDS, label)

        selected = value["selected_proposal_id"]
        if selected is not None:
            if not isinstance(selected, str) or selected not in allowed:
                # The model may only choose from the proposals it was shown. Without this
                # it could name a proposal from another mission, or invent one.
                _reject_llm(
                    f"{label}: selected_proposal_id {selected!r} is not one of the "
                    f"{len(allowed)} proposal(s) presented"
                )

        runner_up = value["runner_up_proposal_id"]
        if runner_up is not None:
            if not isinstance(runner_up, str) or runner_up not in allowed:
                _reject_llm(
                    f"{label}: runner_up_proposal_id {runner_up!r} is not one of the "
                    f"proposals presented"
                )
            if runner_up == selected:
                _reject_llm(f"{label}: runner_up_proposal_id equals selected_proposal_id")

        return {
            "selected_proposal_id": selected,
            "reasoning": self._text(value["reasoning"], f"{label}.reasoning", MAX_REASONING),
            "runner_up_proposal_id": runner_up,
            "confidence_bp": self._bp(value["confidence_bp"], f"{label}.confidence_bp"),
        }

    # ── selection: C12 ──────────────────────────────────────────────────────

    @gl.public.write
    def select(self, mission_id: str) -> str:
        """Choose a proposal for `mission_id` and record the choice in wrk_work.

        Returns the selection decision's content hash. The mission must already be
        SELECTING — moving it there is the creator's act, not this contract's, so an
        adjudication can never be started on a mission whose owner has not closed it.
        """
        if not re.match(id_pattern("msn"), mission_id):
            _reject(f"{mission_id} is not an msn_ prefixed ULID")
        if mission_id in self.selection_payload:
            _reject(f"mission {mission_id} has already been selected")

        work = self._work()
        state = work.view().get_mission_state(mission_id)
        if state != "SELECTING":
            _reject(f"mission {mission_id} is {state}, not SELECTING")

        proposal_ids = list(work.view().list_mission_proposals(mission_id))
        if not proposal_ids:
            _reject(f"mission {mission_id} has no proposals to select from")

        mission = json.loads(work.view().get_mission(mission_id))
        proposals = [json.loads(work.view().get_proposal(pid)) for pid in proposal_ids]

        prompt = selection_prompt(
            mission_outcome=mission["outcome_statement"],
            acceptance_criteria=mission["acceptance_criteria"],
            proposals=proposals,
        )
        parsed = self._parse_selection(self._ask_selection(prompt), proposal_ids)

        if parsed["selected_proposal_id"] is None:
            # A refusal to select is a legitimate outcome (SPEC §21): selecting a weak
            # proposal costs the DAO its budget, selecting none costs it time. It is not
            # recorded as a selection, so the mission stays SELECTING and the creator can
            # cancel or re-open.
            _reject(
                f"no proposal was adequate for mission {mission_id}: {parsed['reasoning']}"
            )

        decision = {
            "schema_version": 1,
            "mission_id": mission_id,
            "selected_proposal_id": parsed["selected_proposal_id"],
            "runner_up_proposal_id": parsed["runner_up_proposal_id"],
            "confidence_bp": parsed["confidence_bp"],
            "reasoning": parsed["reasoning"],
            "candidate_proposal_ids": sorted(proposal_ids),
            "selected_at_unix": _now(),
        }
        canonical = canonicalize(decision)
        digest = content_hash(decision)

        self.selection_payload[mission_id] = canonical
        self.selection_hash[mission_id] = digest
        self.selection_proposal[mission_id] = parsed["selected_proposal_id"]
        self.selection_ids.append(mission_id)
        SelectionDecided(
            mission_id,
            proposal_id=parsed["selected_proposal_id"],
            runner_up_proposal_id=parsed["runner_up_proposal_id"] or "",
            decision_hash=digest,
            confidence_bp=u256(parsed["confidence_bp"]),
            candidate_count=u256(len(proposal_ids)),
        ).emit()

        # on='finalized' is the default and is the point: wrk_work learns the selection
        # only once this transaction is final, so a selection that is merely accepted
        # cannot start a mandate.
        self._work().emit().record_selection(
            mission_id, parsed["selected_proposal_id"], digest
        )
        return digest

    # ── adjudication: C17 ───────────────────────────────────────────────────

    @gl.public.write
    def adjudicate(self, mandate_id: str) -> str:
        """Judge a submitted mandate criterion by criterion and record the decision.

        One prompt per acceptance criterion. That costs more than a single prompt asking
        for a verdict, and it is the reason the outcome is auditable: each finding names
        the criterion it answers and cites the evidence it relied on, and the payout is
        arithmetic over weights the mission fixed in advance.
        """
        if not re.match(id_pattern("mnd"), mandate_id):
            _reject(f"{mandate_id} is not an mnd_ prefixed ULID")
        if mandate_id in self.decision_payload:
            _reject(f"mandate {mandate_id} has already been adjudicated")

        work = self._work()
        state = work.view().get_mandate_state(mandate_id)
        if state != "SUBMITTED":
            _reject(f"mandate {mandate_id} is {state}, not SUBMITTED")

        mandate = json.loads(work.view().get_mandate(mandate_id))
        deliverable_ids = list(work.view().list_mandate_deliverables(mandate_id))
        if not deliverable_ids:
            _reject(f"mandate {mandate_id} has no deliverable to adjudicate")

        deliverables = [json.loads(work.view().get_deliverable(d)) for d in deliverable_ids]
        summary = "\n\n".join(
            f"[{d['deliverable_id']}] {d['title']}\n{d['summary']}" for d in deliverables
        )
        evidence: list[dict] = []
        for item in deliverables:
            evidence.extend(item["evidence"])
        digest_text = evidence_digest(evidence)

        criteria = mandate["acceptance_criteria"]
        weights = {c["id"]: c["weight_bp"] for c in criteria}

        findings: list[CriterionFinding] = []
        for criterion in criteria:
            prompt = criterion_adjudication_prompt(
                criterion_id=criterion["id"],
                criterion_statement=criterion["statement"],
                mandate_objective=mandate["objective"],
                deliverable_summary=summary,
                evidence_digest=digest_text,
            )
            parsed = self._parse_finding(self._ask_criterion(prompt), criterion["id"])
            findings.append(
                CriterionFinding(
                    criterion_id=parsed["criterion_id"],
                    met=parsed["met"],
                    confidence_bp=parsed["confidence_bp"],
                    rationale=parsed["rationale"],
                )
            )

        # The arithmetic the model never sees. release_bp is the summed weight of the met
        # criteria; the verdict label is derived from release_bp rather than reported.
        try:
            release_bp = weighted_release_bp(findings, weights)
        except ValueError as error:
            _reject(str(error))
        refund_bp = BP_DENOMINATOR - release_bp

        if release_bp == BP_DENOMINATOR:
            verdict = "FULL_ACCEPTANCE"
        elif release_bp == 0:
            verdict = "REJECTION"
        else:
            verdict = "PARTIAL_ACCEPTANCE"

        # Payees come from the mandate, never from the model: an injected instruction
        # cannot add an address to this list because the list is not an output of the
        # prompt at all. A rejection has no payees (lib.money.assert_allocations).
        allocations = (
            [{"agent_id": w["agent_id"], "share_bp": w["share_bp"]} for w in mandate["workers"]]
            if release_bp > 0
            else []
        )

        met_count = sum(1 for finding in findings if finding.met)
        payload = {
            "schema_version": 1,
            "decision_id": self._decision_id(mandate_id),
            "mandate_id": mandate_id,
            "verdict": verdict,
            "criteria_findings": [finding.to_dict() for finding in findings],
            "release_bp": release_bp,
            "refund_bp": refund_bp,
            "allocations": allocations,
            "adjudicated_at_unix": _now(),
            "notes": (
                f"{met_count} of {len(criteria)} acceptance criteria met; "
                f"release_bp computed from the mission's own criterion weights."
            ),
        }

        # Decision.from_dict runs the full §7 validation, including that release_bp +
        # refund_bp == 10000, that the verdict agrees with the numbers, and that the
        # allocations sum exactly. A decision that fails it never reaches a content hash
        # and so can never become a digest the escrow would try to settle.
        try:
            validated = Decision.from_dict(payload).to_dict()
        except (ValidationError, ValueError) as error:
            _reject(f"assembled decision failed §7 validation: {error}")

        canonical = canonicalize(validated)
        decision_hash = content_hash(validated)

        self.decision_payload[mandate_id] = canonical
        self.decision_hash[mandate_id] = decision_hash
        self.decision_id_of[mandate_id] = validated["decision_id"]
        self.decision_state[mandate_id] = "ADJUDICATED"
        self.decision_ids.append(mandate_id)
        DecisionRecorded(
            mandate_id,
            decision_id=validated["decision_id"],
            decision_hash=decision_hash,
            verdict=verdict,
            release_bp=u256(release_bp),
            refund_bp=u256(refund_bp),
            criteria_met=u256(met_count),
            criteria_total=u256(len(criteria)),
            state="ADJUDICATED",
        ).emit()

        # Both emissions default to on='finalized', and in this order: wrk_work moves
        # SUBMITTED -> ADJUDICATING -> ADJUDICATED only after this transaction is final.
        # That is the platform guarantee this contract's finality story rests on, rather
        # than an assertion of its own.
        #
        # Written as two full `self._work().emit().<method>(...)` expressions rather than
        # through a saved emitter handle so that every cross-contract call in this file is
        # greppable and extractable from the AST — the surface-agreement check in
        # test_adjudicator.py reads exactly that shape, and a call hidden behind a local
        # variable would slip past it.
        self._work().emit().start_adjudication(mandate_id)
        self._work().emit().record_adjudication(mandate_id, decision_hash)
        return decision_hash

    @gl.public.write
    def confirm_finality(self, mandate_id: str) -> str:
        """Observe that this adjudication was finalized, unlocking the settlement payload.

        Permissionless, because it grants nothing — it reads a fact. The fact is that
        `wrk_work` reports the mandate as ADJUDICATED, which it can only do if the
        `on='finalized'` emission from `adjudicate` was released, which happens only once
        that adjudication transaction is final.

        This is a *sequencing* observation, not a cryptographic finality proof. The
        settlement keeper must still wait for GenLayer finality on its own read before
        posting to Base; `docs/DEPLOYMENT.md` records that as a keeper requirement. What
        this method guarantees is the direction that matters here: nothing
        settlement-shaped leaves this contract earlier than it should.
        """
        if mandate_id not in self.decision_payload:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        if self.decision_state[mandate_id] == "FINALIZED":
            _reject(f"mandate {mandate_id} is already finalized")

        state = self._work().view().get_mandate_state(mandate_id)
        if state not in ("ADJUDICATED", "SETTLED", "REFUNDED"):
            _reject(
                f"mandate {mandate_id} is {state} in wrk_work: this adjudication has not "
                f"been finalized yet"
            )

        recorded = self._work().view().get_mandate_decision_hash(mandate_id)
        if recorded != self.decision_hash[mandate_id]:
            # wrk_work records a decision hash that must be this decision's. A mismatch
            # means something other than this adjudication reached that mandate.
            _reject(
                f"wrk_work records decision hash {recorded} for mandate {mandate_id}, "
                f"not {self.decision_hash[mandate_id]}"
            )

        self.decision_state[mandate_id] = "FINALIZED"
        self.decision_finalized_at[mandate_id] = u256(_now())
        DecisionFinalized(
            mandate_id,
            decision_hash=self.decision_hash[mandate_id],
            finalized_at=self.decision_finalized_at[mandate_id],
            state="FINALIZED",
        ).emit()
        return "FINALIZED"

    # ── reads ───────────────────────────────────────────────────────────────

    @gl.public.view
    def get_selection(self, mission_id: str) -> str:
        if mission_id not in self.selection_payload:
            _reject(f"mission {mission_id} has no recorded selection")
        return self.selection_payload[mission_id]

    @gl.public.view
    def get_selection_hash(self, mission_id: str) -> str:
        if mission_id not in self.selection_hash:
            _reject(f"mission {mission_id} has no recorded selection")
        return self.selection_hash[mission_id]

    @gl.public.view
    def get_selected_proposal(self, mission_id: str) -> str:
        if mission_id not in self.selection_proposal:
            return ""
        return self.selection_proposal[mission_id]

    @gl.public.view
    def selection_count(self) -> int:
        return len(self.selection_ids)

    @gl.public.view
    def get_decision(self, mandate_id: str) -> str:
        """The decision payload, readable as soon as it exists.

        Readable before finality on purpose: transparency about what was judged is not the
        same as authorizing a payment. `get_settlement_payload` is the gated one.
        """
        if mandate_id not in self.decision_payload:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        return self.decision_payload[mandate_id]

    @gl.public.view
    def get_decision_hash(self, mandate_id: str) -> str:
        if mandate_id not in self.decision_hash:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        return self.decision_hash[mandate_id]

    @gl.public.view
    def get_decision_id(self, mandate_id: str) -> str:
        if mandate_id not in self.decision_id_of:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        return self.decision_id_of[mandate_id]

    @gl.public.view
    def get_criteria_findings(self, mandate_id: str) -> str:
        """The per-criterion findings alone, as a JSON array.

        These are the auditable core of a decision: each names the criterion it answers,
        whether it was met, and the evidence the model cited. A reader checking whether a
        payout was justified needs exactly this and should not have to parse the whole
        decision to get it.
        """
        if mandate_id not in self.decision_payload:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        decision = json.loads(self.decision_payload[mandate_id])
        return json.dumps(
            decision["criteria_findings"], sort_keys=True, separators=(",", ":")
        )

    @gl.public.view
    def get_decision_state(self, mandate_id: str) -> str:
        if mandate_id not in self.decision_state:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        return self.decision_state[mandate_id]

    @gl.public.view
    def is_settlement_eligible(self, mandate_id: str) -> bool:
        """Whether a settlement payload may be taken from this decision.

        False for an adjudication that exists but has not been finalized. "Accepted" is
        not "finalized" (SPEC §34), and this is the boundary where that distinction either
        holds or silently does not.
        """
        if mandate_id not in self.decision_state:
            return False
        return self.decision_state[mandate_id] == "FINALIZED"

    @gl.public.view
    def get_settlement_payload(self, mandate_id: str) -> str:
        """The decision the settlement adapter posts to Base. Refused before finality."""
        if mandate_id not in self.decision_payload:
            _reject(f"mandate {mandate_id} has not been adjudicated")
        if self.decision_state[mandate_id] != "FINALIZED":
            _reject(
                f"mandate {mandate_id} is adjudicated but not finalized: no settlement "
                f"payload is available until finality is confirmed"
            )
        return self.decision_payload[mandate_id]

    @gl.public.view
    def get_finalized_at(self, mandate_id: str) -> int:
        """The finality timestamp, or 0 while the decision is not finalized."""
        if mandate_id not in self.decision_finalized_at:
            return 0
        return int(self.decision_finalized_at[mandate_id])

    @gl.public.view
    def decision_count(self) -> int:
        return len(self.decision_ids)

    @gl.public.view
    def wiring(self) -> list[str]:
        """The addresses this contract trusts: the work contract and its deployer."""
        return [self.work, self.deployer]
