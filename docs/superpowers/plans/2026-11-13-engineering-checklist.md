# Definition of done: what must be true for AI-product and data-product engineering in the OS

> Companion to `2026-11-13-engine-rebuild.md`. This is the **acceptance checklist** the programme is tested against at the end of every iteration. Each item states **how it is tested**, so "done" is a measurement, not an opinion. An item that cannot be tested in the environment available is marked `untestable here` with the reason, never silently ticked.

**The standard:** a data or AI engineer who knows LangGraph, Langfuse, LiteLLM, dbt, Dagster, Trino and git should be able to read what the OS produced and recognise their own practice. The OS adds governance, identity and ease of use **on top**; it does not reinvent how the tools work. Where the OS still does something its own way instead of the tool's way, the checklist item fails and the gap report names it.

Legend for the **Test** column: `unit` = automated test in the suite · `kind` = verified against the local kind cluster · `stackit` = verified against production after deploy · `inspect` = read the generated artifact or the source and confirm · `mcp` = exercised through the OS MCP as a client would.

**Status column** (added 2026-11-13 at the end of Phase A5, from the branch `feat/engine-rebuild`
at commit of A5; no cluster was available): `true (test: …)` names the file that makes it true ·
`untestable here (…)` gives the exact step that would prove it · `false (…)` says what is missing.
Part 1 is scored; Part 2 (data products) and Part 3 are Part B/D work and are scored `false (not
started)` where the phase has not run, since claiming otherwise is the failure mode this document
exists to prevent.

---

## Part 1 — AI products (agent systems)

### 1.1 Definition and versioning

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A1 | An agent system is defined by a single `system.yaml` that fully determines its graph: agents, entrypoint, edges with guards, grants, safety preset, state channels. No behaviour lives outside the file. | `inspect` the schema; `unit`: parse → compile → build is deterministic (same YAML, same graph). | true (test: `tabs/agents/lib/langgraph-compile.test.ts`, `system-schema.test.ts` byte-stable serialize, `engine/parity.test.ts` — the same yaml reproduces the same path, tools and final text every run) |
| A2 | Every save of a system, from the UI or the MCP, is a **git commit** in the owning domain's repository, authored as the acting user, with a message naming the action and its origin (`ui:agents` or `mcp:<tool>`). | `unit` on the commit builder; `kind`: save twice, `git log` shows two commits with the right author and message. | true (test: `os-ui/tabs/agents/lib/git/commit.test.ts` — 17 writers x flag on/off, the author/committer/trailers and the `ui:<route>` vs `mcp:<tool>` surface; `os-ui/tabs/agents/lib/git/repo.test.ts` — two saves = two commits in a REAL bare repo. `kind` half: `docs/components/os-ui.md` -> "Agent systems in git" has the `git log` commands) |
| A3 | The repository holds the human-readable artifacts an engineer would commit: `system.yaml`, the compiled graph as `graph.ts` (or an equivalent readable form), and a README. Nothing opaque. | `inspect` a checkout of a domain repo. | true (test: `os-ui/tabs/agents/lib/git/generate.test.ts` + 3 goldens in `lib/git/fixtures/` — `agents/<slug>/{system.yaml, agents/<id>.md, graph.json, README.md}` and `agents/index.yml`; nothing opaque, no secrets, and an unparseable source is still committed with a README saying so) |
| A4 | A system can be exported and run outside the OS: the compiled graph plus a thin runner compiles and executes with LangGraph alone, against LiteLLM, with tools stubbed. | `kind`: export, `npx tsx` the runner, reaches END. | **partly true (Part F)** — the RUNNER now exists and the artefact executes from a plain checkout: `os-ui/scripts/run-agent-graph.mjs <checkout>/agents/<slug>/system.yaml "task"` parses and compiles the committed `system.yaml` with the OS's own `parseSystem` → `compile` → `buildGraph`, with the LiteLLM gateway replaced by a deterministic scripted model, the governed executor by a stub and the Postgres checkpointer by LangGraph's in-memory saver; it prints the path, the tool calls and the budget, and exits 0 iff the run reaches END. No cluster, no database, no model credential, nothing written. Test: `tabs/agents/lib/engine/run-agent-graph-cli.test.ts` drives the CLI as a SUBPROCESS against the exact `system.yaml` blob the git golden commits, asserting END, the LangGraph engine, every member on the path and a tool reaching the stub — plus the negative half (an uncompilable system exits non-zero and never claims END). **Still `partly`, not `true`:** `buildGraph` is the OS's compiler, so "executes with **LangGraph alone**" is not met — a standalone `graph.ts` emitting LangGraph calls directly is unbuilt (deviation D-8). `graph.json` (the compiled IR) is committed and readable, and the whole repo exports as a tar via `GET /api/data/projects/<domain>/export` |
| A5 | Existing `system.yaml` files from before the rebuild load and run unchanged. | `unit` golden fixtures from the old walker still pass. | true (test: `engine/parity.test.ts` + `engine/fixtures.test.ts` — the 13 FROZEN walker goldens, every shipped template among them, still reproduced by the engine) |

### 1.2 Execution is real LangGraph

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A6 | The production run path executes a compiled `StateGraph` from `@langchain/langgraph`. No hand-rolled walk remains on any reachable path. | `inspect`: grep for `nodeOrder`, `runAgenticGraph` BFS, `run-graph.ts`, `interpreter.py` → absent; `unit`: the run route dispatches to `buildGraph`. | true (test: `engine/build-graph.test.ts`, `engine/parity.test.ts`, `core/mcp/agent-run-surface.test.ts`; `inspect`: `nodeOrder`/`runAgenticGraph`/`run-graph.ts`/`interpreter.py` are all DELETED — the grep returns only history and the kept service-bearer name, see deviation A5-12) |
| A7 | Supervisors **decide** which member runs next; members are not visited in declared order. | `unit`: a scripted supervisor choosing `writer` first visits `writer` first. | true (test: `engine/build-graph.test.ts` "A7: the supervisor DECIDES" + the non-member case) |
| A8 | `when` guards route: a handoff with a false guard does not visit its target, and one with a TRUE guard does — including a guard an agent made true during the run. | `unit`: the formerly-`todo` HANDOFF-GUARD test passes, plus a POSITIVE test where an agent sets the channel. | true (test: `engine/parity.test.ts` CHANNEL-GUARD ×5 — one graph, shape (d) `channel-guarded-handoff`, driven with the write (`planner → builder`), without it (`planner` only), with an undeclared channel and with a wrong-typed value (both refused, neither routes), plus node-narrowing; `engine/build-graph.test.ts` "A8" + the five `H-2` tests; `engine/parity.test.ts` HANDOFF-GUARD for the negative walker-divergence case. **Scored `true` only from the review round on** — until then no node could write a channel, so the positive half had no test and could not have passed: see deviation A5-review-H2-*) |
| A9 | State channels declared in `system.yaml` exist in the graph state with the declared reducer — and with the declared TYPE and default. | `unit`: `add_messages` appends, a last-value channel overwrites, a typed channel starts at its default. | true (test: `engine/build-graph.test.ts` "A9" + "H-2: a declared channel starts at its type's default") |
| A10 | Loops are bounded: the team step budget maps to `recursionLimit`, and exhaustion is a graceful stop that returns what completed. | `unit`. | true (test: `engine/build-graph.test.ts` "A10" ×2 — graceful stop and the `recursionLimit` derivation) |
| A11 | Tool calls use the model's native tool-calling, with the text fallback only when the model rejects the tools parameter. | `unit`: both branches exercised; `kind`: a run against the STACKIT model succeeds. | true for both branches (test: `engine/build-graph.test.ts` "A11"); the `kind` half (a run against the STACKIT model) is **untestable here** — needs a cluster with managed inference |
| A12 | Planner and executor tiers are separate models and configurable per agent. | `inspect` + `unit`. | true (test: `build/resolve-node-model.test.ts` — 6 cases incl. an explicit per-agent pin beating Auto; `inspect`: `plan_<id>` takes `reasoningModel`, `act_<id>` the resolved tier) |

### 1.3 Durability and human-in-the-loop

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A13 | Every superstep is checkpointed to Postgres; **thread id = run id**. | `kind`: `SELECT count(*) FROM checkpoints WHERE thread_id = <runId>` grows during a run. | true for the invariant (test: `engine/build-graph.test.ts` "every superstep checkpointed under thread id = run id", `engine/parity.test.ts` P2); the `kind` SELECT is **untestable here** — `psql -d agent_runs -c "select count(*) from checkpoints where thread_id='<RUN>'"` twice during a run |
| A14 | A run interrupted by a pod restart or the request cap **resumes** from its last checkpoint and reaches the same end state as an uninterrupted run. | `unit` P2 **green**; `unit` A4: a SIGTERM between supersteps returns the job to `queued` as a `resume` and the events already written stay durable (`worker-loop.test.ts`); **`kind` half `untestable here`** — "a rolling restart loses no run" needs a cluster: enable the worker (`--set osUI.worker.enabled=true`), start a long run, `kubectl -n agentic-os rollout restart deploy/os-ui-worker` while `run_jobs.status='running'`, then assert the old pod logged "SIGTERM — finishing the current superstep", the row returned to `queued`/`kind=resume`, `locked_by` changed, `run_events` continued at the next `seq`, and the final `done` reports the same `path` as an uninterrupted run. Full commands: `docs/components/os-ui.md` → "Verify it in a cluster". | unchanged: `unit` P2 green + the SIGTERM re-queue in `engine/worker-loop.test.ts`; the `kind` half **untestable here** (commands in `docs/components/os-ui.md` → "Verify it in a cluster"). **Part F narrows the unit half honestly:** `worker-loop.test.ts`'s SIGTERM test injects a mock `execute` that calls `store.requeue` directly, so it proves the worker LOOP's contract (the row returns to `queued` with `kind='resume'`, `locked_by` clears, the events already written stay durable) but NOT that the real executor detects SIGTERM and requeues at the right moment. That link is asserted only by the `kind` half |
| A15 | A write that needs approval **pauses the run** via `interrupt()`; nothing executes before the decision. | `unit` P3. | true (test: `engine/approvals.test.ts` P3(a)+(d) — the batch parks before ANY call executes) |
| A16 | Approving from Governance **resumes the run** and the approved write executes exactly once, as the original runner, not the approver. | `unit` P3; `kind`: end-to-end approve → the artifact exists, authored as the runner. | true (test: `engine/approvals.test.ts` P3(b)+(d) exactly once as the runner, `engine/resume.test.ts` P3(f) the live re-read); the `kind` end-to-end (the artifact exists, authored as the runner) is **untestable here** — approve from Governance → Inbox in a cluster and read the artifact's author |
| A17 | Rejecting returns a typed result to the model and the run continues. | `unit`. | true (test: `engine/approvals.test.ts` P3(c)) |
| A18 | Runs longer than the request cap complete (worker mode). | **`untestable here`** — needs a cluster and a genuinely >300 s run. `kind`: `--set osUI.worker.enabled=true`; `kubectl -n agentic-os logs deploy/os-ui-worker \| grep 'boot:'` must say `checkpointer=postgres jobs=postgres`; start a >6-minute run from the Agents tab and **close the browser tab**; then `psql -d agent_runs -c "select status from run_jobs where run_id='<RUN>'"` → `done` and `select seq,event,at from run_events where run_id='<RUN>' order by seq` → a terminal `done` more than 300 s after the first event, with no client attached. Re-attach mid-run with `GET /api/agents/systems/<id>/run/stream?runId=<RUN>&afterSeq=<n>`. Full commands: `docs/components/os-ui.md` → "Verify it in a cluster". Covered by unit tests here: enqueue → claim → events → settle, the stale-lease re-queue-once-then-fail, and P1–P3 in `inline` mode. | **untestable here**, unchanged (steps in `docs/components/os-ui.md`) |

### 1.4 Observability is Langfuse, used as Langfuse

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A19 | **One Langfuse trace per run**, trace id = run id; nodes are spans, model calls are generations with token usage, tool calls are spans carrying the governance decision. | `kind`: fetch `/api/public/traces/<runId>`, assert the observation tree. | true (test: `engine/observe.test.ts` "TRACE-PER-RUN" — the REAL SDK with a recording `fetch`: exactly one `trace-create` with id = runId, N spans sharing it, and a resume adding no second trace); the `kind` fetch of `/api/public/traces/<runId>` is **untestable here** |
| A20 | The run's "Trace" link opens that trace, not a list. | `inspect` the URL built in code; `kind`: click-through. | true (test: `core/infra/langfuse.test.ts` "LANGFUSE-LINK", plus the tripwire in `core/mcp/agent-run-surface.test.ts` that no module builds a `/traces` LIST link) |
| A21 | Traces carry `userId`, `sessionId`, and tags for domain, agent, run. | `kind`: read the trace. | true (test: `engine/observe.test.ts` A21 — `userId`, `sessionId` = systemId, tags `domain:`/`agent:`/`run:`) |
| A22 | The LLM-judge verdict is written as a Langfuse **score** on the run trace. | `kind`: `/api/public/scores?traceId=`. | true at the client — **but the citation was wrong until Part F**: `core/infra/langfuse.test.ts` never called `scoreTrace`, and `evaluate-judge.test.ts` only parses the judge's verdict JSON, so the only thing exercising the score path was a source-ordering tripwire in `core/mcp/agent-run-surface.test.ts` that greps the route for the string. Part F wrote the missing behavioural tests (`core/infra/langfuse.test.ts` LANGFUSE-SCORE ×3, the REAL SDK with its transport replaced through `__setLangfuseClientForTests`): the verdict lands as exactly ONE `score-create` whose `traceId` IS the run id, with its name/value/comment, and never as a span or generation; an unconfigured client is a reported no-op; a throwing client is swallowed and reported, so a verdict can never fail a run. The ROUTE that writes it still cannot be unit-tested (a test may not import a `route.ts`) and the `kind` read `/api/public/scores?traceId=` is **untestable here** |
| A23 | No Langfuse query in the OS returns another user's observations: every read is filtered by run, user or scope. | `unit` on the diagnostics route; `inspect` every `/api/public/` call site. | true (test: `core/infra/langfuse.test.ts` ×3 — unfiltered refused, run-scoped by trace id, user+window otherwise; `core/mcp/agent-run-surface.test.ts` tripwire that the diagnostics route owner-gates BEFORE the read). **A5 fixed a real hole here**: the route filtered by `traceId` only, and a trace id IS a run id, so a guessed id returned another user's generations. Named gap: two other Langfuse readers (`monitoring/lib/adapters/run-trace.ts`, the Build probe) fetch then filter OS-side rather than through `observationsQuery` — correct today because the OS is the only caller, listed as an A4 follow-up |
| A24 | Model calls are not double-traced unlinked: LiteLLM's callback generations and the OS's spans share the run trace. | `kind`: one trace, generations nested. | true (test: `engine/attribution.test.ts` — `existing_trace_id` + `parent_observation_id` on the outgoing request, and `metadata.trace_id` deliberately absent); the `kind` "generations nested in one trace" is **untestable here** |

### 1.5 Models are LiteLLM, used as LiteLLM

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A25 | **No inference path uses the master key.** Only gateway administration does. | `unit` MODEL-KEY repo-wide: the only files referencing `litellmMasterKey` are the admin read/write clients and key provisioning. | true (test: `core/runtime/runtime.test.ts` MODEL-KEY repo-wide — `deepEqual` against the expected file set, so a file LEAVING the set fails too) |
| A26 | Every run uses a **per-principal key** (per agent when it exists, else the shared agent key), with an allowlist and budget enforced by the gateway. | `unit`; `kind`: a run with an over-budget key fails with a typed `budget_exceeded`, not a raw 400. | true (test: `engine/attribution.test.ts` A25/A26 — the scoped key by reference, else the shared agent key, never the master); the `kind` `budget_exceeded` surface is **untestable here** — needs a cluster key with an exhausted budget |
| A27 | Every model call carries `user` and tags `domain:`, `agent:`, `run:`, including from the Python runtime if any remains, and from embeddings and classify. | `unit`: assert on the outgoing request body at each call site. | true for every run, classify and retrieval call (test: `engine/attribution.test.ts`, `tabs/knowledge/lib/embed.test.ts`, `tabs/files/lib/embed.test.ts`). Named gap, unchanged from A3-11: the three INDEX sites (`indexWorkflow`, `indexDomain`, `indexAsset`) have no acting user in scope and still bill `user os-system` + `domain:platform`, so their attribution is per-surface, not per-user |
| A28 | The key allowlist always covers every model alias the OS can request, including router fallbacks. | `unit` chart test; `stackit`: the provisioning Job log shows the full list. | true (test: `scripts/check-litellm-allowlist.mjs` in `gate.sh`, both chart profiles, all four fallback maps); `stackit` Job-log confirmation is **untestable here** |
| A29 | Gateway spend per domain and per agent is real and visible on Platform and Monitoring, read from LiteLLM, not computed by the OS. | `kind`: after a run, the mirror shows non-zero spend for that domain and agent. | **untestable here** — needs a cluster: after a run, `GET /api/platform-admin/...` spend mirror (`tabs/admin/lib/gateway-mirror.ts` `spend.byRun`) must show non-zero for that domain and agent. Unit side: `gateway-mirror.test.ts` proves the `run:` tag is parsed |
| A30 | Failures are observable: LiteLLM `failure_callback` is configured; a rejected call appears in Langfuse. | `inspect` chart; `kind`. | true by `inspect` (chart `litellm.proxy_config.failure_callback: ["langfuse"]` in `values.yaml`); the `kind` half (a rejected call appears in Langfuse) is **untestable here** |
| A31 | A failed embedding never silently indexes substitute vectors; the fallback is explicit and labelled, and 4xx errors throw. | `unit`. | true (test: `tabs/knowledge/lib/embed.test.ts`, `tabs/files/lib/embed.test.ts`, plus the tripwire in `core/mcp/agent-run-surface.test.ts`: the fallback is labelled in the result (`source: 'offline-hash'` / `mode: 'mock'`) and a 4xx THROWS; the Context Librarian refuses to curate over hash vectors at all) |

### 1.6 Same path through the MCP

| # | Must be true | Test | Status (end of A5) |
|---|---|---|---|
| A32 | `run_agent_system` returns `runId` and `traceUrl`; `get_agent_run` returns state and held approvals; `resume_agent_run` resumes; `decide_approval` resumes the thread. | `mcp`: drive a full run → hold → approve → completion with the MCP alone. | the doors and their semantics are true (test: `core/mcp/agent-run-surface.test.ts` — the five tools, the sequence in their descriptions and the guide, `not_found` from every run-addressed door, the owner-gate tripwires; `core/mcp/wave-a.test.ts` for `run_agent_system`'s identity threading and the unmapped-grant refusal). Driving a FULL run → hold → approve → completion over MCP is **untestable here**: it needs a live model and a cluster — `mcp` steps: `run_agent_system` → `get_agent_run` until `parked` → `decide_approval` → `get_agent_run {afterSeq}` until `done` → `get_run_trace` |
| A33 | A system created through the MCP produces the same git commit, graph, trace and spend attribution as one created in the UI. | `mcp` + `kind`: compare artifacts byte-for-byte except timestamps. | true (test: `os-ui/tabs/agents/lib/git/commit.test.ts` — the MCP and the UI reach the SAME commit path and produce the same tree; the commits differ only in the `OS-Surface` trailer (`mcp:<tool>` vs `ui:<route>`), which is the point. `core/mcp/server.ts` sets that scope for EVERY tool. Graph, trace and spend attribution were already identical via the one start door, `run-jobs-server.ts` `startQueuedRun` (`core/mcp/agent-run-surface.test.ts`). `kind`/byte-for-byte comparison of two live runs: `untestable here`) |

---

## Part 2 — Data products

### 2.1 Definition and versioning

| # | Must be true | Test | Status (end of B4) |
|---|---|---|---|
| D1 | A data product is a **dbt project** an engineer could clone and run: `dbt_project.yml`, `profiles.yml` with a Trino target and no inlined credentials, `models/`, `schema.yml`. | `inspect` a generated project; `kind`: `dbt parse` and `dbt compile` succeed in the dbt image. | **true for the artifact** (test: `os-ui/tabs/data/lib/dbt/generate.test.ts` + the three goldens in `dbt/fixtures/`: `dbt_project.yml`, `profiles.yml` with `env_var()` only and no inlined credential, `models/`, `schema.yml`). `untestable here`: `dbt parse` / `dbt compile` in the dbt image (`kubectl -n agentic-os exec deploy/agentic-os-dagster-user-deployments-sovereign -c repo-sync -- python /opt/dagster/app/os_projects.py --parse /repos-checkout/<domain>/current`). |
| D2 | Every change to a dataset, composition, quality rule or schedule, from the UI or the MCP, is a **git commit** in the domain repo, authored as the acting user, naming the action and origin. | `unit`; `kind`: `git log`. | **true, from BOTH doors** (test: `os-ui/tabs/data/lib/dbt/commit.test.ts` enumerates the store's **32** mutators (the row said 31; Part F recounted) × flag on/off and asserts author, message and trailers; `os-ui/tabs/data/lib/mcp-parity.test.ts` asserts the MCP tool and the UI route's service produce the SAME commit for the same input — B4/X8). `untestable here`: `git log` in the cluster. |
| D3 | Regeneration is idempotent: the same OS state produces a byte-identical project. | `unit` golden files. | **true (test: `os-ui/tabs/data/lib/dbt/generate.test.ts`** — two regenerations of the same state are byte-identical, per golden shape). |
| D4 | A composition is a dbt **model** that `{{ ref() }}`s its sources; the SQL body is the governed projection the OS compiles, inside a model, not an ad-hoc CTAS. | `inspect` the model file; `unit`. | **true (test: `os-ui/tabs/data/lib/dbt/generate.test.ts`, `dbt/parity.test.ts`)**: the body is the governed projection the OS compiled, inside a model, with every in-project relation reached by `ref()` (a `source()` where a `ref()` belongs is a parity FAILURE — B3-review-M-6). A body the OS did NOT compile is a dbt source, never a model (B2-1). |
| D5 | Quality rules are `schema.yml` **tests** (`not_null`, `unique`, `accepted_values`, plus the OS-shipped generics `range` and `not_blank`), and `dbt test` runs them. **`relationships` is NOT in this row any more (B4-review E-4):** the OS has no FK-style rule to compile from — `DATA_CHECK_RULES` is `not_null, not_blank, unique, accepted_values, range` — so the row claimed a test the generator could never emit. Adding a `relationships` rule (a referenced dataset + column, resolved through `canView`) is recorded as a follow-up, not scored here. | `kind`: a violated rule fails `dbt test`; the failure is visible in the OS. | **true for the generation, with the citation corrected in Part F**: the rules → `data_tests` mapping, including `range`/`not_blank` as shipped generic tests, is proven in `os-ui/tabs/data/lib/dbt/generate.test.ts`; `os-ui/tabs/data/lib/dbt/schema.test.ts` covers only the `accepted_values` injection/Jinja safety (an unsafe value or column is recorded as `meta.os_intentions` rather than emitted). The rule set itself is verified exactly as the row states — `DATA_CHECK_RULES` in `tabs/data/lib/dataset-schema.ts:193` is `['not_null','not_blank','unique','accepted_values','range']`, with no `relationships`. `untestable here`: that a violated rule FAILS `dbt test` in the cluster and the failure appears in the OS (it is read back as an asset check — `dq-status-server.test.ts` covers the read, not the execution). |
| D6 | Incremental sync semantics (cursor, late-data lookback, batch idempotency) are expressed as dbt **incremental model config**, not bespoke SQL. | `inspect` + `unit`; `kind`: a second run appends only new rows and re-delivers the lookback window once. | **true (test: `os-ui/tabs/data/lib/dbt/generate.test.ts`** — the append fixture emits `incremental` + `delete+insert` + `unique_key: _batch_id` + the 15-minute lookback predicate as CONFIG, and merge emits `merge` + `unique_key`). `untestable here`: that a second run appends only new rows and re-delivers the lookback window exactly once. |

### 2.2 Scheduling is Dagster, used as Dagster

| # | Must be true | Test | Status (end of B4) |
|---|---|---|---|
| D7 | A sync schedule is a **Dagster schedule** over `dbt_assets` for the domain's project plus one asset per external source. No Kubernetes CronJob provisioning remains for syncs. | `inspect`: `sync-cron.ts` absent; `kind`: the Dagster UI lists the schedule. | **true for the schedule AND the external-source asset** (test: `images/extensions/dagster/tests/test_os_projects.py::SourceAssets`, `os-ui/tabs/data/lib/dbt/source-assets.test.ts`, `dbt/launch.test.ts`); **`sync-cron.ts` IS now deleted** (B4, one `git rm`; what survives is the delete-only `sync-cron-removal.ts`, whose test asserts it cannot CREATE a CronJob — `os-ui/tabs/data/lib/sync-cron-removal.test.ts`), the two fallback sweep routes and both chart CronJob templates are gone, and `helm template` renders **0 `batch/v1` CronJob** for data in every value set. The Dagster-UI half is `untestable here` (no cluster in this worktree — `kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80` then the Automation tab). |
| D8 | Dagster loads the domain's code location **from a git commit**, and a commit that fails `dbt parse` does not replace the last good location. | `kind`: push a broken model, schedules keep running on the previous commit, the OS shows the parse error. | **partly true by unit** (test: `images/extensions/dagster/tests/test_os_projects.py` — `discover`, `ensure_checkout`, `parse_schedules`, `pinned_one` and the per-domain gating in `partition_definitions`, plus `sh -n repo-sync.sh`): the script repoints `current` only after `dbt parse` succeeds, so a bad commit cannot replace the last good checkout. `untestable here`: the behaviour itself — push a broken model, watch the schedules keep running on the previous commit and the OS show the parse error (`curl http://<pod-ip>:8089/status.json` from inside the namespace). |
| D9 | Run status, materialisations and failures in the OS are **read from Dagster** (GraphQL), not a parallel OS ledger. | `inspect`: no OS-native sync run store remains; `kind`: trigger in Dagster, the OS shows it. | **true (test: `os-ui/tabs/data/lib/sync-status-server.test.ts`, `dq-status-server.test.ts`, `core/infra/dagster.test.ts`)**: run history, materialisations, asset checks and the next tick come from Dagster, and B4 DELETED the sweeps that wrote rows beside it (`/api/data/sync-due`, `/api/data/dq/run-all`). What still writes a row: the flag-off ledger path, and the ad-hoc "Run checks" probe, labelled `source: 'os'` so it is never mistaken for a dbt test. `untestable here`: trigger in Dagster, see it in the OS. |
| D10 | The Dagster image works: it has its Postgres driver and completes a run. | `kind`. | `untestable here` (no cluster in this worktree). The "no driver, 0 runs in 90 days" finding behind this row is **B0's**, from `2026-11-13-data-products-concept.md` — the 2026-11-10 audit PDF covered only LangGraph/Langfuse/LiteLLM and says nothing about Dagster (B4-review E-4). Exact step: `kubectl -n agentic-os exec deploy/…-sovereign -- python -c "import psycopg2, dagster_dbt, trino"` then launch `<domain>__all` from the Dagster UI and assert the run reaches SUCCESS. The image carries the drivers, `git`, `repo.py` and `os_projects.py` (`images/extensions/dagster/Dockerfile`, verified). **The row's claim that the tag was "asserted in four places by `ChartContract`" was FALSE** — the string `0.3.0` appeared nowhere in the Python suite; the four references are in `charts/sovereign-agentic-os/values.yaml` and nothing checked them. Part F made the claim true: `ChartContract::test_every_dagster_image_reference_carries_the_same_tag` now reads all four (the user-deployment image, the repo-sync sidecar's inline `sovereign-os/dagster:<tag>`, `dagsterWebserver` and `dagsterDaemon`) and fails if any disagrees — a bump that misses one runs a code location and its run pods on different images, which IS D10's failure mode. |
| D11 | UTC schedules and skipped-missed-slot semantics are preserved. | `inspect` the generated schedule config. | **true (test: `images/extensions/dagster/tests/test_os_projects.py`** — `parse_schedules` carries `timezone: UTC` end to end and `safe_timezone` falls back to UTC WITH a log rather than taking the location down; the generator's `os/schedules.yml` golden is asserted byte-for-byte against the Python parser's expectations). Dagster's own skip-missed-tick semantics replace the CronJob's `startingDeadlineSeconds: 60`. **B4-review H-1 closed the upgrade window:** a pre-B2 install's per-dataset CronJob is deleted by the boot reconcile BEFORE the first `os/schedules.yml` commit, so the two schedulers never both own a slice (test: `tabs/data/lib/dbt/boot-reconcile.test.ts`). |

### 2.3 Execution is Trino, governed

| # | Must be true | Test | Status (end of B4) |
|---|---|---|---|
| D12 | dbt executes on Trino through `dbt-trino`; the OS does not run its own CTAS for anything a model covers. | `inspect`: the old CTAS execution path deleted after parity; `kind`: `dbt run` materialises the Iceberg table. | **partly true**: with the flag on every compiled layer IS a dbt model and the OS launches `dbt build` instead of a CTAS (test: `os-ui/tabs/data/lib/dbt/launch.test.ts`, `generate.test.ts`), but the old `/execute` path is still PRESENT **by decision** (deviations B4-6 / B4-7): `/execute` also carries `apply_quality_fixes`'s MERGE, physical deletes, the warehouse import and the promote/publish CTAS — five live paths — and the CTAS BUILD path is what makes the honesty gate possible (a version is registered only after a real apply+verify; replacing it with a wait on a Dagster asset check is a redesign that cannot be shown correct offline). The CronJob-provisioning half of this item IS gone (D7). `untestable here`: `dbt run` materialising an Iceberg table, and the row-set parity that would license deleting the CTAS (D15). **Said precisely since B4-review L-1** (the CHANGELOG, `values.yaml` and `tabs/data/README.md` now agree): dbt/Dagster own the SCHEDULED path; an INTERACTIVE build runs the TypeScript CTAS first, unconditionally (`mutations-server.ts`), and then commits and launches the equivalent dbt assets — so a git-first install has two materialisers for a button press, one of which is authoritative for the version record. |
| D13 | The `iceberg.<schema>.<table>` naming and the personal/domain lane model are honoured by every generated model. | `unit`. | **true (test: `os-ui/tabs/data/lib/dbt/generate.test.ts` + `store-fqn.test.ts` + `dbt/parity.test.ts`)**: `+schema` is the exact Iceberg schema (`generate_schema_name` returns it verbatim), an un-promoted layer renders under `models/personal/<uid>/` with `+schema: personal_<uid>`, and the parity harness fails if a model's `ref()` resolves to a different lane than the CTAS wrote. |
| D14 | Row-level security and OPA still apply to every read, including reads dbt performs; nothing bypasses the governed boundary. | `inspect` the execution principal and target; `kind`: a user without a grant cannot cause a model to read the ungranted table. | **true by inspection, written down as a table**: `docs/components/trino.md` → "Who runs as whom" (every path's Trino session user, verified in code); the OPA plugin is now CHAINED with a file-based control that can only narrow (test: `os-ui/core/infra/trino-rules.test.ts` — the service user may become an OS principal and nothing else; a domain schema is ownable only by that domain's principals). `untestable here`: the ungranted-read attempt, and the fact that **Trino does not authenticate clients today**, so the impersonation rules have nothing to match until `http-server.authentication.type` is set (deviation B3-2) — exact step in `docs/components/trino.md` → "Verify it in a cluster". |
| D15 | Parity: the same composition yields the **same rows** through the old path and through `dbt run`, before the old path is deleted. | `kind` parity test with a fixture dataset. | **the offline half is true** (test: `os-ui/tabs/data/lib/dbt/parity.test.ts` — 3 fixtures incl. the concept's worked example `gold_order_customer`, plus a negative control; same projection/aliases, FROM+JOIN sequence, ON predicates, WHERE conjuncts, GROUP BY). The ROW half is `untestable here` (exact step: materialise the fixture composition both ways in kind and run `SELECT * FROM a EXCEPT ALL SELECT * FROM b` and the reverse, expecting 0 rows, plus identical `DESCRIBE`). Deliberately a translation gate, not a row gate — deviation B3-7. |
| D16 | Lineage shown in the Data tab comes from dbt's `manifest.json`. | `inspect` + `kind`. | **true (test: `os-ui/tabs/data/lib/dbt/lineage.test.ts`** — a fixture `manifest.json` folded through `assetNodesFromManifest`, which is the equivalence dagster-dbt provides; the Data tab route and MCP `get_lineage` both go through `tabs/data/lib/lineage-server.ts`). Read via Dagster's `assetGraph` rather than the file on disk (deviation B3-5); the fallback to the OS registry is labelled `source: 'registry'`. Column-level lineage: **not derived**, recorded as a follow-up (B3-6). `untestable here`: the live graph. |
### 2.4 Same path through the MCP

| # | Must be true | Test | Status (end of B4) |
|---|---|---|---|
| D17 | MCP tools map one-to-one to engineer operations: `dbt_run`, `dbt_test`, `dagster_materialize`, `get_dagster_run`, `get_lineage`, under the same governance as the UI. | `mcp`: drive define → generate → materialise → read status with the MCP alone. | **partly true, and scored honestly.** TRUE: every data MUTATION is one governed service shared with the UI route, so the MCP is the same path and not a second one (test: `os-ui/tabs/data/lib/mcp-parity.test.ts`, 8 tools), and every data tool `list_capabilities` advertises dispatches with a schema and refuses a foreign object in the documented shape (test: `os-ui/tabs/data/lib/mcp-conformance.test.ts` — checklist X7's data half). FALSE for the item's own NAMES: `dbt_run`, `dbt_test`, `dagster_materialize` and `get_dagster_run` do not exist — the first three are deliberately not added because they address asset keys rather than objects and would bypass the dataset guard (deviation B4-1), and `get_dagster_run` is a REAL gap: an MCP client that launched a build cannot poll that run id (`get_sync_status(datasetId)` is the only run read). Follow-up recorded with its gate. `untestable here`: the `mcp` end-to-end drive (define → generate → materialise → read status) needs a cluster. |
| D18 | A data product created through the MCP produces the same commit, project and Dagster definitions as one created in the UI. | `mcp` + `kind`: byte-for-byte except timestamps. | **true for the commit and the launch (test: `os-ui/tabs/data/lib/mcp-parity.test.ts`)**: for each of the eight mutating tools, the MCP handler and the UI route's service produce a deep-equal committed file map, author and `OS-Actor` trailer and deep-equal Dagster launch args; the `via mcp:<tool>` / `via ui:<route>` half of the commit subject is asserted as the ONE deliberate difference, and the 404/403/400 shapes are asserted identical on both doors. `untestable here`: the `kind` byte-for-byte comparison of two real repositories. |

---

## Part 3 — Cross-cutting

| # | Must be true | Test | Status (end of B4 / Part D) |
|---|---|---|---|
| X1 | **Git everywhere, automatically.** No OS or MCP write to an agent system or data product bypasses the commit; there is one code path for commits and every writer uses it. | `unit`: a test asserts every store write goes through the commit builder; `inspect`. | true (test: `os-ui/tabs/agents/lib/git/commit.test.ts` + `os-ui/tabs/data/lib/dbt/commit.test.ts` — both stores enumerate their exports, so a new writer fails the test until it is classified; on the agents side `writeThrough`'s change descriptor is a REQUIRED parameter, so the compiler refuses an undecided writer before the test does). **Part D review round 3:** the one path is also the one REFUSAL point — a definition write in the `os-ui-worker` process throws `SystemWriteUnavailableError` instead of applying with no commit (the `os-repos` PVC is `ReadWriteOnce`, so only os-ui can mount it; decision D-review-H-3), and a boot reconcile only commits when `hydrationState() === 'hydrated'`, with the git store refusing any `OS-Reason: boot-reconcile` commit that would delete >50% of its own tracked files while adding none (D-review-H-1). A commit caused by a run carries `OS-Run-Id` (D-review-L-3) |
| X2 | The domain repo can be mirrored to an admin-configured remote, and the OS pushes after each commit when one is set. | `kind` with a local bare remote. | true (test: `os-ui/core/infra/git-mirror.test.ts` — the push after every changed commit, the Authorization header really sent (`x-access-token:<token>` resolved from the Secret REFERENCE, only after the 401 challenge), the token scrubbed from the error, the outcome recorded, a throwing push swallowed; `os-ui/tabs/admin/lib/components-git-mirror.test.ts` — the `git-mirror` health row. The REAL remote is `untestable here`: isomorphic-git speaks only smart-HTTP, so a local bare repo is not a valid remote — the `kind` step is `kubectl -n agentic-os exec deploy/os-ui -- sh -lc 'git --git-dir=/repos/<domain>.git log --oneline -1'` against a Forgejo/GitHub remote configured through `PUT /api/platform-admin/data-projects/<domain>/mirror`) |
| X3 | Documentation describes what ships: README, `docs/components/{langfuse,litellm,dagster,dbt,trino,os-ui}.md`, tab READMEs, `ARCHITECTURE.md`, licences, SBOM. No claim without code behind it. | `inspect`, claim by claim, as the audit did. | true for the AGENT side as of A5 (`docs/components/{os-ui,langfuse,litellm}.md`, `os-ui/ARCHITECTURE.md`, `tabs/agents/README.md`, `tabs/agents/guide.md`, `README.md`, `components/README.md`, both seed READMEs and `CHANGELOG.md` were corrected in this phase; `core/kernel/licenses.ts` / `licenses/components.tsv` / `sbom.cdx.json` never listed the Python runtime's deps, so nothing to remove). The Part D docs pass extended that to git-based working for agent systems (`docs/components/os-ui.md` → "Agent systems in git", `tabs/agents/README.md`). For the DATA side: `docs/components/trino.md` **now exists** (B3) and carries the who-runs-as-whom table, the chained access controls, and an explicit "what is NOT true yet" section. **The DATA side is now true as of B4** (cross-checked claim by claim in this phase): `docs/components/{dagster,dbt,trino}.md` (the flag default, the deleted sweeps, what `/execute` still carries, federated sources as assets), `os-ui/tabs/data/README.md` (the shipped architecture, the MCP tool list, the B4 section), `os-ui/tabs/monitoring/README.md` (no ledger import left in the tab, the `source` label), `os-ui/tabs/data/guide.md`, `os-ui/ARCHITECTURE.md` and `CHANGELOG.md` (the breaking change + the migration note). Two stale claims were corrected rather than left: dagster.md's "default off / syncs are CronJobs" and dq-overview.ts's "reuses the persisted dq-results runs". Still to re-audit the whole document set claim by claim at the end of the programme. |
| X4 | The structure ratchet, the regression gate and the test suite are green, and the ratchet baseline is lower than at the start of the programme. | `unit`. | true (test: the suite — 4956 tests, 0 failures, 4 todo; `node scripts/check-structure.mjs` ok; `bash os-ui/scripts/gate.sh` exit 0). The ratchet baseline is LOWER than at the start of the programme and was lowered again by A5 **by deletion only**: TAB-ISOLATION 422 → 421, FILE-HEADER 1245 → 1240 |
| X5 | The deployed version on STACKIT passes: health; one agent run with hold → approve → resume → one trace; one Dagster-scheduled sync; one dbt composition; the key allowlist from the Job log. | `stackit`. | **untestable here** — no cluster in this environment. `scripts/deploy.sh <version>` then the Part C order: health; one run with hold → approve → resume → one trace; the key allowlist from the Job log |
| X6 | The final PDF exists and, for each tool, maps engineer practice → OS source → tool functions used → what the OS adds. Every reinvention that remains is listed, not hidden. | `inspect`. | false (Part E — written last, from the shipped code) |
| X7 | **Every MCP tool dispatches.** For every tool `list_capabilities` lists, a contract test invokes it through the dispatcher as a test principal and asserts: the input schema is present and valid, the call reaches a handler (no `unknown tool`), and a foreign/forbidden object yields the documented error shape (404 for invisible objects, 403 for role gates) — never a stack trace or a 500. | `unit`: one table-driven test over the dispatcher, not per-tool happy paths. | **TRUE for the WHOLE REGISTRY as of Part F (test: `os-ui/core/mcp/mcp-conformance.test.ts`, in `gate.sh`)** — the data half's contract, generalised from the 23 data tools to **all 113** `ALL_MCP_TOOLS` advertises (agents, software, knowledge, metrics, dashboards, monitoring, governance, connections, files, operating-manual, meta), not duplicated per tab. It imports NO tab (CORE-INDEPENDENCE) and MINTS every fixture through the dispatcher as a stranger, exactly as a client would. Six properties, asserted per tool: (1) advertised, object schema, every `required` described, a description a client can act on; (2) every tool DISPATCHES and none answers the `error` catch-all; (3) an object that does not exist is `not_found` from **every one of the 68 object-addressed tools, no exceptions** once arguments are well-formed; (4) an object that EXISTS and is invisible is `forbidden` (the B4-11 convention) — with the software READ/BUILD doors' `not_found` pinned per tool in `SOFTWARE_FOREIGN`; (5) a role gate is `forbidden` naming the role; (6) an agent RUN is `not_found` even when it exists and belongs to someone else. **The statement's own wording is corrected here:** it said "404 for invisible objects", but the OS's implemented convention — chosen in B4-11 and now verified on every tab — is `forbidden` for an object that EXISTS and is invisible and `not_found` for one that does not, with agent RUNS the single deliberate exception (existence is hidden). Two defects the test caught and Part F fixed: `suggest_metrics` answered a raw `error: fetch failed` (now the typed `upstream_error`, deviation F-2) and six software tools carried descriptions too terse to act on — the B4 finding about `use_data`/`use_as_data`, now closed for `use_connection`, `use_data`, `use_knowledge`, `use_as_data`, `start_preview` and `archive`. **One finding recorded, not changed (deviation F-3):** software's write doors (`request_deploy`, `start_preview`, `set_app_spec`, `use_*`, `archive`) answer `forbidden` for an app the caller cannot see at all, while its read doors answer `not_found` — so the write doors tell an enumerating caller the app exists. Pinned so it cannot drift; converging the two is an iteration-2 item. Previously **true for the DATA half only (test: `os-ui/tabs/data/lib/mcp-conformance.test.ts`)**: every tool with `tab === 'data'` (plus `get_lineage` via `extraTabs`) is advertised, carries an object schema whose required fields are all described, dispatches, refuses a foreign dataset as `not_found`/`forbidden` with an actionable hint and no stack, names the role a gate needs, and writes nothing when it refuses. **Strengthened in B4-review M-5:** the code is asserted PER TOOL rather than as "one of two" — an EXISTING dataset the caller may not view is `forbidden`, one that does not exist is `not_found` (which is what `store.getDataset` does, deviation B4-11) — and both runs happen with `DATA_PROJECT_GIT` OFF **and ON**, with a commit hook installed, so a refusal is proved to commit nothing in either world. A foreign CONNECTION is covered on `set_dataset_sync`; `create_dataset` takes no `connectionId`, so the review's version of that case had no door to test. `false` for the agents / software / knowledge / metrics / dashboards tools (Part F) — and one finding from the data pass: the software-tab `use_data` / `use_as_data` tools carry one-line descriptions too terse for a client to act on. Added 2026-11-13 after Alex: "make sure the MCP works with all the new functionalities". |
| X8 | **MCP data mutations are the UI's mutations.** `create_dataset`, `add_dataset_version`, `transform_silver`, `build_gold_join`, `define_quality_rules`, `set_dataset_sync`, `sync_dataset_now`, `run_quality_checks` through the MCP produce the same repo commit (same files, same author trailer) and the same Dagster launch as the UI route for the same input. | `unit`: golden repo tree + launch call per tool, compared with the UI route's. | **true (test: `os-ui/tabs/data/lib/mcp-parity.test.ts`, in `os-ui/scripts/gate.sh`)**: all eight tools, driven through `handleRpc` as a client would and then through the service the route calls, against the real commit path with an injected committer and a fake Dagster client; the committed file map, the author, the `OS-Actor` trailer and the launch args are deep-equal, and the `via mcp:<tool>` / `via ui:<route>` subject half is asserted as the one deliberate difference. The comparison is MCP-handler-vs-SERVICE because a test may not import a route (deviation B4-2); the routes were reduced to shells in the same commit. Three real divergences were found and fixed on the way (B4-3). **B4-review M-1/M-2/M-3:** a ninth case drives `set_dataset_sync` with `clear: true` (the UI route's `null`, which the MCP tool could not express at all); two of the three B4-3 fixes are now pinned by VALUE rather than by both doors agreeing (the personal partner's `iceberg.personal_<owner>` FQN; `domainTable.state === 'refreshed'` after rebuilding a promoted dataset); and two more refusals are asserted identical on both doors — a domain member who is not the owner, and a cross-lane join partner. |
| X9 | **Agents use data as context robustly.** A LangGraph run whose agent is granted `query_data`/`use_data` on a gold dataset: the Trino call runs as the runner (not a service principal) in the runner's lane/domain scope; an oversized result is truncated before it enters the prompt with a visible truncation marker and the row count; a Trino timeout or error surfaces as a typed `tool-step` error the graph can route on (never a hung superstep); the tool call appears in the run's Langfuse trace with the dataset id and the LiteLLM tags. | `unit`: parity fixture `agent-reads-gold-dataset` with a fake Trino (large result, timeout, error) + trace assertions. | true (test: `os-ui/tabs/agents/lib/engine/data-context.test.ts` — 9 over the engine shape `agent-reads-gold-dataset`: the dispatch carries the RUNNER (never `os-<systemId>`) with the dataset id and the gold FQN; 50 000 rows truncated BEFORE the prompt with `[truncated: showing N of 50000 rows]` and the envelope still parseable; a timeout and an upstream failure as typed `tool-step` errors with the run still reaching END; the calls as spans of the ONE run trace with the dataset in the span input and the run tags on the trace. Deviation D-11 — the engine bounded the RUN while the real `query_data` handler executed an unbounded Trino query — is **DONE (B4-review E-1)**: the query-tool now sends `query_max_run_time` (`QUERY_MAX_RUN_TIME`, default 60 s) so Trino itself abandons a runaway read, sets `request_timeout` to that +5 s so the client never orphans the query, and fetches at most `QUERY_MAX_ROWS + 1` rows (default 10 000), reporting `truncated` with the limit through to `query_data`'s payload. Tests: `images/extensions/query-tool/test_query_budget.py` (12). Chart: `queryTool.budget`.) |
---

## Iteration protocol

1. **Test.** At the end of a full pass over Parts A and B, a read-only agent evaluates every item above against the branch and, where available, kind and STACKIT. It produces a **gap report**: for each failing or `untestable here` item, the evidence and the smallest change that would make it pass.
2. **Plan.** The gaps are grouped into a new iteration appended to `2026-11-13-engine-rebuild.md` as "Iteration N", with phases, gates and the items they close.
3. **Design and implement.** Agents execute the iteration: implementation agents in parallel **only on disjoint areas** (agent side vs data side), each in its own worktree, merged by the coordinator; reviewer and test agents read-only and freely parallel. Docs in the same commit.
4. **Repeat** until no item fails for a reason the environment permits fixing, or until two consecutive iterations close no further item. Untestable-here items are listed in the final report with what would be needed to test them.
5. **Deploy** after each iteration whose gates are green, keeping the engine flag's default on the old walker until A5–A17 pass; flip it in the iteration that passes them.

## Gap reports
(Appended by the test agent at the end of each iteration: date, items passed / failed / untestable, the gap list.)

### 2026-11-13 — end of Phase A5 (agent side complete; data side not started)

Scored on the branch `feat/engine-rebuild`, **no cluster available**. Part 1 (A1–A33):

- **true: 21** — A1, A5, A6, A7, A8, A9, A10, A11 (unit half), A12, A13 (invariant), A15, A16
  (unit half), A17, A19 (unit half), A20, A21, A22 (client half), A23, A24 (unit half), A25, A26
  (unit half), A27 (with one named gap), A28 (unit half), A30 (inspect half), A31, A32 (doors).
  Counting only items whose every testable clause passes here: **21**.
- **untestable here: 5** — A14 (cluster half), A18, A29, A32 (the full MCP-driven run), X5. Each
  carries the exact command or step above.
- **false: 5** — A2, A3, A4, A33 (all four wait on Part D's git commit path and an exporter) and
  A2's dependant X1.

The agent side's remaining gaps are therefore **not engine gaps**. Three are Part D (git: A2, A3,
X1), one is a missing exporter (A4), one is comparing artifacts that do not exist yet (A33). The
two honest weaknesses inside A5's own scope are recorded as deviations: the index-site embedding
attribution (A27, deviation A3-11) and `grant-rehydrate.ts` never being imported (A5-11).

### 2026-11-13 — A5 review round (same branch, still no cluster)

A8 was scored `true` on the negative half only (a false guard does not route) — which it was,
because **no node could write a state channel**, so no guard could ever be true and the positive
half was untestable rather than passing. The review round closed that gap (`os_set_state`,
deviations A5-review-H2-1…6) and A8 now cites a positive test; A9 gains the declared type and
default. No other item's status changed. Three security findings were fixed in the same round and
are recorded as deviations, not checklist items: the schedule CronJob pods' borrowed egress
(A5-review-H-3), `get_run_trace`'s domain-wide scope gate on an agent run (A5-review-M-1) and the
`evaluate` route's ungated body `runId` (A5-review-M-3). A5-11 is rewritten: `grant-rehydrate.ts`
was dead code on the agent path, not an open hole, and is deleted.

### 2026-11-13 — Part D, agents half (same branch, still no cluster)

**Closed:** A2, A3, A33, X1, X2 (unit half) and X9. Every mutation of an agent system is now a
commit in the owning domain's repository — the same repository the dbt project lives in, under an
`agents/` subtree the git store protects from the whole-tree writer and vice versa. The decisive
difference from the data half is that the agents store's `writeThrough` takes a **required** change
descriptor, so an undecided new writer fails to COMPILE, not merely to test.

**Still open, with the exact gap named:**

- **A4** — `graph.json` (the compiled IR) is committed and readable, and the whole repo exports as
  a tar, but running a system outside the OS still needs `buildGraph`, the governed executor and
  the LiteLLM credential. A standalone `graph.ts` + thin runner is unbuilt (deviation D-8).
- **X2's `kind` half** — isomorphic-git speaks only smart-HTTP, so the plan's "local bare remote"
  is not a valid remote; the unit half uses a fake transport at the library boundary and the real
  push needs a git server (deviation D-12).
- ~~**X9's handler half**~~ — **DONE in the B4 review round (E-1).** The engine bounded the RUN
  while `query_data` ran an unbounded Trino query. The query-tool now carries both ceilings — the
  `query_max_run_time` session property (so TRINO abandons the statement) with a `request_timeout`
  5 s longer (so the client cannot orphan it) and a `max+1` fetch that reports `truncated` with the
  limit. Deviation D-11 is closed.
- **A2/A33's `kind` halves** — the commands are in `docs/components/os-ui.md` → "Agent systems in
  git"; no cluster was available in this worktree.

### 2026-11-13 — end of Part F (iteration 1)

Scored independently against `feat/engine-rebuild` at **`6d6c1391`**, **no cluster available**.
Every row claiming `true (test: <file>)` was re-verified by OPENING the cited test and reading what
it asserts, not by trusting the citation — which is how A22's and D10's citations were found to
name tests that did not exist. The full suite was run once at the start and once at the end; per-file
otherwise.

#### Gates

| Gate | At `6d6c1391` (start) | At the end of Part F |
|---|---|---|
| `cd os-ui && npx tsc --noEmit -p tsconfig.json` | 0 errors | 0 errors |
| `npm --prefix os-ui test` | 5308 tests, 5304 pass, **0 fail**, 4 todo | **5320** tests, 5316 pass, **0 fail**, 4 todo |
| `node scripts/check-structure.mjs` | ok — 419/421, 1/1, 200/207, 1235/1240 | ok — **419/419, 1/1, 200/200, 1235/1235** (re-locked) |
| `bash os-ui/scripts/gate.sh` | exit 0 — 416 tests, 412 pass, 0 fail, 4 todo | exit 0 — **427** tests, 423 pass, 0 fail, 4 todo |
| `helm lint … -f values.local.yaml` (defaults) | 0 failed | 0 failed |
| … `--set osUI.worker.enabled=true` | 0 failed | 0 failed |
| … `--set osUI.dataProjectGit.enabled=false` | 0 failed | 0 failed |
| `images/extensions/query-tool` (python3.11, per file) | 4 files OK (**7 failures under one discovery pass** — see F-4) | 4 files OK |
| `images/extensions/dagster/tests` (python3 + pyyaml) | 45 tests OK | **46** tests OK |
| `node scripts/check-litellm-allowlist.mjs` | PASS | PASS |

**Tests are not type-checked, and do not type-check.** `os-ui/tsconfig.json` excludes
`**/*.test.ts`. A temporary config that INCLUDES them reports **599 errors**: 510 are one systemic
cause (a test-local `CurrentUser` object literal omits `allDomains` / `activeDomain`, which the
type requires), 18 are deliberate writes to `readonly` config fields, and 2 were real — one dead
file (deleted, F-1) and one stale `@tabs/data/lib/types` specifier in
`tabs/data/lib/model-view-collision.test.ts` (type-only, so it erases at runtime and silently
types as `any`). Deviation F-5; an iteration-2 item, not a Part F change.

**The two cross-cutting rules every reviewer kept hitting: clean.** No `.test.ts` imports a `.tsx`
or a Next.js `route.ts` (the one `route`-shaped import is `@core/runtime/stage-route`, a lib
module; the one `.tsx` hit is a string in a generator assertion) — after deleting the one file that
DID import its route (F-1). No TS parameter properties in any `core/` or `tabs/` source (the only
match is a comment saying a class deliberately avoids one). No `-c core.hooksPath` anywhere.

#### Counts — 60 items

**true 50 · partly true 5 · untestable here 4 · false 1**

Counting convention, unchanged from the A5 report: **true** = every clause testable in this
environment passes (a clause that needs a cluster is listed below as residue, not as a failure);
**partly true** = a clause testable here does not pass; **untestable here** = the item has no
clause testable here at all.

- Part 1 (A1–A33): true 30 · partly 1 (A4) · untestable here 2 (A18, A29)
- Part 2 (D1–D18): true 13 · partly 4 (D8, D12, D15, D17) · untestable here 1 (D10)
- Part 3 (X1–X9): true 7 · untestable here 1 (X5) · false 1 (X6)

**Closed in this pass:** **X7** (`false` for everything but data → **true for all 113 tools**),
**A4** (`false` → `partly true` — the artefact now runs from a plain checkout), **X4** (the ratchet
baseline re-locked downward so it bites), **A22** (its cited test did not exist; now it does),
**D10's unit-side claim** (the image tag is now actually asserted).

#### Every non-true item, one line each

Class: **(i)** cluster-only · **(ii)** a deliberate deviation with its id · **(iii)** a real local gap.

| # | Gap | Class |
|---|---|---|
| A4 | The runner exists and reaches END from a plain checkout, but it calls the OS's `buildGraph`; "executes with **LangGraph alone**" needs a standalone `graph.ts` emitting LangGraph calls directly. | (ii) D-8 |
| A18 | A run longer than the 300 s request cap completing with no client attached cannot be produced without a cluster and a genuinely >6-minute run. | (i) |
| A29 | Gateway spend per domain and per agent being non-zero in the mirror needs a cluster that actually billed a run. | (i) |
| D8 | The script is proven by unit (`current` is repointed only after `dbt parse` succeeds); the BEHAVIOUR — push a broken model, schedules keep running on the previous commit — needs a cluster. | (i) |
| D10 | The image's drivers and the four-place tag agreement are now asserted offline; "completes a run" needs a cluster (`import psycopg2, dagster_dbt, trino`, then `<domain>__all` → SUCCESS). | (i) |
| D12 | The `/execute` CTAS path is still present and an INTERACTIVE build runs it unconditionally before launching the equivalent dbt assets, so a git-first install has two materialisers for a button press. Retained by decision: `/execute` also carries `apply_quality_fixes`' MERGE, physical deletes, the warehouse import and the promote/publish CTAS, and the CTAS build is what makes the honesty gate possible. | (ii) B4-6 / B4-7 |
| D15 | The offline half (same projection, aliases, FROM+JOIN sequence, ON predicates, WHERE conjuncts, GROUP BY) is true across 3 fixtures plus a negative control; the ROW half (`EXCEPT ALL` both ways = 0 rows) needs a cluster. Deliberately a translation gate, not a row gate. | (ii) B3-7 + (i) |
| D17 | `get_dagster_run` does not exist, so an MCP client that launched a build cannot poll that run id — `get_sync_status(datasetId)` is the only run read. (`dbt_run`/`dbt_test`/`dagster_materialize` are deliberately absent: they address asset keys, not objects, and would bypass the dataset guard.) | (iii) + (ii) B4-1 |
| X5 | The whole deployed-version check. The exact ordered list now exists as Part C of the plan; nothing in it has been executed. | (i) |
| X6 | The final PDF is unwritten — Part E is written last, from the shipped code, by design. | (iii) |

#### Findings that are not checklist rows, carried into iteration 2

- **An existence leak in the software tab (F-3).** An app that exists but the caller cannot see is
  `not_found` from the read/build doors and `forbidden` from `request_deploy`, `start_preview`,
  `set_app_spec`, `use_connection`, `use_data`, `use_knowledge`, `use_as_data` and `archive` — so
  the write doors tell an enumerating caller the app exists while the read doors deny it. Every
  other tab is consistent. Pinned per tool in `core/mcp/mcp-conformance.test.ts` so it cannot
  drift; not changed, because which convention wins repo-wide is a decision, not a bug fix.
- **The Python suites ran in no gate (F-4), now in CI** — and they cross-contaminate: the four
  query-tool modules patch the same `app` module at import time, so one discovery pass over the
  directory fails 7 of the 12 budget tests that all pass individually. CI runs them per file; the
  isolation defect is open.
- **A27's named gap stands.** `indexWorkflow`, `indexDomain` and `indexAsset` take no caller at
  all, so `PLATFORM_CALLER = { userId: 'system', domain: 'platform' }` bills them as
  `user os-system` + `domain:platform` — per-surface attribution, not per-user.
- **A13/A2-14: no retention.** LangGraph checkpoints keep raw tool results in `agent_runs`
  indefinitely, and `run_events` with them.
- **A14's unit half is narrower than its English.** `worker-loop.test.ts` injects a mock `execute`
  that calls `store.requeue` directly, so it proves the loop's contract, not that the real executor
  detects SIGTERM at the right moment. Only the `kind` half asserts that link.
- **X3 was audited claim by claim** (20 checkable claims across the six `docs/components/*.md`,
  `ARCHITECTURE.md`, four tab READMEs, `README.md` and the CHANGELOG). 19 were true against the
  tree. One was false and is fixed: `tabs/data/manifest.ts` listed `mcpTools: ["data-query",
  "dataset-write"]` — a name no module or bundle has ever had, contradicting the README that calls
  the manifest authoritative. A second was found by the tripwire written to stop it recurring:
  `tabs/connections/manifest.ts` listed `connection-lifecycle`, whose module was folded into
  `discovery-connection-tools.ts`. Both corrected, and `core/mcp/tabs.test.ts` MANIFEST-MCP now
  fails if any manifest names a tool module that does not exist.

#### Recommendation

**iteration 2 needed: yes.** Not because a gate is red — every gate is green — but because the
largest single block of evidence (everything marked `(i)`) has never been executed anywhere, and
because two findings from this pass are security- or correctness-shaped rather than cosmetic.
Ordered, with estimates:

| # | What | Closes | Est. |
|---|---|---|---|
| 1 | **Deploy once and execute Part C.** It is written as an ordered, executable list with expected outputs. | A14, A18, A29, D8, D10, D15's row half, D16's live half, X5, and the `kind` halves of A2/A16/A19/A24/A26/A28/A30/A32/A33, D1/D5/D6/D9/D11/D12/D14/D17/D18, X2 | 3 h cluster + ~25 min build |
| 2 | **Converge the software foreign-object convention (F-3).** Decide `not_found` (hide existence, the read doors' behaviour) or `forbidden`, apply it to the 8 write doors, update `SOFTWARE_FOREIGN` to a single expectation. | the existence leak | 2 h |
| 3 | **Make the query-tool tests hermetic (F-4).** Per-test env + `importlib.reload`, then collapse CI's per-file loop to one pass. | the isolation defect | 1.5 h |
| 4 | **Add `get_dagster_run`.** An MCP run-read addressed by the run id a build returns, under the dataset guard. | D17 | 2 h |
| 5 | **Type-check the tests (F-5).** Fix the systemic `CurrentUser` literal cause (a `asUser()` helper or optional fields), drop the `**/*.test.ts` exclude, make `tsc` cover tests in `gate.sh`. | 599 latent errors | 4 h |
| 6 | **Retention for `checkpoints` and `run_events` (A2-14).** A job that drops finished threads older than N days, plus a bound on stored tool results. | the A13 follow-up | 3 h |
| 7 | **Per-user attribution at the three index sites (A27).** Thread the acting user into `indexWorkflow`/`indexDomain`/`indexAsset`. | A27's named gap | 2 h |
| 8 | **Write Part E (the PDF).** Read-only agent, one chapter per tool, from the shipped code. | X6 | 6 h |
| 9 | **A standalone `graph.ts` + thin LangGraph-only runner (D-8).** Emit LangGraph calls directly from the IR so the artefact needs no OS code. | A4 fully | 6 h |
| 10 | **A `relationships` quality rule** (a referenced dataset + column resolved through `canView`). | D5's follow-up | 3 h |
| 11 | **Column-level lineage (B3-6).** | D16's follow-up | 4 h |

Items 1–4 are the ones that change what is KNOWN rather than what is built; do them first. On the
protocol's stopping rule: iteration 1 closed five items, so the "two consecutive iterations close
nothing" condition is nowhere near met.
