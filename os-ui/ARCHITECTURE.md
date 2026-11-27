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
  adapters/  opensearch/client.ts — the ONE OpenSearch client (URL, credentials, timeouts)
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

**One model per agent, no hand-off (owner decision 23 Nov 2026).** An agent's plan, act steps and
cap synthesis run on ONE model (`GraphDeps.nodeModel`; production `agentRunModel` in
`agentic-graph-server.ts`, the module engine `agentModuleModel` in `module/os-run.ts`), chosen per agent
in system.yaml: `model: strong | standard | auto` (`tabs/agents/lib/agent-model.ts`; no field = strong —
NOT exactly the behaviour before 70fd047d, when a read-only gatherer's act steps ran on the worker and the
module engine defaulted to the worker). `auto` is decided ONCE per Build (`build/model-choice.ts` +
`model-choice-server.ts`: one strong-model call for all Auto agents, stored as `model_resolved` +
`model_reason`, fallback strong with a warning in the Build report's `models` row); new agents start on
`auto`. The system key's `models` are exactly the roles its agents use (`agentRoles` in `build/live.ts`). The key never fails a
run: its OS-derived fields (`allowed_tools`, `models`) are re-stamped ON SAVE (`installKeySyncOnSave`, a store
change listener in the web process) and BEFORE EVERY RUN (`enqueueRun` → the kernel seam
`core/kernel/key-sync-port.ts`, registered by `instrumentation.ts` — the run path never imports the gateway's
admin code; the worker has no implementation and the gateway answers the run). Auto re-decides only when an
agent's role, instructions, tools or members changed (`model_basis`). Agent runs never offer or run
`delegate_to_worker` / `escalate_to_strong`; the OS-wide lead switch ("Save costs") applies to the chat and
the software builder (`runPhaseTurn`) only.

**A tool call written as text is never PRESENTED as the answer** (`core/runtime/text-tool-call.ts`). A reply
that IS such a call (Hermes/Qwen `<tool_call>`, Kimi/DeepSeek/harmony markup, `<|tool_call|>`,
`[TOOL_CALLS]`, or a bare call object naming a known tool — markup in code blocks, prose mentions and data
do not count) gets one corrective retry (the bad reply, then a note), and a second one fails the agent with
`TextToolCallError` ("the model wrote a tool call as text instead of calling it"); the cap synthesis fails
the same way. The guard parses nothing to run. Two OLDER recoveries do parse and run a textual call — the
ReAct-shaped `{"tool": …}` reply (`reactCall`, the engine's native-mode fallback) and a gpt-oss harmony
call (`parseHarmonyToolCall` in `parseLlmMessage`): such a call runs ONLY if the node is offered that tool
(else the typed `not_found`, lead tools included) and goes through the governed executor (OPA, grant
scope, holds) — but the gateway's `allowed_tools` check does not see it, because it arrived as text, not
in `tool_calls`. `parseLlmMessage` detects on the RAW text, because `content` has its `<|…|>` tokens stripped.

**An agent-run prompt carries each thing once, per agent** (`GraphDeps.agentRun`, `preambleFor`; set by
`runOsTeam`, absent in the parity goldens). An ACT call carries the tools ONLY as native definitions,
compacted for that agent (`compactToolSpecs`: first sentence + argument docs, no Purpose/Before/After/
Governance, no mention of a tool the agent is not offered — the MCP surface keeps the full text); the
PLAN call (no native tools) gets the agent's own one-line list; the ReAct fallback keeps the full list.
The preamble is per agent (`osPreamble(user, sys, agentId)`: its own results and the areas its own tools
touch) and has no tool list. The closing line is neutral (the software builder's "files committed,
preview URL" line stays the chat/builder default of `actSystem`). Results: the SYSTEM saves them from the
named agent's final answer, so the agent does not save them again (its write tools are for other work);
an agent producing several results writes one `=== OUTPUT: <name> ===` section each, read back by
`outputSection`. New teams from the proposer get per-agent `tools:` lists.

**Sampling is per MODEL, everywhere** (`core/models/model-sampling.ts`): every chat-model call — chat, agent
runs, software building, the builder assistant, the module engine — is sent the temperature / top_p its
vendor recommends for the catalog model its role points at (each value with its official source); no
published recommendation = 0.2. The one helper is `wireSampling`, used by the gateway callers. Only listed
small deterministic calls keep an explicit temperature (`fixedSampling: true`): delegate presets, Auto model
choice, file auto-description, NL→SQL, JSON-only builder stages, the team-structure proposal, the catalog
classifier, dummy rows, the expose assistant's JSON, the evaluation judge, the chat memory summariser and figure
extraction (`core/runtime/conversation-memory.ts`, temperature 0).

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
act_<id>   model reply → tool calls; the hold decided ONCE per call → state.holds   (checkpointed)
   │
tools_<id>  phase 1: first undecided held call → interrupt({ kind:'os.hold', tool, node, args, approverRole },
   │                 { responseSchema: { decision, approvalId } })   ── run PARKS (one interrupt per superstep)
   │  run.ts (the stream loop, NOT the graph): __interrupt__ { id, value }
   │        → ApprovalPort.enqueueOnce(<threadId>:<interruptId>)   one card per interrupt, idempotent
   │        → log `parked runId=<id> interrupt=<id>`, SSE approval-required
Governance inbox / MCP decide_approval ── decide() ── onDecided hook ── resume.ts
   │        runner re-read LIVE (principalById): disabled / role lost / domain lost → refused
   │        resume job { decision, approvalId, interruptId } → worker: getState lists interruptId? else 409
   │        Command({ resume: { [interruptId]: { decision, approvalId } } }) as the RUNNER
tools_<id>  phase 2: one call per superstep — approved → grantedToolExecutor(user = runner)
                     rejected → {"error":{"code":"rejected","approvalId"}} to the model
```

**Where the hold lives.** The rule is the pure module `tabs/agents/lib/build/hold.ts`
(`writeTargetScope`, `holdDecision`, `holdDecisionFor`) — the same rule the executor's gate 1b
applied in A1, lifted out so the graph builder (no `server-only`) can call it before anything
executes. The executor runs with `holdAt: 'node'` and no longer re-holds; `'executor'` remains its
DEFAULT as defence in depth for any caller that is not a graph node.

**Idempotency (WP-26: LangGraph's documented interrupt contract).** LangGraph re-runs a paused
node from its start on resume, so the paused node has no side effect before its `interrupt()`, calls
it once (never in a loop), and never asks the hold rule: the decision was made once in `act_<id>`
and checkpointed in the `holds` channel, so a policy change between pause and resume cannot turn a
held or rejected call into an executed one (a call with no entry fails closed: held for an admin).
The **card is filed outside the graph**, by the run driver, from the `__interrupt__` chunk, keyed
on LangGraph's interrupt id — stable across re-runs, so a worker restart never files a second card.
The **resume is strict**: the worker checks the interrupt id against `getState().tasks[].interrupts`
and refuses a stale, duplicate or wrong id with a 409 (`StaleResumeError`; a still-parked run stays
`parked`). Phase 2 executes one call per superstep and every run streams with
`durability: 'sync'`, so a worker killed BETWEEN two calls re-executes only the call in flight.
A death INSIDE the call's superstep replays that call (LangGraph records a step's writes only after
it returns), so every governed call carries an idempotency key (`<thread>:<node>#<visit>.<round>:<callId>`)
and goes through the tool-call ledger (`engine/tool-call-ledger.ts`, table `tool_call_ledger`):
`started` before dispatch, the result after. On a replay, a recorded call is answered from the
record; a write whose dispatch was cut off is not re-sent (typed `unresolved_previous_call`); a
read is sent again. The guarantee is therefore: a governed write is dispatched at most once, and
exactly once when the worker survives the dispatch; reads are at least once.
Proven against the real `PostgresSaver` on Postgres 17, a fresh process per step:
`engine/hitl.pg.test.ts`, `engine/durability.pg.test.ts` (CI job `test-langgraph-pg`).
One-release shim: a thread parked before WP-26 (its interrupt value names its approval) resumes
through its single interrupt; one whose batch held more than one call is refused
(`legacy_multi_hold`) and settled `failed` visibly. The worker logs a read-only parked-run
inventory at boot (`parked-inventory …`).

**Where LangGraph ends and the OS begins.** Native LangGraph: the `StateGraph`, its channels
(including `holds`), `interrupt()` with `responseSchema`, `Command({ resume })`, `PostgresSaver`
on the shared `pg.Pool` (`engine/pg-pool.ts`), `getState`, `durability`. OS wrapper code, outside
the graph's mechanics: the hold rule (`build/hold.ts`, passed in as `hold.decide`), the grant
precheck and governed executor (`build/grant-scope.ts`, `build/os-tools.ts`), identity and the
runner re-read (`engine/runner-identity.ts`, `engine/resume.ts`), the card projector and strict
resume (`engine/run.ts`), the queue (`engine/jobs*.ts`) and output saving (`output-saver.ts`).

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

A run is **one Langfuse trace whose id is `createTraceId(runId)`** (the run id is the LangGraph
thread id). The engine does not attach `@langfuse/langchain`'s `CallbackHandler`: our model calls
are OpenAI-shaped requests to LiteLLM and our tools are governed MCP calls, not LangChain
runnables, so the handler would only re-write the node chains — a second writer of the same
observations — and could not parent the model-call and tool observations under them (its node
spans are active only inside its own synchronous callback). The tree is built explicitly with
`@langfuse/tracing` over OpenTelemetry, which gives exact control over parents:

```
core/infra/langfuse.ts            the ONE Langfuse writer: NodeSDK + LangfuseSpanProcessor (@langfuse/otel v5),
                                  withRunTrace, recordObservation, traceUrlFor, scoreTrace,
                                  readObservations (+ observationsQuery, which refuses an unfiltered read)
core/infra/trace-port.ts          the RunObserver port, the no-op observer and the redaction policy
core/infra/trace-masking.ts       the admin masking switch's PII patterns and content shape (pure)
core/infra/masking-policy.ts      the switch read live (os-ui + worker) and the gateway's redaction header
build-graph.ts  observed(name, body)   every plan_/act_/tools_/route_ node is a CHAIN observation; the
                                  node gets an LlmCall that wraps each call in a `llm.<node>` span (the
                                  gateway's GENERATION nests under it — the only generation) and a
                                  tool() wrapper that records each governed call as a TOOL with the DECISION
run.ts                            finish() → the `run.result` event; flush() in the background
agentic-graph-server.ts           withRunTrace per run segment (trace id = createTraceId(runId); a resume
                                  adds a segment under the same fixed root id)
```

Three rules keep it one tree:

1. **One trace per run, one writer.** The trace id is `createTraceId(runId)`; each segment (start
   or resume) is an `agent` observation on the run's fixed root span id. `userId` (the bare runner
   uid), `sessionId` (`system:<id>`) and the tags `domain:` `agent:` `system:` `run:` `engine:`
   are propagated to every observation. No other os-ui file sends to Langfuse
   (`core/infra/writers.test.ts`).
2. **Everything nests, nothing twice.** A tool call's observation is ACTIVE while the call runs,
   so what the governed call records (a retrieval, a data tool) nests under it by OTel context.
   Under a run `agent-governed.ts` `trace()` writes only to its in-process ring — the observer
   already wrote the tool observation. The LiteLLM caller sends a W3C `traceparent` from
   the `llm.<node>` span's OTel ids and `x-litellm-call-id` (recorded on that span as
   `litellm_call_id`), which is how LiteLLM's OTel v2 `langfuse_otel` callback nests the call's
   generation under the span (`core/runtime/gateway-trace.ts`); the legacy body fields
   `existing_trace_id` / `parent_observation_id` are ignored on V2 and are not sent. The app
   exports no generation of its own (`exportOsSpan`).
3. **Every read is filtered.** The diagnostics route reads observations by
   `traceId=createTraceId(runId)`; without a run id, by the caller's user id and a time window.
   `observationsQuery` throws on anything looser, and that rule has a test.

The LiteLLM side carries the same identity: `callerCredential` tags every call `domain:`,
`agent:`, `tab:`, `run:` with `user = os-<id>`, resolves the system's own key by **reference**
when Build minted one and the shared agent key otherwise — and never the master key, which the
repo-wide `MODEL-KEY` test confines to `litellm-admin.ts`, `litellm-write.ts`, the key
provisioner and `config.ts`.

**Redaction, two levels** (`LANGFUSE_REDACTION`, `config.langfuseRedaction`). `structure` (the
default): message content as roles + character counts, the tool-call structure (names, ids,
arguments) in full, each tool result as a character count plus a 160-character preview. `strict`:
argument **key names** and their sizes only, and no preview — for tenants whose tool arguments can
carry personal data. Neither level governs LiteLLM's own nested generation: that one is redacted
at the gateway (`turn_off_message_logging`, chart default) and its logged output is masked per
request (`metadata.mask_output`, set in `core/runtime/runtime.ts`) — see
`docs/components/langfuse.md` "What the gateway writes".

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
| `run_jobs` | `run_id` **primary key**, `system_id`, `domain`, `requested_by`, `principal_snapshot jsonb`, `input jsonb`, `kind start\|resume`, `status queued\|running\|parked\|done\|failed`, `locked_by`, `locked_at`, `attempts`, `error`, `created_at`, `updated_at` | ONE ROW PER RUN. A resume re-queues the same row, so the status column *is* the cross-process in-flight lock. `input->>'trigger'` says what started the run — `manual` (Agents tab), `schedule` (CronJob → `/api/agents/scheduled-run`), `api` (MCP `run_agent_system`) — and a resume keeps it (both stores merge it into the resume's input). Rows from before 2026-11-26 have none. |
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

**Identity still travels with the work.** The run's `os/principal` tag — set by the
schedule, by the maintenance schema's owner, or by the OS on an explicit launch — becomes the run
pod's `OS_PRINCIPAL` (the run worker reads its own tags), the Trino user `dbt-trino` impersonates, so
Trino→OPA governs the same identity the UI does. The `os/pinned` tag becomes `OS_PINNED_COMMITS`, which
tells a run pod (whose `/repos-checkout` emptyDir starts empty) which commit to check out. No
`dagster-k8s/config` tag is sent: the run-launcher lock-down allows none. Both are principals and shas; **no secret is ever a tag or a repo file**.

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
`dbt-runner` and acts as `env_var('OS_PRINCIPAL')`, which the run worker derives from the run's `os/principal` tag
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

## Governance state lives in Postgres `os_governance` (WP-07)

`core/adapters/postgres/` is the one home for governance state: approvals, confirmations, grants,
run grants and their approved writes, the grant revision, notifications, prefs, domain settings,
commit checks, reconciler status, the catalog index, lifecycle pins and exposure sets, plus the
append-only `audit_events` (design 00 §3.2, §3.5; 10 F2, F3, F8). Users are not here (Keycloak),
and neither are model budgets (LiteLLM owns them; the OS reads its admin API).

- **A separate database, four roles.** `os_governance` (database) is owned by a NOSUPERUSER,
  NOCREATEROLE role that only runs migrations. The OS runs as a different login, a member of
  `os_governance_app`, that owns nothing and may CREATE nothing in the database. pg-boss runs as a
  third login (group `os_governance_jobs`) that also owns nothing: the OWNER owns schema `pgboss`
  and every object in it, because pg-boss's DDL (`pg-boss migrate`) runs only in the migration
  step, and every runtime pg-boss starts with `migrate: false`. Neither OS login has TRIGGER,
  TRUNCATE or CREATE on `pgboss`, so neither can attach code that would run inside a governance
  transaction. They also cannot write `pgboss.bam` (SQL a migrating pg-boss executes) or
  `pgboss.version.version` (which migrations run); only pg-boss's run-time claim columns of
  `version` stay writable (`QUEUE_LOCKDOWN_SQL`, applied after every `pg-boss migrate`).
  `createBoss` refuses `migrate: true` / `createSchema: true` (`QueueMigrationRefusedError`). Only a superuser can create those roles, so the
  chart's `os-governance-bootstrap` hook (`postgres.governance.enabled`, off by default) does
  exactly that, from `charts/sovereign-agentic-os/files/os-governance/*.sql`, with a DEDICATED
  admin Secret (`adminSecretName`); it never runs the migrations. They run in the chart's `os-governance-migrate`
  hook Job (post-install,post-upgrade, after the bootstrap): `worker/migrate-governance.mjs` from the os-ui image calls
  `migrateGovernance` as the OWNER login only (it refuses a superuser). Idempotent on every upgrade; a failure fails the
  Job and so the release. os-ui and the worker run as the DML-only login and never hold the owner credential. The template refuses to render
  with the Langfuse Secret or with a name another service uses
  (`scripts/check-governance-bootstrap-chart.mjs`), and the SQL refuses an existing superuser.
- **Every function pins `search_path = pg_catalog, pg_temp`** and schema-qualifies its calls
  (PostgreSQL's documented guidance), so no caller's schema can shadow `clock_timestamp`, the
  advisory lock or `sha256` inside the chain.
- **Migrations are node-pg-migrate's**, plain SQL in `migrations/` (`-- Up Migration` /
  `-- Down Migration`). `migrate.ts` only fixes the options for `runner()`. The upstream CLI
  applies the same files with no OS code (`components/node-pg-migrate/UPSTREAM.md`). The applied
  list is kept in `os_migrations`, outside the schema, so dropping the schema is a clean rollback.
  There is no default-privileges rule: every later migration GRANTs to `os_governance_app` itself.
- **Row versions:** every table has `version` and `updated_at`, bumped by a trigger. Write with
  `... WHERE version = $n`; 0 rows is a conflict (409), never last-writer-wins.
- **Grant revision:** every statement that inserts, updates or deletes a grant, run grant or
  approved write moves `grant_revision.rev` in the same transaction. Read it with the grant rows in
  one snapshot for the `os-grants` bundle ETag; a bare sequence value is not transactional.
- **The audit chain is computed in the database.** A BEFORE INSERT trigger takes an advisory lock,
  then sets id, time, `prev_hash` and `hash`, so no client can choose them and concurrent appends
  stay linear. It refuses any isolation level but READ COMMITTED (0A000): a snapshot older than the
  lock would fork the chain. `os_governance.audit_verify()` is the one verifier. The runtime role
  may only insert and read `audit_events`, and triggers reject any rewrite for every role. Against
  the owner or a superuser the chain needs an external anchor of `head_hash` + `checked` (WP-08,
  10 "Amendment from WP-07 verification").
- **pg-boss is the one queue**, in schema `pgboss` of the same database, migrated only by its own
  CLI as the owner (`installQueueSchema` in migrate.ts); runtime instances have DML only. A
  partitioned queue (`partition: true`) is DDL, so it can only be created in the migration step. The outbox is `send(…, { db: bossDb(client) })` inside the
  caller's `withTransaction`; `bossDb` returns `pg`'s result as is (an array for several
  statements), as pg-boss documents. Workers, maintenance and cron run only in `os-ui-worker`
  (`registerWorker`, `@core/kernel/process-role`); the web process only sends.
- **Connection budget** against `max_connections` = 100: per process pg-boss `max` 3 and the
  governance pool 4, so 14 for web + worker, beside agent_runs' 20.
- **Proof is `core/testing/postgres/*.it.ts` against the real `postgres:17` digest** (CI job `test-postgres`). They fail,
  never skip, without `OS_PG_TEST_URL`.
- **Nothing reads these tables yet.** Store moves are WP-09 (dual-write, then one read path behind
  a per-store flag, never dual-read).

## Things this codebase will punish you for

Hard-won, each from a real failure. Read before writing a route, a test, or an
OAuth flow.

**A workload os-ui creates at run time must match what the chart renders (2026-11-26).** The
agent-schedule CronJob `tabs/agents/lib/schedule-cron.ts` provisions referenced the Secret
`os-ui`/`agent-runtime-token`, which no profile renders (the bearer lives in
`agent-runtime-token`/`token`), and carried no pod labels. Every unit test passed because they
injected the Secret name; on a cluster every trigger pod would sit in
`CreateContainerConfigError`, and a saved cron schedule never fired. A default that names a
cluster object is a contract with the chart: test the DEFAULT (not an injected value), give the
pod the label its NetworkPolicy selects on (`component: agent-schedule`), and prove it with an
acceptance check that reads the real object (AT-g, `tests/e2e/kind/journeys/journey-g-agent-triggers.e2e.mjs`).
Repairing such objects at boot must not trust this pod's registry either: during a rolling update
it is stale. The schedule resync reads the mirror fresh and complete, re-reads before each write and
holds mass deletes; the receiver re-checks every firing against the fresh record
(`scheduledRunGate`). Operations: `docs/ops/agent-schedules.md`.

**Every OpenSearch call goes through `core/adapters/opensearch/client.ts` (WP-21).** It is the
only reader of `OPENSEARCH_URL` and of the credentials WP-22 adds (`OPENSEARCH_USERNAME` /
`OPENSEARCH_PASSWORD`); `opensearchFetch` throws on a transport failure, `opensearchTry` returns
`null`. A module that builds its own `fetch` to OpenSearch keeps working while security is off
and then 401s forever the day it is turned on — `scripts/check-opensearch-client.mjs` fails CI
on it. The pod's `wait-for-opensearch` initContainer imports the same file with plain
`node --experimental-strip-types`, so the file must stay import-free and erasable-only TS.

**Two processes hold two copies of every store, so a whole-record write erases the other
process's edits.** `os-ui` (web) and `os-ui-worker` (agent runs) each load their own in-process
Map at boot. A store that PUTs the WHOLE record to the mirror puts back its stale copy of every
field the other process changed meanwhile — an agent documenting a dataset in the worker erased
the rename its owner had just made in the Data tab, and the next restart hydrated the loss. Never
write a record with `mirror.writeThrough` after it exists: use `core/infra/field-writes.ts`
(`writeNew` once, then `writeChanged`, which sends only the fields that differ from what this
process last saw and never upserts from the worker; `writeMergedYaml` for a record whose single
source is one yaml string; `refreshRecord` before a write that must start from the newest copy;
`writeDeleted` so a delete cannot overtake a queued write). Prove it with a two-process test
through the real store (`core/infra/two-process-fixture.ts`), not with a mock of the store.

**The worker's copy of a store goes stale unless the store re-reads its mirror.** Each store
hydrates ONCE; the worker never served what os-ui created after its boot and kept serving what
os-ui deleted. A store an agent tool reads must wire `core/infra/mirror-refresh.ts`
(`mirrorRefresher`): call `beforeRead()` in its `ensureHydrated`/`getCache` (the MCP dispatcher
awaits every bundle's `hydrate` before each `tools/call`), `noteHydrated` in the boot hydration,
`noteDeleted` in its delete, and export `enableMirrorRefresh`, switched on in
`worker/agent-runs.ts` (refused outside the run worker). Newer wins by `updatedAt`, so a store
without that stamp must add one on every write (dashboards did). Prove it with
`core/infra/worker-refresh-suite.ts`.

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

**A registry that is re-derived on every load cannot be deleted from.** The
Knowledge workflow's actor registry was rebuilt on each parse as the declared
`actors:` merged with every distinct (category, name) on the steps. A delete
therefore survived exactly one round trip: the next load re-derived the actor from
the step that still named it — and re-derived it without an `id`, so the ✕ that
only renders for an actor with an id disappeared too. Two rules came out of it,
and they generalise to any derived-or-declared collection:

- **Presence of the section is the signal, not its emptiness.** Once `actors:` exists
  it is the source of truth, and `serializeWorkflow` writes it *even when empty* —
  otherwise deleting the last entry hands the next parse a section-less file and
  derivation starts again. Derivation is for a legacy file only.
- **A reference the registry does not hold is a validation warning, never a
  repair.** `tabs/knowledge/lib/actor-registry.ts` reports it; nothing adds the
  entry back. Silent repair is indistinguishable from "my delete did not work".

Derived entries also get a **deterministic** id (`stableActorId`), so writing the
derivation back is a fixed point rather than a file that churns on every load.

**A queued write must carry a REDUCER, never a finished document.** Queueing the
workflow editor's commits fixed the dropped edit and introduced a quieter bug:
each queued task held a whole document serialised in the render where the click
happened, so the task behind reverted the one in front — and because the commit
re-read the sha immediately before its PATCH, the optimistic-concurrency check
could never fire. A commit is now `(fresh: Workflow) => Workflow` applied to the
document the store just returned, committed with **that read's** sha
(`tabs/knowledge/lib/workflow-commit.ts`). Two rules fall out of it:

- **Read, reduce, write — inside the task.** Anything serialised before the task
  runs is a snapshot, and a snapshot plus a fresh sha is a lost update wearing a
  concurrency check.
- **A sha re-read next to the write is not a check.** The token must come from the
  same read as the data it describes, or it only proves the server was reachable.

**"Drop the action if one is already in flight" loses the user's work.** The
workflow editor's `mutate` returned early while a previous commit+reload ran, and
every field committed on blur — so "type, then click" dropped the edit with no
error anywhere. The commit path must **queue**, not drop
(`tabs/knowledge/lib/commit-queue.ts`: serial because each commit re-reads the sha,
resolving an outcome so the caller can keep its draft and show the failure where
the user typed). A busy flag may disable a button; it must never swallow an edit.

**An inspector over a selected item needs `key={item.id}` and controlled fields.**
`defaultValue` plus no key means React keeps the previous item's DOM state, so
selecting another step showed the first step's text — and because the fields also
committed on blur, the stale text could be saved onto the new step.

**An unsaved-changes guard belongs to whoever owns the selection.** Putting it on
the inspector's own ✕ guards one exit out of five: the parent still changed
`selectedStep` / `selectedActor` / `panel`, and the keyed inspector remounted with
the draft gone. The child reports dirtiness (`onDirtyChange({ dirty, save })`), the
parent routes every move through one `navigate(intent)` and renders one prompt
(`tabs/knowledge/lib/editor-guard.ts`). Two guards on one exit is worse than none —
the user answers twice — so when the parent gained the prompt the children lost
theirs. The registered `save` must read the CURRENT draft (a ref assigned each
render), or the guard saves whatever the draft was when dirtiness last flipped.

**"• unsaved" has to be computed on the values the store keeps.** The step
mutations trim the title, drop blank I/O lines and trim the note, so comparing the
raw textarea text with the saved step reported "dirty" immediately after a
successful save. Normalise both sides first (`tabs/knowledge/lib/step-draft.ts`).

**A slug is not an id.** `Loan Officer` and `Loan-Officer` slugify identically, so
one derived id addressed two registry actors: deleting one removed both, the
inspector always opened the first, and React logged duplicate keys. Uniquify on
generation (`-2`, `-3`, …) and delete by object identity, not by id — a
hand-edited file can still carry the same id twice.

**A preview of generated output must call the generator, not re-implement its
format.** The Knowledge editor shows the `AGENT.md` an Agent actor will carry into
the scaffolded agent system. Two copies of that layout — one in the component, one
in the scaffold — would drift on the first edit and the author would be reading a
promise nobody keeps. So the builder is a pure function both sides call
(`tabs/knowledge/lib/actor-prompt.ts` → `actorAgentMd(workflow, actor)`), with a
test asserting the preview equals `scaffoldSystem`'s `agent_md` **byte for byte**
and a source tripwire that the component really imports it.

That is also why it is a function of `(workflow, actor)` ONLY. The scaffold also
takes per-step dispositions, but the editor has none to offer: making the prompt
depend on them would mean the preview could only ever be a guess. Dispositions
decide **whether** an agent exists; they never rewrite **what it is told**. And the
module deliberately imports neither the Agents tab's System schema nor anything
else — the client component renders the preview, and a cross-tab import on that
path would ship the Agents tab's schema to the browser (and grow the
`TAB-ISOLATION` ratchet) for a `<pre>` block.

**A generator that injects its own nodes must reserve their ids before anything
else may claim them.** The workflow scaffold names an agent after its actor, then
adds `supervisor` (or `coordinator`) afterwards — so an actor called "Supervisor"
produced two agents with one id, a supervisor whose `members` listed itself, and
ambiguous edges. Nothing downstream caught it: `parseSystem` validates document
SHAPE and has no duplicate-id check, and adding one there would be another tab's
business. The fix is both halves — `planAgents` seeds its taken-set with
`RESERVED_AGENT_IDS`, and `agent-scaffold.ts` runs `assertUniqueAgentIds` over the
**final** list, after the injection, because a guard over the plan alone cannot see
the node the caller adds next.

**Text an author typed is DATA when it reaches a model, even when it is a prompt.**
Everything in a generated `AGENT.md` that came from a workflow is either wrapped in
an explicit author-supplied region (the actor's prompt, a step's expert-knowledge
note — with any line that forges a marker quoted rather than dropped) or flattened
through `inline()` (step titles, I/O, link labels, rule text: newlines collapsed,
leading `#`/`-`/`>` stripped). Otherwise a tacit note reading
`## Hard rules for the whole X workflow` forges the section the real hard rules
live in. Note how many inlets that text has — `workflow.md` in git, the editor, an
OKF import, an MCP call — which is the argument for sanitising in the ONE builder
both the preview and the scaffold call, rather than at each door. The prompt's own
region says what it is ("this agent's own instructions"); telling the model to
disregard the brief the author deliberately wrote would negate the feature. A
boundary is not a demotion.

**The ACTOR is the unit of agency in a workflow, not the step.** The first scaffold
proposed one agent per step, so an actor that owned six steps became six agents
with six three-line briefs and no identity — and the author had nowhere to write
what that agent *is*. An `Agent` actor now carries a long `prompt` in the workflow's
`actors:` registry and becomes exactly one agent, with its steps compiled in
beneath the prompt. The registry entry parses and serializes that prompt for
**every** category, not just `Agent`: a model that dropped it when the category
changed would destroy the author's work on a mis-click, and the editor can decide
what to *offer* without the file deciding what to *keep*.

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

**A label is not a guard, and a guard keyed on an unset variable is not a guard
either.** Both halves of that cost a live incident on 2026-11-18. Every
degrade-to-mock site gated itself on `config.deploymentProfile !== 'local'`, and
`OS_PROFILE` is set *nowhere* in `charts/`, `values*.yaml`, `deploy/` or
`scripts/` — `config.ts` says so itself, twice, which is why the two fail-closed
guards in that file key on `NODE_ENV` instead. So on the cluster an unreachable
Trino served hash-seeded `offline-mock` rows as KPIs, the Data tools created,
transformed and built against an in-memory fake, and the Software security scan
— whose mode was a *default parameter*, never a decision — gated deploy approval
while always reading `offline-mock`. Nothing noticed, because the only signal was
a `mode` field in a response body: advisory, droppable, and read by no caller.

The answer is `core/kernel/offline-mock.ts`: **one switch and one predicate.**
`OS_OFFLINE_MOCK=allow|refuse` defaults to `refuse` under `NODE_ENV=production`
(the one variable the deploy does set), the chart writes it explicitly into the
os-ui *and* os-ui-worker env, and every site that chooses to fabricate calls
`offlineMockAllowed()` — nothing else. Refusing is typed:
`refuseOfflineMock(reason)` throws `ENGINE_UNAVAILABLE` (503), which the MCP
error mapper hands an agent as `{error:{code:'ENGINE_UNAVAILABLE'}}`, never a
row. `offline-mock-tripwire.test.ts` greps `tabs/**`, `core/**` and `app/**` and
partitions every file naming a stand-in marker into deciders (must import *and*
call the predicate), recognisers (read a refusal, must not decide) and labels
(must not import it), so the next decision site cannot be added quietly.

**And then a third lesson, from the review of that fix.** The first version of
the tripwire grepped for one string, `'offline-mock'` — and missed six real
fabrication sites in the Files pipeline, which spells its stand-in `mode:
'mock'` and reaches it through `mockClient()`, `mockAdapterFor()` and
`mockEmbed()`. Those were indexing documents that are not in the customer's
Drive, inventing the text of documents the parser never read, and writing *hash
vectors* as embeddings, so every k-NN search over them ranked by a hash. It also
missed `app/**` entirely, where two platform-admin routes invented 62% of the
tenant's own envelope as spend and raised a real alert off it. So the tripwire
now greps a marker **set** over three roots, and its docstring states exactly
what it does and does not guarantee: coverage of that set, not of the concept
"fabrication". A new stand-in must reuse a marker or be added to the set.

And then it happened a second time. The re-review of the same PR found two more:
`tabs/knowledge/lib/embed.ts` writing `hashEmbed` vectors labelled
`source: 'offline-hash'` — the identical defect to the Files one, on the corpus
agents cite *with a citation* — and `tabs/software/lib/app-records.ts` answering
an app tool call with two rows called "Sample record A" when the runner said
nothing, inside the very subsystem whose `seeded-evidence.ts` documents why a
label is not a guard. **Both were missed for the same reason as the first six: a
NAME, not a missing gate.** Twice is a pattern, so the marker set is now seven
strings plus a quote/space-tolerant `mode: "mock"` pattern, and the tripwire's
docstring states that a new stand-in must reuse a marker or be added to the set.

The lesson generalises four ways: when a guarantee must hold in production, key
it on something production **has**; make the gate structural rather than
advisory; when you put a grep in CI to enforce it, **write down what the grep
cannot see** — the same move `tabs/software/lib/seeded-evidence.ts` made when it
chose a positive provenance rule over scanning for a negative marker; and expect
the next gap to be a **synonym**, because a codebase this size will always have
more than one word for "stand-in".

One consequence has no clean fix: a fabricated row is **indistinguishable from a
real one once written**. The `files` and `knowledge` indexes hold invented
documents and hash vectors from before this gate, and nothing in the rows marks
them. Re-indexing is the only remedy. That asymmetry — cheap to prevent,
impossible to undo — is the argument for the gate being structural.

**And a tool that cleans up after a fabrication must say what it cannot find.**
The admin re-index (`tabs/{files,knowledge}/lib/reindex.ts`, `POST
/api/platform-admin/reindex`, MCP `reindex_corpus`, Platform → Re-index) pays
that debt down by re-parsing and re-embedding through the same live paths an
upload uses. Writing it turned up the hard part: `IndexReport.embedSource` and
`EmbedResult.mode` are **report** fields that neither `writeOpenSearch` nor
`bulkIndex` ever persisted, so "find the mock rows" has no answer. Four kinds of
evidence are genuinely queryable — a persisted stand-in label, a row with no
vector, an index whose knn mapping dimension no longer matches the configured
one (OpenSearch rejects a wrong-length vector at write time, so that one is
index-wide and exact), and a stored unit the index holds nothing for — and the
fifth, a hash vector with no marker, is not. So `filter: 'marked'` is honest
about being incomplete: the caveat is a FIELD on the plan
(`ReindexPlan.unmarkedCaveat`), repeated by the route, the tool description and
the panel, because an agent reading `counts.marked === 0` would otherwise report
a clean corpus. Three more rules came out of it, each generalising:

- **Add, then prune.** `writeOpenSearch` used to `_delete_by_query` a scope and
  bulk-add second, so a failed write left a workflow with no units at all. Unit
  ids are stable and an index op overwrites in place, so it now adds, then
  removes only what the add did not cover — and prunes nothing when the add did
  not land. `pruneChunksExcept` refuses an empty keep-set, so it can never
  become delete-everything. "Never delete a row you could not replace" has to
  be an ORDER, not an intention.
- **A re-index must check the mode it got back.** On a laptop
  `OS_OFFLINE_MOCK=allow` lets the ingest and the embedder stand in, so a run
  that trusted them would rewrite the exact rows it was started to remove. Each
  unit's own report is read (`ingestMode`/`embedMode`/`embedSource`/`store`) and
  anything but live is a FAILURE with the old rows left in place.
- **The tripwire grew a fourth category, `REFUSERS`.** These two services name
  the markers because they QUERY for them, and they call `refuseOfflineMock`,
  but they have no fabricating branch: DECIDERS would overstate them and LABELS
  may not import the module at all. A refuser must call `refuseOfflineMock(` and
  must never call `offlineMockAllowed(` — a real assertion, because a future
  edit that let a re-index fall back would have to add exactly that call.

The re-index also inherits the September-2026 lesson directly: a plan whose
store lists no unit while the index holds rows is **blocked**, not reported
clean, because an unhydrated store looks exactly like a tenant that owns
nothing.

**The review of that tool then found the same class of mistake twice more, and
both generalise.** First: **a check after the write is not a check.** The
re-index read the parse/embed mode off the report it got back — which is one
statement after `indexAsset` had written the index and `writeOpenSearch` had
written *and pruned*. Where a deployment still permits a stand-in, an engine
falling over mid-run would therefore have overwritten good rows before anyone
looked. The demand moved INTO the pipeline (`requireLive`), raising the typed
refusal between the embedding and the first write; the caller's check stays as a
second line. If an invariant is "we never write X", the guard belongs where the
write is, not where the result is read.

Second: **being in a catalog is not being gated by it.** `WRITE_TOOL_TABS` made
`reindex_corpus` visible to the agent hold gate, and `writeTargetScope` then
answered `personal` — its default for "the runner's own work" — so an agent
could have re-indexed a whole tenant unheld. That is the third time this exact
shape has cost something (`commit`, `push_app_files`, now this), so the fix is
both halves: a `company` scope that holds it to an admin under every preset, and
`AGENT_FORBIDDEN_TOOLS` — an operator act is refused at the agent door outright
and dropped from the advertised schemas, because a model will try whatever it can
see. **A new write whose effect is tenant-wide must be classified when it is
added; the default is "personal", and the default is wrong for it.**

**The platform write surface is now fully classified, and "who confirms it?" has
three answers, not one.** The last eleven `write: true` tools of the platform MCP
were declared writes that the hold gate could not see, so no preset held them —
`read-only` included. They were closed together on 2026-11-19 with a posture per
tool decided by the owner, and the ratchet in
`tabs/software/lib/builder/dispatch.test.ts` now pins the unclassified remainder
at **zero** (it stays two-way: a new platform write fails until it is classified).

| Posture for an agent run | Tools | Mechanism |
|---|---|---|
| **Refused** at the three agent-run doors below | `decide_deploy`, `promote`, `decide_approval`, `promote_connection`, `reindex_corpus`, `revoke_action_adoption` | `AGENT_FORBIDDEN_TOOLS` (`core/mcp/write-tool-meta.ts`). Also `COMPANY_SCOPE_TOOLS` as the second line. |
| **Held under every preset** — a second person confirms (engine path only) | `delete`, `archive`, `request_deploy`, `retire_connection`, `request_certification` | `ALWAYS_CONFIRMED_TOOLS` in `tabs/agents/lib/build/hold.ts` → `domain_admin` of the system's domain (`admin` under `read-only`). |
| **Held under every preset** — a *platform admin* confirms (engine path only) | `update_operating_manual`, `restore_operating_manual_version` | `ALWAYS_CONFIRMED_TOOLS` and `ADMIN_CONFIRMED_TOOLS` in `hold.ts` → `admin`. The scope (My / Domain / Company) is an argument the name-only gate cannot see, so it answers for the widest. |
| **Held on escalation** (pre-existing) | `publish_workflow` (and its deprecated name `publish_knowledge`), `request_promotion`, `approve_promotion` | `ESCALATING_DOMAIN_TOOLS` → `domain_admin`. |
| **My-scope** — `read-only` holds; otherwise the runner's own rights decide (gate 2) | `create_software`, `start_preview`, `use_connection`, `use_data`, `use_knowledge`, `use_as_data`, `commit`, `push_app_files`, `set_app_spec`, `design_software`, `create_connection`, `configure_connection`, `test_connection`, `build_software`, and every other catalogued write | the `personal` default of `writeTargetScope`. |
| **Not classified** — the gate answers "not a write" under every preset | `get_software_status` (see below) | pinned by the registry ratchet in `core/mcp/write-tool-meta.test.ts`. |

**Which door enforces what.** "Refused" and "held" are properties of a door, not of
a tool, and there are five ways a model's tool call reaches `handleRpc`:

| Door | Entry | Forbidden names | Hold | What a call may be |
|---|---|---|---|---|
| Agent system run | `runOsTeam` → `grantedToolExecutor` (engine, schedule, `run_agent_system`) | refused at gate 0, never advertised | yes — decided in the tools node, run parks | the system's grants ∩ the node's tools |
| Software Team panel | `runPhaseTurn` → `phaseToolExecutor` (`POST /api/software/team`) | refused, never advertised | **the user's own Confirm** for `request_deploy` (`PANEL_CONFIRMED_TOOLS`) — not a second person | only what this turn's agent was offered |
| App tool call | `callAppTool` (`POST /api/apps/<id>/tool`) | refused by name; `parseAppActions` rejects the declaration | the app's own reads-on/writes-off preset | the app's own tools |
| Ask the OS | `runOsAssistant` (`/api/assistant/chat`) | **not consulted** | **none** | the present user's whole role-scoped registry |
| Tab assistant | `runTabAgent` (`/api/agent-chat`, the app Build chat) | **not consulted** | **none** | the tab's tools for the user's role (an allow-list in Build-chat modes) |

The last two are interactive assistants acting for a person who is present, and
they are deliberately out of scope of both tables. There is **no structural
confirm step** before a write in either: `core/runtime/agent-loop.ts` says so in
its own words — its `writeToolNames` is "the harness's failed-call guard; it is
NOT a confirmation gate" — and "confirm before a write" is a prompt-level rule
only. A person's own MCP session and every UI route go straight to `handleRpc`
under the user's role gates and consult neither table, which is intended.

**The Software Team panel asks its user to confirm a deploy request (decided
2026-11-19).** The panel is a synchronous chat turn with no checkpoint, so it
cannot park a call for a second person the way the engine does. It applies the
product's own rule instead: a write happens only on the signed-in user's explicit
confirmation. When the deployer calls `request_deploy`, `phaseToolExecutor` does
not dispatch it. The call is stored in the user's server-side session, the model
gets a typed `awaiting_user_confirmation` result, and the turn's final event
carries what would be filed. The panel shows the app with a **Confirm** and a
**Cancel** button.

- **Confirm** → `POST /api/software/team/confirm` → `resolvePhaseConfirmation`
  runs the server-held call through the same governed executor, as that user. The
  client sends only the id and the decision, never the tool or its arguments.
- **Cancel** → nothing is dispatched; the outcome is the typed `not_filed` /
  `user_declined`, recorded with the session and in the trace. The session is back
  in `feedback`, where `request_deploy` is not offered, so the team cannot ask
  again until the user does.
- A confirmation is single-use, belongs to the user whose turn asked for it, and is
  dropped when that user sends a new message. With no way to ask (a caller that
  wires no `park`), the door refuses the call rather than running it.

This is a different guarantee from the engine's hold and is not a substitute for
it: here the confirmer is the requester, there it is a second person. The Builder
review that `request_deploy` opens is unchanged. `PANEL_CONFIRMED_TOOLS` is the
panel's own list, not derived from `hold.ts`. The waiting call lives in the same
in-process, per-user session as the phase (`phase-router.ts`), so a pod restart
drops it and nothing is filed. `delete` and `archive` are offered to no agent of
the team and stay uncallable there.

**The nine-tool backlog is decided (2026-11-19, the owner's decision).** These
were in the MCP registry and in no hold table, so the gate answered "not a write"
for each under every preset. All nine are in `WRITE_TOOL_TABS` now:

| Tool | What it does | Posture for an agent run |
|---|---|---|
| `revoke_action_adoption` | revokes a domain's adoption of an exposed entity's write actions | **refused** — a domain admin's governance decision, the inverse of an approval |
| `retire_connection` | archives a connection, or deletes it with its Trino catalogue and Secret | **always held** → `domain_admin` (the `delete`/`archive` family) |
| `request_certification` | files a Domain → Company certification request | **always held** → `domain_admin`. The platform admin decides the certification itself; making the same admin confirm that an agent may *ask* would have them approve twice |
| `update_operating_manual` | edits an Operating Model at My / Domain / Company scope | **always held** → `admin`. The gate sees the name, not the `scope` argument, so it answers for Company |
| `restore_operating_manual_version` | overwrites an Operating Model with a prior version | **always held** → `admin`, same reason |
| `create_connection` | creates a personal connection and stores its secret by reference | My-scope |
| `configure_connection` | renames, moves, demotes or re-configures the capabilities of a connection | My-scope, with the same Shared/Certified caveat as `set_app_spec` |
| `test_connection` | a live probe that writes the connection's status back | My-scope — so a `read-only` system now parks on it, like any other write |
| `build_software` | returns the build directive; with `SOFTWARE_BUILDER=agentic` it runs the build loop and commits | My-scope, same as `commit` — it reaches the same bytes |

Three consequences worth knowing before granting one of these to an agent:

- **These rules bind agent runs only.** A signed-in person calling the same tool
  from the UI or their own MCP session goes `app/api/mcp/route.ts` → `serveMcp`
  (`core/mcp/http.ts`) → `handleRpc` (`core/mcp/server.ts`), which checks the tool
  exists and the caller's role floor and nothing else. Neither module imports
  either table; `write-tool-meta.test.ts` pins that by source, and
  `core/mcp/connection-lifecycle-tools.test.ts` drives it: a domain admin's
  `revoke_action_adoption` reaches the governed lib, and their `retire_connection`
  executes at once with nothing filed in the inbox.
- **An agent's edit of its runner's own My-scope Operating Model waits on a
  platform admin.** That is the price of a name-only gate deciding a
  scope-dependent tool conservatively. An argument-aware hold would lift it;
  removing a name from `ADMIN_CONFIRMED_TOOLS` routes it to a domain admin instead.
- **`revoke_action_adoption` is now a reserved app-tool name**, like every entry in
  `AGENT_FORBIDDEN_TOOLS`: `parseAppActions` drops an `actions.yml` action called
  that and `callAppTool` refuses an OpenAPI `operationId` of that name.

**The unclassified backlog** is one tool, and it came out of the *read* list:

| Tool | Why it is here |
|---|---|
| `get_software_status` | Listed as a reviewed read, but it calls `reconcileDeployStatus`, which re-polls the runner and may write the app's deploy fields (the self-healed preview URL) back. Whether that is a governed write an agent should be held on has not been checked. Until it is, the gate answers "not a write" for it under every preset — which is what it did as a "read", but now it says so. |

The ratchet pins this list exactly, so it can shrink only by a reviewed diff and
cannot grow silently: a new tool that is in none of the three buckets fails the test.

Four things this cost, each of which generalises:

- **An approval must not be holdable.** Holding an agent's `decide_deploy` looks
  safe and is not: whoever approves the hold is approving "let the agent approve",
  so the go-live rests on one human judgement while the record shows a request, an
  approval and a confirmation. Four-eyes means two people. An agent may *request*
  (held) and may never *decide* (refused). The tools stay fully available to a
  person in the UI or their own MCP session — the table is consulted only at the
  three doors named above, and a test pins that `handleRpc` does not read it.
- **"Always held" and "tenant-wide" are different properties that happened to share
  one set.** `COMPANY_SCOPE_TOOLS` meant both. Deleting one app is not tenant-wide,
  and routing it to a platform admin would have made *asking* for a deploy need a
  higher role than *approving* one (a Builder). Hence a separate set with the same
  unconditional hold and the domain gate. Moving a name between the two sets is one
  line; the posture tests in `tabs/agents/lib/build/os-tools.test.ts` state which.
- **A parked run cannot be confirmed by its own runner.** `canApprove` refuses the
  requester whenever the approval carries a `runId`. So "held for confirmation"
  always means a second person with the role — on a single-admin tenant an
  always-held call waits until there is one. That is the intended reading of
  four-eyes, and it is worth knowing before granting `delete` to an agent.
- **The runner can take a held call back.** A hold has no timeout, so the person
  who started the run may *withdraw* their own pending held call
  (`withdrawHeldCall` in `core/policy/withdraw.ts`, `canWithdraw` in
  `core/policy/roles.ts`; `POST /api/governance/approvals` with
  `decision: 'withdraw'`; the button is on the run's parked banner and on the
  requester's card in the Inbox). The approval ends as `withdrawn` — a fourth
  status, not `rejected` — the tool is never executed, the run resumes exactly as
  after a rejection, the agent receives the typed `withdrawn_by_requester`
  result, and the audit log records `approval.withdraw`. Only the requester can
  do it (an approver who is not the requester already has Deny), only while the
  item is pending, and only for a parked run's call. The one transition it can
  make is pending → withdrawn, so it cannot be used to approve anything, and
  four-eyes for approval is unchanged. There is no MCP tool for it yet.
- **A frozen golden is evidence, not a spec.** The Software Delivery Team's fixture
  records the deploy request running straight through. The file is untouched; the
  engine-side assertion in `tabs/agents/lib/engine/parity.test.ts` now states the
  divergence exactly — the run parks at the deployer with one `request_deploy`
  awaiting a `domain_admin` — and then proves that, once approved, the resumed run
  ends on the golden's path, calls and final text. Nothing else moved: the team's
  other grants are My-scope under its `read-propose` preset, and `os.appsmith`
  grants none of the eleven.

Still open, and stated so nobody assumes otherwise: the hold is **name-only**
(`hold.ts` is pure and sees no arguments), so a My-scope tool cannot tell the
runner's Personal app (or connection) from one already Shared or Certified, nor a
My-scope Operating Model from the Company one; `get_software_status`, unclassified
above; and `promote_metric`, which is catalogued but My-scope although it is a
promotion. The registry ratchet covers `ALL_MCP_TOOLS` as registered in the test
environment — a bundle behind a flag that is off there is not in it.

**Groundwork for a user-confirm gate: the classification is production code, and
nothing consults it yet.** `core/mcp/tool-classes.ts` holds `READ_TOOLS` and the
backlog (they used to live only inside the registry ratchet test), a small table of
tools that sit in the write catalog and are confirm-free anyway — each with the
reason, each only after its handler was read — and
`needsUserConfirm(name) = !CONFIRM_FREE.has(name)`. It is fail-closed: an unknown
name, a backlog tool and every other catalogued write need confirmation.
`WRITE_TOOL_NAMES` alone is the wrong predicate for this question because five
read-shaped tools live in a write barrel (`list_exposure_sets`,
`get_catalog_snapshot`, `get_catalog_classification`, `list_exposed_tables`,
`list_adoptable_actions`). Three cost-only actions that save nothing are confirm-free
too (`preview_metric`, `suggest_metrics`, `propose_quality_fixes`). Two that read like
them are **not**: `run_quality_checks` appends a run to the dataset's durable quality
series and `export_okf_bundle` creates a Files artifact. This changes no behaviour —
the interactive-assistant rows in the table above are still accurate, and a test in
`core/mcp/tool-classes.test.ts` fails if a production file starts importing the
module before the gate that uses it is reviewed.

**The harness takes a *gated* executor, and every interactive assistant uses the confirm gate.**
`runAgentic`'s `callTool` is a `GatedToolExecutor` (`core/runtime/confirm-gate.ts`, pure): a plain
executor does not type-check (`confirm-gate.typecheck.ts` fails the build if that stops being
true), so a caller has to pick a constructor. **Every interactive turn picks `userConfirmGate`**:
Ask the OS (Home chat, the drawer, a direct API call), the per-tab assistant and `/api/agent-chat`,
the app Build chat, and the Software Team panel. A write parks until the same user confirms it;
a turn that names no conversation gets a server-minted id, returned as `conversationId`; a
confirmation is bound to user, conversation and **surface** (`ask`, `tab:<tab>`,
`app-chat:<appId>`, `team`) and each surface decides on its own route, which re-applies that
surface's bound ids and tool allowlist. The old `ungatedInteractive` constructor is deleted, so
a new surface cannot choose it; `core/runtime/confirm-gate.test.ts` pins the call sites of the
gate and the files that call `runAgentic(`. `engineHeldGate` (engine paths that hold elsewhere)
has no production caller.

What the later wiring will rely on, already in place and tested:

- A third tool outcome, **`parked`**: the gate did not run the call. The harness
  keeps it out of the dedup and failed-write ledgers and out of the error streak,
  stops the batch there (later calls get "not executed: an earlier action awaits
  the user"), ends the turn, and composes the final text itself
  (`parkedFinalText`) — the model gets no further completion in which to say the
  action happened. `AgenticResult.pending` carries what parked.
- A store, `core/policy/confirmations.ts`, shaped like the approvals store but a
  different thing: the *same* person confirming their own assistant's action, not
  a second person deciding an agent run. Ten-minute expiry; single use is the one
  `pending → executing` transition; a wrong user is indistinguishable from "not
  found"; the confirmed call is identified by a sha256 of its canonical signature.
  The durable mirror receives the record **without its arguments** (they can hold
  a credential or a file), so a record read back after a restart is expired
  rather than executable.
- "Allow for this conversation": a per (user, conversation, tool) allowance that
  can only be created for `SESSION_ALLOWABLE_TOOLS` — seven tools that create a
  new Personal artifact or append a record. Edit tools are deliberately absent:
  the gate is name-only and cannot tell a Personal artifact from a shared one.

Not built: the confirm endpoint, any UI, and any caller that parks. The external
MCP door (`app/api/mcp/route.ts` → `serveMcp` → `handleRpc`) references none of
this, by test — a person's own MCP client is not confirm-gated.

**A picker scoped to "everything the caller may see" is not scoped to the thing being
edited.** The agent grant picker built its feed from `listDatasets/listWorkflows/
listPersonalKnowledge/listFiles/listMetrics(principal)` — each of which scopes to
`principal.domains`, the union of the caller's memberships whenever no single active
domain is chosen — and never consulted the SYSTEM's own domain, which it had already
read for the 403 gate and thrown away. An admin in four domains editing a system in one
of them was therefore offered all four domains' folders, including their personal
folders elsewhere. `/api/folders` had the answer the whole time: it narrows with
`activeDomain`, and the two surfaces simply never compared notes. The fix is one shared
predicate, `core/kernel/domain-scope.ts`, applied by the agents grant feed
(`tabs/agents/lib/grant-feed.ts`, with the system's domain as the target) and by the
tab-agnostic context feed (`tabs/software/lib/available-context.ts`, with the user's
active domain). Three things that fix had to get right, and each generalises:

- **A narrowing that hides a live grant is a lie.** A folder grant saved before the
  narrowing can point outside the system's domain; dropping its node would show a
  system granting less than it grants — and because the tree's tick-and-save round trip
  removes de-selected folder grants, the next save would DELETE it. Such a node is
  re-admitted flagged `outsideDomain` and rendered with a warning instead.
- **Narrow the presentation, never the enforcement.** The real gates stayed put: the
  canView/DLS filter inside each lister, and the per-item re-resolution of every folder
  grant against the acting principal at build/run (`tabs/agents/lib/build/os-tools.ts`).
  A build-time resolution must be a function of the runner's authority, not of whatever
  a picker currently shows, or the same system does different things on different days.
  And be precise about which gate you are invoking: the first draft of this entry credited
  `assertGrantsWithinAuthority` with gating agent grants. It does not — it validates the
  grantee list of a **promotion approval**. An agent grant rides the edit-scoped `system.yaml`
  PUT with no per-id validation at all; what makes it safe is that execution runs as the
  acting principal, so a grant the runner cannot read returns nothing. Naming the wrong gate
  in a comment is how a codebase convinces its next reader that something is checked when it
  is not.
- **A narrowed feed is also a narrowed DIFF, and a diff is what deletes things.** The review
  of this change found the hole: the picker reconciled the tree's selection against the whole
  system, so a grant the narrowed feed could no longer show looked exactly like one the user
  had just unticked — and the first tick deleted it. `triState` renders an item-less folder
  'none' and `computeSelection` skips it, so a re-admitted node alone fixes nothing. The
  reconcile (now `tabs/agents/lib/grant-apply.ts`, lifted out of the component so it is
  testable) removes only inside what the feed actually showed: `listedItemIds` and
  `protectedFolders`. Pass neither and it removes nothing — when the universe is unknown, do
  nothing rather than destroy. The identical bug existed in the software context picker
  (`reconcileGranted` kept `current.filter(g => target.has(g.id))`). **Any time you narrow a
  feed, audit every reconcile that treats that feed as the full universe.**
- **Carve-outs are part of the predicate, not of the caller.** Company (Marketplace) items and
  domainless artifacts are always kept (the Company rule is `core/kernel/company-scope.ts`,
  shared by every store's view gate and list since 2026-11-23 — see
  `core/policy/README.md` "The scope ladder"), and a `null` target narrows nothing (Ask the OS
  in "All domains" has no single domain to narrow to). Written once, those rules cannot
  drift between the two feeds; written at each call site they would have.
- **No gate on save still needs a WARNING on save** (2026-11-23 incident). A student's
  system.yaml granted a dataset that was private to another user. The run refused it — the
  enforcement was right — but nothing said so at save or build, and the chip read "outside this
  domain … the grant still works at run time", which was false for that user. Now every save
  (files PUT, the assistant's legacy write, MCP `commit_agent_files`/`create_agent_system`) and
  every build (route + MCP) returns `grantWarnings` (`tabs/agents/lib/grant-access.ts`):
  each granted id resolved AS THE ACTOR through the governed `get_*` door
  (`build/grant-access-probe.ts`, the tab's own canView — 403 `forbidden` ⇒ `not-visible`,
  404 ⇒ `not-found`, visible-but-foreign ⇒ `outside-domain`). Still a warning, never a gate:
  access can change after the save. It is also never a COST: probes run 5 at a time under a
  2.5 s overall deadline (unanswered ⇒ no warning), the build probes alongside the build, and
  the files PUT probes only on `?check=grants` — every grant toggle commits through that PUT and
  would otherwise wait on a Trino/Dagster-touching `get_dataset` it throws away. Membership is
  `allDomains`, not the active-domain switcher. The message names only the id and the TEAM's domain —
  never the hidden resource's name or owner. Note the init-order trap: anything under
  `core/mcp/*-tools.ts` that reaches `@core/mcp/server` must import it lazily (`await import`).

**A draft the user can see is a promise the component has to keep.** "Where the results
go" kept the typed output (kind · name · scope · folder) in `useState` and committed it
only when a button labelled `+ Add output` was pressed — a label that reads as "add
another", not as "this is how your typing is saved". Every exit from the Define stage
unmounts the section, so the author filled the fields, moved on, and came back to an
empty row: "the settings reset". Two rules, both already learned in the Knowledge
editor and both re-learned here: the **guard belongs to whoever owns the exit** (the
builder owns the stage rail, the "Grant context →" button and the back buttons, so the
section only reports `{dirty, valid, save, discard}` upward — a guard inside the section
would have covered none of them), and the registered `save` must be **re-registered on
every draft change** so it saves what is on screen rather than what was on screen when
dirtiness last flipped. A complete draft is committed on the way out; only an incomplete
one is worth a question. `tabs/agents/lib/output-draft.ts` holds the two predicates, and
a source tripwire keeps the old label from coming back.
**Four-eyes on a one-person tenant is not a control, it is a deadlock.** The approvals
queue refuses the requester whatever their rank (`canApprove`, A2 review L-G) — correct for a
parked agent run, where the whole point is that a second human authorises what the first
one's agent tried. Applied to an AUDIENCE promotion it inverted: rung-1 requests are
owner-only by construction, so an owner who also held the approver authority filed a request
nobody on earth could decide. Their own dataset, file, dashboard, workflow, app or agent
system could not leave My, and the queue just grew. Worse, the two front doors disagreed —
MCP `approve_promotion` never had the check, so the same act succeeded there and failed in
the Governance inbox. The rule now yields for the audience-ladder kinds and only when nothing
parked a run on them; rank and scope are still checked first, which is what keeps it from
being a widening. **A separation-of-duties rule needs a story for the case where one person
holds both duties** — otherwise it does not separate anything, it just stops.

**A refusal that does not reach the user is a bug, not a gate.** The owner's
"0 requested · 1 failed" on a file promotion was a *correct* documentation gate
(`Cannot promote — add a description, at least one tag first.`) whose reason the bulk UI
discarded. Auditing every other kind for the same shape found four more, each a different
way of losing the same information: the agent-system promote button had no branch for the
route's `{requested:true}` 200 and so looked like a no-op; the software one dereferenced
`body.app` unconditionally and showed the user a TypeError instead of "request filed"; the
workflow publisher had a bare `res.json()` and no `catch`, so a 502 produced *nothing*; and
the Governance inbox replaced the effect's real message with the literal `"Effect failed"`
and then skipped its own reload, leaving the only copy of the cause (`effect.applied`)
invisible until a manual refresh. Three habits prevent all five: `res.json().catch(() => ({}))`
plus a real `catch`; a branch for every documented response shape, not just the happy one;
and an error field that carries the cause rather than a category.

**A gate the approver cannot see through is a gate nobody can open.** Dashboard promotions
were fileable and permanently unapprovable: `transitionDashboard` read the record through the
normal view gate, and a Personal dashboard is visible to its owner alone — deliberately, since
`canManageArtifact` closes the `personal` scope to admins too. So the domain admin's approve
answered "not authorized to view this dashboard". The fix is not to weaken that privacy rule
but to notice that **the owner's filed request IS the consent**: a Personal dashboard only
reaches the ladder because its owner asked for it to be published, so the appointed approver
may read what they are being asked to decide (`getDashboardForGovernance`). Everything else
keeps the old gate.

**An audience is only an axis if the kind HAS one.** A metric's tier is read straight off its
dataset (`tier: TIER_OF[d.tier]`), so "Personal metric" just means "the dataset is private"
and no metric-level approval can change it. Both front doors nevertheless filed an
`artifact_promote` carrying `artifactKind: 'metric'`, for which `applyLadder` has no case: a
creator could file, and the domain admin's approve then died on `unknown ladder artifactKind`
and left the request pending forever. Deriving a property is fine; **offering a control over a
derived property is a promise you cannot keep.** Both doors now refuse with the dataset named,
and the stale queue shape refuses with the same sentence instead of an internal error.

**Personal data before Company is an admin setting enforced in the store's certify, not at the door.**
A Company dataset is readable by every domain and only grant `mask` / `hide` protects a column
(column classification is not compiled into masks). The rule (`block` default / `confirm` / `off`,
Platform → Settings) is stored with the tenant settings and PUBLISHED by `tabs/admin/lib/settings.ts`
into `core/policy/personal-data-rule.ts`, so `tabs/data/lib/store.ts` reads it without a tab→tab
import; until the settings store has answered, the effective rule is `block` (fail-closed), so a
door that wants the saved rule hydrates settings first (certify / approvals routes, the MCP server
before `decide_approval`). The check (`tabs/data/lib/personal-data-gate.ts`) reads the ONE
classification (`ColumnDoc.personalData`, set in Documentation or MCP `document_dataset`; a docs
write without it keeps it) and the ONE masking source (`maskedColumns`, the policy compiler's own
union). It runs inside `certify()` and `transition('certify')`, which every door reaches; a refusal
is a typed 409 (`personal_data_unprotected` / `_unclassified` / `_confirmation_required`) with the
columns and the fix, and the decision (plus the certifier's reason) is on the certification badge
and in a `certify.personal-data` audit row. Tests that certify for another reason turn the rule
off explicitly at the top of the file.

**An audience change is audited in the store's write path, not at the door.** On 2026-11-23 a
prod dataset went `private → domain` with a domain grant and left no version and no audit event:
the audit lived in SOME doors (the Data promote route, the Governance route) and not others (MCP
`approve_promotion`, the legacy `/api/agent/approvals`, the Software data plan, the lifecycle /
certify / import routes), and `PUT dataset.yaml` could set `tier: asset` with no gate at all.
Now `persist` in `tabs/data/lib/store.ts` and `tabs/files/lib/store.ts` compares the record it
overwrites with the one it writes and, on any domain / tier / visibility / grant change, calls
`core/policy/audience.ts` → a `governance.audience.change` audit event (target
`<kind>:<id> (<name>)`, so the id is searchable — `data` is not indexed) and a version naming the
change (files: the version log; datasets: the domain-repo commit, WP-37, whose OS-Action carries
the change, and whose dbt meta carries `os_visibility` / `os_grantees` so the commit is never
empty — and a pushed edit of those keys is refused with `AUDIENCE_MANAGED`, like `os_tier`).
`writeFile` refuses governance fields; a file restore keeps the current audience; a domain move
re-points the `domain:<old>` read grant and records the acting admin. A files version stores the
state BEFORE the change, like every other entry in that log.

The ratchet in `tabs/data/lib/audience-history.test.ts` fails a new function in either store that
assigns `.tier` / `.visibility` / `.grants` (or `['tier']`…) without calling `persist`, a new
function that writes a record directly (`writeThrough(`, `.store.set(`, `.yaml =`, `writeNew…(`,
`writeMergedYaml(`) without a pinned, reasoned entry, and any such write in top-level code (bar the
one mirror refresher). **Its limits:** it is a regex scan of `function` declarations in those two
files; it cannot see a mutation through an aliased property name or a helper that mutates its
argument, and it does not police other stores. Knowledge, agents, software, connections and
dashboards change visibility in per-function code with no such choke point yet.

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

## Software: an app's source tree is a git subtree (night-2, stream S)

An app is not an OpenSearch document any more. Its source tree lives in **the domain's bare git
repository** at `apps/<slug>/` — one repo per domain on the `os-repos` PVC — written through the
one commit path (`core/infra/git-store.ts` `commitSubtree`) by `tabs/software/lib/git-commit.ts`,
with a boot-time `reserveSubtree('apps/')` registered from `instrumentation.ts` so the dbt
generator's whole-tree commit keeps every app. Author = the acting user, committer =
`Sovereign OS`, trailers `OS-Action` / `OS-Object: app:<id> (<name>)` / `OS-Surface` /
`OS-Request-Id` (+ `OS-Actor`, + `OS-Run-Id` inside a run). The OpenSearch `os-app-files` mirror
is **a cache of the committed tree**, not the home of record; `readAppTreeFromGit` is the read
half both doors use, and every answer is labelled `governed-commit` | `mirror-cache` |
`template-seed`.

`push_app_files` is the one documented verb for "code in Claude, push to the OS"
(`tabs/software/lib/push-app-files.ts`). One service, two doors: the MCP tool and
`POST /api/software/<id>/files`. The compile gate runs **before** any write — a red gate is a 422
with the diagnostics and nothing is committed — and `commitSubtree` commits only when the tree
hash changed, so two identical pushes are one commit.

`core/infra/git-store.ts` gained an **additive** tag block (delimited `=== S TAG BLOCK ===`):
`annotatedTag` (immutable — re-releasing a version is 409), `listTags(prefix)` (one app's release
history: `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>`), `resolveTag`, and the path-scoped `logPath`. No
existing export's signature changed.

**Two traps closed.** `normalizeServeMode` now defaults to `'spec'`, and `appImageRef` throws
`MissingAppImageError` (409) when no image is set — the old `'image'` default plus the chart's
`traefik/whoami:latest` meant any legacy record going live served a stranger's placeholder
container on the customer's own domain, and reported success. And a `demo-seed` result is now
**structurally** unusable as evidence: `tabs/software/lib/seeded-evidence.ts` `assertNotSeeded`
refuses it at `requestDeploy`, on the review card, at `decideDeploy` and in the
`verify_software` verdict, because a label in a response field is one a caller can drop.

**The app ↔ agent ↔ data triangle.** `core/app-sdk/agents.ts` gives a governed app
`os.agents.run/get/decide`, and all three post to the **same routes the OS UI posts to**
(`/api/agents/systems/<id>/run` → `enqueueRun`, that run's `run_events` stream, and the one
`/api/governance/approvals` inbox), same-origin with the ambient session — no token exchange, no
app principal, no key of the app's own. A held write surfaces as `state: 'parked'` with its
approval id. The other direction: an app **declares** its actions in `actions.yml`
(`tabs/software/lib/app-actions.ts`) and an agent may call one only through the four-layer
fail-closed intersection **capability ∩ declaration ∩ adoption ∩ grant**, with a `domain_admin`
consent step and a write **held** under the reads-on/writes-off preset. Data goes only through
the governed paths as the end user, so two sessions of the same app see different rows. The
whole triangle, plus both negative cases, is `tabs/software/lib/triangle.test.ts`.

### App intent: what an app may ask the OS for (night-2 review H-1)

A governed app runs in a same-origin sandboxed iframe and calls the OS with the ambient
`soa_session` cookie — which is the cheapest correct answer to "as the signed-in user", and was
also, until this landed, enough for app code to start agent runs and approve held writes
silently. Three layers now stand between an app and those two actions, and each is claimed for
exactly what it does:

1. **A scoped, signed intent.** When the OS renders an app it mints an HMAC intent
   (`core/kernel/app-intent.ts`) for THAT user and THAT app, carrying `agent-run` **only**, and
   injects it into the app document. The SDK sends it back as `x-os-app-intent` with
   `x-os-app-origin: app`. `guardAppIntent` runs on `POST /api/agents/systems/[id]/run` and
   `POST /api/governance/approvals`: a request that announces itself as an app, or presents a
   token at all, must present a valid one — minted for the session's user, unexpired, scoped —
   or it is a 403 with the reason. A cross-site `Sec-Fetch-Site` is refused outright. No code
   path mints `approval-decide` for an app, so approving is refused by construction.
2. **The app does not post the approval.** `os.agents.decide` sends `os:app-decide-request` to
   the host shell; the shell renders the ask in OS chrome and links the user into the top-level
   Governance inbox, where the user decides. The app cannot drive the top level —
   `allow-top-navigation` and `allow-popups` are both omitted from the sandbox — and the shell
   holds no token in its DOM, because an `allow-same-origin` child could read it.
3. **The app frame's `connect-src` is an allowlist.** This is the layer that binds a HOSTILE app,
   which could otherwise simply omit the headers: a header guard cannot tell such an app from the
   OS UI on our own origin.

**Not claimed:** a same-origin `allow-same-origin` frame is not fully isolated. The complete fix
is a null-origin frame with a postMessage RPC for every OS call — a deliberate redesign of the
identity bridge, recorded as deviation S-9 rather than assumed.

## Versioning every object kind: one generic read over the domain repos

(Night 2, stream G — `core/infra/git-objects.ts`, `core/ui/git/`, `core/mcp/git-tools.ts`.
`docs/components/git.md` carries the authoritative repo-layout table and the commands.)

Every builder artefact lives in its domain's repository (see "Git-based working" above), so
"which version is this, what did it look like, what changed, put that back" is the same question
for a dbt model, a dbt metric, a dashboard, an agent system and an app. It is answered once:

```
objectGitInfo(user, kind, id)         -> { head, history[], truncated, via, paths }
getVersion(user, kind, id, sha)       -> the object's files AT that commit
diffVersions(user, kind, id, a, b)    -> a unified diff (no diff dependency; 40 lines of LCS)
restoreVersion(user, kind, id, sha)   -> ONE NEW COMMIT through the object's normal writer
```

**The kernel may not import a tab, so the tabs register themselves.** `GIT_OBJECT_LAYOUT` is the
static layout table in @core; each tab calls `registerGitObject(kind, resolver)` at boot
(`instrumentation.ts`), and the resolver runs **the tab's own governed read as the caller**. A
resolver answers `null` — or throws, as a tab's read does for a forbidden object — and both
become ONE byte-identical `not_found`, so an id cannot be probed for existence.

**Why the path fallback exists, and why it is not optional.** The per-object read-back used to
filter the domain log by the `OS-Object` trailer alone. A boot reconcile commits as the PLATFORM
with `OS-Object: <domain>`, so every object whose only commits were reconciles answered
`head: null` — the UI then said "never committed" about a system sitting in the tree. The
generic reader merges a path-scoped `git log -- agents/<lane>/<slug>/` in whenever the trailer
did not fill the page, and reports `via: 'trailer' | 'path' | 'trailer+path' | 'none'` so the
answer never hides which source produced it. `tabs/agents/lib/git/history.ts` is now a thin
adapter over this module rather than a second implementation.

**Restore is a new commit or it is a refusal.** `restoreVersion` reads the old files and hands
them to the kind's registered writer; nothing in @core knows how to write a dataset or a system,
by design. A kind with no registered writer gets a typed `restore_unsupported` (501) — after the
`not_found` gate, so a refusal never confirms that an object exists. A version too large for one
read, or with no files at that commit, is refused too: a partially applied restore is worse than
none.

**The enumeration test is the gate that makes "everything lives in git" non-optional.**
`core/infra/git-objects-kinds.test.ts` fails when a kind is added without a layout row, when a
kind claims a `committed` writer whose module does not reach `commitTree`/`commitSubtree`, and —
the direction that catches drift — when a module imports those primitives and **no object kind
claims it**. A new writer therefore cannot land without classifying its artefact kind as
committed, landing (naming the stream) or backlog (with a reason).

### Governance → Repositories, and why the mirror verdict is not a boolean

The Repositories section (`tabs/governance/ui/RepositoriesView.tsx` over
`tabs/governance/lib/repositories.ts`) exists so "everything built in the OS lives in git" is
checkable rather than asserted: every domain repository with its head, its commit count, its last
author, its commit log on demand, and the layout table straight out of `GIT_OBJECT_LAYOUT`.

The mirror verdict has **four** states for one reason: `pushMirror` records the sha it last
pushed, and a push that SUCCEEDED two commits ago is not the same thing as a healthy mirror. So
`ok` requires the last successful push to be AT the repository's current head; an older one reads
`behind` and names both shas; a failed attempt reads `failed` and carries the real error (an
egress refusal, an auth failure) rather than "push failed"; no configuration at all reads `none`
and says the repository lives only on the OS volume. A boolean would have made the most common
real state — configured, working, one commit behind until the next write — look identical to
either health or failure.

### Why a version read redacts and a restore does not

`core/infra/git-store.ts` `readFilesAt` is RAW on purpose and `core/infra/git-objects.ts`
`getVersion` scrubs. That asymmetry is the whole design: `getVersion` and `diffVersions` are the
only paths that hand repository bytes to a browser or an AI client, while `restoreVersion`
re-applies bytes through the object's writer — so a redaction performed in the primitive would be
WRITTEN BACK into the tree, replacing a real value with `***REDACTED-BY-OS***`. Scrub at the
read-out boundary; never in the thing a writer consumes.

Two consequences worth keeping: the diff COMPARES raw content and only then redacts, so a change
entirely inside a redacted value is reported as a redacted change instead of as "no change"; and
the patterns are shape-based, never entropy-based, because a commit sha, a blob oid and a UUID are
all high-entropy and redacting them would corrupt every diff the drawer renders.

Binary blobs follow the same honesty rule from the other direction: decoding one as UTF-8 produced
replacement characters that looked like content, so a binary file is reported with `binary: true`
and its size and an EMPTY content — and a version containing one is refused for restore, because
re-applying that empty content would truncate the file.

## The dbt semantic layer — a metric is a dbt metric (stream M)

`tabs/data/lib/dbt/semantic/` is the OS's metric artefact. Six pure modules: `spec.ts` (the ONE
pinned spec version plus the closed DSI enums), `model.ts` (the typed `semantic_models:` +
`metrics:` document, its emitter and its **parser**), `validate.ts` (a key/enum whitelist against
the pinned spec, plus the closed `filter:` grammar), `from-measures.ts` (the OS `Measure` → dbt
bridge, with a named refusal for anything that has no faithful form), `time-spine.ts` and
`render.ts` (the project renderer `generateProject` calls).

Four things here have each cost someone real debugging time, in this product or in dbt's:

- **`docs.getdbt.com` lies about your dbt version.** It serves the 1.12 ("Fusion") spec by default
  and its `?version=` selector is client-side only, so a fetch always returns 1.12 — a breaking
  redesign of this exact spec. The authoritative source for 1.8–1.10 is the `dbt-semantic-interfaces`
  pydantic spec at the version dbt-core pins. Hence one constant, `DBT_SEMANTIC_SPEC`, named in
  every generated README and asserted by a test. **Read the dbt version off the images before
  changing it**: they pin `dbt-core>=1.8,<1.10`, so they run 1.9.x, and `cumulative_type_params`
  does not exist at all on 1.8.
- **dbt names are project-global.** Two datasets each with a `revenue` measure, or a metric name
  used twice, fails `dbt parse` for the **whole domain** — every other dataset included. So every
  measure and metric name goes through one allocator per namespace, shared across the domain, and
  the OS identity is carried in `config.meta.os_metric` / `os_member` rather than in the name.
  Measures and metrics are *separate* namespaces: a measure and its `type: simple` metric sharing a
  name is the canonical dbt shape, not a collision.
- **One unknown key takes the domain down, so validate before writing.** `validateSemanticDoc` runs
  on the plain object the emitter produces (not a parallel model that could drift), and `render.ts`
  DROPS a document with violations and records them as refusals. The same reflex as
  `dbt/schema.ts`: never emit a weaker version of what the author wrote, and never emit something
  that fails the parse.
- **dbt renders YAML through Jinja before reading it.** Authored prose is encoded by
  `dbt/literal.ts` `freeText` (ASCII braces → fullwidth braces, so no delimiter can form);
  identifiers are validated against closed allow-lists, never cleaned. The one field that must keep its Jinja is `filter:`, so it is held to a closed grammar
  (`{{ Dimension('e__d') }} <op> <literal>`, conjunctions only, no Jinja delimiter in the literal).
  A predicate outside that grammar refuses the whole metric rather than emitting a weaker filter.

Execution does **not** move: a metric read is still `tabs/metrics/lib/explorer.ts` compiling one
governed Trino `SELECT` run as the viewer. MetricFlow is never on the request path (it would open
one connection from its own profile and lose per-viewer impersonation), and where it is installed
at all it is pinned `>= 0.209.0` — `<= 0.208.1` is BSL 1.1 and BSL does not relax retroactively.

## The engineering view: the OS orchestrates, the tools own the artefacts

One panel, one adapter per object kind, one structure over both doors.

`core/engineering/types.ts` defines `EngineeringView` — per-tool sections, each with the tool's own
noun, the artefact (the real bytes), the repo path, a deep link and **the command an engineer would
run** — plus `sealView`, which refuses a view that is not honest: a section with no artefact and no
reason, an artefact with no body and no note, a link that does not resolve and does not say why.

`core/engineering/registry.ts` maps `kind` → adapter; `core/engineering/register.ts` fills it with
dynamic `import()` so **the kernel still never imports a tab**. Each tab owns
`lib/engineering.ts`: it calls its own visibility gate first (so the refusal a client sees is the
tab's own `not_found` / `forbidden`, with no new visibility rule anywhere) and then maps its record
onto the shared builders in `core/engineering/sections.ts`.

`core/ui/engineering/UnderTheHood.tsx` is the only renderer — mounted with one line on the five
detail surfaces — and `GET /api/engineering/<kind>/<id>` and the MCP tool `get_engineering_view`
both call `engineeringViewFor`. One function, so the panel and an engineer's client cannot drift.

Three things to know before you add a kind or a tool:

- **The vocabulary rule is data.** `core/engineering/vocabulary.ts` lists the tools' nouns; a label
  that uses only an OS-invented noun fails the test, and the bridge ("dbt metric (KPI)") is allowed
  once. Add a noun to the table, not a string to a component.
- **Show the real thing.** The YAML and SQL come from the repository at `main` through
  `core/engineering/repo.ts`; the LangGraph graph is derived from the SAME IR
  (`langgraph-compile.ts`) and the SAME node naming (`safeNodeName`) the engine compiles with, and
  `tabs/agents/lib/engineering.test.ts` pins the derivation against a real `buildGraph`.
- **The panel may never show what the caller could not have fetched.** An adapter re-applies the
  repository's own membership rule (`requireMember`) before it shows a byte or offers an export,
  and a tool link is gated by that tool's `minRole` — a Company-tier data product is visible
  outside its domain, its domain repository is not. And every adapter hands its tracked-path set to
  `gitSection` and `sealView`, so a path the repository does not track cannot reach the screen.
- **Where the OS still does it its own way, say so on the panel.** The app's git section states
  that app source is in the OS file mirror and not yet an `apps/<slug>/` subtree; a KPI with no
  `models/semantic/<model>.yml` states that `mf query` would not resolve yet. That is the
  `docs/components/trino.md` honesty pattern, applied to our own surfaces.

## Chat to the data — the artifact protocol (stream C, night 2)

An "Ask the OS" turn returns `{ content, plan, tools[], artifacts[], traceId }`. The
`artifacts[]` are the governed tools' OWN MCP `structuredContent`, carried to the browser
unchanged, so the drawer and an external MCP client (Claude Desktop) render the identical
bytes. There is one serialiser, in `core/runtime/chat-artifacts.ts`, and six kinds:
`table` · `chart` · `metric_draft` · `dashboard_draft` · `citation` · `clarification`.

Six read tools declare it: `query_data`, `query_metric`, `preview_metric`,
`suggest_metrics`, `get_metric`, `get_dashboard`. Each sets `outputSchema` to
`ARTIFACT_OUTPUT_SCHEMA` and an `artifacts` projection — a PURE function of the result its
own governed `call` already produced. A projection may not read, may not compute and may
not throw usefully: the dispatcher guards it, so a renderer bug degrades to "no artifacts"
and never turns a successful governed read into an error.

**Three rules this path exists to enforce.**

1. **Truncation is never laundered — and the semantic layer is not exempt.** `QUERY_MAX_ROWS`
   clips to the FIRST n rows, not a sample (`core/infra/governed.ts`), and `query_metric`'s
   compiled serve SQL carries a `LIMIT n` of its own, so the layer that "accepts no SQL by
   construction" can clip a grouped result exactly as raw SQL can — the bound is the OS's, not
   the model's. When a metric query reaches its bound the scalar is **withheld**, not flagged
   (`value: null` + `valueWithheld`): a flagged wrong number still gets pasted into a slide, an
   absent one with a reason cannot be. `rowLimitTruncation()` is the shared decision, and it
   treats "returned exactly n" as possibly-clipped, because SQL cannot report what it did not
   return. The notice is also **prepended** to the text the model reads (`⚠ TRUNCATED: …`): the
   truncation keys sit near the end of the pretty-printed JSON and `truncateToTokens` keeps the
   HEAD, so on exactly the big results most likely to be clipped the notice was the first thing
   dropped — and a model that never saw it cannot obey the rule forbidding a total over it.
   The chat surface used to flatten the whole tool result
   into a markdown string, so whether the user learned the result was clipped depended on
   whether the model chose to mention it — and "total revenue was €4.2m" over the first
   1,000 rows is the worst thing this feature could do. Now `truncated` / `rowLimit` /
   `message` ride the artifact, the backend's own sentence is shown VERBATIM above the rows,
   and `rowCount` is the tool's count and never `rows.length`. The drawer's own 50-row cap is
   reported on a SEPARATE line: merging the two would let a 50-row view read as a 50-row
   result. Guard tests at every hop — mapper, dispatcher, chat path, view.
2. **An ad-hoc number says so.** A `query_data` answer is labelled *"Ad hoc SQL —
   unverified"* with the SQL shown, because its aggregation and joins were chosen for that
   question and reviewed by nobody. A `query_metric` answer is the governed number and
   carries no caveat. The label is a field on the artifact (`source`), not a sentence we
   hope the model wrote.
3. **No model-authored markup, ever.** An artifact carries DATA. The protocol declares no
   `html`, `markup`, `svg`, `href`, `src`, `style` or `url` field — asserted by a test — and
   `core/ui/ask-artifacts-guard.test.ts` scans the whole chat path for
   `dangerouslySetInnerHTML`, `eval`, `new Function`, `srcdoc` and `<iframe>`. A citation's
   link comes from a fixed in-app route map, never from the payload. For data charts the
   right answer is to not have the problem: typed rows plus a vetted component, values
   rendered as text nodes.

**One trace per turn.** `runOsAssistant` mints a per-turn id and passes
`observe: { traceId }` into `runAgentic`, which forwards it to every model call — the plan,
each act iteration and the cap synthesis — so LiteLLM's own Langfuse callback logs INTO that
trace (`existing_trace_id`) instead of starting a fresh one per call. The turn is also tagged
`tab:ask` + `run:<turnId>`: the tab lens no longer doubles as the cost dimension, because an
Ask turn on the Data tab used to be tagged `tab:data` and was indistinguishable from the Data
tab's own calls. The id is minted SERVER-SIDE — a client-chosen trace id would let one user
write into another user's trace.

**Three honesty lines, never merged.** A table can be clipped by the backend, *and* not sliced
as asked (a dimension the governed view does not expose was dropped), *and* longer than the
drawer shows. Those are three separate facts with three separate sentences — `message` (the
backend's, verbatim), `warning` (the tool's own loud degradation, verbatim) and the view's own
row-cap note. Merging any two loses one of them, and `rowCount` always stays the tool's count.

**What is NOT true yet.** Threads are not durable: the drawer still holds messages in
`useState` and the route still trusts the last 20 messages the client sent. The `chart`,
`metric_draft` and `dashboard_draft` renderers are not built — the drawer counts what it
cannot render and says so, rather than discarding it silently. There is no `os.analyst`
LangGraph system and no write path from chat; the migration off `runAgentic` is staged behind
a flag with a parity harness per decision D12 and has not been started. The ask trace is FLAT —
`observe` carries only `traceId`, so calls nest directly under the turn rather than under a
per-step OS span, which needs the engine migration. `exploreMetric` still discards the
query-tool's own `truncated`/`rowLimit`/`message` before `query_metric` can see them
(`tabs/metrics/lib/build/explore-server.ts`), so a `QUERY_MAX_ROWS` clip landing *below* the
metric's own `LIMIT` is not yet detected — a three-line fix in the metrics tab, filed for its
owner. And the confirm before a write is **prompt-level only**: `writeToolNames` stops a failed
write re-firing byte-identically, but it is not a confirmation gate; the structural one is the
writer node's tool allowlist (C15, backlog).

## The coin — git is the system of record, and both doors write the same files

*(stream E, night 2; decisions D27–D29. `docs/components/git.md` is the user-facing half.)*

Git is where everything the OS builds lives: one bare repository per domain under
`config.reposDir`, written by `core/infra/git-store.ts`. The registry (the tab stores) is a
**derived index plus governance metadata** — ownership, tier, approvals, audit. Where a file and a
row disagree, **the file wins and the row is re-derived**.

There are exactly **two doors into those files**, and they meet at the same functions:

| Door | Enters at | Identity | Commit surface |
|---|---|---|---|
| UI | `app/**/route.ts` → the tab's governed service (`tabs/data/lib/mutations-server.ts`, `tabs/agents/lib/store.ts`) | the signed-in `CurrentUser` | `ui:<route>` |
| MCP / Ask the OS | `core/mcp/server.ts` `handleRpc` → the SAME governed service | the signed-in `CurrentUser` | `mcp:<tool>` |
| `git push` | the repo's `pre-receive` hook → `app/api/git/receive` → `core/infra/git-receive.ts` → the SAME governed service | an OS **personal access token** resolved to a live principal (`core/auth/access-tokens*.ts`, `core/auth/git-http-auth.ts`) | `git:push` |

Three rules keep the two sides of the coin from drifting, and each one is structural rather than a
convention someone has to remember:

1. **Read is unconditional; write is gated.** `/api/git/authenticate` gates reading on domain
   membership and nothing else — the whole tree, `os/*.yml` included. Path ownership, validation
   and serialisation apply only to a push.
2. **One validator, not a second copy.** `core/` may not import a tab, so `git-receive.ts` holds no
   validator at all: each kind **registers** the validator the UI already calls
   (`registerRepoKind({ kind, matches, validate, ingest })` — `parseSystem` for an agent system, the
   dbt gate for `schema.yml`). A second copy is not something a reviewer has to notice; there is
   nowhere to put one.
3. **One lock.** A push and an OS commit are mutually exclusive because `git-receive.ts` chains on
   the **same** per-repo mutex `git-store.ts` serialises its writers on (the global
   `Symbol.for('soa.git-store.locks')` map), held from `pre-receive` to `post-receive`. The wait is
   bounded: a lock the OS holds too long fails the push with a readable message rather than hanging
   a developer's terminal.

After a push, `reconcileFromGit(domain, from, to, pusher)` dispatches to each kind's
`ingestFromRepo`-shaped `ingest` — `tabs/data/lib/dbt/ingest.ts` (dbt models + `schema.yml` →
dataset records, quality rules from the tests) and `tabs/agents/lib/git/ingest.ts` (`system.yaml` →
agent systems) — writing **through the governed services**, attributed to the pusher, inside
`runWithSurface('git:push')`. The test that keeps this honest is literal: the same change made over
the MCP and by a push must leave identical files and identical registry state, differing only in the
`OS-Surface` trailer.


## Lifecycle: Studio → Test → Run (the second axis)

Two orthogonal axes, and keeping them orthogonal is the whole design. **Audience** is
`My → Domain → Company`: who may use an object as an official artefact, changed only by the
promotion path. **Lifecycle** is `Draft → Testing → Live`, attached to a **version**: whether this
version is being built, tried out, or run. A `My` object can be Live; a `Company` object can have
a Draft. `core/kernel/object-lifecycle.test.ts` carries a tripwire that fails if any function ever
derives one axis from the other.

- `core/kernel/object-lifecycle.ts` — pure, import-free, **total over all seven kinds**:
  `lifecycleOf(kind, id, head, index)` never throws. Also the ONE go-live dependency guard, the
  two badges' words, the confirm copy, the migration and the `env:` mapping. It is re-exported
  from `@core/kernel/lifecycle`, whose own contents are the unrelated archive/delete confirm copy.
- `core/kernel/lifecycle-adapters.ts` — the per-kind registry. **The kernel must not import a
  tab**, so each tab's adapter (`tabs/<tab>/lib/lifecycle-adapter.ts`, importing only `@core/*`
  and itself) registers itself at boot in `instrumentation.ts`, which is the one place in os-ui
  allowed to know both halves. A kind with no adapter is an honest typed refusal from `go_live`.
- `core/infra/lifecycle-pins.ts` — **the pin**, where the complexity lives: a durable index plus
  the committed, readable, not-pushable `os/lifecycle/pins.yml` in its own reserved subtree.
- `core/kernel/go-live.ts` — the one service BOTH doors call (`core/mcp/lifecycle-tools.ts` and
  `app/api/lifecycle/route.ts`), so a click and a tool call cannot drift. There is no setter that
  takes a lifecycle word.
- `core/mcp/list-args.ts` — the ONE optional `lifecycle` list filter. `withLifecycleArg` adds the
  property without touching a tool's `required`; `lifecycleView` annotates and narrows both
  payload shapes the stores return. `LIST_TOOLS_WITHOUT_LIFECYCLE` names every exception with a
  reason, and `core/mcp/lifecycle-filter.test.ts` asserts that list and the registry agree in both
  directions — so a new artifact list tool cannot quietly skip the filter.

**The thing to remember:** *what operates reads the pin, not the head.* A scheduled agent run
reads the pinned `system.yaml` out of the repository, and a dashboard's Run view resolves the
pinned spec. Both **fail closed**: an unreadable pin refuses the run, and a pin whose version is
no longer retained shows nothing and says why. Neither ever falls back to the draft — a different
version running than the one that was signed off is the exact failure the pin exists to prevent.

**And the two rules that cost the most to get right.** First: *a pin is never written on the
strength of an index nobody could read.* `core/infra/lifecycle-pins.ts` records HOW it hydrated —
the durable mirror, the committed `os/lifecycle/pins.yml` in the domain repos, or nothing — and
every writer refuses with a 503 unless one of the first two answered. A mirror that answers but
knows no pins is the dangerous shape (a rebuilt index looks exactly like a tenant that never went
live), so in that case the committed files are read and adopted. This is the September-2026
failure in a new place, and the guard is the same shape: an empty store is only a fact when the
source answered. Second: *a new gate must not break what already works.* Before the one-time
migration has established the index nothing has a pin, so a scheduled agent run falls open to the
head — once, loudly, naming the fallback — and fails closed for ever after.

## The agentic app builder (stream H)

`tabs/software/lib/builder/**` is a second, flag-gated builder for the Software tab: a bounded
**planner → coder → build → reviewer** loop. Three things about its shape are load-bearing, and
breaking any of them is how it would rot.

1. **Pure core, injected edges.** `grounding.ts`, `acceptance.ts`, `prompts.ts`, `loop.ts` and
   `dispatch.ts` have no model client, no store, no `fs` and no `fetch`. That is why the loop's
   headline property — *the first coder output fails to compile and the loop recovers on iteration
   2* — is a deterministic unit test with a scripted coder rather than a live-model hope. The real
   world lives in `grounding-server.ts`, `tools.ts` and `loop-server.ts` only.
2. **The API surfaces are EXTRACTED FROM SOURCE, never written down.** The pack reads the shipped
   `core/app-sdk` / `core/app-ui` source through the existing vendor readers and parses the
   `OsClient` interface and each `*Props` type out of it. Hand-writing that list is the failure mode
   it exists to prevent: the prompt would drift from what `compile-gate.ts` actually checks, and the
   model would be blamed for the harness's stale brief.
3. **Compile IS the write gate.** The loop never writes anything itself; it calls `commitToApp`,
   which runs the compile gate before any write and throws the exact diagnostics as a typed 422. Do
   not add a second write path "just for the builder" — a red tree would then be able to land.

A fourth property was added by the review round, and it generalises beyond this builder:

4. **A machine check over model-authored content must read the AST, not the text.** Scoring "this
   file reaches governed data" with `String.includes('os.records.add')` is forgeable by a comment, a
   string literal or a JSX text node — and the thing being scored is output the model chose. Any
   future check over generated code belongs on `ts.createSourceFile` (`builder/symbols.ts` is the
   pattern: parse-only, no program, no checker, cheap enough for every iteration).

And one trap this stream fell into, recorded because the next person will too: **anything the Build
dispatch can reach must not take a static import edge back to `@core/mcp/server`.** That module
top-level-awaits its experimental bundle registration, one of those bundles is `platform-tools`,
and `platform-tools` imports `tabs/software/lib/platform-mcp` — so a static edge from anything
downstream of the dispatch closes a cycle on a pending top-level await and **every test file that
touches the MCP server hangs** (28 of them, reported only as "unsettled top-level await"). Import it
lazily at the call site. `builder/dispatch.test.ts` pins the property with a hard-timeout import.

The honesty rules this codebase already punishes you for breaking apply with extra force here,
because a builder is judged by its own report: an ungated shape is `unknown`, never a pass; a
`manual` acceptance check is never machine-passed; a tree that compiles but satisfies no story is
committed (on budget exhaustion) with `ok: false` and the unmet checks named; and a reviewer that
says PASS over a scorecard with a FAIL is **overridden** and told so.

## A generated app ships a real lockfile (scanner plan item 9)

Trivy resolves npm dependencies from `package-lock.json` and never reads the ranges in
`package.json`. Scaffolds used to emit a manifest and no lockfile, so every generated app reached
the review card as "scan INCOMPLETE (deps not covered)" and needed an admin's written
acknowledgement to deploy. A new coded app is now seeded **locked**
(`tabs/software/lib/scaffold-lock.ts`, called by `createApp` only). Five things came out of
building it, and each one generalises.

**A lockfile is the record of a resolution, so it can only be produced by resolving.** The files
in `tabs/software/lib/scaffolds/locks/` are the verbatim output of `npm install
--package-lock-only` (`os-ui/scripts/regen-scaffold-locks.mjs`) over exactly the manifests a seed
commits. The one thing done to them at seed time is writing the app's slug into the two `name`
fields npm copies from the manifest — verified once against npm itself (a seed re-resolved under
another slug is byte-identical) and pinned by a test that the seeded file differs from the
committed one in those two fields only. Everything else is a refusal: the agentic builder may not
write a lockfile anywhere in the tree (`pathRefusal`, `src/` included), because a model can only
write something that *looks* like one and the scanner would read invented versions as the app's
dependency tree.

**The brief assumed a lockfile could be generated for the manifest as it was. It could not.** The
Vite scaffolds declared `@sovereign-os/ui` and `@sovereign-os/app-sdk` as registry ranges
(`^0.1.0`), and neither package is published — `npm install` on a freshly generated app failed
with E404, and so would the scaffold's own Dockerfile. Seed-time vendoring had existed
(`applySdkFileDep`, `vendorUiForRepo`) and was dropped in the v2 restructure, leaving the docstrings
describing a tree nobody produced. So a locked Vite seed declares both as `file:` dependencies and
carries the vendored source under `vendor/@sovereign-os/*`; the Dockerfile copies `vendor/` in
before the install. That tree was installed with `npm ci` and built (`tsc -b && vite build`) from a
clean directory before the lockfile was committed. **When a manifest cannot be resolved, the fix is
to make the manifest true, not to produce a lockfile for a different one.**

**Presence is not evidence; agreement is.** A `package.json` edited after its lockfile was
generated still yields a tidy `lang-pkgs` result — over the dependency set the app used to
declare. `tabs/software/lib/lockfile-evidence.ts` compares each npm manifest with the lockfile
that covers it: name, version, every range in all four dependency fields (peers included — npm
installs them, so a peer-only manifest is not "nothing to resolve"), a resolution entry for each
declared name, **and that the resolved version satisfies the range that asked for it** (`^4.17.21`
beside a resolution of 4.17.20 is stale although both sides exist). Vendored and workspace
packages are held to the entry the root lock keeps for them, including a resolution for each of
their own dependencies. `mapTrivyReport` puts `deps` in `notRun` when any manifest is stale, when a
manifest that declares dependencies got no result of its own while another did, or when a lockfile
that resolves packages got no result from the engine — each with a reason naming the remedy. It
is the same predicate the scaffold drift test uses, so "in sync" cannot mean two things. **What it
cannot see** is written at the top of that file: it contacts no registry, so a lockfile forged end
to end but internally consistent passes; the range check is a small semver subset (`semver` is not
an os-ui dependency) that declines to judge tags, aliases, URLs and prereleases rather than guess —
and is run against every range in the real lockfile in the tests, so it cannot call a sound lock
stale; `yarn.lock`, `pnpm-lock.yaml` and npm lockfileVersion 1 are not parsed and still rest on the
engine's result alone.

**One covered corner must not read as the whole tree — in any ecosystem, and it took three
passes to mean it.** The first version asked "did *any* `lang-pkgs` result come back?", so an
`api/pyproject.toml` with no lockfile rode on the npm lockfile's result. The second gave every
non-npm manifest its own evidence but left two doors open: a `package.json` under `yarn.lock`,
`pnpm-lock.yaml` or an npm v1 lock was judged by nobody, and the carve-outs were generous (any
`requirements*.txt` satisfied a `pyproject.toml`; any ancestor lockfile satisfied any manifest
below it). Now: every manifest needs a result for a specific file (`evidenceTargets`, and for npm
the lockfile recorded by `lockfile-evidence.ts`) — the manifest itself for `requirements*.txt` /
`go.mod` / `pom.xml`, which Trivy parses directly; `requirements.txt` by that exact name beside a
`pyproject.toml`, `setup.py` or `setup.cfg`; otherwise the NEAREST lockfile, and an ancestor's only
when no other manifest of the same ecosystem sits in between. The limits are in that function's
header and are real: workspace membership is inferred from layout and never read from the
workspace file, and only npm lockfiles are compared with their manifests — a stale `poetry.lock`
or `yarn.lock` is not detected, only an unread one. **A carve-out is a claim of coverage; write it
as narrowly as the evidence, and expect the reviewer to find the one that was not.**

**"Covered" has to say covered BY WHAT.** Trivy drops development dependencies unless run with
`--include-dev-deps`, and 180 of the Vite lockfile's 189 packages are dev — the bundler and
compiler the scaffold's own Dockerfile runs. Without the flag, "deps covered" on a fresh app meant
nine production packages had been looked at, while `npm audit` on the same tree reported a high
advisory in `vite` (GHSA-587h-7wmj-h5pm) and a moderate one in `esbuild`. Both halves were fixed:
the scaffold moved to `vite ^6.4.6` (esbuild 0.25.x; `npm audit` on a materialised seed: 0
vulnerabilities, and it still installs with `npm ci` and builds), and the scan now passes
`--include-dev-deps`, so coverage is claimed for the whole lockfile. The compile gate is
unaffected by the scaffold's Vite version: it compiles with the OS's own `esbuild-wasm` and a
`vite/client` shim, never the app's toolchain. A lockfile test pins the patched versions so a
regeneration under a loosened range cannot walk back onto the advisories.

**"Nothing was found" needs something to have been looked at — and sometimes there is nothing to
look at.** Trivy emits no result for a lockfile that resolves zero packages
(`pkg/scanner/langpkg/scan.go`, v0.58.2), which is the APIs-only scaffold exactly. Reading that as
"deps not covered" would have made the zero-dependency template the one that still needs an
acknowledgement. So a manifest that declares no dependency, beside a lockfile that agrees and
resolves none, needs no engine result. It needs the lockfile: a bare manifest proves nothing, which
is also what keeps an API app created before this change exactly where it was.

**A change that only applies to new things must be made where new things are made.** Six call
sites read `getSnapshot(app.id) ?? templateFiles(...)` — the template is the *fallback tree* of
any app without a snapshot, including one whose mirror failed to hydrate. Putting the lockfile
into the template functions would have silently changed the effective tree, and the scan verdict,
of every such app. `templateFiles()` therefore stays the plain scaffold and only `createApp` calls
`lockedSeed`; the failure direction of a lost snapshot is "deps not covered", never a green tick
for a lockfile the app's real tree does not contain.

Be exact about "existing apps are untouched", because the first write-up of this overstated it.
An app with a stored tree — a mirror snapshot or a tree in git — is byte-for-byte unchanged. An
app with neither reads the template fallback, and that fallback DID change in one place: its
`package.json` now asks for `vite ^6.4.6` where it asked for `^5.4.2`. The patched range was
applied to the one manifest both seeds share rather than leaving the plain scaffold on a range that
resolves to a release with a known high advisory. Such an app still has no lockfile, no vendored
tree and no dependency coverage.

Two things the tests turned up that were already broken. The scanner's path allowlist had no `@`,
so any tree with a file under `vendor/@sovereign-os/` — which "refresh vendored SDK" has been
committing all along — failed the scan closed on its first vendored file; `@` is admitted (it is
inert inside the single-quoted `sh` word a path sits in). And the scanner tests' own "lockfile"
fixture was `{"lockfileVersion":3}`, a file that describes no manifest: the new check rightly reads
it as stale, and the fixtures now carry locks that agree with the manifests beside them.

Where the lockfiles live: `scaffolds/locks/<family>.package-lock.json`, imported as JSON so they
are bundled with the server and present for the worker's type-stripped source. The name is
deliberate — syft's npm cataloguer keys on the exact filename `package-lock.json`, so these do not
enter the repository SBOM as if their packages were shipped by the OS. They are template data; the
licence rule that applies to them is the scaffold one, enforced by `scaffold-lock.test.ts` with
each exception named (today one: `caniuse-lite`, CC-BY-4.0 browser data pulled in by
`autoprefixer`).

**What a locked app still does NOT get, stated so nobody assumes it:**

- **The vendored `@sovereign-os/*` source is not vulnerability-scanned by anything.** It is not a
  registry package, so no advisory database knows it; `sast` is `notRun` on every scan; and
  Trivy's secret scan skips nested `vendor/` paths among others (the card's reason now lists what
  it skips instead of claiming "every file"). Its safety rests on it being the OS's own reviewed
  source at the moment the app was created.
- **The gate and the image compile against different copies.** The compile gate type-checks an
  app against the OS's CURRENT `core/app-ui` / `core/app-sdk`, while an image built from the app's
  tree uses the copy FROZEN under `vendor/` at seed time. They are identical on day one and drift
  as the OS evolves; "refresh vendored SDK" re-vendors the SDK only, and nothing re-vendors the UI
  package. Making the gate prefer the tree's own `vendor/` was considered and left: the vendored
  source is memoised process-wide for the compiler host and shared, in deliberate lockstep, with
  the preview bundler (`vfs-resolve.ts`), so it is not a small change.
- **A non-CLI user cannot regenerate a lockfile inside the OS.** Nothing in the OS runs npm. When
  a manifest changes, the remedies are: run `npm install --package-lock-only` on a checkout and
  push the new `package-lock.json` (`push_app_files`, or paste it in the code editor), or have an
  Administrator acknowledge the uncovered dependency scan in writing. There is no button, and the
  agentic builder is refused both `package.json` and every lockfile.

**A lost snapshot is not an empty app (again).** `commitToApp` merged a push over `getSnapshot() ??
templateFiles()` and then replaced the app's whole git subtree. `hydrateSnapshot` returns null when
the mirror is unreachable as well as when there is nothing to read — so one partial push during a
mirror outage committed the deletion of everything not in the template: every file the user had
written, for any app, and for a locked app its lockfile, vendored tree and `file:` manifest too.
`priorTreeForCommit` (`tabs/software/lib/server.ts`) now reads in the order of trust: the mirror
snapshot, then **git, the home of record** (`readAppTreeFromGit`; a truncated read is not used,
since merging over part of a tree deletes the rest), then the template — and the template only
when it can stand in for the app's tree. `app.repo.seeded` records what the app was created with;
if the template plus the push lacks any of those paths the commit is refused (503, nothing
written), naming the two real ways out: retry when a store answers, or push the app's complete
tree. That refusal is reachable for a locked app that was never yet committed to git (creation
writes the mirror, not git) and for an older app whose template has since dropped a seeded file.
What is still not fixed: an app whose seed is the current template, with git disabled or no
domain, still merges over the template and loses user-authored files — there is no other copy to
read. And the six READ-side fallbacks (scan, preview, records, builder) still read the template
for an app with no snapshot; a scan there reports "no lockfile", which is true of the tree it was
given and not of the app.

Costs, stated: a locked Vite seed is about 214 kB (lockfile 95 kB, vendored OS packages 79 kB,
scaffold 40 kB) against the scan payload ceiling (`DEFAULT_MAX_PAYLOAD`, 900 kB encoded), so an
app has less room to grow before a scan is refused as too large; the seed test fails if the seed
alone passes half the ceiling. The regeneration script pins `--registry=https://registry.npmjs.org/`
and a test asserts every `resolved` URL, so a maintainer's private mirror cannot leak into every
generated app. The legacy `nextjs-supabase` family ships no lockfile on purpose
(`next` resolves `sharp`'s LGPL-3.0 libvips binaries). No Trivy binary ran in the tests — the
v0.58.2 release carries no downloadable binaries — so the first scan of a locked app on a cluster
is the real confirmation that the engine returns a `lang-pkgs` result for these files. If it does
not, the app reads "deps not covered" as before: the coverage claim still rests on the engine's
own result.

### The `@sovereign-os` scope is pinned to nowhere (dependency confusion)

The vendored packages are named `@sovereign-os/ui` and `@sovereign-os/app-sdk`, and **the project
does not own that scope on the public npm registry** (neither package nor the organisation existed
on 2026-11-19; the owner does not want an npm account). Anything that asks a registry for the scope
would receive whatever a stranger chose to publish there. The lockfile above only protects a tree
that still has it. `tabs/software/lib/scope-pin.ts` adds two things that do not depend on owning
the name:

- **Prevention.** Every template tree carries a project `.npmrc` with
  `@sovereign-os:registry=https://sovereign-os-is-vendored-not-published.invalid/`. `.invalid` is
  reserved by RFC 6761 and can never be delegated, so the lookup fails closed in any client that
  honours the line, and the host name is the explanation in the error. The Dockerfiles the
  scaffolds emit copy that file in before the install, set the same pin at user level
  (`npm config set`), and run the install with it in the environment — which is the only layer
  that also beats a project `.npmrc` pointing the scope elsewhere (measured: a user-level value
  loses to a project file, an environment value wins).
- **Detection.** `scopePinFindings` runs inside `securityScan`, so on every deploy request and
  layered onto a live Trivy result. A manifest URL / git reference / `npm:` alias for the scope, a
  version range in a tree that carries `vendor/@sovereign-os/`, a lockfile entry for the scope
  that is not a local link, or an `.npmrc` that sets the scope's registry to anything else is a
  **blocking** `deps` finding.

**What npm really does, measured with npm 11.12.1 on a generated `vite-os` seed** (not assumed):
`npm ci` and `npm install --offline` install both packages as links into `vendor/` with the pin in
place, contact only `registry.npmjs.org` for the third-party packages and never for the scope, and
leave `package-lock.json` byte-identical; resolving the lock inputs with and without the `.npmrc`
gives the same lockfile hash (`regen-scaffold-locks.mjs` now resolves with it). `npm install
@sovereign-os/ui@latest` fails with `getaddrinfo ENOTFOUND
sovereign-os-is-vendored-not-published.invalid` and no request to npmjs.org — also with
`--registry=https://registry.npmjs.org/` on the command line, because a scope registry outranks
it. Without the pin the same command asks `registry.npmjs.org` (E404 today).

**It is not fast, and the fast alternative was rejected.** npm retries the failed lookup twice
with 10 s and 60 s back-off: about 70 s by default, 1 s with `--fetch-retries=0`. A malformed URL
fails instantly, but only because today's npm throws while parsing it; a client that skips a line
it cannot parse would fall back to the public registry. Closed-and-slow beats fast-and-maybe-open.

**Existing apps are not rewritten, and the legacy manifest does not block.** The plain
(pre-lockfile) Vite scaffold declares `"@sovereign-os/ui": "^0.1.0"` with no vendored folder. Every
coded app created before seeds were locked holds that manifest, and the template fallback a
*declarative* app's deploy request is scanned over is that tree too — the first version of the
detection blocked on any version range and the end-to-end test showed a declarative app could no
longer be approved. So a plain range in a tree **without** `vendor/@sovereign-os/` is reported and
never blocks: `medium` while the tree has no pin (the exposed state: `npm install` there asks the
public registry), `info` once it does. The OS itself never installs these trees — it serves them
from its own source — so the exposure is a build run elsewhere. The remedy is one file, and
`push_app_files` accepts an `.npmrc` that contains exactly the pin and nothing else (every other
`.npmrc` is still refused). A stored tree is never changed for the user; only the template
fallback (an app with no stored tree at all) now includes the file.

**Not covered:** npm run outside the OS on a tree whose `.npmrc` was removed *and* whose manifest
was edited, without the scaffold Dockerfile; Yarn Berry (it does not read `.npmrc`); `yarn.lock` /
`pnpm-lock.yaml`, which are only searched for a registry URL naming the scope; the Docker build
itself, which was not run here (the Dockerfile lines are asserted as text, their npm behaviour was
measured outside a container). Registering the scope on npmjs.org would close the root cause and
remains the owner's decision.

## Which models may be sent images: a list, not a guess

Message content is a plain string everywhere today, and no model call sends an image. Before any
does, the question "may THIS model be sent an image?" has exactly one answer in the codebase:
`canReceiveImages(model)` in `core/models/capabilities.ts`.

- **It is a data-egress decision, so it is an explicit list.** The built-in list is the four
  gateway aliases the STACKIT profile points at Qwen3-VL-235B on STACKIT (EU):
  `sovereign-reasoning`, `sovereign-vision`, `sovereign-premium`, `sovereign-reasoning-fast`.
  `sovereign-default` / `sovereign-mock` (text-only) and `sovereign-embed` are not on it.
- **A name is never evidence.** `tabs/agents/lib/routing.ts` `tierOf` calls any model whose name
  contains "qwen", "vl" or "vision" the `vision` tier. That is a display label. The capability
  check is exact, case-sensitive membership; an unknown model, a look-alike and a role name are
  all `false`. `capabilities.ts` imports nothing, so no heuristic can leak into it.
- **Admins control the list.** `MODEL_IMAGE_ALLOWLIST` (chart: `osUI.imageAllowlist`, rendered into
  both the `os-ui` and `os-ui-worker` env) is a JSON array that **replaces** the built-in list, so
  a model can be removed as well as added; `[]` means no model. A value that cannot be read falls
  back to the built-in list with a logged warning — there is no wildcard and no input that means
  "all models". Same mechanism as `MODEL_CONTEXT_WINDOWS`: JSON in an env var, read on each lookup.
- **Pass the alias that is actually sent.** The argument is the final LiteLLM `model_name` in the
  request's `model` field — after `roleModel(role)` and after a per-agent pin. Checking a role
  name, or checking before resolution, checks the wrong thing.
- **The list names aliases, not endpoints.** Re-pointing a listed alias in
  `litellm.proxy_config.model_list`, or adding a router fallback from a listed alias to an
  unlisted one, must update the list in the same change. Nothing verifies that for you yet.
- **It is not the file gate.** This says which models may be shown an image at all. Which files
  may be shown is a separate, earlier decision, and nothing here can override it.

Visible read-only in Platform → Models & Providers ("Images: yes/no" per model, plus the list in
force) and in `GET /api/agents/models` (`images` per row, `imageInput`). `capabilities.test.ts`
fails if a second image-capability predicate, or a second reader of the override, appears anywhere
under `core/`, `tabs/` or `app/`; `scripts/check-image-allowlist-chart.mjs` checks the rendered env.

## UI text and the user's language (i18n, wave 1 — 2026-11-26)

The UI is in seven languages through next-intl **without locale routing**. Design:
`docs/superpowers/specs/2026-11-26-multilanguage-design.md`; converting a tab: `docs/i18n/how-to.md`.

- **The preference is per user, server-side** (`core/prefs/locale.ts`, `os-user-prefs` doc `locale-<userId>`),
  mirrored into the user-bound cookie `soa-locale` so the first byte of SSR is already in the right language.
  `core/i18n/request-state.ts` resolves it (`resolveRequestLocale`: saved preference → this user's cookie → English)
  and the layout re-sets a cookie that lags the saved preference; logout clears it. Saving is governed by OPA's
  `user_pref_write` (own record only, fail-closed).
  There is no Accept-Language negotiation, by decision.
- **Catalogs**: `os-ui/messages/<locale>/<namespace>.json`, imported statically by `core/i18n/catalog.ts` and merged
  over English. Every namespace file exists in every locale, so a wave touches only its own files. Keys are
  type-checked against the English catalogs (`core/i18n/next-intl.d.ts`).
- **Components** import from `@core/i18n/client` (`useTranslations`, `useFormat`); async server code from
  `@core/i18n/server` (`getTranslations`, `getFormat`, `getUserLocale`).
- **The AI answers in the user's language** through ONE helper, `core/i18n/answer-language.ts`. English adds
  nothing, so an English prompt is byte-for-byte what it was. A run the worker executes reads the language FRESH
  (`getUserLocaleFresh`): its prefs copy predates the user's change, the same staleness the stores above suffer.
  Scheduled and API runs use the agent owner's language (`runLocaleSubject`).
- **Never** translate user content, MCP tool descriptions or typed error codes, and never format a number or date
  by hand in converted code — `scripts/check-i18n.mjs` (CI) keeps catalogs in parity and fails hard-coded text in
  every module listed in `scripts/i18n-converted.json`.

## The App Builder switch and its extension points (W0, 2026-11-27)

The App Builder (`docs/superpowers/specs/2026-11-26-app-builder-design.md`) is merged dark. Three rules hold every
workstream to "flag off ⇒ zero prod change"; the exact names are in the plan's "W0 as built" section.

- **One switch.** `softwareRunner.environments.enabled` (default false, independent of `softwareRunner.enabled`, which
  prod has on) renders `SOFTWARE_APP_BUILDER=on` through `_os-ui-env-appbuilder.tpl`; read it only through
  `core/kernel/app-builder-flag.ts`. Every `_os-ui-env-*` partial must render NOTHING while it is off: an extra env line
  changes the pod template and restarts os-ui in prod. Prove it with `scripts/check-app-builder-flag-off.mjs` (diffs the
  rendered chart against the merge-base; Secret values are random per render, so only their keys are compared).
- **Shared files have one owner; others plug in.** New MCP tools and v2 behaviour of existing tools go in
  `tabs/software/mcp/app-builder/<ws>-tools.ts`, push reactions in a receive hook, pre-rollout steps in a pre-deploy
  hook, deployment env in `deploy-env-block.ts`. None of them runs while the switch is off.
- **An app is judged by the template version it was created from** (`App.templateVersion`, absent ⇒ 1): `templates/
  nextjs-web/` is frozen, v2 changes go to `templates/nextjs-web-v2/`, and the chart's gate files are keyed `v<n>.<file>`
  and selected by the PipelineRun's `templateVersion` param. Names in the shared env namespaces always come from
  `appResourceName(domain, slug, part?)` / `appDbIdent(domain, slug)` — the 8-hex hash is always in the name, because
  slugs are unique per domain only and `-` is legal in both domain and slug.

### The app identity token (App Builder E, D1)

An App Builder app (v2, flag on) acts as the signed-in user with an OS-issued token, never with a key of its own.
Code: `core/auth/app-{token,login,login-codes,consent,consent-page,identity}.ts`, routes `app/api/auth/app-{login,token,
jwks,consent}`, the Software tab's resolver `os-ui/app-token-sources.ts` (registered in `instrumentation.ts`, flag on
only), template `templates/nextjs-web-v2/src/lib/os/session.ts`.

- **Accepted only on an allowlist, decided in the kernel.** `core/kernel/auth.ts currentUser()` reads an
  `Authorization: Bearer` whose JWS header says `typ: os-app+jwt` only while the flag is on, and only for the route the
  edge middleware names in `x-os-app-route` (set from the real request, a client value is dropped). The route must be
  in `APP_TOKEN_ROUTES`; reads by id must be inside the app's grants AND the user's consent; `by-slug` routes must
  resolve to the token's app for that user (slugs repeat across domains). Off the list the request is "not signed
  in" — a refused token never falls back to a cookie. A route handler cannot see its own path, which is why the
  middleware header exists; never trust that header on a request the middleware did not process.
- **No role in the token.** The user record is re-read on every call (`principalById`), the app re-resolved, the
  token's scope must still be inside the app's CURRENT derived scope, and the consent record is re-read.
- **OPA rules that load only with the flag.** `app_consent_write` / `app_token_issue` live in
  `charts/.../policies/app_identity.rego`, which `_policy-files.tpl` / `opa.yaml` load only while
  `softwareRunner.environments.enabled` is true: adding them to `authz.rego` would change the OPA ConfigMap and its
  revision (a pod restart) in prod with the switch off.
- **Key.** `os-app-token-key` (Ed25519 JWK set, first key signs, every key verifies) is referenced, never rendered;
  mounted on os-ui only (not the worker). Missing ⇒ the pod does not start with the flag on, and the kernel refuses
  every login and bearer (`AppTokenUnavailable`) rather than use a fallback key.
