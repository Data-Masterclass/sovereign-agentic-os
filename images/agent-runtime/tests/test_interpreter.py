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
    """Records every (node_id, system_prompt, user_prompt, model) the walk asks
    for. The walk now makes TWO calls per node (plan → execute), so the recorded
    `model` per call lets tests assert the tier hand-off."""

    def __init__(self):
        self.calls = []

    def __call__(self, n, system_prompt, user_prompt, model):
        self.calls.append((n["id"], system_prompt, user_prompt, model))
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


# --- gate 4: model called TWICE per visited node (plan → execute), DATA-safe ---
def test_model_called_per_node_with_data_defense():
    ir = supervisor_worker_ir()
    model = FakeModel()
    res = run(ir, model_call=model)
    # Two calls per visited node now: a PLAN call then an EXECUTE call.
    assert len(model.calls) == 2 * len(res["path"]) == 4
    for _id, system_prompt, _user, _model in model.calls:
        assert "DATA" in system_prompt
        assert "instruction" in system_prompt.lower()
    # the worker's persona (AGENT.md + MEMORY.md) is threaded into BOTH its prompts
    worker_prompts = [sp for nid, sp, _u, _m in model.calls if nid == "worker"]
    assert len(worker_prompts) == 2
    for sp in worker_prompts:
        assert "You do the work." in sp
        assert "prior notes" in sp


# --- gate 4b: plan uses the REASONING tier, execute uses the EXECUTION tier ----
def single_node_ir(model=None):
    return {
        "entrypoint": "a",
        "startEdge": {"from": "START", "to": "a"},
        "nodes": [node("a", ["retrieve"], prompt="Do the job.", model=model)],
        "memberEdges": [], "conditionalEdges": [], "commands": [], "channels": {},
    }


def test_plan_uses_reasoning_execute_uses_execution():
    model = FakeModel()
    interpreter.run_ir(
        single_node_ir(), prompt="ship it", recursion_limit=25, timeout_ms=60000,
        disabled_agents=[], model_call=model, tool_call=fake_tool_factory({}),
        reasoning_model="qwen-vl-reasoning", execution_model="qwen-27b",
    )
    assert len(model.calls) == 2
    (plan_id, plan_sys, plan_user, plan_model) = model.calls[0]
    (exec_id, exec_sys, exec_user, exec_model) = model.calls[1]
    # phase 1 = PLAN on the reasoning tier; phase 2 = EXECUTE on the execution tier
    assert plan_model == "qwen-vl-reasoning"
    assert exec_model == "qwen-27b"
    assert "PLAN" in plan_sys  # the planning directive is present on the plan call
    # the plan output is handed off into the execution prompt
    assert "model-output-for-a" in exec_user
    assert "ship it" in exec_user


def test_per_agent_model_overrides_execution_only():
    """A per-agent model override changes the EXECUTION tier; planning stays on the
    uniform reasoning tier so every agent still plans with the reasoning model."""
    model = FakeModel()
    interpreter.run_ir(
        single_node_ir(model="custom-exec"), prompt="go", recursion_limit=25,
        timeout_ms=60000, disabled_agents=[], model_call=model,
        tool_call=fake_tool_factory({}),
        reasoning_model="qwen-vl-reasoning", execution_model="qwen-27b",
    )
    assert model.calls[0][3] == "qwen-vl-reasoning"   # plan: uniform reasoning tier
    assert model.calls[1][3] == "custom-exec"         # execute: per-agent override


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
