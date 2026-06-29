# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
Hermetic unit tests for the agent-runtime IR interpreter (Approach A).

NO network: a fake ``model_call`` and a fake ``tool_call`` are injected, so the
graph walk, the governed-tool chokepoint and the prompt-injection defense are
all exercised deterministically. These tests are the verification gates from the
build spec (supervisor reaches END, every tool is governed, allow/deny/approval
effects, model-call count + context-as-DATA system prompt, recursionLimit +
disabledAgents, write-flag detection).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import interpreter  # noqa: E402


def node(id, tools, supervisor=False, members=None, prompt="", memory="", model=None):
    return {
        "id": id,
        "kind": "react",
        "prompt": prompt,
        "memory": memory,
        "tools": list(tools),
        "model": model,
        "supervisor": supervisor,
        "members": members or [],
    }


def supervisor_worker_ir():
    return {
        "entrypoint": "sup",
        "startEdge": {"from": "START", "to": "sup"},
        "nodes": [
            node("sup", ["retrieve"], supervisor=True, members=["worker"],
                 prompt="You supervise the team."),
            node("worker", ["write_file"], prompt="You do the work.", memory="prior notes"),
        ],
        "memberEdges": [{"from": "worker", "to": "sup"}],
        "conditionalEdges": [{"source": "sup", "targets": ["worker", "END"]}],
        "commands": [],
        "channels": {},
    }


class FakeModel:
    """Records every (node_id, system_prompt, user_prompt) the walk asks for."""

    def __init__(self):
        self.calls = []

    def __call__(self, n, system_prompt, user_prompt):
        self.calls.append((n["id"], system_prompt, user_prompt))
        return "model-output-for-" + n["id"]


def fake_tool_factory(effects):
    """Return a tool_call that maps a tool name -> effect (default 'allow')."""
    seen = []

    def tool_call(node_id, tool, args, write):
        seen.append({"node": node_id, "tool": tool, "args": args, "write": write})
        effect = effects.get(tool, "allow")
        return {"effect": effect, "reason": effect, "output": {"ok": effect == "allow"}}

    tool_call.seen = seen
    return tool_call


def run(ir, **kw):
    kw.setdefault("prompt", "do the thing")
    kw.setdefault("recursion_limit", 25)
    kw.setdefault("timeout_ms", 60000)
    kw.setdefault("disabled_agents", [])
    kw.setdefault("model_call", FakeModel())
    kw.setdefault("tool_call", fake_tool_factory({}))
    return interpreter.run_ir(ir, **kw)


# --- gate 1: supervisor+worker reaches END; path includes both --------------
def test_supervisor_worker_reaches_end():
    res = run(supervisor_worker_ir())
    assert res["reachedEnd"] is True
    assert res["ok"] is True
    assert "sup" in res["path"] and "worker" in res["path"]
    # supervisor before its member
    assert res["path"].index("sup") < res["path"].index("worker")


# --- gate 2: EVERY tool in EVERY node is a governed step --------------------
def test_every_tool_is_governed():
    ir = supervisor_worker_ir()
    tool_call = fake_tool_factory({})
    res = run(ir, tool_call=tool_call)
    expected = {(n["id"], t) for n in ir["nodes"] for t in n["tools"]}
    got = {(s["node"], s["tool"]) for s in res["steps"]}
    assert got == expected
    # traces == number of governed tool calls == len(steps)
    assert res["traces"] == len(res["steps"]) == len(tool_call.seen)


# --- gate 3: allow / deny / requires_approval effects + ran flag ------------
def test_allow_deny_approval_effects():
    ir = {
        "entrypoint": "a",
        "startEdge": {"from": "START", "to": "a"},
        "nodes": [node("a", ["retrieve", "secret_tool", "connection_crm_write"])],
        "memberEdges": [],
        "conditionalEdges": [],
        "commands": [],
        "channels": {},
    }
    tool_call = fake_tool_factory({
        "retrieve": "allow",
        "secret_tool": "deny",
        "connection_crm_write": "requires_approval",
    })
    res = run(ir, tool_call=tool_call)
    by_tool = {s["tool"]: s for s in res["steps"]}
    assert by_tool["retrieve"]["effect"] == "allow" and by_tool["retrieve"]["ran"] is True
    assert by_tool["secret_tool"]["effect"] == "deny" and by_tool["secret_tool"]["ran"] is False
    assert by_tool["connection_crm_write"]["effect"] == "requires_approval"
    assert by_tool["connection_crm_write"]["ran"] is False


# --- gate 4: model called once per visited node, system prompt is DATA-safe -
def test_model_called_per_node_with_data_defense():
    ir = supervisor_worker_ir()
    model = FakeModel()
    res = run(ir, model_call=model)
    assert len(model.calls) == len(res["path"]) == 2
    for _id, system_prompt, _user in model.calls:
        assert "DATA" in system_prompt
        assert "instruction" in system_prompt.lower()
    # the worker's persona (AGENT.md + MEMORY.md) is threaded into its prompt
    worker_prompt = next(sp for nid, sp, _ in model.calls if nid == "worker")
    assert "You do the work." in worker_prompt
    assert "prior notes" in worker_prompt


# --- gate 5: recursionLimit caps visits; disabledAgents skips a node --------
def test_recursion_limit_caps_visits():
    res = run(supervisor_worker_ir(), recursion_limit=1)
    assert res["path"] == ["sup"]  # worker never visited


def test_disabled_agent_is_skipped():
    res = run(supervisor_worker_ir(), disabled_agents=["worker"])
    assert res["path"] == ["sup"]
    assert all(s["node"] != "worker" for s in res["steps"])


# --- gate 6: write-flag detection -------------------------------------------
@pytest.mark.parametrize("tool,write", [
    ("connection_crm_write", True),
    ("write_file", True),
    ("retrieve", False),
    ("metrics", False),
])
def test_write_flag_detection(tool, write):
    assert interpreter.is_write_tool(tool) is write


def test_write_flag_passed_to_tool_call():
    ir = {
        "entrypoint": "a",
        "startEdge": {"from": "START", "to": "a"},
        "nodes": [node("a", ["retrieve", "connection_crm_write"])],
        "memberEdges": [], "conditionalEdges": [], "commands": [], "channels": {},
    }
    tool_call = fake_tool_factory({})
    run(ir, tool_call=tool_call)
    flags = {c["tool"]: c["write"] for c in tool_call.seen}
    assert flags["retrieve"] is False
    assert flags["connection_crm_write"] is True


# --- handoff Command(goto) wiring -------------------------------------------
def test_handoff_command_follows_edge():
    ir = {
        "entrypoint": "a",
        "startEdge": {"from": "START", "to": "a"},
        "nodes": [node("a", ["t1"]), node("b", ["t2"])],
        "memberEdges": [],
        "conditionalEdges": [],
        "commands": [{"from": "a", "to": "b", "when": None}],
        "channels": {},
    }
    res = run(ir)
    assert res["path"] == ["a", "b"]
    assert res["reachedEnd"] is True  # b is a leaf


# --- output is the final model text -----------------------------------------
def test_output_is_final_model_text():
    res = run(supervisor_worker_ir())
    assert res["output"] == "model-output-for-worker"


# --- IR validation ----------------------------------------------------------
def test_validate_ir_good():
    ok, err = interpreter.validate_ir(supervisor_worker_ir())
    assert ok is True and err is None


def test_validate_ir_bad_entrypoint():
    ir = supervisor_worker_ir()
    ir["entrypoint"] = "ghost"
    ok, err = interpreter.validate_ir(ir)
    assert ok is False and "ghost" in err
