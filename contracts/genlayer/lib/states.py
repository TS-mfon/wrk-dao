"""State machines (``docs/ARCHITECTURE.md`` §6).

Must agree exactly with ``packages/types/src/states.ts``. Both files are
transcribed from the architecture document; neither is generated from the other,
so a divergence is a real disagreement about the protocol and both verifiers will
catch it.

Where these tables go beyond the document
-----------------------------------------
§6 gives the linear spine and names the terminal states, but does not enumerate
which states may reach them. Those edges are a design decision, one rule per
machine:

* **Mission** — may be cancelled or expire at any point before it is mandated.
  After ``MANDATED`` the mandate machine owns the lifecycle.
* **Mandate** — before escrow is funded, exit is ``CANCELLED`` or ``EXPIRED``. Once
  funded, the only non-settling exit is ``REFUNDED``: escrowed USDC must be
  accounted for, and a terminal state with money still locked would be
  unrecoverable. ``ADJUDICATED`` reaches ``SETTLED`` (full or partial acceptance)
  or ``REFUNDED`` (rejection).
* **Settlement** — exactly as documented; §6 enumerates it fully.
"""

from __future__ import annotations

MISSION_STATES = (
    "DRAFT",
    "OPEN",
    "PROPOSALS_CLOSED",
    "SELECTING",
    "SELECTED",
    "MANDATED",
    "CANCELLED",
    "EXPIRED",
)

MISSION_TRANSITIONS = {
    "DRAFT": ("OPEN", "CANCELLED", "EXPIRED"),
    "OPEN": ("PROPOSALS_CLOSED", "CANCELLED", "EXPIRED"),
    "PROPOSALS_CLOSED": ("SELECTING", "CANCELLED", "EXPIRED"),
    "SELECTING": ("SELECTED", "CANCELLED", "EXPIRED"),
    "SELECTED": ("MANDATED", "CANCELLED", "EXPIRED"),
    "MANDATED": (),
    "CANCELLED": (),
    "EXPIRED": (),
}

MANDATE_STATES = (
    "CREATED",
    "ACCEPTED",
    "FUNDED",
    "IN_PROGRESS",
    "SUBMITTED",
    "ADJUDICATING",
    "ADJUDICATED",
    "SETTLED",
    "REFUNDED",
    "EXPIRED",
    "CANCELLED",
)

MANDATE_TRANSITIONS = {
    "CREATED": ("ACCEPTED", "CANCELLED", "EXPIRED"),
    "ACCEPTED": ("FUNDED", "CANCELLED", "EXPIRED"),
    "FUNDED": ("IN_PROGRESS", "REFUNDED"),
    "IN_PROGRESS": ("SUBMITTED", "REFUNDED"),
    "SUBMITTED": ("ADJUDICATING", "REFUNDED"),
    "ADJUDICATING": ("ADJUDICATED", "REFUNDED"),
    "ADJUDICATED": ("SETTLED", "REFUNDED"),
    "SETTLED": (),
    "REFUNDED": (),
    "EXPIRED": (),
    "CANCELLED": (),
}

SETTLEMENT_STATES = ("NONE", "POSTED", "CHALLENGED", "EXECUTED")

SETTLEMENT_TRANSITIONS = {
    # A challenge returns to NONE so the adapter can re-post correctly. It never
    # destroys the escrow balance: voiding a posting is cheap, wrongly releasing is
    # not (docs/ARCHITECTURE.md §3.3).
    "NONE": ("POSTED",),
    "POSTED": ("CHALLENGED", "EXECUTED"),
    "CHALLENGED": ("NONE",),
    "EXECUTED": (),
}


class StateError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class StateMachine:
    __slots__ = ("name", "states", "initial", "transitions", "terminal")

    def __init__(self, name: str, states: tuple[str, ...], initial: str, transitions: dict) -> None:
        self.name = name
        self.states = states
        self.initial = initial
        self.transitions = transitions
        self.terminal = tuple(state for state in states if not transitions[state])

    def assert_state(self, value: object, label: str = "state") -> str:
        if value not in self.states:
            raise StateError(
                "STATE_UNKNOWN", f"{self.name} has no state {value!r} ({label})"
            )
        return str(value)

    def can_transition(self, source: object, target: object) -> bool:
        start = self.assert_state(source, "from")
        end = self.assert_state(target, "to")
        return end in self.transitions[start]

    def assert_transition(self, source: object, target: object) -> None:
        if not self.can_transition(source, target):
            raise StateError(
                "STATE_ILLEGAL_TRANSITION",
                f"{self.name}: {source} -> {target} is not a legal transition",
            )

    def is_terminal(self, state: object) -> bool:
        return not self.transitions[self.assert_state(state)]


MISSION = StateMachine("mission", MISSION_STATES, "DRAFT", MISSION_TRANSITIONS)
MANDATE = StateMachine("mandate", MANDATE_STATES, "CREATED", MANDATE_TRANSITIONS)
SETTLEMENT = StateMachine("settlement", SETTLEMENT_STATES, "NONE", SETTLEMENT_TRANSITIONS)

MACHINES = (MISSION, MANDATE, SETTLEMENT)

#: Invariant I1 as data: the only route into SETTLED. The verifier checks this
#: against the table rather than against a second copy of the rule.
SETTLED_PREDECESSORS = tuple(
    state for state in MANDATE_STATES if "SETTLED" in MANDATE_TRANSITIONS[state]
)


def can_edit_mission(state: object, proposal_count: object) -> bool:
    """Mission editability (SPEC §102).

    A mission may be edited — incrementing its version — only while it is ``DRAFT``
    or ``OPEN`` **and** has zero proposals. The first proposal freezes it, because a
    worker's proposal is an answer to a specific set of acceptance criteria.
    """
    current = MISSION.assert_state(state)
    if isinstance(proposal_count, bool) or not isinstance(proposal_count, int) or proposal_count < 0:
        raise StateError(
            "STATE_UNKNOWN", f"proposal_count must be a non-negative integer, got {proposal_count!r}"
        )
    return current in ("DRAFT", "OPEN") and proposal_count == 0
