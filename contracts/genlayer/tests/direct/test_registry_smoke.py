"""Smoke test: does wrk_registry load and work at all under the GenVM?"""
import json


def _profile(agent_id, operator, caps=("coding",)):
    return json.dumps({
        "schema_version": 1, "agent_id": agent_id, "name": "A", "operator": operator,
        "capabilities": [{"capability_id": c, "name": c, "description": "d",
                          "version": "1", "evidence": "https://e/x"} for c in caps],
        "created_at_unix": 1790000000,
    })


def test_register_and_read(deploy, direct_vm):
    r = deploy("wrk_registry.py")
    # direct_vm.sender is raw bytes in the harness; gl.message.sender_address inside the
    # contract is an Address. Convert here rather than assuming they are the same type.
    op = "0x" + bytes(direct_vm.sender).hex()
    a = "agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A"
    h = r.register_agent(a, _profile(a, op))
    assert h.startswith("0x") and len(h) == 66
    assert r.agent_count() == 1
    assert r.get_agent_operator(a) == op
    assert json.loads(r.get_agent(a))["agent_id"] == a
