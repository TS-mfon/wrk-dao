"""wrk_work — missions, proposals, mandates, deliverables, evidence.

Test names carry the `-k` selectors leaf-1.2.2's gates filter on: mission_creation,
mission_discovery, proposal, mandate, deliverable, evidence, versioning,
immutable_after_acceptance, transitions_exhaustive.

Two harness facts shape this file
---------------------------------
**1. Direct mode loads exactly one contract class per test.** Deploying `wrk_registry.py`
and `wrk_work.py` in the same test fails inside the GenVM SDK with::

    ImportError: Failed to load contract: only one contract is allowed;
                 first: <class '_contract_wrk_registry.WrkRegistry'>
                 second: <class '_contract_wrk_work.WrkWork'>

Separate tests each loading a different class are fine — the restriction is per test, not
per session. So a real registry cannot stand behind `wrk_work` here, and since every write
in `wrk_work` consults the registry for authorization, without a substitute *no* write
would be testable in direct mode at all.

`gl.get_contract_at` is therefore replaced with `FakeRegistry` for the duration of a test.
That is a harness substitution, not a contract backdoor: `wrk_work` has no mode in which it
trusts the caller instead of the registry, and nothing in the contract knows this happened.

**2. A fake proves logic, not interface agreement.** A fake that answers
`get_agent_operator` proves `wrk_work` uses the answer correctly and proves nothing about
whether `wrk_registry` has a method by that name. `TestRegistrySurfaceAgreement` closes
exactly that gap by parsing both contracts: every registry method `wrk_work` calls must
exist in `wrk_registry.py` as a `@gl.public.view` with matching arity, and the fake must
implement precisely that set — no more, no less. A renamed registry view breaks the AST
check even though every faked test still passes.

The clock is patched the same way, for the same reason Foundry has `vm.warp`: deadline
logic is only testable deterministically if time is an input.
"""

import ast
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

GENLAYER_ROOT = Path(__file__).resolve().parents[2]

#: Fixed transaction time for every test unless a test warps it. Comfortably inside
#: lib.validation's MIN/MAX_UNIX_SECONDS window and well before DEADLINE.
NOW = 1_800_000_000
#: A deadline in the future relative to NOW.
DEADLINE = 1_900_000_000

DECISION_HASH = "0x" + "cd" * 32
SELECTION_HASH = "0x" + "ef" * 32
FUNDING_TX = "0x" + "1a" * 32
SETTLEMENT_TX = "0x" + "2b" * 32

#: The registry address wrk_work is constructed with. Its only job here is to be a
#: well-formed address: `gl.get_contract_at` is patched, so nothing is deployed at it.
REGISTRY = "0x" + "d0" * 20
ADJUDICATOR = "0x" + "a0" * 20
OBSERVER = "0x" + "b0" * 20
STRANGER = "0x" + "c0" * 20


def ulid(prefix: str, tag: str) -> str:
    """A syntactically valid Crockford-base32 ULID with a readable tail.

    Tags must avoid I, L, O and U, which Crockford excludes — the same defect that was
    found in the frozen fixtures and is asserted as a refusal in test_registry.py.
    """
    body = ("01JQ8Z" + "0" * 20)[: 26 - len(tag)] + tag
    assert len(body) == 26, body
    assert not (set(body) & set("ILOU")), body
    return f"{prefix}_{body}"


DAO = ulid("dao", "D1")
DAO2 = ulid("dao", "D2")
A1 = ulid("agt", "A1")
A2 = ulid("agt", "A2")
A3 = ulid("agt", "A3")
OP1 = "0x" + "11" * 20
OP2 = "0x" + "22" * 20
OP3 = "0x" + "33" * 20


def as_bytes(value) -> bytes:
    """Normalise a harness address to raw bytes.

    `direct_alice/bob/charlie` return raw bytes while the GenVM SDK is unimportable and an
    `Address` once it is, and `sys.modules` persists across tests — so the type depends on
    whether an earlier test deployed. `vm.sender` must be bytes either way.
    """
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    raw = getattr(value, "as_bytes", None)
    if raw is not None:
        return bytes(raw() if callable(raw) else raw)
    hex_form = getattr(value, "as_hex", None)
    if hex_form is not None:
        text = hex_form() if callable(hex_form) else hex_form
        return bytes.fromhex(text[2:])
    raise TypeError(f"cannot normalise address of type {type(value).__name__}")


def iso(unix_seconds: int) -> str:
    """Unix seconds as the ISO string `VMContext.warp` expects."""
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hexaddr(value: str) -> bytes:
    return bytes.fromhex(value[2:])


# ── payload builders ────────────────────────────────────────────────────────


def criteria(n=2):
    """`n` acceptance criteria whose weights sum to exactly 10000."""
    base = 10_000 // n
    out = []
    for index in range(n):
        weight = base if index < n - 1 else 10_000 - base * (n - 1)
        out.append(
            {
                "id": f"criterion_{index}",
                "statement": f"The work satisfies requirement {index}.",
                "weight_bp": weight,
            }
        )
    return out


def budget(amount="1000000"):
    return {"asset": "USDC", "chain_id": 84532, "amount_atomic": amount, "decimals": 6}


def mission_payload(
    mission_id,
    dao_id=DAO,
    creator=A1,
    amount="1000000",
    deadline=DEADLINE,
    allow_teams=False,
    max_team_size=1,
    n_criteria=2,
    title="Ship the settlement adapter",
):
    return {
        "schema_version": 1,
        "mission_id": mission_id,
        "dao_id": dao_id,
        "creator_agent_id": creator,
        "title": title,
        "outcome_statement": "A settlement adapter that posts decisions to Base.",
        "acceptance_criteria": criteria(n_criteria),
        "budget": budget(amount),
        "deadline_unix": deadline,
        "evidence_requirements": ["source_repository", "test_output"],
        "allow_teams": allow_teams,
        "max_team_size": max_team_size,
    }


def mission(mission_id, **kwargs):
    return json.dumps(mission_payload(mission_id, **kwargs))


def proposal_payload(
    proposal_id,
    mission_id,
    agent_id=A2,
    dao_id=DAO,
    amount="1000000",
    team=(),
):
    return {
        "schema_version": 1,
        "proposal_id": proposal_id,
        "mission_id": mission_id,
        "dao_id": dao_id,
        "agent_id": agent_id,
        "capabilities": ["coding"],
        "proposed_strategy": "Write the adapter, prove it against the frozen vectors.",
        "execution_plan": ["Write the adapter.", "Prove it against the vectors."],
        "deliverables": ["The adapter source.", "A passing test run."],
        "evidence_plan": ["Link the repository.", "Attach the test output."],
        "estimated_duration_seconds": 86_400,
        "requested_budget": budget(amount),
        "team_members": [{"agent_id": a, "share_bp": s} for a, s in team],
        "submitted_at_unix": NOW,
    }


def proposal(proposal_id, mission_id, **kwargs):
    return json.dumps(proposal_payload(proposal_id, mission_id, **kwargs))


def mandate_payload(
    mandate_id,
    mission_id,
    proposal_hash,
    workers=((A2, 10_000),),
    creator=A1,
    dao_id=DAO,
    amount="1000000",
    deadline=DEADLINE,
    selection_hash=SELECTION_HASH,
    n_criteria=2,
    n_deliverables=2,
):
    return {
        "schema_version": 1,
        "mandate_id": mandate_id,
        "dao_id": dao_id,
        "mission_id": mission_id,
        "creator_agent_id": creator,
        "workers": [{"agent_id": a, "share_bp": s} for a, s in workers],
        "objective": "Deliver the settlement adapter.",
        "deliverables": [f"Deliverable {i}." for i in range(n_deliverables)],
        "budget": budget(amount),
        "deadline_unix": deadline,
        "acceptance_criteria": criteria(n_criteria),
        "evidence_requirements": ["source_repository", "test_output"],
        "proposal_hash": proposal_hash,
        "selection_decision_hash": selection_hash,
        "created_at_unix": NOW,
    }


def mandate(mandate_id, mission_id, proposal_hash, **kwargs):
    return json.dumps(mandate_payload(mandate_id, mission_id, proposal_hash, **kwargs))


def evidence_item(mandate_id, worker=A2, tag="E1", uri="https://example.com/repo", digest="ab"):
    return {
        "evidence_id": ulid("evd", tag),
        "mandate_id": mandate_id,
        "worker_agent_id": worker,
        "type": "source_repository",
        "uri": uri,
        "content_hash": "0x" + digest * 32,
        "mime_type": "text/plain",
        "description": "The adapter source at the submitted commit.",
        "created_at_unix": NOW,
    }


def deliverable_payload(
    deliverable_id,
    mandate_id,
    worker=A2,
    indices=(0,),
    evidence=None,
):
    return {
        "schema_version": 1,
        "deliverable_id": deliverable_id,
        "mandate_id": mandate_id,
        "worker_agent_id": worker,
        "title": "Settlement adapter",
        "summary": "The adapter, with the vector suite passing.",
        "satisfies_indices": list(indices),
        "evidence": evidence if evidence is not None else [evidence_item(mandate_id, worker)],
        "submitted_at_unix": NOW,
    }


def deliverable(deliverable_id, mandate_id, **kwargs):
    return json.dumps(deliverable_payload(deliverable_id, mandate_id, **kwargs))


def dao_rules(dao_id=DAO, version=1, max_budget="1000000000", min_criteria=1, membership="open"):
    return json.dumps(
        {
            "schema_version": 1,
            "dao_id": dao_id,
            "version": version,
            "membership": membership,
            "required_capabilities": [],
            "max_mission_budget_atomic": max_budget,
            "min_acceptance_criteria": min_criteria,
        }
    )


# ── the fake registry ───────────────────────────────────────────────────────


class FakeRegistry:
    """A faithful minimum of wrk_registry, driven by explicit test setup.

    Faithful matters more than convenient. A fake that answered "yes" to everything would
    leave every authorization and membership guard in `wrk_work` unexercised while all the
    tests still passed, so each method here mirrors the real contract's behaviour including
    its refusals: an unknown agent raises rather than returning "", exactly as
    `wrk_registry.get_agent_operator` does.

    `TestRegistrySurfaceAgreement` pins the method set against `wrk_registry.py` itself.
    """

    #: The registry views wrk_work is allowed to depend on. Asserted against both
    #: contracts' source by TestRegistrySurfaceAgreement.
    SURFACE = {
        "get_agent_operator": 1,
        "is_member": 2,
        "agent_of_address": 1,
        "get_dao_rules": 1,
        "get_dao_rules_version": 1,
    }

    def __init__(self):
        self.operators: dict[str, str] = {}
        self.members: set[tuple[str, str]] = set()
        self.rules: dict[str, str] = {}
        self.versions: dict[str, int] = {}
        self.calls: list[tuple] = []

    # -- test-side setup ----------------------------------------------------

    def add_agent(self, agent_id: str, operator: str) -> "FakeRegistry":
        self.operators[agent_id] = operator.lower()
        return self

    def add_member(self, dao_id: str, agent_id: str) -> "FakeRegistry":
        self.members.add((dao_id, agent_id))
        return self

    def set_rules(self, dao_id: str, rules_json: str, version: int = 1) -> "FakeRegistry":
        self.rules[dao_id] = rules_json
        self.versions[dao_id] = version
        return self

    # -- the surface wrk_work calls -----------------------------------------

    def view(self):
        return self

    def get_agent_operator(self, agent_id: str) -> str:
        self.calls.append(("get_agent_operator", agent_id))
        if agent_id not in self.operators:
            self._reject(f"unknown agent {agent_id}")
        return self.operators[agent_id]

    def is_member(self, dao_id: str, agent_id: str) -> bool:
        self.calls.append(("is_member", dao_id, agent_id))
        return (dao_id, agent_id) in self.members

    def agent_of_address(self, address: str) -> str:
        self.calls.append(("agent_of_address", address))
        wanted = address.lower()
        for agent_id, operator in self.operators.items():
            if operator == wanted:
                return agent_id
        return ""

    def get_dao_rules(self, dao_id: str) -> str:
        self.calls.append(("get_dao_rules", dao_id))
        if dao_id not in self.rules:
            self._reject(f"unknown dao {dao_id}")
        return self.rules[dao_id]

    def get_dao_rules_version(self, dao_id: str) -> int:
        self.calls.append(("get_dao_rules_version", dao_id))
        if dao_id not in self.versions:
            self._reject(f"unknown dao {dao_id}")
        return self.versions[dao_id]

    def _reject(self, message: str):
        import genlayer

        raise genlayer.gl.vm.UserError(f"[EXPECTED] {message}")


class Env:
    """A deployed wrk_work with a fake registry, a patched clock, and a sender."""

    def __init__(self, work, reg, vm):
        self.work = work
        self.reg = reg
        self.vm = vm

    def act_as(self, address: str) -> "Env":
        self.vm.sender = hexaddr(address)
        return self

    def warp(self, when: int) -> "Env":
        """Move the harness clock.

        `VMContext.warp` rather than a patched `_now`: warping makes the contract's own
        `datetime.now(timezone.utc)` line execute against a controlled time, where
        replacing `_now` would mean that line never ran in any test at all.
        """
        self.vm.warp(iso(when))
        return self

    @property
    def now(self) -> int:
        return NOW


@pytest.fixture
def env(deploy, direct_vm, monkeypatch):
    """wrk_work wired to a fake registry that already knows A1, A2, A3 and one DAO.

    A1 is the mission creator, A2 and A3 are workers, all three are members of DAO. A test
    that needs a different population mutates `env.reg` directly.
    """
    direct_vm.sender = hexaddr(OP1)
    work = deploy("wrk_work.py", REGISTRY, ADJUDICATOR, OBSERVER)
    return _wire(work, direct_vm, monkeypatch)


@pytest.fixture
def bare(deploy, direct_vm, monkeypatch):
    """wrk_work wired to an EMPTY fake registry — nothing is registered, nobody is a member.

    The positive control for the membership and ownership guards: with this fixture every
    write must be refused, which is what proves the populated `env` fixture is not simply
    being waved through.
    """
    direct_vm.sender = hexaddr(OP1)
    work = deploy("wrk_work.py", REGISTRY, ADJUDICATOR, OBSERVER)
    return _wire(work, direct_vm, monkeypatch, populate=False)


def _wire(work, vm, monkeypatch, populate=True):
    import genlayer

    reg = FakeRegistry()
    if populate:
        reg.add_agent(A1, OP1).add_agent(A2, OP2).add_agent(A3, OP3)
        reg.add_member(DAO, A1).add_member(DAO, A2).add_member(DAO, A3)
        reg.set_rules(DAO, dao_rules(), version=1)

    monkeypatch.setattr(genlayer.gl, "get_contract_at", lambda _address: reg, raising=False)

    vm.warp(iso(NOW))
    vm.sender = hexaddr(OP1)
    return Env(work, reg, vm)


# ── deploy-time wiring ──────────────────────────────────────────────────────


@pytest.fixture
def deploy_work(deploy):
    return deploy


class TestWiring:
    def test_wiring_is_readable_and_lowercased(self, env):
        registry, adjudicator, observer, deployer = env.work.wiring()
        assert registry == REGISTRY.lower()
        assert adjudicator == ADJUDICATOR.lower()
        assert observer == OBSERVER.lower()
        assert deployer == OP1.lower()

    def test_a_malformed_wiring_address_is_refused_at_construction(self, deploy_work):
        """There is no setter for these addresses, so construction is the only chance to
        refuse one. A registry address that is not an address would make every
        authorization check in the contract fail closed at best and unpredictably at worst.
        """
        with pytest.raises(Exception, match="must be a 0x-prefixed 20-byte address"):
            deploy_work("wrk_work.py", "not-an-address", ADJUDICATOR, OBSERVER)


# ── registry surface agreement ──────────────────────────────────────────────


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def _public_views(tree: ast.Module) -> dict[str, int]:
    """`{method_name: positional_arg_count_excluding_self}` for every @gl.public.view."""
    found: dict[str, int] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if ast.unparse(decorator) == "gl.public.view":
                found[node.name] = len(node.args.args) - 1
    return found


def _registry_calls(tree: ast.Module) -> set[str]:
    """Every method name invoked as `self._registry().view().<name>(...)`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        source = ast.unparse(node.func)
        if source.startswith("self._registry().view()."):
            names.add(node.func.attr)
    return names


class TestRegistrySurfaceAgreement:
    """Closes the gap a fake registry opens.

    Every test above runs against `FakeRegistry`, which would keep passing if
    `wrk_registry.get_agent_operator` were renamed tomorrow. These checks read both
    contracts' source instead of their behaviour, so a rename breaks here.
    """

    def test_every_registry_method_wrk_work_calls_exists_as_a_public_view(self):
        calls = _registry_calls(_parse(GENLAYER_ROOT / "wrk_work.py"))
        views = _public_views(_parse(GENLAYER_ROOT / "wrk_registry.py"))
        assert calls, "no cross-contract calls found — the extractor is broken, not the code"
        missing = sorted(name for name in calls if name not in views)
        assert not missing, f"wrk_work calls registry method(s) that do not exist: {missing}"

    def test_the_fake_implements_exactly_the_surface_wrk_work_depends_on(self):
        """No more, no less.

        Fewer, and a call would hit a missing attribute mid-test. More, and the fake has
        drifted into inventing a registry that does not exist.
        """
        calls = _registry_calls(_parse(GENLAYER_ROOT / "wrk_work.py"))
        assert calls == set(FakeRegistry.SURFACE), (
            f"fake surface {sorted(FakeRegistry.SURFACE)} does not match the calls "
            f"wrk_work actually makes {sorted(calls)}"
        )
        for name in FakeRegistry.SURFACE:
            assert callable(getattr(FakeRegistry, name, None)), f"fake is missing {name}"

    def test_arities_agree_between_the_fake_and_the_real_registry(self):
        views = _public_views(_parse(GENLAYER_ROOT / "wrk_registry.py"))
        for name, arity in FakeRegistry.SURFACE.items():
            assert views[name] == arity, (
                f"wrk_registry.{name} takes {views[name]} argument(s), the fake assumes {arity}"
            )

    def test_the_extractor_detects_a_call_to_a_nonexistent_method(self):
        """Positive control. An absence check that has never fired proves nothing."""
        tree = ast.parse(
            "class C:\n"
            "    def f(self):\n"
            "        return self._registry().view().no_such_method('x')\n"
        )
        assert _registry_calls(tree) == {"no_such_method"}
        views = _public_views(_parse(GENLAYER_ROOT / "wrk_registry.py"))
        assert "no_such_method" not in views


# ── missions (G2) ───────────────────────────────────────────────────────────

M1 = ulid("msn", "M1")
M2 = ulid("msn", "M2")
M3 = ulid("msn", "M3")
M4 = ulid("msn", "M4")
P1 = ulid("prp", "P1")
P2 = ulid("prp", "P2")
P3 = ulid("prp", "P3")
N1 = ulid("mnd", "N1")
N2 = ulid("mnd", "N2")
V1 = ulid("dlv", "V1")
V2 = ulid("dlv", "V2")


class TestMissionCreation:
    def test_mission_creation_stores_payload_state_and_hash(self, env):
        digest = env.work.create_mission(M1, DAO, A1, mission(M1))
        assert digest.startswith("0x") and len(digest) == 66
        assert env.work.get_mission_state(M1) == "DRAFT"
        assert env.work.get_mission_hash(M1) == digest
        assert env.work.get_mission_version(M1) == 1
        assert env.work.get_mission_proposal_count(M1) == 0
        assert env.work.get_mission_dao(M1) == DAO
        assert env.work.mission_count() == 1
        stored = json.loads(env.work.get_mission(M1))
        assert stored["mission_id"] == M1
        assert stored["title"] == "Ship the settlement adapter"

    def test_mission_creation_stores_the_payload_canonically_not_as_sent(self, env):
        """Key order must not survive: two callers sending the same object differently
        would otherwise produce two stored strings and two hashes for one mission."""
        payload = mission_payload(M1)
        scrambled = json.dumps({k: payload[k] for k in reversed(list(payload))})
        env.work.create_mission(M1, DAO, A1, scrambled)
        stored = env.work.get_mission(M1)
        assert stored == json.dumps(json.loads(stored), sort_keys=True, separators=(",", ":"))

    def test_mission_creation_records_the_dao_rules_version_in_force(self, env):
        """So a later rules change is visible as a change rather than silently
        reinterpreting an existing mission (invariant I8's upstream half)."""
        env.reg.set_rules(DAO, dao_rules(version=7), version=7)
        env.work.create_mission(M1, DAO, A1, mission(M1))
        assert env.work.get_mission_rules_version(M1) == 7

    def test_mission_creation_opens_and_becomes_discoverable(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        assert env.work.list_open_missions() == []
        assert env.work.open_mission(M1) == "OPEN"
        assert env.work.get_mission_state(M1) == "OPEN"
        assert env.work.list_open_missions() == [M1]
        assert env.work.list_dao_missions(DAO) == [M1]

    def test_mission_creation_requires_a_valid_ulid(self, env):
        with pytest.raises(Exception, match="msn_ prefixed ULID"):
            env.work.create_mission("msn_nope", DAO, A1, mission("msn_nope"))

    def test_mission_creation_refuses_a_duplicate_id(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        with pytest.raises(Exception, match="already exists"):
            env.work.create_mission(M1, DAO, A1, mission(M1))

    def test_mission_creation_refuses_a_caller_who_is_not_the_agents_operator(self, env):
        env.act_as(OP2)
        with pytest.raises(Exception, match="only agent .* own operator may act for it"):
            env.work.create_mission(M1, DAO, A1, mission(M1))

    def test_mission_creation_refuses_a_non_member(self, env):
        env.reg.members.discard((DAO, A1))
        with pytest.raises(Exception, match="not a member of dao"):
            env.work.create_mission(M1, DAO, A1, mission(M1))

    def test_mission_creation_refuses_everything_against_an_empty_registry(self, bare):
        """Positive control for the two guards above.

        If this passed, the populated fixture would prove nothing — the guards could be
        absent and every happy-path test would still be green.
        """
        with pytest.raises(Exception, match="unknown agent"):
            bare.work.create_mission(M1, DAO, A1, mission(M1))

    def test_mission_creation_refuses_a_payload_declaring_another_id(self, env):
        with pytest.raises(Exception, match="different mission_id"):
            env.work.create_mission(M1, DAO, A1, mission(M2))

    def test_mission_creation_refuses_a_payload_declaring_another_dao(self, env):
        with pytest.raises(Exception, match="different dao_id"):
            env.work.create_mission(M1, DAO, A1, mission(M1, dao_id=DAO2))

    def test_mission_creation_refuses_a_payload_declaring_another_creator(self, env):
        with pytest.raises(Exception, match="different creator_agent_id"):
            env.work.create_mission(M1, DAO, A1, mission(M1, creator=A2))

    def test_mission_creation_refuses_a_budget_over_the_dao_cap(self, env):
        env.reg.set_rules(DAO, dao_rules(max_budget="500000"), version=1)
        with pytest.raises(Exception, match="exceeds the DAO's cap"):
            env.work.create_mission(M1, DAO, A1, mission(M1, amount="500001"))

    def test_mission_creation_accepts_a_budget_exactly_at_the_dao_cap(self, env):
        """The boundary in the other direction, so the cap is `>` and not `>=`."""
        env.reg.set_rules(DAO, dao_rules(max_budget="500000"), version=1)
        env.work.create_mission(M1, DAO, A1, mission(M1, amount="500000"))
        assert env.work.get_mission_state(M1) == "DRAFT"

    def test_mission_creation_refuses_fewer_criteria_than_the_dao_requires(self, env):
        env.reg.set_rules(DAO, dao_rules(min_criteria=3), version=1)
        with pytest.raises(Exception, match="requires at least 3 acceptance criteria"):
            env.work.create_mission(M1, DAO, A1, mission(M1, n_criteria=2))

    def test_mission_creation_refuses_an_invalid_payload(self, env):
        payload = mission_payload(M1)
        payload["acceptance_criteria"][0]["weight_bp"] = 1
        with pytest.raises(Exception, match="weights must sum to 10000"):
            env.work.create_mission(M1, DAO, A1, json.dumps(payload))

    def test_mission_creation_refuses_malformed_json(self, env):
        with pytest.raises(Exception, match="not valid JSON"):
            env.work.create_mission(M1, DAO, A1, "{not json")

    def test_mission_creation_refuses_a_json_array(self, env):
        with pytest.raises(Exception, match="must be a JSON object"):
            env.work.create_mission(M1, DAO, A1, "[]")

    def test_mission_creation_refuses_opening_after_the_deadline(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.warp(DEADLINE)
        with pytest.raises(Exception, match="deadline .* has passed"):
            env.work.open_mission(M1)

    def test_mission_creation_allows_opening_one_second_before_the_deadline(self, env):
        """Both directions at the boundary. A test that only checks the refusal passes
        against a contract that never allows opening at all."""
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.warp(DEADLINE - 1)
        assert env.work.open_mission(M1) == "OPEN"

    def test_mission_creation_reads_of_an_unknown_mission_are_refused(self, env):
        for read in ("get_mission", "get_mission_hash", "get_mission_state"):
            with pytest.raises(Exception, match="unknown mission"):
                getattr(env.work, read)(M1)


# ── discovery (G3) ──────────────────────────────────────────────────────────


class TestMissionDiscovery:
    def test_mission_discovery_lists_only_open_missions(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.create_mission(M2, DAO, A1, mission(M2))
        env.work.open_mission(M2)
        assert env.work.list_open_missions() == [M2]

    def test_mission_discovery_excludes_a_cancelled_mission(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        assert env.work.list_open_missions() == [M1]
        env.work.cancel_mission(M1)
        assert env.work.get_mission_state(M1) == "CANCELLED"
        assert env.work.list_open_missions() == []

    def test_mission_discovery_excludes_an_expired_mission(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        env.warp(DEADLINE + 1)
        assert env.work.expire_mission(M1) == "EXPIRED"
        assert env.work.list_open_missions() == []

    def test_mission_discovery_excludes_a_mission_whose_proposals_are_closed(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        env.work.close_proposals(M1)
        assert env.work.list_open_missions() == []

    def test_mission_discovery_excludes_an_already_mandated_mission(self, env):
        drive_to_mandated(env, M1, N1)
        assert env.work.get_mission_state(M1) == "MANDATED"
        assert env.work.list_open_missions() == []

    def test_mission_discovery_survives_a_mix_of_states(self, env):
        """Several missions, one open, the rest in every other reachable state."""
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        env.work.cancel_mission(M1)

        env.work.create_mission(M2, DAO, A1, mission(M2))
        env.work.open_mission(M2)
        env.work.close_proposals(M2)

        env.work.create_mission(M3, DAO, A1, mission(M3))
        env.work.open_mission(M3)

        env.work.create_mission(M4, DAO, A1, mission(M4))

        assert env.work.list_open_missions() == [M3]
        assert sorted(env.work.list_dao_missions(DAO)) == sorted([M1, M2, M3, M4])

    def test_mission_discovery_is_scoped_per_dao(self, env):
        env.reg.add_member(DAO2, A1).set_rules(DAO2, dao_rules(dao_id=DAO2), version=1)
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.create_mission(M2, DAO2, A1, mission(M2, dao_id=DAO2))
        assert env.work.list_dao_missions(DAO) == [M1]
        assert env.work.list_dao_missions(DAO2) == [M2]
        assert env.work.list_dao_missions("dao_unknown") == []

    def test_mission_discovery_expiry_is_refused_before_the_deadline(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        with pytest.raises(Exception, match="is not expired"):
            env.work.expire_mission(M1)

    def test_mission_discovery_expiry_is_permissionless(self, env):
        """Anyone may expire a mission past its deadline; the deadline is the authority.

        If only the creator could, an abandoned mission would sit in the index forever and
        workers would keep proposing to it.
        """
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        env.warp(DEADLINE + 1).act_as(STRANGER)
        assert env.work.expire_mission(M1) == "EXPIRED"


# ── proposals (G4) ──────────────────────────────────────────────────────────


def open_mission_for(env, mission_id=M1, **kwargs):
    env.act_as(OP1)
    env.work.create_mission(mission_id, DAO, A1, mission(mission_id, **kwargs))
    env.work.open_mission(mission_id)
    return mission_id


class TestProposal:
    def test_proposal_is_submitted_against_an_open_mission(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        digest = env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        assert digest.startswith("0x") and len(digest) == 66
        assert env.work.get_proposal_hash(P1) == digest
        assert env.work.get_proposal_agent(P1) == A2
        assert env.work.get_mission_proposal_count(M1) == 1
        assert env.work.list_mission_proposals(M1) == [P1]
        assert json.loads(env.work.get_proposal(P1))["proposal_id"] == P1

    def test_proposal_is_stored_canonically(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        payload = proposal_payload(P1, M1)
        scrambled = json.dumps({k: payload[k] for k in reversed(list(payload))})
        env.work.submit_proposal(P1, M1, A2, scrambled)
        stored = env.work.get_proposal(P1)
        assert stored == json.dumps(json.loads(stored), sort_keys=True, separators=(",", ":"))

    def test_proposal_after_proposals_closed_is_refused(self, env):
        open_mission_for(env)
        env.work.close_proposals(M1)
        env.act_as(OP2)
        with pytest.raises(Exception, match="is PROPOSALS_CLOSED, not OPEN"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))

    def test_proposal_against_a_draft_mission_is_refused(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.act_as(OP2)
        with pytest.raises(Exception, match="is DRAFT, not OPEN"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))

    def test_proposal_against_a_cancelled_mission_is_refused(self, env):
        open_mission_for(env)
        env.work.cancel_mission(M1)
        env.act_as(OP2)
        with pytest.raises(Exception, match="is CANCELLED, not OPEN"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))

    def test_proposal_against_an_unknown_mission_is_refused(self, env):
        env.act_as(OP2)
        with pytest.raises(Exception, match="unknown mission"):
            env.work.submit_proposal(P1, M2, A2, proposal(P1, M2))

    def test_proposal_requires_a_valid_ulid(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="prp_ prefixed ULID"):
            env.work.submit_proposal("prp_nope", M1, A2, proposal("prp_nope", M1))

    def test_proposal_refuses_a_caller_who_is_not_the_agents_operator(self, env):
        open_mission_for(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="only agent .* own operator"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))

    def test_proposal_refuses_a_non_member(self, env):
        open_mission_for(env)
        env.reg.members.discard((DAO, A2))
        env.act_as(OP2)
        with pytest.raises(Exception, match="not a member of dao"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))

    def test_proposal_refuses_a_second_proposal_from_the_same_agent(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        with pytest.raises(Exception, match="has already proposed"):
            env.work.submit_proposal(P2, M1, A2, proposal(P2, M1))

    def test_proposal_allows_a_different_agent_on_the_same_mission(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP3)
        env.work.submit_proposal(P2, M1, A3, proposal(P2, M1, agent_id=A3))
        assert env.work.get_mission_proposal_count(M1) == 2
        assert env.work.list_mission_proposals(M1) == [P1, P2]

    def test_proposal_refuses_a_duplicate_proposal_id(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP3)
        with pytest.raises(Exception, match="already exists"):
            env.work.submit_proposal(P1, M1, A3, proposal(P1, M1, agent_id=A3))

    def test_proposal_refuses_a_payload_declaring_another_mission(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="different mission_id"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M2))

    def test_proposal_refuses_a_payload_declaring_another_agent(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="different agent_id"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, agent_id=A3))

    def test_proposal_refuses_a_payload_declaring_another_dao(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="but the mission belongs to"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, dao_id=DAO2))

    def test_proposal_refuses_a_request_over_the_mission_budget(self, env):
        open_mission_for(env, amount="1000000")
        env.act_as(OP2)
        with pytest.raises(Exception, match="exceeds the mission budget"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, amount="1000001"))

    def test_proposal_accepts_a_request_exactly_at_the_mission_budget(self, env):
        open_mission_for(env, amount="1000000")
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, amount="1000000"))
        assert env.work.get_mission_proposal_count(M1) == 1

    def test_proposal_refuses_a_team_on_a_solo_mission(self, env):
        open_mission_for(env, allow_teams=False, max_team_size=1)
        env.act_as(OP2)
        with pytest.raises(Exception, match="does not allow teams"):
            env.work.submit_proposal(
                P1, M1, A2, proposal(P1, M1, team=((A2, 5000), (A3, 5000)))
            )

    def test_proposal_refuses_a_team_over_the_mission_max_team_size(self, env):
        open_mission_for(env, allow_teams=True, max_team_size=1)
        env.act_as(OP2)
        with pytest.raises(Exception, match="exceeds the mission's max_team_size"):
            env.work.submit_proposal(
                P1, M1, A2, proposal(P1, M1, team=((A2, 5000), (A3, 5000)))
            )

    def test_proposal_accepts_a_team_within_the_limit(self, env):
        open_mission_for(env, allow_teams=True, max_team_size=2)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, team=((A2, 6000), (A3, 4000))))
        stored = json.loads(env.work.get_proposal(P1))
        assert [m["share_bp"] for m in stored["team_members"]] == [6000, 4000]

    def test_proposal_refuses_a_team_the_proposer_is_not_in(self, env):
        """Otherwise the agent who proposes and the agents who get paid are disjoint."""
        open_mission_for(env, allow_teams=True, max_team_size=2)
        env.act_as(OP2)
        with pytest.raises(Exception, match="must appear in its own team_members"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, team=((A1, 5000), (A3, 5000))))

    def test_proposal_refuses_a_team_member_who_is_not_a_dao_member(self, env):
        open_mission_for(env, allow_teams=True, max_team_size=2)
        env.reg.members.discard((DAO, A3))
        env.act_as(OP2)
        with pytest.raises(Exception, match="not a member of dao"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, team=((A2, 5000), (A3, 5000))))

    def test_proposal_refuses_team_shares_that_do_not_sum_to_the_denominator(self, env):
        open_mission_for(env, allow_teams=True, max_team_size=2)
        env.act_as(OP2)
        with pytest.raises(Exception, match="must sum to 10000"):
            env.work.submit_proposal(P1, M1, A2, proposal(P1, M1, team=((A2, 5000), (A3, 4000))))

    def test_proposal_reads_of_an_unknown_proposal_are_refused(self, env):
        for read in ("get_proposal", "get_proposal_hash", "get_proposal_agent"):
            with pytest.raises(Exception, match="unknown proposal"):
                getattr(env.work, read)(P1)
        assert env.work.list_mission_proposals(M1) == []

    def test_proposal_selection_requires_at_least_one_proposal(self, env):
        open_mission_for(env)
        env.work.close_proposals(M1)
        with pytest.raises(Exception, match="no proposals to select from"):
            env.work.start_selection(M1)

    def test_proposal_selection_is_recorded_only_by_the_adjudicator(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP1)
        env.work.close_proposals(M1)
        env.work.start_selection(M1)
        assert env.work.get_mission_state(M1) == "SELECTING"

        with pytest.raises(Exception, match="only the adjudicator may record a selection"):
            env.work.record_selection(M1, P1, SELECTION_HASH)

        env.act_as(ADJUDICATOR)
        assert env.work.record_selection(M1, P1, SELECTION_HASH) == "SELECTED"
        assert env.work.get_selected_proposal(M1) == P1
        assert env.work.get_selection_hash(M1) == SELECTION_HASH

    def test_proposal_selection_refuses_a_proposal_from_another_mission(self, env):
        open_mission_for(env, M1)
        open_mission_for(env, M2)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.work.submit_proposal(P2, M2, A2, proposal(P2, M2))
        env.act_as(OP1)
        env.work.close_proposals(M1)
        env.work.start_selection(M1)
        env.act_as(ADJUDICATOR)
        with pytest.raises(Exception, match="does not belong to mission"):
            env.work.record_selection(M1, P2, SELECTION_HASH)

    def test_proposal_selection_refuses_a_malformed_decision_hash(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP1)
        env.work.close_proposals(M1)
        env.work.start_selection(M1)
        env.act_as(ADJUDICATOR)
        with pytest.raises(Exception, match="decision_hash must be 0x"):
            env.work.record_selection(M1, P1, "0xnope")

    def test_proposal_selection_refuses_an_unknown_proposal(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP1)
        env.work.close_proposals(M1)
        env.work.start_selection(M1)
        env.act_as(ADJUDICATOR)
        with pytest.raises(Exception, match="unknown proposal"):
            env.work.record_selection(M1, P3, SELECTION_HASH)


# ── mandates (G5) ───────────────────────────────────────────────────────────


def drive_to_selected(env, mission_id=M1, proposal_id=P1, worker=A2, worker_op=OP2, **kwargs):
    """mission → OPEN → proposal → PROPOSALS_CLOSED → SELECTING → SELECTED."""
    team = kwargs.pop("team", ())
    env.act_as(OP1)
    env.work.create_mission(mission_id, DAO, A1, mission(mission_id, **kwargs))
    env.work.open_mission(mission_id)
    env.act_as(worker_op)
    env.work.submit_proposal(
        proposal_id,
        mission_id,
        worker,
        proposal(proposal_id, mission_id, agent_id=worker, team=team),
    )
    env.act_as(OP1)
    env.work.close_proposals(mission_id)
    env.work.start_selection(mission_id)
    env.act_as(ADJUDICATOR)
    env.work.record_selection(mission_id, proposal_id, SELECTION_HASH)
    env.act_as(OP1)
    return env.work.get_proposal_hash(proposal_id)


def drive_to_mandated(env, mission_id=M1, mandate_id=N1, workers=((A2, 10_000),), **kwargs):
    proposal_hash = drive_to_selected(env, mission_id, **kwargs)
    env.act_as(OP1)
    env.work.create_mandate(
        mandate_id, mission_id, mandate(mandate_id, mission_id, proposal_hash, workers=workers)
    )
    return mandate_id


class TestMandate:
    def test_mandate_is_created_from_the_selected_proposal(self, env):
        proposal_hash = drive_to_selected(env)
        digest = env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        assert digest.startswith("0x") and len(digest) == 66
        assert env.work.get_mandate_hash(N1) == digest
        assert env.work.get_mandate_state(N1) == "CREATED"
        assert env.work.get_mandate_dao(N1) == DAO
        assert env.work.get_mandate_mission(N1) == M1
        assert env.work.get_mission_mandate(M1) == N1
        assert env.work.get_mission_state(M1) == "MANDATED"
        assert env.work.mandate_count() == 1

    def test_mandate_carries_the_proposal_and_selection_hashes(self, env):
        proposal_hash = drive_to_selected(env)
        env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        stored = json.loads(env.work.get_mandate(N1))
        assert stored["proposal_hash"] == proposal_hash == env.work.get_proposal_hash(P1)
        assert stored["selection_decision_hash"] == SELECTION_HASH
        assert stored["selection_decision_hash"] == env.work.get_selection_hash(M1)

    def test_mandate_refuses_a_hash_that_is_not_the_selected_proposals(self, env):
        """The check that stops a creator running a real selection and then mandating
        against a different proposal."""
        drive_to_selected(env)
        with pytest.raises(Exception, match="must be the content hash of the SELECTED proposal"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, "0x" + "99" * 32))

    def test_mandate_refuses_a_selection_hash_that_was_not_recorded(self, env):
        proposal_hash = drive_to_selected(env)
        with pytest.raises(Exception, match="must be the recorded selection decision"):
            env.work.create_mandate(
                N1, M1, mandate(N1, M1, proposal_hash, selection_hash="0x" + "77" * 32)
            )

    def test_mandate_refuses_workers_the_selected_proposal_did_not_commit(self, env):
        """Without this, selection is decorative: a creator could select A2's proposal and
        then write a mandate that pays A3."""
        proposal_hash = drive_to_selected(env)
        with pytest.raises(Exception, match="must match the selected proposal exactly"):
            env.work.create_mandate(
                N1, M1, mandate(N1, M1, proposal_hash, workers=((A3, 10_000),))
            )

    def test_mandate_refuses_shares_the_selected_proposal_did_not_commit(self, env):
        proposal_hash = drive_to_selected(
            env, allow_teams=True, max_team_size=2, team=((A2, 6000), (A3, 4000))
        )
        with pytest.raises(Exception, match="must match the selected proposal exactly"):
            env.work.create_mandate(
                N1, M1, mandate(N1, M1, proposal_hash, workers=((A2, 4000), (A3, 6000)))
            )

    def test_mandate_accepts_the_team_shares_the_proposal_committed(self, env):
        proposal_hash = drive_to_selected(
            env, allow_teams=True, max_team_size=2, team=((A2, 6000), (A3, 4000))
        )
        env.work.create_mandate(
            N1, M1, mandate(N1, M1, proposal_hash, workers=((A2, 6000), (A3, 4000)))
        )
        assert env.work.get_mandate_acceptance(N1) == [0, 2]

    def test_mandate_refuses_a_budget_over_the_mission_budget(self, env):
        proposal_hash = drive_to_selected(env, amount="1000000")
        with pytest.raises(Exception, match="exceeds the mission budget"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash, amount="1000001"))

    def test_mandate_refuses_a_deadline_that_has_already_passed(self, env):
        proposal_hash = drive_to_selected(env)
        env.warp(DEADLINE + 1)
        with pytest.raises(Exception, match="is not in the future"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))

    def test_mandate_refuses_creation_before_selection(self, env):
        open_mission_for(env)
        with pytest.raises(Exception, match="is OPEN, not SELECTED"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, "0x" + "ab" * 32))

    def test_mandate_refuses_a_second_mandate_for_the_same_mission(self, env):
        proposal_hash = drive_to_selected(env)
        env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        with pytest.raises(Exception, match="is MANDATED, not SELECTED"):
            env.work.create_mandate(N2, M1, mandate(N2, M1, proposal_hash))

    def test_mandate_refuses_a_duplicate_mandate_id(self, env):
        proposal_hash = drive_to_selected(env)
        env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        with pytest.raises(Exception, match="already exists"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))

    def test_mandate_refuses_a_creator_other_than_the_missions(self, env):
        proposal_hash = drive_to_selected(env)
        with pytest.raises(Exception, match="different creator_agent_id"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash, creator=A2))

    def test_mandate_refuses_a_caller_who_is_not_the_mission_creators_operator(self, env):
        proposal_hash = drive_to_selected(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="only agent .* own operator"):
            env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))

    def test_mandate_requires_a_valid_ulid(self, env):
        proposal_hash = drive_to_selected(env)
        with pytest.raises(Exception, match="mnd_ prefixed ULID"):
            env.work.create_mandate("mnd_nope", M1, mandate("mnd_nope", M1, proposal_hash))

    # -- acceptance -----------------------------------------------------------

    def test_mandate_advances_to_accepted_when_its_only_worker_accepts(self, env):
        drive_to_mandated(env)
        env.act_as(OP2)
        assert env.work.accept_mandate(N1, A2) == "ACCEPTED"
        assert env.work.get_mandate_state(N1) == "ACCEPTED"
        assert env.work.is_accepted_worker(N1, A2) is True
        assert env.work.get_mandate_acceptance(N1) == [1, 1]

    def test_mandate_requires_every_worker_to_accept_before_funding(self, env):
        """Partial acceptance is not acceptance: funding a mandate one worker never agreed
        to would commit the DAO's USDC against labour nobody promised."""
        proposal_hash = drive_to_selected(
            env, allow_teams=True, max_team_size=2, team=((A2, 6000), (A3, 4000))
        )
        env.work.create_mandate(
            N1, M1, mandate(N1, M1, proposal_hash, workers=((A2, 6000), (A3, 4000)))
        )
        env.act_as(OP2)
        assert env.work.accept_mandate(N1, A2) == "CREATED"
        assert env.work.get_mandate_state(N1) == "CREATED"
        assert env.work.get_mandate_acceptance(N1) == [1, 2]

        env.act_as(OBSERVER)
        with pytest.raises(Exception, match="CREATED -> FUNDED is not a legal transition"):
            env.work.mark_funded(N1, FUNDING_TX)

        env.act_as(OP3)
        assert env.work.accept_mandate(N1, A3) == "ACCEPTED"
        assert env.work.get_mandate_acceptance(N1) == [2, 2]
        env.act_as(OBSERVER)
        assert env.work.mark_funded(N1, FUNDING_TX) == "FUNDED"

    def test_mandate_refuses_acceptance_by_an_agent_who_is_not_a_worker(self, env):
        drive_to_mandated(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="is not a worker on mandate"):
            env.work.accept_mandate(N1, A3)

    def test_mandate_refuses_acceptance_by_the_wrong_operator(self, env):
        drive_to_mandated(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="only agent .* own operator"):
            env.work.accept_mandate(N1, A2)

    def test_mandate_refuses_a_double_acceptance(self, env):
        proposal_hash = drive_to_selected(
            env, allow_teams=True, max_team_size=2, team=((A2, 6000), (A3, 4000))
        )
        env.work.create_mandate(
            N1, M1, mandate(N1, M1, proposal_hash, workers=((A2, 6000), (A3, 4000)))
        )
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        with pytest.raises(Exception, match="has already accepted"):
            env.work.accept_mandate(N1, A2)

    def test_mandate_records_the_rules_version_the_mission_was_created_under(self, env):
        """Invariant I8: a later rules change cannot reach back into a live mandate."""
        env.reg.set_rules(DAO, dao_rules(version=3), version=3)
        drive_to_mandated(env)
        assert env.work.get_mandate_rules_version(N1) == 3
        env.reg.set_rules(DAO, dao_rules(version=4), version=4)
        assert env.work.get_mandate_rules_version(N1) == 3
        assert env.work.get_mission_rules_version(M1) == 3

    def test_mandate_worker_flags_are_readable(self, env):
        drive_to_mandated(env)
        assert env.work.is_mandate_worker(N1, A2) is True
        assert env.work.is_mandate_worker(N1, A3) is False
        assert env.work.is_accepted_worker(N1, A2) is False

    def test_mandate_reads_of_an_unknown_mandate_are_refused(self, env):
        for read in ("get_mandate", "get_mandate_hash", "get_mandate_state", "get_mandate_mission"):
            with pytest.raises(Exception, match="unknown mandate"):
                getattr(env.work, read)(N1)
        assert env.work.get_mandate_decision_hash(N1) == ""
        assert env.work.get_mission_mandate(M1) == ""

    # -- relayed custody ------------------------------------------------------

    def test_mandate_funding_is_recorded_only_by_the_settlement_observer(self, env):
        drive_to_mandated(env)
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        with pytest.raises(Exception, match="only the settlement observer may record funding"):
            env.work.mark_funded(N1, FUNDING_TX)
        env.act_as(OBSERVER)
        assert env.work.mark_funded(N1, FUNDING_TX) == "FUNDED"
        assert env.work.get_mandate_base_txs(N1) == [FUNDING_TX, ""]

    def test_mandate_funding_requires_the_base_transaction_hash(self, env):
        """Relayed, not proven — so the claim must at least be auditable against Base."""
        drive_to_mandated(env)
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        env.act_as(OBSERVER)
        with pytest.raises(Exception, match="requires the Base transaction hash"):
            env.work.mark_funded(N1, "0xdeadbeef")

    def test_mandate_settlement_requires_a_recorded_decision(self, env):
        """Invariant I1, guarded twice: by the transition table and by this explicit
        check. It is the invariant that most deserves two independent guards."""
        drive_to_submitted(env)
        env.act_as(OBSERVER)
        with pytest.raises(Exception, match="no recorded decision to settle against"):
            env.work.mark_settled(N1, SETTLEMENT_TX)
        assert env.work.get_mandate_state(N1) == "SUBMITTED"

    def test_mandate_settles_after_adjudication_and_records_both_txs(self, env):
        drive_to_adjudicated(env)
        env.act_as(OBSERVER)
        assert env.work.mark_settled(N1, SETTLEMENT_TX) == "SETTLED"
        assert env.work.get_mandate_base_txs(N1) == [FUNDING_TX, SETTLEMENT_TX]
        assert env.work.get_mandate_decision_hash(N1) == DECISION_HASH

    def test_mandate_refunds_from_funded(self, env):
        drive_to_funded(env)
        env.act_as(OBSERVER)
        assert env.work.mark_refunded(N1, SETTLEMENT_TX) == "REFUNDED"
        assert env.work.get_mandate_state(N1) == "REFUNDED"

    def test_mandate_cancel_is_refused_once_funded(self, env):
        """After funding the only non-settling exit is REFUNDED: a terminal state reached
        with USDC still locked would be unrecoverable."""
        drive_to_funded(env)
        env.act_as(OP1)
        with pytest.raises(Exception, match="FUNDED -> CANCELLED is not a legal transition"):
            env.work.cancel_mandate(N1)

    def test_mandate_expiry_is_refused_once_funded(self, env):
        drive_to_funded(env)
        env.warp(DEADLINE + 1).act_as(STRANGER)
        with pytest.raises(Exception, match="FUNDED -> EXPIRED is not a legal transition"):
            env.work.expire_mandate(N1)

    def test_mandate_expiry_before_the_deadline_is_refused(self, env):
        drive_to_mandated(env)
        env.act_as(STRANGER)
        with pytest.raises(Exception, match="is not expired"):
            env.work.expire_mandate(N1)

    def test_mandate_expires_when_unfunded_and_past_its_deadline(self, env):
        drive_to_mandated(env)
        env.warp(DEADLINE + 1).act_as(STRANGER)
        assert env.work.expire_mandate(N1) == "EXPIRED"

    def test_mandate_adjudication_handoff_is_adjudicator_only(self, env):
        drive_to_submitted(env)
        env.act_as(OP1)
        with pytest.raises(Exception, match="only the adjudicator may start adjudication"):
            env.work.start_adjudication(N1)
        env.act_as(ADJUDICATOR)
        assert env.work.start_adjudication(N1) == "ADJUDICATING"
        env.act_as(OP1)
        with pytest.raises(Exception, match="only the adjudicator may record an adjudication"):
            env.work.record_adjudication(N1, DECISION_HASH)
        env.act_as(ADJUDICATOR)
        assert env.work.record_adjudication(N1, DECISION_HASH) == "ADJUDICATED"

    def test_mandate_adjudication_refuses_a_malformed_decision_hash(self, env):
        drive_to_submitted(env)
        env.act_as(ADJUDICATOR)
        env.work.start_adjudication(N1)
        with pytest.raises(Exception, match="decision_hash must be 0x"):
            env.work.record_adjudication(N1, "0x1234")


# ── deliverables (G6) ───────────────────────────────────────────────────────


def drive_to_funded(env, **kwargs):
    drive_to_mandated(env, **kwargs)
    env.act_as(OP2)
    env.work.accept_mandate(N1, A2)
    env.act_as(OBSERVER)
    env.work.mark_funded(N1, FUNDING_TX)
    return N1


def drive_to_in_progress(env, **kwargs):
    drive_to_funded(env, **kwargs)
    env.act_as(OP2)
    env.work.start_work(N1)
    return N1


def drive_to_submitted(env, **kwargs):
    drive_to_in_progress(env, **kwargs)
    env.act_as(OP2)
    env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
    env.work.submit_work(N1)
    return N1


def drive_to_adjudicated(env, **kwargs):
    drive_to_submitted(env, **kwargs)
    env.act_as(ADJUDICATOR)
    env.work.start_adjudication(N1)
    env.work.record_adjudication(N1, DECISION_HASH)
    return N1


class TestDeliverable:
    def test_deliverable_is_submitted_by_an_accepted_worker_in_progress(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        digest = env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        assert digest.startswith("0x") and len(digest) == 66
        assert env.work.get_deliverable_hash(V1) == digest
        assert env.work.list_mandate_deliverables(N1) == [V1]
        assert json.loads(env.work.get_deliverable(V1))["deliverable_id"] == V1

    def test_deliverable_submission_moves_the_mandate_to_submitted(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        assert env.work.get_mandate_state(N1) == "IN_PROGRESS"
        assert env.work.submit_work(N1) == "SUBMITTED"
        assert env.work.get_mandate_state(N1) == "SUBMITTED"

    def test_deliverable_is_required_before_work_can_be_submitted(self, env):
        """Otherwise a mandate reaches adjudication with nothing to adjudicate."""
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="no deliverable to adjudicate"):
            env.work.submit_work(N1)

    def test_deliverable_is_refused_before_the_mandate_is_in_progress(self, env):
        drive_to_funded(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="is FUNDED, not IN_PROGRESS"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))

    def test_deliverable_is_refused_after_the_mandate_is_submitted(self, env):
        drive_to_submitted(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="is SUBMITTED, not IN_PROGRESS"):
            env.work.submit_deliverable(V2, N1, A2, deliverable(V2, N1))

    def test_deliverable_is_refused_from_an_agent_who_did_not_accept(self, env):
        drive_to_in_progress(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="is not an accepted worker"):
            env.work.submit_deliverable(V1, N1, A3, deliverable(V1, N1, worker=A3))

    def test_deliverable_is_refused_from_the_wrong_operator(self, env):
        drive_to_in_progress(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="only agent .* own operator"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))

    def test_deliverable_requires_a_valid_ulid(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="dlv_ prefixed ULID"):
            env.work.submit_deliverable("dlv_nope", N1, A2, deliverable("dlv_nope", N1))

    def test_deliverable_refuses_a_duplicate_id(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        with pytest.raises(Exception, match="already exists"):
            env.work.submit_deliverable(
                V1, N1, A2, deliverable(V1, N1, evidence=[evidence_item(N1, A2, tag="E2")])
            )

    def test_deliverable_refuses_a_payload_declaring_another_mandate(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="different mandate_id"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N2))

    def test_deliverable_refuses_a_payload_declaring_another_worker(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="different worker_agent_id"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, worker=A3))

    def test_deliverable_refuses_an_index_the_mandate_does_not_declare(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="names only 2"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, indices=(5,)))

    def test_deliverable_accepts_the_last_declared_index(self, env):
        """The boundary in the other direction, so the check is `>=` and not `>`."""
        drive_to_in_progress(env)
        env.act_as(OP2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, indices=(1,)))
        assert env.work.list_mandate_deliverables(N1) == [V1]

    def test_deliverable_allows_two_deliverables_on_one_mandate(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        env.work.submit_deliverable(
            V2, N1, A2, deliverable(V2, N1, evidence=[evidence_item(N1, A2, tag="E2")])
        )
        assert env.work.list_mandate_deliverables(N1) == [V1, V2]

    def test_deliverable_reads_of_an_unknown_deliverable_are_refused(self, env):
        for read in ("get_deliverable", "get_deliverable_hash"):
            with pytest.raises(Exception, match="unknown deliverable"):
                getattr(env.work, read)(V1)
        assert env.work.list_mandate_deliverables(N1) == []

    def test_deliverable_start_work_requires_an_accepted_worker(self, env):
        drive_to_funded(env)
        env.act_as(OP3)
        with pytest.raises(Exception, match="is not an accepted worker"):
            env.work.start_work(N1)

    def test_deliverable_start_work_refuses_an_address_with_no_agent(self, env):
        drive_to_funded(env)
        env.act_as(STRANGER)
        with pytest.raises(Exception, match="controls no registered agent"):
            env.work.start_work(N1)

    def test_deliverable_submit_work_refuses_an_address_with_no_agent(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        env.act_as(STRANGER)
        with pytest.raises(Exception, match="controls no registered agent"):
            env.work.submit_work(N1)


# ── evidence (G7) ───────────────────────────────────────────────────────────


class TestEvidence:
    def test_evidence_is_bound_to_its_deliverable_and_resolvable(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))
        assert env.work.find_evidence(item["evidence_id"]) == V1
        stored = json.loads(env.work.get_deliverable(V1))
        assert stored["evidence"][0]["content_hash"] == item["content_hash"]
        assert stored["evidence"][0]["uri"] == item["uri"]

    def test_evidence_requires_a_content_hash_of_the_right_length(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        item["content_hash"] = "0xnothex"
        with pytest.raises(Exception, match="length must be 66..66"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_requires_a_content_hash_that_is_hex(self, env):
        """66 characters so the length check passes and the shape check is what fires."""
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        item["content_hash"] = "0x" + "zz" * 32
        with pytest.raises(Exception, match="lowercase 0x-prefixed 32-byte hex digest"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_requires_a_content_hash_in_lowercase(self, env):
        """Uppercase hex is a second spelling of one value, and two spellings are two
        hashes — the whole reason canonical form is frozen."""
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        item["content_hash"] = "0x" + "AB" * 32
        with pytest.raises(Exception, match="lowercase 0x-prefixed 32-byte hex digest"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_requires_an_https_uri(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2, uri="http://example.com/repo")
        with pytest.raises(Exception, match="must be https"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_for_another_mandate_is_refused(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N2, A2)
        with pytest.raises(Exception, match=f"belongs to mandate {N2}"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_cannot_be_reused_under_a_second_deliverable(self, env):
        """One artefact must not be made to look like two pieces of work."""
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))
        with pytest.raises(Exception, match="was already submitted under deliverable"):
            env.work.submit_deliverable(V2, N1, A2, deliverable(V2, N1, evidence=[item]))

    def test_evidence_is_required_on_every_deliverable(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        with pytest.raises(Exception, match="length must be 1"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[]))

    def test_evidence_refuses_a_duplicate_id_inside_one_deliverable(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        with pytest.raises(Exception, match="duplicate evidence"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item, item]))

    def test_evidence_refuses_an_unknown_type(self, env):
        drive_to_in_progress(env)
        env.act_as(OP2)
        item = evidence_item(N1, A2)
        item["type"] = "vibes"
        with pytest.raises(Exception, match="unknown evidence type"):
            env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1, evidence=[item]))

    def test_evidence_lookup_of_an_unknown_id_returns_empty(self, env):
        assert env.work.find_evidence(ulid("evd", "E9")) == ""


# ── mission versioning, SPEC §102 (G8) ──────────────────────────────────────


class TestVersioning:
    def test_versioning_increments_on_an_edit_in_draft(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        first = env.work.get_mission_hash(M1)
        assert env.work.update_mission(M1, mission(M1, title="Revised title")) == 2
        assert env.work.get_mission_version(M1) == 2
        assert env.work.get_mission_hash(M1) != first
        assert json.loads(env.work.get_mission(M1))["title"] == "Revised title"

    def test_versioning_increments_on_an_edit_in_open_with_no_proposals(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        assert env.work.update_mission(M1, mission(M1, title="Second")) == 2
        assert env.work.update_mission(M1, mission(M1, title="Third")) == 3
        assert env.work.get_mission_state(M1) == "OPEN"

    def test_versioning_is_frozen_permanently_by_the_first_proposal(self, env):
        open_mission_for(env)
        env.act_as(OP2)
        env.work.submit_proposal(P1, M1, A2, proposal(P1, M1))
        env.act_as(OP1)
        with pytest.raises(Exception, match="not editable: state OPEN with 1 proposal"):
            env.work.update_mission(M1, mission(M1, title="Too late"))
        assert env.work.get_mission_version(M1) == 1

    def test_versioning_is_refused_once_proposals_are_closed(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.open_mission(M1)
        env.work.close_proposals(M1)
        with pytest.raises(Exception, match="not editable: state PROPOSALS_CLOSED"):
            env.work.update_mission(M1, mission(M1, title="Too late"))

    def test_versioning_is_refused_on_a_cancelled_mission(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.work.cancel_mission(M1)
        with pytest.raises(Exception, match="not editable: state CANCELLED"):
            env.work.update_mission(M1, mission(M1, title="Too late"))

    def test_versioning_is_refused_for_a_non_creator(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        env.act_as(OP2)
        with pytest.raises(Exception, match="only agent .* own operator"):
            env.work.update_mission(M1, mission(M1, title="Not yours"))

    def test_versioning_refuses_moving_a_mission_to_another_dao(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        with pytest.raises(Exception, match="cannot be moved to another DAO"):
            env.work.update_mission(M1, mission(M1, dao_id=DAO2))

    def test_versioning_refuses_changing_the_creator(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        with pytest.raises(Exception, match="creator cannot be changed"):
            env.work.update_mission(M1, mission(M1, creator=A2))

    def test_versioning_refuses_an_edit_past_a_lowered_dao_cap(self, env):
        """A DAO that lowers its cap must not be editable back up past it."""
        env.work.create_mission(M1, DAO, A1, mission(M1, amount="1000000"))
        env.reg.set_rules(DAO, dao_rules(max_budget="500000"), version=2)
        with pytest.raises(Exception, match="exceeds the DAO's cap"):
            env.work.update_mission(M1, mission(M1, amount="600000"))

    def test_versioning_refuses_an_unknown_mission(self, env):
        with pytest.raises(Exception, match="unknown mission"):
            env.work.update_mission(M1, mission(M1))

    def test_versioning_refuses_an_invalid_payload(self, env):
        env.work.create_mission(M1, DAO, A1, mission(M1))
        with pytest.raises(Exception, match="different mission_id"):
            env.work.update_mission(M1, mission(M2))


# ── mandate immutability after acceptance, invariant I8 (G9) ────────────────


class TestImmutableAfterAcceptance:
    def test_immutable_after_acceptance_no_mutation_method_exists(self):
        """Structural, not behavioural.

        `mandate_payload` is written in exactly one place — `create_mandate`. A test that
        only tried the methods that exist today would go green the moment someone added
        `update_mandate`; this one fails.
        """
        tree = _parse(GENLAYER_ROOT / "wrk_work.py")
        writers = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(node):
                if not isinstance(inner, ast.Assign):
                    continue
                for target in inner.targets:
                    if isinstance(target, ast.Subscript) and ast.unparse(target).startswith(
                        "self.mandate_payload["
                    ):
                        writers.append(node.name)
        assert writers == ["create_mandate"], (
            f"mandate_payload is written by {writers}; only create_mandate may write it"
        )

    def test_immutable_after_acceptance_hash_is_writable_once_only(self):
        tree = _parse(GENLAYER_ROOT / "wrk_work.py")
        writers = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(node):
                if isinstance(inner, ast.Assign):
                    for target in inner.targets:
                        if isinstance(target, ast.Subscript) and ast.unparse(target).startswith(
                            "self.mandate_hash["
                        ):
                            writers.append(node.name)
        assert writers == ["create_mandate"]

    def test_immutable_after_acceptance_the_structural_check_detects_a_mutator(self):
        """Positive control for the two checks above."""
        tree = ast.parse(
            "class C:\n"
            "    def update_mandate(self, i, p):\n"
            "        self.mandate_payload[i] = p\n"
        )
        writers = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Assign):
                        for target in inner.targets:
                            if isinstance(target, ast.Subscript) and ast.unparse(
                                target
                            ).startswith("self.mandate_payload["):
                                writers.append(node.name)
        assert writers == ["update_mandate"]

    def test_immutable_after_acceptance_payload_is_unchanged_through_the_lifecycle(self, env):
        drive_to_mandated(env)
        payload = env.work.get_mandate(N1)
        digest = env.work.get_mandate_hash(N1)

        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        env.act_as(OBSERVER)
        env.work.mark_funded(N1, FUNDING_TX)
        env.act_as(OP2)
        env.work.start_work(N1)
        env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
        env.work.submit_work(N1)
        env.act_as(ADJUDICATOR)
        env.work.start_adjudication(N1)
        env.work.record_adjudication(N1, DECISION_HASH)
        env.act_as(OBSERVER)
        env.work.mark_settled(N1, SETTLEMENT_TX)

        assert env.work.get_mandate_state(N1) == "SETTLED"
        assert env.work.get_mandate(N1) == payload
        assert env.work.get_mandate_hash(N1) == digest

    def test_immutable_after_acceptance_recreating_the_mandate_is_refused_even_by_the_creator(
        self, env
    ):
        """"Only the creator may edit" is the shape this bug takes, so the creator is the
        caller here."""
        proposal_hash = drive_to_selected(env)
        env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        env.act_as(OP1)
        with pytest.raises(Exception, match="already exists"):
            env.work.create_mandate(
                N1, M1, mandate(N1, M1, proposal_hash, amount="1", n_deliverables=1)
            )
        assert json.loads(env.work.get_mandate(N1))["budget"]["amount_atomic"] == "1000000"

    def test_immutable_after_acceptance_a_rules_change_cannot_reach_back(self, env):
        drive_to_mandated(env)
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        before = env.work.get_mandate_rules_version(N1)
        env.reg.set_rules(DAO, dao_rules(version=9, max_budget="1"), version=9)
        assert env.work.get_mandate_rules_version(N1) == before
        assert env.work.get_mandate(N1) == env.work.get_mandate(N1)
        assert env.work.get_mandate_state(N1) == "ACCEPTED"

    def test_immutable_after_acceptance_a_second_mandate_on_the_mission_is_refused(self, env):
        proposal_hash = drive_to_selected(env)
        env.work.create_mandate(N1, M1, mandate(N1, M1, proposal_hash))
        env.act_as(OP2)
        env.work.accept_mandate(N1, A2)
        env.act_as(OP1)
        with pytest.raises(Exception, match="is MANDATED, not SELECTED"):
            env.work.create_mandate(N2, M1, mandate(N2, M1, proposal_hash))
        assert env.work.get_mission_mandate(M1) == N1


# ── exhaustive mandate transitions (G10) ────────────────────────────────────

#: Every state-changing mandate method, the state it targets, and the sender authorized to
#: call it. Authorization is covered by its own tests; here the correct caller is used so
#: that what is measured is the *transition*, not the guard in front of it.
MANDATE_MOVES = (
    ("accept_mandate", "ACCEPTED", OP2, lambda work: work.accept_mandate(N1, A2)),
    ("cancel_mandate", "CANCELLED", OP1, lambda work: work.cancel_mandate(N1)),
    ("expire_mandate", "EXPIRED", STRANGER, lambda work: work.expire_mandate(N1)),
    ("mark_funded", "FUNDED", OBSERVER, lambda work: work.mark_funded(N1, FUNDING_TX)),
    ("start_work", "IN_PROGRESS", OP2, lambda work: work.start_work(N1)),
    ("submit_work", "SUBMITTED", OP2, lambda work: work.submit_work(N1)),
    ("start_adjudication", "ADJUDICATING", ADJUDICATOR, lambda work: work.start_adjudication(N1)),
    (
        "record_adjudication",
        "ADJUDICATED",
        ADJUDICATOR,
        lambda work: work.record_adjudication(N1, DECISION_HASH),
    ),
    ("mark_settled", "SETTLED", OBSERVER, lambda work: work.mark_settled(N1, SETTLEMENT_TX)),
    ("mark_refunded", "REFUNDED", OBSERVER, lambda work: work.mark_refunded(N1, SETTLEMENT_TX)),
)

#: Every mandate state reachable through this contract's own methods, and how to get there.
#: The matrix below asserts one row per state, so a state missing from this list is a state
#: the matrix never visits — hence the completeness assertion in
#: `test_transitions_exhaustive_covers_every_reachable_state`.
REACHABLE_STATES = (
    "CREATED",
    "ACCEPTED",
    "FUNDED",
    "IN_PROGRESS",
    "SUBMITTED",
    "ADJUDICATING",
    "ADJUDICATED",
    "SETTLED",
    "REFUNDED",
    "CANCELLED",
    "EXPIRED",
)


def drive_mandate_to(env, state: str) -> None:
    """Put N1 into `state`, leaving a deliverable in place wherever one is possible."""
    drive_to_mandated(env)
    if state == "CREATED":
        return
    if state == "CANCELLED":
        env.act_as(OP1)
        env.work.cancel_mandate(N1)
        return
    if state == "EXPIRED":
        env.warp(DEADLINE + 1).act_as(STRANGER)
        env.work.expire_mandate(N1)
        return

    env.act_as(OP2)
    env.work.accept_mandate(N1, A2)
    if state == "ACCEPTED":
        return

    env.act_as(OBSERVER)
    env.work.mark_funded(N1, FUNDING_TX)
    if state == "FUNDED":
        return
    if state == "REFUNDED":
        env.work.mark_refunded(N1, SETTLEMENT_TX)
        return

    env.act_as(OP2)
    env.work.start_work(N1)
    # Submitted here rather than later so that `submit_work` is genuinely reachable from
    # IN_PROGRESS: without a deliverable it would fail for the wrong reason and the matrix
    # would record a legal transition as refused.
    env.work.submit_deliverable(V1, N1, A2, deliverable(V1, N1))
    if state == "IN_PROGRESS":
        return

    env.work.submit_work(N1)
    if state == "SUBMITTED":
        return

    env.act_as(ADJUDICATOR)
    env.work.start_adjudication(N1)
    if state == "ADJUDICATING":
        return

    env.work.record_adjudication(N1, DECISION_HASH)
    if state == "ADJUDICATED":
        return

    env.act_as(OBSERVER)
    env.work.mark_settled(N1, SETTLEMENT_TX)
    if state == "SETTLED":
        return

    raise AssertionError(f"no route to {state}")


class TestTransitionsExhaustive:
    """The full (state × method) product, not the happy path.

    `MANDATED → SETTLED` without `ADJUDICATED` is invariant I1 violated and it is one
    missing guard away. A walk down the legal spine proves the legal edges and says
    nothing about the illegal ones, so every cell is asserted in both directions.

    The oracle is `lib.states.MANDATE_TRANSITIONS` — the table the contract itself
    consults. That is the right oracle for the claim being made here, which is that the
    contract *honours* the table; whether the table matches `docs/ARCHITECTURE.md` §6 is
    leaf-1.1.x's gate, cross-checked against `packages/types/src/states.ts`.
    """

    def test_transitions_exhaustive_covers_every_reachable_state(self):
        """Guards the matrix itself: a state absent from REACHABLE_STATES is never tested."""
        from lib.states import MANDATE_STATES

        assert set(REACHABLE_STATES) == set(MANDATE_STATES), (
            f"matrix covers {sorted(REACHABLE_STATES)} but the machine has "
            f"{sorted(MANDATE_STATES)}"
        )

    def test_transitions_exhaustive_covers_every_legal_edge(self):
        """Guards the matrix again: every legal edge must have a method that can take it,
        or the matrix would silently skip proving that edge works at all."""
        from lib.states import MANDATE_TRANSITIONS

        targets = {target for _, target, _, _ in MANDATE_MOVES}
        edges = {t for sources in MANDATE_TRANSITIONS.values() for t in sources}
        assert edges <= targets, f"legal targets with no method in the matrix: {edges - targets}"

    @pytest.mark.parametrize("state", REACHABLE_STATES)
    @pytest.mark.parametrize("move", MANDATE_MOVES, ids=[m[0] for m in MANDATE_MOVES])
    def test_transitions_exhaustive_matrix(self, env, state, move):
        """One cell of the product per test case.

        Cross-parametrized rather than looped because storage persists for the lifetime of
        a test: a loop would try to re-create the same mission in the same contract and
        fail with "already exists" on its second iteration, which is exactly what happened
        when this was written as a loop.
        """
        from lib.states import MANDATE_TRANSITIONS

        name, target, sender, call = move
        legal = set(MANDATE_TRANSITIONS[state])

        drive_mandate_to(env, state)
        assert env.work.get_mandate_state(N1) == state, f"setup for {state} drifted"

        if target == "EXPIRED":
            env.warp(DEADLINE + 1)
        env.act_as(sender)

        if target in legal:
            call(env.work)
            assert env.work.get_mandate_state(N1) == target, (
                f"{state} -> {target} via {name} is legal but left the mandate in "
                f"{env.work.get_mandate_state(N1)}"
            )
        else:
            with pytest.raises(Exception) as caught:
                call(env.work)
            assert "[EXPECTED]" in str(caught.value), (
                f"{state} -> {target} via {name} must be refused with a classified error, "
                f"got {caught.value!r}"
            )
            assert env.work.get_mandate_state(N1) == state, (
                f"{name} was refused from {state} but still changed the state to "
                f"{env.work.get_mandate_state(N1)}"
            )


# ── no payment surface, SPEC §35-37 (G11 companion) ─────────────────────────


class TestNoPaymentSurface:
    """A behavioural companion to the AST gate, not a replacement for it.

    `scripts/verify-ic-discipline.py payment` is the structural check. This asserts the
    consequence a reader cares about: there is no method on this contract whose name or
    signature offers to move value.
    """

    def test_no_method_names_suggest_moving_value(self):
        tree = _parse(GENLAYER_ROOT / "wrk_work.py")
        forbidden = ("transfer", "withdraw", "pay", "release", "send_value", "deposit", "balance")
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            public = any(
                ast.unparse(d).startswith("gl.public") for d in node.decorator_list
            )
            if public and any(word in node.name.lower() for word in forbidden):
                offenders.append(node.name)
        assert offenders == [], f"payment-shaped public methods: {offenders}"

    def test_the_name_check_detects_a_payment_method(self):
        """Positive control."""
        tree = ast.parse(
            "class C:\n"
            "    @gl.public.write\n"
            "    def transfer_to_worker(self, a, b):\n"
            "        return None\n"
        )
        offenders = [
            node.name
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef)
            and any(ast.unparse(d).startswith("gl.public") for d in node.decorator_list)
            and "transfer" in node.name.lower()
        ]
        assert offenders == ["transfer_to_worker"]
