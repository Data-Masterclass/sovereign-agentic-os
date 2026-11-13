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
- **Operational:** implementation agents may run **in parallel only on disjoint areas** (agent side vs data side), each in its own worktree, merged by the coordinator; reviewer and test agents are read-only and freely parallel. `colima stop` when not building; run `scripts/deploy.sh` directly, never piped; rebase-and-merge.
- **Companion documents:** `2026-11-13-engineering-checklist.md` (the definition of done and the iteration protocol) and `2026-11-13-data-products-concept.md` (Part B detail; where it differs from the outline below, the concept wins).

---

## Part A — Agents: real LangGraph

### Phase A0 — Dependencies and parity harness
- [x] Add `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `pg`, `langfuse`, ~~`langfuse-langchain`~~ (not added — see deviation A0-1) to `os-ui/package.json`; mark as `serverExternalPackages` in `next.config`. Confirm each package's LICENSE is MIT (the LangGraph *Platform* is not, and must not be bundled). Record versions and licences in `THIRD-PARTY-LICENSES.md` and `licenses/`.
- [x] Record/replay model caller: the harness already injects `llm` (`core/runtime/agentic.ts`); add a recorder that captures `(request → response)` to JSON fixtures and a replayer, so both engines see identical model outputs.
- [x] Golden fixtures: every `system.yaml` template in `tabs/agents/lib/templates.ts` / `agent-templates.ts`, plus three shapes: single agent; supervisor with two members; guarded handoff with a write grant held for approval.
- [x] Parity test **P1** (walker side green; one `todo` per fixture for `buildGraph`, flipped in A1): for fixtures without `when` guards, replaying "declared order" supervisor decisions, old `runAgenticGraph` and new `buildGraph` produce the same visited path, the same `(tool, args)` sequence, and the same final text.
- [x] Inventory systems with unmapped legacy tools (`os-tools.ts` `resolveGrantedTools`); they will fail compile in A1. List them in this file.
- [x] Engine flag plumbing: `config.agentsEngine`, read in the run route, scheduled runs, and the MCP `run_agent_system` tool.

#### A0 — what landed (commit on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Dependencies (exact-pinned, all MIT, LICENSE files verified in `node_modules`) | `@langchain/langgraph` 1.7.4 · `@langchain/langgraph-checkpoint-postgres` 1.1.3 · `@langchain/core` 1.4.0 (explicit peer pin) · `pg` 8.23.1 · `langfuse` 3.39.2 · dev `@types/pg` 8.23.1; `serverExternalPackages` in `next.config.mjs`; rows in `THIRD-PARTY-LICENSES.md`, `licenses/components.tsv`, `core/kernel/licenses.ts`; notices in `licenses/notices/os-ui-agent-engine-npm-NOTICE.txt` |
| Record/replay caller | `core/runtime/llm-replay.ts` (`recordingCaller`, `replayCaller`, typed `ReplayMismatchError` / `ReplayExhaustedError`) + tests |
| Parity harness + 13 golden fixtures | `tabs/agents/lib/engine/parity-harness.ts`, `fixtures/*.json`; `fixtures.test.ts` (reproducibility; `REGEN_FIXTURES=1` rewrites), `parity.test.ts` (P1), `unmapped-inventory.test.ts` |
| Engine flag | `core/kernel/agents-engine.ts` (`AgentsEngine`, `parseAgentsEngine`), `config.agentsEngine` ← `AGENTS_ENGINE`; `runtime: walker` opt-out in `system-schema.ts`; `tabs/agents/lib/engine/select.ts` `selectEngine`; read in `app/api/agents/systems/[id]/run/route.ts`, `build/scheduled.ts`, `core/mcp/agent-write-tools.ts` (`run_agent_system`); every run report carries `engine` |

**Fixtures (13).** `template-{blank,analyze,evaluate,recommend}` (templates.ts), `agent-template-{blank,analyst,recommender,reviewer,researcher}` (agent-templates.ts, each composed as a single-agent system since those templates are per-agent fragments), `software-team` (guarded — excluded from P1), `shape-single-read` (a), `shape-supervisor-two-members` (b), `shape-guarded-handoff-held-write` (c: `when: state.findings_ready`, target holds `request_promotion`, which `read-propose` holds → `held=1` in the golden; walker visits `publisher` anyway — HANDOFF-GUARD `todo`). Scripted model rule set `first-tool-then-final@1`: PLAN → fixed plan; a node's first ACT → its first advertised tool; next ACT → `FINAL(<node>)`.

#### A0 — inventory: unmapped legacy tools (the A1 compile rule)

Run over every shipped `system.yaml` with `os-tools.ts` `resolveGrantedTools` against the live registry (111 tools), guarded from now on by `tabs/agents/lib/engine/unmapped-inventory.test.ts`:

| System | Grants | Unmapped | Action |
|---|---|---|---|
| `templates.ts` blank · analyze · evaluate · recommend | `search_knowledge` | none | — |
| `agent-templates.ts` blank · analyst · recommender · reviewer · researcher | `query_data`, `search_knowledge` | none | — |
| `software-team.ts` (6 agents) | `create_software commit start_preview request_deploy use_connection use_data use_knowledge use_as_data` | none | — |
| `seed/campaign` Campaign Evaluation Agent | `knowledge_search metrics_query retrieve` | `knowledge_search`, `metrics_query` (`retrieve` is an alias) | **fixed** → `search_knowledge list_metrics query_metric` |
| `seed/ecommerce` Northpeak Support Agent | `knowledge_search` | `knowledge_search` | **fixed** → `search_knowledge` |
| `seed/ecommerce` Northpeak Fraud Agent | `knowledge_search predict` | both — there is **no governed `predict` MCP tool** | **fixed** → `search_knowledge query_data` (reads risk context from the granted Gold data; prose adjusted) |
| `seed/ecommerce` Northpeak Pricing Agent | `metrics_query` | `metrics_query` | **fixed** → `list_metrics query_metric` |

Not a compiled system, left as is: `core/kernel/artifacts.ts` seeded registry record "Domain RAG Agent" (`spec.tools: ['knowledge_search']`, a demo artifact row). Still mapped by `OS_TOOL_ALIASES`: `retrieve`, `metrics`, `files_retrieve`, `write_file`. **Open for A1:** user-authored systems already in a live store may carry `web_fetch`, `knowledge_certify`, `connection_*`; the compile error must surface in Build/the run report, not as a 500 — consider a one-off store scan in A1.

#### A0 — findings the later phases must act on

1. **`software-team.ts` guards are bare identifiers, not `state.<channel>`.** Its handoffs say `when: plan_ready | committed | tests_failed | tests_passed | reported`, and `state.channels` declares only `messages`. The A1 `when` grammar ("`state.<channel>` truthiness") must either accept a bare identifier as a channel name or the compiler must reject the shipped team — and *no node sets those channels today*, so under a real evaluator every handoff is false and the team would stop after `orchestrator`/`planner`. Decide in A1 (likely: bare identifier = channel; supervisor-driven order makes the handoffs redundant for this team).
2. **The walker's transcript has no supervisor routing exchanges.** The walker never asks the model where to go, so `route_<sup>` in A1 will make model calls the replayed transcript cannot serve; `replayCaller` fails loudly by design. For P1 on `shape-supervisor-two-members`, A1 should run `buildGraph` against the *scripted* model (fixtures carry `script: first-tool-then-final@1`; extend the script with a declared-order `route` rule) rather than the raw transcript, or extend the transcript with route exchanges.
3. **Fixed in A0 — `grantedToolSpecs` conflated `tools: []` with "inherit all".** The orchestrator and communication agents of the shipped team (declared `tools: []`) were advertised `create_software`/`commit`/…; the first golden recorded `orchestrator → create_software`. Now `[]` = no tools, `undefined` = inherit. **Still open:** `grantedToolExecutor` gates only at SYSTEM grant level — per-node narrowing is prompt-side only. A1's `tools_<id>` must enforce node narrowing in the executor, and P1 goldens assume it.
4. `isAgenticOsTeam` now accepts `runtime: walker` like `langgraph` (`hermes` still falls back).
5. The `langfuse` 3.39.2 npm tarball ships **no LICENSE file**; `package.json` declares MIT and the upstream `langfuse-js` LICENSE (MIT, © ClickHouse, Inc. / PostHog) is reproduced in the NOTICE. A3 should re-verify when bumping.
6. `liteLlmCaller` omits `tools` when the array is empty, so a tool-less node is a plain completion — safe for the fix in (3).


### Phase A1 — Real graph, in-request, checkpointed
- [x] `tabs/agents/lib/engine/build-graph.ts`: `buildGraph(ir, deps)` → compiled `StateGraph`. Typed state root: `messages` (append; keep the OpenAI wire shape, not LangChain `BaseMessage`), every `state.channels` entry (`add_messages` → append, else last-value), `task`, `current`, `handoffs`, `nodeRuns`, `budget`, `held`, `final`.
- [x] One subgraph per agent: `plan_<id>` (reasoning tier, no tools), `act_<id>` (execution tier, tools, ReAct fallback on tools-unsupported — preserve `agentic.ts` helpers), `tools_<id>` (hold decision first, then `grantedToolExecutor` unchanged), `route_<id>`. Conditional edge act → tools when the reply has tool calls, else → route.
- [x] Supervisor = `route_<sup>` with a mandatory `route` tool returning `{ next, brief }` and a text fallback (`NEXT: <member>`); `addConditionalEdges` to members ∪ END from IR `conditionalEdges`; `supervise` edges return to the supervisor's act.
- [x] Handoffs: evaluate `when` and return `Command({ goto })`. `when` grammar v1: literals, `state.<channel>` truthiness, **bare identifiers resolving to a channel of the same name** (A0 finding 2: the shipped software team uses `plan_ready`, `committed`, …), `==`/`!=` on strings, `&&`/`||`; a ~40-line parser, never `eval`. Absent `when` = unconditional. A guard naming a channel no node ever sets is a **compile warning** surfaced in Build, not a silent false. **Decision taken for the owner:** safe expressions, not model-judged predicates.
- [x] Node-level tool narrowing becomes a real gate (A0 finding 1): `tools_<id>` executes only the tools the node is advertised, not every system grant; test it.
- [x] Supervisor parity (A0 finding 3): walker transcripts carry no routing exchanges, so P1 for supervisor fixtures drives `buildGraph` with the scripted model `first-tool-then-final@1` (plus a scripted `route` decision in declared order) rather than the replayed transcript; document the rule set.
- [x] END: supervisor routes END; a leaf whose handoffs all evaluate false → END; `recursionLimit` = team step budget; graceful stop. Disabled agents pruned at build. Unmapped legacy tools → compile error.
- [x] Checkpointer: `PostgresSaver` on the existing CNPG cluster, new database `agent_runs` via the chart's `additionalDatabases`; run its migrations in an init job. **Thread id = run id**, minted in the run route.
- [x] Execute in the route as today but checkpointed every superstep; `POST …/run {resume:true}` continues an interrupted thread. Replace "re-run to continue" in `BuildRunPanel.tsx` with "Resume".
- [x] Streaming: nodes emit through the custom stream writer; the route forwards the existing events `node-started`, `tool-step`, `node-completed`, `done`, `error` unchanged.
- [x] `finalizeTeamRun` / `nodeReveal` fed from graph state.
- [x] Gate: P1 green under `langgraph`; the parked `HANDOFF-GUARD` test (`when:"false"` must not visit its target) flips from `todo` to green; **P2**: kill a run mid-way, resume, same path as uninterrupted.

#### A1 — what landed (commit on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Graph builder | `tabs/agents/lib/engine/build-graph.ts` — `buildGraph(ir, deps)` → `{ graph, warnings, stepBudget, recursionLimit, agents, names }`; state `Annotation.Root` (OpenAI wire `messages`, system channels with declared reducers, engine keys); `plan_/act_/tools_/route_<id>`; supervisor `route` tool + `addConditionalEdges`; handoff `Command({ goto })`; node-level tool gate; graceful budget END |
| Guard language | `tabs/agents/lib/engine/when.ts` (`parseWhen`, `evaluateWhen`, `whenChannels`, typed `WhenSyntaxError`) + `when.test.ts` |
| Run orchestration | `tabs/agents/lib/engine/run.ts` — `runGraphEngine` (stream `['custom','updates']`, hooks ← `config.writer`, resume = `stream(null)`, result from `getState`, `ResumeNotFoundError`) |
| Checkpointer | `tabs/agents/lib/engine/checkpointer.ts` (`selectCheckpointer`, `ensureCheckpointerReady`, `memoryCheckpointer`); `config.agentRunsDatabaseUrl` ← `AGENT_RUNS_DATABASE_URL`; boot `setup()` in `instrumentation.ts`; chart `postgres.extraDatabases[agent_runs]` + os-ui env |
| Wiring | `agentic-graph-server.ts` `runOsTeam({ engine, runId, resume })` branches; run route mints `newRunId()` / handles `{resume,runId}`; `build/scheduled.ts` + MCP `run_agent_system` pass `engine`, return `runId`; `LastRun.runId/engine/checkpointer`; `RunCheckpoint.runId`; `BuildRunPanel` **Resume** |
| Parity | `parity.test.ts`: P1 both engines (13/13), software-team under langgraph, HANDOFF-GUARD, P2 abort+resume, unknown-thread error; `build-graph.test.ts` (A7, A8, A9, A10, A11, node gate, events, compile errors); fixtures regenerated under `first-tool-then-final@2` with `outcome` |

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

**Principle:** a data product in the OS is a dbt project the user could check out and run. The OS generates and owns the files **in a git repository per domain**; Dagster schedules and materialises them **from a validated commit**; Trino executes them **as the acting principal via impersonation**. The OS reads back Dagster run state and dbt artifacts rather than keeping a parallel ledger.

**Detail:** `2026-11-13-data-products-concept.md` (Phase B0 output). Decisions recorded there and adopted here: isomorphic-git in os-ui with bare repos on a PVC and a read-only git-daemon sidecar; **one Dagster code location for all domains** with per-domain parse gating; `dbt-runner` is an impersonation-only Trino user and OPA's write floor becomes authoritative; commit first, validate second; no OS run ledger.

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

## Part D — Git-based working, automatically, behind every step (cross-cutting)

**Requirement (2026-11-13, product owner):** everything built in the OS, from the UI or the MCP, follows a git-based way of working exactly as engineers work, automatically. No separate "export to git" step.

- [ ] One commit path. `core/infra/git-store.ts` (isomorphic-git, MIT): `openOrInit(repo)`, `commitTree(repo, files, {author, message, trailers})` committing **iff the tree hash changed**, `log`, `readBlob`, `archive`, `push(mirror)`. Author = acting `CurrentUser` (name + email); committer = `Sovereign OS`. Message `<area>(<domain>): <action> <object> — via <mcp:tool | ui:<route>>`, trailers `OS-Action`, `OS-Object`, `OS-Surface`, `OS-Request-Id`.
- [ ] Repos: one bare repo per domain on PVC `os-repos` (RWO; os-ui is single-replica). Layout: `agents/<system>/{system.yaml,graph.ts,README.md}`, `dbt_project.yml`, `models/…`, `os/schedules.yml`. Served read-only in-cluster by a `git daemon` sidecar; NetworkPolicy limits consumers to the Dagster user-code pod.
- [ ] **Every writer commits.** Agent store saves (`tabs/agents/lib/store.ts`), data store mutations (dataset, composition, check, sync, publish), and their MCP tools all route through the one commit path. A unit test enumerates the store's mutating exports and asserts each calls the commit builder (checklist X1).
- [ ] Read access: `GET /api/<tab>/projects/<domain>` tree/log/blob at a ref; export as an archive at a commit; admin-only mirror config (URL + token Secret) with push-after-commit that reports but never blocks.
- [ ] Gates: checklist A2, A3, D2, D3, X1, X2.

## Part E — The final document

**Requirement (2026-11-13, product owner):** a PDF explaining, step by step, how each tool is really used after the refactor and where that manifests in the OS source; which tool functions are implemented at which step; and how it follows the same approach a data or AI engineer would follow — the OS as an abstraction layer, not a reinvention of "how".

- [ ] Written **last, from the shipped code**, by a read-only agent, one chapter per tool (LangGraph, Langfuse, LiteLLM, git, dbt, Dagster, Trino): the engineer's workflow step by step → the OS source performing that step (`file:line`) → the tool functions used and deliberately not used → what the OS adds on top (identity, policy, approvals). A closing chapter lists every reinvention that remains, with the reason.
- [ ] Rendered with headless Chrome like the audit PDF; stored next to it in `~/Documents/Claude/Projects/Data Masterclass Apps/stackit/`. Checklist X6.

## Part F — Iterate against the checklist

After each full pass over Parts A, B and D: a read-only test agent scores `2026-11-13-engineering-checklist.md`, writes a gap report there, and a new "Iteration N" is appended below with phases closing the gaps. Repeat until two consecutive iterations close nothing further. Deploy after each green iteration; the engine flag flips only when A5–A17 pass.

## Decisions taken without the owner (autonomous mode) — review these
1. `when` grammar: safe expression language, not model-judged predicates.
2. Approver authorises, runner executes; no approval TTL in v1.
3. Worker is a second Deployment of the same image, not a separate image.
4. The Python `agent-runtime` and the `hermes` runtime option are retired.
5. Data products: one dbt project per domain, generated by the OS and owned by it; users read it, the OS writes it.
6. Git mechanism: isomorphic-git in-process, bare repos on a PVC, read-only git-daemon sidecar, optional push mirror — not the git CLI in the image, not direct commits to a remote.
7. One Dagster code location for all domains, parse-gated per domain, rather than one per domain.
8. `when` grammar accepts bare identifiers as channel names, because the shipped software team already uses them.

## Deviations log
(Agents append here: phase, what differed, why.)

- **A0-1 `langfuse-langchain` not added.** v3.39.2 peers on the legacy `langchain <0.4` (`@langchain/core` 0.x); installing it beside `@langchain/langgraph@1.7.4` (peer `@langchain/core ^1.3.4`) pulls a second core and its `CallbackHandler` cannot attach to v1 runnables. Our model calls go through LiteLLM via `LlmCall`, not LangChain chat models, so A3 traces explicitly with the `langfuse` SDK (`trace({ id: runId })` gives exact trace-id control). Alternative if a handler is ever wanted: `@langfuse/langchain@6` (+ `@langfuse/client`, OTel SDK).
- **A0-2 `@langchain/core` 1.4.0 pinned explicitly** (a peer of the two LangGraph packages) so the version cannot drift under npm's auto-peer install.
- **A0-3 Per-system override is opt-OUT only.** `runtime: walker` pins the walker; an explicit `runtime: langgraph` is indistinguishable from the default because the serializer omits it (byte-stable files). Opt-in per system therefore means flipping `AGENTS_ENGINE` and pinning the others to `walker`. If A1 needs a per-system opt-in, add a value then.
- **A0-4 Behaviour change outside strict A0 scope:** `grantedToolSpecs(user, sys, [])` now returns no tools (finding 3). Justified because the goldens would otherwise enshrine a grant-gate bug the new engine would have to reproduce. Covered by a regression test in `os-tools.test.ts`.
- **A0-5 Seeded demo systems edited** (`seed/campaign/narrative.mjs`, `seed/ecommerce/lib/narrative.mjs`, `seed/campaign/README.md`) to MCP names — see the inventory table. `predict` has no governed MCP tool; the fraud agent now reads the granted Gold data for risk context.
- **A0-6 Shape (c) uses `request_promotion`, not `publish_knowledge`.** `publish_knowledge` is `domain_admin`-floor, so a builder's agent is never *advertised* it and the hold could never fire; `request_promotion` is creator-floor and in the same escalating set, so `read-propose` holds it (`holdDecision` → `domain_admin`), which the golden records (`held=1`).
- **A0-7 `sbom.cdx.json` not regenerated locally.** `scripts/license-check.sh --update-sbom` runs `syft scan dir:.`, which on a dev checkout ingests `os-ui/node_modules`; CI's `license-gate` regenerates the SBOM from a clean checkout (package-lock) on every push. `scripts/license-check.sh --no-syft` and `npm run check:licenses` both pass locally.
- **A0-8 Run reports gained an additive `engine` field** (route JSON + SSE `done` frame body, scheduled-run report, MCP `run_agent_system` result) so a run always says which executor produced it. `LastRun` (the persisted record) was not changed.
- **A1-1 A member returns to the supervisor's ROUTE node, not its act.** The plan said "supervise edges return to the supervisor's act". Re-running the supervisor's plan+act on every return would make a second model call per return and would make the supervisor's `FINAL(...)` the team's final text — breaking P1 final-text parity with the walker (whose final is the last member's). The standard LangGraph supervisor is one decision call per return, so `route_<sup>` is the re-entry point; the supervisor's own plan/act runs once on entry. On END, a non-empty route `brief` becomes the final text (a real model summarising), else the last agent's answer (what the scripted fixtures produce).
- **A1-2 Hold decision stays inside `grantedToolExecutor` in A1.** The brief said "hold decision first via holdDecision" in `tools_<id>`. `holdDecision` lives in `os-tools.ts` (`server-only`); importing it into the pure graph builder would drag the server module into every parity test, and computing it twice (node + executor) buys nothing until `interrupt()` arrives. A1's `tools_<id>` records the executor's typed `held` result into `state.held`; A2 lifts the decision into the node (where it must be, to interrupt before executing).
- **A1-3 `when` grammar has no `!` operator** — exactly the brief's grammar; negation is `x == false`.
- **A1-4 No node sets a system channel yet.** Every `when` guard over a channel is therefore a compile warning and evaluates false (the shipped software team's five guards included — its supervisor drives the order, as before). A channel-setting mechanism (a `set_state` tool or a structured final) is an open design item for a later iteration; recorded here rather than invented in A1.
- **A1-5 Chart key is `postgres.extraDatabases`, not `additionalDatabases`** (the plan's name was wrong). The os-ui env composes `AGENT_RUNS_DATABASE_URL` from `postgres-agent-runs-credentials` + `pg-rw` with k8s dependent-env expansion, exactly like LiteLLM's `DATABASE_URL`. `setup()` runs at os-ui boot (`instrumentation.ts`, fire-and-forget, loud on failure) instead of a separate init Job — same idempotent call, one fewer workload.
- **A1-6 `recursionLimit` = step budget × 4 + 8**, not × 4 exactly: a tool-less agent visit costs 3 supersteps for 0 budget steps, so a small constant head keeps the first visits from hitting the limit on a tiny budget. The budget check in `plan_`/`route_` is what ends a run; the limit is the backstop and is reported, not thrown.
- **A1-7 `SCRIPT_ID` bumped to `first-tool-then-final@2`** and all 13 fixtures regenerated (reviewer request): the route rule is part of the rule set even though the walker never triggers it, and fixtures now record `outcome: ok|held|error` (M1) instead of `isError`. Regen is documented as single-file (M2).
- **A1-8 `runOsTeam` is the branch point.** The brief placed the `langgraph` branch in the three call sites; putting it inside `runOsTeam` (which all three already call, with the same deps) keeps them thin and guarantees they cannot disagree. The sites pass `engine`/`runId`/`resume` and read `runId`/`checkpointer` back.
- **A1-9 Disabled entrypoint is a compile error under `langgraph`** (the walker silently ran nothing). An honest error beats an empty run.
- **A1-10 Governance note for A5 (reviewer):** once `langgraph` enforces `when` guards and node-level tool narrowing, `runtime: walker` is a user-controlled opt-out of the stricter rules. Acceptable only because A5 retires the value — **A5 must actually remove `runtime: walker`** (and the walker), not leave it as an escape hatch.
- **A0-9 agent-templates fixtures are compositions.** `agent-templates.ts` ships per-agent fragments, not whole systems; each is wrapped as a single-agent system (role, instructions, suggested tools) to get a runnable fixture.

