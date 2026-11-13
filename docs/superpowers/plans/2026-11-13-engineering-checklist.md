# Definition of done: what must be true for AI-product and data-product engineering in the OS

> Companion to `2026-11-13-engine-rebuild.md`. This is the **acceptance checklist** the programme is tested against at the end of every iteration. Each item states **how it is tested**, so "done" is a measurement, not an opinion. An item that cannot be tested in the environment available is marked `untestable here` with the reason, never silently ticked.

**The standard:** a data or AI engineer who knows LangGraph, Langfuse, LiteLLM, dbt, Dagster, Trino and git should be able to read what the OS produced and recognise their own practice. The OS adds governance, identity and ease of use **on top**; it does not reinvent how the tools work. Where the OS still does something its own way instead of the tool's way, the checklist item fails and the gap report names it.

Legend for the **Test** column: `unit` = automated test in the suite · `kind` = verified against the local kind cluster · `stackit` = verified against production after deploy · `inspect` = read the generated artifact or the source and confirm · `mcp` = exercised through the OS MCP as a client would.

---

## Part 1 — AI products (agent systems)

### 1.1 Definition and versioning

| # | Must be true | Test |
|---|---|---|
| A1 | An agent system is defined by a single `system.yaml` that fully determines its graph: agents, entrypoint, edges with guards, grants, safety preset, state channels. No behaviour lives outside the file. | `inspect` the schema; `unit`: parse → compile → build is deterministic (same YAML, same graph). |
| A2 | Every save of a system, from the UI or the MCP, is a **git commit** in the owning domain's repository, authored as the acting user, with a message naming the action and its origin (`ui:agents` or `mcp:<tool>`). | `unit` on the commit builder; `kind`: save twice, `git log` shows two commits with the right author and message. |
| A3 | The repository holds the human-readable artifacts an engineer would commit: `system.yaml`, the compiled graph as `graph.ts` (or an equivalent readable form), and a README. Nothing opaque. | `inspect` a checkout of a domain repo. |
| A4 | A system can be exported and run outside the OS: the compiled graph plus a thin runner compiles and executes with LangGraph alone, against LiteLLM, with tools stubbed. | `kind`: export, `npx tsx` the runner, reaches END. |
| A5 | Existing `system.yaml` files from before the rebuild load and run unchanged. | `unit` golden fixtures from the old walker still pass. |

### 1.2 Execution is real LangGraph

| # | Must be true | Test |
|---|---|---|
| A6 | The production run path executes a compiled `StateGraph` from `@langchain/langgraph`. No hand-rolled walk remains on any reachable path. | `inspect`: grep for `nodeOrder`, `runAgenticGraph` BFS, `run-graph.ts`, `interpreter.py` → absent; `unit`: the run route dispatches to `buildGraph`. |
| A7 | Supervisors **decide** which member runs next; members are not visited in declared order. | `unit`: a scripted supervisor choosing `writer` first visits `writer` first. |
| A8 | `when` guards route: a handoff with a false guard does not visit its target. | `unit`: the formerly-`todo` HANDOFF-GUARD test passes. |
| A9 | State channels declared in `system.yaml` exist in the graph state with the declared reducer. | `unit`: `add_messages` appends, a last-value channel overwrites. |
| A10 | Loops are bounded: the team step budget maps to `recursionLimit`, and exhaustion is a graceful stop that returns what completed. | `unit`. |
| A11 | Tool calls use the model's native tool-calling, with the text fallback only when the model rejects the tools parameter. | `unit`: both branches exercised; `kind`: a run against the STACKIT model succeeds. |
| A12 | Planner and executor tiers are separate models and configurable per agent. | `inspect` + `unit`. |

### 1.3 Durability and human-in-the-loop

| # | Must be true | Test |
|---|---|---|
| A13 | Every superstep is checkpointed to Postgres; **thread id = run id**. | `kind`: `SELECT count(*) FROM checkpoints WHERE thread_id = <runId>` grows during a run. |
| A14 | A run interrupted by a pod restart or the request cap **resumes** from its last checkpoint and reaches the same end state as an uninterrupted run. | `unit` P2 **green**; `unit` A4: a SIGTERM between supersteps returns the job to `queued` as a `resume` and the events already written stay durable (`worker-loop.test.ts`); **`kind` half `untestable here`** — "a rolling restart loses no run" needs a cluster: enable the worker (`--set osUI.worker.enabled=true`), start a long run, `kubectl -n agentic-os rollout restart deploy/os-ui-worker` while `run_jobs.status='running'`, then assert the old pod logged "SIGTERM — finishing the current superstep", the row returned to `queued`/`kind=resume`, `locked_by` changed, `run_events` continued at the next `seq`, and the final `done` reports the same `path` as an uninterrupted run. Full commands: `docs/components/os-ui.md` → "Verify it in a cluster". |
| A15 | A write that needs approval **pauses the run** via `interrupt()`; nothing executes before the decision. | `unit` P3. |
| A16 | Approving from Governance **resumes the run** and the approved write executes exactly once, as the original runner, not the approver. | `unit` P3; `kind`: end-to-end approve → the artifact exists, authored as the runner. |
| A17 | Rejecting returns a typed result to the model and the run continues. | `unit`. |
| A18 | Runs longer than the request cap complete (worker mode). | **`untestable here`** — needs a cluster and a genuinely >300 s run. `kind`: `--set osUI.worker.enabled=true`; `kubectl -n agentic-os logs deploy/os-ui-worker \| grep 'boot:'` must say `checkpointer=postgres jobs=postgres`; start a >6-minute run from the Agents tab and **close the browser tab**; then `psql -d agent_runs -c "select status from run_jobs where run_id='<RUN>'"` → `done` and `select seq,event,at from run_events where run_id='<RUN>' order by seq` → a terminal `done` more than 300 s after the first event, with no client attached. Re-attach mid-run with `GET /api/agents/systems/<id>/run/stream?runId=<RUN>&afterSeq=<n>`. Full commands: `docs/components/os-ui.md` → "Verify it in a cluster". Covered by unit tests here: enqueue → claim → events → settle, the stale-lease re-queue-once-then-fail, and P1–P3 in `inline` mode. |

### 1.4 Observability is Langfuse, used as Langfuse

| # | Must be true | Test |
|---|---|---|
| A19 | **One Langfuse trace per run**, trace id = run id; nodes are spans, model calls are generations with token usage, tool calls are spans carrying the governance decision. | `kind`: fetch `/api/public/traces/<runId>`, assert the observation tree. |
| A20 | The run's "Trace" link opens that trace, not a list. | `inspect` the URL built in code; `kind`: click-through. |
| A21 | Traces carry `userId`, `sessionId`, and tags for domain, agent, run. | `kind`: read the trace. |
| A22 | The LLM-judge verdict is written as a Langfuse **score** on the run trace. | `kind`: `/api/public/scores?traceId=`. |
| A23 | No Langfuse query in the OS returns another user's observations: every read is filtered by run, user or scope. | `unit` on the diagnostics route; `inspect` every `/api/public/` call site. |
| A24 | Model calls are not double-traced unlinked: LiteLLM's callback generations and the OS's spans share the run trace. | `kind`: one trace, generations nested. |

### 1.5 Models are LiteLLM, used as LiteLLM

| # | Must be true | Test |
|---|---|---|
| A25 | **No inference path uses the master key.** Only gateway administration does. | `unit` MODEL-KEY repo-wide: the only files referencing `litellmMasterKey` are the admin read/write clients and key provisioning. |
| A26 | Every run uses a **per-principal key** (per agent when it exists, else the shared agent key), with an allowlist and budget enforced by the gateway. | `unit`; `kind`: a run with an over-budget key fails with a typed `budget_exceeded`, not a raw 400. |
| A27 | Every model call carries `user` and tags `domain:`, `agent:`, `run:`, including from the Python runtime if any remains, and from embeddings and classify. | `unit`: assert on the outgoing request body at each call site. |
| A28 | The key allowlist always covers every model alias the OS can request, including router fallbacks. | `unit` chart test; `stackit`: the provisioning Job log shows the full list. |
| A29 | Gateway spend per domain and per agent is real and visible on Platform and Monitoring, read from LiteLLM, not computed by the OS. | `kind`: after a run, the mirror shows non-zero spend for that domain and agent. |
| A30 | Failures are observable: LiteLLM `failure_callback` is configured; a rejected call appears in Langfuse. | `inspect` chart; `kind`. |
| A31 | A failed embedding never silently indexes substitute vectors; the fallback is explicit and labelled, and 4xx errors throw. | `unit`. |

### 1.6 Same path through the MCP

| # | Must be true | Test |
|---|---|---|
| A32 | `run_agent_system` returns `runId` and `traceUrl`; `get_agent_run` returns state and held approvals; `resume_agent_run` resumes; `decide_approval` resumes the thread. | `mcp`: drive a full run → hold → approve → completion with the MCP alone. |
| A33 | A system created through the MCP produces the same git commit, graph, trace and spend attribution as one created in the UI. | `mcp` + `kind`: compare artifacts byte-for-byte except timestamps. |

---

## Part 2 — Data products

### 2.1 Definition and versioning

| # | Must be true | Test |
|---|---|---|
| D1 | A data product is a **dbt project** an engineer could clone and run: `dbt_project.yml`, `profiles.yml` with a Trino target and no inlined credentials, `models/`, `schema.yml`. | `inspect` a generated project; `kind`: `dbt parse` and `dbt compile` succeed in the dbt image. |
| D2 | Every change to a dataset, composition, quality rule or schedule, from the UI or the MCP, is a **git commit** in the domain repo, authored as the acting user, naming the action and origin. | `unit`; `kind`: `git log`. |
| D3 | Regeneration is idempotent: the same OS state produces a byte-identical project. | `unit` golden files. |
| D4 | A composition is a dbt **model** that `{{ ref() }}`s its sources; the SQL body is the governed projection the OS compiles, inside a model, not an ad-hoc CTAS. | `inspect` the model file; `unit`. |
| D5 | Quality rules are `schema.yml` **tests** (`not_null`, `unique`, `accepted_values`, `relationships`), and `dbt test` runs them. | `kind`: a violated rule fails `dbt test`; the failure is visible in the OS. |
| D6 | Incremental sync semantics (cursor, late-data lookback, batch idempotency) are expressed as dbt **incremental model config**, not bespoke SQL. | `inspect` + `unit`; `kind`: a second run appends only new rows and re-delivers the lookback window once. |

### 2.2 Scheduling is Dagster, used as Dagster

| # | Must be true | Test |
|---|---|---|
| D7 | A sync schedule is a **Dagster schedule** over `dbt_assets` for the domain's project plus one asset per external source. No Kubernetes CronJob provisioning remains for syncs. | `inspect`: `sync-cron.ts` absent; `kind`: the Dagster UI lists the schedule. |
| D8 | Dagster loads the domain's code location **from a git commit**, and a commit that fails `dbt parse` does not replace the last good location. | `kind`: push a broken model, schedules keep running on the previous commit, the OS shows the parse error. |
| D9 | Run status, materialisations and failures in the OS are **read from Dagster** (GraphQL), not a parallel OS ledger. | `inspect`: no OS-native sync run store remains; `kind`: trigger in Dagster, the OS shows it. |
| D10 | The Dagster image works: it has its Postgres driver and completes a run. | `kind`. |
| D11 | UTC schedules and skipped-missed-slot semantics are preserved. | `inspect` the generated schedule config. |

### 2.3 Execution is Trino, governed

| # | Must be true | Test |
|---|---|---|
| D12 | dbt executes on Trino through `dbt-trino`; the OS does not run its own CTAS for anything a model covers. | `inspect`: the old CTAS execution path deleted after parity; `kind`: `dbt run` materialises the Iceberg table. |
| D13 | The `iceberg.<schema>.<table>` naming and the personal/domain lane model are honoured by every generated model. | `unit`. |
| D14 | Row-level security and OPA still apply to every read, including reads dbt performs; nothing bypasses the governed boundary. | `inspect` the execution principal and target; `kind`: a user without a grant cannot cause a model to read the ungranted table. |
| D15 | Parity: the same composition yields the **same rows** through the old path and through `dbt run`, before the old path is deleted. | `kind` parity test with a fixture dataset. |
| D16 | Lineage shown in the Data tab comes from dbt's `manifest.json`. | `inspect` + `kind`. |

### 2.4 Same path through the MCP

| # | Must be true | Test |
|---|---|---|
| D17 | MCP tools map one-to-one to engineer operations: `dbt_run`, `dbt_test`, `dagster_materialize`, `get_dagster_run`, `get_lineage`, under the same governance as the UI. | `mcp`: drive define → generate → materialise → read status with the MCP alone. |
| D18 | A data product created through the MCP produces the same commit, project and Dagster definitions as one created in the UI. | `mcp` + `kind`: byte-for-byte except timestamps. |

---

## Part 3 — Cross-cutting

| # | Must be true | Test |
|---|---|---|
| X1 | **Git everywhere, automatically.** No OS or MCP write to an agent system or data product bypasses the commit; there is one code path for commits and every writer uses it. | `unit`: a test asserts every store write goes through the commit builder; `inspect`. |
| X2 | The domain repo can be mirrored to an admin-configured remote, and the OS pushes after each commit when one is set. | `kind` with a local bare remote. |
| X3 | Documentation describes what ships: README, `docs/components/{langfuse,litellm,dagster,dbt,trino,os-ui}.md`, tab READMEs, `ARCHITECTURE.md`, licences, SBOM. No claim without code behind it. | `inspect`, claim by claim, as the audit did. |
| X4 | The structure ratchet, the regression gate and the test suite are green, and the ratchet baseline is lower than at the start of the programme. | `unit`. |
| X5 | The deployed version on STACKIT passes: health; one agent run with hold → approve → resume → one trace; one Dagster-scheduled sync; one dbt composition; the key allowlist from the Job log. | `stackit`. |
| X6 | The final PDF exists and, for each tool, maps engineer practice → OS source → tool functions used → what the OS adds. Every reinvention that remains is listed, not hidden. | `inspect`. |

---

## Iteration protocol

1. **Test.** At the end of a full pass over Parts A and B, a read-only agent evaluates every item above against the branch and, where available, kind and STACKIT. It produces a **gap report**: for each failing or `untestable here` item, the evidence and the smallest change that would make it pass.
2. **Plan.** The gaps are grouped into a new iteration appended to `2026-11-13-engine-rebuild.md` as "Iteration N", with phases, gates and the items they close.
3. **Design and implement.** Agents execute the iteration: implementation agents in parallel **only on disjoint areas** (agent side vs data side), each in its own worktree, merged by the coordinator; reviewer and test agents read-only and freely parallel. Docs in the same commit.
4. **Repeat** until no item fails for a reason the environment permits fixing, or until two consecutive iterations close no further item. Untestable-here items are listed in the final report with what would be needed to test them.
5. **Deploy** after each iteration whose gates are green, keeping the engine flag's default on the old walker until A5–A17 pass; flip it in the iteration that passes them.

## Gap reports
(Appended by the test agent at the end of each iteration: date, items passed / failed / untestable, the gap list.)
