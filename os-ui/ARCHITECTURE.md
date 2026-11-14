<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# os-ui architecture

One Next.js application: the OS shell, every tab's surfaces, the API routes behind
them, and the MCP server. The UI and MCP are two transports over the **same**
governed code — the MCP endpoint is a front door, never a back door.

## The shape

```
core/      The kernel. Everything every tab depends on; it never imports a tab.
  kernel/    session · auth · config · roles · tabs · artifacts · scopes · lifecycle
  policy/    OPA client, the approvals queue, governance effects (the write spine)
  mcp/       the ONE dispatcher (handleRpc), the tool registry, token minting
  runtime/   the agent/assistant loop, LiteLLM model calls, tool dispatch
  infra/     external-service clients + the OpenSearch mirror (os-* indexes)
  auth/      OAuth app + token plumbing for Connections
  ui/        the app shell: Sidebar, PageHeader, AuthGate, OsAssistant, theme
  app-sdk/   the client SDK vendored INTO generated apps  (keep imports relative)
  app-ui/    the UI package vendored INTO generated apps  (keep imports relative)
  guides/    the cross-cutting guides (overview, how-to-use, governance)
  manifest.ts  the TabManifest contract

tabs/      One folder per tab. A tab imports @core/* and itself — never another tab.
  <tab>/
    manifest.ts   feature key · nav entry · routes · api · mcpTools · policies · services
    lib/          the tab's domain logic
    ui/           the tab's React components
    mcp/          the tab's MCP tool bundle
    guide.md      the in-app guide          context.md  the model-facing context
    *.test.ts     next to the code they test

app/       The Next.js App Router tree. Routes MUST live here, so pages stay put and
           import from @core/* and @tabs/*. Nothing but routing belongs in app/.

worker/    ENTRYPOINTS the Next build never compiles — the `os-ui-worker` container's command.
           `start.mjs` registers `resolve-hook.mjs` (the tsconfig path aliases, READ from
           tsconfig.json) and imports `agent-runs.ts` under Node's type stripping; `empty.mjs`
           is what `server-only` resolves to outside a bundler. Like `instrumentation.ts`, these
           files MAY import a tab: they are entrypoints, not kernel code. `check-structure.mjs`
           enforces the FEATURE / USER STORY / ARCHITECTURE header here too.
```

Path aliases: `@core/*` → `core/*`, `@tabs/*` → `tabs/*` (tsconfig + the test loader + the
worker's resolve hook, which derives them from `tsconfig.json` so the three cannot disagree).

## The 13 tabs

| Group | Tabs |
|---|---|
| Entry | Home |
| Context | Data · KPIs · Files · Knowledge |
| Build | **Workflows** · Agents · Dashboards · Software |
| Manage | Connections · Governance · Monitoring · Platform |

The **Platform** tab's folder is `tabs/admin/` and its feature key is `admin`;
only the label is Platform (renamed 2026-10-30). It is one route with a tab
strip — six sections, no tile grid.

Three personal surfaces are **not** tabs: My Settings (`/settings`), My MCP
access (`/mcp`) and About / Licenses (`/about`) hang off the sidebar's account
menu (`core/ui/account-menu.ts`).

A tab declares the deployed services it needs in its manifest. If a service is
disabled in the chart, the tab is absent from the navigation rather than broken;
`OS_ENABLED_TABS` gates the same set at runtime (`core/kernel/tabs.ts`).

## Which tab owns a surface

Thirteen tabs only stay thirteen if there is a rule for where a new surface
goes. The 2026-10-30 Platform restructure moved ten surfaces out of one tab
using these four, in order:

1. **A surface belongs to the tab that answers the question the user is
   asking** — not to the tab whose team built it, and not to whichever tab is
   the current catch-all. "What may this tenant connect to?" is the same
   question as "what am I connected to", so the tenant registries went to
   Connections.
2. **Observation separates from configuration.** A display-only surface is
   observation and belongs in Monitoring, however administrative its subject.
   The billing envelope is a number the OS shows and LiteLLM budgets enforce,
   so the whole surface moved — nothing stayed behind to configure.
3. **Policy separates from administration.** Defining what a role *may do* is
   policy: rare, high-stakes, auditable → Governance, beside approvals and OPA.
   Assigning a person a role is routine administration → Platform's Users &
   Access. Where one task crosses the line, cross-link both ways in one click.
4. **A surface moving into a tab with a lower `minRole` must carry its own
   gate.** Moving must never widen access. Monitoring and Governance are
   `builder`-visible, so the spend section, Roles & permissions and Security &
   egress each re-check `admin` themselves, fail-closed, and the API behind
   them stays `adminCtx()`-gated. Hiding is never the security boundary; it is
   the layer that stops an admin surface flashing into a builder's strip.

## The rules, and how they are enforced

`scripts/check-structure.mjs` (in CI):

1. `components/` holds upstream material only — licence and pin, nothing of ours.
2. A tab imports `@core/*` and its own folder. Cross-tab needs go through the kernel.
3. The kernel never imports a tab.
4. Every tab has a `manifest.ts`.
5. Every source file carries a `FEATURE` / `USER STORY` / `ARCHITECTURE` header.

Rules 2, 3 and 5 carry a real backlog inherited from v1, so the checker is a
**ratchet**: it fails when a count grows, never because the backlog still exists.
`scripts/structure-baseline.json` records where we are; shrink it as it is paid down.

## How a write happens

```
UI page  ─┐
          ├─> app/api/<route>  ─> @tabs/<tab>/lib  ─> @core/policy (authorize)
MCP call ─┘        or @core/mcp/handleRpc                 │
                                                          ├─ allowed  -> effect + trace
                                                          └─ held     -> approvals queue
                                                                          (Governance tab)
```

Authorisation is OPA, fail-closed, and runs as the **acting user** — an agent can
exceed neither its own grants nor the rights of whoever runs it. Model calls go
through LiteLLM; runs are traced to Langfuse.

## Two things that will bite you

- **`core/app-ui` and `core/app-sdk` are vendored verbatim into generated apps.**
  Their own imports must stay **relative**; an `@core/*` alias does not exist inside
  a generated tree, and aliasing them silently degrades the vendored package's types
  to `any`.
- **Scaffolds hold generated app source inside template literals.** Import-looking
  strings in there belong to the generated app, not to os-ui — never rewrite them.

## Embedded tools

Some components ship a better admin UI than we would write. `core/infra/tool-proxy.ts`
serves those **same-origin** at `/tools/<key>`, so they appear inside the OS chrome with
the OS session as the only credential the browser holds. Three modes: `none` (the proxy
plus the role gate *is* the access control), `header` (trusted-proxy identity), and
`session` (the proxy signs a server-only account in — no second login).

Two rules learned the hard way:

- **A tool can only be framed if its assets are not root-absolute.** A SPA requesting
  `/_next/*` collides with os-ui's own routes and every chunk 404s into a blank iframe.
  LiteLLM is framable because the chart sets `SERVER_ROOT_PATH=/tools/litellm`; Langfuse
  is not, so it opens in its own tab (`ownTab` in the registry).
- **One upstream root path means one proxy prefix.** When a tool exposes both a public
  and an admin surface there, the gate must be per-path: `publicPaths` + `adminSso` +
  `pathAccess()`, evaluated on every request including sub-resources. Fail-closed — a
  non-admin gets our 403, never the upstream's login form.

## Reading a component back

LiteLLM is the first component the OS treats as a **source of truth it reads**
rather than a thing it configures. The pattern is worth copying, because the
temptation with any component is to keep a second copy of its state in the OS
and let the two drift.

The read path is four layers, each with one job:

```
core/infra/litellm-admin.ts      IO only. Bearer key, timeout, envelope shapes.
  tabs/admin/lib/gateway-mirror  Rules only. Pure mapping, drift, attribution.
    app/api/platform-admin/gateway   Gate only. adminCtx(), one endpoint.
      tabs/admin/ui/GatewayPanel     Render only. Four variants, one fetch.
```

Three rules make this honest, and all three are enforced by tests rather than
by convention:

1. **A read of a dependency is not an exception.** The client returns a result
   type, never throws, and always carries a timeout. An unreachable component is
   an expected state of the system, so it must be representable in the type.
2. **Degrade with a date, never with a zero.** A failed read serves the last
   good mirror with its *original* timestamp plus a `degraded` flag. An empty
   answer and an unreachable component are different facts and must look
   different in the UI.
3. **Report drift, never adopt it.** Anything that exists in the component with
   no OS counterpart is listed as unmanaged. The OS does not reconcile behind
   the admin's back, because a surprise write to a shared component is worse
   than a surprise gap in a list.

The mapping layer is a **pure function** taking the raw reads, the OS-side
counterparts and the clock. That is what lets every rule above be tested with
no network and no timing, and it is the reason the IO shell stays small enough
to read in one sitting.

Direction of truth is deliberately one-way here: the OS owns identity and
policy, the component is the enforcement point and the ledger, and the OS reads
only the second half. When a write path arrives it goes in its own module, so a
reviewer can tell from the file list alone which code can change the component.

### Writing to a component

Reads and writes to a component live in **separate modules** — for LiteLLM,
`core/infra/litellm-admin.ts` reads and `core/infra/litellm-write.ts` writes.
The split exists so "what in the OS can change this component?" is answerable
from the import graph instead of by reading bodies.

Three rules for a write path:

1. **Plan, then apply.** The admin sees every intended change, with a reason per
   operation, before anything is written.
2. **Never accept the plan from the client.** The apply route recomputes it
   server-side. A route that applies ops from a request body is a confused
   deputy for whatever credential it holds.
3. **Report drift, never delete it.** Anything the component has that the OS
   does not govern is listed and left alone. Deleting it because the OS has no
   record of it is the worst available outcome.

Credentials follow the same separation: the admin credential administers the
component, and a **scoped** credential runs traffic. The run path fails closed
when the scoped credential is absent rather than borrowing the admin one.

## How a system.yaml becomes a StateGraph

The Agents tab executes a real `@langchain/langgraph` graph, and since A5 of the engine
rebuild that is the **only** executor: no flag, no `runtime:` choice, no fallback. The
hand-rolled IR walker, its mock twin and the Python `agent-runtime` interpreter are gone;
an `AGENTS_ENGINE` left in an environment is ignored with one deprecation line at boot.
The path is:

```
system.yaml ─ parseSystem ─> System ─ compile ─> IR ─ buildGraph(ir, deps) ─> CompiledStateGraph
  (tabs/agents/lib/system-schema.ts)  (langgraph-compile.ts)   (tabs/agents/lib/engine/build-graph.ts)
```

**State** (`Annotation.Root`). `messages` is the shared conversation in the OpenAI wire
shape (`LlmMessage[]`, append) — not LangChain `BaseMessage`, because every model call
goes to LiteLLM as chat-completions. Every `state.channels` entry of the yaml becomes a
**typed** state key: `add_messages` appends; `boolean` / `number` / `string` / `json` is a
last-write-wins channel starting at that type's default; any other declaration (the legacy
`last_value`) is an untyped `json` channel, so a file written before the types runs
unchanged. The engine adds its own keys: `task`, `current` (the agent visit in flight),
`handoffs` (the team-progress blocks, append), `nodeRuns` (append), `routes` (append),
`budget`, `held` (append), `final`, `failed`, `routeNext`. A channel that shadows one
of those is a compile error.

**Four nodes per agent.** `plan_<id>` runs the reasoning tier with no tools, checks
the team step budget and emits `node-started`. `act_<id>` runs the execution tier with
the node's advertised tools (`toOpenAiTools`); if the gateway rejects `tools` it flips
a `react` flag and retries with the ReAct text protocol; a cap or loop-guard triggers
a one-shot synthesis. `tools_<id>` is the **node-level gate**:
only tools this node is advertised reach `grantedToolExecutor` (an un-advertised call
gets a typed `not_found` and never executes). It runs in two phases: first the **hold
decision for the whole batch** (`holdDecisionFor`, parking the run on `interrupt()` —
see "Approvals are interrupts"), then **one executed call per superstep**, so every
execution is checkpointed before the next one starts. `route_<id>` records the visit
(`nodeRuns`, `handoffs`, `node-completed`), then routes. act → tools is a conditional
edge on "the reply carried tool calls"; tools → tools while calls remain, else → act.
Every agent visit costs one budget step in `plan_<id>` (plus one per tool round and per
supervisor decision), so an unguarded handoff cycle ends at the budget — and is a
compile warning.

**Supervisor.** `route_<sup>` asks the model through a mandatory `route` tool
(`{ next: <member>|'END', brief }`, text fallback `NEXT: <member>`) and
`addConditionalEdges` fans out to members ∪ handoff targets ∪ END. A member's route
returns to the supervisor's **route** node — one decision call per return, the standard
LangGraph supervisor shape. When it routes END, a non-empty brief is the team's final
text; otherwise the last agent's answer is.

**Handoffs.** `when` is evaluated by `tabs/agents/lib/engine/when.ts`: literals, string
literals, `state.<channel>`, bare identifiers (= the channel of that name), `==`/`!=`,
`&&`/`||`, parentheses — a hand-written parser, never `eval`. A true guard returns
`new Command({ goto: 'plan_<to>' })`; absent `when` is unconditional. A guard over a
channel nothing **can** set is a **compile warning** carried on the run report, not a
silent false. Handoffs are tried in declared order before the supervisor return / END.

**Who writes a channel** (A5-review-H-2). A guard is useless if nothing can make it true,
so the agent whose turn the guard follows — the `from` of the guarded handoff, since the
guard is evaluated in `route_<from>` immediately after that visit — is advertised one extra,
built-in tool, `os_set_state` (`{ channel, value }`). It is closed to the **declared**
channels and type-checked against the declaration. It is not an MCP tool and not a grant:
it writes the team's own state, so it never reaches `grantedToolExecutor`, is never held for
approval, and an undeclared channel or a mistyped value returns a typed `invalid_argument`
result the model can correct. The write is part of that superstep's state update, so the
following `route_<id>` sees it — as does the supervisor, whose routing prompt carries a
`--- TEAM STATE ---` line of the current channel values. Each writer's system prompt gains a
generated `--- STATE CHANNELS ---` block (one sentence per channel, derived from the
declaration), so the instructions cannot drift from the yaml. This is what makes the shipped
Software Delivery Team's five-phase chain reachable; before it, every `when` guard in the OS
evaluated false by construction.

**END and bounds.** The supervisor routes END; a leaf's handoffs all evaluate false; or
`budget.stepsUsed` (tool rounds + supervisor decisions) reaches the team step budget —
graceful, `final` = what completed plus the budget note. `recursionLimit` is derived
from that budget (`recursionLimitFor`: ×4 + 8) as the hard backstop; hitting it is
reported, never a 500. Disabled agents are pruned at build; an unmapped legacy tool is
a compile error naming it.

**Checkpointer and resume.** `tabs/agents/lib/engine/checkpointer.ts` picks
`PostgresSaver` on `AGENT_RUNS_DATABASE_URL` (the chart's `agent_runs` database, set
up idempotently at boot from `instrumentation.ts`) or `MemorySaver` when unset — and
the run report says which (`checkpointer: 'postgres' | 'memory'`). **Thread id = run
id**, minted in the run route (`newRunId`). `runGraphEngine` (`engine/run.ts`) streams
with `streamMode: ['custom','updates']`; nodes emit through `config.writer`, and the
route forwards the same SSE events as before (`node-started`, `tool-step`,
`node-completed`, `done`, `error`). `POST …/run { resume: true, runId }` calls
`stream(null, { configurable: { thread_id } })` and continues from the last checkpoint;
the Run panel's "Resume" button does exactly that — offered only when the checkpointer is
`postgres` (a memory thread died with the pod). The first superstep stamps
`state.owner = { systemId, userId, domain }`; a resume must name the same system **and**
user or it is a typed `ResumeNotFoundError` (404 — never confirming the thread exists), and a
thread with nothing left to run is a `RunAlreadyFinishedError` (409), never a silent no-op.
Run ids come from `core/kernel/run-id.ts` (`crypto.randomUUID`): a run id is a capability.
Checkpoints hold the full state — raw tool results included — indefinitely; retention is an
open item (plan A13 follow-up).

**Build compiles the same graph.** `tabs/agents/lib/build/compile-verify.ts` calls the SAME
`buildGraph` with inert deps (a model and a tool executor that throw if touched — compiling
calls neither), so Build's `langgraph` row means "the graph this `system.yaml` describes can
be constructed", and a bad guard, an unmapped grant, a disabled entrypoint or a channel
shadowing an engine key fails at Build rather than mid-run. It replaced two things that each
verified something the engine never executes: a POST of the IR to the Python runtime's
`/reload` plus a `/run` test invocation, and a hand-rolled BFS over the IR in the mock
adapter. Build's Langfuse row is consequently `pending` until the system has really run —
its probe reads the traces a RUN leaves behind, and a build no longer stages a fake one.

## Approvals are interrupts

A write that needs a human **pauses the run**; the decision **resumes it**. Nothing executes
in between — not the held call, and not the other calls of the same batch.

```
act_<id> ──tool calls──▶ tools_<id>  phase 1: holdDecisionFor(preset, tool) for EVERY call
                            │          held → ApprovalPort.enqueueOnce(<threadId>:<callId>)   (idempotent)
                            │          pending → interrupt({ approvalId, tool, node, args })  ── run PARKS
                            │                                                                   SSE approval-required
   Governance inbox / MCP decide_approval ── decide() ── onDecided hook ── resume.ts
                            │          runner re-read LIVE (principalById): disabled / role lost / domain lost → refused
                            │          Command({ resume: { [approvalId]: decision } }) as the RUNNER
                            ▼          SSE resumed
                         tools_<id>  phase 2: one call per superstep — approved → grantedToolExecutor(user = runner)
                                              rejected → {"error":{"code":"rejected","approvalId"}} to the model
```

**Where the hold lives.** The rule is the pure module `tabs/agents/lib/build/hold.ts`
(`writeTargetScope`, `holdDecision`, `holdDecisionFor`) — the same rule the executor's gate 1b
applied in A1, lifted out so the graph builder (no `server-only`) can call it before anything
executes. The executor runs with `holdAt: 'node'` and no longer re-holds; `'executor'` remains its
DEFAULT as defence in depth for any caller that is not a graph node.

**Idempotency.** LangGraph re-runs an interrupted node from its start on every resume, so the
node enqueues through `enqueueOnce` keyed on `interruptKey = <threadId>:<callId>` — one approval
per held call however many times the node re-runs. The **queue is the source of truth**: on every
re-run the node reads each approval's state back; a decided one never interrupts again, a pending
one parks again. A resume payload meant for another approval therefore cannot unblock the wrong
call. Phase 2 executes one call per superstep so a crash between two executions re-executes only
the call in flight.

**Who executes.** The approval record carries `runId`, `threadId`, `interruptKey`, `systemId`,
`node`, `tool`, `args` and the **runner's principal snapshot**. `core/policy/approvals.ts`
`decide()` fires the registered `onDecided` handlers (a registration at boot from
`tabs/agents/lib/engine/resume-boot.ts`, mirroring `core/folders/adapters.ts` — the kernel never
imports the tab); `decisionSettled(id)` lets both decide doors await the outcome. The handler
(`engine/resume.ts`) re-reads the runner live and refuses — typed, stamped on the record's
`resume` field — when the runner is gone or no longer clears the tool's role floor; otherwise it
rebuilds the run context **as the runner** (`run-service.ts`) and continues the thread. The
approver authorises; the runner executes. `applyEffect` performs **no approver-side effect** for a
run approval. A rejection also resumes: the agent receives the typed `rejected` result (a policy
outcome in the UI) and continues. A parked approval has **no TTL** in v1 — an open policy
question recorded in `docs/components/os-ui.md`.

**Watching it finish.** The run route's `done` body carries `parked` and `heldApprovals`; the
resume happens in the decider's request, so the panel re-attaches to the run's event topic
(`GET …/run/stream?runId=`, owner-checked) and sees `resumed` → `node-started` … `done`. MCP:
`get_agent_run { runId }` (state, path, held approvals), `resume_agent_run { runId }` (restart
recovery), and `decide_approval` resumes through the same hook.

## One trace per run

A run is **one Langfuse trace whose id is the run id** (= the LangGraph thread id). The engine
does not use a LangChain callback handler — our model calls are OpenAI-shaped requests to
LiteLLM, not LangChain runnables — so the tree is built explicitly with the `langfuse` SDK,
which gives exact control over ids:

```
core/infra/langfuse.ts            the ONE SDK client (buffered, never awaited by a run), traceUrlFor,
                                  scoreTrace, readObservations (+ observationsQuery, which refuses
                                  an unfiltered read with a typed error)
tabs/agents/lib/engine/observe.ts the RunObserver port + the Langfuse implementation (client injected)
build-graph.ts  observed(name, body)   every plan_/act_/tools_/route_ node runs inside a span; the node
                                  gets an LlmCall that records each completion as a GENERATION
                                  (model, usage, redacted input/output) and a tool() wrapper that
                                  records each governed call as a span with the DECISION
run.ts                            finish() → the terminal `run.result` span; flush() in the background
agentic-graph-server.ts           builds the observer per run (resume: no new trace), wires the
                                  caller context and the executor's traceContext
```

Three rules keep it one tree:

1. **One `trace-create` per run start; a resume creates none.** The trace carries
   `userId` (the runner), `sessionId` (the system), tags `domain:` `agent:` `run:` `engine:`.
   The outcome is a terminal `run.result` span rather than a trace update (a trace update is
   a second trace event in the SDK; the recorded-ingestion test asserts exactly one).
2. **Everything nests.** Governance `trace()` events (`core/infra/agent-governed.ts`) become
   spans of the run trace when the executor passes `traceContext` — through the deps, never a
   global. The LiteLLM caller forwards `existing_trace_id` + `parent_observation_id`, so the
   gateway's own Langfuse callback lands under the OS generation instead of as a stray trace.
3. **Every read is filtered.** The diagnostics route reads observations by `traceId=<runId>`;
   without a run id, by the caller's user id and a time window. `observationsQuery` throws on
   anything looser, and that rule has a test.

The LiteLLM side carries the same identity: `callerCredential` tags every call `domain:`,
`agent:`, `tab:`, `run:` with `user = os-<id>`, resolves the system's own key by **reference**
when Build minted one and the shared agent key otherwise — and never the master key, which the
repo-wide `MODEL-KEY` test confines to `litellm-admin.ts`, `litellm-write.ts`, the key
provisioner and `config.ts`.

**Redaction, two levels** (`LANGFUSE_REDACTION`, `config.langfuseRedaction`). `structure` (the
default): message content as roles + character counts, the tool-call structure (names, ids,
arguments) in full, each tool result as a character count plus a 160-character preview. `strict`:
argument **key names** and their sizes only, and no preview — for tenants whose tool arguments can
carry personal data. Neither level reaches LiteLLM's own nested generation, which carries the full
prompt unless the gateway is told otherwise (`turn_off_message_logging`) — see
`docs/components/langfuse.md`.

**In-flight lock.** `executeTeamRun` takes a per-thread lock (`engine/run-lock.ts`) before any
marker or event and releases it in `finally`; a second entrant on the same run gets a typed 409
instead of executing an approved write twice. Since A4 the authoritative lock is the `run_jobs`
row (a `queued`/`running` run cannot be re-queued, typed 409 across pods); the in-process lock
stays as a second belt inside one process.

## Runs execute in a worker

Before A4 a run was bound to the request that started it: the HTTP handler drove `graph.stream()`
to the end, so `maxDuration = 300` was the real ceiling on a run and an os-ui rolling restart
killed whatever was in flight. Since A4 **the route files the run and tails its events; something
else executes it.**

**Two tables in the `agent_runs` database** (the same one as the checkpointer; idempotent DDL at
boot, next to `PostgresSaver.setup()` — `engine/jobs-postgres.ts`):

| Table | Shape | Why |
|---|---|---|
| `run_jobs` | `run_id` **primary key**, `system_id`, `domain`, `requested_by`, `principal_snapshot jsonb`, `input jsonb`, `kind start\|resume`, `status queued\|running\|parked\|done\|failed`, `locked_by`, `locked_at`, `attempts`, `error`, `created_at`, `updated_at` | ONE ROW PER RUN. A resume re-queues the same row, so the status column *is* the cross-process in-flight lock. |
| `run_events` | `(run_id, seq)` **primary key**, `event`, `data jsonb`, `at` | Append-only, written only by the lease holder. `event` is exactly the SSE vocabulary (`node-started`, `tool-step`, `node-completed`, `approval-required`, `resumed`, `done`, `error`); anything else is dropped and reported. `seq` is the client's cursor. |

**The port** is `engine/jobs.ts` (`RunJobStore`) with two implementations: Postgres, and an
in-memory one that is the contract every implementation must meet — it is what the tests drive,
and what a laptop without `AGENT_RUNS_DATABASE_URL` runs on.

**The worker loop** (`engine/worker-loop.ts`, pure; wired by `build/run-jobs-server.ts`;
entrypoint `worker/agent-runs.ts`): claim the oldest `queued` row with
`UPDATE … WHERE run_id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` — two workers never take the
same run and neither blocks — stamp `locked_by`/`locked_at`, re-read the runner **live**, run it,
write every engine event to `run_events`, settle the row. A `running` lease nobody heartbeats is
re-queued **once** (as a `resume` when there is a checkpoint to continue, keeping `kind='start'`
when the run never reached one) and then **failed**, so a run never sits `running` forever.
SIGTERM stops new claims and aborts the run in flight at its next superstep boundary: what
completed is checkpointed and the row goes back to `queued`.

**A lost lease is an abort.** The heartbeat is a watch (`leaseWatch`): the first beat that reports
the row is no longer `running` under this pod aborts the run *and* marks the job abandoned, so
this process settles nothing and re-queues nothing — the pod that re-claimed the row owns it. The
settle itself is lease-guarded in SQL (`AND locked_by=… AND status='running'`), so a stale
holder's `done` updates no rows. `run_events` appends are deliberately **not** guarded: a late
event is ordered after the new holder's by `seq` and is at worst a duplicate line in the panel,
whereas a stale settle would end a run somebody else is still driving. `settlementOf` (pure) is
the whole decision: abandon ▸ failed ▸ requeue ▸ parked/done.

**`inline` still reaps.** There is no loop to sweep leases in `inline` mode, so
`ensureRunJobsReady()` runs one `reapStale` sweep at boot and an inline run heartbeats its own
lease. An os-ui pod OOM-killed mid-run is picked up by the next pod's boot.

**A run id is not an authorisation.** `engine/run-visibility.ts` `assertRunVisible` is the ONE
gate every run-id door calls *before* any side effect — `POST …/run` with `{ resume: true }`,
`GET …/run/stream`, MCP `resume_agent_run` — and the store refuses a resume whose `requested_by`
differs from the row's as defence in depth. Always 404, never 403: a 403 would confirm that the
run exists and belongs to someone else.

**Identity, again.** The job carries a `principal_snapshot` — what was true when the run was
filed, never the authority. Before executing, `engine/runner-identity.ts` re-reads the runner from
the live directory and refuses typed when the identity changed: `runner_unavailable` (gone or
disabled), `runner_role_changed` (downgraded below the filed role), `runner_domain_lost`. A role
*upgrade* is not a refusal — the yaml is re-governed against the owner's live role on every run.

**The tail** is a **poll** of `(run_id, seq)` (a primary-key range scan, 400 ms), not
`LISTEN/NOTIFY`: it is correct across pods and after any reconnect, needs no dedicated connection
per watcher, and a few hundred milliseconds is invisible next to a model call. `POST …/run` tails
from `seq = 0`; `GET …/run/stream?runId=&afterSeq=` tails from the client's cursor, so a re-attach
replays only what it missed. A `done` whose body says `parked: true` is **not** terminal — the
decision will continue the run on the same id. At 240 s both doors emit a `queued`
`{ runId, afterSeq }` frame and the panel re-attaches from that cursor
(`build/run-stream-client.ts`, pure and unit-tested — the panel is a `.tsx` a test may not
import). One pod holds at most 64 tails (`engine/tail-limit.ts`); the next gets `503` +
`Retry-After`, because a tail borrows a pooled connection every 400 ms and sign-in must not lose
to a wall of open Run panels.

**One switch, `AGENTS_WORKER`.** `inline` (the default) means the process that files the job also
executes it, immediately, writing the same `run_events` — a kind install, a laptop and the whole
test suite behave exactly as before and need no worker process. `worker` means os-ui only enqueues
and tails, and the `os-ui-worker` Deployment (same image, `node --experimental-strip-types
worker/start.mjs`, `AGENTS_WORKER=worker`) executes. The chart sets it only when
`osUI.worker.enabled`.

**Every door is the same door — and the door is `enqueueRun`.** The chokepoint in
`build/run-jobs-server.ts` is `enqueueRun`: it files the job row, and nothing executes a run
without one. Three callers sit on top of it, and which one a surface uses depends on whether it
tails the run itself: the SSE run route calls `enqueueRun` DIRECTLY and then tails `run_events`
(it owns the stream); `build/scheduled.ts` and the MCP `run_agent_system` call `startQueuedRun`
(file, then follow until it settles); `resume_agent_run` and the owner's Resume call
`resumeQueuedRun`; and the Governance `onDecided` hook calls `enqueueResumeAfterDecision`.
Earlier revisions of this file called `startQueuedRun` "the one start door", which the run route
has never used (B4-review L-3 / E-4). In particular a decision no longer drives the graph inside
the decider's request — it files a `resume` job, and the approval card says `queued` until the run
reports back.

## Git-based working: one repo per domain, two generators, one commit path

(Engine rebuild, Part D — behind `DATA_PROJECT_GIT`, **ON by default since B4**. The flag's name is historical:
it is the ONE switch for both halves, because they share the repository, the PVC and the
read-only `git daemon` sidecar it provisions.)

Everything built in the OS — from the UI or through the MCP — lands in a real git repository, as a
commit authored by the person who made the change. There is no "export to git" step and no second
ledger: the Agents tab and `get_agent_system` read the commit back out of the repo.

**One repository per domain, two owned subtrees.**

```
$OS_REPOS_DIR/<domain>.git          # bare, on the os-repos PVC (RWO; os-ui is single-replica)
├── dbt_project.yml  profiles.yml  models/…  os/…     # the Data tab's generator (B1)
└── agents/                                           # the Agents tab's generator (Part D)
    ├── index.yml                                     # slug -> id, owner, scope, source version
    ├── <slug>/                                       # a Shared / Marketplace system
    │   ├── system.yaml                               # THE canonical definition
    │   ├── agents/<agent-id>.md                      # each agent's instruction file
    │   ├── graph.json                                # the compiled LangGraph IR the engine runs
    │   └── README.md                                 # purpose, members, grants, channels, edges
    └── personal/<uid>/<slug>/…                       # a Personal system, in its owner's lane
```

The personal lane mirrors the data side's `models/personal/<uid>/` deliberately: one repository,
one convention. A promotion therefore MOVES the directory out of the lane in the same commit that
changes the visibility — and the id in `index.yml` and in the `OS-Object` trailer is what stays
frozen, because a directory name is a slug, not an identity.

**Two generators, one tree, no clobbering.** The dbt generator writes the WHOLE tree
(`commitTree`); the agents generator writes exactly its prefix (`commitSubtree`, which keeps every
other path at its current blob — so an EMPTY file map is how an archive or a delete is recorded).
For the other direction, `reserveSubtree('agents/')` (registered when the agents hook installs)
tells the whole-tree writer to keep paths it does not itself mention. Both primitives are generic:
`core/infra/git-store.ts` holds path prefixes and knows nothing about datasets or systems.

The BOOT ORDER in `instrumentation.ts` is therefore load-bearing, and both halves live in one
block for that reason: data commit hook → agents commit hook (which reserves `agents/`) → data
boot reconcile → agents boot reconcile. The data reconcile is a whole-tree commit, so running it
before the reservation would commit the subtree's deletion; if the agents hook fails to install,
the data reconcile is SKIPPED rather than allowed to do that. Both directions are pinned by
`tabs/data/lib/dbt/boot-reconcile.test.ts` (the reserved subtree survives a real reconcile, and
without the reservation it does not).

**Every writer commits — and the compiler says so.** `tabs/agents/lib/store.ts` has one
`writeThrough(rec, change)` whose second parameter is **required**: a `SystemChangeSpec` makes the
write a commit, `null` says "run bookkeeping, deliberately not a commit". A new writer cannot be
added without deciding, and `tabs/agents/lib/git/commit.test.ts` pins which decision each of the
24 writers made (17 commit; 7 — the activity marker, the run checkpoint, the last-run report and
restart recovery — do not, because a run's artefacts are the LangGraph checkpoint, the `run_events`
rows and the Langfuse trace). The store is reachable from the client bundle, so it emits a pure
`SystemChange` (`tabs/agents/lib/system-events.ts`) and the server-only
`tabs/agents/lib/git/commit.ts` subscribes at boot — the same seam, for the same reason, as the
data side's `project-events.ts`.

**Where "via" comes from, for the MCP too.** `core/mcp/server.ts` now runs EVERY `tools/call`
inside an `mcp:<tool>` request-surface scope, so no tool surface can be forgotten; `withRoute`
supplies `ui:<route>` for the UI, and the hand-rolled build route sets its own scope. A writer
outside any scope is recorded as `ui:agents` and logged once as a gap.

**Boot reconcile.** At boot the OS regenerates each domain's `agents/**` once and lets the git
store decide whether anything changed, so a window with the flag off (or a failed write) is caught
up as the platform principal with `OS-Reason: boot-reconcile`. Domains walked: those holding a
live system, plus any repo that already carries an `agents/` subtree — so a removal is committed
too, and a data-only repo never grows an `agents/` directory.

**Mirror.** One admin-configured remote per domain (`{url, tokenSecretRef}`; the URL may not embed
credentials and its host must be on the egress allowlist). After every CHANGED commit —
either generator — `core/infra/git-mirror.ts` pushes `main`, resolving the token from its Secret
reference at call time, using it once and scrubbing it from any error. The push is
fire-and-forget: it reports, never blocks a save, and is retried by the next commit. The last
outcome is the `git-mirror` row on Platform → Components & Health (red when a mirror's last push
failed, amber before its first), because a fire-and-forget failure that is only a log line is a
remote silently falling behind.

**What is NOT in the tree.** No secrets: grants are names and ids, the LiteLLM key is a Secret
*reference* held on the record and excluded by the snapshot, and no run artefact (activity,
checkpoint, last run, last activity) is committed — those belong to Langfuse, `run_events` and the
checkpointer. A `system.yaml` that does not parse is still committed verbatim, with a README that
says so: losing the source would be worse than an unreadable one.

## A data product is a dbt project in a git repo the OS owns

(Engine rebuild, Phases B1–B4 — `DATA_PROJECT_GIT`, **on by default** since B4. Concept:
`docs/superpowers/plans/2026-11-13-data-products-concept.md`.)

A domain's data product is a **dbt project** an engineer could clone and run, and it lives in a
**bare git repository per domain** that the OS writes: `$OS_REPOS_DIR/<domain>.git` on the
`os-repos` PVC. Users never edit the repo from the UI; the OS is generator, committer and reader.

**The one commit path.** `core/infra/git-store.ts` (isomorphic-git, MIT, in-process — no git
binary in the os-ui image, no shell) exposes `openOrInit`, `commitTree` (writes the whole desired
tree, commits **iff the root tree hash changed**), `log`, `readBlob`, `listTree`, `archive` (tar)
and `push` (mirror; token resolved from a Secret reference at call time, scrubbed from errors).
Author = the acting `CurrentUser`, committer = `Sovereign OS`, message
`<area>(<domain>): <action> <object> — via ui:<route>|mcp:<tool>` plus `OS-*` trailers. It lives in
`@core` because the Data and the Agents tab both commit through it; it knows nothing about either.

**One service per mutation, two surfaces.** `tabs/data/lib/mutations-server.ts` holds the eight
mutating data operations (create, version, silver, gold, quality rules, run checks, sync config,
sync now). A Data-tab route adds HTTP shaping; an MCP tool adds argument coercion; neither holds
logic. That is what makes "the MCP is the same governed path, not a back door" checkable rather than
aspirational — `tabs/data/lib/mcp-parity.test.ts` drives each tool through `handleRpc` and the same
input through the service, and compares the committed tree, the author, the `OS-Actor` trailer and
the Dagster launch args. Errors are thrown status-tagged once, so `withRoute` renders `{error}` +
status and `handleRpc` the typed `{code, reason, hint}` from the same throw. It also deleted seven
cross-layer imports: the MCP tools no longer reach into the Data tab's store, panels, compilers and
publish server — they call one module.

**Every writer commits.** `tabs/data/lib/store.ts` has one `persist()`; it — and the few writers
that bypass it (create, adopt, archive, delete, restore, propagation sweeps) — emit a
`ProjectChange` through `tabs/data/lib/project-events.ts`. The store is reachable from the **client
bundle** (`lib/index.ts` re-exports it), so it may not import `node:fs` or isomorphic-git even
dynamically — hence the event seam. `tabs/data/lib/dbt/commit.ts` subscribes at boot
(`instrumentation.ts`): snapshot the domain (`snapshot.ts`, the only impure read) → `generateProject`
(`generate.ts`, pure, byte-stable: sorted keys, one newline, no timestamps) → `commitTree`.
`commit.test.ts` enumerates the store's exports — a new mutator fails until it is classified.

**The hook cannot see the past, so boot does.** A listener installed at boot sees only writes from
then on, and a crash between the store write and the commit loses that commit. `boot-reconcile.ts`
closes both: at startup, for every domain the OS knows (datasets in the registry ∪ repositories on
disk), it commits the difference between the generated project and the repository HEAD as the
platform principal with the trailer `OS-Reason: boot-reconcile`. It commits only where the tree
moved, survives one broken domain, and launches nothing.

**Where "via" comes from.** `core/infra/request-surface.ts` (AsyncLocalStorage): `withRoute` wraps
every handler in `ui:<route>`, the data MCP tools wrap each call in `mcp:<tool>`; the hook reads it
synchronously at mutation time. A writer outside any scope is recorded as `ui:data` and logged.

**What the project contains.** Bronze is a `source` (the data-runner writes it with PyIceberg, dbt
never does). Silver and Gold are models whose body is the compiled SELECT the OS recorded at build
(`compileSilver` / `compileGoldJoin` output) with `iceberg.<schema>.<table>` rewritten to
`{{ ref() }}` for tables of this project and `{{ source() }}` otherwise — `source()` is exactly the
governance boundary `reuseSourceFqn` enforces (a cross-domain product). Un-promoted datasets live
under `models/personal/<uid>/` with `+schema: personal_<uid>`; promoted ones under
`models/<layer>/` in the domain schema (model name == physical table name, so FQNs hold). Quality
rules are `schema.yml` tests (`range` and `not_blank` are generator-shipped generic tests carrying
the `dq.ts` predicates). Syncs are incremental models (`delete+insert` on `_batch_id` with the
lookback predicate; `merge` on the keys); Kafka offsets and API-batch sources are listed in
`os/external.yml`, not faked. `profiles.yml` is `env_var()` only with
`impersonation_user: env_var('OS_PRINCIPAL')` — no default, so a run without a principal fails.

**Commit first, validate second.** The Dagster user-code pod's `repo-sync` sidecar fetches each
repo over the read-only `git daemon` on the os-ui pod (Service `os-repos:9418`, NetworkPolicy:
Dagster user-code only), runs `dbt parse` in a worktree and repoints `current` only on success.
A broken commit stays in history; the gate is deployment, as in any CI.

**Provenance decides what is a model.** `buildVersion({compiled: true})` records that a body came
from the OS's own compilers. Only those bodies become dbt models. An authored body — the free-text
`body` of `add_dataset_version` or the version route — is stored and rendered as a dbt **source**:
dbt reads that table and never rewrites it, so no user-authored text is ever handed to Jinja at
`dbt parse` and a scheduled `<model>+` run cannot replace someone's table with a copy of the layer
below. A quality rule's column must match `/^[A-Za-z_][A-Za-z0-9_]*$/` — it is interpolated
**unquoted** into the generated test SQL — and anything else is refused at the store gate and
recorded as `meta.os_intentions`, never emitted as a test.

## Dagster schedules the repo

(Phase B2, same flag. Since B4 nothing in the OS provisions a `batch/v1` CronJob for data: the
provisioning module and both fallback sweep routes are deleted, and all that survives is a
delete-only cleanup so an upgrade removes what a pre-B2 save left behind.)

The OS does not run data products and does not keep a run ledger for them. **One** Dagster code
location, `sovereign` (`images/extensions/dagster/repo.py`, with the pure half in `os_projects.py`),
loads every `/repos-checkout/<domain>/current/` that `repo-sync` validated and builds, per domain:
`@dbt_assets` keyed `[<domain>, <node>]`, a `<domain>__all` job the OS launches with an explicit
asset subset, one job + UTC `ScheduleDefinition` per `os/schedules.yml` entry, and a weekly Iceberg
maintenance job per schema. A run-failure sensor pauses a schedule after the OS's own threshold of
consecutive failures (this is what `isQuarantined` becomes); a second sensor pauses the schedules of
a principal the OS reports inactive. A domain that fails to load is skipped, never fatal.

**Identity still travels with the work.** The run pod's `OS_PRINCIPAL` — set through the
`dagster-k8s/config` tag by the schedule, by the maintenance schema's owner, or by the OS on an
explicit launch — is the Trino user `dbt-trino` impersonates, so Trino→OPA governs the same identity
the UI does. `OS_PINNED_COMMITS` tells a run pod (whose `/repos-checkout` emptyDir starts empty)
which commit to check out. Both are principals and shas; **no secret is ever a tag or a repo file**.

**The OS reads Dagster, not itself.** `core/infra/dagster.ts` is the one typed GraphQL client —
`Fetched<T>` like `litellm-admin.ts`, a hard timeout, an injectable `fetch`, nothing thrown and
nothing logged: `launchRun`, `run`, `runsForDataset`, `recentOsRuns`, `assetChecks`,
`allAssetChecks`, `latestMaterialization`, `assetGraph`, `reloadLocation`, `nextTick`. Run history
and the next tick come from it (`tabs/data/lib/sync-status-server.ts`), quality results from asset
checks — one dbt test is one check (`tabs/data/lib/dq-status-server.ts`) — and Monitoring's pipeline
lens from runs filtered by the `os/*` tags. An outage is reported as an outage: empty rows and a
reason, never a fabricated run and never a fake green.

**The index exists because git cannot enumerate.** `GET /api/data/projects` lists every domain
repository with its `main` head and the activity of each schedule principal; the `repo-sync` sidecar
and the inactive-principal sensor poll it with the cluster-internal runtime bearer, a signed-in user
sees only their own domains.

## Data products execute as the principal

(Phase B3, same flag.)

**There is no service identity anywhere in the execution path.** A read through `query_data` or the
Data tab runs on Trino as the caller's domain principal — or as their uid when the SQL touches their
own `personal_<uid>` lane, because even the owner is denied their own personal table under a domain
principal. A write runs as `user.domains[0] ?? user.id`. A dbt model in a Dagster run pod connects as
`dbt-runner` and acts as `env_var('OS_PRINCIPAL')`, which the `dagster-k8s/config` tag sets per run
from the schedule's principal, the maintenance schema's owner, or the principal the OS passed. A
source observation connects as the dataset owner. The full table is
`docs/components/trino.md` → "Who runs as whom", and it is a table because the answer must be one
name per path, not a shrug.

**What the engine enforces, and what it cannot yet.** Trino chains two system access controls and
requires both to allow, so the second can only narrow: the OPA plugin keeps row filters, column masks
and the foreign-`personal_*` deny; a generated `rules.json` adds impersonation and schema ownership.
The file is one shape with two renderers — the chart's bootstrap (impersonation bounded by the id
SHAPE, ownership untouched so a fresh install still works) and the OS's reconciled form (principals
enumerated, ownership closed), written into the same ConfigMap and re-read within
`security.refresh-period`. `core/infra/trino-rules.ts` is pure and golden-tested, including the
property that matters: the service user can become an OS principal and nothing else — not `root`,
not a deactivated user, not `admin; drop`. **The limit to know:** the chart does not set
`http-server.authentication.type`, so Trino does not authenticate clients and the impersonation
rules have no authenticated `original_user` to match. The schema-ownership rules bite immediately;
making impersonation load-bearing needs authentication and a credential, which is a deploy decision
and is written down rather than assumed.

**Lineage is dbt's graph, not the OS's memory.** `datasetLineage` reads Dagster's `assetNodes` —
which dagster-dbt derives from `manifest.json`'s `parent_map` — and folds it into the same
`LineageGraph` the registry path returns, with one additive field saying which source answered.
Reading `target/manifest.json` directly was rejected because it lives in a pod volume os-ui cannot
mount. The fallback is explicit and labelled; an empty graph is never passed off as the truth.

**Parity is a test the deletion will be gated on.** `tabs/data/lib/dbt/parity.ts` compares, per
fixture, the SQL the OS runs today with the SQL dbt will run. It is honest about its reach: because
a model body IS the recorded CTAS after rewriting, the test proves the translation is faithful and
invertible — and catches any future change to the rewriter, the stripper or the lane/FQN mapping —
but not that two materialisations agree row for row. That needs `EXCEPT ALL` both ways on a cluster.

## Things this codebase will punish you for

Hard-won, each from a real failure. Read before writing a route, a test, or an
OAuth flow.

**A store can hydrate EMPTY without throwing, and an empty store looks exactly
like a tenant that owns nothing.** `ensureHydrated()` RESOLVES when the durable
mirror was unreachable: the failure is recorded for a throttled retry and
deliberately not raised, because every read path should degrade rather than 500.
This is the shape of the September-2026 login outage — an os-ui/OpenSearch
startup race hydrated the user store to nothing, and every user got "invalid
password". A read path is right to shrug; a **boot-time WRITER is not**. The
agents and data boot reconciles both generated an empty project from an
unhydrated store and committed the DELETION of everything in the domain
repository, then pushed it to the mirror.

So: **anything that would commit, delete, or reconcile on the strength of what
the store says must call `hydrationState()` first** (`tabs/agents/lib/store.ts`,
`tabs/data/lib/store.ts`) and do nothing unless it says `'hydrated'`. "The store
is empty" is only a fact when the mirror answered. The second line of defence is
in `core/infra/git-store.ts`: a commit carrying `OS-Reason: boot-reconcile` that
would delete more than half the files it tracks and add none is refused
(`DestructiveReconcileError`). A person's commit is never subject to that — the
rule is that an automatic process does not empty a tree, not that nothing may.

**A Next.js `route.ts` may export only its HTTP handlers and a short list of
config names.** Export a helper from one and the build fails type-checking with
`Property 'x' is incompatible with index signature`. And a **test cannot import
a route at all** — it pulls `next/headers` transitively and dies with
`ERR_MODULE_NOT_FOUND`. So logic worth testing never lives in a route; it lives
in a plain module the route imports.

**A test cannot import a `.tsx` either.** Node strips types but not JSX, so the
import fails with `ERR_UNKNOWN_FILE_EXTENSION` before any assertion runs. `.svg`
fails the same way. Put testable data in a `.ts` sibling and re-export it from
the component — `core/ui/account-menu.ts` and `tabs/admin/lib/sections.ts` are
the pattern.

**TypeScript parameter properties do not work.** `constructor(readonly x: string)`
is rejected by the same type-stripping. Declare the field explicitly.

**Never restate a route path that already exists in the nav.** The Drive OAuth
callback sent every user to `/files`, which exists only as an API path and has
no page, while the Files tab is at `/unstructured`. All eight exits of that
route — success included — landed on a 404, and no test caught it because the
constant was never compared to anything. Derive the path from `TABS` and assert
it (`core/auth/drive-landing.ts`).

**Diagnostics are a feature, and discarding them costs hours.** Two separate
places in the OAuth flow threw away the provider's real error: the callback kept
`error` and dropped `error_description`, and the exchange `catch` collapsed every
failure into `exchange_failed`. The actual causes live in codes like
`AADSTS50194` (a single-tenant app on the multi-tenant `/common` endpoint) and
`AADSTS7000215` (a mistyped client secret). Forward a **matched code only** —
never a free-text provider body, which can echo request material and ends up in
a URL.

**Beware a fallback that reports success.** The Files connector falls back to a
deterministic mock drive when no token resolves, which keeps a laptop install
clickable but means a broken connection renders as a *successful* sync of
invented files. Any fallback that substitutes fake data must label itself in the
result, and the UI must surface that label.

## Generated documentation

`node scripts/build-docs.mjs` renders `docs/site/index.html` — every folder and file,
taking its prose from the file headers, the tab manifests and the component pins, so
it cannot drift. CI fails if the committed page is stale.

## Charts: one surface, and vendored third-party source

**`core/ui/charts/` is the only place the OS registers Apache ECharts.** Before night run 2 there
were three independent `echarts.use([…])` call sites — `tabs/dashboards/ui/PanelChart.tsx`,
`tabs/data/ui/ResultChart.tsx` and `tabs/software/ui/appspec/ChartExplorerRenderer.tsx` — each with
its own tree-shaken bundle, its own `cssVar` theme bridge, its own compact-number formatter and its
own canvas lifecycle. That is how the same number came to be drawn three slightly different ways.
The surface is now:

| File | What it owns |
|---|---|
| `register.ts` | the single `echarts.use([…])` and `initChart` — the ONLY module allowed to name the `echarts` package |
| `theme.ts` | the CSS-custom-property → concrete-colour bridge (`resolveChartColors` is pure, so it is tested without a DOM) |
| `format.ts` | `leaf` · `num` · `fmtCompact` · `fileSlug` · `toCsv` — one formatting rule for the whole product |
| `spec.ts` | the pure `ChartSpec → EChartsOption` builder and `fromRows`, the one row→spec adapter |
| `Chart.tsx` | a shell: canvas lifecycle, resize, dispose, point click. No option building |

`core/ui/charts/echarts-surface.test.ts` greps the whole tree and fails on a second registration.
A host maps its own model onto `fromRows` (`tabs/dashboards/lib/chart-spec.ts` is the worked
example) and gets an option identical to every other host's for the same rows.

**`os-ui/vendor/superset/` is attributed third-party source, and it has its own rules.** The
line/area/bar families are built by a vendored slice of Apache Superset's pure ECharts
transformers (`extractSeries`, `getAxisType`, `getChartPadding`, `getMinAndMaxFromBounds`,
`transformProps`, `transformSeries`), Apache-2.0 into Apache-2.0, pinned to an upstream **commit
sha**. Things this codebase will punish you for:

- **Rewriting an upstream licence header.** Apache-2.0 §4(a)/(c) forbids it, so `os-ui/vendor/**`
  is excluded from the `FEATURE:`/`USER STORY:`/`ARCHITECTURE:` ratchet and covered by
  `check-structure.mjs`'s **hard** `VENDOR-LICENCE-HEADER` rule instead: the upstream header
  verbatim, a `Modified from <repo> <path> @ <40-char sha>` notice, a `Changes:` list, an SPDX id.
- **`npm i`-ing an `@superset-ui/*` package.** Every one was last published 2024-12-10 and peers on
  React `^16.13.1`; npm would install a second React tree against this repo's React 19 with no
  warning. Vendor pure functions, never components.
- **Adding a dependency to the vendored tree.** It imports nothing — not `echarts`, not `lodash`.
  `lodash`'s `orderBy`/`sumBy` are reimplemented locally with lodash's own null-last ordering.
- **A TypeScript `enum` in `os-ui/vendor/**` (or anywhere a test reaches).** Node's type-stripping
  loader, which runs the suite, refuses one: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Upstream enums
  become `as const` objects plus a union type of the same name.
- **Letting upstream reorder a user's series.** Superset's default branch sorts series
  reverse-alphabetically. The OS passes `seriesOrder` so the measure order the panel author declared
  is the order on screen.

## A typed union is not a runtime check

The dashboards review found a live SQL injection, and the shape of it is worth remembering because
nothing in the code looked wrong.

`tabs/metrics/lib/explorer.ts` declares `export type Granularity = 'day' | 'week' | …` and
interpolates it straight into the compiled SQL — `date_trunc('${spec.granularity}', "col")` — which
is correct for every caller that *has* a `Granularity`. The dashboards panel query had
`timeGrain: Granularity | undefined` on its type and wrote `p.timeGrain as Granularity`. But the
panel is parsed out of an HTTP request body, a `type` has no runtime existence, and `as` is erased
at compile time, so the cast asserted something nobody had checked: a panel carrying
`timeGrain: "month'), (SELECT password FROM users) --"` type-checked, cast cleanly, and closed the
quote.

Three rules come out of it:

- **A string that reaches SQL as an IDENTIFIER or a KEYWORD must be checked against a closed
  runtime allow-list, at the boundary where it enters.** Not escaped, not sanitised, not cast.
  Values can be quoted and bound; grains, column names, aggregate names and sort directions cannot.
- **A union type with no value form is a trap.** If a set is small and closed, declare the ARRAY and
  derive the type (`const X = [...] as const; type X = (typeof X)[number]`), so there is something
  to check at runtime and so a new member cannot be added to one and not the other.
  `tabs/dashboards/lib/model.ts` does this for `VIZ_TYPES`, `SERVABLE_FILTER_OPERATORS` and
  `PANEL_TIME_GRAINS`, the last of which carries a compile-time assertion that it still equals the
  metrics `Granularity`.
- **One assertion per door, not one per field.** `assertServableFilters` checks the operators AND
  the grain, and the store calls it, so a new entry point cannot remember one check and forget the
  other. A gate that lives in three call sites is a gate that is missing from the fourth.
