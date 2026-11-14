# OS UI — the front door

**What it is:** the Next.js (App Router) application every user opens — the OS shell, all
13 tabs, the API routes behind them and the MCP server. Each surface calls its in-cluster
backend through **server-side** routes, so credentials never reach the browser or the
model. Backend URLs are env values defaulting to in-cluster Service names.

## Access

```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000
# http://localhost:8080      locally: ./scripts/os up  →  http://localhost:8080
```

## The 13 tabs

| Group | Tab | Wiring |
|---|---|---|
| Entry | **Home** | live stack-status strip (`/api/status`) + golden-path cards that deep-link to where each path runs |
| Entry | **MCP** | mint and revoke the per-user MCP token; list the tools the caller's role exposes |
| Entry | **About / Licenses** | the bundled open-source components grouped by SPDX licence |
| Context | **Data** | datasets ingested through data-runner into Iceberg on MinIO, catalogued by Polaris, queried via Trino; build stages bronze → silver → gold → promote → certify, marts built by dbt |
| Context | **Metrics** | a metric is a frozen `<View>.<measure>` member on the Gold mart, compiled to governed Trino SQL under the viewer's identity |
| Context | **Files** | objects in MinIO, text extracted by Docling, folder-level grants |
| Context | **Knowledge** | a knowledge agent interviews you and authors a 3-category `.md` (workflow steps · rules & decisions · tacit context), indexed in OpenSearch with embeddings via LiteLLM |
| Build | **Workflows** | business workflows as governed, versioned artifacts |
| Build | **Agents** | build and run agent teams; grants, safety presets, run traces — see "Agent engine" below for what actually executes a run |
| Build | **Dashboards** | native ECharts panels bound to one governed view, resolved through the same path as the metric explorer |
| Build | **Software** | app spec → design → generated files → preview → verify → deploy approval; versions are app-store revisions |
| Manage | **Connections** | connector configs (OneDrive · Outlook · Teams · Google Drive · Gmail · Kajabi · Notion MCP · Entra · SQL · any MCP server) with server-side credentials and governed egress |
| Manage | **Governance** | the approvals inbox (My → Domain → Company) plus the OPA grants matrix, each cell re-verified live |
| Manage | **Monitoring** | `/api/traces` → Langfuse → recent agent runs |
| Manage | **Admin** | users & access, platform settings, the Components operator, the LLM gateway, appearance |

Each tab declares its routes, APIs, MCP tools and required services in
`os-ui/tabs/<tab>/manifest.ts`. A tab whose services are disabled disappears from the
navigation instead of failing when clicked; `OS_ENABLED_TABS` gates the same set.

## Agent engine

**Current state, stated plainly.** A `system.yaml` is compiled to a LangGraph-shaped IR
(`tabs/agents/lib/langgraph-compile.ts`) and that IR is then compiled to a real
`@langchain/langgraph` `StateGraph` (`tabs/agents/lib/engine/build-graph.ts`) which is what
executes the run — in a worker process, as the signed-in user, checkpointed every superstep.
There is exactly **one** engine. The hand-rolled in-process walker that used to run agent
systems, its mock twin in the Build adapters, and the Python `agent-runtime` IR interpreter were
all deleted in A5; `AGENTS_ENGINE` and `runtime: walker` are gone with them (an environment that
still sets the variable gets one deprecation line at boot, and a stored `system.yaml` carrying
`runtime: hermes | walker` is normalised to `langgraph` on parse rather than refused).

**How it got here** (plan of record:
`docs/superpowers/plans/2026-11-13-engine-rebuild.md`). Phase A0 added the dependencies
(`@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `pg`, `langfuse` — all MIT),
a record/replay model caller, golden fixtures for every shipped template and a parity test, and
the engine flag. **Phase A1 (landed)** adds the real engine behind the flag: `tabs/agents/lib/
engine/build-graph.ts` compiles the IR to a `StateGraph` (four nodes per agent — plan / act /
tools / route — a supervisor that decides through a `route` tool, `when` guards evaluated by a
safe expression language, node-level tool narrowing enforced at execution, bounded by the team
step budget), `engine/run.ts` streams it with thread id = run id, and `engine/checkpointer.ts`
checkpoints every superstep to the `agent_runs` Postgres database (`AGENT_RUNS_DATABASE_URL`) or,
when unset, in memory — the run report says which. `POST …/run { resume: true, runId }` continues
an interrupted run; the Run panel shows **Resume**. **Phase A2 (landed)** makes approvals
interrupts: a write the system's safety preset holds (a Domain/Company escalation, or any write
under `read-only`) PARKS the run on a LangGraph `interrupt()` before anything in that batch
executes; the approval in Governance → Inbox carries the run (`runId`, system, agent node, tool,
arguments, the runner's identity); approving or denying it — in the inbox or over MCP
`decide_approval` — resumes the run **as the runner, whose role is re-read live** (a deactivated
runner or one who lost the role refuses the resume, visibly on the card); an approved call then
executes exactly once as the runner, a denied one reaches the agent as a typed `rejected` result
and the run continues. The Run panel shows the parked state and re-attaches to the run's stream
to watch it finish; `get_agent_run` / `resume_agent_run` cover the same over MCP. **Phase A3
(landed)** gives every run one Langfuse trace whose id is the run id, and attributes every model
call to the acting user and their own LiteLLM key. **Phase A4** took runs off the
request — see "Runs execute in a worker" below. **Phase A5** deleted the walker, the Python
runtime and the flag, re-based Build's graph row onto the same `buildGraph`, and made the MCP run
surface (`run_agent_system` → `get_agent_run` → `decide_approval` → `resume_agent_run` →
`get_run_trace`) the UI's own path with the UI's owner gate. How the graph
is shaped is written up in `os-ui/ARCHITECTURE.md` → "How a system.yaml becomes a StateGraph",
"Approvals are interrupts", "One trace per run" and "Runs execute in a worker".

### Runs execute in a worker (A4)

A run used to live inside the HTTP request that started it, so `maxDuration = 300` was the real
ceiling and a rolling restart killed whatever was mid-flight. Now **the route files the run and
tails its events**, and the work happens elsewhere:

- **Two tables in the `agent_runs` database** (the same one as the LangGraph checkpointer; the DDL
  is idempotent and runs at boot next to `PostgresSaver.setup()`): `run_jobs`, one row per run
  (`run_id` primary key, the runner's identity snapshot, the input, `status`, `locked_by`,
  `locked_at`, `attempts`), and `run_events`, append-only with a per-run `seq` carrying exactly
  the SSE vocabulary the Run panel consumes.
- **`AGENTS_WORKER=inline|worker`** (env; `osUI.worker.enabled` in the chart sets it). `inline`
  (the **default**) means the pod that files the job also executes it at once, writing the same
  events — a kind install, a laptop and the test suite behave exactly as before and need no second
  workload. `worker` means os-ui only enqueues and tails, and the `os-ui-worker` Deployment
  executes.
- **`os-ui-worker`** is the SAME image with a different command
  (`node --experimental-strip-types worker/start.mjs` from `/app/src`; the Next standalone output
  has no entry for a process that serves no HTTP, so the worker runs the TypeScript source with
  the tsconfig path aliases registered — the image's Node must be **≥ 22.6**). It claims one run at
  a time with `FOR UPDATE SKIP LOCKED`, heartbeats `locked_at`, and on SIGTERM finishes the
  current superstep, checkpoints it and puts the run back on the queue — which is why
  `osUI.worker.terminationGracePeriodSeconds` (default 420) must cover one superstep, not a whole
  run. A lease nobody renews is re-queued **once** (`AGENTS_WORKER_LEASE_MS`, default 10 min) and
  then failed, so no run sits `running` forever. A **reaped `start`** is re-STARTED, not resumed:
  a run killed before its first checkpoint has nothing to resume from.
- **A lost lease aborts the run.** The heartbeat is a watch, not a log line: the first beat that
  reports the row is no longer `running` under this pod aborts the run in flight and the pod then
  settles nothing and re-queues nothing — whoever re-claimed the row owns it. Every settle is
  lease-guarded in SQL (`AND locked_by=… AND status='running'`), so a stale holder's `done` is a
  no-op. `run_events` writes are deliberately NOT guarded: a late event is ordered after the new
  holder's by `seq` and is at worst a duplicate line, where a stale settle would end a live run.
- **`inline` mode reaps at boot and heartbeats too.** There is no worker loop to sweep leases, so
  `ensureRunJobsReady()` runs one `reapStale` sweep when the pod starts, and an inline run
  heartbeats its own lease under the same rules. An os-ui pod that is OOM-killed mid-run is
  therefore picked up by the next pod's boot rather than leaving a row `running` forever.
- **Admin credentials are NOT in the worker pod.** The env list is split: `soa.osUI.runEnv` (what a
  run needs — the scoped LiteLLM agent key, the stores, the service bearers, Langfuse) and
  `soa.osUI.adminEnv` (the session + MCP signing keys, the Graph mail secret, the LiteLLM UI login
  and the LiteLLM **master** key). os-ui includes both; `os-ui-worker` includes only the first, so
  a run compromised in the worker pod cannot read full gateway admin or forge a session.
  `scripts/check-worker-env.mjs` (in `os-ui/scripts/gate.sh`, skipped when `helm` is absent)
  asserts it; by hand:

  ```bash
  helm template charts/sovereign-agentic-os -f values.local.yaml \
    --set osUI.worker.enabled=true --set osUI.graph.enabled=true \
    | awk '/name: os-ui-worker$/,/^---$/' \
    | grep -cE 'LITELLM_MASTER_KEY|LITELLM_UI_|GRAPH_CLIENT_SECRET|OS_SESSION_SECRET|OS_MCP_TOKEN_SECRET'
  # expect: 0
  ```
- **Liveness is a heartbeat FILE, not `node -e 'process.exit(0)'`.** The worker touches
  `AGENTS_WORKER_ALIVE_FILE` (`/tmp/worker-alive`, on an `emptyDir` because the root filesystem is
  read-only) every 15 s from an unref'd interval; the probe fails when it is older than 60 s
  (2× the probe period). An interval only fires while the event loop turns, so this catches a
  wedged process — which spawning a fresh `node` never could.
- **At most 64 tails per pod.** Each open Run panel holds a request and polls `run_events` every
  400 ms against a `pg` pool of 6 shared with the checkpointer, so the 65th tail is refused with
  `503` + `Retry-After: 5` rather than starving sign-in. Raise it (and the pool) together if a
  tenant ever needs more; the run itself is never affected by a refused tail.
- **A tail that runs out of budget hands back a cursor.** Both run doors emit a `queued`
  `{ runId, afterSeq }` frame at 240 s, and the Run panel re-attaches from that cursor
  transparently (up to 40 hops) instead of telling the user to run again.
- **Every door is the same door.** The Run button, `build/scheduled.ts`, the MCP
  `run_agent_system` / `resume_agent_run`, and the Governance decision hook all file jobs through
  `tabs/agents/lib/build/run-jobs-server.ts`. A decision therefore no longer drives the graph
  inside the decider's request: it files a `resume` job, and the approval card reads `queued`
  until the run reports back.
- **The identity is re-read live before every execution** (the job's snapshot is evidence, not
  authority): a runner who was deleted, disabled, downgraded below the role the run was filed
  under, or removed from the run's domain gets a typed refusal
  (`runner_unavailable` / `runner_role_changed` / `runner_domain_lost`) and the job fails visibly.
- **`LANGFUSE_REDACTION=structure|strict`** (`osUI.langfuseRedaction`) decides how much of a call
  reaches the trace — see `docs/components/langfuse.md`.

**Verify it in a cluster** (these cannot be tested on a laptop; checklist A14 and A18):

```bash
# 0) turn the worker on
helm upgrade agentic-os charts/sovereign-agentic-os -f values.local.yaml \
  --set osUI.worker.enabled=true --reuse-values --force-conflicts --skip-schema-validation
# --force-conflicts: os-ui co-owns trino-access-rules/rules.json (it PATCHes the reconciled rules), so a
# plain server-side apply conflicts; forcing reseeds the bootstrap, which the boot reconcile restores in seconds.
kubectl -n agentic-os rollout status deploy/os-ui-worker
kubectl -n agentic-os logs deploy/os-ui-worker | grep 'agent-runs-worker. boot:'
#    expect: checkpointer=postgres jobs=postgres resumeHook=true approvals=true
#    ERR_UNKNOWN_FILE_EXTENSION here means the image's Node is below 22.6.

# 1) A18 — a run longer than the 300 s request cap completes
#    Start a run from the Agents tab (or MCP run_agent_system) on a system whose work takes
#    > 6 minutes, then close the browser tab. Watch it finish WITHOUT a client attached:
RUN=<runId from the response>
kubectl -n agentic-os exec deploy/postgres -- psql -d agent_runs -c \
  "select status, attempts, locked_by, locked_at from run_jobs where run_id='$RUN'"
kubectl -n agentic-os exec deploy/postgres -- psql -d agent_runs -c \
  "select seq, event, at from run_events where run_id='$RUN' order by seq"
#    expect: status done, a terminal `done` event, and a total duration > 300 s.
#    Re-attach at any point: GET /api/agents/systems/<id>/run/stream?runId=$RUN&afterSeq=<n>
#    replays only what came after <n>.

# 2) A14 — a rolling restart loses no run
#    Start a long run, then while it is `running`:
kubectl -n agentic-os rollout restart deploy/os-ui-worker
#    expect in the old pod's log: "SIGTERM — finishing the current superstep";
#    then run_jobs.status returns to `queued` with kind='resume', the new pod claims it
#    (locked_by changes), run_events continues at the next seq, and the final `done` reports the
#    same path as an uninterrupted run. checkpoints keep growing throughout:
kubectl -n agentic-os exec deploy/postgres -- psql -d agent_runs -c \
  "select count(*) from checkpoints where thread_id='$RUN'"

# 3) the stale-lease path (no pod is polite about it)
kubectl -n agentic-os delete pod -l app.kubernetes.io/name=os-ui-worker --grace-period=0 --force
#    expect: the run stays `running` until the lease (AGENTS_WORKER_LEASE_MS) expires, then the
#    next worker's reaper re-queues it ONCE ("re-queued run <id>" in the log) and, if it dies
#    again, fails it with "lease expired".

# 4) the image really does run the TypeScript source (A4-3's constraint, verified in the image)
#    The unit suite cannot see this: it is a property of the BASE IMAGE's Node, and a base-image
#    bump below 22.6 breaks the worker with ERR_UNKNOWN_FILE_EXTENSION at boot. Run it against
#    the built image BEFORE deploying (scripts/deploy.sh does this as a post-build smoke step):
docker run --rm --entrypoint node --workdir /app/src <os-ui image> \
  --experimental-strip-types --no-warnings \
  -e "import('./worker/agent-runs.ts').then(m => { if (typeof m.main !== 'function') process.exit(1); })"
#    expect: exit 0 and no output. It imports the whole run-path module graph WITHOUT a database
#    (nothing connects until main() runs), so a failure here is a type-stripping or alias failure.

# 5) liveness is honest (A4 review L-2)
kubectl -n agentic-os exec deploy/os-ui-worker -- stat -c '%Y %n' /tmp/worker-alive
#    expect: a timestamp refreshed at least every 15 s, even while a long run executes.
```

**Open policy question (A2): parked approvals have no TTL.** A run parked on a held write waits
indefinitely for its decision; nothing expires it, reminds anyone, or fails it over to another
approver. v1 chose this deliberately (an expiry that silently rejects would execute a decision no
human took). Candidates for a later iteration: a visible age on the card, an admin "abandon run"
action that resumes with a rejection, or a tenant policy for a default expiry. Also open: both the
checkpointer and the approvals-queue hydration Since A4 the run EVENTS are durable rows (`run_events`), so a
tail survives a restart and works from any pod; the pieces still single-replica are the
checkpointer connection and the approvals-queue hydration.

### Retention for `agent_runs` (the A13 follow-up, closed)

A LangGraph checkpoint holds the full run state — **raw tool results included** — and `run_events`
holds the same payloads as a replayable stream. Neither is covered by `LANGFUSE_REDACTION`
(see `langfuse.md`), and until iteration 2 neither had a bound, so the `agent_runs` database grew
for the life of the install.

**`AGENT_RUNS_RETENTION_DAYS`** (chart: `osUI.agentRunsRetentionDays`, default **30**) is the
window. A run that **settled** — `done` or `failed` — longer ago than that has three things
removed, in this order:

1. its LangGraph checkpoint thread (`deleteThread(runId)`; thread id **is** the run id),
2. its `run_events` rows,
3. its `run_jobs` row.

The order is the recovery story: the job row is deleted LAST, so a sweep that fails part way
through leaves the run eligible and the next sweep retries it — nothing is ever half-deleted with
no row left to name it.

- **A `parked` run is never swept, at any age.** Its checkpoint *is* the run: delete it and the
  pending Governance approval can never be resumed. `RETAINABLE_STATUSES` (`done`, `failed`) is in
  the SQL `settledBefore` runs, and the sweep RE-READS each row immediately before deleting it, so
  a run resumed between the listing and the delete is spared too.
- **Where it runs.** `worker.enabled: true` → the worker loop sweeps every 6 hours, before the
  claim, and a failing sweep is logged and never stops the queue. `worker.enabled: false`
  (`inline`) → there is no loop, so `ensureRunJobsReady()` runs ONE sweep at os-ui boot.
- **`AGENT_RUNS_RETENTION_DAYS=0` keeps everything** — for an install whose own policy says so.
  An unparseable value falls back to 30 rather than to 0, in either direction: a typo must not
  silently turn retention off, and must not silently delete today's runs.
- **Bounded per sweep** (200 runs), so a long backlog drains over successive sweeps instead of
  holding one long transaction.

```bash
# What a sweep would remove right now (read-only).
kubectl -n agentic-os exec deploy/postgres -- psql -d agent_runs -c \
  "select status, count(*) from run_jobs where updated_at < now() - interval '30 days' group by status"
# Parked rows in that list are the ones retention will NOT touch.
```

**No flag.** There is one engine, so there is nothing to select: A5 deleted
`AGENTS_ENGINE`, `core/kernel/config.ts` `agentsEngine`, `tabs/agents/lib/engine/select.ts` and
the per-system `runtime: walker` opt-out. That opt-out had become a way for a user to keep the
LOOSER rules (no `when` guards, no node-level tool narrowing), which is the opposite of what an
engine flag is for. Every run report carries `engine: 'langgraph'`, `runId`, `checkpointer` and
any compile `warnings` — e.g. a handoff guard over a channel that nothing **can** set (an
undeclared one, or one declared with the `add_messages` reducer).

**State channels, and who writes them.** A `when` guard routes on a declared state channel, and
the agent whose turn the guard follows is advertised the engine's built-in `os_set_state` tool —
closed to the declared channels, type-checked against the declaration, never a governed MCP call
and never held for approval. The write lands in the same superstep, so the next routing decision
(and the supervisor's `--- TEAM STATE ---` line) sees it. The shipped Software Delivery Team
declares five boolean channels (`plan_ready`, `committed`, `tests_failed`, `tests_passed`,
`reported`) written by its planner, builder, tester and deployer, so the five-phase chain actually
fires and a tester FAIL routes back to the builder. Until the A5 review round this was the
engine's biggest gap: no node could write a channel, so EVERY `when` guard in the OS evaluated
false and those five guards were five compile warnings. See `os-ui/tabs/agents/README.md` →
"State channels".

**Known limits (honest).** The Context Librarian handoff
curation runs in the graph only when a live embedder is wired, and never over the offline-hash
fallback's vectors (relevance over them is noise). A
A resume after a decision is filed as a job (A4); with the worker off it
still executes inside the decider's request, exactly as in A2.

### Agent systems in git (Part D)

With `DATA_PROJECT_GIT=true` (chart `osUI.dataProjectGit.enabled`) every change to an agent
system is a commit in the owning domain's bare repository — **the same repository** the Data tab's
dbt project lives in, under the `agents/` subtree:

```
agents/index.yml                      slug -> id, owner, scope, visibility, source version
agents/<slug>/system.yaml             the canonical definition
agents/<slug>/agents/<id>.md          each agent's instruction file
agents/<slug>/graph.json              the compiled LangGraph IR the engine runs
agents/<slug>/README.md               purpose, members, grants, channels, edges, last build
agents/personal/<uid>/<slug>/…        a Personal system, in its owner's lane
```

`agents(<domain>): <action> <slug> — via ui:<route> | mcp:<tool>`, authored as the acting user,
committed by `Sovereign OS`, trailers `OS-Action` / `OS-Object` / `OS-Surface` / `OS-Request-Id` /
`OS-Actor`. Runs do not commit. Archive and delete REMOVE the directory. At boot the OS reconciles
each domain (`OS-Reason: boot-reconcile`). `get_agent_system` and the Agents tab header report the
commit the system is at, read from the repo.

**Operator notes.**

- One switch for both halves (`DATA_PROJECT_GIT`): the repository, the `os-repos` PVC and the
  read-only `git daemon` sidecar are shared, so a second flag could only ever disagree with itself.
- `AGENT_TOOL_RESULT_MAX_CHARS` (default 20 000) bounds every agent tool result before it enters
  the prompt, with a visible `[truncated: showing N of M rows]` marker;
  `AGENT_TOOL_CALL_TIMEOUT_MS` (default 60 000) is the per-tool-call deadline, surfacing as a
  typed `timeout` tool step. Both are run-path, so the `os-ui-worker` pod gets them too.
- **Mirror**: `PUT /api/platform-admin/data-projects/<domain>/mirror` `{url, tokenSecretRef}` is
  the ONE config for both halves. The push happens after every changed commit, never blocks a
  save, and its last outcome is the **`git-mirror`** row on Platform → Components & Health — red
  when a mirror's last push failed, amber before its first. Verify in a cluster:

  ```bash
  kubectl -n agentic-os exec deploy/os-ui -- sh -lc 'git --git-dir=/repos/<domain>.git log --oneline -5'
  kubectl -n agentic-os exec deploy/os-ui -- sh -lc 'git --git-dir=/repos/<domain>.git ls-tree -r --name-only main | grep ^agents/'
  # save a system twice in the UI, then once through the MCP, and expect three commits whose
  # authors are the acting users and whose subjects name `ui:agents/…` then `mcp:commit_agent_files`
  ```

## Admin → Components — native stack operator

Operates the whole stack from inside the OS UI. It reads the Kubernetes API **directly,
server-side** (`/api/platform/components`, `/api/platform/toggle`, `/api/platform/doc`)
through a scoped ServiceAccount, so the browser never holds a cluster token. It shows live
status per component, on/off toggles (scale 0↔1; core items are not toggleable), and each
component's address, login and docs. No separate console service is deployed.

## Theming

Styled to www.sovereign-agentic.com: gold accent **`#c8a24a`** (→ `#e7cd86`) with teal
secondary, the gold lotus logo/favicon (`app/icon.svg`), and **Oswald** (headings) /
**Marcellus** (eyebrows) / **Rubik** (body), self-hosted via `next/font` — offline-safe, no
runtime CDN. Light mode is the default; the sidebar and top bar stay black in both modes.
Dark mode is opt-in via Admin → Appearance and persists per device.

## FAQ

**Where are the keys?** Server-side only. Langfuse, LiteLLM and the Kubernetes token are
read from existing Secrets and never shipped to the browser or put in a model prompt.

**How do I point a surface at a different backend?** Every backend URL is an env value —
see `os-ui/core/kernel/config.ts` for the authoritative list and the chart's
`templates/base/os-ui/os-ui.yaml` for where they are set.

**Is MCP a second implementation?** No. The MCP endpoint dispatches through the same
`core/mcp/handleRpc` and the same governed libraries as the UI, with the same role floors
and the same OPA checks.

## Connecting Google Drive or OneDrive (operational notes)

Both are **per-user OAuth**: an admin registers the provider app once, then each
person consents for themselves. An admin cannot connect Drive on someone's
behalf — the token is owner-scoped and owner-only, enforced in code.

**Register the app at Admin → Drive OAuth apps.** The redirect URI the OS sends
is `<public-url>/api/connections/oauth/<google|microsoft>/callback`, and it must
match byte for byte.

**Microsoft: the Azure app must be MULTI-TENANT.** The OS authenticates through
the `/common` endpoint. A single-tenant app there is rejected with
`AADSTS50194`, surfaced as a generic `invalid_request`. Set supported account
types to "any organizational directory", or `"signInAudience":
"AzureADMultipleOrgs"` in the manifest. Multi-tenant governs which directories
*could* authenticate; who actually gets in is still gated by consent.

**Scopes are read-only and minimal:** `drive.readonly` for Google;
`Files.Read` + `offline_access` for Microsoft. `offline_access` is what makes a
refresh token available, so without it a connection dies after an hour.

**If the exchange fails**, check the client **secret value**, not the secret ID —
Azure shows the value once and the ID looks plausible. The OS now forwards the
provider's code as `drive_detail`; `AADSTS7000215` means a bad secret.

**Known limits.** The connector reads the signed-in user's own drive. A Google
**Shared Drive** returns empty, because the Drive query does not send
`supportsAllDrives`/`includeItemsFromAllDrives`. A **SharePoint or Teams**
library is not reachable at all — the OneDrive connector calls `/me/drive`.
Folder scope needs a Graph **item id**, not a path, despite the field label.

## The app-building harness (`SOFTWARE_BUILDER`) — added by night-2 stream H

The Software tab ships **two** builders. The default is unchanged; the second is opt-in.

| | `spec` (default) | `agentic` |
|---|---|---|
| What it does | one reasoning-model turn fills a declarative `AppSpec`, plus up to two validator-seeded repair turns | a bounded **planner → coder → build → reviewer** loop that writes a real Vite/React tree |
| Compile loop | none | the existing in-process gate every iteration, diagnostics fed back verbatim |
| Grounding | the app's grants and story titles | a grounding pack: story specs, dataset **real columns + up to 5 real sample rows**, metric definitions, the SDK and UI API surfaces **extracted from `core/app-sdk` / `core/app-ui` source**, design tokens, one exemplar, the Tier-2 constraints |
| Definition of done | the validator accepted the spec | acceptance checks **derived from the user stories**, scored with evidence |
| Bound | 3 attempts | 4 iterations, plus a no-progress and a coder-error stop |
| Writes | `setAppSpec` | the normal governed commit door (`commitToApp`), as the signed-in user, compile-gated before any write |

**Environment.** `SOFTWARE_BUILDER` = `spec` (default) or `agentic`; anything else resolves to
`spec`. `LITELLM_CODER_MODEL` optionally pins the new `coder` model role — empty means `coder` falls
back to the reasoning tier, so enabling the loop needs no model change. Chart keys:
`softwareBuilder.mode` and `softwareBuilder.coderModel`.

**Where it lives.** `os-ui/tabs/software/lib/builder/**` (grounding, acceptance, build tool, loop,
prompts, dispatch) and `os-ui/tabs/agents/lib/builtin/appsmith.ts` — the `os.appsmith` built-in
system as a real `system.yaml` (planner → coder → reviewer, three guarded handoffs on declared
boolean channels, `commit` as the build tool, `decide_deploy` deliberately not granted). The Build
dispatch consults the flag in **exactly one** guarded line, in
`tabs/software/lib/platform-mcp.ts` `case 'build_software'`.

**What is NOT true yet.** The route and render acceptance checks are **static inspection of the
TypeScript AST** — strong enough that a comment or a string naming `os.records.add` fails, but not
rendering: the evidence string says `static check (AST)` on every line, and jsdom/screenshot
rendering inside the loop is backlog. There are no story-derived **runtime** tests, and no
model-quality evals — so the "harness vs model" split that motivated this work is measured on the
harness side only. Three governance limits are recorded rather than implied: the rest of the
platform-MCP write surface is still invisible to the agent hold gate (`commit` is fixed; the other
thirteen are pinned by a test and handed to the software stream); sample-value masking is a column-
NAME heuristic because the OS has no column-classification facility, and there is no trace redaction
on that path; and builder model calls are still tagged `tab:assistant` because `assistantComplete`
has no tab/run option.
