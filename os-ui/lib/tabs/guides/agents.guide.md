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

   **Capabilities & grants.** The Define grants are **default-on capabilities**: every agent **inherits the full set of the system's Define grants by default** — you narrow a sub-agent to *reduce* what it can touch, never to widen it. In `system.yaml`, `grants` are grouped like the builder's "What your team can use" surface: CONTEXT (`data` · `knowledge` · `metrics` · `connections` · `files`-folders) and PLAN items (`plan` — Operating Model, Strategic Pillars, Big Bets). Each item's ACCESS LEVEL is its `capability`: `Read` (read-only), `Write-approval` (read + propose — writes drafted for a human), or `Write-bounded` (read + write). **Granting a resource at `Write-bounded` is what gives the agent that resource's write tools.**
5. **Build.** Call `build_agent_system` to compile, validate, and verify the system. The response includes a `status` (`success` | `failed`), a `checks` array, and Langfuse trace IDs for every verification run. A failed build returns typed errors per file.
6. **Run.** Call `run_agent_system` with the `systemId` and a `message` (or a `messages` history). The team runs live, in-process, AS YOU — and the recursion is governed: every tool call the team makes dispatches through the SAME governed door as your own MCP calls (grant-scoped, OPA-pre-gated per system, role-floored per tool), so a team can never exceed its declared grants nor your role. You get back the reply plus per-node governed tool steps. A hermes-runtime or legacy-grant system cannot run in-process — that returns `bad_request` pointing to the Agents tab UI.

   **The write gate is scope-aware.** Because the team runs AS you, a **My (personal)** write is exactly what you could do by hand with no approval, so the agent performs it **directly** (run-as-user, OPA/DLS-checked) — it is not held. Only a **Domain / Company** write is an escalation, and *that* is held in Policies & Approvals for the right admin (a `Write-approval` grant additionally drafts every write for a human). Earlier "all agent writes are held for approval" wording is out of date.

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
| `run_agent_system` | Creator (own / domain-shared systems; runs as you) |
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
→ { finalText: "3 exceptions reconciled, 1 escalated…", path: ["reconciler"],
    nodes: [{ node: "reconciler", model: "…", steps: [{ tool: "search_knowledge", isError: false }] }] }
```
