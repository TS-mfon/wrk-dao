# {
#   "Seq": [
#     { "Depends": "py-genlayer-multi:06zyvrlivjga0d5jlpdbprksc0pa6jmllxvp8s20hq1l512vh5yk" },
#     { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
#   ]
# }
#
# Two runners in a Seq, both pinned to concrete hashes. See wrk_registry.py's header.
"""wrk_reputation — DAO-scoped reputation, written only after final settlement.

Contract C22. SPEC §487 (DAO reputation), §491 (network reputation).

Why this is a separate contract
-------------------------------
Invariant I9: **reputation is never an adjudication input.** A worker's past must not bias
the judgment of their present work — that is how a well-regarded agent gets paid for work
it did not do, and how a new agent can never break in.

Keeping reputation in its own contract makes that boundary structural instead of a
convention someone has to remember. `wrk_adjudicator` holds no handle to this contract and
has no way to obtain one, and `scripts/verify-ic-discipline.py reputation` fails the build
if any other contract so much as reads a field named like a score.

The boundary runs the other way too, and it is the point of this file: reputation here is
an **output** of settlement, never an input to anything. Nothing in this contract moves
value, and reputation cannot be written before the money is final. Reputation that can be
written before settlement is a way of paying in standing before the work has been judged;
reputation that can be written twice is the same thing with extra steps.

What a score is
---------------
Deliberately boring arithmetic: `score = total_release_bp // settled_mandates`, the mean
basis points released to that agent across the mandates it has completed in that DAO. No
decay, no weighting, no magic constants — a number anyone can recompute from the decisions
on chain. A rejection contributes 0 and therefore lowers the mean, which is the whole
behavioural requirement.

An agent with no history has **no score**, not a zero one. `has_record` is how a reader
tells "new" from "has been rejected", and conflating them would be a quiet penalty on
every newcomer.
"""

from genlayer import *

from lib.ids import id_pattern
from lib.money import BP_DENOMINATOR

import json
import re
from datetime import datetime, timezone

ERROR_EXPECTED = "[EXPECTED]"

EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")

#: The only mandate states in which money is final. Anything earlier is still in flight.
FINAL_MANDATE_STATES = ("SETTLED", "REFUNDED")


# ── events (docs/ARCHITECTURE.md §9) ────────────────────────────────────────
#
# One event per recorded outcome per agent, carrying the inputs the score is computed
# from. The indexer therefore never has to re-derive a score from a running total it might
# have missed -- it can recompute `total_release_bp // settled_mandates` from the events
# alone, which is the same arithmetic this contract does.
#
# NOTE ON INDEXED FIELD ORDER: the SDK sorts indexed field names alphabetically and binds
# positional arguments to that SORTED order, not to declaration order
# (`indexed_args = tuple(sorted(...))` then `zip(indexed_args, args)`). So an event
# declared `(dao_id, agent_id, /)` and called with `(dao_id, agent_id)` silently files the
# dao id under `agent_id`. Every multi-indexed event below is therefore declared in
# alphabetical order, and `test_cross_contract_events_declare_indexed_fields_in_sorted_order`
# fails the build if a future one is not.


class ReputationRecorded(gl.Event):
    def __init__(self, agent_id: str, dao_id: str, /, **blob): ...



def _reject(message: str):
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {message}")


def _now() -> int:
    """Transaction time in Unix seconds — deterministic across re-execution."""
    return int(datetime.now(timezone.utc).timestamp())


class WrkReputation(gl.Contract):
    # ── wiring ──────────────────────────────────────────────────────────────
    work: str
    adjudicator: str
    deployer: str

    # ── per-DAO record, keyed "dao_id|agent_id" ─────────────────────────────
    # Flat composite keys rather than nested generics: every read asks about one
    # (dao, agent) pair, which a flat map answers in one lookup, and the composite key is
    # what makes the DAO scoping structural — there is no way to ask for an agent's score
    # without naming a DAO.
    scoped_known: TreeMap[str, bool]
    scoped_settled: TreeMap[str, u256]
    scoped_release_total: TreeMap[str, u256]
    scoped_full: TreeMap[str, u256]
    scoped_partial: TreeMap[str, u256]
    scoped_rejected: TreeMap[str, u256]
    scoped_last_at: TreeMap[str, u256]

    # ── network aggregate, keyed by agent_id (SPEC §491) ────────────────────
    network_known: TreeMap[str, bool]
    network_settled: TreeMap[str, u256]
    network_release_total: TreeMap[str, u256]
    network_rejected: TreeMap[str, u256]
    network_daos: TreeMap[str, str]

    # ── rosters and idempotence ─────────────────────────────────────────────
    dao_agents: TreeMap[str, str]
    #: mandate_id -> True once its outcome has been recorded. This single flag is
    #: invariant G4: one settled mandate produces one reputation event, ever.
    recorded: TreeMap[str, bool]
    recorded_dao: TreeMap[str, str]
    recorded_verdict: TreeMap[str, str]
    recorded_release_bp: TreeMap[str, u256]
    recorded_ids: DynArray[str]

    def __init__(self, work: str, adjudicator: str) -> None:
        """Wire the work and adjudicator contracts. Fixed at construction, no setters.

        A rotatable adjudicator address would let whoever can rotate it supply a substitute
        that reports any mandate as finalized with any verdict — which is every check in
        `record_outcome` defeated at once.
        """
        for label, value in (("work", work), ("adjudicator", adjudicator)):
            if not EVM_ADDRESS.match(value):
                _reject(f"{label} must be a 0x-prefixed 20-byte address, got {value!r}")
        self.work = work.lower()
        self.adjudicator = adjudicator.lower()
        self.deployer = gl.message.sender_address.as_hex.lower()

    # ── internal ────────────────────────────────────────────────────────────

    def _work(self):
        return gl.get_contract_at(Address(self.work))

    def _adjudicator(self):
        return gl.get_contract_at(Address(self.adjudicator))

    def _key(self, dao_id: str, agent_id: str) -> str:
        return f"{dao_id}|{agent_id}"

    def _count(self, table: TreeMap[str, u256], key: str) -> int:
        return int(table[key]) if key in table else 0

    def _bump(self, table: TreeMap[str, u256], key: str, amount: int) -> None:
        table[key] = u256(self._count(table, key) + amount)

    def _append_unique(self, index: TreeMap[str, str], key: str, value: str) -> None:
        bucket = json.loads(index[key]) if key in index else []
        if value not in bucket:
            bucket.append(value)
            index[key] = json.dumps(bucket)

    def _mean_release(self, settled: int, total_release: int) -> int:
        """The score. Integer division, so it is reproducible by anyone with the decisions.

        Truncating rather than rounding is a choice in the conservative direction: a score
        is never rounded up into looking better than the released basis points support.
        """
        if settled == 0:
            return 0
        return total_release // settled

    # ── the one write ───────────────────────────────────────────────────────

    @gl.public.write
    def record_outcome(self, mandate_id: str) -> int:
        """Record a finally-settled mandate's outcome against its workers' reputation.

        Permissionless, and that is safe precisely because nothing here is a matter of
        judgment: every input is read from `wrk_work` and `wrk_adjudicator`, and the caller
        supplies only the mandate id. Gating it on an identity would create a party who
        could withhold a worker's earned standing.

        Returns the number of agents whose record was updated.
        """
        if not re.match(id_pattern("mnd"), mandate_id):
            _reject(f"{mandate_id} is not an mnd_ prefixed ULID")
        if mandate_id in self.recorded and self.recorded[mandate_id]:
            # Invariant G4. Replaying one outcome is how reputation gets inflated without
            # any new work being done.
            _reject(f"mandate {mandate_id} has already been recorded")

        state = self._work().view().get_mandate_state(mandate_id)
        if state not in FINAL_MANDATE_STATES:
            _reject(
                f"mandate {mandate_id} is {state}: reputation is written only after final "
                f"settlement, not before"
            )

        # Finality, not merely adjudication. `get_settlement_payload` is the adjudicator's
        # gated read and refuses until finality has been confirmed there, so this call is
        # what ties invariant I9's "after final settlement" to something enforced rather
        # than assumed.
        if not self._adjudicator().view().is_settlement_eligible(mandate_id):
            _reject(
                f"mandate {mandate_id} has no finalized decision: a refund that was never "
                f"adjudicated is not a judgment and earns no reputation event"
            )
        decision = json.loads(self._adjudicator().view().get_settlement_payload(mandate_id))

        if decision["mandate_id"] != mandate_id:
            _reject(
                f"the adjudicator returned a decision for mandate {decision['mandate_id']}, "
                f"not {mandate_id}"
            )

        verdict = decision["verdict"]
        release_bp = int(decision["release_bp"])
        if release_bp < 0 or release_bp > BP_DENOMINATOR:
            _reject(f"decision release_bp {release_bp} is out of range")

        mandate = json.loads(self._work().view().get_mandate(mandate_id))
        dao_id = mandate["dao_id"]
        # Identity comes from the mandate's workers, not from the decision's allocations: a
        # REJECTION has no allocations, and the agents who did the work are exactly the ones
        # whose standing the outcome should reflect.
        agent_ids = [worker["agent_id"] for worker in mandate["workers"]]
        if not agent_ids:
            _reject(f"mandate {mandate_id} names no workers")

        now = _now()
        for agent_id in agent_ids:
            key = self._key(dao_id, agent_id)
            self.scoped_known[key] = True
            self._bump(self.scoped_settled, key, 1)
            self._bump(self.scoped_release_total, key, release_bp)
            self.scoped_last_at[key] = u256(now)
            if verdict == "FULL_ACCEPTANCE":
                self._bump(self.scoped_full, key, 1)
            elif verdict == "PARTIAL_ACCEPTANCE":
                self._bump(self.scoped_partial, key, 1)
            else:
                self._bump(self.scoped_rejected, key, 1)

            self.network_known[agent_id] = True
            self._bump(self.network_settled, agent_id, 1)
            self._bump(self.network_release_total, agent_id, release_bp)
            if verdict == "REJECTION":
                self._bump(self.network_rejected, agent_id, 1)
            self._append_unique(self.network_daos, agent_id, dao_id)
            self._append_unique(self.dao_agents, dao_id, agent_id)

            scoped_settled = self._count(self.scoped_settled, key)
            scoped_total = self._count(self.scoped_release_total, key)
            ReputationRecorded(
                agent_id,
                dao_id,
                mandate_id=mandate_id,
                verdict=verdict,
                release_bp=u256(release_bp),
                settled_mandates=u256(scoped_settled),
                total_release_bp=u256(scoped_total),
                score_bp=u256(self._mean_release(scoped_settled, scoped_total)),
                recorded_at=u256(now),
            ).emit()

        self.recorded[mandate_id] = True
        self.recorded_dao[mandate_id] = dao_id
        self.recorded_verdict[mandate_id] = verdict
        self.recorded_release_bp[mandate_id] = u256(release_bp)
        self.recorded_ids.append(mandate_id)
        return len(agent_ids)

    # ── reads: DAO-scoped ───────────────────────────────────────────────────

    @gl.public.view
    def has_record(self, dao_id: str, agent_id: str) -> bool:
        """Whether this agent has any settled history in this DAO.

        The distinction a score alone cannot carry: an agent with no history and an agent
        whose every mandate was rejected both score 0, and treating them the same is a
        quiet penalty on every newcomer.
        """
        key = self._key(dao_id, agent_id)
        return key in self.scoped_known and self.scoped_known[key]

    @gl.public.view
    def get_score(self, dao_id: str, agent_id: str) -> int:
        """Mean basis points released to this agent in this DAO, or 0 with no history.

        Read `has_record` alongside this: 0 means "nothing released" and says nothing on
        its own about whether anything was ever attempted.
        """
        key = self._key(dao_id, agent_id)
        return self._mean_release(
            self._count(self.scoped_settled, key), self._count(self.scoped_release_total, key)
        )

    @gl.public.view
    def get_reputation(self, dao_id: str, agent_id: str) -> str:
        """The full DAO-scoped record as JSON, so a reader can recompute the score."""
        key = self._key(dao_id, agent_id)
        settled = self._count(self.scoped_settled, key)
        total = self._count(self.scoped_release_total, key)
        return json.dumps(
            {
                "schema_version": 1,
                "dao_id": dao_id,
                "agent_id": agent_id,
                "has_record": self.has_record(dao_id, agent_id),
                "settled_mandates": settled,
                "total_release_bp": total,
                "full_acceptances": self._count(self.scoped_full, key),
                "partial_acceptances": self._count(self.scoped_partial, key),
                "rejections": self._count(self.scoped_rejected, key),
                "score_bp": self._mean_release(settled, total),
                "last_recorded_at_unix": self._count(self.scoped_last_at, key),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    @gl.public.view
    def list_dao_agents(self, dao_id: str) -> list[str]:
        if dao_id not in self.dao_agents:
            return []
        return json.loads(self.dao_agents[dao_id])

    # ── reads: network aggregate (SPEC §491) ────────────────────────────────

    @gl.public.view
    def get_network_score(self, agent_id: str) -> int:
        """An agent's mean released basis points across every DAO.

        Informational only. It is **not** an adjudication input — invariant I9 — and the
        adjudicator has no handle to this contract through which it could become one.
        """
        return self._mean_release(
            self._count(self.network_settled, agent_id),
            self._count(self.network_release_total, agent_id),
        )

    @gl.public.view
    def get_network_reputation(self, agent_id: str) -> str:
        settled = self._count(self.network_settled, agent_id)
        total = self._count(self.network_release_total, agent_id)
        daos = json.loads(self.network_daos[agent_id]) if agent_id in self.network_daos else []
        return json.dumps(
            {
                "schema_version": 1,
                "agent_id": agent_id,
                "has_record": agent_id in self.network_known and self.network_known[agent_id],
                "settled_mandates": settled,
                "total_release_bp": total,
                "rejections": self._count(self.network_rejected, agent_id),
                "score_bp": self._mean_release(settled, total),
                "dao_ids": sorted(daos),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    @gl.public.view
    def list_agent_daos(self, agent_id: str) -> list[str]:
        if agent_id not in self.network_daos:
            return []
        return sorted(json.loads(self.network_daos[agent_id]))

    # ── reads: the recorded ledger ──────────────────────────────────────────

    @gl.public.view
    def is_recorded(self, mandate_id: str) -> bool:
        return mandate_id in self.recorded and self.recorded[mandate_id]

    @gl.public.view
    def get_recorded_outcome(self, mandate_id: str) -> str:
        """What was recorded for one mandate, so a score can be traced to its sources."""
        if not self.is_recorded(mandate_id):
            _reject(f"mandate {mandate_id} has not been recorded")
        return json.dumps(
            {
                "schema_version": 1,
                "mandate_id": mandate_id,
                "dao_id": self.recorded_dao[mandate_id],
                "verdict": self.recorded_verdict[mandate_id],
                "release_bp": int(self.recorded_release_bp[mandate_id]),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    @gl.public.view
    def recorded_count(self) -> int:
        return len(self.recorded_ids)

    @gl.public.view
    def list_recorded(self) -> list[str]:
        return list(self.recorded_ids)

    @gl.public.view
    def wiring(self) -> list[str]:
        """The addresses this contract trusts: work, adjudicator, deployer."""
        return [self.work, self.adjudicator, self.deployer]
