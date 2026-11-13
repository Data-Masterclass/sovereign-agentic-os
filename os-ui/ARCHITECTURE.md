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
gets a typed `not_found` and never executes); the hold decision stays inside the
executor, whose typed `held` result is recorded in `state.held`. `route_<id>` records
the visit (`nodeRuns`, `handoffs`, `node-completed`), then routes. act → tools is a
conditional edge on "the reply carried tool calls"; tools → act is a plain edge.

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
the Run panel's "Resume" button does exactly that.

## A data product is a dbt project in a git repo the OS owns

(Engine rebuild, Phases B1–B2 — behind `DATA_PROJECT_GIT`, default off. Concept:
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

**Every writer commits.** `tabs/data/lib/store.ts` has one `persist()`; it — and the few writers
that bypass it (create, adopt, archive, delete, restore, propagation sweeps) — emit a
`ProjectChange` through `tabs/data/lib/project-events.ts`. The store is reachable from the **client
bundle** (`lib/index.ts` re-exports it), so it may not import `node:fs` or isomorphic-git even
dynamically — hence the event seam. `tabs/data/lib/dbt/commit.ts` subscribes at boot
(`instrumentation.ts`): snapshot the domain (`snapshot.ts`, the only impure read) → `generateProject`
(`generate.ts`, pure, byte-stable: sorted keys, one newline, no timestamps) → `commitTree`.
`commit.test.ts` enumerates the store's exports — a new mutator fails until it is classified.

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

(Phase B2, same flag.)

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
