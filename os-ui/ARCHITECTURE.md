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
```

Path aliases: `@core/*` → `core/*`, `@tabs/*` → `tabs/*` (tsconfig + the test loader).

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

The Agents tab's `langgraph` engine (`AGENTS_ENGINE=langgraph`; default still `walker`
until the deletion phase) executes a real `@langchain/langgraph` graph. The path is:

```
system.yaml ─ parseSystem ─> System ─ compile ─> IR ─ buildGraph(ir, deps) ─> CompiledStateGraph
  (tabs/agents/lib/system-schema.ts)  (langgraph-compile.ts)   (tabs/agents/lib/engine/build-graph.ts)
```

**State** (`Annotation.Root`). `messages` is the shared conversation in the OpenAI wire
shape (`LlmMessage[]`, append) — not LangChain `BaseMessage`, because every model call
goes to LiteLLM as chat-completions. Every `state.channels` entry of the yaml becomes a
state key with its declared reducer (`add_messages` → append, anything else → last
value). The engine adds its own keys: `task`, `current` (the agent visit in flight),
`handoffs` (the team-progress blocks, append), `nodeRuns` (append), `routes` (append),
`budget`, `held` (append), `final`, `failed`, `routeNext`. A channel that shadows one
of those is a compile error.

**Four nodes per agent.** `plan_<id>` runs the reasoning tier with no tools, checks
the team step budget and emits `node-started`. `act_<id>` runs the execution tier with
the node's advertised tools (`toOpenAiTools`); if the gateway rejects `tools` it flips
a `react` flag and retries with the ReAct text protocol; a cap or loop-guard triggers
the same one-shot synthesis the walker did. `tools_<id>` is the **node-level gate**:
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
channel nothing sets is a **compile warning** carried on the run report, not a silent
false. Handoffs are tried in declared order before the supervisor return / END.

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
open item (plan A13 follow-up). The checkpointer and the in-process run-event topic assume a
**single os-ui replica** until A4's worker.

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
executes. Under `langgraph` the executor runs with `holdAt: 'node'` and no longer re-holds; the
walker keeps `holdAt: 'executor'` and the old out-of-band `held` result.

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
re-queued **once** as a `resume` (the checkpoint continues the thread) and then **failed**, so a
run never sits `running` forever. SIGTERM stops new claims and aborts the run in flight at its
next superstep boundary: what completed is checkpointed and the row goes back to `queued`.

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
decision will continue the run on the same id.

**One switch, `AGENTS_WORKER`.** `inline` (the default) means the process that files the job also
executes it, immediately, writing the same `run_events` — a kind install, a laptop and the whole
test suite behave exactly as before and need no worker process. `worker` means os-ui only enqueues
and tails, and the `os-ui-worker` Deployment (same image, `node --experimental-strip-types
worker/start.mjs`, `AGENTS_WORKER=worker`) executes. The chart sets it only when
`osUI.worker.enabled`.

**Every door is the same door.** The run route, `build/scheduled.ts`, the MCP `run_agent_system`
and `resume_agent_run`, and the Governance `onDecided` hook all go through
`build/run-jobs-server.ts` (`startQueuedRun` / `resumeQueuedRun` / `enqueueResumeAfterDecision`).
In particular a decision no longer drives the graph inside the decider's request — it files a
`resume` job, and the approval card says `queued` until the run reports back.

## Things this codebase will punish you for

Hard-won, each from a real failure. Read before writing a route, a test, or an
OAuth flow.

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
