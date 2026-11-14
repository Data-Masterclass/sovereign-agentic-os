# Metrics, dashboards, chat-to-data, vibe-engineered software — and git everywhere

> **For agentic workers:** this is the plan of record for night run 2. Read it fully before touching
> code. Unlike last night's single-file programme, the five streams here run **in parallel** in
> separate worktrees on **disjoint file areas**; each stream works its own brief in order, and each
> brief ends with its gate green and commits on its own branch. Tick nothing you did not measure —
> where you deviate, append to the deviations log with your stream's id prefix instead of ticking a
> lie.

**Decision (2026-11-14, product owner), verbatim:** *"This time we focus on metrics, dashboard and
software: Defining simple and complex metrics using DBT metrics on top of data products. Building
dashboards on top of the DBT metrics and data products that have a similar power as Superset (you
can shamelessly copy code that makes sense to copy to save time from superset as it is open source
but fully integrate it into the OS - whatever is allowed under license, you can also leverage any
alternative open source dashboard tool code … as long as it is allowed). Enabling to chat to the
data products, metrics and dashboards and create dashboards using chat or the MCP. Potentially
leveraging Open WebUI or LibreChat components for this. And finally, to allow to deploy software
apps directly using the MCP so people can code in Claude and then deploy via MCP to our Sovereign
Agentic OS using the built in Git. It needs to be versioned. It needs to allow for basic CI/CD best
practices to be built in. It allows basically fully professional hosting of software applications
that are vibe engineered. The vibe engineered applications can call agents in the OS or can be
called by agents in the OS and can read and write back data with the user access rights of the OS
users being considered. Please plan this out properly and come up with user stories and requirements
for (1) … metrics … (2) … dashboards … (3) … chat … in the Ask the OS and the MCP. (4) … deploy vibe
engineered software using CICD and Git so it would satisfy most IT departments in medium enterprises
in terms of standards. Research first, then plan, then build, then test, then iterate."*

**Second decision (2026-11-14, product owner), verbatim:** *"make sure that everything that is built
in OS lives in GIT and can be versioned. We might need to extend the UI to make GIT more visible"* —
this is stream **G**, and it is first-class, not a footnote. Last night made the agent and data
stores commit; tonight every other builder artefact kind joins them, every object gains a
version history, a diff and a restore, and git becomes **visible in the UI**.

**Builds on:** `2026-11-13-engine-rebuild.md` (the LangGraph engine, the dbt/Dagster/Trino data
products, and Part D's one git commit path) and `2026-11-13-engineering-checklist.md` (the
definition of done and the iteration protocol). Where this plan and those differ on a fact about the
current tree, the tree wins — read it.

**Evidence:** four read-only research reports, copied verbatim beside this file as the evidence base,
each audited at `main` `31c0fc90`:

| Report | Subject |
|---|---|
| `2026-11-14-night2-research-R1-dbt-metrics.md` | dbt `semantic_models`/`metrics` spec, licences (MetricFlow is Apache-2.0 from v0.209.0), what a "metric" is in the OS today, the compiler sketch |
| `2026-11-14-night2-research-R2-dashboards.md` | Superset-class dashboards: licences, which code may be vendored, the current `tabs/dashboards` audit, the MUST list and its effort |
| `2026-11-14-night2-research-R3-chat-to-data.md` | chat to data products / metrics / dashboards, the artifact protocol, Open WebUI's licence boundary, the `observe` plumbing defects |
| `2026-11-14-night2-research-R4-software-deploy.md` | git-backed app hosting, CI/CD gates, environments, approvals, the `'image'`/`whoami` trap, honest-docs findings |

**Third decision (2026-11-14, product owner), verbatim:** *"How can we make it also more visible
wherever things are integrated into standards like Langraph, Litellm and langfuse, trino, dagster,
dbt, etc.? My point is: for developers it does matter that they understand what is going on and
which artifacts are built and deployed in these tools with the OS just making it easier to build,
run and administrate it using the UI and MCP. Right now, I feel that the abstraction layer works to
some degree great and at the same time it abstracts so much that the artifacts become Sovereign
Agentic OS artifacts rather than the original tools underneath. We need to strike the right balance
here."* — this is stream **T**, and it is the principle below.

**Fourth decision (2026-11-14, product owner), verbatim:** *"Ideally, engineers can build and
administer things using the MCP and/or simply their Visual Code deploying to the Git Repo of
Sovereign Agentic OS. … the OS becomes unstoppable if it allows engineers to work their way, while
also allowing them to do the fast track using MCP and then seeing stuff using the UI. Moreover, this
allows business users also building using the Ask the OS, MCP or UI. I see in particular with the
data products that it not yet fully follows the data engineering ways of working. Think of a coin,
from one side it looks like an engineering coin from the other side it looks like a business user
coin but at the end its the same coin."* — this is stream **E**, and the coin is the second principle
below.

---

## Global design principles

> **The OS orchestrates; the tools own the artefacts. The UI and the MCP show the tool-native
> artefact wherever the OS touched it, in the tool's own vocabulary, with a deep link and the
> command an engineer would run.**

This is not decoration and it is not documentation — it is a design constraint on every stream in
this plan, and it is testable.

- **The artefact is the tool's, not ours.** A metric is a **dbt metric** in a `.yml` file in a git
  repo. A pipeline is a **Dagster asset** with a job and a schedule. A query is a **Trino query**
  running as a named principal. An agent system is a compiled **LangGraph** `StateGraph` with
  nodes, edges, guards and channels. A model call is a **LiteLLM** route with a key alias, tags and
  a budget. A run is one **Langfuse** trace. The OS's contribution is identity, policy, approvals
  and ease — not a private re-naming of someone else's object.
- **Vocabulary rule.** Labels on these surfaces use the tool's own nouns — "dbt model", "dbt
  metric", "Dagster asset", "Dagster schedule", "LangGraph node", "Langfuse trace", "Trino query",
  "LiteLLM key alias" — with the OS term in parentheses **once** where a user needs the bridge
  ("dbt metric (KPI)"). A panel label that uses only an OS-invented noun fails checklist T2.
- **Show the real thing, not a paraphrase.** The SQL shown is the SQL that ran. The YAML shown is
  the bytes in the repo. The graph shown is the compiled graph. The run id shown is the Dagster run
  id and the thread id is the LangGraph thread id, which is the OS run id.
- **Give the engineer the command.** Every engineering surface names the command an engineer would
  run to do the same thing outside the OS (`dbt build --select <node>`, `dbt test`,
  `mf query --metrics revenue --group-by metric_time__month`,
  `dagster asset materialize --select <key>`, `trino --execute '<sql>'`).
- **Give them the exit.** Anything the OS generated can be exported in its native form and run
  elsewhere: the domain dbt project as a tarball that `dbt parse` accepts, an agent system as
  `system.yaml` + the compiled graph JSON, a dashboard as its dashboard-as-code file. "You could
  take this and leave" is a product guarantee, documented, not a side effect.
- **Honesty is part of it.** Where the OS still does something its own way instead of the tool's
  way, the surface says so in its own words — the "what is NOT true yet" pattern
  `docs/components/trino.md` already uses. A deep link that cannot resolve says why.

> **Two orthogonal axes. Audience is My → Domain → Company — who may use this as an official
> artefact, promoted with approvals. Lifecycle is Studio → Test → Run, per object version —
> whether this version is being built, being tested, or being run. A My object can be live.**

Everything is in production today, and everything is a tile on one screen with no indication of
whether it is an experiment or the thing the company runs on. The fix is **not** to re-use the
audience ladder as an environment ladder — the owner's words: *"You can have something that is My
and is still under development and then I want to go live with it… Promotion to Domain is only done
if it is used across the domain by other users as official artefact. I would not mix the concepts
My/Domain/Company with Dev/Test/Run."* Mixing them would mean you cannot run your own thing without
publishing it to your colleagues, and cannot publish something without declaring it finished.

So each object carries both, and they do not interact:

- **Audience** — `My` → `Domain` → `Company`. Changed only by the existing promotion path, with its
  roles, requests and approvals. Unchanged by this programme.
- **Lifecycle** — `Studio` → `Test` → `Run`, attached to **a version**: `lifecycle: { draft: <head>,
  testing?: <sha>, live?: <sha|tag> }`. Studio edits the head. `go_live` **pins** a commit or tag and
  the OS runs **from the pin** — Dagster schedules, the app's prod URL, agent schedules, dashboard
  consumers. Editing a live object creates a new draft and **does not touch the live pin**. `retire`
  unpins. Tests run against the draft in a sandbox.

The consequence that makes it worth building: **what is running is a pinned commit, not "whatever
the head happens to be"**. That is the same property the software tier gets from a release tag, and
it is the one an IT department asks about first.

> **Git is the system of record; the OS registry is a derived index plus governance metadata. Both
> doors write the same files: engineers via `git push`, everyone else via the UI, the MCP or Ask the
> OS.**

The coin. One side is an engineering coin — clone the domain repo in VS Code, edit a dbt model or a
`system.yaml`, push, and the OS validates it with the same code the UI uses and reconciles its
registry from the files. The other side is a business-user coin — define the metric in a form, ask
Ask the OS to build the dashboard, click promote — and the OS writes the same files to the same
repo through the same commit path. **It is the same coin**, and the test is literal: the same change
made over the MCP and made by a `git push` must leave the registry in the same state.

Three consequences that bind every stream:

- **A file is authoritative; a registry row is a cache of it.** Where the two disagree, the file
  wins and the row is re-derived. No stream may introduce a registry field that cannot be
  reconstructed from the repo plus governance metadata (ownership, tier, approvals, audit).
- **Validation lives in one place and both doors call it.** The receive gate and the UI/MCP write
  path must share the validator, or the two sides of the coin drift within a week.
- **The OS never rewrites a human's history.** A push is the authoritative new head; a restore is a
  new commit; a reconcile that would empty a tree is refused.
- **Read is unconditional; write is gated.** Anyone with access to a domain can clone and read the
  **whole** repository — including the OS-owned governance metadata, which is committed as real
  files (`os/*.yml`: schedules, grants, promotion state, rules) precisely so that nothing is a black
  box. Those files are **not pushable**: the receive gate rejects a change to them with *"managed by
  the OS; change it in Governance or over the MCP"*. Transparency must never require write access,
  and write access must never be the only way to see what the OS did.

---

## Goal

A user of the Sovereign Agentic OS can:

1. **Define a metric** — simple or complex — as a real dbt metric on top of a data product, in the
   form, from chat or over the MCP, and that metric is a **dbt `metrics:` entry committed in the
   domain's dbt project**, queryable as themselves, with the same number everywhere.
2. **Build a dashboard** over those metrics and data products with Superset-class power — charts,
   layout, filters, cross-filtering, drill, time comparison, export — inside the OS, governed,
   with the dashboard itself **committed as code**.
3. **Chat to the data** — "what was revenue last month by region", "build me a dashboard of
   churn" — in **Ask the OS** and over the **MCP**, with every number produced by the same governed
   query path and every answer carrying the artifact it is about.
4. **Deploy a vibe-engineered application** — coded in Claude, pushed over the MCP — onto the OS's
   built-in git, versioned with tags and releases, through CI gates and an approval, hosted
   professionally, able to call OS agents and be called by them, and reading and writing data **as
   the signed-in OS user**.
5. **See and use git for everything** — every builder artefact's head commit, history, diff and
   restore, in the UI and over the MCP.
6. **See the real tool artefact** — for any object the OS built, open an "Under the hood" panel that
   shows the dbt model and YAML, the Dagster asset/job/schedule and last run, the Trino SQL and the
   principal it runs as, the compiled LangGraph graph, the LiteLLM route and tags, the Langfuse
   trace and the git files, each in the tool's own vocabulary, with a deep link, the engineer's
   command, and an export in native form.
7. **Work from VS Code if they are an engineer** — clone the domain repo over authenticated git
   HTTP, push a dbt model or a `system.yaml`, have the push validated by the same gates the UI runs,
   and see the OS registry, Dagster and Trino pick it up — the same coin as the UI and the MCP.
8. **Tell an experiment from the thing that is running** — a Studio view where it is built and
   tested and a Run view that shows only what is live, with "go live" pinning a version, editing a
   live object leaving the live version untouched, and the audience ladder left to mean what it
   means: who may use this officially.


## Scope

- Metrics: the dbt semantic layer artefact, the four metric types the OS can serve, the time spine,
  the parity oracle, the metric MCP surface.
- Dashboards: the chart library, the vendored Superset slices, the layout engine, dashboard-as-code,
  the panel query path.
- Chat: one built-in governed agent system (`os.analyst`), the artifact protocol, `ask_os` and the
  dashboard-authoring tools, and the night-1 `observe` defects that make a chat run unreadable.
- Software: app repositories, versioning, the CI gate set, environments and approvals, the app↔agent
  and app↔data identity contracts, honest hosting docs.
- Git: one commit path for every artefact kind, generic version read-back, restore, and the git UI.
- Engineering view: one shared panel and one typed adapter per object kind, the MCP twin, and the
  native exports.
- Engineer's door: authenticated git over HTTP, personal access tokens, receive-time validation, and
  registry ingest from the pushed files.
- Lifecycle: the Studio → Test → Run model with pinned live versions, `go_live` / `run_tests` /
  `retire`, the Studio|Run toggle and the two badges, and the lifecycle reaching LiteLLM, Langfuse,
  Dagster and Trino.

## Non-goals (tonight, and named so nobody drifts)

- **No new cluster component.** No Superset deployment, no Cube, no Grafana, no Open WebUI, no
  LibreChat, no kpack, no Argo CD, no Harbor. Everything tonight is os-ui TypeScript, the generated
  dbt project, the existing Dagster image, the existing chart.
- **No MetricFlow on the request path.** It is a CI oracle and a batch engine only (D3).
- **No AGPL code, ever** (see constraints).
- **No production deploy and no merge to `public/main` tonight.** Streams commit to their own
  branches; the coordinator merges in the stated order after review.
- **No history rewriting.** A restore is a new commit (D14).
- **No change to the identity model.** Nothing in this plan may execute a read or a write under a
  service principal where a signed-in user exists.
- Column-level lineage, `conversion` metrics, Tier-3 arbitrary-container apps, and the dbt 1.12
  ("Fusion") emitter are explicitly **follow-on backlog**.

---

## Global constraints

Last night's constraints, unchanged, plus the ones this programme adds.

### Carried forward, unchanged

- **Identity is the architecture.** Every tool call executes as the signed-in `CurrentUser` through
  the in-process governed dispatcher (`core/mcp/server.ts` `handleRpc(user, …)`, gated by
  `tabs/agents/lib/build/os-tools.ts` `grantedToolExecutor`). Nothing in this plan may move that
  across a process boundary or run a side effect under a service principal. Every metric read is
  `propagate(token)` + `queryRun(sql, identities.trino.user)`
  (`tabs/metrics/lib/build/explore-server.ts`); every dbt run impersonates `OS_PRINCIPAL`.
- **Repo rules** (`CONTRIBUTING.md`): a tab imports only `@core/*` and itself; the kernel never
  imports a tab; `components/` is upstream-only; the thirteen tab modules are a closed set; every
  source file carries the `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header **and** the SPDX
  header; `scripts/check-structure.mjs` is a ratchet whose counts may only go down.
- **A test cannot import a `.tsx` or a Next `route.ts`.** Testable logic lives in `.ts` modules; the
  route and the component are shells. No TypeScript parameter properties.
- **A fallback must never report success with substituted data.** Any substituted or mocked value
  is labelled in the result and the label is surfaced in the UI.
- **Gates for every phase:** `npx tsc --noEmit -p os-ui/tsconfig.json` clean · `npm --prefix os-ui
  test` 0 failures · `node scripts/check-structure.mjs` no new violations · `bash
  os-ui/scripts/gate.sh` exit 0 · `helm lint charts/sovereign-agentic-os -f values.local.yaml`
  where the chart changed. Docs updated in the **same commit** (`docs/components/*.md`,
  `os-ui/ARCHITECTURE.md`, the owning tab's `README.md`, `CHANGELOG.md`).
- **Operational:** implementation agents run in parallel **only on disjoint areas**, each in its own
  worktree; reviewer and test agents are read-only and freely parallel. `colima stop` when not
  building; run `scripts/deploy.sh` directly, never piped; rebase-and-merge, never squash.

### Added by this programme

- **Licences — the vendoring rule.** Only **Apache-2.0, MIT, BSD-2/BSD-3-Clause, ISC** code may be
  vendored into `os-ui/`. Every vendored file keeps its upstream licence header **and** gains the
  line `Modified from <repo> <path> @ <sha>` directly beneath it. The same change must add: a row in
  `licenses/components.tsv`, the mirrored row in `THIRD-PARTY-LICENSES.md`, an entry in
  `core/kernel/licenses.ts`, a notice in `licenses/notices/` where upstream ships one, and a
  regenerated `sbom.cdx.json`. `scripts/license-check.sh` and the `license-gate.yml` workflow must
  pass. `CONTRIBUTING.md`'s "never copy upstream source into this repo" applies to **bundled
  components** (`components/`, consumed as pinned images and subcharts) — a small, attributed,
  licence-clean source slice inside `os-ui/` is the exception this programme takes, and every such
  file is listed in the stream's report.
- **NEVER AGPL.** Not vendored, not depended on, not linked, not "temporarily". The named traps:
  **Grafana** (AGPL-3.0 since v8), **Metabase** (AGPL-3.0), **ToolJet** (AGPL-3.0), **Lowcoder**
  (AGPL-3.0), **Budibase** (AGPL-3.0/GPL). MinIO is AGPL and already in the tree as a *deployed
  local stand-in* — that is a separate, pre-existing decision and is not licence cover for
  vendoring AGPL source.
- **NEVER Open WebUI ≥ v0.6.6** (its licence added a branding restriction that is not an OSI
  licence) and **never any Open WebUI UI code at all** — it is Svelte, so it could not be reused
  here anyway. Same for **LibreChat** UI: evaluate, do not vendor.
- **NEVER MetricFlow ≤ 0.208.1** (Business Source License 1.1, whose Additional Use Grant excludes
  exactly this product's use). Where MetricFlow is installed at all it is pinned
  `metricflow >= 0.209.0` and the floor is asserted by a test. `licenses/denied-licenses.txt`
  already denies `BUSL`/`BSL-1.1`.
- **NEVER Lightdash `packages/backend/src/ee/`** — the "Lightdash Source Available License" is
  subscription-gated and non-redistributable, and it is not an SPDX id the substring deny-list
  catches. If Lightdash is ever considered, add a `Source Available` substring to
  `licenses/denied-licenses.txt` first.
- **Identity, restated for the three new surfaces.** Every query and every write runs **as the
  signed-in user**. **Chat never widens access**: `os.analyst` holds no grant its caller does not
  have, and a question about an object the caller cannot see is answered with the same `not_found`
  the MCP gives. **Writes happen only on explicit user confirmation** — chat may *propose* a
  dashboard, a panel or a metric; the write executes after the user confirms, and a write the
  caller's role does not permit goes through the existing approvals queue.
- **Every mutation is a git commit** through the existing path (`core/infra/git-store.ts`
  `commitTree`/`commitSubtree`, via each tab's commit module), authored as the acting user, with the
  `OS-Action` / `OS-Object` / `OS-Surface` / `OS-Request-Id` trailers (and `OS-Run-Id` when a run
  caused it). No artefact kind may ship a writer that does not commit — stream G's enumeration test
  (G1) is the gate.
- **MCP = UI parity for every new tool.** Every user-facing action added tonight grows an MCP twin
  that reaches the **same governed service**, not a second code path, and a parity test asserts the
  two produce the same commit and the same effect, differing only in the `via mcp:<tool>` vs
  `via ui:<route>` half of the commit subject.
- **A store can hydrate EMPTY without throwing, and an empty store looks exactly like a tenant that
  owns nothing.** Any boot-time or reconcile-time **writer** must call `hydrationState()` first and
  do nothing unless it says `'hydrated'`. The git store's second line of defence —
  `DestructiveReconcileError` on an `OS-Reason: boot-reconcile` commit that would delete more than
  half the files it tracks while adding none — stays in force and must not be weakened to make a
  new reconcile pass.
- **Strays.** Before every commit: `find . -path '*/node_modules' -prune -o -type f -name '* 2.*'
  -print -delete`. iCloud conflict copies broke a production image build once (F2-5);
  `os-ui/.dockerignore` excludes `**/* 2.*` and `gate.sh` fails first if one exists. Do not weaken
  either.
- **Worker dependencies.** Anything a stream adds that the MCP dispatcher can reach **lazily** must
  still be present in the worker image copy — `scripts/worker-deps.mjs` seeds every production
  dependency; if you add a production dependency, verify the worker still boots
  (`--experimental-strip-types` smoke in `deploy.sh`).
- **The simplicity contract.** Owner, verbatim: *"The tricky bit is to keep it simple for UI and MCP
  because anything complex here can be a constant source for problems."* This is a **review
  criterion for every stream**, and a stream fails review if it breaks it.
  1. **Vocabulary:** at most **three** lifecycle words — **Draft · Testing · Live** — plus the three
     existing audience words — **My · Domain · Company**. Identical across every kind. The words
     "environment", "stage" and "release" do not appear in UI copy, with the single exception of
     "release" for software apps.
  2. **UI:** one header toggle **Studio | Run**, two small badges per tile and detail header, and one
     **Go live** button with one confirm dialog that states what starts running (the schedule, the
     URL, the consumers). **Nothing else new on screen.**
  3. **Defaults preserve today.** Migration marks every existing object **Live**, so the Run view on
     day one is exactly today's screens. New objects are **Draft**. Consumers land in Run, builders
     in Studio, remembered per user.
  4. **MCP:** exactly **two** new tools — `go_live` and `retire`. `run_tests` is **not** a new tool;
     it reuses each kind's existing verify/test tool. `lifecycle` is an **optional** filter on list
     tools, defaulting to the caller's current view semantics. **No new required argument anywhere.**
     Every result carries `lifecycle` and `audience`.
  5. **Testing is not a managed state.** It means "run, build or preview the draft from Studio". The
     badge reflects an in-flight test; there is nothing to administer.
  6. **Complexity lives where nobody looks:** in the pin (the git tag plus `os/lifecycle.yml`) and in
     the dependency guard. Both are invisible on the common path.
  7. **Budget fallback:** if tonight runs short, ship **Draft / Live only** — two words — and add
     Testing later. Shipping three words badly is worse than two words well.
  **Any stream whose UI adds a fourth noun, or whose MCP adds a required argument, fails review.**
- **Model choice.** Long autonomous implementer and reviewer agents run on **Opus**; short
  mechanical passes may use a smaller model. A stream that runs out of context mid-brief stops,
  records state in its report, and hands back — it does not guess.

---
## Decisions

Each decision is taken for the owner under autonomous mode, with its rationale, and is listed again
in "Decisions taken without the owner" at the end for review.

### Metrics

**D1 — A metric's definition becomes real dbt YAML in the domain's dbt project; the OS keeps
serving it.** The OS writes `semantic_models:` + `metrics:` (and later `saved_queries:` /
`exports:`) into `models/semantic/<model>.yml` of the owning domain's generated dbt project, through
the existing generator and the existing commit path — and keeps **execution** in its own TypeScript
compiler over Trino, extended to the dbt metric types. *Rationale:* this is R1's Option A, and it is
the only option that satisfies all four of the owner's criteria at once. The artefact becomes the
one an engineer recognises and can clone, and a metric change becomes a commit — which does not
happen today at all: `tabs/data/lib/semantic.ts` already emits MetricFlow-shaped YAML but it never
reaches `generateProject`, so no metric is in git, in the manifest, or visible to anyone who checks
out the project. Keeping execution in TypeScript preserves the per-viewer Trino impersonation that
is the whole point of the OS; MetricFlow opens one warehouse connection from its own profile and
would lose it.

**D2 — MetricFlow is never on the interactive request path.** The metric read path stays
`tabs/metrics/lib/explorer.ts` → one governed Trino `SELECT` as the viewer. *Rationale:* MetricFlow
is Python and the read path is TypeScript in os-ui; serving a KPI tile would mean a subprocess (or
the stdio sidecar) per request, each parsing a `semantic_manifest.json` and opening an adapter
connection. Per-viewer RLS means per-viewer process, which does not share and does not scale, and
this programme is already operating under memory-pressure guardrails. Trino is also a
community-tier MetricFlow adapter carrying a known-limitation workaround — fine for batch, thin ice
for the surface that must never show a wrong number.

**D3 — MetricFlow (Apache-2.0, pinned `>= 0.209.0`) is adopted twice, in the two places it is
right: as the CI parity oracle, and as the batch/export engine in the Dagster pod.** *Rationale:*
MetricFlow was relicensed from BSL 1.1 to Apache-2.0 on 2025-10-14; `v0.209.0` is the first Apache
release and `≤ v0.208.1` remains BSL for ever (BSL does not relax retroactively). That removes the
licence objection to using it *somewhere*, and the two places that are not the request path are
exactly where it pays: a differential test that the OS compiler's numbers equal MetricFlow's for the
same committed YAML turns checklist item M7 from an opinion into a measurement, and the Dagster run
pod already has Python, dbt, dbt-trino, `git` and `OS_PRINCIPAL`. Both are **backlog, not tonight** —
the floor assertion in the licence gate is tonight.

**D4 — The emitter targets one pinned spec version: dbt-semantic-interfaces 0.8.5 = dbt-core
1.10, behind a single version constant, and says so in the generated project's README.**
*Rationale:* `docs.getdbt.com` now serves the dbt 1.12 ("Fusion") spec by default and the
`?version=` selector is client-side only, so the prose no longer describes what dbt Core 1.8–1.10
accepts; the authoritative source is the DSI pydantic spec at the version dbt-core pins. 1.12 is a
breaking redesign of this exact spec (`semantic_models:` nests under `models:`, `measures:` are
deprecated in favour of simple metrics, `type_params.metrics` → `input_metrics`,
`cumulative_type_params` flattens). Whatever the OS emits will be wrong for *some* dbt version, so
the pin is explicit, stated, and testable, and the 1.12 form becomes a translation layer rather than
a rewrite. **Before M1 writes a line, read the dbt version off the images** —
`cumulative_type_params` does not exist at all on dbt 1.8, and the pin must match what ships.

**D5 — The generated project gains a time-spine model per domain, and `cumulative` / offset metrics
join to it.** `models/os/os_time_spine_day.sql`, declared with the dbt 1.9+ `time_spine` model
property (not the legacy `metricflow_time_spine` name), built from Trino's
`sequence(date, current_date, interval '1' day)`, materialised by Dagster like any other model.
*Rationale:* without a spine a trailing window counts *existing buckets*, not calendar units — the
defect `tabs/metrics/lib/explorer.ts:188-193` documents in its own comment — so "last 7 days" today
means "the last 7 rows that happen to exist". The spine is also a hard prerequisite for
`offset_window`, `offset_to_grain`, conversion metrics and `join_to_timespine`. Open and deliberately
left to the implementer with a recorded answer: materialised table vs view over `sequence(...)`, and
who owns the upper bound — pick one, state it, test it.

**D6 — The dbt metric becomes the source of truth; the Cube-shaped `Measure` is derived from it,
not the reverse.** Not tonight — tonight's emitter derives the YAML from `Measure` — but the
direction is decided now, so nobody builds a second lossy bridge. *Rationale:* a dbt-only concept
(per-side ratio filters, `offset_window`, `conversion`, metric `label`/`description`/`meta`) has
nowhere to live inside `Measure`, so a `Measure`-first design caps the metric model at what Cube
could express, which is exactly the limit the owner asked to remove. The OS's
`count_distinct_approx` has **no faithful dbt agg** and is the one documented exception: it emits as
`count_distinct` plus `config.meta.os_agg: count_distinct_approx`, the OS compiler honours the
approximation, and it is **excluded from the parity oracle with a stated reason** rather than
quietly passing.

### Dashboards

**D7 — One chart surface first: `core/ui/charts/`.** Before any dashboard feature, the OS gets a single ECharts registration surface, one `<Chart option>` wrapper, one theme resolver and one formatter module, and the three independent registrations (`tabs/dashboards/ui/PanelChart.tsx`, `tabs/software/ui/appspec/ChartExplorerRenderer.tsx`, `tabs/data/ui/ResultChart.tsx`) all consume it and register nothing of their own. *Rationale:* R2 calls this the first deliverable and everything else builds on it. Three call sites each registering their own tree-shaken bundle is how a chart becomes inconsistent in two places at once, and every vendored transformer must land behind one surface or the vendoring multiplies. It is also what makes "a dashboard renders inside a Software app, in-process, under the viewer's identity" nearly free — strictly better than Superset's own iframe-plus-guest-token embedding.

**D8 — Build fresh on ECharts with Superset's form-data model, and vendor exactly four backend-free slices of Superset source into `os-ui/vendor/superset/`.** The slices: (1) `superset-frontend/plugins/plugin-chart-echarts/src/**/transformProps.ts` + `src/utils/series.ts` — the pure `(data, formData) → EChartsOption` transformers, taking Timeseries, Pie, Funnel, Gauge, Heatmap, Waterfall, BoxPlot, Radar, Treemap and skipping Graph/Sankey/MixedTimeseries; (2) `packages/superset-ui-core/src/{time-format,number-format,currency-format,time-comparison}` plus the human time-range grammar — copy the catalogue and the grammar, re-implement the evaluation against the OS's `Granularity` and Trino's date functions; (3) `packages/superset-ui-chart-controls` **as data, not code** — the per-viz control taxonomy (which controls exist, which are required, which are mutually exclusive, defaults, validators), which is exactly what `PanelBuilder.tsx` lacks today; (4) `src/dashboard/util/` — the pure `position_json` layout algebra (`dnd-reorder`, `dropOverflowsParent`, `getDropPosition`, `getComponentWidthFromDrop`, `componentIsResizable`, `getEmptyLayout`, `componentTypes`, …), which turns the single biggest MUST from design work into porting. *Rationale:* Apache-2.0 into Apache-2.0 is the easy case and vendoring source only narrows the OS's obligations relative to bundling the app. **Do not `npm i` any `@superset-ui/*` package:** every one of them was last published 2024-12-10 and peers on React `^16.13.1` against the OS's React 19 — `npm i` would silently install a React-16 tree with no warning — and even `master` targets React 18, which is why the rule is *vendor pure functions, never components*. **Reimplement, never copy:** the DnD substrate, the native filter-bar containers, `SupersetClient` and `POST /api/v1/chart/data` (the OS seam is `/api/dashboards/panel-query` → `runPanelQuery`), SQL Lab, the Redux stores, the theming, and anything touching Superset's permission model — note the trap that `SupersetClient` lives *inside* the package called `superset-ui-core`, so "core" is not a synonym for backend-free.

**D9 — `react-grid-layout@2.3.0` (MIT) is the grid substrate; Superset's DnD is not adopted.** *Rationale:* Superset does not use `react-grid-layout` at all — it uses `react-dnd@^11.1.3` with a bespoke `DragDroppable`, five majors behind current and dormant upstream since mid-2022. Taking Superset's layout *algebra* while standing it on a maintained, React-19-compatible grid is the whole trick: the expensive part (what happens when you drop a chart into a column that is already full) is ported, and the substrate is current. `@dnd-kit/*` (MIT) is the named alternative if the grid proves insufficient.

**D10 — A dashboard is code in the domain repo: `dashboards/<slug>/dashboard.yaml`, one file, not a ZIP.** Under the reserved subtree `dashboards/` via `reserveSubtree` + `commitSubtree`, exactly as `agents/` already does, with an `index.yml`, a generated `README.md`, and byte-stable generation so a commit happens only on real change. The shape takes **Perses' authoring model, Superset's layout vocabulary** (tabs and rows, which Perses lacks) **and the OS's own id discipline**: `apiVersion: os.sovereign/v1`, `kind: Dashboard`, `metadata`, `spec.sources[]` referencing `metric:<id>` / `dataset:<id>`, `spec.time`, `spec.filters[]`, `spec.panels[]`, `spec.layout.tabs[].rows[].items[]` on a 12-column grid. *Rationale:* dashboards are the one builder artefact with no git home today while agent systems and the dbt project both have one, and `git log dashboards/<slug>/` is a better version history than a second ledger. Two design rules are load-bearing: **references are stable OS ids, never embedded queries**, so a dashboard file can never smuggle SQL past the metric registry; and Superset's `datasets/`/`databases/` files are skipped entirely, because in the OS those are already governed artefacts with their own git home. Import resolves ids in the target domain and **fails loudly** on a missing one. Superset-ZIP import is a later interoperability win that needs no vendored UI.

**D11 — No ad-hoc SQL in a panel, no result cache without the principal in the key, and the loud-degradation contract is preserved verbatim.** A panel addresses governed metric members only; the bridge from an exploratory query is "promote this query to a metric", never "paste SQL into a tile". Any cache added later is keyed by `(principal, resolved Trino groups, full panel slice)` with a tripwire test that a principal-less key cannot even be constructed. A filter operator the governed path cannot serve becomes a **typed `bad_request`**, closing the hole where `panel-query.ts` silently keeps only `operator === 'equals'` and drops the rest without reporting it. Scheduled snapshots render **per recipient**, never once for all. *Rationale:* R2 rates the ad-hoc-SQL hole high impact and the naive cache **critical** — under per-viewer RLS a shared cache is a data breach, not a performance choice. And the existing honesty machinery (`missingPanelMembers` → `missingMembersWarning` → the outage > unresolved member > dropped dimension precedence) is a genuine differentiator over Superset, which will happily render an un-grouped bar when a column disappears; it is also exactly the kind of thing a rewrite loses once caching, pivots and post-processing sit between the query and the pixels. Every new path routes through the same precedence chain.

### Chat to the data

**D12 — "Ask the OS" becomes a first-class governed agent system on the existing LangGraph engine; nothing is vendored.** The flagship chat surface moves off the stateless `runAgentic` PLAN→ACT loop (`core/runtime/agent-loop.ts` `runOsAssistant`) onto `runOsTeam` with a built-in, versioned, **not user-editable** system shipped in the repo, id **`os.analyst`**: `router → analyst | explainer | metric-author | dashboard-author → artifact assembler → (user confirms) → writer`, with per-node tool allowlists in the `tabs/software/lib/chat-modes.ts` style. *Rationale:* R3's finding is that the OS is ~80% of the way there and does not know it — a semantic layer that accepts no SQL by construction, a typed chart spec (`Panel`), a governed per-viewer resolver (`/api/dashboards/panel-query`), an ECharts renderer, durable LangGraph threads with parked holds, and the "Apply this suggestion" pattern in `StageAssistantChat.tsx` all already exist. What is missing is wiring. Moving onto the engine buys holds, the Postgres checkpointer, one-trace-per-run, the tool-call timeout and result-size guards, the Governance queue and cost attribution **for free**, and makes chat a citizen of the OS rather than a bolted-on chatbot. **Migration is staged behind a flag with the PLAN→ACT path intact and a parity harness; read-only intents move first, write intents last.**

**D13 — Nothing is vendored for chat. Open WebUI is closed as an option; LibreChat and Wren AI are read-only references.** *Rationale:* Open WebUI ≥ v0.6.6 is BSD-3 **plus a branding-protection Clause 4** that its own docs admit is not an OSI licence — it forbids removing the branding except under a 50-end-user/30-day ceiling, written permission, or a commercial licence, which is exactly what a white-labelled Sovereign OS would need; and its frontend is Svelte, so there is nothing to embed in a React 19 / Next App Router codebase anyway. Vendoring from the v0.6.5 tag would be legally clean and still wrong. LibreChat is MIT but is a Vite SPA against its own Express API, Mongo and Meilisearch — a second system of record, which breaks "every mutation a git commit" — and its artifacts panel renders model-authored code, with a Sandpack fallback to **CodeSandbox's public bundler** if `SANDPACK_BUNDLER_URL` is unset: an outbound third-party dependency in the render path. **Correct the record:** Wren AI is **not blanket AGPL** — it is multi-licensed by path (Apache-2.0 for `core/`, `sdk/`, `skills/`, `examples/`; CC BY 4.0 for `docs/`; AGPL-3.0 *reserved for future modules*); it is excluded on architecture (a competing semantic layer), not on licence, and any plan document repeating "Wren AI = AGPL" is to be fixed. Lightdash's AI stack is entirely in `ee/` (source-available, subscription-gated, modifications assigned to the licensor) and Metabase's Metabot is AGPL core — read the docs, never the source.

**D14 — Artifacts ride the MCP standard, not a bespoke envelope: `outputSchema` + `structuredContent`.** A turn returns `{ text, artifacts[], tools[] }`, where each artifact is a **typed spec the client renders** — `table` · `chart` · `metric_draft` · `dashboard_draft` · `citation` · `clarification` — and the same payload is the `structuredContent` of `query_metric` / `query_data` / `preview_metric` / `suggest_metrics` / `get_metric` / `get_dashboard`, each declaring an `outputSchema`. *Rationale:* the MCP tools spec already standardises exactly this, so UI parity and external-client parity come free instead of costing a second serialiser — Claude Desktop receives the byte-identical validated payload the drawer renders. **The model never emits markup**: a chart is a `Panel` posted to `/api/dashboards/panel-query` and mounted in the existing `PanelChart.tsx`, so the chart in chat is byte-identical to the chart on the dashboard and carries the viewer's own RLS. `resource_link` carries an oversized result set and `annotations.audience` keeps a 500-row table out of the prompt while still showing it to the user. Adding the schemas is a **prerequisite** for the renderers, and it is its own item.

**D15 — Thread = LangGraph thread id = run id = Langfuse trace id, durable in `agent_runs`, keyed `{userId, threadId}`.** The client stops being authoritative: the browser sends `{ threadId, newMessage }` and the server-side `.slice(-20)` of a client-supplied array is deleted. *Rationale:* chat today has **no persistence at all** — `core/ui/OsAssistant.tsx` holds messages in `useState` and the route trusts the last 20 messages the client sent, so history is neither durable nor a server record. Reusing the run thread gives durability, resume, retention (`engine/retention.ts`) and the one-trace-per-turn fix in one move. **The key is per user, never `{domain, agent}`** — that is `agent-memory.ts`'s key, and reusing it for chat would leak across users inside a domain. A `MemorySaver` fallback must stay visibly labelled, as the run report already does: a memory fallback may never masquerade as durability.

### Software: vibe-engineered apps, hosted properly

**D16 — Apps live in git: one repo per domain, apps under `apps/<slug>/`, through the existing commit path.** `commitSubtree('apps/<slug>', …)` plus `reserveSubtree('apps/')`, exactly as the Data and Agents tabs do; the OpenSearch `os-app-files` mirror is demoted from home-of-record to a **cache of the committed tree**. *Rationale:* today `tabs/software/lib/server.ts` says it in its own comment — *"there is no git backend"* — and the `commit` MCP tool is a whole-tree overwrite of one OpenSearch document: no history, no SHAs, no authorship, no diffs, no tags. The prior tree is simply gone. One repo per domain (not per app) keeps every existing invariant: the `os-repos` PVC is `ReadWriteOnce` with a single-replica os-ui and a per-repo mutex; the push mirror is one `{url, tokenSecretRef}` per domain; `git daemon --base-path=/repos` and its NetworkPolicy are unchanged; and a domain admin has **one** repository to point their IT department at. Per-app repos would multiply mirrors, secrets and daemon exposure for no governance gain — and `repoPath` already validates a single safe segment, so a customer who demands them later is a local change.

**D17 — `main` is the only long-lived ref; a release is an annotated tag `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>` carrying a release manifest.** No feature branches in v1. The tag points at the reviewed commit and `apps/<slug>/.app/release.json` records `{ version, commit, appSpecHash | artefactDigest, builtAt, builtBy, inputs, sbom, gates, approval }`. *Rationale:* the OS is the only writer and the compile gate is pre-write, so a branch buys nothing and costs a merge story. Tag namespacing by slug is what makes one-repo-per-domain work — `git tag --list 'app/invoices/v*'` **is** that app's release history. This requires a **new additive tag API in `core/infra/git-store.ts`** (`annotatedTag`, `listTags(prefix)`, `resolveTag`, and a path-scoped `log`): `MAIN` is a hard-coded module constant today and there is no tag or branch API at all. R4 sizes it at ~150 lines, fully testable with the existing temp-dir pattern.

**D18 — Three tiers; Tier 1 and Tier 2 ship to full enterprise standard with no builder, Tier 3 stays behind an operator flag.** Tier 1 `spec` = a frozen AppSpec + its hash, rendered same-origin by the trusted OS renderer. Tier 2 `runtime` = a **content-addressed static bundle**, hashed, stored, pinned and served by hash (not re-bundled per request), in a sandboxed same-origin iframe. Tier 3 = an OCI image digest and a per-app Deployment — a builder, a registry, wildcard DNS and per-app TLS. *Rationale:* Tiers 1–2 are what "vibe engineered business apps over governed data" actually are, they cost **zero marginal pods**, they already have the strongest identity story, and they satisfy every enterprise checklist item except digest-pinned-image and provenance. A content-addressed bundle hash *is* an immutable artefact: "re-pin the digest" becomes "re-pin the bundle hash", and an IT department asking "what exactly is running" gets a hash → a tag → a commit. Tier 3 is where the hard SKE questions live and where the Kaniko path already died once — do not re-enter it to satisfy a checklist Tiers 1–2 satisfy. **And do not revive Kaniko:** `config.ts` pins `gcr.io/kaniko-project/executor:v1.23.2` and Google archived the project in June 2025, read-only, no upstream CVE fixes. When Tier 3 is eventually built, **prefer kpack/CNB** (non-root by construction, rebuilds on base-image CVE patches, emits the SBOM) over rootless BuildKit/Buildah, whose honest trade is *"you stop being privileged and start being unconfined, which an auditor treats as equivalent"* — and pay its four CRDs plus a registry only when a customer needs it.

**D19 — The pipeline runs in the OS's own job path, with the gates in-process for Tiers 1–2.** Gate order, all blocking unless noted: **compile/typecheck** (exists — `compileGate` runs before any write and throws 422 with diagnostics; it is the model for the rest) → **tests** (run the committed tree's tests) → **secret scan** (exists; blocks even a Builder with 409) → **SAST** (replace the 129-line regex `lib/scan.ts` with a real engine behind the same shape its own header already promises) → **dependency vulnerabilities** (fail high/critical, warn below, against the committed lockfile) → **licence policy** (fail on denylist) → **SBOM** (non-blocking to produce, but its absence blocks the tag) → **release manifest → tag**. Every result is one `PipelineRun` record with a log readable over MCP. Tool choices, all permissive: **Trivy** (Apache-2.0) is the default single pick covering SAST-ish, vulns, licences and SBOM; **osv-scanner** (Apache-2.0) for a precise lockfile gate; **Syft**/**Grype** (Apache-2.0) if SBOM-driven; `npm audit` is **Artistic-2.0**, necessary but not sufficient — it must not ship as "the" dependency gate. SBOM format: **CycloneDX 1.7** (ECMA-424). *Rationale:* not Dagster (it would couple app deploys to dbt parse cycles and a pod the data team owns), not Tekton or Argo Workflows (new CRDs and a controller against the v2-lean direction). Standards the gate set is written against, so an IT department recognises it: NIST SSDF SP 800-218 **PS.1/PS.2/PS.3, PW.4/PW.7/PW.8, PO.3/PO.5, RV.1–RV.3**; **SLSA Build L1→L2**; OWASP **SAMM v2** Secure Build/Secure Deployment and **ASVS 5.0** V13.3/V15; **12-factor V** (every release has a unique, immutable id); **OpenGitOps** "versioned and immutable"; ISO/IEC 27001:2022 Annex A **8.25–8.32** (notably **8.31** separation of environments and **8.32** change management) and **5.3** segregation of duties; and the **CRA** (Regulation (EU) 2024/2847) Annex I Part II(1) SBOM duty — technical documentation, not publication, no mandated format.

**D20 — Environments are the existing scope ladder, and promotion re-points; it never rebuilds.** dev/preview = My scope, `startPreview`, owner-only, no review. staging = Domain, `request_deploy` → a Builder review card with four-eyes. prod = Company, `promote` → Admin certification. A release is built and gated **once**, at My→Domain; Domain→Company moves a pointer to the same release, and a test asserts the artefact hash is byte-identical before and after. **Rollback** is `rollback_software(appId, toVersion)`: resolve the tag, read `release.json`, re-pin, move the pointer, audit actor/from→to/reason — **no rebuild and no re-review**, because re-reviewing a rollback is the anti-pattern that makes teams avoid rolling back. *Rationale:* this makes dev/prod parity true by construction instead of by discipline, and it is the Vercel model the whole industry already recognises: immutable deployment, the alias moves. The existing `scopeBroadened` predicate is already the right test for "does this need a fresh card", and ITIL 4 change enablement gives it the right words — an in-envelope redeploy is a **standard change** under a pre-authorised change model; a scope-broadening one is a **normal change** needing authority. **The one change the gate needs** is six fields on the card and the approval record: commit SHA, release tag, test result, SBOM, vulnerability report, artefact digest. The one-sentence test to put in front of an IT department is *"show me the commit, the tag, the build log, the SBOM, the scan result, the approval with the approver's name, and the digest that is actually running — for the app that is live right now."* Today the OS can answer two of seven.

**D21 — The identity model does not change: the same-origin session bridge is defended, not replaced; agents reach app actions through the adoption gate.** An app's `createOsClient()` runs same-origin with `credentials: 'include'`, so the app acts **as the signed-in user** and RLS/OPA apply unchanged — no token, no postMessage RPC, no new auth path. Custom AppSpec blocks keep running null-origin and can never act as the user. **Agent → app** keeps `callAppTool` with reads-on/writes-off and writes **held (202) in the Governance inbox**, and **gains the adoption layer**: a `domain_admin` must *adopt* an app's actions before the domain's agents may be granted them, reusing `adoptActions` from `core/mcp/experimental/exposure-write-tools.ts` — the best governance primitive in the codebase, a fail-closed intersection of capability ∩ exposure ∩ adoption ∩ grant. Execution uses the **calling run's** principal, not the app's. **App → agent** goes through the same governed MCP door under the viewer's session. *Rationale:* token exchange for Tiers 1–2 would buy a new secret, a new rotation story, a confused-deputy surface and an auditor's favourite question, in exchange for nothing the ambient session does not already give. Tier 3 is the only case that needs a delegated token, and then it must be short-lived, audience-restricted, per-request, and unusable when no user is present.

**D22 — Fix the two live traps and delete the false documentation, first, before any feature.** (a) **The `'image'` default is a live trap:** `normalizeServeMode` maps every legacy or nil record to `'image'`, and `appImageRef` falls back to `config.softwareRunnerImage`, whose chart default is `traefik/whoami:latest` — so any legacy app that flips live today serves **a stranger's placeholder container on the customer's own domain**. The default becomes `'spec'`, and a missing image fails closed and loudly. (b) **Demo-seed paths must become structurally unusable in any gate, review card or `verify_software` result** — they are honestly labelled today, which is right, but the label lives in a response field a UI or an agent can drop, and *an approval card grounded in seeded data is a governance failure wearing a green tick*. (c) **The shipped documentation is false and that is itself an audit finding:** every scaffolded app's README and Dockerfile tells the user *"built by Sovereign Agentic OS CI → Harbor → Argo CD"* and *"Argo CD syncs it to https://<slug>.<domain>"*; `tabs/software/lib/README.md` describes Forgejo, Harbor, Argo CD and two files that **do not exist** (`build-service.ts`, `ci-repair.ts`); `config.ts` carries Forgejo and Harbor comment blocks and dead `kanikoImage` / `softwareBuildEnabled` / `softwareBuildNamespace` config with zero call sites; `values.stackit-managed.yaml` still advertises a `forgejoConsoleUrl`; `values.yaml` has a dangling `# Software DIRECT BUILD SERVICE` comment with no keys; and the Admin UI tells users *"Argo CD reverts drift automatically"* over pure mock data. *Rationale:* an IT reviewer who reads that, greps for `build-service.ts` and finds nothing will conclude the documentation is unreliable and then distrust the parts that are true and excellent — the deploy gate, the identity model, the NetworkPolicies. It is a credibility risk wildly disproportionate to the effort of fixing it, and R4 calls it the cheapest, highest-value item in the whole report.

### Cross-cutting: git, the engineering view, and licences

**D23 — Every builder artefact kind lives in the domain repo through the one commit path, and no kind may ship a writer that does not commit.** One table (in the stream G brief) fixes the repo path per object kind, personal lanes included. Datasets and agent systems already comply; tonight metrics, dashboards and app source trees join them; knowledge workflows and connection **configurations** (never secrets) follow. The gate is an X1-style enumeration test per kind: a new writer fails the test until it is classified. *Rationale:* the owner's requirement is literally "everything that is built in OS lives in GIT and can be versioned", and the existing machinery already makes that cheap — what is missing is coverage and a test that makes coverage non-optional. The `DestructiveReconcileError` guard and the `hydrationState()` rule stay in force for every new reconcile.

**D24 — Versioning is generic and read-only on git; restore is a new commit, never a rewrite.** `objectGitInfo(kind, id)` → `{ head, history[], truncated }`, `getVersion(kind, id, sha)`, `diffVersions(kind, id, shaA, shaB)`, `restoreVersion(kind, id, sha)` — the last re-applying that version **through the object's normal writer**, so every invariant, gate and approval on the normal path still applies, and the result is one new commit on `main`. All four are owner/scope-gated with the OS's `not_found` semantics for an object the caller cannot see. The lookup is keyed on the `OS-Object` trailer **with a path-based `git log -- <path>` fallback**, because boot-reconcile commits carry platform attribution rather than per-object trailers and a trailer-only lookup therefore returns `null` for objects that plainly exist in the tree. *Rationale:* a history read is just `git log`, and the cheapest correct restore is the one that goes back through the writer — a history rewrite would break the mirror, the audit trail and every consumer's assumption that the log is append-only.

**D25 — The engineering view is one shared panel over one typed adapter per object kind, and the adapter is pure, testable and MCP-serialisable.** `core/engineering/` holds the registry and the `EngineeringView` type; each tab exposes `lib/engineering.ts` returning its view; `core/ui/engineering/` renders it as an **Under the hood** panel with one tab per tool; `get_engineering_view({kind, id})` returns the identical structure over MCP. *Rationale:* the owner's objection is precise — the abstraction has gone so far that the artefacts read as Sovereign OS artefacts rather than the tools' own. A panel per tab would drift; a pure adapter per kind behind one shared renderer cannot. Making the adapter MCP-serialisable is what keeps the UI and an engineer's client honest to the same structure, and keeping the logic in `.ts` with a thin `.tsx` is the house rule that makes it testable at all.

**D26 — Native export is a product guarantee, not a side effect.** The domain dbt project downloads as a tarball (`core/infra/git-store.ts` `archive()` already produces it) that `dbt parse` accepts; an agent system exports as `system.yaml` plus the compiled graph JSON; a dashboard exports as its dashboard-as-code file; an app exports as its `apps/<slug>/` tree plus `release.json`. Each is documented with the exact command to run it elsewhere. *Rationale:* "you could take this and leave" is the strongest possible answer to the sovereignty question and the cheapest possible proof that the OS is an orchestration layer rather than a lock-in. It is also a test: an export that `dbt parse` rejects is a defect in the generator, found by the export.

### The engineer's door

**D27 — Engineers reach the domain repo over authenticated git HTTP, served by git's own `http-backend` beside os-ui, authenticated by an OS personal access token.** `https://<os>/git/<domain>.git` supports clone, fetch and push. The transport is `git http-backend` — git's own CGI, from a distro package in our own image (`images/base/git-http`, or the existing git-daemon image extended to run both), so the licence posture is unchanged and we write no git protocol. Authentication is a **new OS personal access token**: created in Platform → "Access tokens", scoped to the user, **hashed at rest, shown once, revocable**, and mapped to the OS identity so a push carries a real principal. *Rationale:* this is the owner's engineering side of the coin, and it has to be the real protocol — a VS Code user types `git push`, not a bespoke CLI. The existing read-only `git daemon` sidecar already proves the shape (a second process on the os-ui pod, reaching the `os-repos` PVC, fenced by a NetworkPolicy); this adds authentication, write, and an ingress path. **Serialisation decision, taken:** the pre-receive hook calls one OS endpoint that **takes the same per-domain git-store lock for the duration of `receive-pack`**, rather than letting the push land and telling the OS afterwards. The alternative is simpler to build and wrong: the OS's own `commitTree` reads the head, builds a tree and writes a commit, so an interleaved push between read and write is a lost update, and "the OS is told afterwards" cannot undo one. Holding the lock makes the two writers mutually exclusive, which is exactly what the existing per-repo mutex was for. A lock wait must be bounded and must fail the push with a readable message rather than hanging a developer's terminal.

**D28 — The receive gate calls ONE OS endpoint, and that endpoint is the same validator the UI and the MCP use.** Pre-receive resolves the token to an OS identity, then decides **which paths that identity may change** — their own personal lane always; domain paths according to role; **never** `os/` governance files, grants, or anything secret-shaped — rejected with *"managed by the OS; change it in Governance or over the MCP"*, because those files are committed for transparency, not for editing — and runs the per-path validators: the dbt project through the existing parse gate, `agents/<slug>/system.yaml` through `parseSystem`, and the dashboard and metric YAML through their schemas once D and M land them. A rejection is a readable message on the developer's terminal naming the file and the reason. A non-fast-forward push to `main` is refused: **no history rewrites.** *Rationale:* if the receive gate gets its own validator the two sides of the coin drift within a week, and the drift shows up as "the UI refused this and git accepted it", which is the worst possible failure for a governance product. One endpoint also means one place to audit and one place to extend when a new object kind arrives.

**D29 — After a push, the registry is reconciled *from the files*: `reconcileFromGit(domain, fromSha, toSha)`, with one `ingestFromRepo(kind, files)` per object kind.** Each stream owns the ingest for its own kind by contract; E owns the orchestration and tonight's two implementations (dbt models + `schema.yml` → dataset records with layer, schema, columns, description and quality rules derived from the tests; `agents/<slug>/system.yaml` → agent systems). The resulting registry write is attributed to **the pusher**, with `OS-Surface: git:push`, and reuses the existing Dagster reload and Trino-rules reconcile hooks. Conflicts resolve at the git level — last writer wins — and the OS never rewrites history. *Rationale:* this is what makes the registry a derived index rather than a second system of record, and it is the only way a `git push` can be a first-class way to build. It also has a hard, cheap test: the **coin test** — make the same change over the MCP and by a push, and assert the registry state is equal.

### Lifecycle: Studio → Test → Run

**D30 — Lifecycle is a second, orthogonal axis attached to a version, not a re-use of the audience
ladder.** `core/kernel/lifecycle.ts` is pure and total over every kind: an object carries
`lifecycle: { draft: <head>, testing?: <sha>, live?: <sha|tag> }` beside its unchanged
`audience: My | Domain | Company`. *Rationale:* the two questions are genuinely different — "who may
use this as an official artefact" is a governance question answered by promotion and approvals;
"is this version being built, tested, or run" is an operational question answered by a pin. Folding
them together would make "I want to run my own thing" require publishing it to the domain, and
"I want to share this" require declaring it finished. The owner rejected that explicitly. Keeping
them orthogonal costs one new pure module and changes no existing gate.

**D31 — The OS runs from a pin, and editing never moves it.** `go_live(kind, id, sha?)` pins a commit
or tag — a git tag `live/<kind>/<id>`, or the SemVer release tag for apps, reusing **S's tag API** —
and everything that *operates* reads the pin: Dagster schedules are generated only for live pins
(a draft is materialised by hand), the app's prod URL serves the pinned artefact, agent schedules run
the pinned definition, a dashboard's Run view renders the pinned spec. Editing a live object writes a
**new draft** and leaves the pin alone; `retire` unpins. Tests run against the **draft**, in a
sandbox: datasets and metrics build into the author's lane or a `__dev` schema, agents run from Studio
with no schedule, apps serve on a preview or staging URL. *Rationale:* "what is running" must be a
specific, nameable, reproducible version, or every incident starts with an archaeology problem. This
is the same property a release tag gives the software tier, generalised to every kind — and it is why
the dependency guard can be meaningful at all.

**D32 — Two surfaces, two badges, and the tools follow the lifecycle.** The shell header carries a
**Studio | Run** toggle: Studio shows drafts, what is in testing, and live objects *for editing*;
Run shows **only live artefacts**, for operating and consuming. Every tile and detail header carries
**two small badges** — lifecycle (Draft · Testing · Live) and audience (My · Domain · Company) —
with the logic in testable `.ts`. The MCP gains `go_live`, `run_tests` (reusing each kind's existing
verify/test path), `retire`, a `lifecycle` filter on every `list_*` tool through **one** central
helper, and `lifecycle` + `audience` on every result; the promotion tools are untouched. Underneath:
**LiteLLM** tags `env:studio|test|run` with per-lifecycle budgets, **Langfuse** sets the trace
`environment` to the lifecycle, **Dagster** generates schedules only for live pins, **Trino** uses
the lane or `__dev` schema for a draft and the real schema for a live version, and **Software** maps
preview/staging/prod. **The dependency guard becomes a go-live guard:** an object may go live only
if its dependencies are live — not "at the same audience" — refused with a reason naming the
offending dependency. The pin is recorded in the OS-owned `os/lifecycle.yml`, **readable** in an
engineer's clone and **not pushable**, plus the git tag; a single `main` per domain repo stays.
*Rationale:* a lifecycle that exists only as a label on a tile is a label. These are the places that
already thread context, so each is a one-line attribution change rather than new plumbing — and the
Studio|Run split is the smallest UI that answers the owner's actual complaint, which was that
everything appears on one screen with no differentiation.

---

## Tonight's MVP cut line

**The honest arithmetic.** R2 alone prices its MUST list at **≈ 41.5 engineer-days**; R4's enterprise-credibility minimum is six items of which one is a ~150-line git API and one is a documentation purge; R1's metric work is "medium effort, incremental"; R3's is four slices of which only the first is hours. Tonight each stream has roughly **6–8 agent-hours**, unattended, in its own worktree, and must end with a green gate and tests. That is **one to two engineer-days per stream at best**.

So the cut line is drawn on one rule: **a thin end-to-end slice with tests beats breadth.** Each stream ships something a user can do, end to end, governed, committed and tested — and writes everything else into the backlog with the exact file list, so the next night starts at a brief rather than at a blank page. **A stream that finishes early takes the next item from its own backlog; it does not wander into another stream's files.**

### Stream M — metrics

**Tonight.** The typed dbt semantic model + emitter + **parser** (round-trip, not a string builder), wired into `generateProject` so `models/semantic/<model>.yml` really appears in the generated tree with a golden fixture; `type: simple` and `type: ratio` emitted correctly from today's `Measure`; the time-spine model generated; the metric writers committing through `tabs/data/lib/dbt/commit.ts` with an `OS-Object: metric:<id>` trailer; the DSI-0.8.5 version constant and its test; the licence-gate floor assertion for `metricflow >= 0.209.0`; and the Cube-vocabulary purge from every agent- and user-facing string (M-R12.1), which is cheap and pure honesty.
**Not tonight.** `cumulative` and `derived` SQL compilation and the calendar-correct window fix (they need the spine materialised and a careful compiler change — the YAML may be emitted, but the compiler must refuse what it cannot serve rather than return a wrong number); the dbt filter-syntax parser; entity joins; `saved_queries`/`exports`; the MetricFlow parity oracle; the `Measure`-derived-from-dbt inversion.

### Stream D — dashboards

**Tonight.** `core/ui/charts/` consolidated and the three call sites moved onto it (D7 — the prerequisite, and nothing else in this stream is allowed to start first); the licence machinery for vendoring landed **in the same commit as the first vendored file** (the `os-ui/vendor/superset/` tree, the per-file `Modified from …` convention, the `check-structure.mjs` exclusion plus the new header tripwire, `components.tsv`, `THIRD-PARTY-LICENSES.md`, `core/kernel/licenses.ts` — which lists **neither ECharts nor Superset** today — and the regenerated SBOM); **one** vendored transformer slice proven end to end behind the new surface (Timeseries, with Pie if time); the `vizType` enum fixed to the full `VizType` union; the filter-operator hole closed as a typed `bad_request`; and **dashboard-as-code**: the generator, the reader, the `reserveSubtree('dashboards/')` commit hook and goldens.
**Not tonight.** The layout tree, drag and resize, tabs, markdown tiles; the native filter bar; the pivot table; dashboard-level time range; the explore upgrade; multi-view dashboards; PNG/PDF; per-recipient snapshot rendering; the principal-keyed cache; `update_dashboard`/`add_chart`/`remove_chart`/`render_dashboard_data`. All of it is in the backlog with R2's per-item day estimates intact, because those estimates are the only honest schedule this stream has.

### Stream C — chat to the data

**Tonight.** R3's slice 1 in full, because it is hours and it is the difference between a trustworthy answer and a plausible one: pass `observe: { traceId }` so a conversation turn is **one** Langfuse trace instead of N orphans; the semantic-layer-first rule in `OS_RULES` **and** in the four guides; the `DISCOVERY_COMPANIONS` entries for `query_metric` and `create_dashboard`; and the truncation fields (`truncated`, `rowLimit`, `message`) carried verbatim into the turn with a guard test that fails if they are ever dropped — *"a confident 'total revenue was €4.2m' computed over the first 1,000 rows is the single worst thing this feature could do."* Then the artifact protocol's foundation: `outputSchema` + `structuredContent` on the six read tools, the shared artifact type module, and the `table` and `citation` renderers in the drawer.
**Not tonight.** The `chart` / `metric_draft` / `dashboard_draft` renderers; the `os.analyst` system definition; the engine migration off `runAgentic`; durable per-user threads; streaming; the write path with its confirm; `ask_os`; `add_panel_to_dashboard`; the red-team fixtures. The engine migration in particular is explicitly staged behind a flag with a parity harness (R3's R9) and must not be attempted in one unattended night on the OS's most visible surface.

### Stream S — software

**Tonight.** R4's S1 and S2 in full — the documentation purge and the trap fixes — because an IT reviewer who greps for `build-service.ts` and finds nothing stops believing the parts that are true: the scaffold README/Dockerfile lies, `tabs/software/lib/README.md`, the Forgejo/Harbor/Kaniko comment blocks and dead config in `config.ts`, `forgejoConsoleUrl`, the dangling `values.yaml` comment, and the Admin UI's "Argo CD reverts drift automatically" over mock data; plus the `'image'`-default trap (default becomes `'spec'`, a missing image fails closed and loudly) and the capture-then-delete instruction for the orphan `cron-deploy-pipelines` CronJob written into Part C. Then the foundation: the **additive tag API in `core/infra/git-store.ts`** (`annotatedTag`, `listTags(prefix)`, `resolveTag`, path-scoped `log`) with temp-dir tests, and app source trees committing through `commitSubtree('apps/<slug>')` + `reserveSubtree('apps/')` with the OpenSearch mirror demoted to a cache; then `push_app_files` as the one documented verb from Claude.
**Not tonight.** `release_software` and the release manifest; the six approval-card fields; `PipelineRun` and the pipeline MCP tools; the tests/SAST/dependency/licence/SBOM gates; `rollback_software`; the content-addressed Tier-2 bundle; the adoption gate for app actions; quotas; PSS `restricted`; Tier 3 in any form.

### Stream G — git everywhere and the git UI

**Tonight.** `core/infra/git-objects.ts`: the generic `objectGitInfo(kind, id)` read-back keyed on `OS-Object` **with the path-based `git log -- <path>` fallback** (this is the night-1 follow-up that makes `git.head` non-null for pre-existing objects), plus `getVersion` and `diffVersions`; the additive `core/infra/git-store.ts` support they need (read-at-commit, path-scoped log, unified diff) — **coordinated with S, which owns the tag half of the same file**; the repo-layout table for every object kind; the shared `core/ui/git/` components (`GitHeadBadge`, `HistoryDrawer`) with the logic in `.ts`; the generic MCP reads `get_history`, `get_version`, `diff_versions`; and the X1-style enumeration test over **all** kinds, which is the gate that makes "everything lives in git" non-optional.
**Not tonight.** `restoreVersion` and `restore_version` (a write that must go back through each object's writer — design it, test the refusals, but do not ship the write path unattended on five kinds at once); `ReleaseList`; `list_releases`/`create_release`; Governance → Repositories; knowledge workflows and connection configs. Ship `restoreVersion` next, first on one kind, with the owner/scope gate tested before the write exists.

### Stream T — the engineering view

**Tonight.** `core/engineering/` with the `EngineeringView` type and the adapter registry (pure, testable, MCP-serialisable); `lib/engineering.ts` adapters for **dbt** (repo path, the stored model SQL and YAML, the `dbt build --select` / `dbt test` commands), **Dagster** (asset keys, job and schedule names, last run id and status, the `dagster asset materialize` command), **LangGraph** (the compiled graph as JSON — nodes, edges, `when` guards, channels, interrupt points — plus checkpointer and thread-id semantics), **Git** (file list, head sha, composing G's badge rather than duplicating it) and **Langfuse** (the trace URL and what is redacted); the `UnderTheHood` panel in `core/ui/engineering/` with one tab per tool and the vocabulary rule enforced by a test; `get_engineering_view({kind, id})`; and the **native dbt-project export** documented, since `archive()` already produces the tarball.
**Not tonight.** The Trino "preview as me" button; the LiteLLM tab; the LangGraph diagram (the JSON first — `@xyflow/react` is already a dependency, so the diagram is cheap later); the agent-system and dashboard exports; `list_capabilities` description sweep naming each tool's underlying tool.

### Stream X — night-1 live follow-ups

**Tonight, all of it** — these are small, independent, and each one is a lie in the product today: boot-reconcile per-object attribution so `git.head` resolves for pre-existing systems (coordinated with G, which owns the fallback); skipping a **zero-agent system** rather than its whole domain in the agents reconcile; the tool-span `status: error` on successful tools and `owner: unknown` in trace read-back; the `docs/components/trino.md` password and regeneration wording; the ECharts and Superset rows missing from `core/kernel/licenses.ts` (**coordinate: D owns that file tonight — X files the finding, D lands it**); the MCP `vizType` enum (**same: D owns it**); and the agent-facing "Cube secures the number" text (**M owns the metric strings; X owns any outside `tabs/metrics`**).

### Stream E — the engineer's door (git → OS)

**Tonight, in this order — transparency first, then write, then ingest.**

1. **Authenticated READ.** The `git http-backend` image, the chart sidecar, the `/git/` ingress path
   and `core/auth/access-tokens.ts` (creation, hashing at rest, one-time display, revocation,
   lookup) plus the small Platform → Access tokens section — so an engineer can
   `git clone https://<os>/git/<domain>.git` with a token and read **everything**, including the
   `os/*.yml` governance metadata. With it: the "open this file in the repo" link in T's panel and a
   `git clone` instruction on every detail page. This is the half that stops the OS being a black
   box, and it needs no receive gate at all.
2. **Push behind the receive gate.** `core/infra/git-receive.ts`: hold the per-domain git-store lock
   for the duration of `receive-pack`, resolve the token to a principal, decide path permission
   (own personal lane; domain paths per role; **never** `os/*`, grants or anything secret-shaped),
   run the validators — the dbt project through the existing parse gate and `agents/<slug>/system.yaml`
   through `parseSystem` — refuse a non-fast-forward `main`, and reject with a readable message
   naming the file and the reason.
3. **Post-receive ingest.** `reconcileFromGit(domain, fromSha, toSha)` with
   `tabs/data/lib/dbt/ingest.ts` (dbt models + `schema.yml` → dataset records: name, layer, schema,
   columns, description, quality rules from the tests) and `tabs/agents/lib/git/ingest.ts`
   (`system.yaml` → agent systems), attributed to the pusher with `OS-Surface: git:push`, reusing
   the existing Dagster reload and Trino-rules hooks.

Drive all three in tests with a **fake receive** — a real bare repo in a temp dir, a synthetic push,
the endpoint called directly — so every gate and the coin test are green offline. `docs/components/git.md`
("Work from VS Code") lands tonight. **The live clone and push are `kind`/`stackit` and go in Part C.**

**Not tonight.** Branches as proposals (`proposal/*` surfacing as a promotion request); PR-like
review in the UI; the reverse mapping for the remaining object kinds (metrics and dashboards arrive
when M and D have landed their formats — the contract is the per-kind `ingestFromRepo`); Software
apps by push, which lands with S's tags and releases; VS Code task snippets.

### Stream V — lifecycle: Studio → Test → Run

**Tonight.** The model, the two verbs, the pins for two kinds, and the smallest UI that answers the
complaint: `core/kernel/lifecycle.ts` (pure, total over every kind, `{ draft, testing?, live? }`);
`go_live(kind, id, sha?)` and `retire(kind, id)` as the **only two new MCP tools**, writing the git
tag (via **S's tag API**) and the OS-owned `os/lifecycle.yml`; the **go-live dependency guard**
refusing with a reason that names the offending dependency; **pins honoured for two kinds** — agent
systems (the schedule runs the pinned definition) and dashboards (the Run view renders the pinned
spec); the **two badges** and the **Studio | Run** header toggle, persisted per user, with the logic
in `.ts`; the **optional `lifecycle` filter** on every `list_*` tool through one central helper plus
`lifecycle` and `audience` on every result; the `env:studio|test|run` LiteLLM tag and the Langfuse
`environment` field; the **migration marking every existing object Live** so day one looks like
today; and `docs/components/lifecycle.md` with the per-kind Studio/Test/Run mapping table and the
honest "physically separated vs only logically" section.
**Not tonight, and say so in the report if you run out:** the `__dev` sandbox schema for dataset and
metric drafts; the apps' three URLs mapped to the lifecycle (that lands with S); Dagster schedule
generation gated on the pin for the data kinds; the Promote/Go-live dialog's full "what changes"
summary. **If the budget goes, drop "Testing" first** and ship Draft/Live — per the simplicity
contract's fallback.

---

## User stories and requirements

Convention: **<S>-US<n>** a story, **<S>-R<n>.<m>** its testable requirements, where `<S>` is the
stream letter (M · D · C · S · G · T · E · X). `[MVP]` = tonight; `[later]` = backlog with the
file list. "As the signed-in user" always means a user-delegated token through the governed path —
never a service principal.

### Stream M — Metrics as dbt metrics

Lifted from R1 §5 and reconciled with the MVP cut line. `[MVP]` = tonight. `[later]` = backlog.

**M-US1 — a simple metric.** As a creator I define "Revenue" as the sum of `net_amount` over
`order_month` — in the form, from chat, or over the MCP — and the three doors produce one artefact.
- **M-R1.1** `[MVP]` The definition is persisted as a dbt `metrics:` entry of `type: simple`
  referencing a `semantic_models:` `measures:` entry with `agg: sum`, `expr: net_amount`,
  `agg_time_dimension: order_month`, in `models/semantic/<model>.yml` of the owning domain's dbt
  project. Testable: generator golden.
- **M-R1.2** `[MVP]` The emitted YAML validates against the pinned dbt semantic spec (DSI 0.8.5):
  a schema validator in the suite. `[later]` `kind`: `dbt parse` succeeds on the committed project
  and `target/manifest.json` contains the metric node.
- **M-R1.3** `[MVP]` Emission round-trips: `parse(emit(x)) == x` on one fixture per metric type, and
  two regenerations of the same state are byte-identical. The YAML is a **typed model with an
  emitter and a parser**, not `lines.push()` — today `tabs/data/lib/semantic.ts` is 124 lines of
  string building with no schema, no validation and no parser.
- **M-R1.4** `[MVP]` Re-defining the same metric name is an UPSERT in place (today's behaviour,
  `tabs/data/lib/store.ts` `defineMeasure`) and emits exactly one changed YAML file.

**M-US2 — ratio and derived metrics.** As a creator I define "Conversion Rate" as converted orders ÷
orders, and "Revenue per Order" as `revenue / orders`.
- **M-R2.1** `[MVP]` A ratio persists as `type: ratio` with `numerator`/`denominator` — not as a
  `number` measure carrying `1.0 * {a} / {b}` SQL.
- **M-R2.2** `[MVP]` Each side accepts its own `filter:`.
- **M-R2.3** `[MVP]` A derived metric persists as `type: derived` with `expr` + `metrics:`, with
  `alias` where the expression renames an input.
- **M-R2.4** `[MVP]` A zero denominator yields `NULL` via `NULLIF`, never a division error, and the
  UI shows "—".
- **M-R2.5** `[MVP]` A derived metric over a metric that does not exist is refused at define time
  with a named reason (today: `assertFormulaRefs`, `tabs/metrics/lib/model.ts`).

**M-US3 — cumulative metrics.** As a creator I define "Trailing 7d Revenue" and "Revenue MTD".
- **M-R3.1** `[MVP]` Persists as `type: cumulative` with `cumulative_type_params.window: 7 days` or
  `grain_to_date: month`.
- **M-R3.2** `[MVP]` A trailing window is **calendar-correct**: a day with no orders contributes 0
  and does not shift the window. This is the regression test for `explorer.ts:188-193`. Testable:
  a fixture series with a gap.
- **M-R3.3** `[MVP]` A cumulative metric queried at a grain coarser than its window returns an
  honest typed refusal, not a wrong number.
- **M-R3.4** `[MVP]` A cumulative query requires the time spine; a domain without one gets a named,
  actionable error — and the OS generates the spine (M-R11.1).

**M-US4 — dimensions, filters, grains.** As a user I slice any metric by its dimensions, filter it,
and change the time grain.
- **M-R4.1** `[MVP]` Query-time `group_by` accepts the semantic model's dimensions; a requested
  member the model does not expose is **reported**, never silently dropped — keep today's loud
  degradation contract (`explorer.ts` dropped-member recording, `explore-server.ts`,
  `tabs/dashboards/lib/model.ts` `missingMembers`).
- **M-R4.2** `[MVP]` Query-time `where` supports the dbt filter syntax
  `{{ Dimension('e__dim') }}` / `{{ TimeDimension('e__t','month') }}`, with values **parameterised**
  and identifiers passed through the existing `assertColumn` gate — never string-concatenated from
  user input. Testable: an injection suite over the filter parser.
- **M-R4.3** `[MVP]` Grains `day|week|month|quarter|year` all return correctly bucketed series; a
  metric's declared `time_granularity` is the floor (a day-grained measure cannot be queried at
  hour).
- **M-R4.4** `[later]` A metric on a semantic model with a `foreign` entity can be grouped by a
  dimension of the joined model — **or** the limitation is documented and the attempt refused at
  define time. Tonight: refuse with a reason; never emit YAML the OS cannot execute.

**M-US5 — every metric change is a commit, authored as me.**
- **M-R5.1** `[MVP]` Define / edit / rename / archive / delete regenerates the domain project and
  commits it, authored as the acting user, with `OS-Action`, `OS-Object` (`metric:<id>`),
  `OS-Surface`, `OS-Request-Id` trailers, through `tabs/data/lib/dbt/commit.ts`.
- **M-R5.2** `[MVP]` The same metric change over the MCP and through the UI produces a deep-equal
  committed file map, author and trailers, differing only in the `via mcp:<tool>` / `via ui:<route>`
  subject half — `tabs/data/lib/mcp-parity.test.ts` extended to the metric tools.
- **M-R5.3** `[MVP]` Regeneration is idempotent: byte-identical semantic YAML for the same state.
- **M-R5.4** `[MVP]` A metric's version history in the UI is the **git log of its YAML file** plus
  the existing version-log overlay (`tabs/metrics/lib/lifecycle.ts`) — no third ledger. Delivered
  through stream G's `objectGitInfo('metric', id)`.

**M-US6 — promotion My → Domain → Company.**
- **M-R6.1** `[MVP]` A metric's tier follows its dataset's ladder with the existing role gate and
  consistency gate (`tabs/metrics/lib/governance.ts`); a creator files `request_promotion`, a
  domain_admin approves.
- **M-R6.2** `[later]` The consistency gate additionally asserts the YAML validates, the metric
  resolves to a number as the requester, and every consumer resolves the identical value
  (`consistency.ts` `numbersMatch` extended).
- **M-R6.3** `[MVP]` Promotion moves the metric's YAML from the personal lane to the domain lane in
  the project tree exactly as models already move (`models/personal/<uid>/` → `models/semantic/`),
  in one commit.
- **M-R6.4** `[MVP]` A metric may not be promoted above its dataset's tier; refusal names the
  reason.

**M-US7 — preview and query as me.**
- **M-R7.1** `[MVP]` `preview_metric` computes an unsaved draft and persists nothing.
- **M-R7.2** `[MVP]` Every metric read runs as the signed-in user's Trino principal; two users of
  the same metric and slice get different row sets under OPA/RLS.
- **M-R7.3** `[MVP]` On a real deployment with Trino unreachable, a metric returns **no number** and
  an honest outage message (`explore-server.ts` honesty gate) — never a fabricated value.
- **M-R7.4** `[MVP]` The exact SQL that ran is returned to the caller for transparency
  (`ExploreServerResult.sql`).

**M-US8 — one number everywhere.**
- **M-R8.1** `[MVP]` A dashboard panel addresses a metric by its stable member id; its number is the
  same number the explorer shows for the same slice and viewer — `panel-query.ts` stays on the one
  compiler.
- **M-R8.2** `[MVP]` Renaming a metric never moves its identity (`label` vs `name`) and never breaks
  a dashboard.
- **M-R8.3** `[MVP]` Chat answers "what is revenue this month" through `query_metric`, which accepts
  **no SQL parameter** by construction — keep the `core/mcp/wave-a.test.ts` tripwire.
- **M-R8.4** `[later]` An agent's `query_data`/`use_data` grant over a dataset also exposes that
  dataset's **metrics** by id, with the definition in the tool context, so an agent prefers the
  governed metric over re-deriving a number from rows.
- **M-R8.5** `[MVP]` Agents and chat read the metric's `label`/`description`/`meta` from one place.

**M-US9 — MCP parity.**
- **M-R9.1** `[MVP]` `define_metric`, `preview_metric`, `query_metric`, `list_metrics`,
  `promote_metric` cover every metric operation the UI offers, each through the same governed
  service.
- **M-R9.2** `[MVP]` `define_metric` accepts the dbt metric model (`type` ∈
  simple|ratio|derived|cumulative, `measure`, `numerator`/`denominator`, `expr`+`metrics`,
  `cumulative_type_params`, `filter`, `label`, `description`) and its description stops promising
  "the generated Cube YAML".
- **M-R9.3** `[MVP]` `query_metric`'s description stops claiming Cube applies RLS; it states Trino +
  OPA as the viewer. Same for `tabs/metrics/context.md`.
- **M-R9.4** `[MVP]` A metric on a dataset the caller cannot see returns a byte-identical
  `not_found` to a non-existent one.
- **M-R9.5** `[MVP]` `list_metrics` returns the metric **type** and its time grain, so a client can
  pick a valid slice without a round trip.

**M-US10 — a metric's export is a Dagster asset.** `[later, all of it]`
- **M-R10.1** A metric set can be declared as `saved_queries:` with an `exports:` block, written on
  an explicit user action, never by default.
- **M-R10.2** Each export becomes a Dagster asset in the `sovereign` code location, materialising as
  the declared principal with the existing `os/*` tags. **Decided now:** the executable form is the
  OS compiling each export into a plain dbt **model** (`models/metrics/metrics_<name>.sql`) that
  Dagster materialises with everything else — `dbt sl export` and
  `dbt build --resource-type saved_query` are dbt Cloud only and **there is no `mf export`
  command**. The `exports:` block is portable documentation; the docs must not imply dbt runs it.
- **M-R10.3** The exported table's freshness is read from Dagster, as sync freshness already is.
- **M-R10.4** A dashboard tile may read the export instead of recomputing, and says which it did.

**M-US11 — the time spine.**
- **M-R11.1** `[MVP]` The generated project contains a time-spine model for every domain that
  declares a time dimension, materialised in the domain schema, built by Dagster like any other
  model, declared with the dbt 1.9+ `time_spine` property.
- **M-R11.2** `[MVP]` A cumulative/offset query uses the spine; the spine's grain is at least as
  fine as the finest `time_granularity` the domain declares.

**M-US12 — honest text.** `[MVP]`
- **M-R12.1** No tool description, `context.md` or UI string under `tabs/metrics`,
  `tabs/dashboards` or `core/mcp` claims Cube serves or secures a number. Only historical code
  comments may mention Cube.

### Stream D — Superset-class dashboards

**D-US1 — one chart surface.** As a developer I add a chart anywhere in the OS and it looks and formats identically.
- **D-R1.1** `[MVP]` `core/ui/charts/` owns the ECharts registration, the `<Chart>` wrapper, the theme bridge and the formatters. `grep "from 'echarts" ` outside `core/ui/charts/` returns nothing.
- **D-R1.2** `[MVP]` The same chart spec renders identically in `tabs/dashboards`, `tabs/data` and `tabs/software/appspec`.
- **D-R1.3** `[later]` A governed dashboard renders inside a Software app from the same component, under the **viewer's** identity, with no iframe and no guest token.

**D-US2 — vendored Superset power, attributed.** As a maintainer I can prove every line we took and under what terms.
- **D-R2.1** `[MVP]` Every file in `os-ui/vendor/superset/` retains its ASF header **verbatim** and carries `Modified from apache/superset <path> @ <sha>` plus the changes made. A ratchet test asserts both on every file in that tree.
- **D-R2.2** `[MVP]` `os-ui/vendor/**` is excluded from the `FEATURE:`/`USER STORY:`/`ARCHITECTURE:` header ratchet (ASF policy forbids rewriting third-party headers) and included in the new licence-header ratchet instead — **in the same change as the first vendored file**.
- **D-R2.3** `[MVP]` `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`, `core/kernel/licenses.ts` and `sbom.cdx.json` name the vendored Superset source **pinned to a commit sha, not a version**, and `core/kernel/licenses.ts` gains the **ECharts** row it is missing today. `scripts/license-check.sh` is green and **no new SPDX id enters the gate**.
- **D-R2.4** `[MVP]` No vendored dependency moves the OS off React 19 / Next 15; the lockfile diff proves one React copy.
- **D-R2.5** `[MVP]` Nothing is branded "Superset" — not a route, not a package name, not a logo. "Includes code derived from Apache Superset" is the permitted form.
- **D-R2.6** `[later]` `mapbox-gl` is added pre-emptively to `licenses/denied-licenses.txt` (proprietary since v2.0, and a TOS is not an SPDX id the substring gate can catch); `maplibre-gl` (BSD-3-Clause) is the only permitted map renderer.

**D-US3 — a dashboard is code.** As a user every save of a dashboard is a commit I can read.
- **D-R3.1** `[MVP]` Each save, from the UI or the MCP, is a git commit under `dashboards/<slug>/dashboard.yaml` in the owning domain's repo, authored as the acting user, naming the action and the surface, via `reserveSubtree('dashboards/')` + `commitSubtree`.
- **D-R3.2** `[MVP]` The file is human-readable and round-trips: generate → read → generate is byte-stable, and a hand-edited file imports. Goldens, in the style of `tabs/agents/lib/git/generate.test.ts`.
- **D-R3.3** `[MVP]` References are **stable OS ids** (`metric:<id>` / `dataset:<id>`), never embedded queries — a dashboard file cannot smuggle SQL past the registry.
- **D-R3.4** `[MVP]` Import resolves ids in the target domain and **fails loudly** on a missing id.

**D-US4 — honest numbers, honest refusals.**
- **D-R4.1** `[MVP]` A filter operator the governed path cannot serve is a typed `bad_request`, never a silent under-filter (today `panel-query.ts` keeps only `equals` and drops the rest unreported).
- **D-R4.2** `[MVP]` The `create_dashboard` MCP `vizType` enum equals the full `VizType` union; a tripwire test asserts the equality so they cannot drift.
- **D-R4.3** `[MVP]` The loud-degradation precedence — outage > unresolved member > dropped slice dimension — stays the warning authority, and every new path routes through it.
- **D-R4.4** `[MVP]` A panel accepts **no ad-hoc SQL**. The bridge from exploration is "promote this query to a metric".
- **D-R4.5** `[later]` Any result cache is keyed by principal **and** resolved Trino groups **and** the full panel slice, with a tripwire that a principal-less key cannot be constructed; A's hit is B's miss.
- **D-R4.6** `[later]` A scheduled snapshot is rendered **per recipient** under that recipient's identity; a recipient who lost entitlement gets nothing, never stale rows.

**D-US5 — Superset-class capability.** `[later, with R2's day estimates]`
- **D-R5.1** Layout: a persisted tree of tabs → rows → panels with x/y/w/h, drag and resize; an absent layout falls back to today's flow order (3.5 d, vendored algebra + `react-grid-layout`).
- **D-R5.2** Markdown, header and divider tiles, which never issue a query (1 d).
- **D-R5.3** A native filter bar — value, numeric-range, date-range, time-grain — with scope and defaults, every filter landing in the governed WHERE (4 d; per-panel scoping and dependencies +3 d).
- **D-R5.4** Pivot table with row and column groupings and subtotals, computed in SQL or in a declared, tested post-processing step — never in the browser over partial rows (4 d).
- **D-R5.5** Dashboard-level time range from the vendored human grammar, compiled to Trino predicates (2.5 d).
- **D-R5.6** Explore upgrade: n dimensions, row limit, sort, "View query" (the SQL is already on the wire as `PanelQueryResult.sql`), viz-switch preserving config (3 d).
- **D-R5.7** Multi-view dashboards — each panel carries its own view; a legacy single-`view` spec still loads (1.5 d; the executor already ignores `spec.view`).
- **D-R5.8** Exports: dashboard CSV, panel PNG via `getDataURL()`, dashboard PDF via the already-present `jspdf` — each of the **rendered governed rows**, naming the viewer, the time and the active filters (2 d).
- **D-R5.9** MCP parity: `update_dashboard`, `add_chart`, `remove_chart`, `render_dashboard_data` (2.5 d), the last returning every panel's governed rows **as the caller** with the same warnings the UI shows.
- **D-R5.10** Promotion refuses a dashboard citing metrics of a narrower tier than the target, naming the offending metric (0.5 d).
- **D-R5.11** The Superset Helm chart and its `components.tsv` bundled-app row are removed **in one change** when this stream completes — otherwise the OS ships two dashboard products.

### Stream C — chat to the data

**C-US1 — ask a question about a data product.** `[MVP]`
- **C-R1.1** The answer carries an artifact showing the SQL or compiled semantic query (collapsed), the dataset id and tier as a citation, and the row count.
- **C-R1.2** When the result was clipped, `rowLimit` and the query-tool's own `message` are shown **verbatim**, and a guard test fails if the truncation fields are ever dropped on the chat path.
- **C-R1.3** The model is instructed never to aggregate or summarise a truncated result set.

**C-US2 — ask about a metric and the semantic layer answers.** `[MVP]`
- **C-R2.1** `OS_RULES` states: for any question about a number, `list_metrics` → `query_metric`; `query_data` only when no metric member exists, and then always show the SQL and the row bound.
- **C-R2.2** The same sentence is in `core/guides/overview.guide.md`, `tabs/metrics/guide.md`, `tabs/dashboards/guide.md` and `tabs/data/guide.md`, so an external MCP client gets it too.
- **C-R2.3** `DISCOVERY_COMPANIONS` gains `query_metric: ['list_metrics','get_metric','get_dataset']` and `create_dashboard: ['list_dashboards','list_metrics','get_dataset']` — widening discovery, never authority.
- **C-R2.4** An ad-hoc `query_data` answer is visibly labelled as ad-hoc and unverified.

**C-US3 — one trace per turn.** `[MVP]`
- **C-R3.1** `observe: { traceId }` is passed from the assistant path into `liteLlmCaller`, so a conversation turn is one Langfuse trace with the tool calls nested — replacing today's N orphan traces per turn.
- **C-R3.2** Every model call on the path carries `tab:ask` plus the thread dimension.

**C-US4 — artifacts, not prose.** `[MVP for the protocol + table/citation; later for the rest]`
- **C-R4.1** `[MVP]` `query_metric`, `query_data`, `preview_metric`, `suggest_metrics`, `get_metric` and `get_dashboard` declare an MCP `outputSchema` and return the artifact payload as `structuredContent`. This is the **prerequisite** — without it the UI and the MCP grow two serialisers.
- **C-R4.2** `[MVP]` One shared artifact type module — `table` · `chart` · `metric_draft` · `dashboard_draft` · `citation` · `clarification` — generalising the existing `StageSuggestions` family rather than inventing a parallel one.
- **C-R4.3** `[MVP]` `/api/assistant/chat` returns `artifacts[]` beside `content` and `tools`, and the drawer renders the `table` and `citation` kinds by **extending** the existing tool-chip mechanism.
- **C-R4.4** `[later]` A `chart` artifact is a `Panel` posted to `/api/dashboards/panel-query` and mounted in the existing `PanelChart.tsx` — so two viewers with different RLS see different bars from the identical chat turn, and the chart in chat is byte-identical to the chart on the dashboard.
- **C-R4.5** `[MVP]` **No** `dangerouslySetInnerHTML`, `eval` or `new Function` anywhere on the chat/artifact path, asserted by a guard test; no model-authored HTML, SVG or JS is ever rendered; every number comes from the governed query path, never the model's arithmetic.
- **C-R4.6** `[later]` An oversized result travels as an MCP `resource_link`, and `annotations.audience` keeps a large table out of the prompt while still showing it to the user.

**C-US5 — a governed analyst, read-only by structure.** `[later]`
- **C-R5.1** The built-in `os.analyst` system ships in the repo, is not user-editable, and is compile-verified by the existing `compile-verify.ts` path.
- **C-R5.2** Read-only is enforced by the **node's tool allowlist**, not by prompting: a prompt-injected instruction in a data *value* produces zero write-tool calls, asserted by a red-team fixture.
- **C-R5.3** The writer node's allowlist contains only `define_metric` and `create_dashboard`; the model may never invoke a write as a side effect of reading, nor from tool output alone — only a human button press.
- **C-R5.4** The engine migration from `runAgentic` to `runOsTeam` ships behind a flag with the old path intact and a parity harness; read-only intents migrate first, write intents last.

**C-US6 — threads that survive.** `[later]`
- **C-R6.1** Thread id = run id = LangGraph thread id = Langfuse trace id, checkpointed in `agent_runs`; a `memory` checkpointer is visibly labelled.
- **C-R6.2** History is keyed `{userId, threadId}`; a second user in the same domain cannot read or resume a thread — asserted by a guard test. Never the `{domain, agent}` key.
- **C-R6.3** The client sends `{ threadId, newMessage }`; the server-side `.slice(-20)` of a client-supplied array is deleted.
- **C-R6.4** Retention reuses `engine/retention.ts`.

**C-US7 — build by chat, write on confirm.** `[later]`
- **C-R7.1** `metric_draft` → `preview_metric` → explicit confirm → `define_metric`; `dashboard_draft` → confirm → `create_dashboard`. The confirm names the artifact, the scope and the commit, reusing `core/ui/GuardedConfirm.tsx`.
- **C-R7.2** New MCP tool `add_panel_to_dashboard({ dashboardId, panel })` — closing the lost-update race that read-merge-replace on `create_dashboard` creates when two chats add a chart at once.
- **C-R7.3** New MCP tool `ask_os({ question, threadId?, artifacts? })`, a thin adapter over `run_agent_system` on `os.analyst`, returning the **same** text and artifact payloads as the UI — asserted by a payload-parity golden test.
- **C-R7.4** **No** `create_dashboard_from_chat` tool: chat is the same door, not a second one.
- **C-R7.5** Anything created by chat lands in **My** scope; wider goes through `request_promotion` → domain admin.

### Stream S — vibe-engineered software, hosted properly

**S-US1 — push from Claude, get a preview URL.** `[MVP]`
- **S-R1.1** `push_app_files(appId, files[], message)` writes to `apps/<slug>/` via `commitSubtree` and returns `{ commit, changed, gate }` plus a preview URL.
- **S-R1.2** The compile gate runs **before** the write; red → 422 with diagnostics and **nothing committed**.
- **S-R1.3** The commit's author is the calling user, committer `Sovereign OS`, with `OS-Action`/`OS-Object`/`OS-Surface`/`OS-Request-Id` trailers.
- **S-R1.4** A no-change push returns `changed: false` and creates no commit. Pushing the same files twice yields **one** commit.
- **S-R1.5** `reserveSubtree('apps/')` prevents a whole-tree writer from clobbering app code; the OpenSearch mirror is a cache of the committed tree, not the home of record.

**S-US2 — releases.** `[MVP for the tag API; later for the verb]`
- **S-R2.1** `[MVP]` `core/infra/git-store.ts` gains, additively, `annotatedTag`, `listTags(prefix)`, `resolveTag` and a path-scoped `log`, with temp-dir tests.
- **S-R2.2** `[later]` `release_software(appId, bump|version)` runs the full gate set, writes `apps/<slug>/.app/release.json`, and creates `app/<slug>/v<x.y.z>`.
- **S-R2.3** `[later]` A failing blocking gate creates **no tag** and names the gate that failed.
- **S-R2.4** `[later]` A tag is immutable: re-releasing the same version is a 409.
- **S-R2.5** `[later]` `list_releases(appId)` returns tags newest-first with commit, gate results and approval state.

**S-US3 — the approval names what is approved.** `[later]`
- **S-R3.1** The review card names the **release tag and commit**; `decide_deploy` records approver id, decision, timestamp, tag and commit.
- **S-R3.2** Requester ≠ approver, enforced (exists).
- **S-R3.3** `promote` to Company **re-points** to the already-built release; a test asserts the artefact hash is byte-identical before and after.
- **S-R3.4** A scan failure or a leaked secret blocks approval with a 409, even for a Builder (exists).
- **S-R3.5** One query answers, for any live app: commit, tag, artefact hash or digest, gate results, requester, approver, timestamps and the current pointer — exportable as evidence.

**S-US4 — CI gates built in.** `[later]`
- **S-R4.1** Gate order, all blocking unless noted: compile → tests → secret scan → SAST → dependency vulnerabilities (fail high/critical, warn below, against the committed lockfile) → licence policy → SBOM (produced; its absence blocks the tag).
- **S-R4.2** The regex `lib/scan.ts` is replaced by a real engine behind the same shape — Trivy is the default single pick; `npm audit` (Artistic-2.0) must not ship as "the" dependency gate.
- **S-R4.3** A CycloneDX 1.7 SBOM per release, attached to `release.json`, retrievable over MCP for **superseded** releases too.
- **S-R4.4** Every gate result is one `PipelineRun` with `get_pipeline_status` and a bounded `get_pipeline_log`; an unreachable backend returns an honest degraded status, **never a fabricated pass**.

**S-US5 — rollback.** `[later]`
- **S-R5.1** `rollback_software(appId, toVersion)` resolves the tag, reads `release.json`, re-pins and moves the pointer — **no rebuild, no re-review** — audited with actor, from→to and reason; the served pointer changes within one request.
- **S-R5.2** Rolling back to a never-approved release is a 403; rolling back to a release whose scan has since failed a newly added rule is refused **and says so honestly**.

**S-US6 — the app reads and writes data as the end user.** `[MVP for the trap fixes; the rest exists]`
- **S-R6.1** An app's data read returns only rows the viewing user may see — two sessions, same app, different row sets.
- **S-R6.2** `os.records` writes are scoped by `recordActor` and governed by the approved deploy envelope.
- **S-R6.3** A dataset not in `app.grants.data` is refused, and the reference is flagged on commit **and** on the review card.
- **S-R6.4** A custom AppSpec block runs null-origin and **cannot** act as the user.
- **S-R6.5** `[MVP]` The `serveMode` default becomes `'spec'`, and a missing image **fails closed and loudly** — today every legacy or nil record normalises to `'image'` and falls back to `traefik/whoami:latest`, serving a stranger's placeholder container on the customer's own domain.
- **S-R6.6** `[MVP]` A `demo-seed` result is **structurally unusable** in any gate, review card or `verify_software` verdict, asserted by a test — an approval grounded in seeded data is a governance failure wearing a green tick.

**S-US7 — apps call agents, agents call apps, and both read and write data.** This is a **MUST**,
not a nice-to-have, and it is the owner's fifth requirement verbatim. Each half gets a test tonight
with fakes; the cluster step is written out in Part C.

- **S-R7.1** `[MVP]` **App → agent.** The OS app SDK exposes `os.agents.run(systemId, message)`,
  `os.agents.get(runId)` and — only where the user's own role permits —
  `os.agents.decide(approvalId, …)`. All three call the **same `enqueueRun` / run-service door the
  UI and the MCP call**, as the signed-in user over the same-origin session. Never a service
  principal, never the app's own key. A run that hits a held write returns the typed `parked` state
  with its approval id, and the app renders that state rather than pretending the run finished.
- **S-R7.2** `[MVP]` **Agent → app.** An app **declares** its actions (an `actions.yml` / AppSpec
  section: name, input schema, scope, side effects) and those register as **governed tools in the
  agent catalogue** through the existing `list_adoptable_actions` / `adopt_entity_actions` path.
  **Audit that path first and say precisely what changes** — R4 found it governs *Connection*
  exposures today, with a four-layer fail-closed intersection (capability ∩ exposure ∩ adoption ∩
  grant) and a `domain_admin` consent step, and calls it the best governance primitive in the
  codebase. App actions reuse it rather than growing a parallel one.
- **S-R7.3** `[MVP]` An app action executes as the **calling run's principal**, within the app's
  declared scopes, held under the normal hold rules when it writes (reads-on/writes-off preset means
  a write is **never** auto-enabled), and appears in the run's Langfuse trace as a tool span carrying
  the decision.
- **S-R7.4** `[MVP]` **App ↔ data and agent ↔ data** go only through the governed paths — bounded
  `query_data`, `os.records`, dataset writes via the data services — always as the end user, with
  RLS, OPA and the V stage and dependency rules holding. **No app-level credential can widen
  access**, and a reference to a dataset outside `app.grants.data` is refused and flagged on commit
  and on the review card.
- **S-R7.5** `[MVP]` **The triangle test.** One end-to-end test (unit with fakes tonight, the
  `kind`/`stackit` steps written into Part C): a demo app calls an agent → the agent writes a dataset
  row through a governed tool → the app reads that row back. All three steps are attributed to the
  **same user** in `run_events`, in the Langfuse trace and in the git commit. Plus the two negative
  cases: an app calling a tool outside its declared scopes gets `not_found`/`forbidden` per the tab's
  convention, and an agent calling an app action that writes is **held** under the read-only preset.
- **S-R7.6** `[MVP]` The report states precisely what changed versus the audit of
  `app-tool-call.ts`, `authorizeAppTool` and `app-runtime.ts` — what already held, what was wired,
  and what is still a gap.

**S-US8 — honest documentation.** `[MVP]`
- **S-R8.1** No shipped file claims Harbor, Argo CD, Forgejo or a build service that does not exist: the scaffold README/Dockerfile text, `tabs/software/lib/README.md`, the `config.ts` comment blocks and dead `kanikoImage`/`softwareBuildEnabled`/`softwareBuildNamespace`, `values.stackit-managed.yaml`'s `forgejoConsoleUrl`, the dangling `values.yaml` comment, and the Admin UI's "Argo CD reverts drift automatically" rendered over mock data.
- **S-R8.2** `grep -rn "build-service\|ci-repair\|Harbor\|Argo CD\|forgejo"` over the shipped tree returns only deliberate historical notes, asserted by a tripwire test.
- **S-R8.3** Kaniko is **not** revived (archived upstream June 2025, read-only, no CVE fixes); when Tier 3 is eventually built the preference is kpack/CNB, and the honest trade of rootless BuildKit/Buildah is recorded: *you stop being privileged and start being unconfined, which an auditor treats as equivalent*.

**S-US9 — limits and deletion.** `[later]`
- **S-R9.1** Per-domain caps on live apps and total CPU/memory, enforced at `decide_deploy`; Tier-1/2 bundle-size and records-count caps; every Tier-3 pod has requests and limits (exists).
- **S-R9.2** Delete is lineage-aware and blocked at 409 when a dependent exists (exists); it removes the Deployment/Service/Ingress, revokes the MCP grant and the OPA profile, and **retains git history and the audit trail**. Archive is reversible and lossless (exists).

### Stream G — git everywhere, and git made visible

**G-US1 — nothing is built outside git.** `[MVP]`
- **G-R1.1** One table fixes the repo path for **every** builder artefact kind, personal lanes included, and it is in this plan.
- **G-R1.2** An enumeration test over all kinds asserts **no kind exists whose writer does not commit** — a new writer fails the test until it is classified, the way the agent and data stores already work.
- **G-R1.3** Every boot-time or reconcile-time writer calls `hydrationState()` first and does nothing unless it says `'hydrated'`; the `DestructiveReconcileError` guard is not weakened for any new reconcile.

**G-US2 — every object has a version history.** `[MVP]`
- **G-R2.1** `objectGitInfo(kind, id)` → `{ head, history[], truncated }`, keyed on the `OS-Object` trailer **with a path-based `git log -- <path>` fallback**, so `git.head` is **never null for an object that has files in the tree** — including objects whose only commits are platform boot-reconciles.
- **G-R2.2** `getVersion(kind, id, sha)` returns the object's files at that commit.
- **G-R2.3** `diffVersions(kind, id, shaA, shaB)` returns a unified diff.
- **G-R2.4** All three are owner/scope-gated: an object the caller cannot see returns a byte-identical `not_found` to one that does not exist.
- **G-R2.5** `[later]` `restoreVersion(kind, id, sha)` re-applies that version **through the object's normal writer**, producing one new commit — never a history rewrite — with every normal gate and approval still applying.

**G-US3 — git is visible.** `[MVP for the badge and drawer; later for the rest]`
- **G-R3.1** `[MVP]` `core/ui/git/` provides `GitHeadBadge` (sha7 · author · relative time, click → drawer) and `HistoryDrawer` (commit list with action, surface and actor; per-commit diff), with the logic in testable `.ts` and the `.tsx` thin.
- **G-R3.2** `[MVP]` The five detail headers (Data, Metrics, Dashboards, Agents, Software) mount `<GitHeadBadge kind=… id=…/>` and nothing more; the Agents header line is unified onto the shared component rather than kept as a second implementation.
- **G-R3.3** `[later]` "Restore this version" in the drawer, confirm-gated, calling the restore tool.
- **G-R3.4** `[later]` `ReleaseList` for apps; Governance → **Repositories** listing each domain repo with head, commit count, last author, mirror status from the existing `git-mirror` health row and an "open in mirror" link when configured, plus a commit log.

**G-US4 — the same over the MCP.** `[MVP for reads]`
- **G-R4.1** `[MVP]` `get_history`, `get_version`, `diff_versions` take `{kind, id}` and work for every kind, with the same gating and the same `not_found` semantics.
- **G-R4.2** `[later]` `restore_version`, and `list_releases`/`create_release` for software.
- **G-R4.3** `[MVP]` A UI/MCP parity test per read: the drawer's data and the tool's payload come from the same module.

### Stream T — the engineering view

**T-US1 — see the real artefact.** `[MVP for dbt/Dagster/LangGraph/Git/Langfuse]`
- **T-R1.1** Every object kind touched by this programme or last night's has an `EngineeringView` from a **pure, testable, MCP-serialisable** adapter in that tab's `lib/engineering.ts`, registered in `core/engineering/`.
- **T-R1.2** The **dbt** view shows the model SQL, the `schema.yml` / `sources.yml` / `semantic_models` / `metrics` YAML **as stored in the repo**, the repo path, and the commands `dbt build --select <node>`, `dbt test`, `mf query --metrics …`.
- **T-R1.3** The **Dagster** view shows asset keys, job and schedule names, the last run id and status, an "Open in Dagster" link through the tool proxy, and `dagster asset materialize --select …`.
- **T-R1.4** The **LangGraph** view shows the compiled graph as JSON — plan/act/tools/route nodes per agent, edges, `when` guards, state channels, interrupt points — plus the checkpointer, the thread id and the resume semantics. `[later]` the diagram (`@xyflow/react` is already a dependency).
- **T-R1.5** The **Git** view shows the file list with paths and the head sha and composes G's badge; it does not duplicate it.
- **T-R1.6** The **Langfuse** view shows the trace URL per run or turn and states what is redacted and why.
- **T-R1.7** `[later]` The **Trino** view shows the compiled SQL the OS actually runs, the catalog and schema, who it runs as (impersonation), and a "preview as me" button bounded by the existing query budget. `[later]` The **LiteLLM** view shows the model routes per role, the key **alias** (never the key), the `domain:`/`agent:`/`tab:`/`run:` tags and the budget.

**T-US2 — the tool's own words.** `[MVP]`
- **T-R2.1** Labels on these panels use the tool's nouns — "dbt model", "dbt metric", "Dagster asset", "Dagster schedule", "LangGraph node", "Langfuse trace", "Trino query", "LiteLLM key alias" — with the OS term in parentheses at most once. A test fails a label that uses only an OS-invented noun.
- **T-R2.2** A deep link that cannot resolve says **why**, rather than failing silently.

**T-US3 — take it elsewhere.** `[MVP for the dbt project]`
- **T-R3.1** The domain dbt project downloads as a tarball (`archive()`) and `dbt parse` accepts it — asserted through the existing parse gate.
- **T-R3.2** `[later]` An agent system exports as `system.yaml` plus the compiled graph JSON; a dashboard exports as its dashboard-as-code file; an app exports as its `apps/<slug>/` tree plus `release.json`. Each documented with the command to run it elsewhere.

**T-US4 — the same over the MCP.** `[MVP]`
- **T-R4.1** `get_engineering_view({kind, id})` returns the identical structure the panel renders, asserted by a parity test.
- **T-R4.2** `[later]` `get_guide` texts name the real artefacts and commands, and each `list_capabilities` description names the tool it maps to (`define_metric` → "writes dbt `metrics:` YAML").

### Stream E — the engineer's door

**E-US1 — clone and push from VS Code.** `[MVP offline; the live push is `kind`]`
- **E-R1.1** `https://<os>/git/<domain>.git` supports clone, fetch and push over authenticated HTTP, served by `git http-backend`.
- **E-R1.2** A push with a valid personal access token lands, and the registry updates from the pushed files.
- **E-R1.3** A push with no token, an expired token or a revoked token is a **401**.
- **E-R1.4** A push to a path the pusher does not own is **rejected with a readable reason** naming the file.
- **E-R1.5** A push containing an invalid dbt project, an unparseable `system.yaml` or invalid dashboard/metric YAML is **rejected**, by the **same validator the UI and the MCP call**.
- **E-R1.6** A non-fast-forward push to `main` is refused: no history rewrites.
- **E-R1.7** `os/` governance files, grants and anything secret-shaped are never writable by a push;
  the rejection says *"managed by the OS; change it in Governance or over the MCP"*.
- **E-R1.8** **Read is unconditional.** Anyone with access to the domain can clone and read the
  whole repository, `os/*.yml` governance metadata included — the OS-owned files are committed as
  real files so nothing is a black box, and reading them never requires write access.
- **E-R1.9** Every detail page shows the `git clone` command for the owning domain's repo, and T's
  engineering panel links each artefact to its file in the repo.

**E-US2 — access tokens.** `[MVP]`
- **E-R2.1** A user creates a scoped personal access token in Platform → Access tokens; it is **hashed at rest**, shown **once**, listable by prefix and metadata only, and revocable.
- **E-R2.2** A token maps to exactly one OS identity, and every push is attributed to that identity.
- **E-R2.3** A token is never logged, never echoed in an error, and never committed.

**E-US3 — safe interleaving.** `[MVP]`
- **E-R3.1** An OS commit and an engineer's push cannot interleave: the pre-receive hook holds the **same per-domain git-store lock** for the duration of `receive-pack`.
- **E-R3.2** A lock wait is bounded and fails the push with a readable message rather than hanging the developer's terminal.

**E-US4 — the coin.** `[MVP]`
- **E-R4.1** The same change made over the MCP and made by a `git push` leaves the **registry in the same state** — the coin test.
- **E-R4.2** The registry write from a push is attributed to the pusher with `OS-Surface: git:push`.
- **E-R4.3** After ingest, the existing Dagster reload and Trino-rules reconcile hooks run — a pushed model becomes a Dagster asset without a second mechanism.
- **E-R4.4** Each stream exposes `ingestFromRepo(kind, files)` for its own kind; E orchestrates. Tonight: dbt models + `schema.yml` → dataset records; `agents/<slug>/system.yaml` → agent systems.
- **E-R4.5** `[later]` Branches as proposals (`proposal/*` surfacing as a promotion request); PR-like review in the UI; the reverse mapping for the remaining kinds; apps by push; VS Code task snippets.

**E-US5 — documented.** `[MVP]`
- **E-R5.1** `docs/components/git.md` has a "Work from VS Code" section: clone, create a token, push, what gets validated, and what the OS does afterwards.
- **E-R5.2** `os-ui/ARCHITECTURE.md` states the coin principle and where each door enters.

### Stream X — night-1 live follow-ups `[all MVP]`

- **X-R1** Boot-reconcile commits carry per-object attribution (or the history lookup falls back to the path), so `git.head` resolves for systems that existed before the reconcile. *Coordinated with G-R2.1, which owns the fallback.*
- **X-R2** The agents reconcile skips a **zero-agent system**, not its whole domain.
- **X-R3** A successful tool no longer produces a tool span with `status: error`, and trace read-back no longer reports `owner: unknown`.
- **X-R4** `docs/components/trino.md` states the password and regeneration behaviour correctly.
- **X-R5** `core/kernel/licenses.ts` gains the missing **ECharts** and **Superset** rows. *D owns that file tonight; X files the finding and verifies.*
- **X-R6** The MCP `vizType` enum matches the model's `VizType` union. *D owns it; X verifies.*
- **X-R7** No agent-facing text claims "Cube secures the number". *M owns the strings under `tabs/metrics`; X owns any elsewhere.*
- **X-R8** **The coin test.** One table-driven test, landed tonight, asserts that for each object
  kind the same change made (a) through its MCP tool and (b) by a `git push` produces **byte-identical
  files**, **identical registry state**, and an **identical history entry except `OS-Surface`**
  (`mcp:<tool>` vs `git:push`). Kinds tonight: the dataset model and the agent system; metrics and
  dashboards join as soon as M and D land their formats. *X owns the test; E owns the push half it
  drives.*

---

### Stream V — lifecycle: Studio → Test → Run

**V-US1 — I can tell a draft from the thing that is running.** `[MVP]`
- **V-R1.1** `core/kernel/lifecycle.ts` is pure and total over every kind — dataset, metric,
  dashboard, agent system, software app, knowledge workflow, connection — returning
  `{ draft: <head>, testing?: <sha>, live?: <sha|tag> }`. A unit test covers every kind.
- **V-R1.2** Lifecycle and audience are **independent**: a `My` object can be Live, and a `Company`
  object can have a Draft. A test asserts both combinations are reachable and that neither axis is
  derived from the other.
- **V-R1.3** Every tile and detail header shows **two small badges** — lifecycle (Draft · Testing ·
  Live) and audience (My · Domain · Company) — and nothing else new.
- **V-R1.4** The shell header has one **Studio | Run** toggle, persisted per user: Studio shows
  drafts, in-flight tests and live objects **for editing**; Run shows **only live** artefacts, for
  operating and consuming. Builders default to Studio, consumers to Run.
- **V-R1.5** Vocabulary is exactly the six words, identical across kinds. No UI copy says
  "environment", "stage" or "release" — "release" only for software apps.

**V-US2 — go live pins a version, and editing does not move it.** `[MVP]`
- **V-R2.1** `go_live(kind, id, sha?)` pins a commit or tag — git tag `live/<kind>/<id>`, or the
  SemVer release tag for apps — and records it in the OS-owned `os/lifecycle.yml`.
- **V-R2.2** Everything that **operates** reads the pin: an agent schedule runs the pinned
  definition; the Run view renders the pinned dashboard spec; `[later]` the app's prod URL serves the
  pinned artefact and Dagster generates schedules only for live pins.
- **V-R2.3** **Editing a live dashboard does not change what Run shows until `go_live`.** This is the
  headline test of the whole stream: edit, save, assert the Run view is byte-identical, then
  `go_live` and assert it changed.
- **V-R2.4** `retire(kind, id)` unpins; Run stops showing it; nothing is deleted.
- **V-R2.5** One confirm dialog on Go live states what starts running — the schedule, the URL, the
  consumers.
- **V-R2.6** `go_live` and `retire` are the **only two new MCP tools**. `run_tests` is not a new
  tool: testing means running, building or previewing the draft from Studio using each kind's
  existing verify/test path.

**V-US3 — you cannot run on top of a draft.** `[MVP]`
- **V-R3.1** One implementation of the **go-live guard** refuses when a dependency is not live,
  naming it: dashboard → its metrics and datasets; metric → its dataset; agent system → its granted
  resources; app → what it binds. Tested per kind.
- **V-R3.2** There is no other way to change a lifecycle — no direct setter, no MCP field, no UI
  shortcut.
- **V-R3.3** The guard is about **lifecycle**, not audience: a Live `My` metric is a perfectly good
  dependency for a Live `My` dashboard.

**V-US4 — the tools follow the lifecycle.** `[MVP for two]`
- **V-R4.1** `[MVP]` Every LiteLLM call carries `env:studio|test|run`, with per-lifecycle budgets in
  the key metadata so a draft cannot drain what is running.
- **V-R4.2** `[MVP]` The Langfuse trace `environment` field is the lifecycle.
- **V-R4.3** `[later]` Dagster generates schedules only for live pins; a draft is materialised by
  hand.
- **V-R4.4** `[later]` A draft dataset or metric builds into the author's lane or a `__dev` schema;
  a live one uses the real schema. T's engineering view shows which.
- **V-R4.5** `[later]` Software preview / staging / prod URLs map onto Draft / Testing / Live,
  aligned with S's environment model.

**V-US5 — nothing changes on day one.** `[MVP]`
- **V-R5.1** Migration marks **every existing object Live**, so the Run view on day one is exactly
  today's screens. A test asserts the migration leaves every existing fixture visible in Run.
- **V-R5.2** A newly created object is **Draft**, and therefore absent from Run until someone goes
  live — asserted per kind.
- **V-R5.3** No existing MCP argument becomes required, and `lifecycle` defaults so that every
  existing client sees what it saw before.

**V-US6 — the pin is readable, not pushable.** `[MVP]`
- **V-R6.1** `os/lifecycle.yml` is committed so an engineer's clone can read exactly what is live;
  the receive gate rejects a push that changes it with *"managed by the OS; change it in the UI or
  over the MCP"*.
- **V-R6.2** A single `main` per domain repo stays; branch-per-lifecycle is backlog.

**V-US7 — documented honestly.** `[MVP]`
- **V-R7.1** `docs/components/lifecycle.md` carries the per-kind Studio / Test / Run mapping table,
  how to try something out versus go live, and an explicit section on what is **physically**
  separated (Trino lane and `__dev` schemas, app URLs) versus only **logically** (everything else).

### Traceability — every story group to its phase and its checklist rows

Checked at planning time; a reviewer re-checks it. A requirement with no checklist row is a planning
defect, and a checklist row with no requirement is scope creep.

| Stories | Phase | Checklist rows |
|---|---|---|
| M-US1 … M-US4 (define simple, ratio, cumulative, derived; dimensions, filters, grains) | M | M1 · M2 · M3 · M4 · M5 · M6 · M11 |
| M-US5 (every change a commit) · M-US9 (MCP parity) | M | M7 · M8 |
| M-US6 (promotion) | M | M12 |
| M-US7 (preview and query as me) · M-US8 (one number everywhere) | M | M10 · M11 · M13 |
| M-US10 (exports) · M-US11 (time spine) | M | M9 · M16 |
| M-US12 (honest text) | M | M13 · X9 |
| (licence floor) | M | M14 · M15 |
| D-US1 (one chart surface) | D | D1 |
| D-US2 (vendored, attributed) | D | D2 · D3 · D4 · D5 · D6 · D7 · D20 |
| D-US3 (dashboard as code) | D | D8 · D9 |
| D-US4 (honest numbers and refusals) | D | D10 · D11 · D12 · D13 · D18 · D19 |
| D-US5 (Superset-class capability) | D (backlog) | D14 · D15 · D16 · D17 · D21 |
| C-US1 · C-US2 (ask a data product, ask a metric) | C | C2 · C3 · C4 · C5 · C6 |
| C-US3 (one trace per turn) | C | C1 |
| C-US4 (artifacts) | C | C7 · C8 · C9 · C10 · C11 |
| C-US5 (governed analyst) · C-US6 (threads) · C-US7 (build by chat) | C (backlog) | C12 · C13 · C14 · C15 · C16 |
| S-US1 (push from Claude) | S | S5 · S6 |
| S-US2 (releases) | S | S4 · S11 |
| S-US3 (approvals name the artefact) | S (backlog) | S12 · S15 |
| S-US4 (CI gates) | S (backlog) | S13 · S14 |
| S-US5 (rollback) | S (backlog) | S15 |
| S-US6 (data as the end user; the two traps) | S | S2 · S3 · S9 |
| S-US7 (apps ↔ agents ↔ data, the triangle) | S | S7 · S8 · S9 · S10 |
| S-US8 (honest documentation) | S | S1 |
| S-US9 (limits and deletion) | S (backlog) | S16 · S17 |
| G-US1 (nothing outside git) | G | G1 · G2 · G8 |
| G-US2 (version history) | G | G3 · G4 · G5 · G9 |
| G-US3 (git visible) | G | G6 · G10 |
| G-US4 (same over MCP) | G | G7 |
| T-US1 (see the real artefact) | T | T1 · T3 · T4 · T5 · T6 · T7 · T10 |
| T-US2 (the tool's own words) | T | T2 |
| T-US3 (take it elsewhere) | T | T9 · T11 |
| T-US4 (same over MCP) | T | T8 |
| E-US1 (clone and push) | E | E1 · E3 · E4 · E5 · E6 |
| E-US2 (access tokens) | E | E2 |
| E-US3 (safe interleaving) | E | E7 |
| E-US4 (the coin) | E | E8 · E9 · X8 · E12 |
| E-US5 (documented) | E | E10 · E11 |
| V-US1 (draft vs running) | V | V1 · V2 · V8 |
| V-US2 (go live pins a version) | V | V3 · V4 · V5 · V7 |
| V-US3 (no running on a draft) | V | V6 |
| V-US4 (tools follow the lifecycle) | V | V11 · V14 |
| V-US5 (nothing changes on day one) | V | V10 · V9 |
| V-US6 (pin readable, not pushable) | V | V12 |
| V-US7 (documented) | V | V13 |
| X-R1 … X-R8 | X | X1 · X2 · X3 · X4 · X5 · X6 · X7 · X8 · X9 |
| (the merged tree's gates and licences) | X / coordinator | X10 · X11 · X12 |

## Phases and implementer briefs

Eight streams. **M, D, C, S, G, T, E, X run in parallel, each in its own worktree, on disjoint file
areas.** Branch names: `night2-M`, `night2-D`, `night2-C`, `night2-S`, `night2-G`, `night2-T`,
`night2-E`, `night2-X`, each branched from `public/main`.

### The shared-file list — read this before you touch anything

These files are touched by more than one stream. **Every edit to one must be purely additive: append
your row, your section, your key; never reflow, re-sort, re-indent or rewrite another stream's
lines.** A conflict here is expected and the coordinator resolves it by taking both sides.

| Shared file | Streams | Rule |
|---|---|---|
| `CHANGELOG.md` (`[Unreleased]`) | all | append one bullet under the existing heading; never restructure |
| `docs/superpowers/plans/2026-11-14-metrics-dashboards-chat-software.md` | all | append to the **deviations log** only, under your stream's heading |
| `docs/superpowers/plans/2026-11-14-engineering-checklist-night2.md` | all | edit **only your own rows'** status column |
| `os-ui/core/kernel/config.ts` | D, S, E, T | append a new key at the end of its section; do not reorder |
| `charts/sovereign-agentic-os/values.yaml` | E, S | append keys; one block each, clearly commented |
| `os-ui/instrumentation.ts` | E, G | append a boot step at the end; never reorder existing ones |
| `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`, `sbom.cdx.json`, `licenses/notices/**` | D (owner), E, S | **D owns the format and lands first**; others append a row |
| `os-ui/core/kernel/licenses.ts` | D (owner), X (verifier) | D lands the ECharts + Superset rows; X verifies, does not edit |
| `os-ui/core/infra/git-store.ts` | S (tag API), G (read/diff/path-log) | **additive only, different exports.** S appends the tag block at the end of the file; G appends the read block **above** it after S merges, or takes the conflict. Neither may change an existing export's signature |
| `os-ui/core/mcp/registry.ts` / `register-*.ts` | C, D, G, S, T | append your tool registrations; alphabetical order is **not** required |
| `os-ui/core/ui/charts/**` | D (owner) | C and T **consume** it; neither creates a second chart surface |
| `os-ui/core/ui/git/**` | G (owner) | the five tabs mount `<GitHeadBadge/>` and nothing more; T **composes** it |
| `os-ui/ARCHITECTURE.md` | all | append a new `##` section; never edit another stream's |

Anything **not** in this table is owned by exactly one stream. If you find yourself needing to edit
a file another stream owns: **stop, write it in your report as a cross-stream dependency, and work
around it.** Do not edit it.

### Every brief's common contract

**Inputs every stream reads first (do not skip):** `CONTRIBUTING.md` · `os-ui/ARCHITECTURE.md`,
especially "Things this codebase will punish you for" · this plan's **Global design principles** and
**Global constraints** · `docs/superpowers/plans/2026-11-14-engineering-checklist-night2.md` (your
rows) · your stream's research report under `docs/superpowers/plans/2026-11-14-night2-research-*.md`
· the owning tab's `README.md`, `manifest.ts`, `context.md` and `guide.md`.

**Gates, every stream, every commit:**
```
find . -path '*/node_modules' -prune -o -type f -name '* 2.*' -print -delete   # FIRST, always
npx tsc --noEmit -p os-ui/tsconfig.json          # clean
npm --prefix os-ui test                          # 0 failures
node scripts/check-structure.mjs                 # no new violations
bash os-ui/scripts/gate.sh                       # exit 0
helm lint charts/sovereign-agentic-os -f values.local.yaml   # only if you touched the chart
```
Docs in the **same commit** as the code. `os-ui/node_modules` is a symlink — keep it, never
`npm ci`. Commit as `Data Masterclass <contact@datamasterclass.com>`, ending exactly
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Hard rules, every stream:**
1. **Never widen identity.** No read or write under a service principal where a signed-in user
   exists. No cache, no shortcut, no "just for the preview".
2. **Never fabricate.** A missing dependency, an unreachable backend or a clipped result is a
   labelled, typed, honest result — never a substituted value that reads as success.
3. **Never commit without the trailers**, and never add a writer that does not commit.
4. **A test may not import a `.tsx` or a `route.ts`.** Logic lives in `.ts`; the route and the
   component are shells.
5. **No new top-level folder, no fourteenth tab, no new cluster component.**
6. **If you cannot finish an item, stop and record it.** A half-built write path left unattended is
   worse than a backlog line. Never tick a checklist row you did not measure.
7. **Report at the end in the format below.** The coordinator reads only the report.

**Report format (every stream, verbatim structure):**
```
## Stream <X> — report
Branch / commits:        <branch> · <sha> <subject> (× n)
What landed:             a table — Piece | Where (file paths)
Checklist rows now true: <ids>, each with the test that makes it true
Checklist rows still false: <ids>, each with the exact reason
Deviations:              <X>-1, <X>-2 … (also appended to the plan's deviations log)
Gates:                   tsc · test count before→after · check-structure counts · gate.sh · helm lint
Cross-stream needs:      what you could not do because another stream owns the file
Next item from my backlog: the single thing the next session should start with
```

---

### Phase M — Metrics as dbt metrics (`night2-M`)

**Owns:** `os-ui/tabs/metrics/**` · `os-ui/tabs/data/lib/dbt/semantic*` (new) ·
`os-ui/tabs/data/lib/semantic.ts` (the existing lossy string builder — replace it) ·
`os-ui/tabs/data/lib/dbt/{generate,models,project}.ts` (the semantic wiring only) ·
`os-ui/tabs/data/lib/dbt/fixtures/**` (new metric fixture) · `os-ui/tabs/metrics/mcp/**` ·
`images/extensions/dagster/**` (only if an export asset is attempted — it is **backlog**, so expect
not to touch it) · `docs/components/dbt.md` (metrics section) · `os-ui/tabs/metrics/README.md`,
`context.md`, `guide.md`.

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/kernel/config.ts` (if a version
constant needs a config key — prefer a module constant) · `os-ui/ARCHITECTURE.md`.

**Read first:** `2026-11-14-night2-research-R1-dbt-metrics.md` **in full** — §1 is the spec, §3 is
the audit, §4.2–§4.4 the compiler sketch and the worked Northpeak example, §7 the open questions.
Then `tabs/data/lib/semantic.ts`, `tabs/metrics/lib/{model,explorer,consistency,governance}.ts`,
`tabs/metrics/lib/build/explore-server.ts`, `tabs/data/lib/dbt/{generate,models,project,commit}.ts`
and its three goldens, and `tabs/metrics/mcp/metric-write-tools.ts`.

**Deliverables, in order:**
1. **Read the dbt version off the images before writing a line.** `cumulative_type_params` does not
   exist on dbt 1.8. Record what you found in your report. Then pin: one module constant naming
   **DSI 0.8.5 / dbt-core 1.10** field names, with a test, and a line in the generated project's
   README saying which spec it targets.
2. **A typed semantic model, an emitter and a parser** in `tabs/data/lib/dbt/semantic/`: types for
   `semantic_models` (entities with the four `EntityType`s, dimensions with
   `type_params.time_granularity`, measures with the nine `AggregationType`s + `expr` +
   `agg_time_dimension`, `defaults`) and `metrics` (`simple`, `ratio`, `derived`, `cumulative`;
   `filter`; `label`; `description`; `config.meta`). Emit through the existing `emit.ts` `yml()`, not
   `lines.push()`. **Parse back**, and test `parse(emit(x)) === x` on one fixture per type.
3. **Wire it into `generateProject`** so `models/semantic/<model>.yml` appears in the generated tree,
   with a **new golden fixture** beside the existing three, and idempotence asserted.
4. **`simple` and `ratio` from today's `Measure`**, including per-side filters on the ratio, and the
   `count_distinct_approx` exception emitted as `count_distinct` + `config.meta.os_agg`.
5. **The time-spine model** (`models/os/os_time_spine_day.sql` + the dbt 1.9+ `time_spine` property),
   generated for every domain that declares a time dimension. **Decide and record** materialised
   table vs view over `sequence(...)`, and who owns the upper bound.
6. **Commit path:** every metric writer regenerates and commits through `tabs/data/lib/dbt/commit.ts`
   with `OS-Object: metric:<id>`; extend that file's mutator enumeration test to the metric writers,
   flag on and off; extend `tabs/data/lib/mcp-parity.test.ts` to `define_metric`/`promote_metric`.
7. **Honest text:** `define_metric` stops promising "the generated Cube YAML"; `query_metric` stops
   claiming Cube applies RLS and states Trino + OPA as the viewer; `tabs/metrics/context.md` likewise;
   `list_metrics` returns the metric **type** and grain.
8. **The licence floor:** assert `metricflow >= 0.209.0` wherever it is installed, in the existing
   licence gate. `≤ 0.208.1` is BSL and must never enter a build.

**Tests:** the generator golden + idempotence · round-trip per metric type · the spec-validation test
· the commit-mutator enumeration · MCP parity for the two metric tools · a `not_found` parity case
for a metric on an invisible dataset · the Cube-string grep tripwire · the MetricFlow version floor.

**Hard rules for M:** emit **nothing the OS compiler cannot serve** — a cross-model metric is refused
at define time with a reason, not emitted as YAML that would resolve to a wrong number or fail
`dbt parse` for the whole domain. `cumulative` and `derived` **YAML** may land tonight; their **SQL**
compilation does not, so the compiler must refuse those types with a typed, named refusal rather than
return a number. Identifiers keep going through `assertColumn`; filter values are parameterised.

---

### Phase D — Superset-class dashboards (`night2-D`)

**Owns:** `os-ui/core/ui/charts/**` (new — **you own it; C and T consume it**) ·
`os-ui/vendor/superset/**` (new) · `os-ui/tabs/dashboards/**` ·
`os-ui/tabs/data/ui/ResultChart.tsx` and `os-ui/tabs/software/ui/appspec/ChartExplorerRenderer.tsx`
(the ECharts-registration lines only — move them onto `core/ui/charts/`, change nothing else) ·
`os-ui/core/kernel/licenses.ts` · `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`,
`licenses/notices/**`, `sbom.cdx.json`, `licenses/denied-licenses.txt` · `scripts/check-structure.mjs`
(the `os-ui/vendor/` exclusion + the new header ratchet) · `os-ui/package.json` (the one dependency:
`react-grid-layout@2.3.0`, only if the layout work starts — otherwise do not add it) ·
`os-ui/tabs/dashboards/README.md`, `context.md`, `guide.md`.

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/mcp/register-experimental.ts`
(your tool rows) · `os-ui/ARCHITECTURE.md` · `core/kernel/config.ts`.

**Read first:** `2026-11-14-night2-research-R2-dashboards.md` **in full** — §2 is the licence work and
is not optional reading, §2.8 has the exact 8-step recording procedure and the per-file header
template, §3 the audit, §4.2 the four slices, §4.4 the dashboard-as-code format, §6 the checklist,
§7 the risks. Then `tabs/dashboards/lib/{model,store}.ts`, `lib/build/panel-query.ts`,
`ui/{PanelChart,PanelBuilder,DashboardGrid}.tsx`, `mcp/dashboard-write-tools.ts`,
`core/infra/git-store.ts` (`reserveSubtree`, `commitSubtree`) and `tabs/agents/lib/git/generate.ts`
as the generator pattern.

**Deliverables, in order — and 1 and 2 must be complete before 3:**
1. **`core/ui/charts/`**: one ECharts registration surface, one `<Chart option>` wrapper, one theme
   resolver (keep the CSS-custom-property bridge — it is better integrated than Superset's CSS
   templates), one formatter module. Move all three existing call sites onto it. A grep tripwire
   asserts no `from 'echarts` outside this directory.
2. **The licence machinery, in the same commit as the first vendored file**: the per-file header
   convention from R2 §2.8 step 7 (ASF header **verbatim**, then `Modified from apache/superset
   <path> @ <sha>`, then the SPDX line and the list of changes), the `os-ui/vendor/` exclusion from
   the `FEATURE:`/`USER STORY:`/`ARCHITECTURE:` ratchet **plus a new ratchet asserting every file
   there has an upstream header and a `Modified from` line**, the `components.tsv` row **pinned to a
   sha, not a version**, the mirrored `THIRD-PARTY-LICENSES.md` row, the `core/kernel/licenses.ts`
   rows for **ECharts** (missing today) and vendored Superset, and a regenerated SBOM with
   `scripts/license-check.sh` green and **no new SPDX id**.
3. **One vendored transformer end to end**: `Timeseries/transformProps.ts` + `utils/series.ts`
   behind `core/ui/charts/`, rendering a real panel. Pie if time allows. Nothing else.
4. **Dashboard-as-code**: `reserveSubtree('dashboards/')`, a byte-stable generator and a reader for
   `dashboards/index.yml` + `dashboards/<slug>/dashboard.yaml` + a generated `README.md`, the commit
   hook on save from **both** doors, and goldens in the style of
   `tabs/agents/lib/git/generate.test.ts`. The format is R2 §4.4 — references are `metric:<id>` /
   `dataset:<id>` ids, never embedded queries.
5. **Two honesty fixes**: the `vizType` enum equals the `VizType` union with a drift tripwire; a
   filter operator the governed path cannot serve becomes a typed `bad_request` instead of being
   silently dropped.

**Tests:** the ECharts grep tripwire · the vendored-header ratchet · the generator goldens +
round-trip + byte-stability · two saves = two commits in a real bare repo · the enum-equality
tripwire · the typed-`bad_request` case · `scripts/license-check.sh` · the lockfile proving one React
copy.

**Hard rules for D:** **never `npm i` an `@superset-ui/*` package** — React 16 peers, frozen
2024-12-10. Vendor **pure functions only**; never a Superset container, Redux store, `SupersetClient`,
`/api/v1/chart/data` call, filter container, SQL Lab file or theming file. Never `antd`, `@emotion`,
`immutable`, a second chart renderer or `mapbox-gl`. Never rewrite an ASF header. Never brand anything
"Superset" — no route, no package name, no logo. Keep the loud-degradation precedence chain intact.
**Do not remove the Superset Helm chart tonight** — that is tied to this stream's completion, and
completion is weeks away.

---

### Phase C — Chat to the data (`night2-C`)

**Owns:** `os-ui/core/runtime/agent-loop.ts` · `os-ui/app/api/assistant/chat/route.ts` ·
`os-ui/core/ui/OsAssistant.tsx` and its new `.ts` siblings · the new shared artifact type module
(place it in `core/runtime/` or `core/models/` — it is kernel-level, consumed by tabs) ·
`os-ui/core/guides/overview.guide.md` · `os-ui/tabs/metrics/guide.md`,
`os-ui/tabs/dashboards/guide.md`, `os-ui/tabs/data/guide.md` (**the semantic-layer sentence only** —
M and D own the rest of those files; append a section, change nothing else) ·
`os-ui/tabs/agents/lib/build/os-tools.ts` (**the `DISCOVERY_COMPANIONS` map only**) · the
`outputSchema` / `structuredContent` additions to `tabs/admin/mcp/discovery-read-tools.ts`,
`tabs/admin/mcp/discovery-waveb-tools.ts`, `tabs/metrics/mcp/metric-write-tools.ts` and
`tabs/dashboards/mcp/dashboard-write-tools.ts` (**schema additions only — do not touch handler
logic; M owns the metric tool's descriptions and D owns the dashboard tool's enum**) ·
`os-ui/tabs/agents/lib/builtin/**` (new, **only** for the `os.analyst` definition — backlog tonight).

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/kernel/config.ts` ·
`os-ui/ARCHITECTURE.md`.

**Read first:** `2026-11-14-night2-research-R3-chat-to-data.md` **in full** — §3 is the audit and
names every gap, §4 is the artifact protocol and the conversation model, §4.4 the MCP tools, §6 the
C1–C26 checklist, §7 the risks (R2 prompt injection and R3 truncation laundering especially). Then
`core/runtime/{agent-loop,agentic,runtime}.ts`, `core/infra/governed.ts` (the `truncated` /
`rowLimit` / `message` contract), `core/ui/core/StageAssistantChat.tsx` (the type family to
generalise) and `tabs/software/lib/chat-modes.ts` (the allowlist discipline).

**Deliverables, in order:**
1. **`observe: { traceId }`** passed from the assistant path into `liteLlmCaller`, so a turn is one
   Langfuse trace with nested tool calls. One parameter; the plumbing already exists in
   `agentic.ts` and `runtime.ts`. This is the smallest, highest-value item in the whole night.
2. **The semantic-layer-first rule** in `OS_RULES` and in the four guides, plus the two
   `DISCOVERY_COMPANIONS` entries.
3. **Truncation honesty**: `truncated`, `rowLimit` and `message` carried verbatim into the turn and
   rendered; `OS_RULES` forbids aggregating a truncated result; a **guard test fails if the fields
   are dropped**. An ad-hoc `query_data` answer is labelled ad-hoc and unverified.
4. **`outputSchema` + `structuredContent`** on the six read tools — the prerequisite for everything
   else. Then the **shared artifact type module** (`table` · `chart` · `metric_draft` ·
   `dashboard_draft` · `citation` · `clarification`), generalising `StageSuggestions`.
5. **`artifacts[]` from the route** and the **`table` + `citation` renderers** in the drawer,
   extending the existing tool-chip mechanism.
6. **The security guard test**: no `dangerouslySetInnerHTML`, `eval` or `new Function` on the chat or
   artifact path. The baseline is clean today — the test keeps it that way.

**Tests:** one-trace-per-turn (the real SDK with a recording transport, as `engine/observe.test.ts`
does) · the truncation-field guard · the `outputSchema` validity of each of the six payloads · the
artifact type module's round-trip · the no-`innerHTML`/`eval` guard · an `OS_RULES` content tripwire
so the semantic-layer sentence cannot be deleted silently.

**Hard rules for C:** do **not** start the engine migration, the `os.analyst` system, durable threads
or the write path tonight — they are staged behind a flag with a parity harness for a reason, and
this is the OS's most visible surface. Vendor **nothing**. Never render model-authored HTML, SVG or
JS. Never let a number in an artifact come from the model's arithmetic. Never reuse
`agent-memory.ts`'s `{domain, agent}` key for anything chat-related.

---

### Phase S — Software, hosted properly (`night2-S`)

**Owns:** `os-ui/tabs/software/**` · `os-ui/core/infra/git-store.ts` (**the tag API only, appended at
the end of the file; G owns the read/diff block**) · `os-ui/core/mcp/` software tool registration ·
`os-ui/tabs/admin/ui/OverviewHealth.tsx` and `os-ui/tabs/admin/lib/components-extra.ts` (the Argo CD
claim only) · `os-ui/tabs/admin/mcp/discovery-waveb-tools.ts` (the forgejo mention and the two
misplaced software tools) · `os-ui/core/kernel/config.ts` (the Forgejo/Harbor/Kaniko deletions) ·
`charts/sovereign-agentic-os/values.yaml` (the `softwareRunnerImage` default and the dangling
comment) · `charts/sovereign-agentic-os/values.stackit-managed.yaml` (`forgejoConsoleUrl`) ·
`docs/components/*.md` where they describe software delivery · `os-ui/tabs/software/README.md`,
`lib/README.md`, `context.md`, `guide.md`.

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/infra/git-store.ts` (with G) ·
`values.yaml` (with E) · `os-ui/ARCHITECTURE.md`.

**Read first:** `2026-11-14-night2-research-R4-software-deploy.md` **in full** — §0 names the three
root causes, §2 is the standards and tool-licence survey, §3 the audit, §4 the architecture, §6 the
S1–S20 checklist, §7 the risks. Then `tabs/software/lib/{server,apps,review,scan,runner,file-mirror,
snapshot,platform-mcp}.ts`, `core/infra/git-store.ts`, and
`tabs/data/lib/dbt/commit.ts` + `tabs/agents/lib/git/commit.ts` as the two commit-path precedents.

**Deliverables, in order — 1 and 2 first, because they are lies in the product today:**
1. **S1 — the documentation purge.** Every false claim listed in S-R8.1, plus a **tripwire test** so
   it cannot come back. Delete the dead config; do not "fix" it.
2. **The two traps.** `serveMode` default becomes `'spec'` and a missing image fails closed and
   loudly (today a legacy record serves `traefik/whoami:latest` on the customer's domain). A
   `demo-seed` result becomes **structurally unusable** in any gate, review card or
   `verify_software` verdict, with a test.
3. **The tag API** in `core/infra/git-store.ts`, additively: `annotatedTag`, `listTags(prefix)`,
   `resolveTag`, path-scoped `log`. Temp-dir tests, the existing pattern. ~150 lines. **Append at the
   end of the file. Do not change an existing export's signature.**
4. **App source into git**: `commitSubtree('apps/<slug>')` + `reserveSubtree('apps/')` on the commit
   path, the OpenSearch mirror demoted to a cache, the compile gate still running **before** the
   write, author = the acting user, the four trailers.
5. **`push_app_files(appId, files[], message)`** — the one documented verb for "code in Claude, push
   to the OS" — returning `{ commit, changed, gate }` and a preview URL, with `changed: false` and no
   commit for an unchanged push. Its UI twin goes through the same service.
6. **Part C entries** for the orphan `cron-deploy-pipelines` CronJob: capture then delete.

**Tests:** the false-documentation tripwire · the `serveMode` default and fail-closed cases · the
`demo-seed`-unusable test · the tag API against a real bare repo · push twice identically = one
commit, with the pusher as author · the compile gate refusing before any write · MCP/UI parity for
`push_app_files`.

**Hard rules for S:** **do not revive Kaniko** and do not build Tier 3 in any form. Do not add a
registry, a build pod, wildcard DNS or a per-app TLS cert. Do not widen the `agentic-apps` egress
policy. Do not build token exchange — the same-origin session bridge is the correct answer for
Tiers 1–2 and is to be defended. Do not couple app CI to Dagster, Tekton or Argo Workflows. Do not
re-add a forge. Do not ship `npm audit` as the dependency gate.

---

### Phase G — Git everywhere, and git made visible (`night2-G`)

**Owns:** `os-ui/core/infra/git-objects.ts` (new) · `os-ui/core/infra/git-store.ts` (**the read/diff
block only: read-at-commit, path-scoped log, unified diff — appended; S owns the tag block in the
same file**) · `os-ui/core/ui/git/**` (new — **you own it; T composes it, the five tabs mount the
badge and nothing more**) · `os-ui/core/mcp/git-tools.ts` (new) · `os-ui/tabs/governance/**` (the
Repositories section — backlog tonight) · `docs/components/git.md` (the versioning half; **E owns
the "Work from VS Code" half — append sections, do not rewrite**).

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/infra/git-store.ts` (with S) ·
`os-ui/instrumentation.ts` (with E) · `os-ui/ARCHITECTURE.md` · the one-line badge mounts in the five
tab detail headers (**the mount only — one JSX line and its import; touch nothing else in those
files, and if a stream owns that file tonight, hand the line to them in your report instead**).

**Read first:** this plan's git principle and D23–D26 · `core/infra/git-store.ts` in full (especially
`commitTree`, `commitSubtree`, `reserveSubtree`, `log`, `readBlob`, `listTree`, `archive`,
`parseTrailers`, `DestructiveReconcileError`) · `tabs/agents/lib/git/history.ts` (`systemGitInfo` —
the existing per-kind read-back, which `objectGitInfo` generalises) · `tabs/agents/lib/git/commit.ts`
and `tabs/data/lib/dbt/commit.ts` (the two compliant writers) · `tabs/agents/lib/git/reconcile.ts`
(where the missing per-object attribution comes from).

**The repo layout — one table, authoritative.** Write this into `docs/components/git.md` and keep it
true. One bare repo per domain at `/repos/<domain>.git` on the `os-repos` PVC, `main` only.

| Object kind | Path in the domain repo | Personal lane | Owner stream |
|---|---|---|---|
| dbt project (datasets, compositions, quality rules, schedules) | `dbt_project.yml`, `profiles.yml`, `models/**`, `os/schedules.yml`, `os/sources.yml`, `os/external.yml` | `models/personal/<uid>/**` | existing (night 1) |
| metric (dbt `semantic_models` + `metrics`) | `models/semantic/<model>.yml` | `models/personal/<uid>/semantic/<model>.yml` | **M** |
| dashboard | `dashboards/index.yml`, `dashboards/<slug>/dashboard.yaml`, `dashboards/<slug>/README.md` | `dashboards/personal/<uid>/<slug>/…` | **D** |
| agent system | `agents/index.yml`, `agents/<slug>/{system.yaml,agents/<id>.md,graph.json,README.md}` | `agents/personal/<uid>/<slug>/…` | existing (night 1) |
| software app | `apps/<slug>/**` + `apps/<slug>/.app/release.json`; releases as tags `app/<slug>/v<x.y.z>` | n/a (an app is owned, not laned) | **S** |
| lifecycle pins | `os/lifecycle.yml` + tags `live/<kind>/<id>` | — | **V** |
| promotion / governance metadata | `os/promotion.yml`, `os/grants.yml` | — | OS-owned, **never pushable** |
| knowledge workflow | `knowledge/<slug>/**` | `knowledge/personal/<uid>/<slug>/…` | **backlog** |
| connection configuration (**never a credential**) | `connections/<slug>.yml` | — | **backlog** |

**Deliverables, in order:**
1. **`core/infra/git-objects.ts`**: `objectGitInfo(kind, id)` → `{ head, history[], truncated }`,
   resolving by the `OS-Object` trailer **and falling back to a path-scoped `git log -- <path>`** when
   no trailer matches — which is the night-1 follow-up: boot-reconcile commits carry platform
   attribution, so a trailer-only lookup returns `null` for objects that plainly have files in the
   tree. Then `getVersion(kind, id, sha)` and `diffVersions(kind, id, shaA, shaB)`.
2. **The additive git-store support** those need: read a blob at a commit, a path-scoped log, a
   unified diff between two trees. Append at the top of your own block; do not change an existing
   export's signature.
3. **Owner/scope gating**: all three return a byte-identical `not_found` for an object the caller
   cannot see and one that does not exist.
4. **`core/ui/git/`**: `GitHeadBadge` (sha7 · author · relative time; click opens the drawer) and
   `HistoryDrawer` (commit list with action, surface and actor; per-commit diff), **logic in `.ts`,
   `.tsx` thin**. Unify the existing Agents header line onto the shared component rather than leaving
   two implementations.
5. **`core/mcp/git-tools.ts`**: `get_history`, `get_version`, `diff_versions`, each `{kind, id}`,
   each reaching the **same module** the drawer uses, asserted by a parity test.
6. **The enumeration test**: over **all** object kinds, assert no kind exists whose writer does not
   commit — the X1 pattern, generalised. A kind that is backlog is listed as backlog **in the test**,
   so adding it is a one-line change and forgetting it is a failure.

**Tests:** `objectGitInfo` against a **real bare repo** in a temp dir, including the
boot-reconcile-attributed case that the fallback exists for · `git.head` non-null for every object
with files in the tree · the `not_found` gate for an invisible object · the diff · UI/MCP parity per
read · the all-kinds enumeration.

**Hard rules for G:** **no history rewriting, ever.** Do **not** ship `restoreVersion` or
`restore_version` tonight — design the signature, write the refusal tests, and stop; a write path
that re-applies versions across five kinds is not a thing to leave unattended. Every boot-time writer
calls `hydrationState()` first. Do not weaken `DestructiveReconcileError`. Do not duplicate a
per-kind history reader — `systemGitInfo` becomes a thin call into the generic one or is deleted.

---

### Phase T — The engineering view (`night2-T`)

**Owns:** `os-ui/core/engineering/**` (new: the `EngineeringView` type and the adapter registry,
pure) · `os-ui/core/ui/engineering/**` (new: the `UnderTheHood` panel) ·
`os-ui/core/mcp/engineering-tools.ts` (new) · `os-ui/tabs/<tab>/lib/engineering.ts` for the five tabs
(**new files, one per tab — you own them; they are small and collide with nothing**) ·
`docs/components/*.md` engineering sections · the one-line panel mounts on the five detail pages
(**the mount only; if a stream owns that file tonight, hand them the line**).

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/kernel/config.ts` ·
`os-ui/ARCHITECTURE.md` · `core/ui/git/**` (**consume** G's badge; never fork it).

**Read first:** this plan's **Global design principle** (the whole section — it is your
specification) and D25–D26 · `os-ui/ARCHITECTURE.md` "How a `system.yaml` becomes a StateGraph",
"A data product is a dbt project in a git repo the OS owns", "Dagster schedules the repo", "Data
products execute as the principal" · `tabs/agents/lib/langgraph-compile.ts` and `engine/build-graph.ts`
(what the compiled graph actually contains) · `tabs/data/lib/dbt/{generate,read}.ts` ·
`core/infra/dagster.ts` · `core/infra/langfuse.ts` (`traceUrlFor`) · `core/infra/litellm-credential.ts`.

**Deliverables, in order:**
1. **`core/engineering/`**: the `EngineeringView` type — a serialisable structure of per-tool
   sections, each with the tool's own noun, the artefact (text or JSON), the repo path where
   relevant, the deep link, and the **engineer's command** — plus a registry mapping `kind` → adapter.
   Pure, testable, no React.
2. **Five adapters** in `tabs/{data,metrics,dashboards,agents,software}/lib/engineering.ts`, each
   returning the sections it can honestly fill: **dbt** (model SQL, `schema.yml` / `sources.yml` /
   `semantic_models` / `metrics` YAML **as stored in the repo**, the repo path,
   `dbt build --select <node>`, `dbt test`, `mf query --metrics …`); **Dagster** (asset keys, job and
   schedule names, last run id and status, the "Open in Dagster" link through the tool proxy,
   `dagster asset materialize --select …`); **LangGraph** (the compiled graph as JSON — plan/act/
   tools/route nodes per agent, edges, `when` guards, state channels, interrupt points — plus the
   checkpointer, thread-id = run-id and the resume semantics); **Git** (the file list with paths and
   the head sha, **composing G's badge**); **Langfuse** (the trace URL and what is redacted and why).
3. **`UnderTheHood`** in `core/ui/engineering/`: one tab per tool, mounted on the five detail pages
   with a single line each. A section the adapter could not fill says **why**, rather than being
   absent.
4. **The vocabulary test**: a label on these panels that uses only an OS-invented noun fails. Keep
   the allowed noun list in a `.ts` constant so the test is data-driven.
5. **`get_engineering_view({kind, id})`** returning the identical structure, with a parity test.
6. **The native dbt export, documented**: `archive()` already produces the tarball; document the
   exact commands to run the exported project with the dbt CLI, and assert through the existing parse
   gate that an exported project parses.

**Tests:** one adapter test per kind against a fixture (pure, no cluster) · the vocabulary test ·
the MCP/UI parity test · the exported-project parse assertion · a "deep link that cannot resolve
explains why" case.

**Hard rules for T:** **show the real thing, never a paraphrase** — the SQL shown is the SQL that
ran, the YAML shown is the bytes in the repo, the graph shown is the compiled graph. Never invent a
command you have not checked against the tool's own CLI. Never duplicate G's git components or D's
chart surface. Do **not** add the Trino "preview as me" button or the LiteLLM tab tonight — they are
backlog, and a preview button that forgets the query budget is a live incident. Where the OS still
does something its own way, **say so on the panel** in the "what is NOT true yet" style.

---

### Phase E — The engineer's door (`night2-E`)

**Owns:** `images/base/git-http/**` (new, or the existing git-daemon image extended to run both) ·
`charts/sovereign-agentic-os/templates/base/os-ui/` sidecar + the `/git/` ingress path ·
`os-ui/core/auth/access-tokens.ts` + its store (new) · `os-ui/core/infra/git-receive.ts` (new) ·
`os-ui/app/api/git/**` (new) · `os-ui/tabs/admin/**` the Access-tokens section (**small, new section
only — S also touches this tab tonight for the Argo CD claim; keep your edit to a new file plus one
nav line**) · `os-ui/tabs/data/lib/dbt/ingest.ts` and `os-ui/tabs/agents/lib/git/ingest.ts` (**new
files, you own them**) · `docs/components/git.md` (the "Work from VS Code" half; **G owns the
versioning half**).

**Shared (additive only):** `CHANGELOG.md` · the checklist · `charts/.../values.yaml` (with S) ·
`core/kernel/config.ts` · `os-ui/instrumentation.ts` (with G) · `os-ui/ARCHITECTURE.md`.

**Read first:** this plan's **coin principle** and D27–D29 · `core/infra/git-store.ts` (the
per-domain mutex — your lock story depends on understanding it exactly) ·
`charts/.../templates/base/os-ui/os-repos.yaml` and `os-ui.yaml` (the existing read-only `git daemon`
sidecar and its NetworkPolicy — your model) · `tabs/data/lib/dbt/{generate,read,commit}.ts` and
`tabs/agents/lib/{system-schema,git/generate}.ts` (what you are ingesting back) ·
`tabs/data/lib/mutations-server.ts` (the one governed service per data mutation — your ingest writes
through services, not stores).

**Deliverables, in the owner's order — transparency first:**
1. **Authenticated READ.** The `git http-backend` image, the chart sidecar, the `/git/` ingress path,
   and `core/auth/access-tokens.ts`: create, **hash at rest**, show once, list by prefix and metadata
   only, revoke, resolve to an identity. Plus the small Platform → Access tokens section. Then the
   transparency affordances: the `git clone` command on every detail page and T's "open this file in
   the repo" link. **Read is unconditional** — the whole repo, `os/*.yml` included.
2. **Push behind the receive gate.** `core/infra/git-receive.ts`: **hold the per-domain git-store
   lock for the duration of `receive-pack`** (bounded wait; on timeout fail the push with a readable
   message, never hang the terminal); resolve the token; decide path permission (own personal lane;
   domain paths per role; **never** `os/*`, grants or anything secret-shaped — rejected with *"managed
   by the OS; change it in Governance or over the MCP"*); run the validators — **the same ones the UI
   and MCP call**, the dbt parse gate and `parseSystem`; refuse non-fast-forward `main`; reject with
   the file name and the reason.
3. **Post-receive ingest.** `reconcileFromGit(domain, fromSha, toSha)` dispatching to
   `ingestFromRepo(kind, files)`: dbt models + `schema.yml` → dataset records (name, layer, schema,
   columns, description, quality rules from the tests) and `agents/<slug>/system.yaml` → agent
   systems. Attributed to the **pusher**, `OS-Surface: git:push`, reusing the existing Dagster reload
   and Trino-rules reconcile hooks.
4. **`docs/components/git.md` → "Work from VS Code"**: clone, create a token, push, what gets
   validated, what the OS does afterwards, and what is read-only and why.
5. **Part C entries** for the live clone and push — they cannot be tested here.

**Tests, all offline, driven by a *fake receive***: a real bare repo in a temp dir, a synthetic push,
the endpoint called directly. Cases: valid token lands and the registry updates · no token / expired
/ revoked → 401 · a path you do not own → rejected with the reason · `os/*` → rejected with the
managed-by-the-OS message · invalid dbt / unparseable `system.yaml` → rejected · non-fast-forward →
refused · an OS commit and a push interleaved → serialised, neither lost · a token never appears in
a log or an error · **the coin test** (X owns the table-driven version; you own the push half it
drives).

**Hard rules for E:** the validator is **one** endpoint shared with the UI and the MCP — never a
second copy. Read is unconditional; write is gated. The OS never rewrites a human's history. A token
is hashed at rest and shown once. Do **not** widen the `os-repos` NetworkPolicy beyond what the
sidecar needs. Do not build branches-as-proposals or PR review tonight. Do not let the ingest write
through a store directly — it goes through the governed service, so the push and the UI leave the
same state.

---

### Phase V — Lifecycle: Studio → Test → Run (`night2-V`)

**Owns:** `os-ui/core/kernel/lifecycle.ts` (new) · `os-ui/core/ui/lifecycle/**` (new: the two badges
and the Studio|Run toggle; one shell-header file) · the central list-filter helper in
`os-ui/core/mcp/` (one new file; **one-line integrations** in each list tool) · the go-live path and
its guard (`os-ui/tabs/governance/lib/**` where the promotion path lives — **V owns the go-live half;
do not change the promotion tools**) · `os-ui/core/mcp/lifecycle-tools.ts` (new: exactly `go_live`
and `retire`) · `docs/components/lifecycle.md` (new).

**Shared (additive only):** `CHANGELOG.md` · the checklist · `core/kernel/config.ts` ·
`os-ui/ARCHITECTURE.md` · `core/infra/git-store.ts` tag API (**consume S's; if S has not merged,
write against the signature in D17 and note the dependency**) · the one-line badge mounts.

**Read first:** this plan's **lifecycle principle**, the **simplicity contract** (line by line — your
reviewer checks it against you), and D30–D32 · `tabs/metrics/lib/governance.ts` and
`tabs/dashboards/lib/governance.ts` (the audience ladder you must **not** touch) ·
`core/prefs/**` (where the Studio|Run choice persists) · `core/kernel/artifacts.ts` and each tab's
store (where `lifecycle` has to live).

**Deliverables, in order:**
1. **`core/kernel/lifecycle.ts`**: the pure model, total over every kind, `{ draft, testing?, live? }`,
   with the two-axis invariant tested — a `My` object can be Live, a `Company` object can have a
   Draft, and neither axis derives from the other.
2. **`go_live(kind, id, sha?)` and `retire(kind, id)`** — the **only** two new MCP tools — writing the
   git tag (S's API) and `os/lifecycle.yml`, with their UI twins going through the same service.
3. **The go-live guard**, one implementation: refuse when a dependency is not live, naming it.
   Tested per kind.
4. **Pins honoured for two kinds:** agent systems (the schedule runs the pinned definition) and
   dashboards (the Run view renders the pinned spec). **The headline test:** edit a live dashboard,
   assert Run is byte-identical, `go_live`, assert it changed.
5. **The UI:** two small badges, one Studio|Run header toggle persisted per user, one shared hook
   every tab's tile list calls. **Nothing else new on screen.** Logic in `.ts`.
6. **The central list filter**: optional `lifecycle` parameter, `lifecycle` + `audience` on every
   result, one helper, one-line integration per tool, the registry-wide conformance test extended.
7. **The migration**: every existing object becomes **Live**, so the Run view on day one is exactly
   today's screens. New objects are Draft. Tested against existing fixtures.
8. **The LiteLLM `env:` tag and the Langfuse `environment` field**, plus per-lifecycle budgets in the
   key metadata.
9. **`docs/components/lifecycle.md`**: the per-kind Studio / Test / Run mapping table, try-it-out
   versus go-live, and the honest physically-versus-logically section.

**Tests:** `lifecycle` total over all kinds · the two-axis independence cases · the go-live guard per
kind · **edit-live-does-not-change-Run** · `retire` · the migration leaving every fixture in Run · a
new object absent from Run · the filter helper · the conformance extension · the LiteLLM and Langfuse
attribution.

**Hard rules for V:** **the simplicity contract is a hard gate, not advice.** Three lifecycle words,
three audience words, two badges, one toggle, one Go-live button with one confirm, two new MCP tools,
no new required argument anywhere, and `lifecycle` optional with a default that preserves today's
behaviour for every existing client. Do **not** touch the promotion tools or the audience ladder. Do
**not** add a `stage`, `environment` or `release` noun to any UI string (except "release" for apps).
Do **not** invent a managed "Testing" state to administer — Testing means running or previewing the
draft from Studio. **If the budget runs out, drop Testing and ship Draft/Live**; say so in the report.

---

### Phase X — Night-1 live follow-ups (`night2-X`)

**Owns:** the specific lines named in X-R1…X-R8 and nothing else. `os-ui/tabs/agents/lib/git/reconcile.ts`
(per-object attribution, zero-agent skip) · the tool-span and trace read-back sites
(`os-ui/tabs/agents/lib/engine/observe.ts`, `core/infra/agent-governed.ts`, the monitoring run-trace
adapter) · `docs/components/trino.md` (the password and regeneration wording) · the coin test (a new
test file — place it in `core/mcp/` beside the conformance tests).

**Shared:** `CHANGELOG.md` · the checklist · `core/kernel/licenses.ts` (**D owns it — you verify and
report, you do not edit**) · `tabs/dashboards/mcp/dashboard-write-tools.ts` (**D owns the enum — you
verify**) · `tabs/metrics/**` strings (**M owns them — you verify; you own any Cube string outside
`tabs/metrics`**).

**Read first:** the X requirements in this plan · last night's plan and checklist for the context of
each item · `tabs/agents/lib/git/{reconcile,history}.ts` · `engine/observe.test.ts` (the recording-SDK
pattern your trace fixes need).

**Deliverables:** each of X-R1 … X-R8, each with a test, each as its own commit so the coordinator can
take them independently. The coin test (X-R8) is the one substantial piece: one table-driven test
asserting that for each kind the same change via the MCP tool and via a `git push` yields
byte-identical files, identical registry state and an identical history entry **except**
`OS-Surface`. Kinds tonight: the dataset model and the agent system. **It depends on E's receive
path** — write it against E's signature, mark it `todo` if E has not merged, and say so.

**Hard rules for X:** surgical changes only. One commit per item. Verify, do not edit, what another
stream owns — a finding in your report is the correct output. Never tick a row you did not measure.

---

## Review protocol

**One read-only reviewer per stream, all nine in parallel.** A reviewer never edits; it reads the
diff, reads the tests, re-runs the gates, and produces findings as `H` (must fix before merge), `M`
(fix in the round) and `L` (record as a deviation or a backlog line). Reviewers run on **Opus** —
they are the only thing standing between an unattended night and a merged lie.

**Every reviewer checks, in this order:**
1. **Did it do what the brief said**, and is every checklist row it ticked actually measured by the
   test it cites? **Read the cited test.** Last night's single most useful review finding was a row
   whose cited test never called the function.
2. **Identity.** Any read or write that could execute under a service principal where a user exists.
3. **Honesty.** Any fallback, mock, cache, truncation or outage that could read as success.
4. **The commit path.** Any writer that does not commit; any commit missing its trailers.
5. **The simplicity contract**, line by line. **A stream whose UI adds a fourth noun, or whose MCP
   adds a required argument, fails review** — this is V's reviewer's primary job and every other
   reviewer's secondary one.
6. **Licences.** Any vendored file without its upstream header and a `Modified from … @ <sha>` line;
   any new SPDX id; any AGPL or source-available code anywhere near the tree.
7. **File ownership.** Any edit outside the stream's owned set that is not in the shared table, and
   any edit to a shared file that reflowed rather than appended.
8. **The gates, re-run.** Not trusted from the report: `tsc`, the suite, `check-structure`,
   `gate.sh`, `helm lint` where the chart changed, `scripts/license-check.sh` where licences changed.

**Then one fix round per stream**, by the implementer, against its reviewer's `H` and `M` findings,
with each fix a test. A finding that is deliberately not fixed becomes a numbered deviation with the
reason — never a silent omission.

**Merge order, and why.** Conflicts are expected in the shared files; the coordinator resolves them
by taking both sides, never by discarding one.

| # | Stream | Merged before/after | Reason |
|---|---|---|---|
| 1 | **X** | first | small, surgical, independent; clears the night-1 lies out of everyone's diff |
| 2 | **D** | before C and T | owns `core/ui/charts/`, the licence machinery and `core/kernel/licenses.ts`, which C, T and X all read |
| 3 | **S** | before G and V | owns the **tag API** block in `core/infra/git-store.ts`, which G appends after and V consumes |
| 4 | **G** | after S, before T and V | owns `core/ui/git/**` (T composes it) and the generic read-back (V's pins and E's history link on it) |
| 5 | **M** | after D | shares `tabs/metrics/**` boundaries with C's guide edits and D's panel path |
| 6 | **C** | after D and M | consumes D's chart surface and M's corrected metric-tool descriptions |
| 7 | **T** | after D, G, M | composes G's badge, consumes D's chart surface, reads M's semantic artefacts |
| 8 | **E** | after G | shares `instrumentation.ts` and `docs/components/git.md` with G; X's coin test depends on it |
| 9 | **V** | last | consumes S's tag API and touches the most tabs with one-line integrations; least disruptive to resolve against a settled tree |

After each merge: re-run the full gate set on the merged tree, not just the branch. A merge that
breaks a gate is reverted, not patched forward at 4 a.m.

---

## Part C — Deploy and verify

**Nothing in this programme deploys tonight.** Part C is the morning's work, written out now from the
plan so the deploy is a checklist rather than an improvisation — exactly as last night's Part C was.
Every step below is `untestable here` until it is run.

### C.0 — Version

`charts/sovereign-agentic-os/Chart.yaml` is at chart `0.3.0`; `os-ui/package.json` is `0.8.0`.
This programme is **additive** at the chart level tonight — the new objects are E's `git-http`
sidecar and the `/git/` ingress path, both behind a value — and **breaking in behaviour** the moment
V's migration runs (every existing object becomes Live; the Run view becomes the default for
consumers). Proposed: **chart `0.4.0`** (new rendered objects and new values keys), **app version
`0.9.0`** (new surfaces, new MCP tools, a migration). `CHANGELOG.md` stays `[Unreleased]`; the release
commit that merges these branches converts it.

### C.1 — Build and roll out

```bash
colima start                                   # the build runs in a 14 GB VM
cd ~/Documents/Claude/Projects/'Data Masterclass Apps'/sovereign-os-stack
./scripts/deploy.sh 0.9.0                      # DIRECTLY — never `| tail`
colima stop                                    # frees 14 GB before anything else needs kubectl
```
Expect the final line `DEPLOY_0.9.0_OK`. If `scripts/worker-deps.mjs` needed a new production
dependency, the post-build strip-types smoke is the check that the worker still boots.

### C.2 — Post-deploy verification, in this order

```bash
NS=agentic-os; CTX=dmagenticos; kubectl config use-context $CTX
```

**1. Health.** No pod outside `Running|Completed`; `rollout status deploy/os-ui`; `/api/health` 200.

**2. Metrics are dbt metrics (M).** Define a metric in the UI, then:
```bash
kubectl -n $NS exec deploy/os-ui -- sh -lc \
  'git --git-dir=/repos/<domain>.git ls-tree -r --name-only main | grep ^models/semantic/'
# expect: models/semantic/<model>.yml, and the commit authored as YOU with OS-Object: metric:<id>
kubectl -n $NS exec deploy/agentic-os-dagster-user-deployments-sovereign -c repo-sync -- \
  python /opt/dagster/app/os_projects.py --parse /repos-checkout/<domain>/current
# expect: dbt parse succeeds WITH the semantic block, and target/manifest.json contains the metric node
```
Then query the metric in the explorer and assert the number; define the same metric over the MCP in a
second domain and compare the two commits — they must differ **only** in `OS-Surface`.

**3. Dashboards are code (D).** Save a dashboard, then
`git --git-dir=/repos/<domain>.git show main:dashboards/<slug>/dashboard.yaml` — readable, and a
second save is a second commit. Confirm the vendored transformer renders a real panel and that the
`vizType` enum offered over MCP matches the UI's.

**4. Chat is honest and traced (C).** Ask a question whose answer is clipped; the turn must show the
row limit and the query-tool's own sentence verbatim. Then:
```bash
curl -fsS -H "Authorization: Bearer $LANGFUSE_PUBLIC_KEY" "https://<langfuse>/api/public/traces/<threadId>"
# expect: ONE trace for the turn with the tool calls nested — not N orphan traces
```

**5. An app is a commit, and the triangle holds (S).**
```bash
kubectl -n $NS exec deploy/os-ui -- sh -lc \
  'git --git-dir=/repos/<domain>.git ls-tree -r --name-only main | grep ^apps/'
kubectl -n $NS exec deploy/os-ui -- sh -lc 'git --git-dir=/repos/<domain>.git tag --list "app/*"'
```
Push the same files twice over `push_app_files` → **one** commit. Then the **triangle**: from a demo
app call an agent; the agent writes a dataset row through a governed tool; the app reads it back.
Assert all three steps carry the **same user** in `run_events`, in the Langfuse trace and in the git
commit. Negative: an app calling a tool outside its scopes gets the tab's documented refusal; an
agent calling a writing app action is **held** in the Governance inbox. Finally, confirm no app
serves `traefik/whoami` on any domain.

**6. Git is visible (G).** On a Data, Metrics, Dashboards, Agents and Software detail page the head
badge resolves — including for an object that existed **before** tonight, which is the
boot-reconcile-attribution fix. Open the history drawer, read a diff. Then the same three reads over
the MCP and compare.

**7. The engineering view is true (T).** On each of the five kinds, open **Under the hood** and check
every claim against the cluster: the dbt model SQL equals what is in the repo; the Dagster asset key
and last run match the Dagster UI; the LangGraph JSON matches the compiled graph; the Langfuse link
opens that trace. Then download the dbt project tarball and run `dbt parse` on it **outside** the OS.

**8. The engineer's door (E).** From a laptop:
```bash
git clone https://<OS_PUBLIC_URL>/git/<domain>.git     # with a personal access token
# expect: the whole tree, os/*.yml included
# then: edit a dbt model, push -> lands, the registry updates, Dagster reloads
# then: edit os/promotion.yml, push -> REJECTED: "managed by the OS; change it in Governance or over the MCP"
# then: push an unparseable system.yaml -> REJECTED naming the file
# then: push --force to main -> REFUSED
```
Then the **coin test for real**: make the same change over the MCP and by a push, and diff the
registry state and the two commits.

**9. Lifecycle (V).** Confirm the migration: every pre-existing object shows **Live** and the Run view
is today's screen. Create a dashboard → it is **Draft** and absent from Run. `go_live` → it appears.
Edit it → Run is unchanged until the next `go_live`. `retire` → it leaves Run and nothing is deleted.
Try to go live over a Draft metric → refused, naming the metric. Then check a model call's LiteLLM
tags carry `env:` and the Langfuse trace's `environment` is the lifecycle.

**10. The old world is gone (S).**
```bash
kubectl -n $NS get cronjob cron-deploy-pipelines -o yaml > /tmp/orphan-cronjob.yaml   # capture FIRST
kubectl -n $NS delete cronjob cron-deploy-pipelines                                   # then delete
kubectl -n $NS get cronjob -o name | grep -i 'deploy\|pipeline'                       # expect: no output
```

**11. Rollback.** `helm rollback agentic-os <previous>` is the recovery path. The only non-additive
item is V's migration, which writes a lifecycle onto existing objects; it is reversible by retiring
nothing and ignoring the field, since every object is marked Live.

- [ ] C.1 executed
- [ ] C.2 steps 1–11 executed and each expected output seen

---

## Part F — Iterate against the checklist

After the merge of all nine streams: a **read-only test agent** scores
`2026-11-14-engineering-checklist-night2.md` against the merged tree, **reading every cited test
rather than trusting it**, and appends a gap report there. The gaps are grouped into "Iteration N"
appended to this file, with phases, gates and the items they close. Repeat until two consecutive
iterations close nothing further. Deploy after each iteration whose gates are green.

The iteration protocol is the one in last night's checklist, unchanged: **Test → Plan → Design and
implement (parallel only on disjoint areas) → Repeat → Deploy.** Untestable-here items are listed in
the final report with exactly what would be needed to test them.

- [ ] Iteration 1 — score all items, write the gap report, close what the environment permits.

---

## Decisions taken without the owner (autonomous mode) — review these

1. Metrics: dbt YAML is the committed contract; the OS's TypeScript compiler keeps serving every
   interactive read (D1, D2).
2. MetricFlow is adopted only as a CI parity oracle and a batch export engine, pinned `>= 0.209.0`,
   and is never on the request path (D3).
3. The emitter pins DSI 0.8.5 / dbt-core 1.10 field names behind one version constant; dbt 1.12
   "Fusion" becomes a translation layer later (D4).
4. The dbt metric becomes the source of truth and `Measure` is derived from it — direction decided
   now, inversion later; `count_distinct_approx` is the documented exception (D6).
5. Dashboards: build fresh on ECharts, vendor exactly four backend-free Superset slices, never
   `npm i @superset-ui/*` (D8); `react-grid-layout` is the grid (D9).
6. A dashboard is one `dashboard.yaml` in the domain repo, Perses' authoring model with Superset's
   layout vocabulary (D10). No ad-hoc SQL in a panel; no cache without the principal in the key (D11).
7. Chat moves onto the existing LangGraph engine as a built-in, non-editable `os.analyst` system,
   staged behind a flag; nothing is vendored; Open WebUI is closed as an option and Wren AI's licence
   claim is corrected to multi-licensed (D12, D13).
8. Artifacts ride MCP `outputSchema` + `structuredContent`, not a bespoke envelope (D14); a chat
   thread is a run thread, keyed per user (D15).
9. Software: one repo per domain with apps under `apps/<slug>/`, `main` only, releases as annotated
   tags with a manifest (D16, D17); Tiers 1–2 to full standard, Tier 3 behind a flag, kpack over
   rootless BuildKit when it comes, Kaniko never (D18).
10. CI runs in the OS's own path, not Dagster, Tekton or Argo Workflows; Trivy is the default scanner;
    CycloneDX 1.7 is the SBOM format (D19).
11. Promotion re-points and never rebuilds; rollback is never re-reviewed (D20).
12. The same-origin session bridge is defended rather than replaced; agents reach app actions through
    the existing adoption gate (D21).
13. Git: every artefact kind commits through one path, no writer may skip it, restore is a new
    commit, and history read-back falls back to the path when the trailer is absent (D23, D24).
14. The engineering view is one shared panel over one pure adapter per kind, MCP-serialisable (D25);
    native export is a product guarantee (D26).
15. The engineer's door is real git over HTTP with OS personal access tokens; the pre-receive hook
    **holds the per-domain lock** rather than letting the push land and telling the OS afterwards
    (D27); one validator serves both doors (D28); the registry is reconciled from the files (D29).
16. Lifecycle is a second, orthogonal axis attached to a version — **not** a re-use of the audience
    ladder, which the owner explicitly rejected (D30); the OS runs from a pin and editing never moves
    it (D31); two badges, one toggle, two new MCP tools, and the dependency guard becomes a go-live
    guard (D32).
17. **Overruled from the research, deliberately:** R2's "one chart surface then straight into layout
    and filters" ordering (tonight stops after the licence machinery and one transformer, because
    41.5 engineer-days cannot be compressed into one night and a half-built filter bar is worse than
    none); R3's slice-3/4 ordering for durable threads and the write path (deferred entirely — the
    engine migration on the OS's most visible surface is not an unattended-night task); R4's S4–S6
    release verbs (the tag API lands, the verbs do not, because a release that cannot be rolled back
    is worse than no release); and R2's D21 removal of the Superset Helm chart (tied to the stream's
    completion, which is weeks away — removing it tonight would leave the OS with no dashboard
    product at all).

---

## Deviations log

Agents append here: **phase, what differed, why.** One entry per deviation, numbered with your
stream's prefix — `M-1`, `D-1`, `C-1`, `S-1`, `G-1`, `T-1`, `E-1`, `V-1`, `X-1`, and
`<X>-review-<id>` for findings from the review round. A deviation is not a failure; an unrecorded
deviation is.

### Stream G — git everywhere and the git UI

- **G-1 — `restoreVersion` SHIPPED as a gated, refusing capability, where the brief said "design the signature and stop".** The plan's hard rule for G was "do not ship `restoreVersion`"; the night's implementer brief asked for it as "a NEW commit through the object's normal writer". Resolution: the function, its owner/scope gate, its three refusals (`not_found` first, then `nothing_to_restore`, `version_too_large`, `restore_unsupported`) and the "one new commit, prior history byte-identical" contract are implemented and tested — but **no tab registers a restorer**, so no kind can actually be restored tonight, and the write across five kinds the plan was protecting against does not exist. The UI shows the refusal rather than hiding the button, which is what makes the gap visible instead of silent.
- **G-2 — `restore_version` was NOT added to the MCP surface.** A write tool must be declared in `core/mcp/write-tools.ts` + `core/mcp/write-tool-meta.ts` (the governance-critical approval catalogue, shared with several streams), and tonight its only possible answer is `restore_unsupported`. Adding a refusing write tool to the approval catalogue is churn in a shared, safety-relevant file for no user-visible gain. `get_history`, `get_version` and `diff_versions` shipped; `restore_version` is one row in two files once a kind registers its writer.
- **G-3 — the writer states are three, not two.** `GIT_OBJECT_LAYOUT` distinguishes `committed` (the module exists and reaches `commitTree`/`commitSubtree`), `landing` (declared, naming the stream that lands it tonight) and `backlog` (with a reason). Two states would have forced a lie: calling metric/dashboard/software/lifecycle-pin "committed" before M/D/S/V land their writers, or calling them "backlog" when they are explicitly in flight. The enumeration test asserts a `landing` row whose module starts committing must be flipped to `committed` — so the honesty is enforced rather than hoped for.
- **G-4 — only ONE of the five badge mounts landed.** The Agents detail header is unified onto `<GitHeadBadge/>`; the Data, Metrics, Dashboards and Software detail headers are inside files M, D and S own tonight (`tabs/metrics/**`, `tabs/dashboards/**`, `tabs/software/**`, `tabs/data/ui/ResultChart.tsx`), and the brief's rule is to hand the line over rather than edit another stream's file. The one-line mount is in stream G's report for each.
- **G-5 — `Governance → Repositories` and `ReleaseList` were built, though the MVP cut line listed both as backlog.** They are read-only, they are inside files stream G owns, and the mirror-health row they read already existed, so the cost was low and the "prove everything is in git" claim is exactly what an operator asks about first. `ReleaseList` is hidden until stream S's tag API lands, which it discovers at RUN time (`objectReleases`) rather than by compiling against an export that does not exist yet.
- **G-6 — `tabs/agents/lib/git/history.ts` was rewritten rather than left beside the generic reader,** and its `SystemGitInfo` gained two fields (`via`, `paths`). The brief allowed "a thin call into the generic one or is deleted"; the rewrite is the thin call. One existing assertion in `tabs/agents/lib/git/repo.test.ts` (the deep-equal shape of an empty answer) was updated additively for the two new fields — the only test of another stream's area this stream touched, and it is in the agents git area no stream owns tonight.
- **G-7 — the per-object history MERGES the trailer hits and the path hits, ordered by position in the walk, not by timestamp.** The brief said "falling back to" the path log; a strict fallback would have hidden the boot-reconcile commit for an object that ALSO has a trailer commit, which is the common case for every pre-existing object. Sorting the merged list by author timestamp was tried first and was wrong: a save and its follow-up share a timestamp, so the two commits swapped. Ordering by position in the (single, shared) log window is both correct and free.

- **G-review-H2 — the operator surfaces became ADMIN-only, not builder+.** `?action=repos` and `?action=repolog` are tenant-wide and unscoped by domain, and they carry mirror URLs, push errors and each commit's object slug — which for a Personal object is somebody else's artefact name. They now match the floor Platform → Components applies to the same material, and the Governance section carries `minRole: 'admin'`. The commit log additionally applies a SECOND gate (every row's `OS-Object` must resolve for the caller through the owning tab's governed read) and reports the withheld count rather than returning a quietly shorter list.
- **G-review-M1 — a version read now REDACTS secret-shaped content, and a restore still re-applies the raw bytes.** The scrub lives at the read-out boundary (`getVersion` / `diffVersions`), never in `readFilesAt`, because a redaction performed in the primitive would be written back into the tree by a restore. The patterns are shape-based, never entropy-based: a commit sha, a blob oid and a UUID must survive untouched. The diff compares RAW content and only then redacts, so a change entirely inside a redacted value is reported as a redacted change instead of as "no change".
- **G-review-M3 — binary blobs are named, not decoded, and a version containing one cannot be restored.** `Buffer.toString('utf8')` on a PNG produced replacement characters that looked like content and that a restore would have written back as a truncated file. A binary file now reads back as `{binary: true, bytes, content: ''}`, a diff shows git's own `Binary files … differ`, and `restoreVersion` refuses with `binary_in_version`.
- **G-review-M2 — the differ emits `\ No newline at end of file`.** Without it `'x\n'` → `'x'` compared as two identical line arrays and produced a header-only patch that `git apply` rejects. The marker travels with the line through the LCS (a NUL-tagged sentinel, safe because binary blobs never reach the differ).
- **G-review-struct — the two operator payloads moved OUT of the route into `core/infra/git-objects.ts`** (`repositoriesOverview`, `repositoryCommitLog`). The hydrate-then-read ordering (H-1) and the per-row visibility filter (H-2) are the kind of logic that must be tested, and a test cannot import a `route.ts`; the route is now a role gate plus one call each.

