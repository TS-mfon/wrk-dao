"""wrk_registry — agents, DAOs, rules, membership.

Test names carry the `-k` selectors leaf-1.2.1's gates filter on: agent, dao_creation,
registry, metadata, rules, discovery, capability, acting_for_another.
"""

import json

import pytest

A1 = "agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A"
A2 = "agt_01JQ8ZC1D2E3F4G5H6J7K8M9N0"
A3 = "agt_01JQ8ZD1E2F3G4H5J6K7M8N9P0"
D1 = "dao_01JQ8Z1A2B3C4D5E6F7G8H9J0K"
D2 = "dao_01JQ8Z2B3C4D5E6F7G8H9J0K1M"


def as_bytes(value) -> bytes:
    """Normalise a harness address to raw bytes.

    The `direct_alice/bob/charlie` fixtures call `create_address`, which returns raw
    bytes while the GenVM SDK is unimportable and an `Address` once it is. The SDK is
    imported by the first deployment and `sys.modules` persists for the whole session, so
    the type a fixture hands back depends on whether an earlier test deployed anything --
    the first test in a run sees bytes and the rest see Address.
    `vm.sender` must be bytes either way, or the contract raises
    "cannot convert 'Address' object to bytes" from inside the VM. Twelve tests failed
    that way before this helper existed.
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


def addr(value) -> str:
    """Lowercase 0x hex, the form the contract stores."""
    return "0x" + as_bytes(value).hex()


def profile(agent_id, operator, caps=("coding",), name="Agent"):
    return json.dumps(
        {
            "schema_version": 1,
            "agent_id": agent_id,
            "name": name,
            "operator": operator,
            "capabilities": [
                {
                    "capability_id": c,
                    "name": c,
                    "description": f"Can do {c}.",
                    "version": "1",
                    "evidence": f"https://example.com/evidence/{c}",
                }
                for c in caps
            ],
            "created_at_unix": 1790000000,
        }
    )


def metadata(dao_id, creator, name="Protocol DAO"):
    return json.dumps(
        {
            "schema_version": 1,
            "dao_id": dao_id,
            "name": name,
            "purpose": "Commission and adjudicate protocol work.",
            "creator_agent_id": creator,
            "created_at_unix": 1790000000,
        }
    )


def rules(dao_id, version=1, membership="open", required=(), budget="1000000000", min_criteria=1):
    return json.dumps(
        {
            "schema_version": 1,
            "dao_id": dao_id,
            "version": version,
            "membership": membership,
            "required_capabilities": list(required),
            "max_mission_budget_atomic": budget,
            "min_acceptance_criteria": min_criteria,
        }
    )


@pytest.fixture
def registry(deploy):
    return deploy("wrk_registry.py")


def register(registry, vm, who, agent_id, caps=("coding",)):
    vm.sender = as_bytes(who)
    return registry.register_agent(agent_id, profile(agent_id, addr(who), caps))


# ── agents (G2) ─────────────────────────────────────────────────────────────


class TestAgent:
    def test_agent_registers_and_is_readable_by_id(self, registry, direct_vm):
        h = register(registry, direct_vm, direct_vm.sender, A1)
        assert h.startswith("0x") and len(h) == 66
        assert registry.agent_count() == 1
        assert registry.list_agents() == [A1]
        assert registry.get_agent_hash(A1) == h
        stored = json.loads(registry.get_agent(A1))
        assert stored["agent_id"] == A1
        assert stored["capabilities"][0]["capability_id"] == "coding"

    def test_agent_profile_is_stored_canonically_not_as_sent(self, registry, direct_vm):
        """Key order must not survive. Two callers sending the same object differently
        would otherwise produce two stored strings and two hashes for one agent."""
        op = addr(direct_vm.sender)
        reordered = json.dumps(json.loads(profile(A1, op)), sort_keys=False)
        scrambled = json.dumps(
            {k: v for k, v in reversed(list(json.loads(reordered).items()))}
        )
        registry.register_agent(A1, scrambled)
        stored = registry.get_agent(A1)
        assert stored == json.dumps(json.loads(stored), sort_keys=True, separators=(",", ":"))

    def test_agent_id_must_be_a_valid_ulid(self, registry):
        with pytest.raises(Exception, match="agt_ prefixed ULID"):
            registry.register_agent("agt_not-a-ulid", profile("agt_not-a-ulid", "0x" + "11" * 20))

    def test_agent_id_rejects_an_invalid_crockford_character(self, registry, direct_vm):
        """U is excluded from Crockford base32. This is the defect that was found in the
        frozen fixtures, asserted here as a contract-level refusal."""
        bad = "agt_01JQ8Z0Q1R2S3T4U5V6W7X8Y9Z"
        with pytest.raises(Exception, match="agt_ prefixed ULID"):
            registry.register_agent(bad, profile(bad, addr(direct_vm.sender)))

    def test_second_registration_of_the_same_agent_is_refused(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="already registered"):
            registry.register_agent(A1, profile(A1, addr(direct_bob)))

    def test_one_address_cannot_control_two_agents(self, registry, direct_vm):
        """Otherwise one operator holds several identities and membership rules mean
        nothing — the same party could propose, accept and vouch under three names."""
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="already controls agent"):
            registry.register_agent(A2, profile(A2, addr(direct_vm.sender)))

    def test_profile_must_declare_the_calling_operator(self, registry, direct_vm):
        with pytest.raises(Exception, match="but the caller is"):
            registry.register_agent(A1, profile(A1, "0x" + "ee" * 20))

    def test_profile_must_declare_its_own_agent_id(self, registry, direct_vm):
        with pytest.raises(Exception, match="but was registered as"):
            registry.register_agent(A1, profile(A2, addr(direct_vm.sender)))

    def test_malformed_json_is_refused(self, registry):
        with pytest.raises(Exception, match="not valid JSON"):
            registry.register_agent(A1, "{not json")

    def test_profile_update_replaces_it(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        before = registry.get_agent_hash(A1)
        registry.update_agent_profile(
            A1, profile(A1, addr(direct_vm.sender), caps=("coding", "research"))
        )
        assert registry.get_agent_hash(A1) != before
        assert len(json.loads(registry.get_agent(A1))["capabilities"]) == 2

    def test_profile_update_cannot_rotate_the_operator(self, registry, direct_vm):
        """Rotating the controlling key via a profile update would let a compromised
        update hand the identity away, and every permission check reads that address."""
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="operator address cannot be changed"):
            registry.update_agent_profile(A1, profile(A1, "0x" + "cc" * 20))


# ── capability profiles (G8) ────────────────────────────────────────────────


class TestCapability:
    def test_capability_list_is_readable_for_a_registered_agent(self, registry, direct_vm):
        """The capability ids a profile declares, without parsing the whole profile.

        This is the same list join_dao compares against a DAO's required_capabilities, so
        exposing it makes can_agent_join's answer independently checkable.
        """
        register(registry, direct_vm, direct_vm.sender, A1, caps=("coding", "security-analysis"))
        assert registry.list_agent_capabilities(A1) == ["coding", "security-analysis"]

    def test_capability_list_reflects_a_profile_update(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1, caps=("coding",))
        assert registry.list_agent_capabilities(A1) == ["coding"]
        registry.update_agent_profile(
            A1, profile(A1, addr(direct_vm.sender), caps=("coding", "research"))
        )
        assert registry.list_agent_capabilities(A1) == ["coding", "research"]

    def test_capability_list_of_an_unknown_agent_is_refused(self, registry):
        with pytest.raises(Exception, match="unknown agent"):
            registry.list_agent_capabilities(A1)

    def test_capability_list_agrees_with_what_can_agent_join_checks(
        self, registry, direct_vm, direct_bob
    ):
        """Pins the two against each other on the path the rule actually governs.

        The *joining* agent, not the creator: a creator is a member by construction and is
        exempt from `required_capabilities` (see `create_dao`), so asserting against the
        creator would measure the exemption rather than the gate.
        """
        register(registry, direct_vm, direct_vm.sender, A1, caps=("coding",))
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("security-analysis",)))

        register(registry, direct_vm, direct_bob, A2, caps=("coding",))
        held = registry.list_agent_capabilities(A2)
        assert "security-analysis" not in held
        assert "security-analysis" in registry.can_agent_join(D1, A2)
        with pytest.raises(Exception, match="lacks required capabilit"):
            registry.join_dao(D1, A2)

    def test_capability_the_dao_creator_is_exempt_from_its_required_capabilities(
        self, registry, direct_vm
    ):
        """The exemption, asserted rather than left implicit.

        SPEC §7 makes membership something an agent acquires by applying, and
        `required_capabilities` gates that application; a creator does not apply. Stated as
        a test so the behaviour is visible instead of being discovered later.
        """
        register(registry, direct_vm, direct_vm.sender, A1, caps=("coding",))
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("security-analysis",)))
        assert registry.is_member(D1, A1) is True
        assert "security-analysis" not in registry.list_agent_capabilities(A1)
        assert registry.can_agent_join(D1, A1) == "already a member"

    def test_capability_requires_structured_fields(self, registry, direct_vm):
        """SPEC §20: capabilities are not bare strings."""
        payload = json.loads(profile(A1, addr(direct_vm.sender)))
        payload["capabilities"] = ["coding"]
        with pytest.raises(Exception, match="expected an object"):
            registry.register_agent(A1, json.dumps(payload))

    def test_capability_without_evidence_is_refused(self, registry, direct_vm):
        payload = json.loads(profile(A1, addr(direct_vm.sender)))
        del payload["capabilities"][0]["evidence"]
        with pytest.raises(Exception, match="missing required field"):
            registry.register_agent(A1, json.dumps(payload))

    def test_capability_evidence_must_be_https(self, registry, direct_vm):
        payload = json.loads(profile(A1, addr(direct_vm.sender)))
        payload["capabilities"][0]["evidence"] = "ftp://example.com/x"
        with pytest.raises(Exception, match="https"):
            registry.register_agent(A1, json.dumps(payload))

    def test_duplicate_capability_is_refused(self, registry, direct_vm):
        payload = json.loads(profile(A1, addr(direct_vm.sender), caps=("coding",)))
        payload["capabilities"].append(dict(payload["capabilities"][0]))
        with pytest.raises(Exception, match="duplicate capability"):
            registry.register_agent(A1, json.dumps(payload))

    def test_an_agent_must_declare_at_least_one_capability(self, registry, direct_vm):
        payload = json.loads(profile(A1, addr(direct_vm.sender)))
        payload["capabilities"] = []
        with pytest.raises(Exception, match="length must be"):
            registry.register_agent(A1, json.dumps(payload))


# ── DAO creation (G3) ───────────────────────────────────────────────────────


class TestDaoCreation:
    def test_dao_creation_makes_its_creator_the_first_member(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        h = registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        assert h.startswith("0x")
        assert registry.dao_count() == 1
        assert registry.get_dao_creator(D1) == A1
        assert registry.is_member(D1, A1) is True
        assert registry.member_count(D1) == 1
        assert registry.get_dao_rules_version(D1) == 1

    def test_dao_id_must_be_a_valid_ulid(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="dao_ prefixed ULID"):
            registry.create_dao("dao_bad", A1, metadata("dao_bad", A1), rules("dao_bad"))

    def test_duplicate_dao_is_refused(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        with pytest.raises(Exception, match="already exists"):
            registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))

    def test_metadata_and_rules_must_agree_on_the_dao_id(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="must both declare this dao_id"):
            registry.create_dao(D1, A1, metadata(D2, A1), rules(D1))

    def test_a_new_dao_must_start_at_rules_version_one(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="must start at version 1"):
            registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, version=2))

    def test_creating_a_dao_for_an_unregistered_agent_is_refused(self, registry):
        with pytest.raises(Exception, match="unknown agent"):
            registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))


# ── registry listing (G4) ───────────────────────────────────────────────────


class TestRegistry:
    def test_registry_lists_daos_deterministically(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        registry.create_dao(D2, A1, metadata(D2, A1), rules(D2))
        first = registry.list_daos()
        assert first == [D1, D2]
        assert registry.list_daos() == first, "the same query must return the same order"
        assert first == sorted(first), "ULIDs sort in creation order, so the two agree"

    def test_registry_counts_agree_with_the_lists(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        register(registry, direct_vm, direct_bob, A2)
        assert registry.agent_count() == len(registry.list_agents()) == 2
        assert registry.dao_count() == len(registry.list_daos()) == 1

    def test_address_to_agent_lookup_is_exact_and_total(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        assert registry.agent_of_address(addr(direct_vm.sender)) == A1
        assert registry.agent_of_address("0x" + "99" * 20) == ""


# ── metadata integrity (G5) ─────────────────────────────────────────────────


class TestMetadata:
    def test_metadata_is_stored_with_its_content_hash(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        h = registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        assert registry.get_dao_hash(D1) == h

    def test_a_tampered_payload_does_not_match_the_stored_hash(self, registry, direct_vm):
        """The point of storing a content hash: anyone can detect a substituted payload."""
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        stored_hash = registry.get_dao_hash(D1)

        tampered = json.loads(registry.get_dao(D1))
        tampered["purpose"] = "Something the DAO never agreed to."
        import hashlib  # noqa: F401 -- not used; the contract's hash is the oracle

        # Re-registering the tampered object under a second id yields a different hash,
        # which is what makes the original detectable.
        tampered["dao_id"] = D2
        registry.create_dao(D2, A1, json.dumps({**tampered, "creator_agent_id": A1}), rules(D2))
        assert registry.get_dao_hash(D2) != stored_hash

    def test_metadata_must_name_its_creator(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="different creator_agent_id"):
            registry.create_dao(D1, A1, metadata(D1, A2), rules(D1))


# ── rules (G6) ──────────────────────────────────────────────────────────────


class TestRules:
    def test_rules_gate_membership_on_capability(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1, caps=("coding", "security-analysis"))
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("security-analysis",)))

        register(registry, direct_vm, direct_bob, A2, caps=("coding",))
        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="lacks required capabilit"):
            registry.join_dao(D1, A2)
        assert registry.is_member(D1, A2) is False
        # And the read-only path explains the same obstacle without spending a tx.
        assert "missing capabilit" in registry.can_agent_join(D1, A2)

    def test_an_agent_holding_the_capability_may_join(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("coding",)))
        register(registry, direct_vm, direct_bob, A2, caps=("coding",))
        direct_vm.sender = as_bytes(direct_bob)
        assert registry.join_dao(D1, A2) is True
        assert registry.is_member(D1, A2) is True
        assert registry.member_count(D1) == 2

    def test_invite_only_refuses_self_service_joining(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, membership="invite"))
        register(registry, direct_vm, direct_bob, A2)
        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="invite-only"):
            registry.join_dao(D1, A2)

    def test_only_the_creator_may_invite(self, registry, direct_vm, direct_bob, direct_charlie):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, membership="invite"))
        register(registry, direct_vm, direct_bob, A2)
        register(registry, direct_vm, direct_charlie, A3)

        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.invite_agent(D1, A2)

        direct_vm.sender = as_bytes(direct_charlie)
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.invite_agent(D1, A3)

    def test_rules_version_must_increment_by_exactly_one(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        with pytest.raises(Exception, match="version must be 2"):
            registry.update_dao_rules(D1, rules(D1, version=3))
        registry.update_dao_rules(D1, rules(D1, version=2, required=("coding",)))
        assert registry.get_dao_rules_version(D1) == 2

    def test_a_rules_change_does_not_retroactively_alter_an_earlier_version(
        self, registry, direct_vm
    ):
        """Rules never apply retroactively. The version is how a reader tells which rules
        applied to a mandate — invariant I8 in another costume."""
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        v1_hash = registry.get_dao_rules_hash(D1) if hasattr(registry, "get_dao_rules_hash") else None
        v1 = json.loads(registry.get_dao_rules(D1))
        assert v1["version"] == 1 and v1["required_capabilities"] == []

        registry.update_dao_rules(D1, rules(D1, version=2, required=("security-analysis",)))
        v2 = json.loads(registry.get_dao_rules(D1))
        assert v2["version"] == 2
        assert v1["required_capabilities"] == [], "the version 1 object read earlier is unchanged"
        assert registry.get_dao_rules_version(D1) == 2
        del v1_hash

    def test_unknown_membership_mode_is_refused(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        with pytest.raises(Exception, match="membership must be"):
            registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, membership="whenever"))

    def test_joining_twice_is_refused(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        register(registry, direct_vm, direct_bob, A2)
        direct_vm.sender = as_bytes(direct_bob)
        registry.join_dao(D1, A2)
        with pytest.raises(Exception, match="already a member"):
            registry.join_dao(D1, A2)
        assert registry.member_count(D1) == 2, "a refused join must not inflate the count"


# ── discovery (G7) ──────────────────────────────────────────────────────────


class TestDiscovery:
    def test_discovery_filters_by_required_capability(self, registry, direct_vm):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("security-analysis",)))
        registry.create_dao(D2, A1, metadata(D2, A1), rules(D2, required=("coding",)))

        assert registry.find_daos_requiring("security-analysis") == [D1]
        assert registry.find_daos_requiring("coding") == [D2]
        assert registry.find_daos_requiring("nonexistent") == []

    def test_discovery_explains_eligibility_before_a_transaction_is_spent(
        self, registry, direct_vm, direct_bob
    ):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("security-analysis",)))
        register(registry, direct_vm, direct_bob, A2, caps=("coding",))

        assert registry.can_agent_join(D1, A1) == "already a member"
        assert "missing capabilit" in registry.can_agent_join(D1, A2)
        assert registry.can_agent_join(D2, A2).startswith("unknown dao")
        assert registry.can_agent_join(D1, A3).startswith("unknown agent")

    def test_discovery_says_ok_when_an_agent_really_can_join(
        self, registry, direct_vm, direct_bob
    ):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1, required=("coding",)))
        register(registry, direct_vm, direct_bob, A2, caps=("coding",))
        assert registry.can_agent_join(D1, A2) == "ok"
        direct_vm.sender = as_bytes(direct_bob)
        assert registry.join_dao(D1, A2) is True


# ── invariant I7 (G9) ───────────────────────────────────────────────────────


class TestActingForAnother:
    def test_acting_for_another_agent_is_refused_on_every_write(
        self, registry, direct_vm, direct_bob
    ):
        """Three separate attempts, because each is a different missing guard."""
        register(registry, direct_vm, direct_vm.sender, A1)
        register(registry, direct_vm, direct_bob, A2)

        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.update_agent_profile(A1, profile(A1, addr(direct_vm.sender)))
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))

        direct_vm.sender = as_bytes(direct_bob)
        registry.create_dao(D2, A2, metadata(D2, A2), rules(D2))
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.join_dao(D2, A1)

    def test_a_stranger_cannot_change_a_dao_s_rules(self, registry, direct_vm, direct_bob):
        register(registry, direct_vm, direct_vm.sender, A1)
        registry.create_dao(D1, A1, metadata(D1, A1), rules(D1))
        register(registry, direct_vm, direct_bob, A2)
        direct_vm.sender = as_bytes(direct_bob)
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.update_dao_rules(D1, rules(D1, version=2))
        assert registry.get_dao_rules_version(D1) == 1

    def test_an_unregistered_caller_can_act_for_nobody(self, registry, direct_vm, direct_charlie):
        register(registry, direct_vm, direct_vm.sender, A1)
        direct_vm.sender = as_bytes(direct_charlie)
        with pytest.raises(Exception, match="own operator may act for it"):
            registry.update_agent_profile(A1, profile(A1, addr(direct_charlie)))
