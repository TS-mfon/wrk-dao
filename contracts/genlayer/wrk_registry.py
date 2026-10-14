# {
#   "Seq": [
#     { "Depends": "py-genlayer-multi:06zyvrlivjga0d5jlpdbprksc0pa6jmllxvp8s20hq1l512vh5yk" },
#     { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
#   ]
# }
#
# Two runners in a Seq, both pinned to concrete hashes.
#
# `py-genlayer-multi` because this contract imports `lib/`, which makes it a multi-file
# contract package. It is an ADDITION, not a replacement: pinning only the multi runner
# makes genvm-lint warn "Missing py-genlayer dependency in header" and then fail
# validation outright with "Failed to load SDK". Both are required, multi first.
#
# Concrete hashes because every GenLayer network rejects `py-genlayer:test`,
# `py-genlayer:latest` and unversioned aliases -- those are local-Studio development
# aliases only, and a contract carrying one deploys nowhere. Both hashes are present in
# the cached v0.2.16 runner set, so the direct-mode tests exercise the same runners the
# networks will.

from genlayer import *

from lib.canonical import canonicalize
from lib.hashing import content_hash
from lib.ids import id_pattern, parse_id
from lib.validation import (
    ValidationError,
    validate_agent_profile,
    validate_dao_metadata,
    validate_dao_rules,
)

import json
import re
from datetime import datetime, timezone

#: Error classification. Every refusal in this contract is deterministic business logic,
#: so every message carries [EXPECTED] and a validator re-running the transaction must
#: see the identical string. The other classes ([EXTERNAL], [TRANSIENT], [LLM_ERROR])
#: belong to contracts that touch the outside world; this one never does.
ERROR_EXPECTED = "[EXPECTED]"


# ── events (docs/ARCHITECTURE.md §9) ────────────────────────────────────────
#
# The read model is event-sourced, not polled. §9 requires every document to carry a
# `chain_ref` and rule 3 forbids creating a document without a corresponding chain event,
# so state that the indexer must see has to be *emitted*, not merely stored. An indexer
# that polled `list_agents()` could not know the transaction or log index a change came
# from, could not be idempotent per event, and could not heal a reorg precisely.
#
# Fields before `/` are indexed (they become log topics); the rest travel in the blob.
# Ids are indexed because they are what the indexer keys an upsert on.
#
# NOTE ON INDEXED FIELD ORDER: the SDK sorts indexed field names alphabetically and binds
# positional arguments to that SORTED order, not to declaration order
# (`indexed_args = tuple(sorted(...))` then `zip(indexed_args, args)`). So an event
# declared `(dao_id, agent_id, /)` and called with `(dao_id, agent_id)` silently files the
# dao id under `agent_id`. Every multi-indexed event below is therefore declared in
# alphabetical order, and `test_cross_contract_events_declare_indexed_fields_in_sorted_order`
# fails the build if a future one is not.


class AgentRegistered(gl.Event):
    def __init__(self, agent_id: str, /, **blob): ...


class AgentProfileUpdated(gl.Event):
    def __init__(self, agent_id: str, /, **blob): ...


class DaoCreated(gl.Event):
    def __init__(self, dao_id: str, /, **blob): ...


class DaoRulesUpdated(gl.Event):
    def __init__(self, dao_id: str, /, **blob): ...


class MemberJoined(gl.Event):
    def __init__(self, agent_id: str, dao_id: str, /, **blob): ...


def _reject(message: str):
    """Raises a classified, consensus-safe error.

    `gl.vm.UserError` rather than a bare `Exception`: a bare exception surfaces as an
    unrecoverable VMError, which a validator cannot compare and which gives the caller
    nothing to act on.
    """
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {message}")


def _now() -> int:
    """Transaction time in Unix seconds.

    `datetime.now(timezone.utc)` inside the GenVM is the deterministic **transaction**
    datetime, identical for every re-executing validator — not host wall-clock. There is
    no block timestamp or block number in the GenLayer execution context.
    """
    return int(datetime.now(timezone.utc).timestamp())


class WrkRegistry(gl.Contract):
    # ── agents ──────────────────────────────────────────────────────────────
    agent_profile: TreeMap[str, str]
    agent_profile_hash: TreeMap[str, str]
    agent_operator: TreeMap[str, str]
    agent_of_operator: TreeMap[str, str]
    agent_registered_at: TreeMap[str, u256]
    agent_ids: DynArray[str]

    # ── DAOs ────────────────────────────────────────────────────────────────
    dao_metadata: TreeMap[str, str]
    dao_metadata_hash: TreeMap[str, str]
    dao_rules: TreeMap[str, str]
    dao_rules_hash: TreeMap[str, str]
    dao_rules_version: TreeMap[str, u256]
    dao_creator: TreeMap[str, str]
    dao_ids: DynArray[str]

    # ── membership ──────────────────────────────────────────────────────────
    # Flat "dao_id|agent_id" keys rather than TreeMap[str, DynArray[str]]. Membership is
    # asked one pair at a time by every permission check, which a flat map answers in one
    # read; enumerating a DAO's members is the read model's job (§9), not a chain scan.
    dao_membership: TreeMap[str, bool]
    dao_member_count: TreeMap[str, u256]

    # ── capability index ────────────────────────────────────────────────────
    # capability_id -> JSON array of dao_ids requiring it. An index rather than a scan:
    # find_daos_requiring used to walk every DAO and re-parse its rules JSON, which is
    # O(n) against the transaction compute limit and gets slower as the protocol grows.
    # Kept in step by _index_capabilities on create and on every rules change.
    capability_daos: TreeMap[str, str]

    def __init__(self) -> None:
        pass

    # ── internal ────────────────────────────────────────────────────────────

    def _sender(self) -> str:
        """The caller's address as a lowercase hex string.

        Stored as a string rather than as `Address` so the value round-trips through
        canonical JSON and the read model unchanged. `Address.as_hex` is the documented
        accessor; `str()` of an Address is not a stable wire format.
        """
        return gl.message.sender_address.as_hex.lower()

    def _require_agent_owner(self, agent_id: str) -> str:
        """Invariant I7. Returns the caller so the caller is used, not re-read."""
        if agent_id not in self.agent_operator:
            _reject(f"unknown agent {agent_id}")
        sender = self._sender()
        owner = self.agent_operator[agent_id]
        if owner.lower() != sender:
            _reject(f"only agent {agent_id}'s own operator may act for it: "
                f"caller {sender} is not {owner.lower()}"
            )
        return sender

    def _require_dao(self, dao_id: str) -> None:
        if dao_id not in self.dao_metadata:
            _reject(f"unknown dao {dao_id}")

    # No @staticmethod anywhere in this class: the GenVM linter requires `self` as the
    # first parameter of every method, so a static helper fails `genvm-lint check`.
    def _membership_key(self, dao_id: str, agent_id: str) -> str:
        return f"{dao_id}|{agent_id}"

    def _index_capabilities(self, dao_id: str, previous: list[str], current: list[str]) -> None:
        """Move `dao_id` between capability buckets.

        Both directions matter. Adding on create is obvious; *removing* when a rules
        change drops a requirement is the half that gets forgotten, and forgetting it
        makes discovery return DAOs that no longer require the capability -- a wrong
        answer that looks like a working feature.
        """
        for capability in previous:
            if capability in current:
                continue
            bucket = json.loads(self.capability_daos[capability]) if capability in self.capability_daos else []
            if dao_id in bucket:
                bucket.remove(dao_id)
                self.capability_daos[capability] = json.dumps(bucket)

        for capability in current:
            bucket = json.loads(self.capability_daos[capability]) if capability in self.capability_daos else []
            if dao_id not in bucket:
                bucket.append(dao_id)
                self.capability_daos[capability] = json.dumps(bucket)

    def _parse_json(self, raw: str, label: str) -> dict:
        try:
            value = json.loads(raw)
        except Exception as error:
            _reject(f"{label} is not valid JSON: {error}")
        if not isinstance(value, dict):
            _reject(f"{label} must be a JSON object")
        return value

    # ── agents: C1, C11 ─────────────────────────────────────────────────────

    @gl.public.write
    def register_agent(self, agent_id: str, profile_json: str) -> str:
        """Register the calling address as `agent_id` with a capability profile.

        One agent per address and one address per agent. Without that, a single operator
        could hold several agent identities and a DAO's membership rules would mean
        nothing — the same party could propose, accept and vouch under three names.
        """
        if not re.match(id_pattern("agt"), agent_id):
            _reject(f"{agent_id} is not an agt_ prefixed ULID")
        if agent_id in self.agent_operator:
            _reject(f"agent {agent_id} is already registered")

        sender = self._sender()
        if sender in self.agent_of_operator:
            _reject(f"address {sender} already controls agent {self.agent_of_operator[sender]}"
            )

        profile = self._parse_json(profile_json, "profile")
        try:
            validate_agent_profile(profile)
        except ValidationError as error:
            _reject(str(error))

        if profile["agent_id"] != agent_id:
            _reject(f"profile declares agent_id {profile['agent_id']} but was registered as {agent_id}"
            )
        if profile["operator"].lower() != sender:
            _reject(f"profile declares operator {profile['operator'].lower()} but the caller is {sender}"
            )

        canonical = canonicalize(profile)
        self.agent_profile[agent_id] = canonical
        self.agent_profile_hash[agent_id] = content_hash(profile)
        self.agent_operator[agent_id] = sender
        self.agent_of_operator[sender] = agent_id
        self.agent_registered_at[agent_id] = u256(_now())
        self.agent_ids.append(agent_id)
        AgentRegistered(
            agent_id,
            operator=sender,
            profile_hash=self.agent_profile_hash[agent_id],
            registered_at=u256(_now()),
        ).emit()
        return self.agent_profile_hash[agent_id]

    @gl.public.write
    def update_agent_profile(self, agent_id: str, profile_json: str) -> str:
        """Replace an agent's profile. Caller must be that agent's operator (I7).

        The operator address itself cannot be changed here: rotating the controlling key
        would let a compromised profile update hand the identity away, and every
        permission check in the protocol reads that address.
        """
        self._require_agent_owner(agent_id)

        profile = self._parse_json(profile_json, "profile")
        try:
            validate_agent_profile(profile)
        except ValidationError as error:
            _reject(str(error))
        if profile["agent_id"] != agent_id:
            _reject("profile declares a different agent_id")
        if profile["operator"].lower() != self.agent_operator[agent_id].lower():
            _reject("an agent's operator address cannot be changed by a profile update")

        self.agent_profile[agent_id] = canonicalize(profile)
        self.agent_profile_hash[agent_id] = content_hash(profile)
        AgentProfileUpdated(agent_id, profile_hash=self.agent_profile_hash[agent_id]).emit()
        return self.agent_profile_hash[agent_id]

    # ── DAOs: C2, C3, C4, C5 ────────────────────────────────────────────────

    @gl.public.write
    def create_dao(self, dao_id: str, creator_agent_id: str, metadata_json: str, rules_json: str) -> str:
        """Create a DAO. The creating agent becomes its first member.

        The creator is a member **by construction and is not subject to the DAO's own
        `required_capabilities`**. That exemption is deliberate and is stated here because
        an unstated exemption to a membership rule is a trap for whoever reads the rule
        next.

        The reasoning: SPEC §7 describes membership as something an agent acquires by
        *applying* — DISCOVERED, APPLIED, SELECTED — and `required_capabilities` gates that
        application. A creator does not apply. Requiring them to hold every capability
        their DAO demands of workers would block the ordinary case of an organizer who
        commissions work they cannot perform themselves: a DAO that buys security audits
        would need its founder to be an auditor.

        What this costs is that a DAO can hold one member who does not meet its stated
        worker bar. That is bounded: the creator still cannot *win* a mandate without
        capabilities, because selection judges proposals against the mission's criteria,
        and `create_mission` only requires membership, not capability.
        """
        if not re.match(id_pattern("dao"), dao_id):
            _reject(f"{dao_id} is not a dao_ prefixed ULID")
        if dao_id in self.dao_metadata:
            _reject(f"dao {dao_id} already exists")
        self._require_agent_owner(creator_agent_id)

        metadata = self._parse_json(metadata_json, "metadata")
        rules = self._parse_json(rules_json, "rules")
        try:
            validate_dao_metadata(metadata)
            validate_dao_rules(rules)
        except ValidationError as error:
            _reject(str(error))

        if metadata["dao_id"] != dao_id or rules["dao_id"] != dao_id:
            _reject("metadata and rules must both declare this dao_id")
        if metadata["creator_agent_id"] != creator_agent_id:
            _reject("metadata declares a different creator_agent_id")
        if rules["version"] != 1:
            _reject("a new DAO's rules must start at version 1")

        self.dao_metadata[dao_id] = canonicalize(metadata)
        self.dao_metadata_hash[dao_id] = content_hash(metadata)
        self.dao_rules[dao_id] = canonicalize(rules)
        self.dao_rules_hash[dao_id] = content_hash(rules)
        self.dao_rules_version[dao_id] = u256(1)
        self.dao_creator[dao_id] = creator_agent_id
        self.dao_ids.append(dao_id)

        self.dao_membership[self._membership_key(dao_id, creator_agent_id)] = True
        self.dao_member_count[dao_id] = u256(1)
        self._index_capabilities(dao_id, [], rules["required_capabilities"])

        DaoCreated(
            dao_id,
            creator_agent_id=creator_agent_id,
            metadata_hash=self.dao_metadata_hash[dao_id],
            rules_hash=self.dao_rules_hash[dao_id],
            rules_version=u256(1),
        ).emit()
        # The creator's membership is a membership like any other, so it emits like any
        # other. Omitting it would leave the read model with a DAO whose member_count is 1
        # and whose member list is empty -- a discrepancy that looks like indexer lag.
        MemberJoined(creator_agent_id, dao_id, mode="created").emit()
        return self.dao_metadata_hash[dao_id]

    @gl.public.write
    def update_dao_rules(self, dao_id: str, rules_json: str) -> str:
        """Replace a DAO's rules, incrementing the version.

        **Rules never apply retroactively.** A mandate records the rules version it was
        created under, so a DAO cannot change the terms after work has begun — that is
        invariant I8 wearing different clothes. This contract enforces the monotonic
        version; `wrk_work` is what records it on each mandate.
        """
        self._require_dao(dao_id)
        self._require_agent_owner(self.dao_creator[dao_id])

        rules = self._parse_json(rules_json, "rules")
        try:
            validate_dao_rules(rules)
        except ValidationError as error:
            _reject(str(error))
        if rules["dao_id"] != dao_id:
            _reject("rules declare a different dao_id")

        current = int(self.dao_rules_version[dao_id])
        if rules["version"] != current + 1:
            _reject(f"rules version must be {current + 1}, got {rules['version']}")

        previous = json.loads(self.dao_rules[dao_id])["required_capabilities"]
        self._index_capabilities(dao_id, previous, rules["required_capabilities"])

        self.dao_rules[dao_id] = canonicalize(rules)
        self.dao_rules_hash[dao_id] = content_hash(rules)
        self.dao_rules_version[dao_id] = u256(rules["version"])
        DaoRulesUpdated(
            dao_id,
            rules_hash=self.dao_rules_hash[dao_id],
            rules_version=u256(rules["version"]),
        ).emit()
        return self.dao_rules_hash[dao_id]

    # ── membership ──────────────────────────────────────────────────────────

    @gl.public.write
    def join_dao(self, dao_id: str, agent_id: str) -> bool:
        """Join an open DAO. Caller must be the agent's operator (I7).

        Refused when the DAO's rules require capabilities the agent's profile does not
        declare. The check reads the agent's own stored profile, not anything the caller
        passes in, so an agent cannot claim a capability at join time that it has not
        published evidence for.
        """
        self._require_dao(dao_id)
        self._require_agent_owner(agent_id)

        key = self._membership_key(dao_id, agent_id)
        if key in self.dao_membership and self.dao_membership[key]:
            _reject(f"agent {agent_id} is already a member of {dao_id}")

        rules = json.loads(self.dao_rules[dao_id])
        if rules["membership"] != "open":
            _reject(f"dao {dao_id} is invite-only")

        required = rules["required_capabilities"]
        if required:
            profile = json.loads(self.agent_profile[agent_id])
            held = [c["capability_id"] for c in profile["capabilities"]]
            missing = [c for c in required if c not in held]
            if missing:
                _reject(f"agent {agent_id} lacks required capabilit(ies): {', '.join(missing)}"
                )

        self.dao_membership[key] = True
        self.dao_member_count[dao_id] = u256(int(self.dao_member_count[dao_id]) + 1)
        MemberJoined(agent_id, dao_id, mode="joined").emit()
        return True

    @gl.public.write
    def invite_agent(self, dao_id: str, agent_id: str) -> bool:
        """Add an agent to an invite-only DAO. Only the DAO creator's operator may call."""
        self._require_dao(dao_id)
        self._require_agent_owner(self.dao_creator[dao_id])
        if agent_id not in self.agent_operator:
            _reject(f"unknown agent {agent_id}")

        key = self._membership_key(dao_id, agent_id)
        if key in self.dao_membership and self.dao_membership[key]:
            _reject(f"agent {agent_id} is already a member of {dao_id}")

        self.dao_membership[key] = True
        self.dao_member_count[dao_id] = u256(int(self.dao_member_count[dao_id]) + 1)
        MemberJoined(agent_id, dao_id, mode="invited").emit()
        return True

    # ── reads: C3, C6 ───────────────────────────────────────────────────────

    @gl.public.view
    def get_agent(self, agent_id: str) -> str:
        if agent_id not in self.agent_profile:
            _reject(f"unknown agent {agent_id}")
        return self.agent_profile[agent_id]

    @gl.public.view
    def get_agent_hash(self, agent_id: str) -> str:
        if agent_id not in self.agent_profile_hash:
            _reject(f"unknown agent {agent_id}")
        return self.agent_profile_hash[agent_id]

    @gl.public.view
    def get_agent_operator(self, agent_id: str) -> str:
        if agent_id not in self.agent_operator:
            _reject(f"unknown agent {agent_id}")
        return self.agent_operator[agent_id]

    @gl.public.view
    def agent_of_address(self, address: str) -> str:
        key = address.lower()
        return self.agent_of_operator[key] if key in self.agent_of_operator else ""

    @gl.public.view
    def agent_count(self) -> int:
        return len(self.agent_ids)

    @gl.public.view
    def list_agents(self) -> list[str]:
        return list(self.agent_ids)

    @gl.public.view
    def get_dao(self, dao_id: str) -> str:
        self._require_dao(dao_id)
        return self.dao_metadata[dao_id]

    @gl.public.view
    def get_dao_hash(self, dao_id: str) -> str:
        self._require_dao(dao_id)
        return self.dao_metadata_hash[dao_id]

    @gl.public.view
    def get_dao_rules(self, dao_id: str) -> str:
        self._require_dao(dao_id)
        return self.dao_rules[dao_id]

    @gl.public.view
    def get_dao_rules_hash(self, dao_id: str) -> str:
        self._require_dao(dao_id)
        return self.dao_rules_hash[dao_id]

    @gl.public.view
    def get_dao_rules_version(self, dao_id: str) -> int:
        self._require_dao(dao_id)
        return int(self.dao_rules_version[dao_id])

    @gl.public.view
    def get_dao_creator(self, dao_id: str) -> str:
        self._require_dao(dao_id)
        return self.dao_creator[dao_id]

    @gl.public.view
    def dao_count(self) -> int:
        return len(self.dao_ids)

    @gl.public.view
    def list_daos(self) -> list[str]:
        """Every DAO id, in creation order.

        Deterministic because `DynArray` preserves insertion order and ids are ULIDs, so
        creation order and lexicographic order agree. Callers that need filtering should
        use the read model; this exists so the read model can be rebuilt from chain alone.
        """
        return list(self.dao_ids)

    @gl.public.view
    def is_member(self, dao_id: str, agent_id: str) -> bool:
        key = self._membership_key(dao_id, agent_id)
        return key in self.dao_membership and self.dao_membership[key]

    @gl.public.view
    def member_count(self, dao_id: str) -> int:
        self._require_dao(dao_id)
        return int(self.dao_member_count[dao_id])

    @gl.public.view
    def find_daos_requiring(self, capability_id: str) -> list[str]:
        """DAOs whose rules require `capability_id`.

        One index read. The earlier implementation scanned every DAO and re-parsed its
        rules JSON; that is O(n) against the transaction compute limit and degrades as
        the protocol grows, which is exactly the shape the GenLayer guidance warns about.
        """
        if capability_id not in self.capability_daos:
            return []
        return json.loads(self.capability_daos[capability_id])

    @gl.public.view
    def list_agent_capabilities(self, agent_id: str) -> list[str]:
        """The capability ids an agent's stored profile declares.

        Exists so a caller can see what an agent claims without parsing the whole profile,
        and so the reason behind `can_agent_join`'s answer is independently checkable: the
        join check compares a DAO's `required_capabilities` against exactly this list.
        """
        if agent_id not in self.agent_profile:
            _reject(f"unknown agent {agent_id}")
        profile = json.loads(self.agent_profile[agent_id])
        return [capability["capability_id"] for capability in profile["capabilities"]]

    @gl.public.view
    def can_agent_join(self, dao_id: str, agent_id: str) -> str:
        """Why an agent could or could not join, as a readable string.

        Exists so the UI and an agent can see the reason *before* spending a transaction
        on a refusal. Returns "ok" or the specific obstacle.
        """
        if dao_id not in self.dao_metadata:
            return f"unknown dao {dao_id}"
        if agent_id not in self.agent_profile:
            return f"unknown agent {agent_id}"
        if self.is_member(dao_id, agent_id):
            return "already a member"

        rules = json.loads(self.dao_rules[dao_id])
        if rules["membership"] != "open":
            return "invite-only"

        required = rules["required_capabilities"]
        if required:
            profile = json.loads(self.agent_profile[agent_id])
            held = [c["capability_id"] for c in profile["capabilities"]]
            missing = [c for c in required if c not in held]
            if missing:
                return f"missing capabilit(ies): {', '.join(missing)}"
        return "ok"
