"""wrk_reputation — DAO-scoped reputation written only after final settlement.

Test names carry the `-k` selectors leaf-1.2.4's gates filter on: dao_scoped,
only_after_settlement, idempotent, scoring.

Two fakes stand in for `wrk_work` and `wrk_adjudicator`, for the reason recorded in
test_work.py: direct mode loads exactly one contract class per test, so the real ones
cannot be deployed alongside this contract. `gl.get_contract_at` is patched with a router
that dispatches on the requested address, so the contract's own distinction between its
two handles is preserved rather than collapsed into one fake.

`TestSurfaceAgreement` parses both sibling contracts, because a fake cannot prove that
`wrk_adjudicator.is_settlement_eligible` exists — only that this contract uses the answer
correctly.
"""

import ast
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

GENLAYER_ROOT = Path(__file__).resolve().parents[2]

NOW = 1_800_000_000

WORK_ADDRESS = "0x" + "e0" * 20
ADJUDICATOR_ADDRESS = "0x" + "a0" * 20
CALLER = "0x" + "11" * 20
STRANGER = "0x" + "99" * 20


def ulid(prefix: str, tag: str) -> str:
    body = ("01JQ8Z" + "0" * 20)[: 26 - len(tag)] + tag
    assert len(body) == 26, body
    assert not (set(body) & set("ILOU")), body
    return f"{prefix}_{body}"


DAO = ulid("dao", "D1")
DAO2 = ulid("dao", "D2")
A2 = ulid("agt", "A2")
A3 = ulid("agt", "A3")
N1 = ulid("mnd", "N1")
N2 = ulid("mnd", "N2")
N3 = ulid("mnd", "N3")
N4 = ulid("mnd", "N4")

#: Every mandate state that is NOT final. G3 is asserted across all of them, because "only
#: after settlement" is the whole claim and one counter-example is not enough.
NON_FINAL_STATES = (
    "CREATED",
    "ACCEPTED",
    "FUNDED",
    "IN_PROGRESS",
    "SUBMITTED",
    "ADJUDICATING",
    "ADJUDICATED",
    "EXPIRED",
    "CANCELLED",
)
FINAL_STATES = ("SETTLED", "REFUNDED")


def iso(unix_seconds: int) -> str:
    """Unix seconds as the ISO string `VMContext.warp` expects."""
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hexaddr(value: str) -> bytes:
    return bytes.fromhex(value[2:])


# ── payload builders ────────────────────────────────────────────────────────


def mandate_payload(mandate_id=N1, dao_id=DAO, workers=((A2, 10_000),)):
    return {
        "schema_version": 1,
        "mandate_id": mandate_id,
        "dao_id": dao_id,
        "mission_id": ulid("msn", "M1"),
        "creator_agent_id": ulid("agt", "A1"),
        "workers": [{"agent_id": a, "share_bp": s} for a, s in workers],
        "objective": "Deliver the settlement adapter.",
        "deliverables": ["Deliverable 0."],
        "budget": {"asset": "USDC", "chain_id": 84532, "amount_atomic": "1000000", "decimals": 6},
        "deadline_unix": 1_900_000_000,
        "acceptance_criteria": [
            {"id": "criterion_0", "statement": "It works.", "weight_bp": 10_000}
        ],
        "evidence_requirements": ["source_repository"],
        "proposal_hash": "0x" + "ab" * 32,
        "selection_decision_hash": "0x" + "ef" * 32,
        "created_at_unix": NOW,
    }


def decision_payload(mandate_id=N1, verdict="FULL_ACCEPTANCE", release_bp=10_000, workers=((A2, 10_000),)):
    return {
        "schema_version": 1,
        "decision_id": ulid("dec", "C1"),
        "mandate_id": mandate_id,
        "verdict": verdict,
        "criteria_findings": [
            {
                "criterion_id": "criterion_0",
                "met": release_bp > 0,
                "confidence_bp": 9000,
                "rationale": "The evidence supports the conclusion.",
            }
        ],
        "release_bp": release_bp,
        "refund_bp": 10_000 - release_bp,
        "allocations": (
            [{"agent_id": a, "share_bp": s} for a, s in workers] if release_bp > 0 else []
        ),
        "adjudicated_at_unix": NOW,
        "notes": "",
    }


def full(mandate_id=N1, **kwargs):
    return decision_payload(mandate_id, "FULL_ACCEPTANCE", 10_000, **kwargs)


def partial(mandate_id=N1, release_bp=7000, **kwargs):
    return decision_payload(mandate_id, "PARTIAL_ACCEPTANCE", release_bp, **kwargs)


def rejection(mandate_id=N1, **kwargs):
    return decision_payload(mandate_id, "REJECTION", 0, **kwargs)


# ── fakes ───────────────────────────────────────────────────────────────────


class FakeWork:
    VIEW_SURFACE = {"get_mandate_state": 1, "get_mandate": 1}

    def __init__(self):
        self.states: dict[str, str] = {}
        self.mandates: dict[str, str] = {}

    def with_mandate(self, mandate_id=N1, state="SETTLED", payload=None):
        self.states[mandate_id] = state
        self.mandates[mandate_id] = json.dumps(payload or mandate_payload(mandate_id))
        return self

    def view(self, state=None):
        return self

    def get_mandate_state(self, mandate_id):
        if mandate_id not in self.states:
            self._reject(f"unknown mandate {mandate_id}")
        return self.states[mandate_id]

    def get_mandate(self, mandate_id):
        if mandate_id not in self.mandates:
            self._reject(f"unknown mandate {mandate_id}")
        return self.mandates[mandate_id]

    def _reject(self, message):
        import genlayer

        raise genlayer.gl.vm.UserError(f"[EXPECTED] {message}")


class FakeAdjudicator:
    VIEW_SURFACE = {"is_settlement_eligible": 1, "get_settlement_payload": 1}

    def __init__(self):
        self.eligible: set[str] = set()
        self.payloads: dict[str, str] = {}

    def with_decision(self, mandate_id=N1, payload=None, eligible=True):
        self.payloads[mandate_id] = json.dumps(payload or full(mandate_id))
        if eligible:
            self.eligible.add(mandate_id)
        return self

    def view(self, state=None):
        return self

    def is_settlement_eligible(self, mandate_id):
        return mandate_id in self.eligible

    def get_settlement_payload(self, mandate_id):
        if mandate_id not in self.payloads:
            self._reject(f"mandate {mandate_id} has not been adjudicated")
        if mandate_id not in self.eligible:
            self._reject(f"mandate {mandate_id} is adjudicated but not finalized")
        return self.payloads[mandate_id]

    def _reject(self, message):
        import genlayer

        raise genlayer.gl.vm.UserError(f"[EXPECTED] {message}")


class Env:
    def __init__(self, rep, work, adj, vm):
        self.rep = rep
        self.work = work
        self.adj = adj
        self.vm = vm

    def act_as(self, address):
        self.vm.sender = hexaddr(address)
        return self

    def warp(self, when):
        """Move the harness clock, so the contract's own `_now()` really runs."""
        self.vm.warp(iso(when))
        return self

    def settled(self, mandate_id=N1, decision=None, dao_id=DAO, workers=((A2, 10_000),), state="SETTLED"):
        """A mandate in a final state with a finalized decision behind it."""
        payload = decision if decision is not None else full(mandate_id, workers=workers)
        self.work.with_mandate(
            mandate_id, state=state, payload=mandate_payload(mandate_id, dao_id, workers)
        )
        self.adj.with_decision(mandate_id, payload=payload, eligible=True)
        return mandate_id


@pytest.fixture
def env(deploy, direct_vm, monkeypatch):
    direct_vm.sender = hexaddr(CALLER)
    rep = deploy("wrk_reputation.py", WORK_ADDRESS, ADJUDICATOR_ADDRESS)

    import genlayer

    work = FakeWork()
    adj = FakeAdjudicator()
    routes = {WORK_ADDRESS.lower(): work, ADJUDICATOR_ADDRESS.lower(): adj}

    def router(address):
        """Dispatch on the requested address.

        A single fake for both handles would hide a contract that asked the work contract
        for a decision, or the adjudicator for a mandate — so the router keeps the
        distinction the contract itself draws.
        """
        raw = getattr(address, "as_hex", None)
        hexed = (raw() if callable(raw) else raw) if raw is not None else str(address)
        target = routes.get(hexed.lower())
        assert target is not None, f"contract asked for an unexpected address: {hexed}"
        return target

    monkeypatch.setattr(genlayer.gl, "get_contract_at", router, raising=False)

    direct_vm.warp(iso(NOW))
    return Env(rep, work, adj, direct_vm)


# ── wiring ──────────────────────────────────────────────────────────────────


class TestWiring:
    def test_wiring_is_readable_and_lowercased(self, env):
        work, adjudicator, deployer = env.rep.wiring()
        assert work == WORK_ADDRESS.lower()
        assert adjudicator == ADJUDICATOR_ADDRESS.lower()
        assert deployer == CALLER.lower()

    @pytest.mark.parametrize("bad", ["0xnope", "", "not-an-address", "0x" + "11" * 19])
    def test_a_malformed_work_address_is_refused_at_construction(self, deploy, bad):
        """No setters exist, so construction is the only chance to refuse one.

        One deploy per test: direct mode permits exactly one contract load per test, and
        a second `deploy()` in the same test fails with "only one contract is allowed"
        rather than with the refusal being measured.
        """
        with pytest.raises(Exception, match="must be a 0x-prefixed 20-byte address"):
            deploy("wrk_reputation.py", bad, ADJUDICATOR_ADDRESS)

    @pytest.mark.parametrize("bad", ["0xnope", "", "not-an-address", "0x" + "11" * 19])
    def test_a_malformed_adjudicator_address_is_refused_at_construction(self, deploy, bad):
        """A rotatable adjudicator address would let whoever can rotate it report any
        mandate as finalized with any verdict, so it is validated as strictly as `work`."""
        with pytest.raises(Exception, match="must be a 0x-prefixed 20-byte address"):
            deploy("wrk_reputation.py", WORK_ADDRESS, bad)


# ── DAO scoping (G2) ────────────────────────────────────────────────────────


class TestDaoScoped:
    def test_dao_scoped_records_are_independent_for_one_agent(self, env):
        """The same agent, two DAOs, opposite outcomes. Neither may leak into the other."""
        env.settled(N1, decision=full(N1), dao_id=DAO)
        env.rep.record_outcome(N1)
        env.settled(N2, decision=rejection(N2), dao_id=DAO2)
        env.rep.record_outcome(N2)

        assert env.rep.get_score(DAO, A2) == 10_000
        assert env.rep.get_score(DAO2, A2) == 0
        assert env.rep.has_record(DAO, A2) is True
        assert env.rep.has_record(DAO2, A2) is True

        first = json.loads(env.rep.get_reputation(DAO, A2))
        second = json.loads(env.rep.get_reputation(DAO2, A2))
        assert first["settled_mandates"] == 1 and first["full_acceptances"] == 1
        assert first["rejections"] == 0
        assert second["settled_mandates"] == 1 and second["rejections"] == 1
        assert second["full_acceptances"] == 0

    def test_dao_scoped_a_write_in_one_dao_does_not_create_a_record_in_another(self, env):
        env.settled(N1, dao_id=DAO)
        env.rep.record_outcome(N1)
        assert env.rep.has_record(DAO2, A2) is False
        assert env.rep.get_score(DAO2, A2) == 0
        assert json.loads(env.rep.get_reputation(DAO2, A2))["settled_mandates"] == 0

    def test_dao_scoped_an_agent_with_no_history_has_no_record_not_a_zero_one(self, env):
        """Conflating "new" with "rejected" is a quiet penalty on every newcomer, so the
        two are distinguishable: both score 0, only one has a record."""
        assert env.rep.has_record(DAO, A3) is False
        assert env.rep.get_score(DAO, A3) == 0

        env.settled(N1, decision=rejection(N1), workers=((A3, 10_000),))
        env.rep.record_outcome(N1)
        assert env.rep.has_record(DAO, A3) is True
        assert env.rep.get_score(DAO, A3) == 0

    def test_dao_scoped_rosters_are_per_dao(self, env):
        env.settled(N1, dao_id=DAO, workers=((A2, 10_000),))
        env.rep.record_outcome(N1)
        env.settled(N2, dao_id=DAO2, workers=((A3, 10_000),))
        env.rep.record_outcome(N2)
        assert env.rep.list_dao_agents(DAO) == [A2]
        assert env.rep.list_dao_agents(DAO2) == [A3]
        assert env.rep.list_dao_agents("dao_unknown") == []

    def test_dao_scoped_team_members_each_get_their_own_record(self, env):
        env.settled(N1, decision=partial(N1, 6000, workers=((A2, 6000), (A3, 4000))),
                    workers=((A2, 6000), (A3, 4000)))
        assert env.rep.record_outcome(N1) == 2
        # Both workers share the mandate's outcome: the release reflects the work, and the
        # allocation split is about money, not about standing.
        assert env.rep.get_score(DAO, A2) == 6000
        assert env.rep.get_score(DAO, A3) == 6000
        assert sorted(env.rep.list_dao_agents(DAO)) == sorted([A2, A3])

    def test_dao_scoped_network_record_aggregates_across_daos(self, env):
        """SPEC §491. Informational only — invariant I9 keeps it out of adjudication, and
        the adjudicator has no handle to this contract through which it could get in."""
        env.settled(N1, decision=full(N1), dao_id=DAO)
        env.rep.record_outcome(N1)
        env.settled(N2, decision=rejection(N2), dao_id=DAO2)
        env.rep.record_outcome(N2)

        assert env.rep.get_network_score(A2) == 5000
        network = json.loads(env.rep.get_network_reputation(A2))
        assert network["settled_mandates"] == 2
        assert network["total_release_bp"] == 10_000
        assert network["rejections"] == 1
        assert network["dao_ids"] == sorted([DAO, DAO2])
        assert env.rep.list_agent_daos(A2) == sorted([DAO, DAO2])

    def test_dao_scoped_network_record_is_empty_for_an_unknown_agent(self, env):
        network = json.loads(env.rep.get_network_reputation(A3))
        assert network["has_record"] is False
        assert network["settled_mandates"] == 0
        assert network["dao_ids"] == []
        assert env.rep.get_network_score(A3) == 0
        assert env.rep.list_agent_daos(A3) == []

    def test_dao_scoped_reads_are_canonical_json(self, env):
        env.settled(N1)
        env.rep.record_outcome(N1)
        for text in (
            env.rep.get_reputation(DAO, A2),
            env.rep.get_network_reputation(A2),
            env.rep.get_recorded_outcome(N1),
        ):
            assert text == json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))


# ── only after final settlement (G3) ────────────────────────────────────────


class TestOnlyAfterSettlement:
    @pytest.mark.parametrize("state", NON_FINAL_STATES)
    def test_only_after_settlement_every_earlier_state_is_refused(self, env, state):
        """Exhaustive over the non-final states. Reputation that can be written before
        settlement is a way of paying in standing before the work has been judged."""
        env.settled(N1, state=state)
        with pytest.raises(Exception, match="reputation is written only after final settlement"):
            env.rep.record_outcome(N1)
        assert env.rep.has_record(DAO, A2) is False
        assert env.rep.recorded_count() == 0

    @pytest.mark.parametrize("state", FINAL_STATES)
    def test_only_after_settlement_both_final_states_are_accepted(self, env, state):
        """The other direction at the boundary: a test that only asserted refusals would
        pass against a contract that refuses everything."""
        env.settled(N1, state=state)
        assert env.rep.record_outcome(N1) == 1
        assert env.rep.has_record(DAO, A2) is True

    def test_only_after_settlement_covers_every_mandate_state(self):
        """Guards the parametrisation itself: a state missing from both lists is a state
        this gate never exercises."""
        sys.path.insert(0, str(GENLAYER_ROOT))
        from lib.states import MANDATE_STATES

        assert set(NON_FINAL_STATES) | set(FINAL_STATES) == set(MANDATE_STATES)
        assert not set(NON_FINAL_STATES) & set(FINAL_STATES)

    def test_only_after_settlement_requires_a_finalized_decision(self, env):
        """Settled money is not enough: the decision must have passed the adjudicator's own
        finality gate. "Accepted" is not "finalized" (SPEC §34)."""
        env.work.with_mandate(N1, state="SETTLED")
        env.adj.with_decision(N1, eligible=False)
        with pytest.raises(Exception, match="no finalized decision"):
            env.rep.record_outcome(N1)
        assert env.rep.recorded_count() == 0

    def test_only_after_settlement_a_refund_without_adjudication_earns_nothing(self, env):
        """A refund that was never judged is not a judgment, so it is not a reputation
        event in either direction."""
        env.work.with_mandate(N1, state="REFUNDED")
        with pytest.raises(Exception, match="no finalized decision"):
            env.rep.record_outcome(N1)
        assert env.rep.has_record(DAO, A2) is False

    def test_only_after_settlement_refuses_a_decision_for_another_mandate(self, env):
        env.work.with_mandate(N1, state="SETTLED")
        env.adj.with_decision(N1, payload=full(N2), eligible=True)
        with pytest.raises(Exception, match="returned a decision for mandate"):
            env.rep.record_outcome(N1)

    def test_only_after_settlement_refuses_an_unknown_mandate(self, env):
        with pytest.raises(Exception, match="unknown mandate"):
            env.rep.record_outcome(N1)

    def test_only_after_settlement_requires_a_valid_mandate_ulid(self, env):
        with pytest.raises(Exception, match="mnd_ prefixed ULID"):
            env.rep.record_outcome("mnd_nope")

    def test_only_after_settlement_refuses_a_mandate_with_no_workers(self, env):
        payload = mandate_payload(N1)
        payload["workers"] = []
        env.work.with_mandate(N1, state="SETTLED", payload=payload)
        env.adj.with_decision(N1, payload=rejection(N1), eligible=True)
        with pytest.raises(Exception, match="names no workers"):
            env.rep.record_outcome(N1)

    def test_only_after_settlement_the_write_is_permissionless(self, env):
        """Every input is read from the sibling contracts and the caller supplies only an
        id, so gating this on an identity would only create a party who could withhold a
        worker's earned standing."""
        env.settled(N1)
        env.act_as(STRANGER)
        assert env.rep.record_outcome(N1) == 1
        assert env.rep.get_score(DAO, A2) == 10_000

    def test_only_after_settlement_stamps_the_recording_time(self, env):
        env.settled(N1)
        env.warp(NOW + 3600)
        env.rep.record_outcome(N1)
        assert json.loads(env.rep.get_reputation(DAO, A2))["last_recorded_at_unix"] == NOW + 3600


# ── idempotence (G4) ────────────────────────────────────────────────────────


class TestIdempotent:
    def test_idempotent_a_second_write_for_one_mandate_is_refused(self, env):
        """Replaying one outcome is how reputation gets inflated with no new work done."""
        env.settled(N1)
        env.rep.record_outcome(N1)
        with pytest.raises(Exception, match="has already been recorded"):
            env.rep.record_outcome(N1)

    def test_idempotent_the_refused_replay_changes_nothing(self, env):
        env.settled(N1)
        env.rep.record_outcome(N1)
        before = env.rep.get_reputation(DAO, A2)
        for _ in range(3):
            with pytest.raises(Exception, match="has already been recorded"):
                env.rep.record_outcome(N1)
        assert env.rep.get_reputation(DAO, A2) == before
        assert env.rep.get_score(DAO, A2) == 10_000
        assert env.rep.recorded_count() == 1

    def test_idempotent_replay_is_refused_even_by_a_different_caller(self, env):
        env.settled(N1)
        env.rep.record_outcome(N1)
        env.act_as(STRANGER)
        with pytest.raises(Exception, match="has already been recorded"):
            env.rep.record_outcome(N1)

    def test_idempotent_replay_is_refused_even_if_the_decision_is_rewritten(self, env):
        """The flag is on the mandate, not on the decision's content, so swapping the
        decision underneath cannot buy a second write."""
        env.settled(N1, decision=rejection(N1))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 0
        env.adj.payloads[N1] = json.dumps(full(N1))
        with pytest.raises(Exception, match="has already been recorded"):
            env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 0

    def test_idempotent_distinct_mandates_each_count_once(self, env):
        env.settled(N1, decision=full(N1))
        env.rep.record_outcome(N1)
        env.settled(N2, decision=full(N2))
        env.rep.record_outcome(N2)
        assert json.loads(env.rep.get_reputation(DAO, A2))["settled_mandates"] == 2
        assert env.rep.recorded_count() == 2
        assert sorted(env.rep.list_recorded()) == sorted([N1, N2])

    def test_idempotent_the_recorded_ledger_traces_a_score_to_its_sources(self, env):
        env.settled(N1, decision=partial(N1, 7000))
        env.rep.record_outcome(N1)
        assert env.rep.is_recorded(N1) is True
        assert env.rep.is_recorded(N2) is False
        outcome = json.loads(env.rep.get_recorded_outcome(N1))
        assert outcome == {
            "schema_version": 1,
            "mandate_id": N1,
            "dao_id": DAO,
            "verdict": "PARTIAL_ACCEPTANCE",
            "release_bp": 7000,
        }

    def test_idempotent_reads_of_an_unrecorded_mandate_are_refused(self, env):
        with pytest.raises(Exception, match="has not been recorded"):
            env.rep.get_recorded_outcome(N1)
        assert env.rep.list_recorded() == []


# ── scoring (G5) ────────────────────────────────────────────────────────────


class TestScoring:
    def test_scoring_full_acceptance_scores_the_whole_release(self, env):
        env.settled(N1, decision=full(N1))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 10_000

    def test_scoring_rejection_scores_zero(self, env):
        env.settled(N1, decision=rejection(N1))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 0

    @pytest.mark.parametrize("release", [1, 2500, 5000, 7000, 9999])
    def test_scoring_partial_acceptance_reflects_the_release_basis_points(self, env, release):
        env.settled(N1, decision=partial(N1, release))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == release

    def test_scoring_a_rejection_lowers_an_established_score(self, env):
        """The behavioural requirement, stated as the arithmetic it is: the score is the
        mean released basis points, and a rejection contributes zero to that mean."""
        env.settled(N1, decision=full(N1))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 10_000

        env.settled(N2, decision=rejection(N2))
        env.rep.record_outcome(N2)
        assert env.rep.get_score(DAO, A2) == 5000

        env.settled(N3, decision=rejection(N3))
        env.rep.record_outcome(N3)
        assert env.rep.get_score(DAO, A2) == 3333

    def test_scoring_a_full_acceptance_raises_a_damaged_score(self, env):
        env.settled(N1, decision=rejection(N1))
        env.rep.record_outcome(N1)
        assert env.rep.get_score(DAO, A2) == 0
        env.settled(N2, decision=full(N2))
        env.rep.record_outcome(N2)
        assert env.rep.get_score(DAO, A2) == 5000

    def test_scoring_is_the_mean_and_is_reproducible_from_the_record(self, env):
        """Anyone holding the decisions must be able to recompute the number, so the
        inputs are published alongside it."""
        env.settled(N1, decision=partial(N1, 7000))
        env.rep.record_outcome(N1)
        env.settled(N2, decision=partial(N2, 4000))
        env.rep.record_outcome(N2)

        record = json.loads(env.rep.get_reputation(DAO, A2))
        assert record["total_release_bp"] == 11_000
        assert record["settled_mandates"] == 2
        assert record["score_bp"] == 11_000 // 2 == 5500
        assert env.rep.get_score(DAO, A2) == record["score_bp"]

    def test_scoring_truncates_rather_than_rounds_up(self, env):
        """Conservative on purpose: a score is never rounded up into looking better than
        the released basis points support. 10000 + 0 + 0 over three mandates is 3333.33."""
        env.settled(N1, decision=full(N1))
        env.rep.record_outcome(N1)
        env.settled(N2, decision=rejection(N2))
        env.rep.record_outcome(N2)
        env.settled(N3, decision=rejection(N3))
        env.rep.record_outcome(N3)
        assert env.rep.get_score(DAO, A2) == 3333

    def test_scoring_counts_each_verdict_class_separately(self, env):
        env.settled(N1, decision=full(N1))
        env.rep.record_outcome(N1)
        env.settled(N2, decision=partial(N2, 5000))
        env.rep.record_outcome(N2)
        env.settled(N3, decision=rejection(N3))
        env.rep.record_outcome(N3)
        env.settled(N4, decision=full(N4))
        env.rep.record_outcome(N4)

        record = json.loads(env.rep.get_reputation(DAO, A2))
        assert record["full_acceptances"] == 2
        assert record["partial_acceptances"] == 1
        assert record["rejections"] == 1
        assert record["settled_mandates"] == 4
        assert record["score_bp"] == (10_000 + 5000 + 0 + 10_000) // 4 == 6250

    def test_scoring_network_score_is_the_mean_across_every_dao(self, env):
        env.settled(N1, decision=partial(N1, 8000), dao_id=DAO)
        env.rep.record_outcome(N1)
        env.settled(N2, decision=partial(N2, 2000), dao_id=DAO2)
        env.rep.record_outcome(N2)
        assert env.rep.get_score(DAO, A2) == 8000
        assert env.rep.get_score(DAO2, A2) == 2000
        assert env.rep.get_network_score(A2) == 5000

    def test_scoring_refuses_a_release_outside_basis_point_range(self, env):
        """The adjudicator validates this, and so does the escrow. A third check costs
        nothing and this contract should not store a number it knows is impossible."""
        bad = full(N1)
        bad["release_bp"] = 10_001
        env.work.with_mandate(N1, state="SETTLED")
        env.adj.with_decision(N1, payload=bad, eligible=True)
        with pytest.raises(Exception, match="release_bp 10001 is out of range"):
            env.rep.record_outcome(N1)


# ── surface agreement ───────────────────────────────────────────────────────


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def _public_methods(tree: ast.Module, kind: str) -> dict[str, int]:
    found: dict[str, int] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if ast.unparse(decorator) == f"gl.public.{kind}":
                found[node.name] = len(node.args.args) - 1
    return found


def _handle_calls(tree: ast.Module) -> dict[str, set[str]]:
    """`{"work": {...}, "adjudicator": {...}}` — view calls per handle."""
    out: dict[str, set[str]] = {"work": set(), "adjudicator": set()}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        source = ast.unparse(node.func)
        if source.startswith("self._work().view()."):
            out["work"].add(node.func.attr)
        elif source.startswith("self._adjudicator().view()."):
            out["adjudicator"].add(node.func.attr)
    return out


class TestSurfaceAgreement:
    """What the fakes cannot prove.

    Every test above would keep passing if `wrk_adjudicator.is_settlement_eligible` were
    renamed. These read the siblings' source instead of their behaviour.
    """

    def test_every_work_view_called_exists_in_wrk_work(self):
        calls = _handle_calls(_parse(GENLAYER_ROOT / "wrk_reputation.py"))["work"]
        views = _public_methods(_parse(GENLAYER_ROOT / "wrk_work.py"), "view")
        assert calls, "no work view calls found — the extractor is broken, not the code"
        missing = sorted(name for name in calls if name not in views)
        assert not missing, f"calls wrk_work view(s) that do not exist: {missing}"

    def test_every_adjudicator_view_called_exists_in_wrk_adjudicator(self):
        calls = _handle_calls(_parse(GENLAYER_ROOT / "wrk_reputation.py"))["adjudicator"]
        views = _public_methods(_parse(GENLAYER_ROOT / "wrk_adjudicator.py"), "view")
        assert calls, "no adjudicator view calls found — the extractor is broken"
        missing = sorted(name for name in calls if name not in views)
        assert not missing, f"calls wrk_adjudicator view(s) that do not exist: {missing}"

    def test_the_fakes_match_the_calls_actually_made(self):
        calls = _handle_calls(_parse(GENLAYER_ROOT / "wrk_reputation.py"))
        assert calls["work"] == set(FakeWork.VIEW_SURFACE), (
            f"FakeWork {sorted(FakeWork.VIEW_SURFACE)} vs calls {sorted(calls['work'])}"
        )
        assert calls["adjudicator"] == set(FakeAdjudicator.VIEW_SURFACE), (
            f"FakeAdjudicator {sorted(FakeAdjudicator.VIEW_SURFACE)} vs calls "
            f"{sorted(calls['adjudicator'])}"
        )

    def test_arities_agree_between_the_fakes_and_the_real_contracts(self):
        work_views = _public_methods(_parse(GENLAYER_ROOT / "wrk_work.py"), "view")
        adj_views = _public_methods(_parse(GENLAYER_ROOT / "wrk_adjudicator.py"), "view")
        for name, arity in FakeWork.VIEW_SURFACE.items():
            assert work_views[name] == arity
        for name, arity in FakeAdjudicator.VIEW_SURFACE.items():
            assert adj_views[name] == arity

    def test_this_contract_reads_reputation_and_no_other_contract_does(self):
        """Invariant I9's structural half, asserted from the test side as well as by
        `verify-ic-discipline.py reputation`.

        The check is on the adjudicator's contract *handles*, not on whether the word
        "reputation" appears in its source — it appears there in prose, explaining why it
        must not be an input. A handle is what would make it reachable.
        """
        tree = _parse(GENLAYER_ROOT / "wrk_adjudicator.py")
        handles = [
            ast.unparse(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and ast.unparse(node.func) == "gl.get_contract_at"
        ]
        assert handles == ["gl.get_contract_at(Address(self.work))"], (
            f"the adjudicator opens handles to {handles}; a handle to wrk_reputation "
            f"would make reputation reachable as an adjudication input"
        )

    def test_there_is_exactly_one_write_method(self):
        """Reputation is an output of settlement and nothing else. One write, no setters,
        no adjustment method — an "admin correction" is how a score stops being derivable
        from the decisions on chain."""
        writes = _public_methods(_parse(GENLAYER_ROOT / "wrk_reputation.py"), "write")
        assert sorted(writes) == ["record_outcome"], writes
