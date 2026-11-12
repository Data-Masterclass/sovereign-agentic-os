# Engine rebuild: real LangGraph, one trace per run, per-principal LiteLLM, and data products as dbt + Dagster + Trino

> **For agentic workers:** this is the plan of record. Read it fully before touching code. Work the phases **in order**; each phase ends with its gate green and one commit on the branch `feat/engine-rebuild`. Tick checkboxes as you go. Where you deviate, write the deviation under the phase instead of ticking a lie.

**Decision (2026-11-13, product owner):** the OS becomes a thin layer over how engineers actually use these tools. Whether a user works in the UI or through the OS MCP, what they build is translated into real LangGraph graphs observed by Langfuse and metered by LiteLLM, and real dbt models scheduled by Dagster and executed on Trino. Execution is autonomous: no approval gates between phases; the gates are tests.

**Supersedes:** Phase 3 of `2026-10-28-builder-vertical-rework.md` (which planned real LangGraph in the Python runtime). The Python runtime is retired by this plan.

**Evidence:** the 2026-11-10 audit, `~/Documents/Claude/Projects/Data Masterclass Apps/stackit/agent-stack-audit-2026-11-10.pdf` (Part I audit, Part II concept). Its verified findings are restated below where a phase depends on them.

---

## Global constraints

- **Identity is the architecture.** Every tool call executes as the signed-in `CurrentUser` through the in-process governed dispatcher (`core/mcp/server.ts` `handleRpc(user, …)`, gated by `tabs/agents/lib/build/os-tools.ts` `grantedToolExecutor`). Nothing in this plan may move that across a process boundary or run a side effect under a service principal. This is why the engine is **TypeScript inside os-ui**, not Python.
- **Keep the definition layer.** `system.yaml` schema and byte-stable serializer (`tabs/agents/lib/system-schema.ts`), the compiler and its IR (`tabs/agents/lib/langgraph-compile.ts`), grant gates, `core/infra/litellm-credential.ts`, the SSE event vocabulary consumed by `tabs/agents/ui/BuildRunPanel.tsx`, run records, the approvals queue. Existing `system.yaml` files must keep working unchanged.
- **Delete, don't refactor, the runtime layer:** the TS live walker (`agentic-graph.ts` BFS), the TS mock walker (`build/run-graph.ts`), the Python interpreter (`images/base/agent-runtime/`), the IR-as-wire-format (`runtime-contract.ts`, `live.ts` `/reload`), request-bound execution, out-of-band approvals. Deletion happens only in the deletion phase, after parity tests pass.
- **Engine flag.** `AGENTS_ENGINE=walker|langgraph` (env) with per-system override via the existing `runtime` key. Default `walker` until the deletion phase flips it.
- **Repo rules** (`CONTRIBUTING.md`): a tab imports only `@core/*` and itself; the kernel never imports a tab; every source file carries the `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header; `scripts/check-structure.mjs` is a ratchet. A test cannot import a `.tsx` or a Next `route.ts`; testable logic lives in `.ts` modules. No TS parameter properties.
- **Gates for every phase:** `npx tsc --noEmit -p os-ui/tsconfig.json` clean; `npm --prefix os-ui test` 0 failures; `node scripts/check-structure.mjs` no new violations; `bash os-ui/scripts/gate.sh` exit 0; `helm lint charts/sovereign-agentic-os -f values.local.yaml` where the chart changed. Docs updated in the same commit (`docs/components/*.md`, `os-ui/ARCHITECTURE.md`, the owning tab's `README.md`, `CHANGELOG.md`).
- **Operational:** one implementation agent at a time on the branch; `colima stop` when not building; run `scripts/deploy.sh` directly, never piped; rebase-and-merge.

---

## Part A — Agents: real LangGraph

### Phase A0 — Dependencies and parity harness
- [ ] Add `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `pg`, `langfuse`, `langfuse-langchain` to `os-ui/package.json`; mark as `serverExternalPackages` in `next.config`. Confirm each package's LICENSE is MIT (the LangGraph *Platform* is not, and must not be bundled). Record versions and licences in `THIRD-PARTY-LICENSES.md` and `licenses/`.
- [ ] Record/replay model caller: the harness already injects `llm` (`core/runtime/agentic.ts`); add a recorder that captures `(request → response)` to JSON fixtures and a replayer, so both engines see identical model outputs.
- [ ] Golden fixtures: every `system.yaml` template in `tabs/agents/lib/templates.ts` / `agent-templates.ts`, plus three shapes: single agent; supervisor with two members; guarded handoff with a write grant held for approval.
- [ ] Parity test **P1**: for fixtures without `when` guards, replaying "declared order" supervisor decisions, old `runAgenticGraph` and new `buildGraph` produce the same visited path, the same `(tool, args)` sequence, and the same final text.
- [ ] Inventory systems with unmapped legacy tools (`os-tools.ts` `resolveGrantedTools`); they will fail compile in A1. List them in this file.
- [ ] Engine flag plumbing: `config.agentsEngine`, read in the run route, scheduled runs, and the MCP `run_agent_system` tool.

### Phase A1 — Real graph, in-request, checkpointed
- [ ] `tabs/agents/lib/engine/build-graph.ts`: `buildGraph(ir, deps)` → compiled `StateGraph`. Typed state root: `messages` (append; keep the OpenAI wire shape, not LangChain `BaseMessage`), every `state.channels` entry (`add_messages` → append, else last-value), `task`, `current`, `handoffs`, `nodeRuns`, `budget`, `held`, `final`.
- [ ] One subgraph per agent: `plan_<id>` (reasoning tier, no tools), `act_<id>` (execution tier, tools, ReAct fallback on tools-unsupported — preserve `agentic.ts` helpers), `tools_<id>` (hold decision first, then `grantedToolExecutor` unchanged), `route_<id>`. Conditional edge act → tools when the reply has tool calls, else → route.
- [ ] Supervisor = `route_<sup>` with a mandatory `route` tool returning `{ next, brief }` and a text fallback (`NEXT: <member>`); `addConditionalEdges` to members ∪ END from IR `conditionalEdges`; `supervise` edges return to the supervisor's act.
- [ ] Handoffs: evaluate `when` and return `Command({ goto })`. `when` grammar v1: literals, `state.<channel>` truthiness, `==`/`!=` on strings, `&&`/`||`; a ~40-line parser, never `eval`. Absent `when` = unconditional. **Decision taken for the owner:** safe expressions, not model-judged predicates; revisit only if a template needs it.
- [ ] END: supervisor routes END; a leaf whose handoffs all evaluate false → END; `recursionLimit` = team step budget; graceful stop. Disabled agents pruned at build. Unmapped legacy tools → compile error.
- [ ] Checkpointer: `PostgresSaver` on the existing CNPG cluster, new database `agent_runs` via the chart's `additionalDatabases`; run its migrations in an init job. **Thread id = run id**, minted in the run route.
- [ ] Execute in the route as today but checkpointed every superstep; `POST …/run {resume:true}` continues an interrupted thread. Replace "re-run to continue" in `BuildRunPanel.tsx` with "Resume".
- [ ] Streaming: nodes emit through the custom stream writer; the route forwards the existing events `node-started`, `tool-step`, `node-completed`, `done`, `error` unchanged.
- [ ] `finalizeTeamRun` / `nodeReveal` fed from graph state.
- [ ] Gate: P1 green under `langgraph`; the parked `HANDOFF-GUARD` test (`when:"false"` must not visit its target) flips from `todo` to green; **P2**: kill a run mid-way, resume, same path as uninterrupted.

### Phase A2 — Approvals as interrupts
- [ ] In `tools_<id>`: compute hold decisions for the whole batch first; for each held call `enqueue` **once** (idempotent on `(threadId, callId)` — LangGraph re-runs the node from its start on resume), then `interrupt({ approvalId, tool, args })`. Execute non-held and approved calls as the **runner**. Rejected → typed tool result, the model continues.
- [ ] Approvals carry `runId`, `threadId`, `interruptKey`. `core/policy/approvals.ts` `decide()` gains a post-hook: `graph.invoke(new Command({ resume }), { configurable: { thread_id: runId } })` under the runner's principal snapshot (role re-read live).
- [ ] Governance Inbox card links to the run. Two additive SSE events: `approval-required`, `resumed`; panel renders them.
- [ ] Decisions taken for the owner: the approver authorises, the **runner executes**; a parked approval has **no TTL** in v1 (documented as an open policy question in `docs/components/os-ui.md`).
- [ ] Gate **P3**: a held write never executes before the decision; approve executes exactly once as the runner; reject surfaces to the model; a racing second approver gets null; a batch with one held and one non-held call executes the non-held exactly once.

### Phase A3 — One Langfuse trace per run; LiteLLM attribution and keys
- [ ] Langfuse JS SDK + `langfuse-langchain` `CallbackHandler`, root trace **id = runId**; nodes → spans, model calls → generations with usage, tool calls → spans with the decision in metadata. `trace()` in `core/infra/agent-governed.ts` becomes a span under the run trace. `LastRun.traceUrl` deep-links to the run. Keep the in-process ring for Monitoring-without-Langfuse.
- [ ] **Close the leak:** `app/api/agents/systems/[id]/run/diagnostics/route.ts` filters observations by the run's trace id (interim: by `fromTimestamp` and user), never unfiltered.
- [ ] Write the LLM-judge verdict as a Langfuse **score** on the run trace (`evaluate/route.ts`).
- [ ] LiteLLM: add `TAG_RUN` to `litellm-credential.ts`; pass `domain` and `systemId` at the four call sites that drop them (`core/runtime/complete.ts`, `core/runtime/agent-loop.ts`, `agentic-graph-server.ts` ×2). Route `app/api/classify/route.ts`, `tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts` through `callerCredential` — **no master key on any inference path**; extend the `MODEL-KEY` gate test to assert only `litellm-admin.ts`, `litellm-write.ts` and `build/live-clients.ts` reference `litellmMasterKey`. Make the embed hash fallback explicit: timeout → fallback labelled `offline-hash`; 4xx → throw.
- [ ] Use the reconciled **per-agent key** for a run when it exists (`live-clients.ts` mints `sk-<alias>`); fall back to the shared agent key; never the master key.
- [ ] Chart: `failure_callback: ["langfuse"]`; Valkey cache for classify/suggest/embed; a chart test that `litellmAgentKey.models` ⊇ every `LITELLM_*_MODEL` default, `agentRuntime.*Model`, and every router `fallbacks` target. Teach `gateway-mirror.ts` the `run:` tag.
- [ ] Gate: Langfuse shows one trace per run in the local kind install (or, if no cluster is available, a recorded-ingestion test asserts one `trace-create` + N spans sharing the id); `MODEL-KEY` passes repo-wide; attribution test asserts `user`, `domain:`, `agent:`, `run:` on a real run's outgoing request.

### Phase A4 — Worker
- [ ] `os-ui/worker/agent-runs.ts` entrypoint in the same image (Node type-stripping already runs `.ts`): pulls `run_jobs` (`FOR UPDATE SKIP LOCKED`), drives `graph.stream()`, writes `run_events`; the route becomes enqueue + tail. Scheduled runs (`build/scheduled.ts`) use the same start service. Runner `Principal` snapshot serialised with the job; role re-read at start and every resume.
- [ ] Chart: a `os-ui-worker` Deployment from the same image with a different command; `replicas: 1` initially.
- [ ] Gate: a run longer than 300 s completes; an os-ui rolling restart loses no run; P1–P3 green in worker mode.

### Phase A5 — Deletion and docs
- [ ] Delete: `agentic-graph.ts` walk (keep the Librarian/handoff-curation helpers), `build/run-graph.ts`, `images/base/agent-runtime/` and its chart block, `live.ts` `/reload` path, `runtime-contract.ts` wire types; the `hermes` runtime option unless a runtime exists for it (it does not). Flip the engine default to `langgraph`, then delete the flag.
- [ ] Make `README.md`, `docs/components/os-ui.md`, `docs/components/langfuse.md`, `docs/components/litellm.md`, the runtime badge, `core/kernel/licenses.ts` and `sbom.cdx.json` true. Explain in `os-ui/ARCHITECTURE.md` how a `system.yaml` becomes a StateGraph.
- [ ] MCP: `run_agent_system` returns `runId` and `traceUrl`; add `resume_agent_run` and `get_agent_run` (state, held approvals); `decide_approval` resumes the thread. `tabs/agents/README.md` lists them.

---

## Part B — Data products: dbt + Dagster + Trino

**Principle:** a data product in the OS is a dbt project the user could check out and run. The OS generates and owns the files; Dagster schedules and materialises them; Trino executes them. The OS reads back Dagster run state and dbt artifacts rather than keeping a parallel ledger.

### Phase B0 — Audit and concept (read-only; may run in parallel with A0)
- [ ] Audit how datasets, transforms, compositions, syncs and quality rules execute today (`tabs/data/lib/{ingest,transform,sync-sql,sync-cron,sync-run-server,auto-gold,auto-pipeline,dq-*}.ts`, the Dagster image and chart block, the dbt image, the data-runner and query-tool services). Separate docs claims / code present / wired at runtime, as the agent audit did. Known facts to verify: scheduled syncs are Kubernetes CronJobs curling an os-ui route, not Dagster; transforms are Trino CTAS composed in TypeScript, not dbt models; Dagster had no Postgres driver in its image and 0 runs in 90 days.
- [ ] Concept: the mapping. Dataset/composition → dbt model (`models/<domain>/<slug>.sql` + `schema.yml` with tests from quality rules); sync → Dagster asset with a schedule/sensor, `dbt_assets` for the project; Trino as dbt's target via `dbt-trino`; lineage from dbt manifest; run history from Dagster GraphQL. Where the generated project lives (a git-backed volume or the OS's object store), how the OS reads back `manifest.json` / `run_results.json`, and how the MCP exposes the same operations. Decide and write the plan for B1–B4 into this file.

### Phase B1 — dbt project generation
- [ ] `tabs/data/lib/dbt/`: generate a dbt project per domain from the OS's dataset definitions: `dbt_project.yml`, `profiles.yml` (Trino target, credentials from secrets, never inlined), `models/`, `schema.yml` with `not_null`/`unique`/`accepted_values` tests compiled from quality rules. Byte-stable output; a test asserts regeneration is idempotent.
- [ ] Compositions compile to dbt models (`{{ ref() }}` between datasets) instead of ad-hoc CTAS; the existing Gold compiler becomes the SQL body generator inside a model.
- [ ] `dbt parse` in the dbt image validates the generated project in Build. Gate: generated project parses; golden-file tests for three shapes.

### Phase B2 — Dagster as the scheduler
- [ ] Fix the Dagster image (Postgres driver) and verify a run completes in kind.
- [ ] Generate a Dagster code location per domain: `dbt_assets` over the generated project, one asset per external sync source, schedules from the OS sync definitions. Replace the `batch/v1` CronJob provisioning in `sync-cron.ts` with Dagster schedules; keep the UTC and missed-slot semantics.
- [ ] Read back: run status, asset materialisations and failures via Dagster GraphQL into the Data tab's run history and Monitoring; the OS stops being its own ledger for sync runs.
- [ ] Gate: a scheduled sync materialises through Dagster in kind; the OS shows the Dagster run; `sync-cron.ts` deleted.

### Phase B3 — Trino as the engine, lineage from dbt
- [ ] dbt runs on Trino via `dbt-trino`; incremental models carry the OS's cursor/late-data semantics (`sync-sql.ts`) as model config, not bespoke SQL. Row-level security and OPA stay at the query-tool / Trino boundary (verify nothing bypasses them).
- [ ] Lineage and docs from `manifest.json`; the Data tab's lineage view reads it.
- [ ] Gate: parity test — the same composition yields the same rows via the old CTAS path and via `dbt run`; then delete the old path.

### Phase B4 — MCP, docs, deletion
- [ ] MCP tools map 1:1 to engineer operations: `dbt_run`, `dbt_test`, `dagster_materialize`, `get_dagster_run`, `get_lineage` — same governed path as the UI. Remove the OS-native sync and transform executors once B2–B3 parity holds.
- [ ] Docs: `docs/components/{dagster,dbt,trino}.md` describe the real flow; `tabs/data/README.md` lists the MCP tools; `os-ui/ARCHITECTURE.md` explains "a data product is a dbt project".

---

## Part C — Deploy and verify
- [ ] Deploy to STACKIT with `scripts/deploy.sh <version>` (directly, not piped; `colima start` first, `colima stop` after). Engine flag flips only after A1–A3 gates are green on the branch; B2–B3 deletions only after their parity gates.
- [ ] Post-deploy verification, in this order: health; one agent run end-to-end with an approval and a resume; one Langfuse trace for that run; the LiteLLM key allowlist from the Job log; one scheduled sync through Dagster; one composition through dbt.
- [ ] `helm rollback agentic-os <previous>` is the recovery path; no data migration in this plan is irreversible except the `agent_runs` database creation, which is additive.

---

## Decisions taken without the owner (autonomous mode) — review these
1. `when` grammar: safe expression language, not model-judged predicates.
2. Approver authorises, runner executes; no approval TTL in v1.
3. Worker is a second Deployment of the same image, not a separate image.
4. The Python `agent-runtime` and the `hermes` runtime option are retired.
5. Data products: one dbt project per domain, generated by the OS and owned by it; users read it, the OS writes it.

## Deviations log
(Agents append here: phase, what differed, why.)
