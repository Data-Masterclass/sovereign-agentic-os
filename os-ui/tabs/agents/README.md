# Agents · Build

Build, run and govern agents. Their grants, runs, traces and the scoped credential each run uses.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/agents`

**APIs**

- `/api/agents`
- `/api/agent`
- `/api/agent-chat`
- `/api/assistant`

**MCP tools**

- `agent-write`

**Needs deployed**

- `litellm`
- `opa`
- `langfuse`
- `opensearch`
- `postgres`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## The agent engine — one engine, and it is LangGraph

Since A5 of the rebuild (`docs/superpowers/plans/2026-11-13-engine-rebuild.md`) there is exactly
ONE executor. There is no engine flag, no `runtime:` choice and no fallback path: the hand-rolled
IR walker, its mock twin and the Python `agent-runtime` interpreter are deleted. `AGENTS_ENGINE`,
if an environment still sets it, is ignored with one deprecation line at boot.

### From `system.yaml` to a running graph

1. `lib/system-schema.ts` parses and byte-stably serialises the file (the definition layer, unchanged).
2. `lib/langgraph-compile.ts` compiles it to the **IR** — nodes, supervisor members, conditional
   edges, handoff commands with their `when` guards, state channels.
3. `lib/engine/build-graph.ts` `buildGraph(ir, deps)` turns that IR into a real
   `StateGraph` from `@langchain/langgraph`. **Four nodes per agent:**
   - `plan_<id>` — the reasoning tier, no tools. One pass per visit.
   - `act_<id>` — the execution tier WITH the node's tools. Native tool-calling; the ReAct text
     protocol only after the model rejects the `tools` parameter.
   - `tools_<id>` — the **node-level gate**: it executes only what this node is *advertised*, not
     every system grant, one call per superstep so each is checkpointed before the next.
   - `route_<id>` — where the run goes next: a handoff whose `when` guard evaluates true
     (`Command({ goto })`), else END.
   A **supervisor** is `route_<sup>` with a mandatory `route` tool returning `{ next, brief }`
   (text fallback `NEXT: <member>`) and `addConditionalEdges` to its members ∪ END — it *decides*,
   it does not visit in declared order. A member returns to the supervisor's ROUTE node, so one
   decision call per return. `when` guards are a ~40-line safe parser (`lib/engine/when.ts`) —
   literals, `state.<channel>` truthiness, bare channel names, `==`/`!=`, `&&`/`||` — never `eval`.
   A guard over a channel nothing **can** set is a compile WARNING carried on the run report, not a
   silent false (see *State channels* below). The team step budget becomes `recursionLimit`; exhaustion is a graceful stop that returns
   what completed. Disabled agents are pruned at build; an unmapped legacy grant, a disabled
   entrypoint or a channel shadowing an engine key is a compile ERROR.
   What `build-graph.ts` does NOT own is what one agent *is* — its model tier, its system prompt,
   the running team transcript, the Context-Librarian handoff and how an outcome is classified all
   live in `lib/build/agentic-graph.ts`, which the graph calls into.
4. `lib/engine/run.ts` `runGraphEngine` streams it (`['custom','updates']`), maps the custom
   chunks onto the live hooks, and reads the result back from `getState`.
5. **Build compiles the same graph.** The `langgraph` row of Build is
   `lib/build/compile-verify.ts` → `buildGraph` (live and offline alike), so a ✓ there means the
   graph the engine will execute can actually be constructed from this `system.yaml`.

### State channels — how a guard becomes true

A `when` guard can only route if something sets the channel it reads, so the engine gives the
agents a way to write one. `state.channels` in `system.yaml` is a map of **name → declaration**:

```yaml
state:
  channels:
    messages: add_messages    # the shared conversation (appends) — always present
    plan_ready: boolean       # a typed, last-write-wins channel; starts at false
    attempts: number          # starts at 0
    verdict: string           # starts at ''
    report: json              # any JSON value; starts at null
```

Every declaration becomes a real **typed state key** in the `Annotation.Root` of the compiled
`StateGraph`, with the type's default and a last-write-wins reducer (`add_messages` appends, as
before; an unrecognised declaration — the legacy `last_value` — is an untyped `json` channel, so
files written before the types keep working).

The agent whose turn a guard follows — the `from` of the guarded handoff, because the guard is
evaluated in `route_<from>` immediately afterwards — is advertised ONE extra, built-in tool:

| | |
|---|---|
| **`os_set_state`** | `{ channel, value }`. Closed to the system's **declared** channels and type-checked against the declaration. |

It is not an MCP tool and it is not a grant: it writes the team's own state, so it never reaches
the governed executor, is never held for approval, and an undeclared channel or a mistyped value
comes back as a typed `invalid_argument` tool result the model can read and correct. The write
lands in the same superstep's state update, so the next `route_<id>` evaluation — and the
supervisor's `--- TEAM STATE ---` block, which lists the current channel values — see it.

Each writer's system prompt carries a generated `--- STATE CHANNELS ---` block: one sentence per
channel, derived from the declaration and the handoff it unlocks, so the instructions can never
drift from the yaml. The shipped **Software Delivery Team** uses exactly this: five boolean
channels (`plan_ready`, `committed`, `tests_failed`, `tests_passed`, `reported`) written by the
planner, builder, tester and deployer, so the team advances on recorded evidence and a tester FAIL
routes straight back to the builder. A channel that is declared but never set is simply a false
guard; a guard over an **undeclared** channel, or over an `add_messages` one (the setter writes
single values), is the compile warning.

### Durability: thread id = run id

`lib/engine/checkpointer.ts` selects `PostgresSaver` over `AGENT_RUNS_DATABASE_URL` (the
`agent_runs` database; chart `postgres.extraDatabases`, `setup()` runs at os-ui boot) and falls
back to an in-memory saver, reported as `checkpointer: 'memory'` on every run — a fallback must
never pass for durability. **The thread id IS the run id** (`core/kernel/run-id.ts`), which is also
the Langfuse trace id. `POST /api/agents/systems/<id>/run { resume: true, runId }` continues a run
from its last checkpoint — only for its own system and runner (404 otherwise, 409 once finished);
the Run panel offers **Resume** when the checkpoints are in Postgres.

### Approvals are interrupts

A write that needs a human parks the run **before any call of the batch executes**: `tools_<id>`
computes the hold for the whole batch first (`lib/build/hold.ts`, the pure rule), enqueues each
held call once (idempotent on `(threadId, callId)`), then `interrupt()`s. The approver
**authorises**; the **runner executes** on resume. Rejecting returns a typed tool result and the
model continues. `lib/engine/approval-port.ts` is the queue port, `approvals-bridge.ts` its server
implementation, `lib/engine/resume.ts` the resume (registered into `core/policy/approvals.ts`
`onDecided` by `resume-boot.ts`), and `lib/build/run-service.ts` drives start/resume/finalise for
every door. A parked approval has no TTL in v1 (open policy question, `docs/components/os-ui.md`).

### A run is a row, not a request

`POST …/run` validates, mints the run id, inserts a `queued` `run_jobs` row and tails that run's
`run_events`; `GET …/run/stream?runId=&afterSeq=` tails the same table from a cursor.
`AGENTS_WORKER=inline` (default) executes the job in the same process right after filing it —
identical events, so every test runs without a worker; `AGENTS_WORKER=worker` leaves it to the
`os-ui-worker` Deployment (`os-ui/worker/agent-runs.ts`), which claims with
`FOR UPDATE SKIP LOCKED`, heartbeats its lease, and on SIGTERM finishes the current superstep and
re-queues the run. `AGENTS_WORKER_LEASE_MS` bounds a lease; an abandoned one is re-queued once
(keeping `kind='start'` when the run never reached a checkpoint), then failed. One start door for
everything: `run-jobs-server.ts` `startQueuedRun` (the run route, `build/scheduled.ts`, MCP
`run_agent_system`), `resumeQueuedRun` (owner Resume, MCP `resume_agent_run`) and
`enqueueResumeAfterDecision` (the Governance `onDecided` hook — a decision FILES a resume rather
than driving the graph inside the decider's request).

SSE events of `POST …/run` (stream): `node-started`, `tool-step`, `node-completed`;
`approval-required { approvalId, tool, node }` when a held write parks the run; `resumed
{ approvalId, decision }` on the re-attach stream when a decision continues it; then `done` (body
carries `parked`, `heldApprovals`, `warnings`, `checkpointer`) or `error`. The panel's SSE parsing
and its re-attach decision are pure (`lib/build/run-stream-client.ts` — a test may not import the
`.tsx`), so a `queued` cursor at the server's 240-second tail budget re-attaches transparently;
`engine/tail-limit.ts` caps a pod at 64 concurrent tails (`503` + `Retry-After` beyond that).

**A run id is NOT an authorisation.** `lib/engine/run-visibility.ts` `assertRunVisible` is the one
gate every run-id door calls BEFORE any side effect or read — the run route's resume, the re-attach
stream, the diagnostics read, MCP `resume_agent_run` and `get_agent_run` — always 404, never 403,
and the store refuses a resume filed by anyone but the run's requester. A worker that loses its
lease ABORTS the run and settles nothing (`engine/worker-loop.ts` `leaseWatch` / `settlementOf`,
both pure); `complete` is lease-guarded, `appendEvent` deliberately is not. `inline` mode reaps
stale leases once at boot and heartbeats its own runs. `lib/engine/run-lock.ts` is the per-thread
in-flight lock inside one process (a concurrent resume is a typed 409); across pods the authority
is the `run_jobs` row's status.

### One Langfuse trace per run, one scoped LiteLLM key

`lib/engine/observe.ts` builds the trace over the SDK client in `core/infra/langfuse.ts`: **trace
id = run id**, every node a span (`build-graph.ts` `observed()`), every model call a generation
with token usage, every tool call a span carrying its governance decision. A resume adds to the
same trace and creates no second one. The run report and `LastRun` carry `traceUrl`
(`<console>/trace/<runId>`) and `traceStoreAvailable`; the Evaluate judge writes a `judge` score on
that trace; the diagnostics route reads Langfuse **by the run's trace id**, owner-gated.
`LANGFUSE_REDACTION` governs how much of a call reaches the TRACE (`run_events` is exempt by
design — the panel's own log is written in full).

Every model call of a run is attributed to the runner (`user = os-<id>`) with tags `domain:`,
`agent:`, `run:`, and uses the system's own LiteLLM key by reference
(`LastBuild.litellmKeyRef`, minted by a live Build) or else the shared agent key — **never the
master key** (`core/runtime/runtime.test.ts` `MODEL-KEY` enforces that repo-wide).

### The MCP surface — the same doors the UI uses

| Tool | What it does |
|---|---|
| `build_agent_system` | compile + verify; the `langgraph` row IS `buildGraph` |
| `run_agent_system` | files the run on the queue and returns `runId` (= thread id = trace id), `traceUrl`, `parked`, `heldApprovals`. A grant with no governed tool behind it is a `bad_request` naming it |
| `get_agent_run { runId, afterSeq?, limit? }` | run state (path, budget, warnings, parked + held approvals with who can decide) **and the `run_events` tail** from a cursor, returning `nextSeq` |
| `resume_agent_run { runId }` | restart recovery only — NOT for a parked run |
| `decide_approval` (governance) | approving RESUMES the parked thread; the write executes once, as the runner |
| `get_run_trace { runId }` (monitoring) | the one Langfuse trace for that run |
| `list_runs` (monitoring) | recent runs, hard-scoped to the caller |

All of them go through `enqueueRun`/the jobs path and `assertRunVisible`, with identical 404/409
semantics to the UI. The sequence is taught in `guide.md` and pinned by
`core/mcp/agent-run-surface.test.ts`.

### Parity with what came before

`lib/engine/parity-harness.ts` + `lib/engine/fixtures/*.json` are the **frozen** golden recordings
of the pre-rebuild walker — every shipped template, the software team and three canonical shapes.
`parity.test.ts` holds the engine to them (P1), plus HANDOFF-GUARD and P2 (abort + resume);
`fixtures.test.ts` keeps them frozen and well-formed. There is no `REGEN_FIXTURES` any more: the
walker that produced them is gone, a golden regenerated by the engine under test would only prove
the engine equals itself, and `shape-guarded-handoff-held-write` exists precisely to record a
defect the engine must NOT reproduce (the walker ignored `when` and visited the guarded target).
A new shape means a new fixture beside them.

## Every change is a commit (Part D — flag `DATA_PROJECT_GIT`, default off)

With the flag on (chart: `osUI.dataProjectGit.enabled`), every mutation of an agent system —
created, edited, built, promoted, demoted, forked, renamed, moved, archived, unarchived, deleted,
restored, scheduled, started, stopped, an agent toggled, a grant changed, an owner or a domain
reassigned — regenerates this domain's `agents/**` subtree and commits it to the bare repository
the OS owns (`$OS_REPOS_DIR/<domain>.git`, PVC `os-repos`, **the same repo** the Data tab's dbt
project lives in). Author = the acting user, committer = `Sovereign OS`, message
`agents(<domain>): <action> <slug> — via ui:<route> | mcp:<tool>` with trailers `OS-Action`,
`OS-Object` (`<id> (<name>)`), `OS-Surface`, `OS-Request-Id`, `OS-Actor` (and
`OS-Author-Email: synthesized` when the user has no e-mail). A regeneration that changes nothing
commits nothing.

**Runs do not commit.** A run's artefacts are the LangGraph checkpoint, the `run_events` rows and
the Langfuse trace; committing per node would bury every real change under run noise. The activity
marker, the run checkpoint, the last-run report and restart recovery are therefore
`writeThrough(rec, null)` — the store's second parameter is required, so a new writer cannot be
added without deciding, and `lib/git/commit.test.ts` pins both lists (17 commit, 7 do not).

**Generated layout** (goldens: `lib/git/fixtures/*.golden.json`):

```
agents/index.yml                        # slug -> id, owner, scope, visibility, source version
agents/<slug>/system.yaml               # THE canonical definition (what you edit in the OS)
agents/<slug>/agents/<agent-id>.md      # each agent's instruction file (agent_md)
agents/<slug>/graph.json                # the compiled LangGraph IR `buildGraph` runs
agents/<slug>/README.md                 # purpose, members, grants, channels, edges, last build
agents/personal/<uid>/<slug>/…          # a Personal system, in its owner's lane
```

A Personal system lives in `agents/personal/<uid>/` — the lane split B1 chose for
`models/personal/<uid>/`, so one repository keeps one convention. A promotion moves the directory
in the same commit that changes the visibility; the frozen identity is the `id` in `index.yml` and
in the `OS-Object` trailer, never the slug. Archive and delete are commits that REMOVE the
directory, with the reason in the subject. No secrets are ever written: grants are names and ids,
and the system's LiteLLM key is a Secret *reference* the generator never sees.

**Read it back.** `get_agent_system` and `GET /api/agents/systems/<id>` return
`git: { head: { sha, author, at, action, surface }, history[] }`, read from the repository by
`lib/git/history.ts` (filtered on the `OS-Object` trailer, so a rename or a lane move keeps ONE
history). The Agents tab header shows `git <sha7> by <author> <time>`. With the flag off the
answer is `null` — never a fabricated sha. The whole repo (dbt project + `agents/**`) is readable
and exportable through the Data tab's project routes (`GET /api/data/projects/<domain>`,
`…/blob`, `…/export`), gated on domain membership.

**At boot**, the OS reconciles: it regenerates each domain's subtree once and commits any delta as
the platform principal with `OS-Reason: boot-reconcile`, so a window with the flag off is caught
up without anyone re-saving. **After every changed commit** the configured mirror is pushed
(`core/infra/git-mirror.ts`; one admin-configured remote per domain, token by Secret reference),
reported on Platform → Components & Health and retried by the next commit.

## Agents use the data as context, robustly (X9)

A granted data read is an ordinary governed tool call — `query_data` / `get_dataset` through
`grantedToolExecutor` → `handleRpc` **as the runner**, so OPA and row-level security see the human,
never a service principal. What the ENGINE adds around every tool call (`lib/engine/tool-result.ts`):

- **A bound before the prompt** (`AGENT_TOOL_RESULT_MAX_CHARS`, default 20 000). A JSON answer
  carrying `rows` / `data` / `items` / `results` (or a bare array) is truncated BY ROWS, so the
  model still sees well-formed JSON plus `[truncated: showing 243 of 50000 rows]`; anything else is
  cut by characters, with the counts named. A truncated result ALWAYS carries the marker — a
  silently shortened answer is how an agent reaches a confident wrong conclusion.
- **A deadline per call** (`AGENT_TOOL_CALL_TIMEOUT_MS`, default 60 s) → a typed
  `{"error":{"code":"timeout"}}` tool-step the graph routes on, so a hung read ends the step, not
  the run. An upstream failure is likewise typed (`upstream_error`). A THROWN dispatch is *not*
  swallowed: it fails the superstep so the checkpoint keeps the exactly-once property of the calls
  that already ran, and a resume re-runs exactly the one in flight.
- The call is a span of the run's ONE Langfuse trace, with the dataset in the span input and the
  result bounded there too (a 160-char preview plus the size).

Both bounds protect EVERY tool, not just the data ones. Pinned by
`lib/engine/data-context.test.ts` over the engine shape `agent-reads-gold-dataset`.

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
