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
- [x] Handoffs: evaluate `when` and return `Command({ goto })`. `when` grammar v1: literals, `state.<channel>` truthiness, **bare identifiers resolving to a channel of the same name** (A0 finding 2: the shipped software team uses `plan_ready`, `committed`, …), `==`/`!=` on strings, `&&`/`||`; a small hand-written tokeniser + recursive-descent parser, never `eval` (`lib/engine/when.ts`, 203 lines including its header and the compile-warning path — the plan's "~40-line parser" was an estimate written before it existed; B4-review E-4). Absent `when` = unconditional. A guard naming a channel no node ever sets is a **compile warning** surfaced in Build, not a silent false. **Decision taken for the owner:** safe expressions, not model-judged predicates.
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
- [x] In `tools_<id>`: compute hold decisions for the whole batch first; for each held call `enqueue` **once** (idempotent on `(threadId, callId)` — LangGraph re-runs the node from its start on resume), then `interrupt({ approvalId, tool, args })`. Execute non-held and approved calls as the **runner**. Rejected → typed tool result, the model continues.
- [x] Approvals carry `runId`, `threadId`, `interruptKey`. `core/policy/approvals.ts` `decide()` gains a post-hook: `graph.invoke(new Command({ resume }), { configurable: { thread_id: runId } })` under the runner's principal snapshot (role re-read live).
- [x] Governance Inbox card links to the run. Two additive SSE events: `approval-required`, `resumed`; panel renders them.
- [x] Decisions taken for the owner: the approver authorises, the **runner executes**; a parked approval has **no TTL** in v1 (documented as an open policy question in `docs/components/os-ui.md`).
- [x] Gate **P3**: a held write never executes before the decision; approve executes exactly once as the runner; reject surfaces to the model; a racing second approver gets null; a batch with one held and one non-held call executes the non-held exactly once.

#### A2 — what landed (commit on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Pure hold rule | `tabs/agents/lib/build/hold.ts` (`writeTargetScope`, `holdDecision`, `holdDecisionFor`); `os-tools.ts` re-exports, executor gains `opts.holdAt: 'executor' \| 'node'` |
| Tools node | `engine/build-graph.ts` `tools_<id>`: phase 1 hold for the whole batch → `ApprovalPort.enqueueOnce` → `interrupt({ approvalId, tool, node, args })`; phase 2 ONE call per superstep (`tools → tools \| act`); `rejected` typed result; `state.owner` stamp; `HeldCall { approvalId, decision }` |
| Approval port | `engine/approval-port.ts` (pure port + `memoryApprovalPort`), `engine/approvals-bridge.ts` (server, over `core/policy/approvals.ts`) |
| Approvals | `core/policy/approvals.ts`: `runId/threadId/interruptKey/systemId/node/runner/args/resume`, `enqueueOnce`, `onDecided`, `decisionSettled`, `recordResume`; `core/policy/effects.ts` no approver-side effect for a run approval |
| Resume | `engine/resume.ts` (`resumeAfterDecision`, typed refusals), `engine/resume-boot.ts` (registered from `instrumentation.ts`), `core/kernel/auth.ts` `principalById` (live role), `build/run-service.ts` (`prepareRunYaml`, `executeTeamRun`, `finalizeTeamRun`, `resumeOsRunAfterDecision`) |
| Engine run | `engine/run.ts`: `owner` gate (`ResumeNotFoundError` 404 / `RunAlreadyFinishedError` 409), `resumeWith`, `onInterrupt`, `parked` + `heldApprovals`, `inspectGraphRun`; `agentic-graph-server.ts` wires hold deps, `inspectOsRun`, `peekRunOwner` |
| Route / stream | `app/api/agents/systems/[id]/run/route.ts` on the run service; SSE `approval-required`; `done.parked/heldApprovals`; new `run/stream/route.ts` (GET re-attach, owner-checked) over `engine/run-events.ts` (adds `resumed`) |
| UI | `BuildRunPanel.tsx` parked banner + auto re-attach, warnings/checkpointer line, Resume only on `postgres`; `ApprovalsInbox.tsx` agent-run block + resume badge |
| MCP | `core/mcp/agent-write-tools.ts`: `resume_agent_run` (write catalog), `run_agent_system.parked/heldApprovals`; `core/mcp/discovery-base-tools.ts`: `get_agent_run` (a read, beside `get_agent_system`); `governance-tools.ts` `decide_approval` awaits/returns `resume`; `newRunId` from `core/kernel/run-id.ts` |
| Tests | `engine/approvals.test.ts` (P3 a–e, H1, M4, M5), `engine/resume.test.ts` (P3 f), `engine/run-events.test.ts`, `core/policy/approvals-hook.test.ts`; parity harness holds at the node |


### Phase A3 — One Langfuse trace per run; LiteLLM attribution and keys
- [x] Langfuse JS SDK (~~`langfuse-langchain` `CallbackHandler`~~ — the SDK directly, see A3-1), root trace **id = runId**; nodes → spans, model calls → generations with usage, tool calls → spans with the decision in metadata. `trace()` in `core/infra/agent-governed.ts` becomes a span under the run trace. `LastRun.traceUrl` deep-links to the run. Keep the in-process ring for Monitoring-without-Langfuse.
- [x] **Close the leak:** `app/api/agents/systems/[id]/run/diagnostics/route.ts` filters observations by the run's trace id (interim: by `fromTimestamp` and user), never unfiltered.
- [x] Write the LLM-judge verdict as a Langfuse **score** on the run trace (`evaluate/route.ts`).
- [x] LiteLLM: add `TAG_RUN` to `litellm-credential.ts`; pass `domain` and `systemId` at the four call sites that drop them (`core/runtime/complete.ts`, `core/runtime/agent-loop.ts`, `agentic-graph-server.ts` ×2). Route `app/api/classify/route.ts`, `tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts` through `callerCredential` — **no master key on any inference path**; extend the `MODEL-KEY` gate test to assert only `litellm-admin.ts`, `litellm-write.ts` and `build/live-clients.ts` reference `litellmMasterKey`. Make the embed hash fallback explicit: timeout → fallback labelled `offline-hash`; 4xx → throw.
- [x] Use the reconciled **per-agent key** for a run when it exists (`live-clients.ts` mints `sk-<alias>`); fall back to the shared agent key; never the master key.
- [x] Chart: `failure_callback: ["langfuse"]`; Valkey cache for classify/suggest/embed; a chart test that `litellmAgentKey.models` ⊇ every `LITELLM_*_MODEL` default, `agentRuntime.*Model`, and every router `fallbacks` target. Teach `gateway-mirror.ts` the `run:` tag.
- [x] Gate: Langfuse shows one trace per run in the local kind install (or, if no cluster is available, a recorded-ingestion test asserts one `trace-create` + N spans sharing the id); `MODEL-KEY` passes repo-wide; attribution test asserts `user`, `domain:`, `agent:`, `run:` on a real run's outgoing request.

#### A3 — what landed (commit on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Langfuse client + filtered reads | `core/infra/langfuse.ts` — `langfuseClient` (buffered SDK singleton, test seam), `langfuseEnabled`, `traceUrlFor` (`<console>/trace/<runId>`), `scoreTrace`, `observationsQuery` (typed `UnfilteredLangfuseQueryError`), `readObservations` |
| Run observer | `tabs/agents/lib/engine/observe.ts` — `RunObserver`/`SpanHandle` port, `langfuseRunObserver` (client injected; one `trace-create`, resume adds only), `noopObserver`, `redactRequest`/`redactCompletion`, `runTraceTags` |
| Node instrumentation | `engine/build-graph.ts` `observed()` wraps every node; `GraphDeps.observe`; `obs.llm()` generations with `req.observe`; `obs.tool()` / `toolEvent()` for every call with the decision; `run.ts` `finish()` + background `flush()`, result `traceId`/`observed` |
| Governance spans | `core/infra/agent-governed.ts` `TraceEvent.run` → span of the run trace via the SDK; `os-tools.ts` `ExecutorOptions.traceContext` threads it; `agentic-graph-server.ts` wires it and the run-summary trace |
| Gateway nesting + attribution | `core/runtime/agentic.ts` `LlmRequest.observe`; `runtime.ts` `liteLlmCaller` forwards `existing_trace_id`/`parent_observation_id`/`trace_user_id`/`session_id`; `litellm-credential.ts` `TAG_RUN`, `CallerContext.runId/keyRef`, `keySource`, `GatewayRejectedError`/`classifyRejection`/`isClientRejection` |
| Call sites | `agentic-graph-server.ts` ×2, `core/runtime/complete.ts` (domain), `core/runtime/agent-loop.ts`, `app/api/classify/route.ts`, `tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts` (+ `core/infra/context/librarian-live.ts` guard) |
| Master key confined | `app/api/gateway/route.ts`, `app/api/platform-admin/{mcp-apis,providers,models/assistant,models/[id]}/route.ts`, `tabs/admin/lib/model-remove.ts` (injected `GatewayIo`), `tabs/monitoring/lib/adapters/cost.ts` → `litellm-admin.ts`/`litellm-write.ts`; `runtime.test.ts` MODEL-KEY repo-wide |
| Per-agent key | `tabs/agents/lib/store.ts` `LastBuild.litellmKeyRef`; `app/api/agents/systems/[id]/build/route.ts` persists the secret reference after a live build; `live-clients.ts` `agentKeyValue`; `run-service.ts` passes `keyRef` into `runOsTeam` |
| Deep link + score | `run-service.ts` `finalizeTeamRun` (`traceUrl`, `traceStoreAvailable`); MCP `run_agent_system`/`resume_agent_run`/`get_agent_run` `traceUrl`; `evaluate/route.ts` `judge` score; `run/diagnostics/route.ts` by trace id; `BuildRunPanel.tsx` passes `runId` |
| Mirror | `tabs/admin/lib/gateway-mirror.ts` `spend.byRun` |
| Chart | `values.yaml` `litellm:` — `failure_callback`, `cache`/`cache_params` (Valkey `valkey:6379`, `mode: default_off`), `extraEnvVars` `REDIS_PASSWORD`; `values.stackit-managed.yaml` `litellmAgentKey.models`; `scripts/check-litellm-allowlist.mjs` in `os-ui/scripts/gate.sh` |
| A2 review | `approvals-bridge.ts` + `governance-tools.ts` hydrate (M-A); `engine/run-lock.ts` + `executeTeamRun` (M-B); `core/policy/roles.ts` `canApprove` self-exclusion (L-G); `approvals.ts` `parked` status + `resume_hook_unregistered` (L-F, L-C); route headers (L-A) |
| Tests | `engine/observe.test.ts` (a, b, redaction), `engine/attribution.test.ts` (d), `core/infra/langfuse.test.ts` (c), `engine/run-lock.test.ts` (M-B), `runtime.test.ts` MODEL-KEY repo-wide (e), `knowledge/lib/embed.test.ts` + `files/lib/embed.test.ts` (f), `check-litellm-allowlist.mjs` (g), `litellm-credential.test.ts`, `gateway-mirror.test.ts`, `roles.test.ts`, `approvals-hook.test.ts`, `model-remove.test.ts` |
| Docs | `docs/components/langfuse.md` (rewritten), `docs/components/litellm.md`, `os-ui/ARCHITECTURE.md` "One trace per run", `tabs/agents/README.md`, `CHANGELOG.md` |

### Phase A4 — Worker
- [x] `os-ui/worker/agent-runs.ts` entrypoint in the same image (Node type-stripping already runs `.ts`): pulls `run_jobs` (`FOR UPDATE SKIP LOCKED`), drives `graph.stream()`, writes `run_events`; the route becomes enqueue + tail. Scheduled runs (`build/scheduled.ts`) use the same start service. Runner `Principal` snapshot serialised with the job; role re-read at start and every resume.
- [x] Chart: a `os-ui-worker` Deployment from the same image with a different command; `replicas: 1` initially.
- [x] Gate: ~~a run longer than 300 s completes; an os-ui rolling restart loses no run~~ (both `untestable here` — the exact cluster steps are in `docs/components/os-ui.md` → "Verify it in a cluster" and in the checklist rows A14/A18); P1–P3 green in `inline` mode (the default), which writes the same `run_events` through the same executor.

#### A4 — what landed (commit on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Job store port + memory implementation + tail | `tabs/agents/lib/engine/jobs.ts` — `RunJobStore`, `RUN_EVENT_NAMES`, typed `RunJobConflictError` (409) / `RunJobNotFoundError` (404), `memoryRunJobStore`, `runEventSink` (serialised writes, vocabulary-filtered), `tailRunEvents` (`until: 'terminal' \| 'settled'`), `isTerminalEvent` |
| Postgres implementation + migrations | `engine/jobs-postgres.ts` — `RUN_JOBS_DDL` (idempotent), `migrateRunJobs`, `postgresRunJobStore` (claim = `FOR UPDATE SKIP LOCKED`; `seq` derived in SQL), `runJobStoreFor` (one `globalThis`-pinned pool per URL, lazy `pg`) |
| Worker loop (pure) | `engine/worker-loop.ts` — `workerTick` / `workerLoop`: reap → claim → heartbeat → execute; store, executor, clock and `sleep` injected |
| Live identity | `engine/runner-identity.ts` — `principalSnapshotOf`, `hydrateRunner` (typed `runner_unavailable` / `runner_role_changed` / `runner_domain_lost`) |
| Server wiring + the one start door | `tabs/agents/lib/build/run-jobs-server.ts` — `runJobStore`, `ensureRunJobsReady`, `enqueueRun`, `drainOne`, `executeJob`, `startAgentRunsWorker`, `startQueuedRun`, `resumeQueuedRun`, `followRun`, `enqueueResumeAfterDecision` |
| Worker entrypoint | `os-ui/worker/agent-runs.ts` (`bootWorker` = instrumentation parity: secret guard, resume hook, approvals hydration, checkpointer `setup()`, `run_jobs` DDL, a Langfuse PROBE — `langfuseClient()` is resolved lazily at each use site and the boot only records whether one is configured, so a worker with no Langfuse starts normally (B4-review E-4); `main()` = loop + SIGTERM), `worker/start.mjs`, `worker/resolve-hook.mjs`, `worker/empty.mjs` |
| Config | `core/kernel/agents-worker.ts` (`parseAgentsWorkerMode`), `config.agentsWorker` ← `AGENTS_WORKER`, `config.agentsWorkerLeaseMs` ← `AGENTS_WORKER_LEASE_MS`, `config.langfuseRedaction` ← `LANGFUSE_REDACTION` |
| Routes | `app/api/agents/systems/[id]/run/route.ts` (langgraph → enqueue + tail from `seq=0`; walker unchanged and request-bound; governed yaml now lazy), `run/stream/route.ts` (tails `run_events` from `afterSeq`, owner-checked against the `run_jobs` row) |
| Other doors | `build/scheduled.ts` (`deps.startQueuedRun`, langgraph branch), `core/mcp/agent-write-tools.ts` (`run_agent_system`, `resume_agent_run`), `engine/resume-boot.ts` → `enqueueResumeAfterDecision`; `ApprovalResume.status` gains `queued`; `resumeOsRunAfterDecision` removed from `run-service.ts` |
| Boot | `instrumentation.ts` runs `ensureRunJobsReady()` next to the checkpointer `setup()` and logs the mode |
| Chart | `templates/base/os-ui/_os-ui-env.tpl` (`soa.osUI.env`, extracted — byte-identical render), `os-ui-worker.yaml`, `values.yaml` `osUI.worker{enabled,replicas,leaseMs,terminationGracePeriodSeconds,resources}` + `osUI.langfuseRedaction`; `images/base/os-ui/Dockerfile` bakes the source at `/app/src` |
| Tests | `engine/jobs.test.ts` (14), `engine/jobs-postgres.test.ts` (8 SQL tripwires), `engine/worker-loop.test.ts` (9), `engine/jobs-resume.test.ts` (2, over A2's P3 fixtures + a real `MemorySaver`), `engine/runner-identity.test.ts` (7), strict-redaction case in `observe.test.ts`; all five added to `os-ui/scripts/gate.sh` |

### Phase A5 — Deletion and docs
- [x] Delete: `agentic-graph.ts` walk (keep the Librarian/handoff-curation helpers), `build/run-graph.ts`, `images/base/agent-runtime/` and its chart block, `live.ts` `/reload` path, `runtime-contract.ts` wire types; the `hermes` runtime option unless a runtime exists for it (it does not). ~~Flip the engine default to `langgraph`, then delete~~ **delete** the flag (A5-2: there was no reason to ship a default nobody could change).
- [x] Make `README.md`, `docs/components/os-ui.md`, `docs/components/langfuse.md`, `docs/components/litellm.md`, the runtime badge, `core/kernel/licenses.ts` and `sbom.cdx.json` true. Explain in `os-ui/ARCHITECTURE.md` how a `system.yaml` becomes a StateGraph.
- [x] MCP: `run_agent_system` returns `runId` and `traceUrl`; add `resume_agent_run` and `get_agent_run` (state, held approvals); `decide_approval` resumes the thread. `tabs/agents/README.md` lists them.

#### A5 — what landed (three commits on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Parity gate, recorded before any deletion | this file, "A5 — the parity gate, fixture by fixture" (A5-review-L-2: the real split is **parity 16 · fixtures 16 · MCP run surface 9**, not one file of 28; the review round takes parity to 21 with shape (d)) — 0 failures; 11 fixtures identical, `software-team` identical, `shape-guarded-handoff-held-write` deliberately divergent |
| The walk, deleted | `build/agentic-graph.ts` loses `runAgenticGraph` + `nodeOrder` (−146 lines) and becomes the **agent NODE layer** the graph calls into (model tier, system prompt, handoff + Librarian, status classification, `runNode` for the phase-router chat). `build/run-graph.ts` + test `git rm`'d |
| The Python runtime, deleted | `images/base/agent-runtime/**` (7 files), the Deployment/ConfigMap/Service in `charts/.../base/agent-runtime/agent-runtime.yaml`, its dedicated egress policy + the `NotIn` exclusion in `network/egress-policies.yaml`, `AGENT_RUNTIME_URL` in `_os-ui-env.tpl` and `config.ts`, `realRuntime`/`RuntimeClient`, `app/api/agents/tool/route.ts`, the CI pytest steps, the `scripts/os` image row, `agentRuntime.{enabled,image,resources,*Model}` |
| The flag, deleted | `core/kernel/agents-engine.ts` + test, `engine/select.ts` + test, `config.agentsEngine`, `runtime: walker`; `Runtime` collapses to `'langgraph'` with retired names normalised on parse; `instrumentation.ts` logs one deprecation line if `AGENTS_ENGINE` is still set |
| The branch points, collapsed | `runOsTeam` (one path, `runId` now required), the run route (always enqueue + tail; `runSystem`/legacy branch gone), `build/scheduled.ts` (one start door), MCP `run_agent_system`; `run-service.ts` loses its `engine` parameter and reports `engine: 'langgraph'` |
| The gate that replaced `isAgenticOsTeam` | `os-tools.ts` `unmappedGrantNames(sys)`; the three run doors return a 400 naming the offending grants |
| Build, re-based | `build/compile-verify.ts` (`compileVerify(sys, ir)` → `buildGraph` with inert deps) consumed by BOTH `live.ts` and `mocks.ts`; `gatewayAdminReachable()` replaces `runtimeReachable()` as the live/mock switch |
| MCP | `get_agent_run` + `run_events` tail (`afterSeq`/`limit`/`nextSeq`, `eventsAvailable`) and `assertRunVisible`; diagnostics route owner-gated; descriptions + `tabs/agents/guide.md` teach build → run → follow → approve → resume → trace |
| Docs | `tabs/agents/README.md` (engine section rewritten), `os-ui/ARCHITECTURE.md`, `docs/components/{os-ui,langfuse,litellm}.md`, `README.md`, `components/README.md`, `os-ui/README.md`, both seed READMEs, `CHANGELOG.md` |
| Tests | `core/mcp/agent-run-surface.test.ts` (9, new); rewritten `build/agentic-graph.test.ts` (12), `engine/fixtures.test.ts` (frozen-fixture checks incl. the recorded defect), `engine/parity.test.ts` (engine side only), `build/scheduled.test.ts` (one start door + a tripwire), `build/live.test.ts` (compile + compile-failure rows), `gateway.test.ts`, `wave-a.test.ts`, `orchestrate.test.ts`, `validation-gate.test.ts`, `platform.test.ts`, `model-prices.test.ts`, `os-tools.test.ts`, `agentic-graph-server.test.ts`; `gate.sh` gains parity, fixtures, build-graph and the MCP surface |

**Gate at A5:** `tsc --noEmit` clean · `npm --prefix os-ui test` **4956 tests, 0 failures, 4 todo**
(baseline before A5: 4988 / 0 / 7 — the walker's own tests went with it) · `check-structure` ok,
baseline LOWERED by deletion (TAB-ISOLATION 422→421, FILE-HEADER 1245→1240) · `gate.sh` exit 0
(161 → 182 tests) · `helm lint` with and without `osUI.worker.enabled=true`, and with
`agentRuntime` removed entirely · `helm template` renders **no** `agent-runtime` Deployment or
Service · `check-litellm-allowlist` PASS on both profiles.

#### A5 — the parity gate, fixture by fixture (run 2026-11-13, before any deletion)

`node --test tabs/agents/lib/engine/parity.test.ts` — 16 tests, 0 failures, 2 `todo` (A5-review-L-2:
the "28" first recorded here counted the parity + fixtures files together; the two files are 16 and
16, and `core/mcp/agent-run-surface.test.ts` is 9. After the review round parity is **21** — shape
(d) `channel-guarded-handoff` is driven four ways plus a node-narrowing test — and fixtures is
still 16). The harness
drives BOTH engines per fixture in one process (`replayWalker` vs `replayGraph`/`scriptGraph`), so
there is no `AGENTS_ENGINE` to set: the table IS the two-engine comparison.

| Fixture | walker | langgraph | verdict |
|---|---|---|---|
| `agent-template-analyst` | green | green (replayed transcript) | identical |
| `agent-template-blank` | green | green (replayed transcript) | identical |
| `agent-template-recommender` | green | green (replayed transcript) | identical |
| `agent-template-researcher` | green | green (replayed transcript) | identical |
| `agent-template-reviewer` | green | green (replayed transcript) | identical |
| `shape-single-read` | green | green (replayed transcript) | identical |
| `shape-supervisor-two-members` | green | green (scripted route, declared order) | identical |
| `template-analyze` | green | green (replayed transcript) | identical |
| `template-blank` | green | green (replayed transcript) | identical |
| `template-evaluate` | green | green (replayed transcript) | identical |
| `template-recommend` | green | green (replayed transcript) | identical |
| `software-team` | `todo` (guarded; the walker ignores its five `when` guards) | green — same path, tools and final text as the walker golden, **plus** five compile warnings naming `plan_ready`, `committed`, `tests_failed`, `tests_passed`, `reported` (A5-review-H-2: those five channels are now DECLARED and settable, so the warnings are **zero** and the path is unchanged — the scripted model simply never sets them) | identical path, warnings now zero |
| `shape-guarded-handoff-held-write` | `todo` (guarded) | green — path `['researcher']`, `held=0` | **deliberate divergence** |

P2 (abort after node 1 → resume on the same thread) and "resume of an unknown thread is a typed
error" are green. Full suite at the gate: **4988 tests, 0 failures, 7 `todo`**; `check-structure`
no new violations.

**The one divergence, and why it is not a parity failure.** `shape-guarded-handoff-held-write`
carries `when: state.findings_ready`, which nothing sets. The walker ignored the guard, visited
`publisher` and held its `request_promotion` write (`held=1` in the golden). The LangGraph engine
evaluates the guard, finds it false, routes to END and never visits `publisher`. The audit named
exactly this: `when` guards, conditional edges, supervisor return and channels were *silently
discarded* by the walkers. "The walker ignored it" is not parity to preserve — the golden records
the defect on purpose (`assert.ok(golden.path.includes('publisher'), 'the walker golden still
records the defect')`) and the HANDOFF-GUARD test asserts the new, correct behaviour. The gate is
therefore **passed**: every fixture either matches or diverges in the direction the plan requires,
and the divergence is pinned by a test rather than by a comment.

#### A5 review round (2026-11-13) — what the review found and what was done

Decisions recorded as `A5-review-<id>`; the fixes are three commits on `feat/engine-rebuild`.

- **A5-review-H2-1 A channel DECLARATION is a type, and the type is the default.** `state.channels`
  was a map of name → *reducer*, with everything but `add_messages` meaning "last value, default
  `undefined`". For `os_set_state` to type-check a write, the declaration has to say what the
  channel holds, so the value is now read as `add_messages` | `boolean` | `number` | `string` |
  `json`, each typed key starting at that type's default (`false` / `0` / `''` / `null`). No new
  YAML shape was invented for an explicit default (`plan_ready: { type: boolean, default: false }`
  would have needed schema, serializer and UI changes for one value that is already implied). Any
  unrecognised declaration — notably the legacy `last_value`, which three fixtures use — stays an
  untyped `json` channel, so **no existing `system.yaml` changes meaning**.
- **A5-review-H2-2 The setter is advertised to the agent whose guard reads the channel, not to
  every agent.** The brief said "every agent gets a built-in `set_channel` tool". Two reasons it is
  narrower: (a) node-level tool narrowing is the engine's own rule — an agent is advertised what it
  needs and nothing else — and the guard of a handoff FROM node `n` is evaluated in `route_<n>`,
  immediately after `n`'s turn, so `n` is exactly the agent that can act on it; (b) a tool-less
  agent (the orchestrator and the communication agent of the shipped team) would otherwise be
  handed `os_set_state` as its FIRST advertised tool, which the frozen parity script calls — the
  goldens would have changed for a reason that has nothing to do with the walker. The tool's
  `channel` enum is still the system's full declared set, so a writer is closed to the
  DECLARATION, not to its own edges.
- **A5-review-H2-3 The write is not a governed tool call.** `os_set_state` never reaches
  `deps.callTool` / `grantedToolExecutor`, is filtered out of the hold batch before
  `holdDecisionFor` sees it, and cannot be held for approval: there is no OS object behind it. It
  is recorded as a normal `tool-step` (so the Run panel, the event log and the Langfuse span tree
  all show it, with `state.<channel> = <value>` as the span detail) and an illegal write comes back
  as a typed `invalid_argument` result the model can read. Wrong-typed values are REFUSED, with the
  one tolerance that a model's string forms of a boolean/number (`"true"`, `"3"`) are coerced —
  rejecting those teaches nothing and burns a tool round.
- **A5-review-H2-4 The supervisor sees the channels.** `route_<sup>`'s prompt gained a
  `--- TEAM STATE ---` line listing the current channel values. It was already *routing* on them
  (handoff guards are evaluated in the route node before the model is asked), but its own decision
  was blind to the team's recorded state, which is the thing that makes a supervisor + guards
  combination coherent.
- **A5-review-H2-5 Shape (d) is an ENGINE shape, not a frozen fixture.** The new
  `channel-guarded-handoff` lives in `parity-harness.ts` beside `P2_YAML` and is driven from
  `parity.test.ts`, NOT added to `fixtureSpecs()`: a frozen fixture is a WALKER golden, the walker
  is deleted, and `fixtures.test.ts` would (correctly) demand a `.json` that cannot exist. The
  proof is the comparison of two runs of ONE graph — with the write and without it — plus the
  undeclared-channel and wrong-type refusals and a node-narrowing test that reads the advertised
  tools off the real model requests. Checklist **A8** is updated to cite it.
- **A5-review-H2-6 The shipped team's yaml changed, so three files changed with it.**
  `SOFTWARE_TEAM_YAML` declares the five channels (one-line purpose each) and four `agent_md`
  blocks say which gate they record; `seed/software-team/system.yaml` is regenerated from the
  constant (the byte-identical test) and the frozen fixture's `yaml` field is updated — which is
  exactly the "a template edit must be a visible fixture change" that `fixtures.test.ts` asks for.
  The fixture's GOLDEN is untouched: `software-team` is supervisor-driven, so its path comes from
  the scripted route rule, and the scripted model never calls the setter.
- **A5-review-H-3 The schedule CronJobs were wearing the deleted runtime's label.** A5 deleted the
  runtime's dedicated egress policy and widened `allow-intra-namespace-egress` to `podSelector: {}`
  with the note "there is nothing left to lock down here". There was: `schedule-cronjobs.yaml`
  still labelled its pods `component: agent-runtime`, so a pod whose entire job is one `curl` to
  os-ui inherited the whole in-namespace plane — and, through `allow-apiserver-egress` (which
  carries no `to:`), 443/6443 to anywhere. Pods are now `component: agent-schedule`, excluded from
  both blanket policies with the same `NotIn` the runtime used (an absent label still matches
  `NotIn`, so nothing else loses its allow), and governed by `allow-agent-schedule-egress`:
  `component: os-ui` port 3000, plus the namespace-wide DNS policy. Verified by rendering the chart
  with one populated schedule.
- **A5-review-H-1 / M-4 The token Secret moved to B2's file and stopped depending on its own
  value.** A5 kept the Secret in `agent-runtime.yaml` to avoid conflicting with the data branch,
  which had already moved it to `agent-runtime-token.yaml`; the merge would have had to resolve two
  files defining one Secret. This branch now `git rm`s `agent-runtime.yaml` and carries B2's file
  verbatim (A5-1's note moved into its header), so the merge sees one file with a comment-block
  difference. B2's gate also happens to be the M-4 fix: it does not test `$r.token`, where A5's
  `and $token (eq profile "local")` rendered nothing for `agentRuntime.token: ""` while
  `_os-ui-env.tpl` mounts the key through a NON-optional `secretKeyRef` — os-ui would fail to
  start. `helm template --set agentRuntime.token=` renders exactly one Secret and the reference.
- **A5-review-M-1 An agent run id is owner-gated in Monitoring too.** `get_run_trace` used
  `assertInScope`, which is builder-domain-wide AND answers 403 for an in-scope-but-foreign trace —
  so a builder could read a colleague's agent run, and the 403/404 split confirmed a guessed id
  exists. For `isRunId(id)` the tool now goes through `assertRunVisible` over the checkpoint's
  owner stamp (`peekRunOwner`), the same gate as `get_agent_run`; an unreadable checkpointer falls
  through to 404 rather than widening. Other trace ids keep the scope gate.
- **A5-review-M-3 The judge route was a run-addressed door nobody had treated as one.** `POST
  /api/agents/systems/<id>/evaluate` accepted a body `runId` and wrote a Langfuse SCORE on that
  run's trace; `getSystem` is read-scope, so even the implicit `view.lastRun` can be a colleague's
  run on a Shared system. The gate now runs before the judge's model call: an explicitly requested
  foreign run is 404, the implicit fall-back scores nothing and still returns the verdict. Both
  this route and `monitoring-tools.ts` joined the tripwire door list, which now also requires the
  gate to precede `scoreTrace(` and `fetchTrace(`.
- **A5-review-L-4 `list_runs` stays scope-wide — documented, not changed.** `filterScope` is the
  Monitoring tab's own ladder, and the MCP must not be stricter than the UI it mirrors. What was
  missing is that the two halves differ: the LISTING is scope-wide (a builder sees that a
  colleague's run exists, its health and its cost), the CONTENTS are owner-only. Both tool
  descriptions now say so, because `list_capabilities` is what an AI reads. Narrowing the listing
  to the owner is a Monitoring-tab decision, with the UI, not an MCP-only change.
- **A5-review-L-5 `holdAt: 'executor'` stays, as A5-9 already argued.** It has no production
  caller — every graph node passes `'node'` — but gate 1b in the executor is the only hold a
  non-graph caller would get, and its tests are the only proof the executor can hold at all.
  Removing it would delete a defence and a test for no behaviour change. Recorded as a follow-up
  for whoever retires the executor hold path entirely.
- **What the review itself got slightly wrong.** (a) It said the declared channels "become real
  typed state keys" as if none existed — they were already state keys with declared reducers
  (`A9` tests that); what was missing was the TYPE and the WRITER. (b) It read `egress-policies.yaml`
  policy 6 as deleted and the fix as "give them their own policy"; a narrow policy alone would not
  have helped, because NetworkPolicy is additive — the `NotIn` exclusions in policies 3 AND 4 are
  what makes it a lockdown. (c) `agentRuntime.enabled` no longer exists, so B2's `$needed` leans
  on `osUI.enabled` / `dagster.enabled`; that is correct today but it is a gate on OTHER
  components' flags, which is worth a second look when the data side lands.

---

## Part B — Data products: dbt + Dagster + Trino

**Principle:** a data product in the OS is a dbt project the user could check out and run. The OS generates and owns the files **in a git repository per domain**; Dagster schedules and materialises them **from a validated commit**; Trino executes them **as the acting principal via impersonation**. The OS reads back Dagster run state and dbt artifacts rather than keeping a parallel ledger.

**Detail:** `2026-11-13-data-products-concept.md` (Phase B0 output). Decisions recorded there and adopted here: isomorphic-git in os-ui with bare repos on a PVC and a read-only git-daemon sidecar; **one Dagster code location for all domains** with per-domain parse gating; `dbt-runner` is an impersonation-only Trino user and OPA's write floor becomes authoritative; commit first, validate second; no OS run ledger.

### Phase B0 — Audit and concept (read-only; may run in parallel with A0)
- [ ] Audit how datasets, transforms, compositions, syncs and quality rules execute today (`tabs/data/lib/{ingest,transform,sync-sql,sync-cron,sync-run-server,auto-gold,auto-pipeline,dq-*}.ts`, the Dagster image and chart block, the dbt image, the data-runner and query-tool services). Separate docs claims / code present / wired at runtime, as the agent audit did. **Attribution (B4-review E-4):** the 2026-11-10 audit PDF covered only the AGENTS side — LangGraph, Langfuse, LiteLLM — so none of the data-side facts below come from it. They are B0's own findings, recorded in `2026-11-13-data-products-concept.md`; where this file or the checklist credited "the audit" for a data claim, it meant the B0 concept. Known facts B0 established and this phase verifies: scheduled syncs are Kubernetes CronJobs curling an os-ui route, not Dagster; transforms are Trino CTAS composed in TypeScript, not dbt models; Dagster had no Postgres driver in its image and 0 runs in 90 days.
- [ ] Concept: the mapping. Dataset/composition → dbt model (`models/<domain>/<slug>.sql` + `schema.yml` with tests from quality rules); sync → Dagster asset with a schedule/sensor, `dbt_assets` for the project; Trino as dbt's target via `dbt-trino`; lineage from dbt manifest; run history from Dagster GraphQL. Where the generated project lives (a git-backed volume or the OS's object store), how the OS reads back `manifest.json` / `run_results.json`, and how the MCP exposes the same operations. Decide and write the plan for B1–B4 into this file.

### Phase B1 — dbt project generation
- [x] `tabs/data/lib/dbt/`: generate a dbt project per domain from the OS's dataset definitions: `dbt_project.yml`, `profiles.yml` (Trino target, credentials from secrets, never inlined), `models/`, `schema.yml` with `not_null`/`unique`/`accepted_values` tests compiled from quality rules. Byte-stable output; a test asserts regeneration is idempotent.
- [x] Compositions compile to dbt models (`{{ ref() }}` between datasets) instead of ad-hoc CTAS; the existing Gold compiler becomes the SQL body generator inside a model. *(Body = the `compileGoldJoin` output recorded at build, FQNs rewritten — see deviation B1-2.)*
- [~] `dbt parse` in the dbt image validates the generated project in Build. Gate: generated project parses; golden-file tests for three shapes. *(Golden tests green; the `repo-sync` sidecar + script that runs `dbt parse` per commit are in the chart/image; the kind run of `dbt parse` is **untestable here** — no cluster in this worktree. Checklist D1 `kind` half open.)*

#### B1 — what landed (commit on `feat/engine-rebuild-b1`)

| Piece | Where |
|---|---|
| Git store (isomorphic-git 1.44.13, MIT; LICENSE.md verified) | `core/infra/git-store.ts` (`openOrInit`, `commitTree` iff tree changed, `log`, `readBlob`, `listTree`, `archive`, `push`, `commitMessage`, `authorFor`), `core/infra/tar.ts`, tests `git-store.test.ts` |
| Request surface (`ui:<route>` / `mcp:<tool>` + request id) | `core/infra/request-surface.ts`; `withRoute` wraps every handler; `data-write-tools.ts` wraps every data MCP tool; hand-rolled `datasets/[id]` + `checks` POST wrapped |
| Generator (pure, byte-stable) | `tabs/data/lib/dbt/{snapshot,emit,models,sources,schema,schedules,project,generate}.ts`; goldens `fixtures/{ingested-pass-through,composition-with-tests,append-sync-with-cursor}.golden.json`; `generate.test.ts` |
| One commit path + boot wiring | `tabs/data/lib/project-events.ts` (store → events), `tabs/data/lib/dbt/commit.ts` (`commitDataProject`, `installDataProjectCommitHook`), `instrumentation.ts`; `store.ts` `persist()` + 11 bypassing writers emit; `datasetsForProject`; `commit.test.ts` (31 mutators × flag on/off) |
| Read access + mirror | `tabs/data/lib/dbt/{read,mirror}.ts`; routes `app/api/data/projects/[domain]/{route,blob/route,export/route}.ts`, `app/api/platform-admin/data-projects/[domain]/mirror/route.ts`; `read.test.ts` |
| Chart + image | `templates/base/os-ui/os-repos.yaml` (PVC, Service, NetworkPolicy), `os-ui.yaml` (env, volume, `git-daemon` sidecar), `values.yaml` (`osUI.dataProjectGit`, Dagster `repo-sync` sidecar, `TRINO_SCHEMA: sales`), `images/extensions/dagster/{Dockerfile,repo-sync.sh}` |
| Config + licences + docs | `config.dataProjectGit` / `reposDir` / `dataProjectMirrorsIndex`; `THIRD-PARTY-LICENSES.md`, `licenses/components.tsv`, `core/kernel/licenses.ts`, `licenses/notices/os-ui-git-store-npm-NOTICE.txt`; `docs/components/{dbt,dagster}.md`, `tabs/data/README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` |

### Phase B2 — Dagster as the scheduler
- [x] Fix the Dagster image (Postgres driver) and verify a run completes in kind. *(Drivers and `git` confirmed present in the Dockerfile; `os_projects.py` added; image tag bumped `0.2.0` → `0.3.0` in all four places. The **kind run is untestable here** — no cluster in this worktree; checklist D10 stays open.)*
- [x] Generate a Dagster code location ~~per domain~~ **for all domains** (concept §2.3): `dbt_assets` over each validated commit, schedules from `os/schedules.yml`, a failure sensor, an inactive-principal sensor, a weekly Iceberg maintenance job. `set_dataset_sync` provisions no `batch/v1` CronJob with the flag on (and removes a pre-B2 one); UTC and Dagster's skip-missed-tick semantics are preserved. *(One asset per external sync source is **not** done — see deviation B2-6; `sync-cron.ts` was still present at B2 and was **deleted in B4** — only the delete-only `sync-cron-removal.ts` remains, and since B4-review H-1 the boot reconcile calls it for every synced dataset.)*
- [x] Read back: run status, materialisations, asset checks and the next tick via Dagster GraphQL into the Data tab, `get_sync_status`, the DQ surfaces and Monitoring; the OS writes no `os-sync-runs` / `os-dq-results` row for a Dagster-executed run.
- [~] Gate: a scheduled sync materialises through Dagster in kind; the OS shows the Dagster run; `sync-cron.ts` deleted. *(Unit + Python gates green — see the table; `sync-cron.ts` **was deleted in B4**, so only the **kind** half is open.)*

#### B2 — what landed (commit on `feat/engine-rebuild-b2`)

| Piece | Where |
|---|---|
| Repo index (closes B1-8) | `GET /api/data/projects` → `{domains:[{name, head, principals:[{id, active}]}]}`; `core/infra/git-store.ts` `listRepos`, `tabs/data/lib/dbt/read.ts` `projectIndex` + `schedulePrincipals`; runtime bearer **or** signed-in user (narrowed to their domains) |
| `sovereign` code location | `images/extensions/dagster/repo.py` (thin wiring) + `os_projects.py` (pure: `discover`, `ensure_checkout`, `parse_schedules`, `schemas_from_manifest`, tag builders, `should_pause`, `fetch_index`, `inactive_principals`); `tests/test_os_projects.py` (15 tests, `python3 -m unittest`) |
| Dagster client | `core/infra/dagster.ts` — `Fetched<T>`, timeout, injectable `fetch`: `launchRun`, `run`, `runsForDataset`, `recentOsRuns`, `assetChecks`, `allAssetChecks`, `latestMaterialization`, `assetGraph`, `reloadLocation`, `nextTick`, `k8sEnvTag`, `scheduleNameFor`; `dagster.test.ts` against a fake GraphQL endpoint |
| Launch after commit | `tabs/data/lib/dbt/launch.ts` (`launchAfterCommit`, `launchDatasetBuild`, `waitForAssets`, `batchIdForRetry`, `reconcileSyncSchedule`, `runSyncNow`) + `asset-keys.ts` (`datasetAssetKeys`, `selectionForBuild`, `selectionForSync`); `store.setVersionRun`, `VersionState.{commit,dagsterRunId,launchError}`; wired in the transform / gold-join / sync routes and `transform_silver` / `build_gold_join` / `sync_dataset_now` / `set_dataset_sync` |
| Read-back | `tabs/data/lib/sync-status-server.ts`, `tabs/data/lib/dq-status-server.ts`; consumed by the sync route GET, `get_sync_status`, the dataset DQ route, `/api/monitoring/data-quality`, `tabs/monitoring/lib/{artifacts-view,detail-view}.ts`; `tabs/monitoring/lib/adapters/pipeline-health.ts` rewritten onto the typed client and the `os/*` tags |
| Sweeps stood down | `/api/data/sync-due` and `/api/data/dq/run-all` return `{skipped, reason}` with the flag on |
| Image / chart | `images/extensions/dagster/{Dockerfile,repo.py,os_projects.py,repo-sync.sh}`; `values.yaml` user-code deployment renamed `example-user-code` → `sovereign`, tag `0.3.0` ×4, `DAGSTER_RELOAD_LOCATION=sovereign`, `REPO_SYNC_INDEX_URL`/`OS_INDEX_URL`, `OS_QUARANTINE_THRESHOLD`, runtime bearer from the `agent-runtime-token` Secret |
| Review fixes | M1 (test-SQL injection), M2 (authored body ⇒ source, with provenance), M3 (per-domain commit serialisation + synchronous capture), M4 (documented), L1 `ref` allowlist, L3 `OS-Actor`, L4 mirror credentials, L5 `status.json` only, L7 empty `accepted_values`, L8 batch comment; Admin Dagster version `v1.9.1` → `v1.13.11`; Files connector `launchPipelineExecution` → logged no-op + TODO |
| Tests | `core/infra/dagster.test.ts`, `tabs/data/lib/dbt/{launch,asset-keys}.test.ts`, `tabs/data/lib/{sync-status-server,dq-status-server}.test.ts`, `tabs/monitoring/lib/adapters/pipeline-health.test.ts`, 3 new cases in `dbt/commit.test.ts`, 6 new Python cases |
| Docs | `docs/components/{dagster,dbt}.md`, `tabs/data/README.md`, `tabs/monitoring/README.md`, `os-ui/ARCHITECTURE.md` ("Dagster schedules the repo"), `CHANGELOG.md` |

**Gates:** `tsc --noEmit` clean · `npm --prefix os-ui test` **5008 tests, 0 fail, 7 todo** (4985 → 5008) · `check-structure.mjs` **no new violations** (TAB-ISOLATION 421/422, CORE-INDEPENDENCE 206/207, FILE-HEADER 1248/1249 — all *below* baseline) · `gate.sh` exit 0 (86 pass) · `helm lint` exit 0 with the flag off **and** `--set osUI.dataProjectGit.enabled=true` · `py_compile repo.py os_projects.py` + `python3 -m unittest` **15 tests OK**.

### Phase B3 — Trino as the engine, lineage from dbt
- [x] dbt runs on Trino via `dbt-trino`; incremental models carry the OS's cursor/late-data semantics (`sync-sql.ts`) as model config, not bespoke SQL (B1). Row-level security and OPA stay at the query-tool / Trino boundary — **verified, nothing bypasses them**, and the who-runs-as-whom table is now written down (`docs/components/trino.md`). The Trino side of `impersonation_user` is real: a second, chained **file-based** access control whose `rules.json` the OS generates and reconciles. *(What it cannot do yet: Trino does not authenticate clients, so the impersonation section has no authenticated `original_user` — deviation B3-2.)*
- [x] Lineage and docs from `manifest.json`; the Data tab's lineage view reads it — through Dagster's `assetGraph` (the same `parent_map` edges, over a path the OS already authenticates to — deviation B3-5). Column-level lineage: **follow-up**, not derived (deviation B3-6).
- [x] **One asset per external source** (B2's open half of D7): `os/sources.yml` → one observable source asset per federated sync source, keyed as dagster-dbt keys the dbt source, with a freshness check from the sync's own cron.
- [~] Gate: parity test — the same composition yields the same rows via the old CTAS path and via `dbt run`; then delete the old path. *(The OFFLINE half is green and gate-able: `tabs/data/lib/dbt/parity.test.ts`, 3 fixtures + the worked example + a negative control. The ROW-SET half needs two materialisations and `EXCEPT ALL` both ways on a cluster — **untestable here**, checklist D15's `kind` half. **No deletion in B3**: the old path stays until the kind parity run passes, which is the honest reading of "then delete".)*

#### B3 — what landed (commit on `feat/engine-rebuild-b2`)

| Piece | Where |
|---|---|
| Trino rules generator (pure) | `core/infra/trino-rules.ts` — `buildTrinoRules`, `renderTrinoRules`, `rulesInputFromDirectory`, `OS_PRINCIPAL_PATTERN`, and a first-match-wins evaluator (`impersonationAllowed`, `schemaOwnerAllowed`, `tablePrivilegesFor`) the tests assert THROUGH; golden `core/infra/fixtures/trino-rules.golden.json` |
| Rules reconciler | `core/infra/trino-rules-server.ts` (`reconcileTrinoAccessRules`: PATCH only on change, every failure a typed outcome); wired fire-and-forget in `instrumentation.ts` behind `config.trinoAccessRules`; `config.{trinoAccessRules,trinoServiceUser}` |
| Chart | `templates/extensions/lakehouse/trino.yaml` — `access-control.config-files`, `access-control-{opa,file}.properties`, bootstrap ConfigMap `trino-access-rules` + **directory** mount; `values.yaml` `trino.accessControl`; `_os-ui-env.tpl` `TRINO_ACCESS_RULES`/`TRINO_DBT_USER`; os-ui Role's configmap RBAC also granted under `osUI.dataProjectGit` |
| Source assets | `tabs/data/lib/dbt/source-assets.ts` (`cronIntervalMinutes`, `freshnessMinutesFor`, `renderSourceAssets` → `os/sources.yml`), `models.ts` `SourceAssetEntry` + planner wiring, `generate.ts`; `os_projects.py` `SourceAsset`/`parse_source_assets`/`source_asset_key`/`observe_sql`/`freshness_seconds`; `repo.py` `_source_assets` + `_trino_rows` + `asset_checks` in `Definitions` |
| Lineage from the manifest | `tabs/data/lib/dbt/lineage.ts` (`graphLineage`, `assetNodesFromManifest`, `layerOfModel`), `tabs/data/lib/lineage-server.ts` (`datasetLineage`); `LineageGraph.source` (additive); consumed by `app/api/data/datasets/[id]/lineage/route.ts` and `core/lineage/unified.ts` (so MCP `get_lineage` too) |
| Parity harness | `tabs/data/lib/dbt/parity.ts` (`selectShape`, `compareSelects`, `resolveJinja`, `substitutionsFor`, `parityReport`) + `parity.test.ts` |
| B2 loose ends | `core/infra/dagster.ts` `sanitizeAll` + `scheduleNameFor(…, allDomains)`, shared golden `images/extensions/dagster/tests/sanitize-collisions.golden.json` (+ `regen_sanitize_golden.py`), `sync-status-server.ts` `domains` dep; `os_projects.pinned_one` + `repo.py` per-domain pinning; `repo-sync.sh` binds `POD_IP` and requires a bearer, `values.yaml` `POD_IP` downward API |
| Docs | **new** `docs/components/trino.md`; `docs/components/{dagster,dbt}.md`; `tabs/data/README.md` "B3"; `os-ui/ARCHITECTURE.md` "Data products execute as the principal"; `CHANGELOG.md` |
| Tests | `core/infra/trino-rules.test.ts` (10), `core/infra/trino-rules-server.test.ts` (4), `tabs/data/lib/dbt/source-assets.test.ts` (4), `tabs/data/lib/dbt/lineage.test.ts` (5), `tabs/data/lib/dbt/parity.test.ts` (6), 2 new cases in `core/infra/dagster.test.ts`, 9 new Python cases (`SourceAssets`, `PerSchedulePinning`, `SanitizeGolden`) |

**B3 review round (fourth commit on the branch):** all 6 H, all 8 M and all 3 L findings fixed with
tests, plus the "impersonation reality" item; the reconcile trigger set is **boot + directory event
(debounced, serialised) + jittered periodic repair**, with the last outcome published as a
`Trino access rules` row on Platform → Components & Health. Deviations: `#### B3 review round
deviations` below. New: `core/kernel/events.ts`, `scripts/check-trino-rules-chart.mjs`,
`core/kernel/events.test.ts`, `tabs/admin/lib/components-extra.test.ts`.

**Gates:** `tsc --noEmit` clean · `npm --prefix os-ui test` **5162 tests, 0 fail, 7 todo** (5008 → 5162) · `check-structure.mjs` **no new violations** (TAB-ISOLATION 421/422, CORE-INDEPENDENCE 206/207, FILE-HEADER 1244/1245 — all below baseline, NOT re-locked) · `gate.sh` exit 0 · `helm lint` exit 0 · `helm template` defaults **and** `--set osUI.dataProjectGit.enabled=true`, with the `trino-access-rules` ConfigMap's `rules.json` asserted to `JSON.parse` in both · `python3 -m unittest discover -s images/extensions/dagster/tests` **40 tests OK** (31 → 40) · `py_compile` on `repo.py`, `os_projects.py`, `tests/regen_sanitize_golden.py` · `sh -n repo-sync.sh`.

### Phase B4 — MCP, docs, deletion
- [x] MCP tools map 1:1 to engineer operations — **re-scoped by the owner's B4 brief** to "MCP = UI for every data mutation" (checklist X8) and the data half of the dispatcher contract (X7), which is what landed. The four engineer-NAMED tools (`dbt_run`, `dbt_test`, `dagster_materialize`, `get_dagster_run`) were deliberately NOT added — deviation B4-1. `get_lineage` already reads the dbt graph (B3).
- [x] Flip `DATA_PROJECT_GIT` on by default, guarded by the data parity harness in `gate.sh`, with a boot-time reconcile commit so the repository catches up with the registry (the B2-review follow-up).
- [x] Delete the ledger execution paths the flag-on world no longer uses: the CronJob provisioning, both sweep routes and their chart CronJobs. *(`/execute` and the TS CTAS build path stay — deviations B4-6 and B4-7.)*
- [x] Monitoring reads Dagster for pipeline health, the DQ rollup and freshness, with the `source` label visible in the UI. *(B2/B3 did the work; B4 verified there is no ledger import left in `tabs/monitoring` and corrected the last stale claim.)*
- [x] Docs: `docs/components/{dagster,dbt,trino}.md` describe the real flow; `tabs/data/README.md` lists the MCP tools; `os-ui/ARCHITECTURE.md` explains "a data product is a dbt project"; `tabs/monitoring/README.md`, `tabs/data/guide.md`, `CHANGELOG.md`.

#### B4 — what landed (three commits on `feat/engine-rebuild-b2`)

| Piece | Where |
|---|---|
| One service per data mutation | `tabs/data/lib/mutations-server.ts` — `createDatasetService`, `commitVersionService`, `transformSilverService`, `buildGoldJoinService`, `rematerializeDomainTableService`, `defineQualityRulesService`, `runQualityChecksService`, `saveDatasetSyncService`, `syncDatasetNowService`; `DataMutationError {status, field}`; `__setMutationDepsForTests` (the one seam for platform/reconcile/queryFn) |
| Both doors on it | routes `app/api/data/datasets/{route,[id]/version,[id]/transform,[id]/gold-join,[id]/checks,[id]/sync}` (HTTP shaping only) and `core/mcp/experimental/data-write-tools.ts` (argument coercion only) |
| X8 parity harness | `tabs/data/lib/mcp-parity.test.ts` — 8 tools × (MCP handler vs the route's service) over the real commit path with an injected committer + a fake Dagster client; commit tree/author/`OS-Actor` and launch args deep-equal; surface asserted as the ONE difference; 404/403/400 parity cases. `launch.ts` gained `__setLaunchDepsForTests` + `awaitDataProjectLaunches` so a fire-and-forget launch is observable from both doors |
| X7 conformance (data half) | `tabs/data/lib/mcp-conformance.test.ts` — every `tab === 'data'` tool (+ `extraTabs`) dispatches, has a described schema, refuses a foreign dataset as `not_found`/`forbidden` with a hint and no stack, names the role a gate needs, and writes nothing |
| Boot reconcile | `tabs/data/lib/dbt/boot-reconcile.ts` (`reconcileDataProjectsAtBoot`, `PLATFORM_ACTOR`, `OS-Reason: boot-reconcile`), wired in `instrumentation.ts`; `commit.ts` `CommitMeta.extraTrailers`; `boot-reconcile.test.ts` (6) |
| Flag flip | `charts/.../values.yaml` `osUI.dataProjectGit.enabled: true` **and** the repo-sync sidecar's own `REPO_SYNC_ENABLED: "true"` (the copy the script actually reads); `values.local.yaml` states it explicitly |
| Deletion | `git rm`: `tabs/data/lib/sync-cron.ts` + test, `app/api/data/sync-due/route.ts`, `app/api/data/dq/run-all/route.ts`, `templates/extensions/metrics/{data-sync,dq}-cronjob.yaml`; values `dataSync.sweep` + `data.quality.cron`; `store.datasetsWithSync`. **New:** `tabs/data/lib/sync-cron-removal.ts` (delete-only) + test (6) |
| Guide + docs | `tabs/data/guide.md` ("What actually happens when you call these tools" + the real sequence + lineage step), `tabs/data/README.md` (the shipped architecture diagram, the MCP tool list, B4 section), `tabs/monitoring/README.md`, `docs/components/{dagster,dbt,trino}.md`, `os-ui/ARCHITECTURE.md`, `CHANGELOG.md` (breaking change + migration note) |

**Gates:** `tsc --noEmit` clean · `npm --prefix os-ui test` **5202 tests, 0 fail, 7 todo** (5162 → 5202) · `check-structure.mjs` **all three counts BELOW baseline** (TAB-ISOLATION 420/422, CORE-INDEPENDENCE **200/207** — the MCP now reaches the Data tab through one module — FILE-HEADER 1242/1245; NOT re-locked) · `gate.sh` exit 0 (226 tests, the two new data-MCP tests in it) · `helm lint` + `helm template` on the defaults, `osUI.dataProjectGit.enabled=false`, `trino.accessControl.enabled=false` and `values.local.yaml` — **0 `batch/v1` CronJob** in every render · `check-trino-rules-chart.mjs` ok · `python3 -m unittest discover -s images/extensions/dagster/tests` **45 tests OK** · `py_compile` on `repo.py` + `os_projects.py`.

---

## Part C — Deploy and verify

**Written out as an executable list at the end of Part F (iteration 1), from the shipped code.** No
cluster was available in this worktree, so every step below is `untestable here` until it is run —
that is the point of writing it down exactly. Run the whole list in order; a step that disagrees
with its expected output is a finding to fix in the code, not in the cluster.

### C.0 — Version

`charts/sovereign-agentic-os/Chart.yaml` is `version: 0.2.12`, `appVersion: "0.2.0-alpha.11"`;
`os-ui/package.json` is `0.2.0-alpha.11`. The programme is a **breaking change** — data scheduling
moves from Kubernetes CronJobs to Dagster schedules (the CronJob templates are DELETED, so the
upgrade removes objects), the agent engine moves from the walker to a compiled LangGraph
`StateGraph`, and `DATA_PROJECT_GIT` now defaults ON in both the chart and `config.ts`.

- **Proposed app version: `0.2.0-alpha.12`** (the alpha train is where this repo has carried
  breaking platform changes — alpha.8 → .9 → .10 → .11 each did).
- **Proposed chart version: `0.3.0` — a MINOR bump, not a patch.** The rendered object set changes
  incompatibly: the data-sync CronJob templates are gone, `os-ui-worker`, the `git-daemon` sidecar,
  the `os-repos` PVC and its NetworkPolicy are new, and values keys were added
  (`osUI.dataProjectGit`, `osUI.worker`, `queryTool.budget`) and removed.
- **CHANGELOG stays `[Unreleased]`.** This repo stamps the version in its own `release: sync
  v<version> — <title>` commit (`3c72f885`, `4abec9ce`), never on the feature branch: every Part D
  and B4 commit edited `CHANGELOG.md` and left the heading alone. **The deploy stamps nothing in
  git** — `scripts/deploy.sh <version>` only tags and pins the image
  (`--set osUI.image.tag="<version>@<digest>"`); it does not touch `Chart.yaml` or `CHANGELOG.md`.
  So the release commit that merges this branch is what converts `[Unreleased]` → `[0.2.0-alpha.12]
  — 2026-11-13` and bumps the chart to `0.3.0`.

### C.1 — Build and roll out

```bash
colima start                                   # the build runs in a 14 GB VM
cd ~/Documents/Claude/Projects/'Data Masterclass Apps'/sovereign-os-stack
./scripts/deploy.sh 0.2.0-alpha.12             # DIRECTLY — never `| tail`: a pipe masks a failed
                                               # upgrade as success (2026-11-04)
colima stop                                    # frees 14 GB before anything else needs kubectl
```

`deploy.sh` already does, in this order and aborting on any failure: derive the values from the
LIVE release (never the chart defaults), diff the rendered manifest and **refuse** if the upgrade
would delete a PVC or StatefulSet, take the pre-upgrade Velero backup, build `linux/amd64`, run the
**post-build strip-types smoke** (`docker run --entrypoint node … --experimental-strip-types -e
"import('./worker/agent-runs.ts')…"` — this is the only check that the image's Node can run the
worker's TypeScript source; a base image below 22.6 fails here instead of at boot), push, pin the
digest, `helm upgrade --skip-schema-validation`, and wait for the rollout. Expect the final line
`DEPLOY_0.2.0-alpha.12_OK`.

### C.2 — Post-deploy verification, in this order

```bash
NS=agentic-os; CTX=dmagenticos; kubectl config use-context $CTX
```

**1. Health.**
```bash
kubectl -n $NS get pods | grep -vE 'Running|Completed'          # expect: no rows
kubectl -n $NS rollout status deploy/os-ui --timeout=5m         # expect: successfully rolled out
curl -fsS https://<OS_PUBLIC_URL>/api/health                    # expect: 200, {"ok":true,…}
```

**2. The worker is up and durable** (A14/A18 depend on it).
```bash
helm upgrade agentic-os charts/sovereign-agentic-os -n $NS --reuse-values --set osUI.worker.enabled=true
kubectl -n $NS rollout status deploy/os-ui-worker
kubectl -n $NS logs deploy/os-ui-worker | grep 'agent-runs-worker. boot:'
# expect EXACTLY: checkpointer=postgres jobs=postgres resumeHook=true approvals=true
# ERR_UNKNOWN_FILE_EXTENSION here ⇒ the image's Node is below 22.6 (the C.1 smoke should have caught it)
```

**3. One agent run: hold → approve → resume → one trace** (A13, A15, A16, A19).
Start a run from the Agents tab on a system whose safety preset holds a write (or over MCP:
`run_agent_system`), approve it in Governance → Inbox, note `RUN=<runId>`.
```bash
kubectl -n $NS exec deploy/postgres -- psql -d agent_runs -c \
  "select status, kind, attempts, locked_by from run_jobs where run_id='$RUN'"
# expect: status done (it passed through parked → queued/kind=resume → running → done)
kubectl -n $NS exec deploy/postgres -- psql -d agent_runs -c \
  "select seq, event, at from run_events where run_id='$RUN' order by seq"
# expect: a contiguous seq with no gap, a `held` event before the decision and a terminal `done`
kubectl -n $NS exec deploy/postgres -- psql -d agent_runs -c \
  "select count(*) from checkpoints where thread_id='$RUN'"
# expect: > 1 — thread id IS the run id (A13)
curl -fsS -H "Authorization: Bearer $LANGFUSE_PUBLIC_KEY" \
  "https://<langfuse>/api/public/traces/$RUN"
# expect: ONE trace whose id is the run id, userId = the runner, sessionId = the systemId,
# tags domain:/agent:/run:, node spans beneath it and model calls as generations (A19, A21, A24).
# The run's "Trace" link in Monitoring must open THIS trace, not a /traces list (A20).
```
Then assert the artifact the approved write produced is authored as the **runner**, not the
approver (A16) — open it in its tab and read its author.

**4. The run's work is a commit, authored as the acting user** (A2, A33, X1).
```bash
kubectl -n $NS exec deploy/os-ui -- sh -lc 'git --git-dir=/repos/<domain>.git log --oneline -5'
kubectl -n $NS exec deploy/os-ui -- sh -lc \
  'git --git-dir=/repos/<domain>.git ls-tree -r --name-only main | grep ^agents/'
# expect: agents/<slug>/{system.yaml,agents/<id>.md,graph.json,README.md} and agents/index.yml,
# the commit authored as the acting user with OS-Action/OS-Object/OS-Surface (+ OS-Run-Id) trailers.
# Save the same system once from the UI and once over MCP: two commits, differing ONLY in
# `via ui:<route>` vs `via mcp:<tool>` (A33).
```

**5. A scheduled sync materialises in Dagster, as the owner** (D7, D8, D9, D11).
```bash
kubectl -n $NS port-forward svc/agentic-os-dagster-webserver 3070:80 &
# Automation tab: the domain's schedule is listed, UTC, and its next tick is in the future.
# Trigger it (or wait), then in the OS the Data tab must show the SAME run — it is read from
# Dagster, not from an OS ledger (D9).
kubectl -n $NS get job -l dagster/job -o name | head -1 | xargs kubectl -n $NS get \
  -o jsonpath='{.spec.template.spec.containers[0].env[*].name}'
# expect BOTH OS_PRINCIPAL and TRINO_HOST — the run tag MERGED with the location's container
# context rather than replacing it (dagster.md "Verify it in a cluster" step 2)
kubectl -n $NS get pods -l component=user-deployments -o custom-columns=NAME:.metadata.name
# expect the code-server pod AND any live dagster-run-* pod — without that label a run pod cannot
# reach the git daemon on 9418 and every scheduled sync dies at ensure_checkout
kubectl -n $NS logs job/<a dagster-run job> -c repo-sync | tail -2
# expect "in a Dagster run pod … exiting 0" — a Job only completes once every container exits
kubectl -n $NS exec deploy/agentic-os-dagster-user-deployments-sovereign -c repo-sync -- \
  python -c "import psycopg2, dagster_dbt, trino; print('drivers ok')"
# D10 — the image has its Postgres driver. Then launch `<domain>__all` and assert SUCCESS.
```

**6. One composition through dbt, on Trino** (D1, D12, D13, D16).
Build a gold composition from the Data tab, then:
```bash
kubectl -n $NS exec deploy/agentic-os-dagster-user-deployments-sovereign -c repo-sync -- \
  python /opt/dagster/app/os_projects.py --parse /repos-checkout/<domain>/current
# expect: dbt parse + compile succeed (D1)
# then in Trino: the iceberg.<schema>.<table> exists and DESCRIBE matches the OS's column list,
# and the Data tab's lineage comes from the manifest/assetGraph, not the OS registry (D16 —
# the fallback is labelled source: 'registry', so a 'registry' label here is a FAILURE).
```

**7. The old world is gone.**
```bash
kubectl -n $NS get cronjobs                      # expect: NO per-dataset data-sync CronJob
kubectl -n $NS get cronjob -o name | grep -i sync   # expect: no output
kubectl -n $NS delete secret dq-run-principal    # the chart no longer renders it; remove by hand
```

**8. Governance plumbing: the three health rows and the key allowlist** (X2, A28, D14).
```bash
kubectl -n $NS logs job/litellm-agent-key-init | tail -20
# expect the FULL alias list on the key: sovereign-default, sovereign-mock, sovereign-reasoning,
# sovereign-embed, sovereign-premium, sovereign-reasoning-fast (+ sovereign-vision) — A28
kubectl -n $NS logs deploy/os-ui | grep 'trino access rules'
kubectl -n $NS get cm trino-access-rules -o jsonpath='{.data.rules\.json}' | python3 -m json.tool | head
# Platform → Components & Health must show, all GREEN:
#   `trino-access-rules`   (RED until the first successful reconcile — that is deliberate)
#   `git-mirror`           (after configuring a remote via PUT /api/platform-admin/data-projects/<domain>/mirror,
#                           then: git --git-dir=/repos/<domain>.git log --oneline -1 on the REMOTE)
#   `data-products-git`    (present in both states; amber "scheduling disabled" when the flag is off)
```

**9. Rollback.** `helm rollback agentic-os <previous>` is the recovery path. Nothing in this
programme is irreversible except the `agent_runs` database creation, which is additive — but note
the upgrade DELETES the data-sync CronJobs, so a rollback re-creates them while `os/schedules.yml`
is already committed: stand the CronJobs down again (`reconcileDataProjectsAtBoot` does it at the
next os-ui boot) or both schedulers own the same slice.

- [ ] C.1 executed
- [ ] C.2 steps 1–9 executed and each expected output seen

---

## Part D — Git-based working, automatically, behind every step (cross-cutting)

**Requirement (2026-11-13, product owner):** everything built in the OS, from the UI or the MCP, follows a git-based way of working exactly as engineers work, automatically. No separate "export to git" step.

- [x] One commit path. `core/infra/git-store.ts` (isomorphic-git, MIT): `openOrInit(repo)`, `commitTree(repo, files, {author, message, trailers})` committing **iff the tree hash changed**, `log`, `readBlob`, `archive`, `push(mirror)`. Author = acting `CurrentUser` (name + email); committer = `Sovereign OS`. Message `<area>(<domain>): <action> <object> — via <mcp:tool | ui:<route>>`, trailers `OS-Action`, `OS-Object`, `OS-Surface`, `OS-Request-Id`. *(B1; `listTree` added; `CurrentUser` has no e-mail field — resolved through the user directory at boot, synthesized + declared otherwise, deviation B1-4.)*
- [x] Repos: one bare repo per domain on PVC `os-repos` (RWO; os-ui is single-replica). Layout: `agents/<system>/{system.yaml,graph.ts,README.md}`, `dbt_project.yml`, `models/…`, `os/schedules.yml`. Served read-only in-cluster by a `git daemon` sidecar; NetworkPolicy limits consumers to the Dagster user-code pod. *(B1 ships the data half of the layout; `agents/<system>/…` is A2/A5's write into the same repo through the same store. The NetworkPolicy also keeps port 3000 open — os-ui had no ingress policy before, deviation B1-6. Chart objects render only with `osUI.dataProjectGit.enabled`.)*
- [x] **Every writer commits.** Agent store saves (`tabs/agents/lib/store.ts`), data store mutations (dataset, composition, check, sync, publish), and their MCP tools all route through the one commit path. A unit test enumerates the store's mutating exports and asserts each calls the commit builder (checklist X1). *(Data side in B1 — `commit.test.ts` enumerates 31 mutators, flag on/off. Agents side NOW DONE: `writeThrough(rec, change)` takes a REQUIRED change descriptor or an explicit `null`, so the compiler forces the decision; `tabs/agents/lib/git/commit.test.ts` pins 17 committing writers × flag on/off plus 7 deliberately-not-committing run writers.)*
- [x] Read access: `GET /api/<tab>/projects/<domain>` tree/log/blob at a ref; export as an archive at a commit; admin-only mirror config (URL + token Secret) with push-after-commit that reports but never blocks. *(Data tab routes in B1; the push itself is `kind`-only — checklist X2 untestable here.)*
- [x] Gates: checklist A2, A3, D2, D3, X1, X2. *(A2 `true`, A3 `true`, D2/D3 `true` from B1, X1 `true`, X2 `true (unit)` with the real-remote half `untestable here`. A4 and A33 stay `false`/partial — see the checklist rows and deviation D-8.)*
- [x] **X9 — agents use the data as context robustly** (added at the owner's request): bounded tool results, a per-call deadline, typed `timeout`/`upstream_error` steps, the runner's identity on the dispatch and the dataset in the run trace.

#### Part D — what landed (agents half; five commits on `feat/engine-rebuild`)

| Piece | Where |
|---|---|
| Subtree ownership in the ONE git store | `core/infra/git-store.ts` — `commitSubtree(domain, prefix, files, opts)` (replaces one prefix, keeps the rest; empty map = delete), `reserveSubtree`/`reservedSubtrees` (a whole-tree writer keeps a declared prefix), tree builder generalised to keep existing blobs by oid; `core/infra/git-store-subtree.test.ts` (6) |
| Generator (pure, byte-stable) | `tabs/agents/lib/git/{snapshot,generate}.ts` — `agents/index.yml`, `agents/<slug>/{system.yaml,agents/<id>.md,graph.json,README.md}`, `agents/personal/<uid>/<slug>/…`; goldens `lib/git/fixtures/*.golden.json` (3 shapes incl. slug collisions + an unparseable source); `generate.test.ts` (12) |
| One commit path + the event seam | `tabs/agents/lib/system-events.ts` (pure), `store.ts` `writeThrough(rec, change \| null)` + `systemsForProject` / `projectDomains`, `tabs/agents/lib/git/commit.ts` (`commitAgentSystem`, `installAgentProjectCommitHook`, per-domain serialisation, synchronous capture, two-repo cross-domain move), `instrumentation.ts`; `commit.test.ts` (49) |
| Surface everywhere | `core/mcp/server.ts` wraps EVERY `tools/call` in `mcp:<tool>` (one place, so no tool can be forgotten — the data half benefits too); `app/api/agents/systems/[id]/build/route.ts` sets its own `ui:…` scope |
| Boot reconcile | `tabs/agents/lib/git/reconcile.ts` (`reconcileAgentProjects`, `PLATFORM_ACTOR`, `OS-Reason: boot-reconcile`, domains = live systems ∪ repos already carrying `agents/`), wired in `instrumentation.ts` |
| Read-back from the repo | `tabs/agents/lib/git/history.ts` (`systemGitInfo`, filtered on `OS-Object`), `get_agent_system`, `GET /api/agents/systems/<id>`, `SystemView.tsx` header line; `repo.test.ts` (7, against a REAL bare repo) |
| Mirror push (X2) | `core/infra/git-mirror.ts` over B1's ONE record (same map symbol, same index, no second setter/credential path), `push` gains an injectable `http` transport, `gitMirrorRow` in `tabs/admin/lib/components-extra.ts` + the components route; `core/infra/git-mirror.test.ts` (8), `tabs/admin/lib/components-git-mirror.test.ts` (1) |
| X9 | `tabs/agents/lib/engine/tool-result.ts` (`boundToolResult`, `callToolGuarded`, typed codes), `build-graph.ts` tools node, `os-tools.ts` typed `upstream_error`, `config.agentTool{ResultMaxChars,CallTimeoutMs}`, chart `soa.osUI.runEnv` (so the worker gets them), harness shape `agent-reads-gold-dataset`; `engine/data-context.test.ts` (9) |
| Docs | `tabs/agents/README.md` ("Every change is a commit", "Agents use the data as context, robustly"), `os-ui/ARCHITECTURE.md` ("Git-based working: one repo per domain, two generators, one commit path"), `docs/components/os-ui.md`, `CHANGELOG.md` |

**Gates at Part D:** `tsc --noEmit` clean · `npm --prefix os-ui test` **5246 tests, 0 failures, 4 todo** (5162 → 5246) · `check-structure` no new violations (TAB-ISOLATION 420/421, CORE-INDEPENDENCE 206/207, FILE-HEADER 1237/1240 — all below baseline, NOT re-locked) · `bash os-ui/scripts/gate.sh` exit 0 (**356 tests**, 8 files added) · `helm lint` + `helm template` with defaults and with `osUI.worker.enabled=true`, the two new env vars rendered for BOTH os-ui and the worker and absent when unset.

## Part E — The final document

**Requirement (2026-11-13, product owner):** a PDF explaining, step by step, how each tool is really used after the refactor and where that manifests in the OS source; which tool functions are implemented at which step; and how it follows the same approach a data or AI engineer would follow — the OS as an abstraction layer, not a reinvention of "how".

- [ ] Written **last, from the shipped code**, by a read-only agent, one chapter per tool (LangGraph, Langfuse, LiteLLM, git, dbt, Dagster, Trino): the engineer's workflow step by step → the OS source performing that step (`file:line`) → the tool functions used and deliberately not used → what the OS adds on top (identity, policy, approvals). A closing chapter lists every reinvention that remains, with the reason.
- [ ] Rendered with headless Chrome like the audit PDF; stored next to it in `~/Documents/Claude/Projects/Data Masterclass Apps/stackit/`. Checklist X6.

## Part F — Iterate against the checklist

After each full pass over Parts A, B and D: a read-only test agent scores `2026-11-13-engineering-checklist.md`, writes a gap report there, and a new "Iteration N" is appended below with phases closing the gaps. Repeat until two consecutive iterations close nothing further. Deploy after each green iteration; the engine flag flips only when A5–A17 pass.

- [x] **Iteration 1 — 2026-11-13.** All 60 items re-scored independently against the tree at
  `6d6c1391`, every cited test read rather than trusted, the full gate suite run at the start and
  the end. Gap report in `2026-11-13-engineering-checklist.md` → "Gap reports" →
  "2026-11-13 — end of Part F (iteration 1)". Closed in this pass: **X7** (the conformance contract
  generalised from the 23 data tools to all 113 in the registry), **A4** (`false` → `partly true` —
  the committed `system.yaml` now runs from a plain checkout), **X4** (the ratchet baseline
  re-locked downward so it bites). Three defects were found by the new tests and fixed:
  `suggest_metrics`' raw `fetch failed`, six software tool descriptions too terse to act on, and a
  dead rule-violating test under `app/`. Two gaps were found that no gate covered: the Python
  suites ran nowhere (now in CI) and the query-tool tests cross-contaminate under one discovery
  pass (open). Part E (X6) remains the only wholly unstarted item.
- [ ] Iteration 2 — scoped in the gap report's recommendation.

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
- **A2-1 `grantedToolExecutor` gained an option, `opts.holdAt: 'executor' | 'node'`.** The brief said the executor stays unchanged, but an approved escalation sent back through it would be re-held by gate 1b and re-enqueued. Gates 1 and 2 (grant scope, `handleRpc(user)`) are untouched; `node` only steps gate 1b aside because the tools node already applied the same `holdDecisionFor` rule. The walker keeps `executor`.
- **A2-2 The resume payload is keyed by `approvalId` but is a *scalar* resume for LangGraph.** LangGraph's keyed resume map needs its own interrupt ids (XXH3 hashes), which are not known when the approval is filed. So `interruptKey` is OUR idempotency key (`<threadId>:<callId>`), the payload `{ [approvalId]: decision }` is a plain resume value, and the node treats the **queue as the source of truth**: it re-reads each approval on every re-run, uses the payload only as a shortcut, and parks again (second `interrupt()`) when the payload was for another approval. Tested (P3 e: deciding the second of two held calls first).
- **A2-3 One executed call per superstep in `tools_<id>`** (review M5), not the whole batch in one node run: a `tools → tools | act` conditional edge, so each execution is checkpointed before the next and a crash re-executes at most the call in flight. `node-started`/`tool-step` event order is unchanged.
- **A2-4 The owner stamp is graph state (`state.owner`), not checkpoint metadata** (the reviewer's suggestion). Same gate, but typed in the state annotation and readable straight from the checkpointer tuple (`peekRunOwner`) so the MCP tools can map a bare `runId` to its system before `getSystemForRun` re-authorises. Threads older than A2 carry no owner and are therefore not resumable through the owner gate (an honest 404, not a guessable continuation).
- **A2-5 `node-started.total` = max(agents, visit)**, not the step budget (review L2 suggested the budget): "agent 3 of 40" would mislead; the invariant that matters — `index ≤ total` — holds.
- **A2-6 `principalById` added to `core/kernel/auth.ts`.** The live role re-read needs the user directory; `auth.ts` already imports `@tabs/admin/lib/users` (a baselined CORE-INDEPENDENCE item), so reusing that import adds no new violation. `resume.ts` receives it injected (tests run with fakes).
- **A2-7 `applyEffect` short-circuits a run approval** with an `ok`, `live:false` "authorised; the runner executes on resume" result, so both decide doors keep their existing effect/decide ordering (the inbox route decides then applies; `decide_approval` applies then decides) and neither performs a side effect as the approver.
- **A2-8 `decide()` stays synchronous.** The hook runs fire-and-forget; `decisionSettled(id)` lets a caller await it. Both decide doors await it so the response (and the card) carries the `resume` outcome at once; a handler failure is stamped `resume.status='failed'`, never thrown into the decision.
- **A2-9 `LastRun.held` = typed-held steps + pending approvals**; the body gains `parked` and `heldApprovals`; `LastRun` gains `heldApprovals` and `warnings`.
- **A2-10 Resume is offered only when `checkpointer === 'postgres'`** (review M3); an interrupted memory-checkpointed run says its checkpoints died with the process. `RunCheckpoint.checkpointer` records the kind at run start from config.
- **A2-11 A task re-parked after a resume is absent from LangGraph's `next`** (it already carries its `__resume__` write) but present in `tasks` with its interrupts. `runGraphEngine` therefore treats "pending interrupts" as resumable/interrupted, not finished — otherwise P3(e) would have reported a 409.
- **A2-12 Run ids moved to `core/kernel/run-id.ts`** (`crypto.randomUUID`); the store re-exports `newRunId` so A1 callers are unchanged; `agent-write-tools.ts` imports it from core (review H1/L5).
- **A2-13 The re-attach stream is an in-process topic** (`engine/run-events.ts`, `GET …/run/stream?runId=`), single replica like the checkpointer; A4's worker moves it to `run_events`. The resume after a decision runs inside the decider's request (`maxDuration` of the governance route applies) — also A4's.
- **A2-14 Retention (review L4):** LangGraph checkpoints keep raw tool results indefinitely in `agent_runs`; no retention exists. **A13 follow-up:** add a retention job (drop threads older than N days once finished) and a bound on stored tool results.
- **A3-1 Langfuse integration = the `langfuse` JS SDK directly, no callback handler.** `langfuse-langchain` is peer-incompatible with `@langchain/core` 1.x (A0-1) and our model calls are OpenAI-shaped LiteLLM requests, not LangChain runnables, so a handler would see nothing. `@langfuse/langchain@6` was not added either: explicit spans give exact control of ids (trace id = run id) and of what is recorded. The SDK client is injected into the observer, so the recorded-ingestion tests run the REAL SDK with a recording `fetch`.
- **A3-2 The run's outcome is a terminal `run.result` span, not a trace update.** In the SDK a trace update is a second `trace-create` event; the gate asserts exactly one per run, so the trace carries identity + input and the result span carries the outcome. A resume emits no trace event at all.
- **A3-3 Redaction default.** Model-call content is recorded as roles + character counts; the tool-call structure (names, ids, args) and a 160-char result preview are kept. LiteLLM's own callback generation (nested under ours) carries the full content and cost — that is the gateway's record, configured in the chart. Tool args can carry PII: a checklist concern ("PII handling"), paired with L-D below.
- **A3-4 Identity in Langfuse.** Trace `userId` = the OS user id of the runner (also forwarded to LiteLLM as `trace_user_id`); LiteLLM's `user` (its `end_user` spend ledger) stays `os-<id>`. `sessionId` = the system id.
- **A3-5 Two generations per model call, nested, not deduplicated (A24).** The OS generation (redacted, usage) is the parent of LiteLLM's callback generation (`existing_trace_id` + `parent_observation_id`). Only the gateway's carries cost; the OS's carries the node attribution (`metadata.node`) the diagnostics table rolls up.
- **A3-6 Governance spans hang directly under the run trace, not under the node's tool span.** `trace()` receives only the trace id through the executor's `traceContext` (the executor does not know the node span id). Under a run `TraceRecord.landed` means "queued to the SDK buffer"; standalone traces keep the synchronous ingestion POST and its real `landed`.
- **A3-7 Diagnostics read.** `?runId=` → `traceId` filter; without a run id (walker runs) → `userId` + `fromTimestamp` (a ≤6 h window). `observationsQuery` throws `UnfilteredLangfuseQueryError` on anything looser; the panel passes the run id.
- **A3-8 Per-agent key by reference, minted only by a LIVE build.** `live.ts`/`live-clients.ts` derive the key value `sk-os-<systemId>` (pre-existing, deterministic from a public id — a weakness A5 should revisit when the Python runtime goes and Build is re-based). The build route writes the value to the secrets store once and persists `LastBuild.litellmKeyRef`; `callerCredential(ctx.keyRef)` resolves it, else the shared agent key, never the master key. On kind (no live runtime) every run uses the shared key, as before.
- **A3-9 Cache scope.** LiteLLM caches per call type globally, so instead of enabling completion caching for everyone the chart runs `cache_params.mode: default_off` and only classify (temperature 0) and the two embedders send `cache: {"use-cache": true}`. Agent runs are never cached.
- **A3-10 MODEL-KEY repo-wide moved seven admin surfaces onto the IO layer** (`/api/gateway`, platform-admin `mcp-apis`, `providers`, `models/assistant`, `models/[id]` with `tabs/admin/lib/model-remove.ts` now over an injected `GatewayIo`, Monitoring `cost.ts`). Allowlist: `litellm-admin.ts`, `litellm-write.ts`, `tool-sso-litellm.ts` (reserved; it does not read the key today), `live-clients.ts`, `config.ts`.
- **A3-11 Embedders take an optional caller context, defaulting to the platform principal.** `indexWorkflow`/`indexDomain`/`indexAsset`/`retrieveKnowledge`/`filesRetrieve` do not thread the acting user yet, so embedding spend is attributed to `tab:knowledge`/`tab:files` + `domain:platform` with `user os-system`. **Follow-up:** thread the principal from those call sites (A27 "from embeddings" is per-surface today, not per-user).
- **A3-12 A gateway rejection during handoff curation degrades, it does not fail the node.** `liveEmbedder`/`guardedEmbedder` treat `GatewayRejectedError` as the offline source (keepRows handoff); curation indexes nothing, so A31 is not at stake there.
- **A3-13 What proved wrong (A28).** The STACKIT overlay's router fallbacks target `sovereign-premium` and `sovereign-reasoning-fast`, which the base four-alias key allowlist never contained — every fallback would have 403'd. The new chart test caught it on first run; the overlay now carries its own `litellmAgentKey.models` (plus `sovereign-vision`).
- **A3-14 The judge score is written only for the persisted last run with a run id** (a walker run has no trace). `evaluate` accepts an optional `runId` and refuses to score a trace other than the last run's.
- **A3-15 `assistantComplete` passes the first of the caller's domains**; callers that pass a bare user id string still land in `domain:platform`.
- **A3-16 `traceStoreAvailable` under `langgraph` = "an observer recorded this run" (Langfuse configured)**, not a live probe of the trace store — a run never waits on Langfuse. The walker path keeps its reachability probe.
- **A3-17 `gate.sh` runs the chart allowlist script and the A3 tests** (`attribution`, `observe`, `langfuse`).
- **A3-review-M-A** `approvals-bridge.ts` (`enqueueOnce`, `status`) and MCP `decide_approval` `await ensureHydrated()` before reading the queue; test: hydrate-after-restart finds the same approval (`__simulateRestart` test seam, mirror stubbed).
- **A3-review-M-B** `engine/run-lock.ts` — a `globalThis`-pinned per-run lock taken in `executeTeamRun` before any marker/event, released in `finally`; a second entrant is a typed `RunInFlightError` (409). Tests: two concurrent resumes execute the write once; a source tripwire on `executeTeamRun`. Single replica; A4 replaces it with the `run_jobs` row lock.
- **A3-review-L-A** headers on `run/route.ts` (SPDX + FEATURE block) and `run/stream/route.ts`. **L-C** `fireDecided` with no handler stamps `resume.status='failed'`, `code='resume_hook_unregistered'`. **L-F** `ApprovalResume.status` gains `parked`; `resume.ts` stamps it when the run re-parks. **L-G** `canApprove` refuses `requestedBy === actor.id` (tested; `decide_approval` names the reason).
- **Follow-ups recorded, not implemented (A2 review lows):** **L-B** the parity harness's `hold.decide` omits `resolveAlias` (`parity-harness.ts` `graphDeps`) — align with production. **L-D** held `args` (≤4000 chars) can carry PII into the `os-approvals` index with no retention — add to the A13 retention item together with trace args (A3-3). **L-E** the resume's domain check (`runner_domain_lost`) is stricter than the start path's `canRunCheck`; consider `getSystemForRun` as the single authority. **L-H** `enqueueOnce` is an O(n) scan and the `settled` map is unbounded — index by `interruptKey`, evict settled entries.
- **A0-9 agent-templates fixtures are compositions.** `agent-templates.ts` ships per-agent fragments, not whole systems; each is wrapped as a single-agent system (role, instructions, suggested tools) to get a runnable fixture.
- **A4-resume: inherited 3 partial files from the terminated predecessor; all three KEPT, two finished.** `git status` showed `os-ui/core/kernel/agents-worker.ts` (new), `os-ui/tabs/agents/lib/engine/jobs.ts` (new) and a modified `os-ui/core/kernel/config.ts`. Read in full before anything else: `agents-worker.ts` (the `inline|worker` union + parser) was complete and correct and is used as written; `config.ts` carried `agentsWorker`, `agentsWorkerLeaseMs` and `langfuseRedaction` — all three correct and all three used (the last one is review item M-2, so it was already half-done); `jobs.ts` carried the port, the in-memory implementation and `tailRunEvents` exactly as the predecessor's last words said, and it is the file the whole phase rests on — kept verbatim and FINISHED with `RunJobNotFoundError` (a resume of a run that never existed was reporting 409 "already running", a lie) and `runEventSink`. Nothing was discarded. No partial worker entrypoint, route change or chart work existed.
- **A4-1 The tail is a POLL, not `LISTEN/NOTIFY`.** 400 ms over `(run_id, seq)` — a primary-key range scan on an append-only table. Reasons, in order: it is correct across pods and after any reconnect with no extra state; `LISTEN` needs a dedicated connection per watcher (a parked run with three open panels is three connections held for as long as a human takes to decide), and `pg`'s notification delivery is per-connection, so a pooled client cannot be the listener; a missed notification still needs a poll as the backstop, so NOTIFY would be an optimisation on top of this loop, not a replacement for it; and a few hundred milliseconds is invisible next to a model call. Revisit if a tenant ever runs enough concurrent runs that the poll shows up in `pg_stat_statements`.
- **A4-2 `run_events` is `event text` + `data jsonb`, not one `event jsonb` blob** (the brief said `event jsonb`). Two columns let the terminal check be a cheap predicate, let the vocabulary be enforced on write (`isRunEventName` before the INSERT — the table IS the SSE contract), and keep the tail's filter indexable. The SSE frame is reassembled as `event: <event>\ndata: <data>`, unchanged on the wire.
- **A4-3 The worker runs the TypeScript SOURCE, because `output: 'standalone'` has no entry for it.** The brief said "Node type-stripping runs `.ts` — check how `instrumentation.ts`/scripts do it". It turns out `instrumentation.ts` is no precedent at all: Next compiles it with webpack. What proved wrong is the assumption that a `.ts` entrypoint just works in the image — the standalone output ships a traced server and a pruned `node_modules`, no sources. Verified empirically instead: with a `register()`ed resolve hook (tsconfig `@core/*`/`@tabs/*` aliases, a `server-only` stub, extensionless relative `.ts`, and a `.js` retry for `next/headers` — a package with no `exports` map does not get extensionless subpath resolution in ESM) the WHOLE run-path import graph loads and runs under `node --experimental-strip-types`. So: `worker/start.mjs` (plain `.mjs`, registers the hook) → `worker/agent-runs.ts`, and the Dockerfile bakes `core/`, `tabs/`, `worker/` and `tsconfig.json` at `/app/src`, one level under the standalone `node_modules` so bare specifiers resolve up into it. No second `node_modules`, no build step, and the worker executes the same modules the Next build compiles. **Constraint this adds: the image's Node must be ≥ 22.6.** It is 22.13.1 today; the boot log line is the cluster check (an `ERR_UNKNOWN_FILE_EXTENSION` there means the base image went backwards).
- **A4-4 The walker engine stays request-bound and has no queue.** `AGENTS_WORKER` applies only to `langgraph`: the walker has no thread, no checkpoint and nothing to resume, so filing a `run_jobs` row for it would create a durable record of something that cannot be recovered. A5 deletes the walker and the branch with it.
- **A4-5 A role UPGRADE does not refuse a queued job; a downgrade does.** The brief said "refuse typed if changed". Taken literally that refuses a run because its owner was promoted while it sat in the queue, which is user-hostile and buys nothing: the yaml is re-governed against the OWNER's live role on every run (`prepareRunYaml` → `governYamlForOwner`), so a higher role cannot widen what the system may do. The refusals are therefore: gone/disabled (`runner_unavailable`), live role below the filed role (`runner_role_changed`), and the run's domain no longer in the live domain set (`runner_domain_lost`). Tested both directions.
- **A4-6 A `parked` job is settled but not finished.** `status='parked'` releases the lease and ends the POST tail (its `done{parked:true}` frame is deliberately NOT terminal for a re-attach), and only a `parked`/`done`/`failed` row may be re-queued as a resume. That is what makes the status column a usable cross-process in-flight lock without a second table.
- **A4-7 The resume hook FILES a job instead of running the graph** (`enqueueResumeAfterDecision`, wired from `resume-boot.ts`), which removed `resumeOsRunAfterDecision` from `run-service.ts` and gave `ApprovalResume.status` a `queued` value. In `inline` mode the behaviour is unchanged (the decider's request still executes it); in `worker` mode the card honestly says the resume is queued rather than reporting a `done` nobody observed. The `resumed` frame is appended BEFORE the job is filed so it precedes the resumed run's own events in `seq` order whichever pod executes them.
- **A4-8 The os-ui env list became a named template** (`soa.osUI.env` in `templates/base/os-ui/_os-ui-env.tpl`). ~290 lines of env duplicated into a second Deployment would have drifted on the first change. Verified as a pure refactor: `helm template` of `os-ui.yaml` is byte-identical to the pre-change render. The one nested include inside it (`soa.serviceBearerEnv`) moved from `nindent 12` to `nindent 0`, since the outer include now supplies the indentation.
- **A4-9 The worker Deployment has no Service and probes with an exec.** It serves no HTTP, so an `httpGet` liveness probe would have required starting a server for the probe's sake. A wedged process fails `node -e 'process.exit(0)'`, is restarted, and the run it held is re-queued by the next pod's lease reaper.
- **A4-10 `scheduled.ts` and the MCP `run_agent_system` take the queue only under `langgraph`,** and keep their injected `runOsTeam` seam for the walker. No existing test sets `AGENTS_ENGINE=langgraph`, so the walker-default suites are untouched; the langgraph branch is covered by the queue's own tests. `scheduled.ts` gained `deps.startQueuedRun` for the same reason.
- **A4-11 The non-streaming `POST …/run` awaits its own inline execution** so a refused run keeps the exact HTTP status it had before A4 (404 unknown thread, 409 in flight/finished). In `worker` mode it follows the event log for up to 240 s and then returns `202 { queued: true, runId, afterSeq }` — honest about not having waited, with the cursor to resume from. The SSE path emits a `queued` frame in the same situation.
- **A4-12 `maxAttempts` is 2 and is burned by a CLAIM, not by a failure.** A run that fails on its merits fails once and stays failed; the attempt counter exists only for leases nobody renewed. Two claims therefore means "one honest retry from the checkpoint", then a visible failure.
- **A4-13 `run-lock.ts` stays.** The `run_jobs` row is the cross-process authority (A3 review M-B said A4 would replace the in-process lock), but the in-process lock is free and still catches two entrants inside ONE pod before any store round-trip. Both are tested.
- **A4-14 What proved wrong, besides A4-3.** (a) The route was preparing the governed yaml and then the executor prepared it again — made lazy, so only the request-bound paths pay for it. (b) `tailRunEvents`'s `until: 'settled'` has to drain once MORE after it sees a settled status, because the status flips after the last event is written; without that the final `done` is lost on a fast run. (c) A resume of an unknown run reported 409 (see A4-resume). (d) `boundedResult` previously always returned a preview, so the `observe.ts` header's claim that results are "character counts" was false — fixed in both directions (A4-review-b).
- **A4-15 Untestable here, with the exact cluster steps written down.** Checklist A18 ("a run longer than the request cap completes") and A14's cluster half ("a rolling restart loses no run") need a cluster and a genuinely long run; `docs/components/os-ui.md` → "Verify it in a cluster" carries the commands (enable the worker, read the boot line, start a >6-minute run and close the tab, query `run_jobs`/`run_events`/`checkpoints`, `rollout restart deploy/os-ui-worker`, and a `--grace-period=0 --force` delete to exercise the stale-lease path). Marked `untestable here` in the checklist rather than ticked.
- **A4-review-a** `runtime.test.ts` MODEL-KEY matches `litellmMasterKey|LITELLM_MASTER_KEY|PROXY_MASTER_KEY` and asserts `deepEqual(hits, EXPECTED)` — a file leaving the set is as interesting as one joining it. `core/infra/tool-sso-litellm.ts` is out of the expected set: it never read the key (A3-10 listed it as "reserved", which made the allowlist describe an intention rather than the code).
- **A4-review-b** `observe.ts`: the header's result claim corrected; `config.langfuseRedaction: 'structure' | 'strict'` threaded through `redactRequest`/`redactCompletion`/`redactMessages`/`boundedResult` and the tool spans (`strict` = argument key names + character counts, no preview), recorded on the generation and the span so a trace says how it was written; `docs/components/langfuse.md` rewritten with the two-level table AND the fact that LiteLLM's nested generation still ships the full prompt unless `turn_off_message_logging` is set at the gateway.
- **A4-review-c** `tabs/knowledge/lib/retrieve.ts` and `tabs/files/lib/retrieve.ts` pass the acting principal into `embedQuery`, so a retrieval's embedding is billed to the user, not the platform. (Both carry a delegated `Principal`/`Reader` with no `activeDomain`, so the scope is `domains[0]`.) `core/runtime/complete.ts` tags `activeDomain ?? domains[0]`.
- **A4-review-d** `core/infra/langfuse.ts` registers `process.once('SIGTERM', () => void client.shutdownAsync())` on construction — the SDK buffers 20 events / 2 s, so a stopping pod was losing the end of its last run.
- **A4-review-e** `core/runtime/runtime.ts` drops `metadata.trace_id`; `existing_trace_id` is the key LiteLLM's callback reads, and two names for one id invite them to disagree. The attribution test now asserts its absence.
- **A4-review-f** `observe.ts tool()` maps `"code":"not_found"` to `error`, not `denied` — a missing object is the tool reporting reality, not a governance decision, and counting it as `denied` would inflate every policy dashboard.
- **A4-review-g** `tabs/agents/lib/build/server.ts` no longer builds `<console>/traces`. That path is the legacy hermes/unmapped-grant run, which has no run id and therefore no trace to open; a LIST link violates checklist A20 and drops the viewer into every tenant's traces. It now reports `traceStoreAvailable` with no link.
- **A4-review-h** `scripts/check-litellm-allowlist.mjs` reads `default_fallbacks`, `context_window_fallbacks` and `content_policy_fallbacks` as well as `fallbacks`. The last two fire on exactly the errors a long agent prompt or a refused completion produces, so an alias reachable only through them is the worst possible 403.
- **A4-review-i** `app/api/knowledge/workflows/[id]/publish/route.ts` returns `indexing: { ok: false, code, error }` instead of swallowing the failure. A publish whose embedding was rejected by the gateway leaves the unit invisible to every agent; the caller has to see that the flip succeeded and the indexing did not.
- **A4-review-H-1 A run id was an authorisation.** `POST …/run {resume:true}` checked only
  `getSystemForRun`, then enqueued and tailed from `seq=0`; the engine's owner gate
  (`run.ts assertResumable`) fired AFTER the row had been re-queued (overwriting `requested_by`
  and `principal_snapshot`) and after the whole history had streamed to the caller. Fixed at both
  layers: `engine/run-visibility.ts` `assertRunVisible` (pure, dependency-free, 404-semantics) is
  called BEFORE any side effect by the run route, the re-attach stream and MCP `resume_agent_run`
  (twice there: the checkpoint owner and the `run_jobs` row); and `enqueue(kind:'resume')` in both
  stores refuses a foreign `requested_by` — in Postgres as a `requested_by=$2` predicate ON the
  UPDATE, so a refused resume provably writes nothing. Tests: `run-visibility.test.ts` (4).
- **A4-review-H-2 A lost lease was a log line.** `run-jobs-server.ts` only logged
  `heartbeat()===false`, so the pod kept executing a run another pod had re-claimed, and
  `complete` was `WHERE run_id=$1` (unlike `requeue`) so the loser could settle the winner's run.
  Now: `leaseWatch` (pure) flips `lost()` once and aborts the run; `settlementOf` (pure) says
  `abandon` — neither settle nor requeue — and `abandon` beats a failure and a shutdown; `complete`
  takes an optional `lockedBy` and adds `AND locked_by=$5 AND status='running'`, returning whether
  it applied. **`appendEvent` is deliberately NOT guarded** (decision recorded): the engine's
  `emit` is synchronous and carries no holder, a late event is ordered after the new holder's by
  `seq` and is at worst a duplicate panel line, whereas a stale settle ends a live run — and a
  guard there would need a holder threaded through `executeTeamRun`'s emit for no safety gain. A
  heartbeat that THROWS is not a lost lease (a DB blip must not abort healthy runs); the reaper
  stays the backstop. Tests: `jobs-lease.test.ts` (4 of 12).
- **A4-review-M-1 `inline` mode had no reaper.** `ensureRunJobsReady()` now runs one
  `reapStaleOnce` sweep at boot, and an inline run heartbeats its own lease through the same
  `startLeaseKeeper` the worker uses (same lease, same abort-on-loss) — so an OOM-killed os-ui pod's
  row is reaped by the next pod's boot instead of sitting `running` forever in a deployment with no
  worker. Tested at the store level plus a source tripwire on the wiring (the module is
  `server-only`, so a unit test must not import it).
- **A4-review-M-2 A decision taken while the run was still parking stamped the approval `failed`.**
  Between `interrupt()` and `complete(…,'parked')` the row is `running`, which `enqueue` refused
  409 → `resume.ts` recorded `failed` for a perfectly valid decision. CHOSEN: bounded retry
  (`enqueueResumeWithRetry`, 5 × 200 ms, pure and injectable) rather than a `pending_resume`
  marker — the window is one `await` wide, a marker adds a second piece of state to the row and a
  new way for the row and the checkpoint to disagree. `RunJobConflictError` now carries `state`, so
  ONLY a `running` row is retried: a `queued` row (a resume is already filed) and a missing row
  fail at once. Applied to every resume door via `enqueueRun`. Tests: 3.
- **A4-review-M-3 The tail-timeout UX lied.** Both doors emitted `queued {runId, afterSeq}` at
  240 s and `BuildRunPanel.tsx` had no handler, so the frame fell through to "please run
  again" — about a run that was still executing — and its own re-attach asked for `afterSeq=0`
  (replaying everything). The SSE logic moved to `tabs/agents/lib/build/run-stream-client.ts`
  (pure: `parseSseChunk`, `reattachFrom`, `isRunOver`, `runStreamUrl`, `REATTACH_LIMIT = 40`) and
  the panel now follows the server's cursor in a loop until the run really ends. Tests: 8
  (including a source tripwire that the TSX uses the shared helpers).
- **A4-review-L-3 corrected the review.** The item asked for an event-less `until:'terminal'` tail
  to end on ANY `isSettled` status; that would close the re-attach stream of a PARKED run, which is
  exactly the stream that exists to show the decision resuming it (A4-6). Implemented as "settled
  and not `parked`", plus the extra drain. Tested in both directions.
- **A4-review-M-4 Admin secrets were in the worker pod.** `_os-ui-env.tpl` is now three defines:
  `soa.osUI.runEnv` (the run path), `soa.osUI.adminEnv` (`OS_SESSION_SECRET`,
  `OS_MCP_TOKEN_SECRET`, `GRAPH_CLIENT_SECRET`, `LITELLM_UI_USERNAME/PASSWORD`,
  `LITELLM_MASTER_KEY`) and `soa.osUI.env` = both, so `os-ui.yaml` is untouched; the worker
  includes only `runEnv`. Verified with `helm template`: the os-ui Deployment's env NAME SET is
  identical to before (the six entries moved to the END of the list — identical ordering is not
  achievable with two defines, and the brief allowed "modulo ordering"), and the worker Deployment
  contains none of the six. `scripts/check-worker-env.mjs` asserts both in `os-ui/scripts/gate.sh`
  (skips loudly when `helm` is absent) and the manual one-liner is in `docs/components/os-ui.md`.
- **A4-review-M-5 A run killed before its first checkpoint failed instead of restarting.**
  `reapStale` re-queued everything as `kind='resume'`, and a resume of a thread with no checkpoint
  is a 404 — a retry turned into a visible failure. The reaper now PRESERVES the row's kind
  (`CASE WHEN kind='start' THEN 'start' ELSE 'resume' END`); `requeue` (SIGTERM) still forces
  `resume`, because that path always has a checkpoint. Chosen over converting `ResumeNotFoundError`
  back into a start inside the executor: the store-level rule is testable without a graph and
  cannot be defeated by a future executor. The two existing A4 tests that asserted the old
  behaviour were updated with the reason.
- **A4-review-L-1 corrects A4-8.** The split in M-4 supersedes it, and the claim it made is now
  stated properly: the os-ui Deployment gains `AGENTS_WORKER_LEASE_MS` ONLY from
  `osUI.worker.leaseMs`, which is also rendered when the worker is DISABLED — os-ui reads the same
  value for its inline lease and its boot sweep, so that is correct rather than accidental.
- **A4-review-L-2 The liveness probe proved nothing.** `node -e 'process.exit(0)'` tested whether a
  NEW process could start. The worker now touches `AGENTS_WORKER_ALIVE_FILE` (`/tmp/worker-alive`,
  an `emptyDir` because the root filesystem is read-only) every 15 s from an unref'd interval — an
  interval only fires while the event loop turns — and the probe fails when the file is older than
  60 s (2× the probe period) or missing. Documented in `docs/components/os-ui.md`, with the
  `stat` check in the cluster steps.
- **A4-review-L-4 `run_events` is exempt from `LANGFUSE_REDACTION`** — stated in
  `docs/components/langfuse.md` and `docs/components/os-ui.md`: the switch governs the TRACE, while
  the panel's own event log is written in full by design (a redacted `node-completed` would show
  less than the page the user is looking at). It lives in `agent_runs` beside the checkpoints,
  under the same absent retention, so the A13 follow-up now names both tables.
- **A4-review-L-5 `worker/resolve-hook.mjs` derives its aliases from `tsconfig.json`**
  (`compilerOptions.paths`, longest prefix first) instead of a hand-kept copy that could drift from
  the compiler's — a drift that fails as `ERR_MODULE_NOT_FOUND` in the cluster, not in CI. A
  non-`<prefix>/*` mapping throws rather than being silently ignored. Test: parity with the
  tsconfig, ordering, actual resolution of `@core/*` and `@tabs/*`, and the `server-only` stub.
- **A4-review-L-6 A ceiling on tails.** `engine/tail-limit.ts`: 64 concurrent tails per pod, the
  next refused `503` + `Retry-After: 5` (each tail polls every 400 ms against a `pg` pool of 6
  shared with the checkpointer). Released on close AND on client disconnect (`cancel()`). The pool
  was NOT raised: the worker holds one claim at a time and os-ui only enqueues and tails, so the
  ceiling is the honest fix; raising both together is documented as the next step if a tenant needs
  more.
- **A4-review-L-7 `check-structure.mjs` walks `os-ui/worker/`** for the FILE-HEADER rule (it is
  production code the Next build never compiles), which found `worker/empty.mjs` — now headed. The
  `worker/` layer is described in `os-ui/ARCHITECTURE.md`'s layout block, including the fact that
  these entrypoints MAY import a tab.

- **Follow-ups recorded, not implemented (A4):** (1) other Langfuse readers are scope-filtered CLIENT-side rather than through `observationsQuery` — only the diagnostics route goes through the typed, refuses-unfiltered query; the rest fetch and then filter in the OS, which is correct today only because the OS is the one asking. (2) The three remaining embed sites (`indexWorkflow`, `indexDomain`, `indexAsset`) still bill the platform principal (A3-11); A4 threaded the two RETRIEVE sites only, because the index sites have no acting user in scope. (3) `BuildRunPanel.tsx` re-attaches with no `afterSeq`, so it replays the whole run on re-attach — the same behaviour the A2 replay buffer gave it, but now it could ask for only what it missed. (4) `run_events` has no retention; it joins the A13 item with the checkpoints and the held approval args. (5) **A4 review:** image-level verification that the worker's type stripping works is a `docker build` away and cannot run in the unit gate — the exact `docker run --rm --entrypoint node … --experimental-strip-types -e "import('./worker/agent-runs.ts')"` command is now step 4 of `docs/components/os-ui.md` → "Verify it in a cluster" and a post-build smoke step in `scripts/deploy.sh` (it imports the whole run-path graph without touching a database, so it fails loudly on a base image below Node 22.6 and on an alias mistake). (6) **A4 review:** raising the `pg` pool `max` for the worker only, together with the 64-tail ceiling, if a tenant ever needs more concurrent panels. (7) **A4 review:** the Run panel still re-attaches to a PARKED run with `afterSeq=0` (it has no seq to resume from, because frames carry no `seq`); sending `seq` on the wire would let the parked re-attach be incremental too.

- **A5-1 `AGENT_RUNTIME_TOKEN`, `config.agentRuntimeToken` and the `agent-runtime-token` Secret are KEPT.**
  The token outlived the workload it was named after. os-ui does not *present* it any more (there
  is nothing to call), it **validates** it on the service paths the OS's own CronJobs hit:
  `/api/agents/scheduled-run`, the metrics data-sync sweep and the connections catalog-refresh
  sweep, all through `build/runtime-auth.ts` `runtimeTokenOk`. The data branch's Dagster sidecar
  reads the same Secret (review finding B2 L-6 is moving it into its own template), so the Secret
  stayed exactly where it was — `charts/.../base/agent-runtime/agent-runtime.yaml`, now a
  Secret-only template, ungated and nil-safe — rather than being moved and conflicting with that
  work. `agentRuntime` values shrank to `{ token, schedules }`. **Follow-up: drop the token (and
  rename the key) once the data side has its own Secret template; this file and that template
  carry the same note.**
- **A5-2 The flag is REMOVED, not flipped.** The plan said "flip the default to `langgraph`, then
  delete the flag". Flipping first buys a rollback that does not exist: the thing the flag would
  roll back to is deleted in the same commit, so a `AGENTS_ENGINE=walker` after A5 would select an
  engine that is not there. So: no default, no selector, no `runtime: walker`. What IS kept is a
  single boot WARNING when the variable is still set — the one failure mode worth insuring against
  is an operator who believes they pinned the old engine and is not told otherwise.
- **A5-3 `runtime: hermes | walker` in a stored file is NORMALISED, not rejected.** The global
  constraint is "existing `system.yaml` files must keep working unchanged". Removing the values
  from the `Runtime` union would have made `parseSystem` throw on a saved file, i.e. a 400 on
  every read of that system — unopenable, not just un-runnable. `parseSystem` therefore accepts
  both retired names and returns `langgraph`; the serializer already omits the key, so the next
  save rewrites the file without it. A1-10's requirement ("A5 must actually remove
  `runtime: walker`") is met in the sense that mattered: there is no way to opt a system out of
  the stricter rules.
- **A5-4 `isAgenticOsTeam` is gone, replaced by `unmappedGrantNames(sys): string[]`.** The boolean
  chose between the in-process path and the Python fallback; with one path the question is not
  yes/no but *which grants have no governed tool behind them*, and that answer belongs in the
  error the door returns. Two behaviour changes follow, both deliberate: (a) a system with NO tool
  grants is now runnable (its agents are plain completions) — the old `grants.tools.length === 0`
  refusal was an artefact of the fallback; (b) a system with an unmapped grant gets a 400 NAMING
  the tool at the route / scheduler / MCP instead of being quietly routed to a weaker executor.
- **A5-5 Build's graph step now compiles the real StateGraph** (`build/compile-verify.ts` →
  `buildGraph` with inert deps). The plan only said to delete `live.ts`'s `/reload` path; deleting
  it left the `langgraph` Build row with nothing to do, and the two things it used to do each
  verified something the engine never executes (a POST of the IR to a Python interpreter; a
  hand-rolled BFS in the mock adapter). Compiling needs no cluster, so live and offline now run
  the SAME check — and it is the tripwire that `langgraph-compile.ts`'s output is CONSUMED rather
  than merely emitted. Consequence: Build's Langfuse row is `pending` (neutral, `report.ok`
  tolerates it) until the system has actually run, because its probe reads the traces a RUN leaves
  behind and a build no longer manufactures them. Four test files were updated to assert that
  instead of a fabricated trace.
- **A5-6 `runtime-contract.ts` keeps its path, loses its name's meaning.** Only the WIRE types
  were deleted (`/reload`, `/run`, the governed-tool callback, `RUNTIME_DEFAULTS`); `principalFor`
  and `runCostUsd` live there and are imported by a dozen modules across three tabs and the
  kernel. A rename would have been a 12-file diff for no behaviour change; the header now says
  what the file is. Same reasoning for `build/agentic-graph.ts`, which is now the agent NODE layer
  (it is still what one agent of a graph IS) and for the `templates/base/agent-runtime/` directory
  (see A5-1).
- **A5-7 The fixtures are FROZEN and `REGEN_FIXTURES` is deleted.** The generator ran the walker;
  the walker is gone. Regenerating a "golden" from the engine under test would prove only that the
  engine equals itself, and it would erase what the two guarded fixtures exist to record — the
  walker visiting a node whose `when` guard is false. `fixtures.test.ts` therefore checks what can
  still be checked without a generator (the set covers every shipped template + the team + the
  three shapes, each file well-formed, carrying the current `SCRIPT_ID`, its yaml still matching
  the shipped template, `guarded` matching the yaml, no orphans) plus one test that the guarded
  fixture still records the defect. A new shape means a NEW fixture beside them.
- **A5-8 The Runtime card lost its second option.** `RuntimeSelector.tsx` offered "Structured
  (LangGraph)" and "Autonomous (Hermes)". Hermes never executed a system in this OS, so the second
  card was a promise the product did not keep; the component is now one honest line about the
  engine plus the safety presets (which are the real choice moment). `SystemView` stops passing
  `hermesEnabled`; the API field and the hermes-gateway health row are left alone — that extension
  is a separate component and not A5's business.
- **A5-9 `holdAt: 'executor'` stays the DEFAULT.** After A5 the only production caller passes
  `'node'`, so the option is single-valued in practice. It is kept because gate 1b in the executor
  is defence in depth for any future caller that is not a graph node, and its tests are the only
  thing that proves the executor can hold at all.
- **A5-10 What proved wrong in the plan, and what the audit items actually needed.**
  (a) The plan listed `runtime-contract.ts` for deletion; two widely-used pure helpers live in it
  (A5-6). (b) It did not mention that deleting the Python runtime removes Build's `langgraph`
  verify and `runSystem` entirely (A5-5), nor that `isAgenticOsTeam` becomes meaningless (A5-4).
  (c) It called `AGENT_RUNTIME_TOKEN` an agents-side concern; it is in fact the shared bearer for
  three CronJob paths across two tabs (A5-1). (d) **The audit item "diagnostics are owner-filtered"
  was NOT satisfied before this phase:** the route filtered Langfuse observations by `traceId`,
  and the trace id IS the run id, so a guessed run id returned another user's generations — the
  same defect class as A4-review-H-1, one layer further out. Now `assertRunVisible` runs before
  any trace read. (e) The audit item "`langgraph-compile.ts` output is consumed" was already true
  on the RUN path (`compile` → `buildGraph`) but FALSE on the Build path, which only counted the
  IR's nodes; A5-5 fixes that and `agent-run-surface.test.ts` + `live.test.ts` are the tripwires.
- **A5-11 (REWRITTEN in the review round — the original was wrong) `grant-rehydrate.ts` was DEAD
  CODE, and deleting it changes no gate.** The original note said that because the module is never
  imported, "after a pod restart an `os-<systemId>` principal's grants are NOT rehydrated and gate
  1a falls through to the static chart grants" — implying a live agent-path defect. It is not one.
  The app-registry grant map is read by exactly one function, `authorizeAppTool`
  (`core/infra/agent-governed.ts`), and that function is called from exactly one place:
  `tabs/software/lib/app-tool-call.ts`, the **auto-generated app MCP** path of the Software tab.
  The AGENT path never consults it: an agent's tools are narrowed by `grantedToolSpecs` and
  executed by `grantedToolExecutor` (`tabs/agents/lib/build/os-tools.ts`), both of which read the
  system YAML's own grants in-process (gate 1/1b) before dispatching as the acting user (gate 2) —
  and the engine additionally narrows per node in `tools_<id>`. So on the agent path the module is
  neither fail-open nor fail-closed; it is simply unreachable. On the APP path, `grantsForDurable`
  with no registered resolver is **fail-closed** by construction (`core/infra/app-registry.ts`:
  `if (!resolver) return existing;` → the in-memory set, then OPA's default-deny), which is what
  happens today anyway because nothing imports the registrant. The review round therefore `git
  rm`'d `grant-rehydrate.ts` and its test rather than wiring a resolver nobody asked for.
  **Follow-up (app path, not agents):** `registerDurableGrantResolver` now has no caller at all,
  and the comment above `authorizeAppTool` still describes grants that "self-heal" from a durable
  record after a restart. Either the Software tab registers a resolver of its own or that comment
  should go; both live in `core/infra` / `tabs/software` and were left to their owners.
- **A5-12 The repo-wide grep does not come back empty, by design.** `walker` / `agent-runtime` /
  `AGENT_RUNTIME` still appear in: the KEPT shared bearer and its Secret name (A5-1); historical
  "A5 deleted X" notes in the files that lost the code; the frozen parity fixtures and their tests,
  which exist to describe the walker; `llm-replay.ts`, whose purpose was recording for both
  engines; and the unrelated pure `tree-walker` in `tabs/software/lib/appspec/`. No live code path
  references either. `tabs/data/**` keeps `config.agentRuntimeTokenSecret*` (its CronJobs use the
  same bearer) and was not touched — that tree belongs to the data branch.
- **B1-1 The store emits events; it does not import the commit path.** `tabs/data/lib/store.ts` is reachable from the client bundle through `lib/index.ts` (the `markDatasetsSourceRevoked` comment records that even a dynamic import of a node-only module there broke the production build). So the store emits a pure `ProjectChange` (`tabs/data/lib/project-events.ts`) from its one `persist()` and from every writer that bypasses it, and the server-only `dbt/commit.ts` subscribes at boot. One code path for commits still holds — the listener is the only caller of `commitDataProject`; a second listener would be visible in `instrumentation.ts`.
- **B1-2 Model bodies come from the compiled artifact recorded at build, not from a re-run of the compilers at generation time.** *(Corrected in B2 — review M2: the sentence below said "the recorded body IS `compileSilver`/`compileGoldJoin`'s output". That was only true for bodies the OS itself compiled; `add_dataset_version` and the version route accept a free-text `body` through the same field, and the generator rendered it as a model, so user text was handed to Jinja at `dbt parse`. The store now records provenance and ONLY a compiled body becomes a model — see B2-1. The last sentence below, "a built layer with no recorded body renders a commented pass-through", is also superseded: such a layer is a dbt source now.)* The Silver guided ops are not persisted (only `compileSilver`'s CTAS is, via `buildVersion({body})`), and the Gold `goldSpec` is the panel's own vocabulary converted client-side — the server never held a `GoldJoinSpec`. Recompiling would have meant re-implementing the panel's mapping on the server (drift risk). The recorded body IS `compileSilver`/`compileGoldJoin`'s output, so the generator strips `create or replace table … as` and rewrites FQNs; the pure parity test asserts byte equality with `compileGoldJoin` after substitution. A built layer with no recorded body (seeded / adopted) renders a commented pass-through of the layer below, never a stub.
- **B1-3 Surface via AsyncLocalStorage, not threaded signatures.** Adding `{surface, requestId}` to every store mutator would have touched ~30 signatures and every caller (several in A2's area). `core/infra/request-surface.ts` sets the scope in `withRoute` (all wrapped routes), in the data MCP tools (`mcp:<tool>`) and in the two hand-rolled data POST routes; the hook reads it synchronously at mutation time. Gap, logged at runtime as `ui:data`: writers outside any scope — e.g. the scheduled sync marking Bronze built (`sync-run-server.ts`, no request) and agent-side callers (`tabs/agents/**`, not touched). There is no request-id convention in the OS yet; one is minted per scope (`req_<16 hex>`).
- **B1-4 `CurrentUser` carries no e-mail.** The store's `Principal` is `{id, domains, role}`; the user directory (`tabs/admin/lib/users.ts`, `email?`) is another tab, so the commit hook takes an injected `resolveActor` which `instrumentation.ts` wires to `getPublicUser`. Users without an e-mail (the local bootstrap admin, API-created users) get `<id>@os.local` and the commit says so (`OS-Author-Email: synthesized`). The concept's "confirm every CurrentUser has an e-mail" remains open — it does not.
- **B1-5 Sync source catalogs are resolved by an injected resolver, else flagged.** The federated source's Trino catalog lives on the connection (another tab's store); `sync-run-server.ts` gained `connectionCatalogForOwner` (reusing its existing lazy owner + connection resolvers) and `instrumentation.ts` passes it in. Unresolvable ⇒ the source is emitted without `database` and `meta.os_catalog: unresolved` (parse passes, the gap is visible); a non-catalog (API-batch) connection ⇒ `os/external.yml`, never a model.
- **B1-6 NetworkPolicy keeps os-ui:3000 open.** No ingress policy selected os-ui pods before; a 9418-only policy would have isolated the UI. `os-ui-git-daemon-dagster-only` allows 3000 from any peer (status quo) and 9418 from `component: user-deployments` (the Dagster subchart's label — verify on the cluster; the subchart tgz is not vendored, so `helm template` cannot render here and lint only warns about the missing dependencies, as before B1).
- **B1-7 Chart objects are gated on `osUI.dataProjectGit.enabled` (default false)** so a default install is unchanged (no PVC provisioned, no sidecars). The Dagster `repo-sync` sidecar cannot be gated from values (it is subchart config), so it ships inert: `REPO_SYNC_ENABLED=false` makes the script idle. The `sidecarContainers` / `volumes` / `volumeMounts` keys of the Dagster user-deployment schema and the `alpine/git` tag `v2.47.2` are to be verified at the first deploy (B2 bumps the image tag anyway). `includeConfigInLaunchedRuns` will propagate the `emptyDir` to run pods (empty until B2).
- **B1-8 Domain discovery for repo-sync is an explicit list** (`REPO_SYNC_DOMAINS`): the git protocol cannot enumerate repositories. B2 adds discovery (e.g. an index the OS maintains) together with the multi-project code location and the `reloadRepositoryLocation` call (`DAGSTER_RELOAD_LOCATION` empty ⇒ logged skip).
- **B1-9 `data_tests:` not `tests:`** in `schema.yml` (dbt ≥ 1.8 in the image; `tests:` is deprecated). `+on_table_exists: replace` requires dbt-trino ≥ 1.8 (the image pins `>=1.8,<1.10`). `impersonation_user` with `method: none` is what B3 must verify against the image/Trino; the profile reads `TRINO_AUTH_METHOD` so B3 can switch without regenerating history.
- **B1-10 The concept's "`projectGit.commit(domain, user, {action, surface})`" became an event + hook** (B1-1) and its proposed `tabs/data/lib/git/` wrapper was placed in `core/infra/git-store.ts` from the start (both tabs need it; a tab may not import another). `OS-Dataset` trailer is spelled `OS-Object` per the plan's Part D wording; the value is `<id> (<name>)`.
- **B1-11 Promote/publish does not "move" a model file as the concept says; the generator derives placement from `tier`.** A promoted dataset's models render under `models/<layer>/` in the domain schema and the personal copy disappears from the tree in the same commit — the observable result (one commit, model moved) is the concept's, without a move operation.

- **B2-resume: inherited 31 partial files from a predecessor terminated mid-phase (API usage limit).** 10 new files (`core/infra/dagster.ts` + its test, `app/api/data/projects/route.ts`, `tabs/data/lib/dbt/{asset-keys,launch}.ts`, `tabs/data/lib/{sync-status-server,dq-status-server}.ts`, `images/extensions/dagster/os_projects.py`, `tests/test_os_projects.py`) and 21 modified. **All kept** — `tsc --noEmit` was already clean and the suite already green (4985/0), and every file read end to end held up. The predecessor's last words reported "a garbled `location` expression in `syncStatusFor`" and `dq-status-server.ts` + the index route as unwritten; in fact it had fixed the expression and written both before being cut off, so nothing was discarded. What was **missing** and is this agent's work: every call site (no surface called `launchDatasetBuild`, `syncStatusFor`, `latestDqRun*` or `projectIndex` — the transform route carried only an unused import), the `set_dataset_sync` hand-over, the sweep stand-downs, the Monitoring adapter, the image tag / deployment rename / sensor env in `values.yaml`, the Admin version string, the Files connector, 5 of the 6 test files, every doc, and the review items M4 + L-series. One piece was **removed**: an unused `onDataProjectCommitted` observer seam in `commit.ts` — `launchAfterCommit` awaits the in-flight commits and reads the head itself, so the second mechanism was dead code.

- **B2-1 Provenance, not escaping, is how an authored body is made safe (review M2).** The review suggested rendering a non-compiled body as a commented pass-through or inside `{% raw %}…{% endraw %}`. Both still put user text in a *model*, which a scheduled `<model>+` run would then **materialise** — replacing a table the OS never built with a commented-out no-op or a literal. So `store.buildVersion` gained `compiled?: boolean` (set only by the transform / gold-join routes and `transform_silver` / `build_gold_join`), persisted as `DatasetRecord.compiledArtifacts`, and the planner emits a model ONLY for a compiled body or a pass-through. A built layer without compiled provenance becomes a dbt **source** (`meta.os_built: out-of-band`) that dbt reads, tests and never rewrites. *(CORRECTED by B2-review-H3: the sentence that followed — "and no user-authored byte reaches the tree at all" — was **false**. No authored BODY reaches the tree; authored descriptions, dataset names and column names always did, into `schema.yml` / `sources.yml` descriptions and into model-SQL header comments. dbt renders both YAML and SQL through Jinja, so those were template input. They now pass through `emit.stripJinja`; the accurate claim is "no authored byte reaches the tree **as a template or as SQL**".)* Consequence: the dataset's quality rules attach to that source instead of a model, and `asset-keys.ts` returns the source key as the tested asset.
- **B2-2 `set_dataset_sync` hands over through one function, not by removing a call.** The brief said it "stops calling `reconcileSyncCron`". A flag check at each of the three call sites (the PUT route, the MCP tool, `adopt-connected.ts`) would drift, and a dataset saved *before* the flag flipped would keep a live CronJob **and** gain a Dagster schedule — the same slice twice. `tabs/data/lib/dbt/launch.ts` `reconcileSyncSchedule` is now the single entry point: flag off ⇒ `reconcileSyncCron` unchanged; flag on ⇒ `reconcileSyncCron(id, null)` once (idempotent cleanup of a pre-B2 CronJob) and an outcome in the shape the panel already renders saying Dagster owns the schedule. `/api/data/sync-due` and `/api/data/dq/run-all` stand down for the same reason.
- **B2-3 The code-location deployment is renamed `example-user-code` → `sovereign`.** In the Dagster Helm subchart the user-deployment's `name` *is* the code location name, and `reloadRepositoryLocation("sovereign")` / `config.dagsterLocation` must address it. This replaces the Deployment on the next upgrade (new name, old one removed by Helm) — additive in data terms, visible in `kubectl get deploy`.
- **B2-4 `repo.py` cannot be unit-tested in this worktree; `os_projects.py` carries the logic.** Dagster is not installed locally, so `build_definitions()` is unreachable from `python3 -m unittest`. Everything decidable without Dagster was therefore moved into `os_projects.py` (discovery, `os/schedules.yml` parsing, schema→principal derivation, tag and name shapes, quarantine and principal-pause decisions) and tested there, including a **contract test over the exact bytes the TypeScript generator emits** for `os/schedules.yml` — a renamed key fails in CI, not on the cluster. `repo.py` itself is covered by `py_compile` plus the first deploy.
- **B2-5 Quality read-back falls back to the OS row, LABELLED.** With the flag on, a dataset whose tested asset has no asset-check execution yet (a brand-new model; a layer built out of band before the first `dbt build`) would show "never run" even though the user just pressed "Run checks". `DqRunRecord` gained an optional `source: 'dagster' | 'os'` and `latestDqRun` returns the OS's own ad-hoc row marked `source: 'os'` in that case. A record is never a *mix* of the two, and a Dagster record always says `dagster`. The ad-hoc "Run checks" path still writes `os-dq-results` — it is not a Dagster-executed run; B3 deletes it with the rest of the OS executor.
- **B2-6 External-source assets are NOT in B2.** The plan's B2 line asks for "one asset per external sync source". Kafka-offset and API-batch syncs (Salesforce, Kajabi, the Files connectors) are not dbt models and the concept (§1) puts them in a Dagster *Python* asset that calls the OS's governed slice executor over the runtime-bearer route. That needs the executor's HTTP contract, which B3 reshapes; building it now would mean writing it twice. The generator already records them in `os/external.yml`, `repo.py` ignores that file, and the Files connector's dead `launchPipelineExecution` is a logged no-op with the TODO. Checklist D7's "one asset per external source" half stays open.
- **B2-7 `/api/data/projects` authenticates with the shared runtime bearer, like the sync trigger.** The sidecar and the `os_principals` sensor need the full domain list, which no user session can provide. The route therefore takes bearer-OR-user auth (the pattern the dataset sync POST already uses); a signed-in caller is narrowed to `user.domains`. `active` is resolved through the same owner resolver scheduled runs use, and an unresolvable principal is `active:false` — so a deleted owner's schedule is **paused**, never run.
- **B2-8 `lastSync` now means when the newest run ENDED** (its start while still running), in both the Dagster and the ledger path. The pre-B2 Monitoring rows used `startedAt` for a finished run, which read as "last synced" minutes before the data actually landed. One `SyncSignal` shape serves both paths.
- **B2-9 The structure baseline was NOT re-locked.** Three counts came *down* (TAB-ISOLATION 422→421, CORE-INDEPENDENCE 207→206, FILE-HEADER 1249→1248) and `check-structure.mjs` passes. Running `--baseline` would rewrite `scripts/structure-baseline.json`, which A4's agent-side work also touches; the ratchet only forbids growth, so the lower numbers are left for the coordinator to lock in after the merge.
- **B2-10 Known gaps, logged not fixed (B3/B4 or a later iteration):** (a) the per-repo mutex map in `core/infra/git-store.ts` grows one entry per domain forever — unbounded only in the number of domains, so it is a leak in name more than in fact; (b) there is still a crash window between the store write and the commit — a boot-time reconcile commit (regenerate every domain, commit if the tree moved) closes it and belongs in `instrumentation.ts`; (c) an un-promoted dataset whose slug collides with another's gets the `__<id>` suffix in the model name, which changes its FQN relative to the OS registry's `physicalSlug` — the registry wins today, so that edge is a latent mismatch rather than drift.
#### B2 review round (`feat/engine-rebuild-b2`, second commit) — deviations `B2-review-*`

- **B2-review-H1 Run pods get the netpol label from the RUN LAUNCHER, not the deployment entry.** The finding is real: `os-repos.yaml` opens 9418 only to `component: user-deployments`, which the Dagster subchart stamps on the code-server Deployment's pod template and nowhere else, so launched run pods could not clone their pinned commit. The suggested fix — `pod_template_spec_metadata.labels` on the deployment's `run_k8s_config` — is **not expressible**: the subchart synthesises that block itself (`dagsterUserDeployments.k8sContainerContext`) and emits `pod_template_spec_metadata` only for `annotations`. The label is therefore set once for every run pod at `dagster.runLauncher.config.k8sRunLauncher.runK8sConfig.podTemplateSpecMetadata.labels` (a key the subchart's own schema defines), verified by `helm template`: the instance ConfigMap now carries `run_k8s_config.pod_template_spec_metadata.labels.component: user-deployments`. The netpol is unchanged. Because the Dagster subchart tgz is not vendored in every checkout, the CI-runnable test asserts the VALUES contract instead (`tests/test_os_projects.py::ChartContract` reads `values.yaml` + the netpol template and requires the two to agree) — a `helm template` gate would silently skip wherever the dependency is missing.
- **B2-review-H2 An `accepted_values` entry is refused at the gate, and ONE bad value disqualifies the whole check.** Confirmed end to end. `store.addCheck` now rejects any value that is empty, longer than 200 characters, or carries a quote, backslash, backtick, control character or Jinja delimiter (`isSafeCheckValue`, in `dataset-schema.ts` — the import-light base both halves already share, so the two ends cannot drift). `checkToTest` returns `null` for such a check, which routes it to `meta.os_intentions`. Deliberately NOT "filter the bad values out": emitting the surviving subset would enforce a narrower rule than the author wrote while looking like theirs.
- **B2-review-H3 Two fixes, and B2-1 was wrong.** (1) The `dbt parse` environment is now an explicit allowlist in **one** place: `os_projects.PARSE_ENV_PASSTHROUGH` / `PARSE_ENV_FIXED` / `dbt_parse`, used by the run-pod bootstrap (`ensure_checkout`) AND by `repo-sync.sh`, which shells out to `os_projects.py --parse` instead of keeping its own `env -i` list (a test asserts the script contains no second list). `AGENT_RUNTIME_TOKEN`, `DAGSTER_PG_PASSWORD` and the Kubernetes service env are provably absent. (2) Authored text is made inert by `emit.stripJinja` — applied to dataset names, descriptions, column names/descriptions and intention names — because dbt renders **SQL as well as YAML** through Jinja, so even a `--` header comment was template input. B2-1's claim that "no user-authored byte reaches the tree" is corrected above. Stripping was chosen over `{% raw %}`, which protects neither a quoted YAML scalar nor a SQL comment.
- **B2-review-M1 The repo-sync sidecar cannot be removed from the run config; it self-exits instead.** The finding is right — the subchart derives `run_k8s_config.pod_spec_config.containers` from the SAME `sidecarContainers` key that puts repo-sync on the code-server pod, and there is no way to have one without the other (`helm template` confirms both). Removing `sidecarContainers` would delete the only process that maintains `/repos-checkout/<domain>/current`, which the code location loads from. So: the sidecar reads `POD_NAME` (downward API, added to the chart) and `exit 0`s in a `dagster-run-*` / `dagster-step-*` pod, before anything else. The disabled branch no longer sleeps unconditionally either: with `POD_NAME` set (so provably the code-server pod) it idles as before — a container that exits under `restartPolicy: Always` is restarted forever and eventually backs off, which reads as a broken default install — and with `POD_NAME` unset it exits 0, the safe half of the trade. The lying comment at `values.yaml:786` is replaced with the mechanism. If the guard proves wrong on a cluster, the documented fallback is `includeConfigInLaunchedRuns.enabled: false` plus run-pod `volumes`/`volumeMounts`/env at the run-launcher level (`docs/components/dagster.md` → "Verify it in a cluster", step 5).
- **B2-review-M2 Collisions are resolved by a deterministic digest; `Definitions` is built with per-domain gating.** `sanitize_all(names)` gives the first claimant in sorted order the plain `sanitize` form and every later collision `<base>_<6 hex of sha256(original)>` — stable, order-independent, and unchanged when an unrelated domain appears. `repo.py` threads that name through the asset group, the `<domain>__all` job, every schedule name AND the `os/schedule` tag (which is how the sensors pause a schedule — they must agree). `partition_definitions` (pure, in `os_projects.py`, so it is unit-tested without Dagster) builds the whole workspace in ONE call on the happy path and only on failure probes domain by domain, skipping and logging the offenders. **Consequence to know:** for a collided domain the OS's own `scheduleNameFor` computes the plain form and so cannot address that domain's schedule — `nextTick` returns not-found and the panel shows no next tick. Degraded for one pathological domain pair, versus the whole code location failing to load; the OS cannot compute the digest because it does not know the other domains.
- **B2-review-M3 The fail-closed key is `NODE_ENV`, not the profile — the review's suggestion would have been inert.** `runtimeBearerAuthAllowed` (additive in `core/kernel/config.ts`) refuses the bearer when `AGENT_RUNTIME_TOKEN` is unset or still the shipped `dev-only-insecure-agent-runtime-token`, unless `NODE_ENV !== 'production'`. Keying it on `global.profile` / `config.deploymentProfile` as the review proposed would have disabled the guard exactly where it matters: the live deploy runs `OS_PROFILE=local` **with** `NODE_ENV=production` — the same trap `assertNoDevDefaultSecretsInProd` documents. `runtimeTokenOk` itself is untouched: five other routes share it, two of them writes outside this phase's scope, so the gate is tightened in `/api/data/projects`, where the un-narrowed cross-domain read lives. A request carrying an `Authorization` header gets an explicit 401; a signed-in user is still served, narrowed to their domains.
- **B2-review-M4 Per-dataset tag query, plus a tri-state, not either/or.** `latestSyncSignals` now issues one `runsForDataset(id, 1)` per dataset (six concurrent) instead of `recentOsRuns(200)` with an empty filter: Dagster's `RunsFilter` has no OR-over-tags, so there is no single query that answers the question honestly. An empty result therefore now genuinely means "never synced". `SyncSignal` additionally gained `unknown?: boolean`, set ONLY when that dataset's read failed, so a surface can distinguish "never" from "could not find out"; it is optional, so no consumer had to change.
- **B2-review-M5 `source` is surfaced in both payloads and as a badge in both tabs.** `DqRunRecord.source` now reaches `/api/monitoring/data-quality` (`DqDatasetInput.latest.source` → `DqRiskRow.source`) and the Monitoring dataset detail; the dataset DQ route already returned the whole record. The wording is one pure function, `dqSourceLabel` in `tabs/data/lib/dq.ts` (tested): `dagster` → "dbt test", `os` → "OS probe", absent → **null**, so a pre-B2 record claims nothing. `DataBuilder.tsx` renders it next to the last-run time; `tabs/monitoring/ui/DetailView.tsx` renders a `sourceLabel` the `.ts` payload computed, because a tab's UI may not import another tab. Re-exported through `dq-status-server.ts` so Monitoring needed no second cross-tab import (the TAB-ISOLATION count stays at 421, one below baseline).
- **B2-review-M6 (a) and (c) are recorded, (b) is restored.** (b) `latestSyncSignals` with the flag OFF is `startedAt` again, byte for byte the pre-B2 ledger payload; B2-8's "when the run ENDED" reading now applies only to the Dagster path, where it was the point. (a) `pipeline-health.ts` stays flag-irrespective and on the typed client: the pre-B2 document asked for `pipelineName`, deprecated in the pinned Dagster, so it was not a working fallback worth preserving. The UNTAGGED title shape is identical (`<job> — Dagster run`), and that is every row an install without `DATA_PROJECT_GIT` can produce, since the `os/*` tags only exist once the `sovereign` location runs; `STARTING`/`CANCELING` joined the amber set because the old mapping dropped two plainly-in-flight statuses into `unknown`. (c) `triggerDagster` is accepted as a flag-irrespective no-op: the job it claimed to launch never existed in EITHER flag state (the old code read `live` off an HTTP 200 whose body was a GraphQL error), so restoring the flag-off behaviour would restore a lie.
- **B2-review-L1/L2/L3/L7** L1: `safe_timezone` validates the repo's `timezone` against `zoneinfo.available_timezones()` and falls back to UTC **with a log** rather than letting one bad repo raise inside `ScheduleDefinition` and take the location down; the schedule description names the zone it actually uses. L2: documented in `docs/components/dagster.md` → "Known limits" and in `repo.py` — `DagsterInstance.stop_schedule` needs the origin + selector ids that only a stored instigator state carries, and there is no name-addressed API, so a never-ticked schedule pauses on its first tick, not before. L3: `os_quarantine` now queries `RunsFilter(statuses=TERMINAL_STATUSES)` so the window really is "10 consecutive FAILUREs among terminal runs" — an in-flight run used to truncate the count and leave a dead schedule firing. L7: the type declaration wedged between `dq-status-server.ts`'s imports moved below them, `triggerDagster` returns `boolean` rather than the literal `false`, and `ensure_checkout`'s unused `env` parameter is now the ambient environment `parse_env` filters.
- **B2-review-L6 One Secret, one template, every consumer.** `agent-runtime-token` moved out of `agent-runtime.yaml` (where it rendered only under `agentRuntime.enabled`) into its own `templates/base/agent-runtime/agent-runtime-token.yaml`, rendered when `agentRuntime` **or** `dagster` **or** `osUI.dataProjectGit` **or** `osUI` is enabled, on the local profile only (ESO delivers it elsewhere). One name, one definition — `helm template` confirms exactly one Secret in all of: flag off, flag on, `agentRuntime.enabled=false`, `dagster.enabled=false`. A5 can now delete the agent runtime without breaking Dagster.
- **B2-review follow-ups (NOT fixed, they need the live cluster):** the Dagster 1.13 GraphQL field names the client sends (`assetChecksOrError` as a root field, `Schedule.futureTicks`, `ExecutionParams.selector.assetSelection`), whether a `dagster-k8s/config` run tag MERGES with or REPLACES the code location's container context, and whether a `Definitions`-based location really reports the repository name `__repository__`. Each now has an exact command in `docs/components/dagster.md` → "Verify it in a cluster", alongside the run-pod label (H1) and run-pod sidecar-exit (M1) checks. Also recorded there as known limits: the never-ticked schedule (L2), cold-start cost linear in the number of domains (L4 — fix with per-schedule commit pinning), and the status server binding `0.0.0.0` rather than the pod IP (L5).
- **What the review got wrong or incomplete:** M3's "unless `global.profile`/`config.profile` is local" would have made the guard inert on the live deploy (see B2-review-M3). H1's `pod_template_spec_metadata` on the deployment entry is not a key the Dagster subchart accepts (B2-review-H1). M1's "remove `containers` from the run config" cannot be done without also removing the sidecar from the code-server pod (B2-review-M1). And H3's scope was larger than stated: the Jinja sink is not only `schema.ts` descriptions but model-SQL header comments and `sources.yml` descriptions in `models.ts` too.

#### B3 deviations (`feat/engine-rebuild-b2`, third commit)

- **B3-1 The rules file is generated by BOTH the chart and the OS, deliberately — bootstrap vs
  reconciled.** The brief offered "a ConfigMap reconciled by the OS on membership change is
  acceptable; a static template with a clear TODO if not". Neither alone works: a static template
  cannot know who is in which domain, and an OS-only ConfigMap would not exist on a fresh install,
  so Trino would fail to start on a missing `security.config-file`. So the chart renders a
  BOOTSTRAP (impersonation bounded by the id SHAPE, ownership left exactly as it is without the
  file) and `trino-rules-server.ts` overwrites the same key with the enumerated form at boot. The
  duplication is held down by a test that feeds the chart's own values through the TS generator with
  nothing enumerated and asserts the two documents are equal, so the Helm block cannot drift.
- **B3-2 Trino does not authenticate clients, so the impersonation rules have nothing to match
  yet.** This is the most important thing B3 learned and the concept did not say. `dbt-trino`'s
  `impersonation_user` works by connecting as the authenticated principal and setting a DIFFERENT
  session user; Trino's `impersonation` rules compare `original_user` (authenticated) with
  `new_user` (the session user). The chart sets no `http-server.authentication.type`, so there is no
  authenticated principal at all and the session user is simply asserted. The rules are therefore
  deployed, tested and correct, and the impersonation section is inert until authentication is
  enabled — which needs `http-server.authentication.type=PASSWORD` (or JWT/OAuth2), a credential for
  `dbt-runner` and for the OS query path, `TRINO_PASSWORD` in the run pod and query-tool, and
  `allow-insecure-over-http` or TLS. That is a new secret and a deploy decision, so it is written
  into `docs/components/trino.md` rather than invented here. The **schema-ownership** half of the
  file bites immediately, because it matches on the session user.
- **B3-3 The ownership catch-all is OPEN when nothing is enumerated.** `buildTrinoRules` emits
  `{"owner": true}` / full privileges as the final rule while `domains` and `personalLanes` are both
  empty, and closes it the moment either is non-empty. An empty enumeration means "the OS has not
  spoken yet", not "nobody owns anything"; closing it would deny every CTAS the OS already performs
  as the domain principal on a fresh install. Tested in both directions.
- **B3-4 `<domain>_silver` / `<domain>_gold` schemas do not exist.** The brief asked for ownership of
  "a domain's `<domain>_silver/_gold` schemas". The code has never had those: `store-fqn.ts` gives
  `personal_<sanitizeIdent(uid)>` and `sanitizeIdent(domain)`, and the LAYER is a table prefix
  (`silver_orders`, `gold_order_customer`). Ownership is therefore expressed on the real schemas —
  the domain schema for the domain and its members, `personal_<uid>` for its one owner.
- **B3-5 Lineage reads Dagster's asset graph, not `manifest.json` on disk.** The brief allowed
  either. `target/manifest.json` lives in the Dagster pod's `/repos-checkout` emptyDir, which os-ui
  cannot mount, and the repo-sync status port has no Service — so the only reachable copy of the
  manifest's edges is `assetNodes { assetKey dependencyKeys }`, which dagster-dbt derives from
  `parent_map`. `assetNodesFromManifest` (pure) encodes that equivalence and is what the tests feed
  in, so a manifest fixture is a faithful stand-in and the path is also ready if os-ui ever gets the
  file.
- **B3-6 Column-level lineage: follow-up, as the brief allowed.** dbt Core's manifest carries no
  column-level edges; per-node `columns` stay the OS's documented columns. Recorded here rather than
  approximated from the SQL.
- **B3-7 The parity harness is a TRANSLATION gate, not a row gate — and says so.** Because a model
  body IS the CTAS the OS recorded, rewritten (deviation B1-2), an offline test cannot be an
  independent recompilation. What it does prove: resolving `ref()`/`source()` back to FQNs yields
  the same projection (expression AND alias, in order), FROM/JOIN sequence, ON predicates, WHERE
  conjuncts and GROUP BY — so any future change to the rewriter, the CTAS stripper or the lane/FQN
  mapping fails here. The negative control drifts ONE side (a join type, a dropped column, an
  unresolvable `ref`) and asserts each is reported. Shape equality, not byte equality, is the
  contract: `WHERE` order is semantically irrelevant, and byte equality is already asserted by the
  generator goldens.
- **B3-8 The collided-domain schedule name is fixed by a shared ALGORITHM, not by `status.json`.**
  The brief proposed writing the sanitized name into `status.json` and reading it back. Rejected:
  nothing in os-ui reads `status.json` today, no Service exposes the port, and adding a network
  dependency to compute a NAME is heavier than the problem. `sanitizeAll` in `core/infra/dagster.ts`
  is a transcription of `sanitize_all`, and both languages assert the SAME golden file — which is a
  stronger guarantee than a round trip through a sidecar, and it runs in CI. `scheduleNameFor` takes
  the domain list (from the repos on disk) and degrades to the plain form without it.
- **B3-9 `freshness_minutes` is two schedule intervals, and absent when the cron is unfamiliar.**
  The concept said "a `FreshnessPolicy` where the OS has a sync interval" without a number. One
  missed tick is normal jitter; two is late. `cronIntervalMinutes` handles exactly the shapes the
  OS's own schedule picker produces (`*/n * * * *`, hourly, `*/n` hours, daily, weekly) and returns
  null for anything richer, which makes no freshness claim at all rather than a wrong one. Dagster's
  `build_last_update_freshness_checks` is called inside a `try` so a freshness-API shift logs and
  drops the CHECK, never the asset.
- **B3-10 The observation probe lives in `repo.py` but its SQL and validation live in
  `os_projects.py`.** Same split as B2-4 (Dagster is not installable in this worktree): `observe_sql`
  and `parse_source_assets` are pure and unit-tested, including that an identifier which is not
  `^[A-Za-z_][A-Za-z0-9_$]{0,127}$` DROPS the entry rather than being quoted and hoped for. `repo.py`
  carries only the Dagster decorator and the `trino.dbapi` connection, both covered by `py_compile`
  and the first deploy.
- **B3-11 No deletion in B3.** The phase's gate line ends "then delete the old path", and the brief
  did not ask for deletions. The row-set parity run needs a cluster, so deleting query-tool
  `/execute`, `execute_guard.py`, `sync-sql.ts`'s executor use, `sync-run-server.ts`, `sync-runs.ts`,
  `dq-run*.ts`, `dq-results.ts`, `auto-pipeline.ts` and the dbt demo project would be deleting a
  working path on the strength of an offline test. They stay for B4, after the kind parity run.
- **B3-12 What still needs the live cluster (B3's own list):** that `access-control.config-files`
  with a `file` controller beside the OPA plugin loads (field name and chaining taken from Trino
  476's documented behaviour, not probed); that a ConfigMap rewrite is picked up within
  `security.refresh-period` without a restart (a directory mount, so it should be); that an
  `@observable_source_asset` whose key equals a dbt source's key is ACCEPTED rather than reported as
  a duplicate definition; that `build_last_update_freshness_checks` exists under that name in the
  pinned Dagster 1.13; that `trino.dbapi` is importable in the run pod (it is dbt-trino's own
  dependency) and that the probe's reads pass OPA as the owner; and everything on B2's list below,
  which B3 did not revisit.

#### B3 review round deviations (`feat/engine-rebuild-b2`, fourth commit)

Every H and M finding of the B3 review is fixed with a test; the three L findings and the
impersonation-reality item are fixed too. Where the fix differs from what the review proposed, the
reason is here.

- **B3-review-H-1 Fixed as written, and the gate is now asserted from rendered YAML.**
  `TRINO_ACCESS_RULES` / `TRINO_DBT_USER` moved out of the `$dpg` block in `_os-ui-env.tpl` and are
  gated on `and .Values.trino.enabled $ac.enabled .Values.trino.opa.enabled` — the FULL `$acOn`
  expression from `trino.yaml`, not just `$ac.enabled`, which is also the L-5 fix (one gate, so
  os-ui can never log "ConfigMap does not exist" on a boot where the file is absent by design).
  `scripts/check-trino-rules-chart.mjs` renders stock, `dataProjectGit=true`,
  `accessControl.enabled=false` and `opa.enabled=false` and asserts `TRINO_ACCESS_RULES` is present
  **iff** the ConfigMap is.
- **B3-review-H-2 The event hook is a KERNEL EVENT BUS, and the chokepoint is `writeThrough`.** New
  `core/kernel/events.ts` (`emitDirectoryChange` / `onDirectoryChange`, synchronous, listener
  failures logged and swallowed). `tabs/admin/lib/users.ts` and `domains.ts` emit from their single
  durable `writeThrough` — which every create / edit / role / domain / archive / restore / verify
  path already goes through — plus `deleteUser`'s mirror delete. That is one line per store instead
  of one per mutator, and a mutator added later gets the event for free. `instrumentation.ts` is the
  only subscriber. The debounce + serialisation live in `startTrinoRulesReconciler`
  (`core/infra/trino-rules-server.ts`) so they are unit-testable with injected timings;
  `core/kernel/events.test.ts` drives the REAL `createUser`/`updateUser`/`archiveUser` and
  `createDomain`/`setArchived` and counts reconciles.
- **B3-review-H-3 Periodic repair, not a second ConfigMap key.** The review offered either. The
  two-key alternative does not work: Trino's `security.config-file` is ONE path, so "read the OS key
  when present" would need a second access-control entry or an init container that merges files, and
  a merge step is a new failure mode between the OS and the engine. A jittered `setInterval`
  (`trino.accessControl.reconcileIntervalMinutes`, default 10) in the same boot block is a GET plus
  a byte compare when nothing drifted, needs no new moving part, and also covers the cases an event
  cannot see at all (a ConfigMap edited by hand, a replica that missed an event). The residual
  window — between a `helm upgrade` and the next pass — is documented in the chart comment and in
  `docs/components/trino.md`.
- **B3-review-H-4 The health row is PURE and lives in `components-extra.ts`; the route assembles the
  `HealthItem`.** `trinoAccessRulesRow({enabled, outcome, now, periodMs})` is a pure mapper in
  `tabs/admin/lib/components-extra.ts` with its own row type — it deliberately does NOT import
  `@tabs/monitoring/lib/types`, because a tab importing another tab would be a new TAB-ISOLATION
  violation. `app/api/platform-admin/components/route.ts` (a route, which already imports both tabs)
  turns the row into the `systemHealth` item. `ReconcileOutcome` gained `code` and `at`;
  `lastReconcileOutcome()` is the process-wide record the row reads. Retry is 3 attempts with
  backoff doubling from 2 s and capped at 30 s, EXCEPT for `no-cluster` and `no-configmap`, which
  are configuration facts rather than blips and are not retried inside the pass.
- **B3-review-H-5 The subchart's `TRINO_USER` is a LITERAL plus an asserted equality, because Helm
  cannot template a subchart's values.** The Dagster code-location env lives under
  `dagster.dagster-user-deployments.deployments[0].env` in `values.yaml`, which is data passed to a
  dependency chart — there is no template to interpolate `.Values.trino.accessControl.serviceUser`
  into. So the literal is corrected to `dbt-runner` and `check-trino-rules-chart.mjs` parses
  `values.yaml` and fails on any future divergence. The review's "or a helm-template assertion in a
  script under `scripts/` that gate.sh runs" is what shipped, with the skip condition "helm missing
  OR no subchart .tgz" as asked.
- **B3-review-H-6 Fixed as written. The Secrets grant is back on `externalConnectorsEnabled` alone**
  and the reconciler has its own `resourceNames: ["trino-access-rules"]` rule with `get,patch` only
  — no `list`, no `create`. Note the consequence, which the review did not call out: an install with
  `dataProjectGit.enabled=true` and external connectors off now has NO ConfigMap/Secret write at all
  beyond that one named ConfigMap. Nothing in the data-project path needed it (the mirror config
  lives in OpenSearch), and `helm template` confirms the rendered Role carries no `secrets`
  resource in every value set the check renders.
- **B3-review-M-1/M-2 Fixed as written**, with the fallback path's own label asserted
  (`lineageFor(...).source === 'registry'`), and `UnifiedLineage.source` added as an OPTIONAL field
  so no existing MCP consumer breaks.
- **B3-review-M-3 One observation job per (domain, CRON), not one per domain.** A domain's sources
  do not share a cron — the generator derives each from its own sync's schedule — and a single
  per-domain job would have to pick one, either over-probing the slow sources or under-probing the
  fast ones. Grouping by cron keeps "at the source's own cron" literally true. Names are
  `<domain>__observe_<sha6(cron)>` so adding or removing a source never renames an existing
  schedule. `os/principal` and `OS_PRINCIPAL` are set only when the group shares one principal, and
  only such a group is registered with the inactive-principal sensor — otherwise one deactivated
  owner would pause other people's observations.
- **B3-review-M-4 `enabled: false` drops the SCHEDULE, not the asset.** Removing the asset would
  remove the node the silver model depends on, so the lineage view would lose the external source
  the moment a sync is paused — a worse answer than a node nobody probes. The asset and its
  freshness check stay; `observe_crons` filters disabled entries out of the scheduled groups.
- **B3-review-M-5 Fixed as written**, with the reason recorded in the code: `request_timeout` alone
  bounds one HTTP poll, and only `query_max_run_time` makes TRINO abandon the query.
  `OS_OBSERVE_TIMEOUT_SECONDS`, default 60.
- **B3-review-M-6 Two changes, because resolving refs from the CTAS is not enough on its own.**
  `refs` now resolves from each model's own recorded CTAS TARGET (`ctasTarget`), falling back to the
  plan only where the OS compiled nothing. But a wrong lane mapping does not survive as a wrong
  `ref()`: `rewriteFqns` keys its model lookup on the FQN as it appears in the CTAS, so the lookup
  MISSES and the model is emitted as an external `{{ source(...) }}` — which the plan's own source
  map then resolves straight back, which is why it passed. The discriminating assertion is therefore
  `sourceRefConflicts`: a relation that is one of this project's model targets must be reached with
  `ref()`, never `source()`. The test drives the worked example with the Orders dataset re-owned
  (plan schema `personal_zed`, recorded CTAS `personal_amir`) and asserts it FAILS, and that the
  correct mapping still passes. The header's "one source of truth, both directions" claim is
  replaced by what is actually true.
- **B3-review-M-7 Fixed as written**, plus `core/kernel/events.test.ts` and
  `tabs/admin/lib/components-extra.test.ts`, plus `check-trino-rules-chart.mjs`.
- **B3-review-M-8 Order AND an explicit close, because order alone does not fix it.** Emitting the
  personal-lane rules first is necessary but insufficient: the lane's `schemas` entry is
  `{user: ^amir$, schema: ^personal_amir$, owner: true}`, so a DIFFERENT user falls through it to
  the next matching rule — which, for a domain whose sanitized schema is also `personal_amir`, was
  the domain's owner rule. So each lane now also emits `{schema: ^personal_amir$, owner: false}`
  immediately after its owner rule, exactly mirroring the empty-privileges fallthrough the `tables`
  list already had. The golden file was regenerated. (The review's alternative — excluding domains
  matching `^personal_` — would have left the domain silently un-ownable instead, which is a
  different bug.)
- **B3-review-L-1 Fixed as written** (`^(?:…)$` in the evaluator, including the `original_user`
  exec), with a test that an unanchored fragment no longer matches a longer value.
- **B3-review-L-2 Validated against the PRINCIPAL pattern, not `_IDENT_RE`.** The review said "the
  identifier regex". That would be wrong: `_IDENT_RE` is `^[A-Za-z_][A-Za-z0-9_$]{0,127}$` and a
  principal legitimately contains `-` and `.` (`sales-eu`), so it would drop real datasets and real
  schedules. What the check is for is that the principal becomes a Trino session user and an
  `OS_PRINCIPAL` env value, so it must carry no whitespace, newline or quote — which is exactly
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, the same `OS_PRINCIPAL_PATTERN` the generated `rules.json`
  enforces on the other side. Applied to `parse_source_assets` AND `parse_schedules`.
- **B3-review-L-3/L-4 Fixed as written.** `_wire_project` lost the shadowed `pinned_env` parameter
  (and `build_definitions` lost the now-consumerless `osp.pinned_env(projects)` call);
  `repo-sync.sh` neutralises the shipped placeholder immediately after reading it, so one rule
  governs both the log line and the server.
- **Impersonation reality — fixed as written, and the pre-existing limit is now stated.**
  `profiles.yml` emits `password: "{{ env_var('TRINO_PASSWORD', '') }}"` inside
  `{% if env_var('TRINO_AUTH_METHOD', 'none') != 'none' %}` (dbt renders `profiles.yml` through
  Jinja before parsing the YAML, so the key is genuinely absent under `method: none`, which
  `TrinoNoneCredentials` requires). Spliced textually after the `user:` line at its own indentation,
  because the YAML emitter cannot express a conditional key. `docs/components/trino.md` gains
  "Enable real impersonation" as a six-step numbered procedure marked a deploy decision, and a
  "Known limits" section stating plainly that `readPrincipalFor` maps a governed read to the
  caller's FIRST DOMAIN, not to the person (and that the write path has the same shape) — recorded
  as a **follow-up**, since fixing it needs per-user grants in `trino.rego` and a per-user Trino
  credential, i.e. the same deploy decision.
- **What the B3 review got wrong or incomplete:** L-2's "identifier regex" would have dropped valid
  principals (above). M-8's ordering fix alone does not close the hole — an explicit per-lane
  `owner: false` rule is required. M-6's "resolve refs from the recorded CTAS's own FQNs" alone does
  not make a wrong lane mapping fail, because the mapping error turns a `ref()` into a `source()`
  that round-trips; the source/ref conflict check is what actually discriminates. H-5's "template
  the Dagster env block" is not possible for a subchart's values. And every line number in the
  review's H-2 (`unified.ts:111-115`, `lineage.ts:51-52` partly), M-1 and M-2 citations is off by
  enough to matter — the findings themselves were real and were located by reading the code.
- **Still needs the live cluster (unchanged from B3-12), plus:** that a `resourceNames`-scoped
  ConfigMap Role really permits the reconciler's GET + PATCH (strategic-merge PATCH on a named
  resource; no `list` is used); that `observable_source_asset`s inside a `define_asset_job` are
  materialisable as OBSERVATIONS by a schedule in Dagster 1.13; and that `trino.dbapi.connect`
  accepts `request_timeout` and `session_properties` in the pinned client version.

#### B4 deviations (`feat/engine-rebuild-b2`, fifth–seventh commits)

- **B4-1 The four engineer-NAMED MCP tools were not added, deliberately.** The outline asked for
  `dbt_run`, `dbt_test`, `dagster_materialize`, `get_dagster_run`. The owner's B4 brief replaced that
  line with "MCP = UI for every data mutation" (X8) + the dispatcher contract (X7), which is what
  landed — and the named tools are the wrong shape for this OS anyway: they address **asset keys and
  select strings**, not objects, so a caller could materialise or test an asset without passing
  through the `canView`/`canEdit` guard on a dataset id. Every operation they name is already
  reachable object-addressed: `transform_silver` / `build_gold_join` / `sync_dataset_now` commit and
  then launch `dbt build --select` for exactly that dataset's assets (that IS `dbt_run` +
  `dagster_materialize`), `run_quality_checks` runs the rules and the DQ surfaces read the dbt tests
  back as asset checks (`dbt_test`), and `get_lineage` reads the dbt graph. **The real gap is one
  READ:** there is no `get_dagster_run {runId}` — `get_sync_status(datasetId)` is the only way to see
  a run, so an MCP client that launched a build cannot poll that run id. Recorded as a follow-up with
  its gate: resolve the run's `os/dataset` tag → `getDataset` (canView) → return the run; refuse a
  run with no OS tags. Checklist D17 is scored accordingly, not ticked.
- **B4-2 The parity test compares the MCP handler with the SERVICE, not with a route.** A test may
  not import a `route.ts` (CONTRIBUTING), so the route's half of the comparison is the service
  function it calls. That is only honest because the routes were REDUCED to shells in the same
  commit — each is now `service(...)` plus `NextResponse.json(...)`, visible in a 40-line file. If a
  route ever grows logic again, the parity test stops proving what it claims; the cheap guard
  (asserted nowhere yet, recorded) would be a line-count or an import ratchet on
  `app/api/data/datasets/**`.
- **B4-3 Three divergences the harness found were real bugs, fixed here.** (a) MCP `build_gold_join`
  resolved a join partner with `assetTarget(up)` while the route used `reuseSourceFqn(up)` — the
  owner-aware resolver — so joining a personal-lane partner through the MCP compiled a read of the
  wrong schema. (b) MCP `transform_silver` never refreshed the governed domain copy of a promoted
  dataset, so a rebuild through the MCP left dashboards on the prior snapshot with no "stale"
  report. (c) MCP `run_quality_checks` called `runQualityChecks` (rules only, nothing persisted)
  while the button called `runAndRecord` (rules + the three default-on monitors, persisted). All
  three now run one code path; the existing MCP test that asserted 3 results was updated to 6 with
  the reason in the test.
- **B4-4 Two UI-door behaviour changes, deliberate, because parity means the stricter door wins.**
  (a) The sync PUT route now enforces the per-source mode/cursor LOCKS (Kafka append-only, Salesforce
  / Kajabi cursor rules) that only the MCP tool enforced, at config time. (b) It refuses a connection
  the caller cannot read: the platform resolver's 403/404 is no longer swallowed (`.catch(() => null)`
  would have let a sync be attached to an invisible connection through the UI door). Conversely the
  MCP's own stricter rule — "at least one pick" for `build_gold_join` — was DROPPED, because zero
  picks is a legal single-table projection in the route and the rule fired before the dataset guard.
- **B4-5 The ambient test seams are the honest price of fire-and-forget.** `launchDatasetBuild` and
  the services are called by both doors with no injection, so observing them identically needed one
  module-level seam each (`__setLaunchDepsForTests` + `awaitDataProjectLaunches` in `dbt/launch.ts`,
  `__setMutationDepsForTests` in `mutations-server.ts`). They follow the codebase's existing
  `__setDataProjectGitForTests` / `__setRunOsTeamForTests` pattern, are never set in production, and
  are what let the parity test use the REAL commit path rather than a re-implementation.
- **B4-6 `/execute` is NOT deleted, and the brief's condition was the wrong test.** The brief said to
  keep it "ONLY if `query_data`/preview still go through it" — they do not (reads go through
  `/query`). But `/execute` carries five other live paths: `apply_quality_fixes`'s whitelisted MERGE,
  `physical-delete`, the warehouse import, the promote/publish CTAS and the domain-table
  re-materialise. Deleting it would break all five. Kept, documented in `docs/components/trino.md`.
- **B4-7 The TypeScript CTAS build path for silver/gold is NOT deleted either — this is the one
  place B4 refuses its own brief.** The honesty gate registers a version only after a real
  apply+verify of the physical target. With the CTAS gone, a Silver build would have to wait on a
  Dagster run AND its asset check before it could register anything, or register optimistically —
  the first is a redesign of the gate whose correctness cannot be shown offline, the second is
  exactly the stale-"built" bug the gate exists to prevent. B3-11 had already refused to delete this
  path on the strength of an offline test, and nothing in B4 changed that evidence: the row-set
  parity run in kind (checklist D15) is its gate. Recorded as the next data deletion.
- **B4-8 The flag-off opt-out LOST scheduling, and says so.** Deleting the CronJob provisioning means
  `enabled: false` no longer schedules anything; the saved config waits for a manual "Sync now".
  `reconcileSyncSchedule` returns that sentence in the outcome the panel already renders rather than
  implying a trigger exists, and it carries an unreachable API server into the detail so "no
  CronJob" can never mean "nobody could check". The opt-out still covers the OS's CTAS execution,
  the ledger reads and the OS DQ probe. Recorded as the honest answer to the brief's "say so
  honestly and drop the opt-out instead": the SCHEDULING half is dropped, the EXECUTION half stays.
- **B4-9 The DQ failure e-mail has no sender any more.** — **CLOSED by B4-review L-2:**
  `dq-status-server.ts` `alertOnNewFailure` is the sender, driven by the Dagster asset-check
  read-back and suppressed by a durable per-dataset record keyed on the check execution's `ranAt`.
  The original text follows. `/api/data/dq/run-all` was the only caller
  of `deliverDqAlert`, and quality rules now run inside Dagster. Nobody is notified on a new
  failure; the Dagster failure sensor only quarantines after the threshold. Both building blocks
  (`isNewFailure`, `deliverDqAlert`) are kept and tested, and the follow-up is written down: alert
  from the asset-check read-back plus a persisted last-alerted badge. This is a real regression of
  the flag-on default and is in the CHANGELOG as one.
- **B4-10 `REPO_SYNC_ENABLED` exists twice and only one copy mattered.** The deployment's `env` list
  is the user-code container's; the sidecar that runs `repo-sync.sh` carries its OWN env under
  `sidecarContainers`. Flipping only the first would have left the flag "on" with no sidecar syncing
  anything — which is exactly how the whole path fails silently. Both are now `"true"`, and the
  rendered manifest was checked for all four occurrences (two plain, two inside the run-launcher's
  JSON).
- **B4-11 The 404-for-an-invisible-object reading is not what the store does, and B4 did not change
  it.** The brief asked for "foreign/invisible dataset → 404-semantics". `store.getDataset` answers
  **403** for an existing dataset the caller may not view and 404 only for one that does not exist.
  Both doors agree (the parity test asserts the identical code AND message, and that a missing id is
  404/`not_found` on both), but the no-existence-leak reading would mean changing `getDataset` for
  every surface in the OS — a cross-cutting change with its own test fallout, outside this phase.
  Recorded as a follow-up.
- **B4-12 Two new tests moved out of `core/mcp/` into `tabs/data/lib/`.** Written beside the
  dispatcher they tripped CORE-INDEPENDENCE (+3: a test under `core/` importing `@tabs/data/...`).
  In the Data tab they import only `@core/*` and their own tab, so the counts went the other way:
  **CORE-INDEPENDENCE 207 → 200**, because extracting the service also removed six `@tabs/data/...`
  imports from `core/mcp/experimental/data-write-tools.ts`. The baseline is left for the coordinator
  to lock after the merge (B2-9's convention).
- **B4-13 A bronze-only dataset contributes no file to its project.** Found while testing the boot
  reconcile: a raw Bronze landing is neither a dbt model nor a source (only a FEDERATED sync source
  is), so a domain of bronze-only datasets commits `dbt_project.yml`, `profiles.yml`, the macros and
  the generic tests — and nothing per dataset. "Every existing dataset gets its initial commit" is
  therefore true of the project, not of a file per dataset; the CHANGELOG says so.
- **B4-14 The checklist's shape differs between this branch and `main`.** `main` (the A5 agent) added
  a `Status (end of A5)` COLUMN plus rows X7/X8/X9; this worktree's copy carries the B2/B3 statuses
  INLINE in the Test column. B4 followed the local convention and appended X7/X8/X9 with the same
  wording as `main` so the rows line up; the coordinator resolves one table shape at merge.
- **B4-15 What proved wrong in the plan/concept, beyond B4-1 and B4-6:** the concept's B2 line
  "**Delete:** … `sync-next-run.ts`" — it is a pure, CLIENT-safe cron estimator the SyncPanel renders
  and `sync-status-server` falls back to, not an execution path, so it stays. And the concept's B4
  line "Old names become aliases for one release, then go" presumes the new names of B4-1, which
  were not added; nothing was aliased or renamed, so no deprecation window is open.

- **B2-11 What still needs the live cluster:** that a scheduled sync materialises in kind under the owner principal (D7, D10); that `dagster-k8s/config` really propagates `OS_PRINCIPAL` / `OS_PINNED_COMMITS` into run pods; that the subchart honours `sidecarContainers` / `volumes` / `volumeMounts` and an `env` entry with `valueFrom`; that `reloadRepositoryLocation` succeeds against the webserver Service; that the webserver's GraphQL schema matches the documents in `core/infra/dagster.ts` (field names were taken from Dagster 1.13's schema, not probed); and that `Definitions`-based locations really report the repository name `__repository__`.


#### Part D deviations (agents half, five commits on `feat/engine-rebuild`) — `D-n`

- **D-1 One repository, two OWNED SUBTREES — and the git store learned the concept.** `commitTree`
  writes the whole desired tree, so the data generator's next commit would have DELETED
  `agents/**`, and an agents generator written the same way would have deleted the dbt project.
  Rather than teach either generator about the other (they are in different tabs and may not
  import each other), `core/infra/git-store.ts` gained two generic primitives: `commitSubtree`
  (replace exactly one path prefix, keep every other path at its current blob — so an EMPTY file
  map is how a deletion is recorded) and `reserveSubtree(prefix)` (a whole-tree writer keeps paths
  under a declared prefix that its own map does not mention). The registry holds path prefixes and
  nothing else, so the store still knows nothing about datasets or systems. The reservation is
  deliberately NOT implicit: without it, `commitTree` behaves exactly as before, which is what the
  B1 tests assert.
- **D-2 ONE switch, keeping its historical name.** `DATA_PROJECT_GIT` gates both halves. The
  repository, the `os-repos` PVC and the read-only `git daemon` sidecar it provisions are shared,
  so a second flag could only ever disagree with itself (git on for agents, off for data = an
  `agents/` subtree in a repo nothing else maintains). Renaming the variable would touch
  `tabs/data/**`, the chart and four docs for no behaviour change; it is a follow-up, recorded
  here so nobody mistakes the name for a scope.
- **D-3 PERSONAL systems live in the DOMAIN repo, in the owner's lane — mirroring B1.** The brief
  allowed "the user's personal repo if B1 has that concept". It does not: B1 puts an un-promoted
  dataset in the domain repo under `models/personal/<uid>/` with `+schema: personal_<uid>`, and
  documents (`tabs/data/README.md` → "Who can read what") that every domain member can therefore
  read every member's dataset DEFINITIONS while the DATA stays governed. The agents half mirrors
  that decision exactly — `agents/personal/<uid>/<slug>/` — so one repository keeps one
  convention and the read gate stays one gate. The same caveat applies and is now stated in
  `tabs/agents/README.md`: a Personal system's definition (its prompts and its grant NAMES, never
  a credential) is readable by the domain, which is wider than the Agents tab's own listing.
- **D-4 The slug follows the display name; the ID is the identity.** A directory is
  `<slug(name)>`, so a rename MOVES the directory and a promotion moves it out of the personal
  lane — which is what an engineer reading the tree expects, and what makes the path meaningful.
  Identity is carried by `agents/index.yml` (slug → id, owner, scope, version) and by the
  `OS-Object: <id> (<name>)` trailer, which is also what `systemGitInfo` filters on — so a
  rename, a lane move and even a delete stay in ONE history. Collisions are resolved
  deterministically in id order (`<slug>-<id suffix>` for the later claimant), and a domain-scope
  system that would slug to `personal` is disambiguated so it can never shadow the personal lane.
- **D-5 The mirror is ONE config read by two modules, not one module.** The brief said "reuse
  B1's mirror config and credential handling exactly — do not add a second config", and the admin
  write path with its validation (http(s) only, no embedded credentials, egress allowlist, the
  Secret must exist) lives in `tabs/data/lib/dbt/mirror.ts` — which the agents tab may not import
  and which this phase must not edit (Phase B4 is live in that tree). `core/infra/git-mirror.ts`
  therefore reads and writes the SAME record: the same `globalThis` symbol
  (`soa.data.project-mirrors`) and the same durable index (`config.dataProjectMirrorsIndex`), with
  no setter and no second validation of its own. The consequence is two push wrappers over one
  record and one credential path; the health row reads the record's status, so it tells the truth
  about whichever side pushed last. **Follow-up:** collapse `tabs/data/lib/dbt/mirror.ts` onto
  `core/infra/git-mirror.ts` (keeping its setter) once B4 has landed.
- **D-6 `OS-Reason` is additive, not a rename of `OS-Action`.** Part D's prose said "`OS-Actor` +
  `OS-Reason` trailers"; B1 shipped the per-write reason as `OS-Action` and the whole data history
  uses it. Renaming it would have rewritten the convention for every existing commit's reader, so
  `OS-Action` stays the action and `OS-Reason` is added only where the CAUSE differs from the
  action — today exactly one case, `boot-reconcile`.
- **D-7 A BUILD commits; a RUN does not.** `setLastBuild` is a definition-level fact (this
  definition built, or failed to, at this time) and the generated README states it, so a build is
  a commit. Every run writer (`setActivity`, `clearActivity`, `startRunCheckpoint`,
  `checkpointNode`, `setLastRun`, `recordActivity`, `recoverInterrupted`) is
  `writeThrough(rec, null)`: a run's artefacts are the LangGraph checkpoint, the `run_events` rows
  and the Langfuse trace, and committing per node would bury every real change under run noise.
  `setRunning` and `setSchedule` DO commit — enabling or scheduling a system is a configuration
  act an engineer would commit, exactly like a dbt schedule.
- **D-8 A4 (run the export outside the OS) is NOT closed, and `graph.json` is why.** The committed
  IR is the compiled graph in a readable, diff-able form — which is checklist A3's requirement and
  the brief's — but it is not a runnable artefact: executing it still needs `buildGraph`, the
  governed executor and the LiteLLM credential, i.e. this repository. Emitting a standalone
  `graph.ts` + a thin runner is a real piece of work (the node bodies, the hold decision and the
  tool specs all have to be expressible without `@core`), so A4 stays `false` with the exact gap
  named rather than being half-claimed. What IS true today: the whole repository, `agents/**`
  included, is readable and exportable as a tar through the existing project routes.
- **D-9 The MCP surface was fixed in ONE place, for every tool.** B1 wrapped each data MCP tool
  individually (`runWithSurface('mcp:<tool>')`), which left every other tool — including the
  generic `archive` / `delete` / promotion-ladder tools that mutate an agent system — recording the
  default `ui:` surface. `core/mcp/server.ts` now wraps the single `tools/call` dispatch instead,
  so no tool surface can be forgotten; the per-tool wrappers simply nest with the same name.
- **D-10 X9's guardrails are the ENGINE's, and a thrown dispatch is still a crash.** The brief
  asked for a typed `timeout` / `upstream_error` the graph routes on. The deadline produces
  `timeout` as a typed result (there is no exception to propagate and nothing to resume onto).
  A THROW out of the governed executor is deliberately NOT converted: it means the dispatch itself
  broke, and A2's M5 property — the superstep fails, the checkpoint keeps every call that already
  ran, and a resume re-runs exactly the one in flight — is worth more than a readable message that
  invites the model to continue from an unverified state. What the model now gets instead is a
  TYPED `upstream_error` from the executor's own JSON-RPC-error branch (previously the prose
  `Error: <message>`), so an upstream failure is routable on a code.
- **D-11 Follow-up in `tabs/data` (not done here, by instruction).** The real `query_data` handler
  has no row cap, no `LIMIT` injection and no `request_timeout` of its own: it runs the SQL the
  model wrote and returns every row. The engine-side bound and deadline protect the RUN (and every
  other tool), but the Trino query itself still executes in full and the full result still crosses
  the process boundary once. The handler should also (a) bound its own result set, (b) carry a
  statement timeout, and (c) report the true row count beside the truncated rows. That belongs to
  the next iteration in `tabs/data/mcp/data-query-tools.ts` + `core/infra/governed.ts`.
- **D-12 What proved wrong in the plan.** (1) "Layout: `agents/<system>/{system.yaml,graph.ts,
  README.md}`" — `graph.ts` cannot be generated honestly (D-8), so the compiled graph is
  `graph.json`, and each agent's prompt is its own `agents/<id>.md` rather than being buried in
  the yaml only. (2) Part D assumed the agent store could be hooked the way the data store was;
  it could, but only after `writeThrough` was given a required change descriptor — the data side's
  `persist()` + 11 bypassing writers pattern would have left 22 call sites silently deciding by
  omission. (3) The plan's X2 wording ("`kind` with a local bare remote") is not achievable with
  isomorphic-git: it speaks only smart-HTTP, so a local bare repo is not a valid remote. The unit
  half is therefore a FAKE TRANSPORT at the isomorphic-git boundary (which is where the brief
  allowed it), and the `kind` half needs a real git server.

#### Part D review round 3 deviations — `D-review-<id>`

- **D-review-H-1 The hydration gate is on BOTH reconciles, and the destructive guard is ONE
  place.** Two independent defences, because they fail differently. (1) Each store exports
  `hydrationState(): 'hydrated'|'failed'|'pending'`, set from the mirror read's own outcome, and
  both boot reconciles return early (loud `console.error`) unless it says `'hydrated'` — the data
  one's swallowing `catch` around `ensureHydrated()` was never the bug, because `ensureHydrated()`
  does not throw on a down mirror at all; it resolves. (2) The guard lives in
  `core/infra/git-store.ts`, inside both `commitTree` and `commitSubtree`, so neither generator
  can forget it and neither needed to learn about it.
  **The rule, exactly:** a commit carrying `OS-Reason: boot-reconcile` (in `trailers` or already
  in the message) is refused with `DestructiveReconcileError` (status 409, `code:
  'destructive_reconcile'`) when it would delete **more than 50%** of the files already tracked in
  its own scope **AND** adds **no new path** to that scope. Scope = the prefix for
  `commitSubtree`, everything outside the reserved subtrees for `commitTree`. A human-initiated
  commit is never subject to it.
  **Why the second condition** (it is not in the brief, and the brief's rule alone broke a real
  behaviour): a reconcile that replaces one system's files with another's legitimately deletes a
  large share — that is the catch-up the reconcile exists for, and `repo.test.ts` had a test
  proving it. A reconcile that deletes a large share and creates NOTHING is generating from an
  empty registry: every file it still writes is one it already had. That is the outage shape, and
  only that is refused.
  **Known limit, recorded rather than hidden:** the guard measures a SHARE, so a domain whose
  tracked files are mostly fixed skeleton (one dataset: 3 model files against 8 project files) is
  below the threshold by arithmetic and is protected by the hydration gate alone. The more a
  domain has to lose, the more certain the refusal — which is the right way round, but it is not
  "every domain, always".
- **D-review-H-2 The reservation moved to the top of `register()`, and a test pins the literal.**
  `reserveSubtree('agents/')` now runs before any hook, reconcile or kernel init whenever
  `config.dataProjectGit` is on, so no ordering mistake can reopen the hole; the round-2 ordered
  block and its tests stay as defence in depth. `instrumentation.ts` uses the LITERAL `'agents/'`
  rather than importing `AGENTS_PREFIX`, to avoid pulling the Agents tab's module graph into the
  first milliseconds of boot — and `lib/git/commit.test.ts` now asserts the literal is present,
  equals `AGENTS_PREFIX`, and appears before `installDataProjectCommitHook`.
- **D-review-H-3 CHOSE (b): the worker fails closed. The PVC fact decided it.**
  `charts/.../os-ui/os-repos.yaml` declares `accessModes: ["ReadWriteOnce"]`. os-ui and
  `os-ui-worker` are separate Deployments the scheduler may place on different nodes, and an RWO
  volume attaches to one node at a time, so (a) would either fail to start the worker or silently
  pin it to os-ui's node — and two processes writing one bare repo is precisely what the git
  store's IN-PROCESS mutex cannot protect. So the worker does not write repos, and no longer
  pretends to: `worker/agent-runs.ts` calls `markRunWorkerProcess()` at boot
  (`tabs/agents/lib/write-availability.ts`), and the store's `writeThrough(rec, change)` throws
  `SystemWriteUnavailableError` (`code: 'run_worker_write_unavailable'`) for any non-null
  `change`. That chokepoint was chosen because `change !== null` IS the set of writes that must
  become a commit (`commit.test.ts` pins both lists), so the guard covers all 17 without
  enumerating them, and covers none of the 7 run-bookkeeping writes the worker exists to perform.
  **Honest limitation:** the throw happens after the in-memory record was mutated and before the
  durable mirror write and the event, so the worker's own process-local map can hold a value the
  mirror never sees, until its next hydration. Nothing durable, nothing committed and nothing
  mirrored changes, and the caller gets the error — which is the property that matters.
- **D-review-M-1 An opaque owner token, and `OS-Actor` deliberately unchanged.**
  `ownerToken(id) = sha256(id).slice(0,12)` now stands for the owner in `index.yml`, in every
  generated README and as the `agents/personal/<token>/` path segment. `commit.ts`'s `OS-Actor`
  trailer and the git author still carry the principal id and its real e-mail, per the brief: a
  commit is the one artefact where naming the person is the point. The three goldens were
  regenerated; a new test asserts no generated path or index/README content contains an `@` even
  when the owner id IS an address.
- **D-review-M-2 The two-line paragraph D-3 promised is in the README** as "Who can read what",
  with the consequence stated plainly: a Personal system's committed directory reaches every
  domain member (project routes + mirror), so nothing in an instruction file should be a secret.
- **D-review-M-3 `unresolved` is a third state, and the write catalog decides who is protected.**
  `ExecutedSig` gained `unresolved?: boolean`, set when the result's typed code is `timeout`. A
  repeat of an unresolved signature is refused only for a WRITE (`isWriteTool` — the static
  `core/mcp/write-tool-meta` catalog), with `{"error":{"code":"unresolved_previous_call"}}`
  telling the model to verify by reading; a read re-dispatches, because re-reading is how the
  uncertainty should be resolved. The test uses `ingest_dataset`, not the brief's `insert_rows`:
  this OS's write catalog has no `insert_rows` (that is the hosted DM OS MCP's name), and the test
  deliberately uses a REAL catalog entry so the guard cannot be satisfied by a stub.
- **D-review-L-1** `systemGitInfo` returns `truncated`, and resolves the HEAD with one deeper walk
  bounded by the new `MAX_LOG_DEPTH` (2000) — which also raises `log()`'s own clamp from 500, the
  only way a deeper walk was reachable at all.
- **D-review-L-2** `authorFor` keeps only the mailbox token of the id (`amir@acme.com` →
  `amir@os.local`), with everything outside `[A-Za-z0-9._+-]` collapsed to `-` and an empty result
  becoming `unknown`.
- **D-review-L-3 Three parts, and one scope extension.** The redundant per-tool wrapper is gone;
  `server.ts` now passes the ambient request id into its `mcp:<tool>` scope so a nested call keeps
  ONE `OS-Request-Id`; and the run id reaches the commit through the request scope rather than
  through every writer's signature — `RequestSurface` gained an optional `runId`,
  `runWithRunId(runId, fn)` sets it, `grantedToolExecutor` wraps its gate-2 dispatch in it, and
  `commitMessage` emits `OS-Run-Id` from `currentSurface()` (or an explicit input). That last
  choice makes `commitMessage` read ambient state, which is a real cost; it buys the trailer for
  BOTH halves (agents and dbt) in one place instead of editing two commit modules, one of which
  was outside this round's scope. Files touched beyond the stated scope, and why:
  `core/infra/request-surface.ts` (the `runId` field — there is no other ambient carrier),
  `tabs/data/lib/store.ts` (`hydrationState`, required by H-1 for the data reconcile),
  `tabs/agents/lib/build/os-tools.ts` (the run scope), `os-ui/scripts/gate.sh` (added the data
  boot-reconcile test, which now carries H-1 assertions).
- **D-review-L-4** `pushMirror` re-checks `isEgressAllowed(rec.url)` before the push, records the
  refusal on the mirror record (so Platform → Components & Health shows it like any failure), and
  fails CLOSED if the allowlist itself cannot be read.

#### B4 review round deviations — `B4-review-<id>`

- **B4-review-H-1 The stand-down runs for every SYNCED dataset, and its result is reported.**
  `reconcileDataProjectsAtBoot` deletes the pre-B2 CronJob of every dataset with `d.sync` before
  its first commit. Two choices beyond the brief: (a) the per-dataset outcome is returned as
  `cronsStoodDown` on `BootReconcileResult`, not only logged, so the boot log and a future health
  row read the same data; (b) a cron client that THROWS (which `removeSyncCronJob` documents it
  never does) is also caught, because a broken injected client must not be the one thing that
  takes a boot down. The ordering assertion is in the test, not a comment: the index of the first
  `commit:` must be after the last `delete:`.
- **B4-review-H-2 The `batch`/`cronjobs` rule is UNCONDITIONAL, which contradicts the review.** The
  review asked for it gated on `osUI.dataProjectGit.enabled`. That would be wrong:
  `tabs/agents/lib/schedule-cron.ts` creates, updates and deletes one CronJob per scheduled agent
  system through `app/api/agents/systems/[id]/{route,schedule}` and is NOT gated on that flag, so
  an opted-out install would 403 every agent cron save — the exact silent failure H-2 is about.
  The data-sync cleanup needs only `delete`, which is a subset, so one rule serves both and a
  flag-gated second rule would be dead weight. `scripts/check-trino-rules-chart.mjs` therefore
  asserts the rule is present in EVERY render (a fifth case, `dataProjectGit.enabled=false`, was
  added) with `get, create, update, delete` and without `*`/`deletecollection` — i.e. the gate's
  "present iff flag on" wording is deliberately not implemented, and the reason is recorded here.
- **B4-review-H-5 The guard was already in place; what was missing was the ALLOWED case.** Commit
  `72c9ee6f` had already added the `hydrationState()` gate, the `OS-Reason: boot-reconcile`
  destructive-delta guard and two tests for the refusal paths (an empty registry over a repo whose
  models are the bulk of the tree, and `hydration` ∈ {`failed`,`pending`} examining nothing). The
  line-161 "the repository is emptied" test was still asserting through an injected committer that
  an emptying reconcile COMMITS, which is true but proves nothing about the guard, so it was
  renamed to what it actually pins (discovery is the UNION) and a new real-repository test covers
  the guard's second condition: a hydrated registry with zero datasets over a legacy repo of
  hand-written models IS allowed to empty it, because the skeleton it writes adds paths the repo
  did not have. Nothing in the guard itself was changed.
- **B4-review-H-3 The wording moved into a `.ts` module, and the pickers learn the truth from the
  read-back.** `tabs/data/lib/sync-schedule-view.ts` (pure, client-safe) holds
  `saveScheduleMessage`, `schedulingDisabled` and `SCHEDULING_OFF_NOTE`; `SyncPanel` renders them.
  The panel learns the state from `source: 'ledger' | 'dagster'`, which `syncStatusFor` already
  returned — no new endpoint. `AdoptConnectionPanel` offers a cadence BEFORE the dataset exists and
  so has no status to read, so `GET /api/data/exposed-tables` answers `scheduling: 'dagster'|'off'`
  (one boolean of server state, not a capability endpoint of its own).
- **B4-review-H-4 / L-11 The code default moved to `true`, not the chart to `false`.** As the review
  preferred: `config.dataProjectGit` is `env('DATA_PROJECT_GIT', 'true') !== 'false'`, so `npm run
  dev` and the chart agree. Two test files that were silently relying on the old default now pin
  the opt-out explicitly (`core/mcp/sync-tools.test.ts` — it tests the ledger world on purpose).
  The flag was NOT split: splitting it would mean a half-committed repository, which is worse than
  one switch.
- **B4-review-M-2 `domainTable: 'refreshed'` is reachable offline, so it is asserted literally.**
  The rebuild of a promoted dataset runs through `rematerializeDomainTableLive`, which in the test
  environment takes the `offline-mock` apply path and reports `refreshed` — so the pinned assertion
  is the brief's, not a weakened "both doors agree". The gold-join half asserts the compiled SQL
  contains `iceberg.personal_amir.silver_customers` and does NOT contain the domain-schema form, so
  a regression that breaks both doors identically still fails.
- **B4-review-M-5 `create_dataset` takes no `connectionId`, so the foreign-connection case moved to
  the tool that does.** The review asked for `create_dataset` with a foreign `connectionId`;
  `create_dataset`'s schema is `{name, domain, columns}` and an extra argument is ignored, so there
  is no such door to test. The tool that names a connection is `set_dataset_sync` (B4-4 made it
  refuse one the caller cannot read instead of swallowing the resolver's 403), and that is what the
  new case drives — refused, nothing committed, nothing in the store. The per-tool code assertions
  and the flag-ON run landed as asked.
- **B4-review-M-8 A NEW row, not a changed `gitMirrorRow`.** The review pointed at
  `components-extra.ts:175`, which is `gitMirrorRow` — the MIRROR's row, whose absence when no
  mirror is configured is correct. The missing signal is the FEATURE's, so
  `dataProductsGitRow({enabled})` was added beside it and wired into
  `app/api/platform-admin/components/route.ts`: `data-products-git`, green when on, amber with
  "scheduling disabled" when off, never absent.
- **B4-review-L-9 `config.dataSyncUrlBase` really was unread and is deleted.** `DATA_SYNC_URL_BASE`
  appears nowhere else in the repository (chart, scripts, images included) — B4 deleted the CronJob
  that built the URL from it. Removed, with the surviving bearer's comment corrected to name only
  the two service paths that still exist.
- **B4-review-L-2 The alert fires from a READ, which is why the suppression had to be durable.**
  The only remaining surface that learns a dbt test failed is the read-back every DQ page and the
  Monitoring rollup already perform, so that is where the alert is raised — not a new sweep, which
  is the thing B4 deleted. A read happens many times a minute and in any pod, so "the owner has
  been told about THIS execution" lives in its own small OpenSearch index (`os-dq-alerts`,
  `config.dqAlertsIndex`) through the same `osMirror` boundary `git-mirror.ts` uses. If that index
  cannot be read, the first read after a restart may notify twice — chosen deliberately: a
  duplicate notification is recoverable, a missed failure is not. `deliverDqAlert` MOVED to
  `@core/notifications/dq-alert` because a tab may not import another tab; `tabs/dashboards/lib/
  delivery.ts` re-exports it, so no caller or test changed.
- **B4-review-L-3 Only ONE of the two claimed falsehoods was locatable.** `ARCHITECTURE.md`'s
  "Every door is the same door" paragraph names `startQueuedRun` as the door the run route uses; it
  never has (`app/api/agents/systems/[id]/run/route.ts` calls `enqueueRun` directly, because it
  owns the SSE tail). That is fixed in all three places that repeated it (ARCHITECTURE,
  `tabs/agents/README.md`, the `startQueuedRun` docstring). Every other claim in those lines
  checked out against the code (`scheduled.ts` → `startQueuedRun`, `resume_agent_run` →
  `resumeQueuedRun`, `onDecided` → `enqueueResumeAfterDecision`), so the second item is recorded as
  not reproducible rather than silently "fixed".

#### B4 review round — the final report writer's data-side defects — `B4-review-E-<n>`

- **B4-review-E-1 Two ceilings for reads, none for writes, and the client timeout derived from the
  server one.** `QUERY_MAX_RUN_TIME` (`60s`) becomes Trino's `query_max_run_time`, which is the
  only thing that makes TRINO abandon a runaway read; `request_timeout` is set to that **+5 s**,
  because a client that gives up FIRST orphans the query on the cluster — the exact defect. Rows
  are fetched as `max+1` so `truncated` is MEASURED, and the flag reaches `query_data`'s payload
  (`QueryResult.truncated` / `rowLimit` / `message`), because a clipped result set a caller cannot
  see is worse than an error. `EXECUTE_MAX_RUN_TIME` is deliberately UNSET: a full-refresh sync or
  a promote CTAS legitimately runs for minutes, and a ceiling guessed here would abort real work —
  so the /execute comment now says plainly that nothing bounds a write statement, instead of
  claiming the client owns the budget. `_seconds()` parses `60s`/`5m`/`1h`/`90`/`1500ms` and never
  raises: a malformed env var must not take the service down while the ceiling still applies.
  Checklist D11 wording unchanged; `D-11` recorded DONE.
- **B4-review-E-2 The review's premise was half right.** `no-cluster`/`no-configmap` were NOT
  retried *within* a pass — fixed, every code now gets the backoff — but the jittered PERIODIC
  pass always retried them unconditionally, so the failure mode was a 10-minute window of open
  ownership rather than a permanent one. Both halves are now closed: the window shrinks to the
  pass's own backoff, and the health row is RED until the first success so a permanently failing
  reconciler cannot read as a warm-up state. The test that asserted "a missing ConfigMap is not
  retried" was inverted with the reason written in it.
- **B4-review-E-3 This was a real latent bug, and the reason matters.** dbt reads `profiles.yml`
  as YAML and THEN renders each scalar through Jinja, so a `{% if %}` carried inside a YAML
  comment is discarded by the parser: `password:` was emitted unconditionally and `method: none`
  rejects it. The fix is a generator input, which also makes `method:` a literal — the file must
  not say one thing in `method` and another in whether `password` exists. Consequence to know:
  changing `TRINO_AUTH_METHOD` now requires a REGENERATION (any dataset write, or the boot
  reconcile) rather than taking effect on the next dbt run.
- **B4-review-E-4 `relationships` was corrected, not implemented.** The OS has no FK-style quality
  rule to compile from (`DATA_CHECK_RULES` = `not_null, not_blank, unique, accepted_values,
  range`), so checklist D5 claimed a test the generator could never emit; the row now names the
  implemented set and records a `relationships` rule as a follow-up with its shape (a referenced
  dataset + column, resolved through `canView`). Also fixed: the B0 line and checklist D10 now
  attribute the data-side findings to the B0 concept rather than the 2026-11-10 audit PDF, which
  covered only LangGraph/Langfuse/LiteLLM; "`startQueuedRun` is the one start door" became
  `enqueueRun` in all three places; the "~40-line parser" is 203 lines (`lib/engine/when.ts`); and
  the worker's "Langfuse singleton at boot" is a PROBE — `langfuseClient()` is resolved lazily at
  each use site.

- **F-1 A test that could never run was DELETED, not fixed.**
  `os-ui/app/api/agents/systems/[id]/assistant/route.test.ts` sat outside the runner's globs
  (`core/**/*.test.ts`, `tabs/**/*.test.ts`), so it never executed; it imported its own
  `./route.ts` — which the repo's rules forbid a test to do — and `../../../../../../lib/agents/store.ts`,
  a path that has not existed since the v2 layout, so it would have thrown on line 46 if it ever had
  run. One `git rm`. Coverage that claims to exist and does not is worse than none; writing it
  properly means moving the route's logic into a `tabs/agents/lib` service the test may import,
  which is the same shape B4 used for the data routes and belongs to whoever next touches that route.
- **F-2 `upstream_error` added to the MCP error vocabulary.** The registry-wide conformance test
  (X7) asserts no tool answers the `error` catch-all. `suggest_metrics` did, with a bare
  `fetch failed`, whenever the model gateway was unreachable — a client cannot tell that from a bug
  in its own arguments. Rather than exempt the tool, `structuredError` gained a fifth documented
  code: a thrown error with NO HTTP status whose cause chain carries a transport failure
  (`fetch failed`, `ECONNREFUSED`/`ETIMEDOUT`/`UND_ERR…`, `AbortError`) is `upstream_error`, hinting
  at Platform → Components rather than at the caller's arguments. One function, one call site; the
  documented set is now `not_found | forbidden | bad_request | conflict | upstream_error`, with
  `error` reserved as the last-resort catch-all a conformant tool never reaches.
- **F-3 The software tab's foreign-object convention is MEASURED, not changed.** A software app
  that exists but the caller cannot see is `not_found` from the read/build doors
  (`get_software`, `read_app_files`, `build_software`, `design_software`, `get_app_spec`,
  `generate_app_spec`, `set_app_design`, `verify_software`, `get_software_status`) and `forbidden`
  from the grant/preview/deploy/archive doors (`request_deploy`, `start_preview`, `set_app_spec`,
  `use_connection`, `use_data`, `use_knowledge`, `use_as_data`, `archive`). The second set
  therefore tells an enumerating caller that an app EXISTS while the first denies it. Every other
  tab is consistent (`forbidden`, the B4-11 convention; agent RUNS deliberately `not_found`).
  Converging the two needs a decision on WHICH convention wins repo-wide and a change to seven
  tools' security semantics, so Part F pinned the current behaviour per tool in
  `core/mcp/mcp-conformance.test.ts` (`SOFTWARE_FOREIGN`) — it can no longer drift unnoticed — and
  recorded the leak as an iteration-2 item rather than changing it unreviewed.
- **F-4 The Python suites ran in no gate at all.** `images/extensions/query-tool/*` (X9's handler
  half — the `query_max_run_time` / `request_timeout` / `max+1` ceilings that closed deviation
  D-11) and `images/extensions/dagster/tests/test_os_projects.py` (D7/D8/D11's unit halves, 45
  tests) were cited as evidence by five checklist rows while `ci.yml` ran only data-runner and
  web-fetch and `gate.sh` is node-only. Both are now in CI's `test-python` job. They run PER FILE:
  the four query-tool modules patch the same `app` module at import time, so a single
  `unittest discover`/pytest pass over the directory cross-contaminates — 7 of the 12 budget tests
  fail together and all 12 pass individually. The per-file invocation makes them run honestly
  today; the isolation defect itself is an iteration-2 item, named rather than papered over.
- **F-5 Test files are not type-checked, and do not type-check.** `os-ui/tsconfig.json` excludes
  `**/*.test.ts`, so `tsc --noEmit` is clean while the tests are not: a temporary config that
  INCLUDES them reports **599 errors**. 510 are one systemic cause (a test-local `CurrentUser`
  object literal omits `allDomains` / `activeDomain`, which the type requires), 18 are deliberate
  assignments to `readonly` config fields, and **2 are real**: a stale `@tabs/data/lib/types`
  specifier in `tabs/data/lib/model-view-collision.test.ts` (type-only, so it erases at runtime and
  the import silently types as an error rather than failing) and the dead `route.test.ts` deleted
  as F-1. Including tests in the project config is not a Part F change — it would turn 599 errors
  into a red gate — so it is an iteration-2 item with the systemic cause already identified.
- **F-6 Commit trailer.** Part F's commits are trailed `Co-Authored-By: Claude Opus 5 (1M context)`
  rather than the branch's `Claude Fable 5.1`, because that is the model that wrote them. The
  trailer records authorship; recording a model that did not do the work would make it decorative.
- **F-7 The three chart checks never ran in CI — and could not have told anyone.** Draft PR #41's
  `test-ui` job failed in `gate.sh` with helm's raw `found in Chart.yaml, but missing in charts/
  directory: langfuse, litellm-helm, opensearch, dagster`: the runner has helm but the subchart
  tarballs are gitignored, so `helm template` cannot render the chart. `check-trino-rules-chart.mjs`
  already skipped on a missing `.tgz` — which meant that once the crash was gone it would have
  asserted NOTHING on the one machine meant to enforce it — and `check-worker-env.mjs` had no such
  guard at all, so it was the one that died. Fixed on both sides: (1) `test-ui` now sets up helm
  (the same pinned `azure/setup-helm` the `helm-lint` job uses) and runs
  `helm dependency build charts/sovereign-agentic-os || helm dependency update …` before the gate,
  resolving exactly the versions `Chart.lock`/`Chart.yaml` pin; (2) both scripts skip on "helm
  missing OR `charts/sovereign-agentic-os/charts/*.tgz` absent OR `values.local.yaml` absent" with
  a loud line naming the fix command — and that skip is a **hard failure when `process.env.CI` is
  set**, so CI can never silently skip a chart check again. `check-litellm-allowlist.mjs` needed no
  change: it reads `values.yaml` directly and never templates. Verified locally with the exact CI
  command: `CI=true bash scripts/gate.sh` from `os-ui/` is exit 0 with all three checks reporting
  `ok`/`PASS`; with the subcharts moved away, `CI=true` makes both scripts exit 1 with the
  actionable message while a plain laptop run still skips at exit 0.

#### Part F iteration 2 deviations (local half, `feat/engine-rebuild-b2`) — `F2-n`

- **F2-1 The software existence leak is closed towards `not_found`, and the tab's own tool
  descriptions decided it.** F-3 measured the split without changing it because "which convention
  wins repo-wide is a decision". It turned out not to need one for this tab: `start_preview`,
  `use_connection`, `use_data`, `use_knowledge`, `use_as_data` and `archive` already DOCUMENT
  "an unseeable app id → not_found; an app you can see but may not … → forbidden" in the strings
  the MCP advertises, so the write doors were violating their own published contract, not an
  unwritten one. Fixed by putting the visibility gate FIRST in the six functions behind the eight
  doors — `startPreview`, `requestDeploy` (`tabs/software/lib/review.ts`), `archiveApp`,
  `useAsData`, `consumeResource` (`tabs/software/lib/lifecycle.ts`) and `setAppSpec`
  (`tabs/software/lib/apps.ts`) now open the app through the existing `getAppForUser` (the read
  doors' own door, 404 on invisible) instead of the unscoped `getAppByIdInternal`, and keep their
  owner/role check afterwards as the 403. **Tools whose refusal code changed for an invisible app
  (8):** `request_deploy`, `start_preview`, `set_app_spec`, `use_connection`, `use_data`,
  `use_knowledge`, `use_as_data`, `archive` — `forbidden` → `not_found`. Nothing that was ALLOWED
  becomes denied, and one thing that was wrongly allowed is now denied: `consumeResource`'s Builder
  arm carried no domain check at all, so any Builder could grant a resource to an app in a domain
  they do not belong to; the visibility gate closes that.
  `SOFTWARE_FOREIGN` in `core/mcp/mcp-conformance.test.ts` collapses to a single expectation and
  gains a second test asserting (a) the tab answers with exactly ONE code and (b) every software
  tool addressing an `appId` that a Creator can reach carries a pinned expectation — so a new door
  cannot re-open the split on the `?? 'forbidden'` default. `platform-mcp-appspec.test.ts`'s pinned
  403 becomes a 404, and a new case pins the other half: a colleague who CAN see a Shared app but
  may not write it still gets `forbidden`, because converging the EXISTENCE answer must not swallow
  genuine PERMISSION answers.
  **Deliberately NOT changed:** the other tabs. The brief named the repo convention as "invisible =
  `not_found`", but F-3 recorded the opposite for every non-software tab (`forbidden`, deviation
  B4-11) and `mcp-conformance.test.ts` still pins that. So this converges the tab that was
  internally inconsistent — software, where read and write doors disagreed with each other and the
  write doors disagreed with their own descriptions — and leaves the cross-tab question
  (software + agent runs hide existence; data/knowledge/files/agents/metrics/dashboards do not)
  open for a decision, named here rather than changed under cover of a bug fix. `promote`,
  `delete` and `commit` were also left alone: they floor at `builder`, so the dispatcher's role
  gate answers before their object gate is ever reached.
