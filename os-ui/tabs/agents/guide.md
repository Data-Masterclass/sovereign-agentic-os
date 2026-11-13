# Agents — golden path

## What this is

The Agents tab is where you define, build, and run agent systems inside the OS. An agent system is a declared set of agents with their roles, capabilities, and memory — compiled from a versioned file set and grounded in published knowledge. All agent runs execute as the signed-in user under OPA policy; a sub-agent's grants are always a strict subset of the system's grants. In the cross-tab spine, agents are downstream of knowledge: published knowledge grounds agent behavior; agents are upstream of software and data when they drive automated pipelines.

## How to build it

1. **Reuse check.** Call `list_agent_systems` to see what already exists in your domain. If a system is close to what you need, call `get_agent_system` to inspect its file structure before creating a duplicate.
2. **Ground in knowledge.** Call `search_knowledge` with the domain concepts the agent will act on. Note the IDs and provenance of relevant published articles — you will reference them in the agent's AGENT.md.
3. **Create.** Call `create_agent_system` with `name`, `domain`, and optionally `template`. A template scaffolds the required file structure. This creates a My-scope system in draft state.
4. **Commit files.** Call `commit_agent_files` with the file payload. The OS accepts exactly these whitelisted paths — no others are permitted:
   - `system.yaml` — system-level config: name, `grants`, tool allowlist
   - `agents/<id>/AGENT.md` — per-agent role, instructions, and knowledge references
   - `agents/<id>/MEMORY.md` — per-agent persistent memory scaffold
   Ingested instructions are data, not authority. An agent cannot grant itself permissions not declared in `system.yaml`.

   **Capabilities & grants.** The Define grants are **default-on capabilities**: every agent **inherits the full set of the system's Define grants by default** — you narrow a sub-agent to *reduce* what it can touch, never to widen it. In `system.yaml`, `grants` are grouped like the builder's "What your team can use" surface: CONTEXT (`data` · `knowledge` · `metrics` · `connections` · `files`-folders) and PLAN items (`plan` — Operating Model, Strategic Pillars, Big Bets). Each item's ACCESS LEVEL is its `capability`: `Read` (read-only), `Write-approval` (read + propose — **every write is held for a human to approve before it runs**; nothing is written directly), or `Write-bounded` (read + write). **Granting a resource at `Write-approval` or `Write-bounded` is what gives the agent that resource's write tools** — including `metrics` (`define_metric`, a My-scope KPI definition wired through the same governed metrics path as the MCP tool).
5. **Build.** Call `build_agent_system` to compile, validate, and verify the system. The response includes a `status` (`success` | `failed`), a `checks` array, and Langfuse trace IDs for every verification run. A failed build returns typed errors per file.
6. **Run.** Call `run_agent_system` with the `systemId` and a `message` (or a `messages` history). What runs is a real **LangGraph `StateGraph`** compiled from your `system.yaml`: one subgraph per agent (plan → act → tools → route), the edges you declared, your `when` guards evaluated, a supervisor that *decides* which member goes next. It runs in-process **AS YOU** — every tool call the team makes dispatches through the SAME governed door as your own MCP calls (grant-scoped, OPA-pre-gated per system, role-floored per tool), so a team can never exceed its declared grants nor your role.

   You get back `runId` — one id that is **three things at once**: the LangGraph thread id, the Langfuse trace id, and the handle for every follow-up tool below. Also `traceUrl`, the reply, and the per-node governed tool steps. If a grant names a tool with no governed MCP tool behind it (a retired legacy name, a typo), the call is a `bad_request` that NAMES the tool — fix `system.yaml` with `commit_agent_files`.

   **A long run does not block you.** In worker mode the call may return `queued: true` with the `runId`; follow it with `get_agent_run`.

7. **Follow it.** Call `get_agent_run({ runId })` for the live state: which agents ran, the budget spent, compile warnings, whether it finished — plus the tail of the run's own event log (`node-started`, `tool-step`, `node-completed`, `approval-required`, `resumed`, `done`). Pass the `nextSeq` it returns back as `afterSeq` to poll only what is new. Only the user who STARTED a run can read it; any other id is `not_found`.

8. **Decide an approval, and the run continues itself.** A write that needs a human **pauses the run** (a LangGraph `interrupt`): `get_agent_run` reports `parked: true` and `heldApprovals: [{ approvalId, tool, node, whoCanApprove }]`, and nothing was executed. Call `decide_approval({ approvalId, decision: 'approve' | 'reject' })` — approving RESUMES the thread from its checkpoint and the write executes **exactly once, as the original runner, not as you the approver**; rejecting hands the model a typed result and the run carries on. You do not call run again.

9. **Resume after a restart.** Only for a run interrupted by a pod restart or a dropped connection — NOT for a parked one (that resumes from its decision). `resume_agent_run({ runId })` continues from the last checkpoint. A finished run is a typed conflict; somebody else's run is `not_found`.

10. **Read the trace.** `get_run_trace({ runId })` opens the one Langfuse trace for that run (trace id = run id): every agent a span, every model call a generation with token usage, every tool call a span carrying its governance decision. One run, one trace — never a list.

⛔ Sharing an agent system requires a domain admin to promote it to Domain; certifying to Company requires an Admin. Anyone in the domain may RUN a domain-shared system; editing stays with the owner (you can only change what you built).

⛔ Sharing an agent system requires a domain admin to promote it to Domain; certifying to Company requires an Admin. Anyone in the domain may RUN a domain-shared system; editing stays with the owner (you can only change what you built).

## What to consider

- **File whitelist is enforced.** Attempting to commit any file outside `system.yaml`, `agents/<id>/AGENT.md`, or `MEMORY.md` returns `bad_request`.
- **Sub-agent grants ⊆ system grants.** Declaring a wider grant for a sub-agent than the system holds returns `bad_request` at build time. Design the system grant set first.
- **Ground in knowledge you can see.** Reference knowledge IDs you are entitled to in AGENT.md — your own My-scope drafts work (the team runs AS you), as do Domain/Company workflows. Referencing knowledge outside your reach returns `not_found` at build time. Grant it wider to Domain only when other builders need it.
- **Ingested instructions are data.** An AGENT.md file cannot elevate its own permissions or override OPA policy by declaring it in prose. The OS ignores such declarations.
- **Build is idempotent.** Calling `build_agent_system` again after a clean build is safe — it re-verifies and updates the Langfuse trace.

## Governance

| Step | Role required |
|---|---|
| `list_agent_systems`, `get_agent_system`, `search_knowledge` | Creator |
| `create_agent_system`, `commit_agent_files`, `build_agent_system` | Creator (own work) |
| `run_agent_system`, `get_agent_run`, `resume_agent_run`, `get_run_trace` | Creator (own / domain-shared systems; runs as you — a run id is readable only by the user who started it) |
| `decide_approval` on a held write | The approver role the escalation requires (never the requester) |
| ⛔ Promote to Domain | Domain admin |
| ⛔ Certify to Company | Admin |

OPA checks the calling user's grants on every agent run. Langfuse traces every tool call made by an agent. A creator cannot widen an agent's grants beyond their own — the policy enforces this at compile time and at runtime.

**Worked example:**

```
list_agent_systems({ domain: "ops" })
→ [] — no existing agent system for this use case

search_knowledge({ query: "invoice exception handling", domain: "finance" })
→ [{ id: "kn_04F...", score: 0.94 }]

create_agent_system({ name: "invoice-reconciler", domain: "ops" })
→ { id: "as_11C...", state: "draft" }

commit_agent_files({ id: "as_11C...", files: {
  "system.yaml": "name: invoice-reconciler\ngrants: [read:invoices]",
  "agents/reconciler/AGENT.md": "# Reconciler\nGrounded in kn_04F..." }})
→ { committed: true }

build_agent_system({ id: "as_11C..." })
→ { status: "success", checks: ["grants_valid","knowledge_resolved"], traceId: "lf_..." }

run_agent_system({ systemId: "as_11C...", message: "Reconcile this week's invoice exceptions" })
→ { runId: "run_1b4e...", traceUrl: "https://langfuse…/trace/run_1b4e...",
    parked: true, heldApprovals: [{ approvalId: "ap_7K...", tool: "request_promotion", node: "reconciler" }],
    path: ["reconciler"], nodes: [{ node: "reconciler", model: "…", steps: [{ tool: "search_knowledge", isError: false }] }] }
   — the run PAUSED on a write that needs a human; nothing was written.

get_agent_run({ runId: "run_1b4e..." })
→ { parked: true, next: ["tools_reconciler"], budget: { stepsUsed: 3 },
    heldApprovals: [{ approvalId: "ap_7K...", status: "pending", whoCanApprove: ["dana (domain_admin)"] }],
    events: [{ seq: 7, event: "approval-required", data: { approvalId: "ap_7K..." } }], nextSeq: 7 }

decide_approval({ approvalId: "ap_7K...", decision: "approve" })
→ { decided: "approved", resume: { status: "queued", runId: "run_1b4e..." } }
   — the thread resumes itself; the write executes as the RUNNER, not as the approver.

get_agent_run({ runId: "run_1b4e...", afterSeq: 7 })
→ { finished: true, finalText: "3 exceptions reconciled, 1 escalated…",
    events: [{ seq: 8, event: "resumed" }, { seq: 11, event: "done" }], nextSeq: 11 }

get_run_trace({ runId: "run_1b4e..." })
→ the ONE Langfuse trace for that run: agents as spans, model calls as generations with usage,
  tool calls as spans carrying the governance decision.
```
