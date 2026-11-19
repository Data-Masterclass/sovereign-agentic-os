# Agent engine: delivery plan

> **Status: agreed direction, 2026-11-19. Phase 0 is in progress.** This plan follows
> [`design.md`](design.md), whose decisions the owner took on 2026-11-19 (D10 to D22 there).
> Phases 1 to 5 have not started. Details may change as each phase is built and measured.

Written 2026-11-19 against commit `b47e2cd5`.

## How to read this

- There are six phases. Each one can be shipped by itself and leaves the product better than before.
- Each phase lists: what is in it, what the user will notice, how it is tested, what can go wrong, what is deliberately left out, and an **exit check** that must pass before the phase counts as done.
- Defect numbers (F1, S5 and so on) refer to [`known-defects.md`](known-defects.md).
- Every pull request that changes how agents behave also updates the matching row in these documents. See [`README.md`](README.md).

## Work merged or in progress since the verified commit

State on 2026-11-19, evening. The plan builds on these and does not repeat them. What each one
changes is taken from the pull request's own report. The new `main` was not re-read for this plan.

| PR | State | What it changes | Belongs to |
|---|---|---|---|
| #88 | **merged**, not yet in a release | The shared agent key allows 1,000,000 tokens and 300 requests per minute (was 200,000 and 120). | Phase 0 |
| #91 | **merged**, not yet in a release | A failed agent stops the run. A rate-limit 429 is waited out, with a visible event. Tool descriptions are sent once. The agent's `list_files` shows only the granted folder, in compact form. The step-limit display of `get_agent_run` is corrected. A test measures the token footprint of the 12-invoice run. | Phase 0 and Phase 1 |
| #92 | **merged**, not yet in a release | System-key caps come from the chart (`osUI.agentSystemKey`, default 5 USD per 7 days, 300 requests and 1,000,000 tokens per minute). Rebuild updates an existing key through `/key/update`. Build rows say Created, Updated or Already in place. | Phase 0 and Phase 4 |
| #89 | open | Confirmation gate for Ask the OS. | Owner decision D2, outside this plan |
| #90 | open | Pins the `@sovereign-os` npm scope. | Outside this plan |

Already shipped and live (image tag 0.9.12, as reported on 2026-11-19): reading text from PDFs
with Docling, refreshing the worker's copy of system records, hardening of the older approvals
route, a deploy confirmation in the Team panel, withdrawing held calls, and the list of models that
may be sent images (`os-ui/core/models/capabilities.ts`).

## The four kinds of test used in every phase

| Kind | What it is | Where it runs |
|---|---|---|
| **Unit test with a scripted model** | The model is replaced by a script that returns fixed replies (text, tool calls, broken arguments, errors). No network. | CI, on every pull request |
| **Checkpoint and resume test** | A run is stopped at a chosen step (pause, crash, shutdown) and continued. The test checks that nothing is lost and no write happens twice. | CI |
| **Trajectory test** | The test checks the order of steps and tool calls of a whole run against an expected order. | CI |
| **Live smoke run** | One real run on the test environment with the real gateway and models. A person looks at the result and the trace. | By hand, before each release |

---

## The acceptance benchmark: "12 invoices"

One benchmark is used to judge Phases 1 and 2.

**Definition.**

- **Team:** two agents. `reader` may use `get_file` (and the listing tools that come with it). `writer` may use `upload_file`. `reader` hands off to `writer`.
- **Input:** a folder with 12 short invoices that are already extracted as text. Each is at most 4,000 characters. The files are synthetic and are kept in the repository as a test fixture, so every run uses the same input.
- **Task:** "Read the 12 invoices in the folder. For each one extract supplier, invoice number, date, net amount, tax, gross amount and currency. Write one table with 12 rows and a totals row, and save it."
- **Expected result:** the run ends as "done". The saved table has exactly 12 rows. Every field equals the fixture's known value. The totals equal the fixture's known totals. No tool call was made outside the granted folder.

**How it is measured.**

| Number | Source |
|---|---|
| Model calls | The gateway's spend records for the tag `run:<runId>`, counted |
| Tokens (in + out) | The same records, summed |
| Peak tokens in one minute | The same records, grouped by minute |
| Wall time | From "queued" to "settled" on the run's job row |
| Outcome | The job's final status plus the field-by-field check of the saved table |

**Where it runs.**

- In CI, with the scripted model. There it checks the number of calls, the size of each request in characters, and the order of steps. It cannot measure real tokens.
- By hand on the test environment, with the real models, before each release. The numbers are written into the table below.

**Numbers.**

The only numbers that exist today come from two different sources. They must not be mixed.

*Source 1: the scripted-model test added by PR #91.* It runs the 12-invoice team with a scripted
model and adds up the size of every request with the repository's own `estimateTokens` (characters
divided by four). It counts **input only**. These are **estimates, not measurements of real tokens.**

| | Estimated input tokens, whole run | Invoices the agents could see | Kind of number |
|---|---|---|---|
| Today (`main` before PR #91) | 199,820 | 9 of 12 | Estimate from the scripted-model test |
| After PR #91 | 136,851 | 12 of 12 | Estimate from the scripted-model test |
| After PR #91 plus a per-agent tool list | roughly 50,000 | 12 of 12 (expected) | **Calculated, not measured.** Not built |

*Source 2: one real run on the production system* (2026-11-19), on the owner's real two-agent
invoice team, not on the fixture: ten model calls, about 185,000 tokens by the gateway's counter,
**failed** on the limit of 200,000 tokens per minute. Wall time was not recorded.

*Targets.* These are **estimates, to be replaced by measurements** from the live benchmark run
(real tokens, input and output, from the gateway).

| | Model calls | Tokens (in + out, from the gateway) | Wall time | Outcome |
|---|---|---|---|---|
| After Phase 1 | at most 30 | at most 80,000 | at most 5 minutes | passes |
| After Phase 2 | about 15 | at most 50,000 | at most 2 minutes | passes |

Three honest notes:

1. The scripted-model numbers and the gateway's numbers are not comparable one to one: different input (fixture versus real documents), estimate versus real tokenizer, input only versus input and output.
2. Whether the Phase 1 target of 80,000 is still the right one, given the calculated 50,000 for a per-agent tool list alone, has to be decided when the first real measurement exists.
3. The first task of Phase 1 is therefore a live run of the fixture on the current `main`, recording calls, tokens, peak minute and wall time.

---

## Phase 0: stop the bleeding

**Status: in progress** (started 2026-11-19).

**Goal:** close the security holes and the failures that make runs die or misbehave. No new features.

**Work now under way.** No result is claimed for any of it: nothing in this table is merged,
released or verified yet. The state of every row is "in progress, PR not yet open".

| Track | Work under way | Scope rows | State |
|---|---|---|---|
| Gateway | Gateway hardening and upgrade, with a rehearsed in-place upgrade test first. A resetting budget on the shared key. Model prices in the gateway. | 0.1, 0.3 | in progress, PR not yet open |
| Per-system keys | Per-system key handling. | 0.2 | in progress, PR not yet open |
| Engine correctness | Grant enforcement. Argument validation with a repair turn. Handling of cut-off and empty replies. Valid hand-off conditions from the team proposer. A truthful "failed" status for failed runs. | 0.4, 0.6, 0.7, 0.8 | in progress, PR not yet open |

Not yet started in Phase 0: Build verifying what a run uses beyond the new row wording (0.9).
Rotating the gateway's master key and any load test against a live service need the owner's go
each time ([`design.md`](design.md), section 8).

Security items are tracked privately until a fix is released. The security rows below are therefore named
only in general terms.

**Scope**

| # | Change | Fixes |
|---|---|---|
| 0.1 | Gateway hardening and upgrade (decisions D11, D12). | Tracked privately |
| 0.2 | Per-system key handling (decision D13). | Tracked privately |
| 0.3 | Budgets reset. Limits and budgets come from settings, not from code. Rebuild updates an existing key. Real prices in the gateway. (On main: PR #88 for the shared key's limits; PR #92 for system-key caps from the chart, a 7-day budget window and key update on Rebuild. Still open: the shared key's budget window, and prices in the gateway.) | F5, S5 |
| 0.4 | A failed agent stops the run. A run that failed is stored as failed. (On main: PR #91 stops the run. Whether the job is then stored as failed was not checked.) | F1, part of F15 |
| 0.5 | On "too many requests": tell budget from rate limit; wait and retry. (On main: PR #91 waits out a rate-limit 429 with a visible event.) Parking a throttled run comes in Phase 2. | F2 |
| 0.6 | Tool arguments are checked before the tool runs. Broken arguments are not executed; the model gets one repair turn. The stop reason of a reply is read. An empty reply is not a success. | F10 |
| 0.7 | Grant enforcement at execution time. | Tracked privately |
| 0.8 | The team proposer stops writing invalid hand-off conditions. | F0 |
| 0.9 | Build verifies what a run uses: one test call per model alias with a tool attached, and the checks the executor applies. Rows that verify nothing are removed or relabelled. (Partly on main: PR #92 makes the Build rows say Created, Updated or Already in place.) | F13 (first half), S1, S6 |

**What the user will notice**

- Runs no longer die on the first "too many requests".
- A run with a failed agent stops and says why, instead of carrying on.
- A system no longer stops for ever after spending 5 USD.
- "Use this team" on a proposed team leads to a team that builds.

**Tests**

- Scripted model: a 429 with a rate-limit text, a 429 with a budget text, broken argument JSON, valid JSON with wrong fields, an empty reply, a cut-off reply, an act-step error on the first of two agents.
- Checkpoint and resume: per-system key handling across a restart of the web process and a run in the worker.
- Trajectory: two agents, the first fails in the act step; the second must not start.
- Live smoke run: one small team; check the key used and the budget's reset date in the gateway.
- Gateway upgrade: a rehearsal on the test environment with a copy of the gateway's database; check keys, budgets, request tags and that gateway records still land inside the run's trace.

**Risks**

- The gateway upgrade spans about 18 minor versions. From 1.103.0 a setting in the config file wins over the value in the database, which can change models an admin added by hand.
- From 1.104.0 the old Langfuse sender changes how it sends. The link between gateway records and the run's trace must be re-tested. If it breaks, gateway records appear as separate traces until Phase 3.
- Grant enforcement can change how existing teams behave. Mitigation: a logging-only period first.
- Key changes while a run is in flight. Mitigation: switch keys at Rebuild, remove the old key a day later.

**Not included:** smaller prompts beyond what PR #91 brings; parallel work; the tracing changes of Phase 3; any builder UI beyond honest Build rows.

**Exit check**

1. The security items tracked privately for this phase are fixed and released.
2. All Phase 0 tests are green in CI, and the live smoke run passes.

---

## Phase 1: token economy

**Goal:** the same work with far fewer tokens. No change to how a team is drawn.

**Scope**

| # | Change | Fixes |
|---|---|---|
| 1.0 | Run the "12 invoices" fixture live on the code as it is after Phase 0. Record calls, real tokens, peak minute and wall time. Keep the scripted-model footprint test from PR #91 as the CI guard. | Baseline |
| 1.1 | Prompt diet: each tool described once; an agent sees only its own tools; the software-team sentence is removed from other teams. (On main: PR #91 sends tool descriptions once. The per-agent tool list is still open; it is the step calculated at roughly 50,000 tokens above.) | F7 |
| 1.2 | Results by reference: large tool results are stored once outside the conversation; the conversation and the checkpoint hold a reference. | F9, checkpoint size |
| 1.3 | Old tool results are cleared from the model's input (the last 3 stay). A per-agent input budget (24,000 tokens) with summarising above it. The `tools` part is counted. | F9 |
| 1.4 | The plan step becomes optional and is off by default. When on, it uses the agent's own model. | F11 |
| 1.5 | Scoped listings: a listing tool returns only what is inside the granted folders, in pages. (On main for the agent's `list_files`: PR #91.) | Token use |
| 1.6 | Hand-off passes the previous agent's answer, its structured results and references, not a cut-down copy. | F8 |
| 1.7 | Lower default limits: 10 tool rounds per agent, 60 steps per run. | F9 |

**What the user will notice**

- Runs are faster and cost less.
- A team that reads documents and hands them on works: the second agent can see what the first one read.
- The run view shows tokens used per agent.

**Tests**

- Scripted model: the size of every request, in characters, stays under a fixed ceiling for the fixture; a tool description appears exactly once per request; a cleared result can be fetched again.
- Checkpoint and resume: stop after the sixth invoice, continue; references still resolve; checkpoint size stays under a fixed ceiling.
- Trajectory: the fixture's sequence of tool calls matches the expected sequence.
- **Measured benchmark:** the "12 invoices" live run before and after. The table above gets real numbers.
- Live smoke run: one team that reads a long document in the first agent and quotes from its middle in the second.

**Risks**

- A model may need a result that was cleared. Mitigation: it can ask for it again; the benchmark's field-by-field check catches silent loss.
- Summaries can drop facts. Mitigation: summarising starts only at the budget, which the benchmark should not reach.
- Without a plan step some agents may act less well. Mitigation: a developer can switch it on per agent; compare benchmark quality with and without.

**Not included:** parallel "for each"; new retry machinery; streaming; any tracing change.

**Exit check**

1. The benchmark passes on the test environment.
2. Its measured tokens are at most 80,000 and no minute carries more than 100,000. If the measured numbers miss this, the phase is not done; the targets may be revised only with the measurement written down.
3. All Phase 1 tests are green in CI.

---

## Phase 2: LangGraph-native engine

**Goal:** rebuild the loop on LangGraph's own parts (option A in the design), remove the second copy of the loop, and add "for each".

**Scope**

| # | Change | Fixes |
|---|---|---|
| 2.1 | One subgraph per agent, with message state. One routing method per step. | F1 for good, F18 |
| 2.2 | `RetryPolicy`, node timeouts and one graph-wide error handler. A throttled run is parked and continues by itself. Time limits consistent with the gateway. | F2 for good, F15 |
| 2.3 | "For each item" with `Send` and a concurrency cap; structured answers per item with one repair turn. | New |
| 2.4 | Approvals by interrupt id with a response schema. An idempotency key on every write. An unknown write outcome stops and asks a person. | S4 |
| 2.5 | Forced tool choice where a call is required (after the gateway test from Phase 0.9). `parallel_tool_calls` sent explicitly. The text fallback keeps gathered results. | F14, S2 |
| 2.6 | Live text for the final answer and tool progress (stream modes). An explicit durability mode. Clean stop on shutdown. | F17 (in part) |
| 2.7 | The tab assistants use the same loop. The old copy is deleted. | F18 |
| 2.8 | Read-only run history from checkpoints. | New |

**What the user will notice**

- A new switch on an agent: "Process each item separately". Twelve documents are handled side by side.
- The answer appears as it is written.
- When the gateway is busy, the run waits and says so, instead of failing.
- After a restart or a crash, a run continues, and a write is never done twice.

**Tests**

- Scripted model: every row of the reply table in [`how-an-agent-runs.md`](how-an-agent-runs.md), section (e), has a test with the new expected behaviour.
- Checkpoint and resume: a crash in the middle of a write (the write must not repeat); a crash in the middle of a "for each" (finished items are not redone); an approval answered twice; an answer for an old pause.
- Trajectory: a three-agent team with a supervisor; a "for each" with one failing item.
- Benchmark: "12 invoices" with the "for each" switch on; measured.
- Live smoke run: the benchmark, plus one run with a held write that is approved and one that is rejected.
- Running-run compatibility: runs parked before the upgrade must be finished or cancelled first. LangGraph cannot continue a paused run whose next step was renamed.

**Risks**

- This is the largest change. Mitigation: the new engine runs beside the old one behind a setting, and the benchmark and trajectory tests must pass on both before the old one is removed.
- Forced tool calls may not work through the gateway for the two models in use. Mitigation: it is tested in Phase 0.9; if it does not work, the repair turn alone has to carry the supervisor and "for each".
- Parked runs at the moment of the switch. Mitigation: drain them first.
- The amount of own code. This is the cost of option A. It is measured at the end of the phase and feeds the "look again at option B" decision.

**Not included:** memory across runs; subagents as tools; any tracing change; builder settings UI (the new settings exist in `system.yaml` and are edited as text until Phase 4).

**Exit check**

1. The benchmark passes with about 15 model calls and at most 50,000 tokens, measured.
2. One loop in the code. `core/runtime/agentic.ts` no longer contains a second one.
3. The crash-during-write test is green.
4. The owner has the numbers needed to look again at option B.

---

## Phase 3: one trace, clean logs

**Goal:** exactly one trace per run and one record per model call, with no document or image content anywhere in the logs.

**Scope**

| # | Change | Fixes |
|---|---|---|
| 3.1 | The OS moves from the old `langfuse` SDK to the new one (version 5). One `mask` function on everything sent. | Tracked privately |
| 3.2 | LiteLLM to 1.109 or later with the `langfuse_otel` sender, content capture off; the old sender is removed. The engine sends the standard `traceparent` header. | S3 |
| 3.3 | The OS stops writing its own second record per model call and its second span per tool call. | S3 |
| 3.4 | Sessions are conversations or schedules, not system ids. | Langfuse map |
| 3.5 | A retention sweep for traces, with the same period as run data. Spend-log retention in the gateway. | Langfuse map |
| 3.6 | Model prices defined in Langfuse from the single price list. | Cost |

**What the user will notice**

- A run's trace shows each model call once, with its real cost.
- Traces show structure and sizes, not content, unless a system is set to the less strict level.
- Old traces disappear after the retention period.

**Tests**

- A recorded-ingestion test: for a scripted run, exactly one trace, one generation per model call, one span per tool call.
- A masking test: a run with a file and an image; no file text and no image data in anything sent.
- Live smoke run: compare one run's token total in Langfuse with the gateway's; they must be equal.
- Whether the new SDK uploads images before or after masking is tested explicitly. The research could not confirm it.

**Risks**

- Running the old and the new gateway sender together logs every call twice. The switch must be one change.
- The tracing code is rewritten; trace reads in the OS (run diagnostics, Monitoring) must keep working.
- A second gateway upgrade.

**Not included:** Langfuse server version 4 (Phase 5); dashboards and alerts.

**Exit check**

1. For the benchmark run: one trace, model-call records equal to the gateway's count, token totals equal.
2. A search of that trace finds no invoice text.
3. Traces older than the retention period are gone.

---

## Phase 4: builder — Simple and Developer settings, staleness, honest Build rows

**Goal:** the settings table in [`design.md`](design.md), section 6, becomes real in the builder.

**Scope**

| # | Change | Fixes |
|---|---|---|
| 4.1 | Simple mode shows the settings marked "shown" with their defaults. Developer mode gets a Settings panel for the rest, each limited by the admin cap. | F12 |
| 4.2 | Admin caps as platform settings. | New |
| 4.3 | Settings that do nothing are removed (`routing.overrides`) or made to work (the agent's role line, access per grant). | F12 |
| 4.4 | Staleness: the builder knows when the definition changed after the last Build. Simple rebuilds on Run; Developer shows "Rebuild needed" (decision D21). | F0b |
| 4.5 | One place for name, visibility, domain and schedule. | F0b |
| 4.6 | Build rows say only what was really verified. The Langfuse row asks Langfuse. A build through MCP is saved. | F13, S7 |
| 4.7 | Golden runs per system and a judge after every run, as options. A fallback model per agent. A daily budget guard and a warning at 80 %. | New |

**What the user will notice**

- Simple mode looks the same, with two more things: the "Process each item separately" switch and the budget line.
- Developer mode has one Settings panel instead of scattered controls, and no control that does nothing.
- "Rebuild needed" appears when it is true.

**Tests**

- Unit tests for every setting: default, range, admin cap, and what happens to an old `system.yaml` without the key.
- A round-trip test: every setting survives save and load of `system.yaml`.
- Trajectory: a system with a golden run; a change to the instructions that breaks it is caught.
- Live smoke run: build a team in Simple from nothing to a passing benchmark without opening Developer mode.

**Risks**

- Old definitions. Every new key needs a default that reproduces the behaviour after Phase 2, so existing systems do not change when they are opened.
- Too many settings. Mitigation: a setting enters the Developer panel only if it is in the table in the design.

**Not included:** memory across runs (decision D18); marketplace changes.

**Exit check**

1. Every row of the settings table is either built, or marked "not built" in the table with a reason.
2. No control in the builder is without effect on a run.
3. A person who has never seen Developer mode can pass the benchmark from Simple mode.

---

## Phase 5: platform upgrades

**Goal:** Langfuse server version 4, before version 3 stops receiving security fixes at the end of January 2027.

**Scope**

| # | Change |
|---|---|
| 5.1 | ClickHouse to 25.12 or later. Langfuse chart to its version 2. |
| 5.2 | Langfuse server version 4 in the mode that accepts old and new input. Data move in the background. |
| 5.3 | The OS reads traces, entries and scores through the newer endpoints. |
| 5.4 | Switch version 4 to its final mode. SDK version 6. |
| 5.5 | LangGraph and its Postgres checkpointer to their current patch versions. |

**What the user will notice:** nothing in the builder. Admins get Langfuse's dashboards, alerts and search.

**Tests**

- A rehearsal on a copy of production data, including the data move and its disk use.
- The recorded-ingestion and masking tests from Phase 3, against version 4.
- Every OS screen that reads traces (run diagnostics, Monitoring, Build's Langfuse row).
- Live smoke run: the benchmark; its trace must look the same as before.

**Risks**

- About three times the ClickHouse disk is needed during the data move.
- The Langfuse chart's major version change is a migration in its own right. It needs a rehearsal and a maintenance window.
- In version 4's final mode the old SDK, the old gateway sender and the old read endpoints stop working. Phase 3 must be complete first.

**Not included:** any Enterprise feature.

**Exit check**

1. Langfuse runs version 4 in its final mode.
2. The benchmark's trace is complete and its totals match the gateway's.
3. No OS screen that reads traces shows an error.

---

## Order and dependencies

| Phase | Needs | Can run in parallel with |
|---|---|---|
| 0 (in progress) | decisions D11, D12, D13, D14, D15, all taken | — |
| 1 | Phase 0.4 to 0.6 | Phase 0.1 to 0.3 |
| 2 | Phase 1; decisions D10, D16, D20 | Phase 3.1 |
| 3 | Phase 0.1; decisions D17, D19 | Phase 2 |
| 4 | Phase 2; decision D21 | Phase 3 |
| 5 | Phase 3; decision D22 | Phase 4 |

All decisions named in this table were taken on 2026-11-19. No dates are given. Phase 5 has the only hard date: before the end of January 2027.
