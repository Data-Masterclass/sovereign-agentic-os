# Under the hood — the real artefacts behind the abstractions

Which open-source tool does the work, where the files live in git, and what to open in each tool's own
UI to find the object.

> Written read-only against `feat/night-2` at `71b0c567` (14 November 2026). Two commits landed in the
> worktree during writing — `ac91c803` (worker boot secrets) and `14ed35ce` (a merge from main) — and
> between them they change only `os-ui/worker/agent-runs.ts` and
> `os-ui/core/kernel/config-secret-guard.test.ts`, so every citation here still resolves at `14ed35ce`.

This page is for an engineer who already knows dbt, Dagster, Trino, LangGraph, Langfuse, LiteLLM,
ECharts, OpenSearch and git, and who wants to know what the OS is actually doing on their behalf. It is
organised module by module. Each module section answers the same four questions — what the user sees,
what actually runs, where the real artefact is, and how to inspect it without the OS — and carries a
**Not yet true** callout wherever the code does less than the product language suggests.

A backticked `path:line` after a sentence is the file that makes it true, relative to the repository
root. Where a table says "the tool-side name", that is the string you would type into the tool's own
UI, CLI or API — the asset key, the index name, the trace name, the tag.

## How to keep this honest

Most of the load-bearing tables on this page are pinned by a test. If you change one of these things,
the named test fails, and that failure is the reminder to update this page too.

| What | Pinned by | What the test asserts |
|---|---|---|
| The `GIT_OBJECT_LAYOUT` table, and the mirrored table in [`docs/components/git.md`](components/git.md) | `os-ui/core/infra/git-objects-kinds.test.ts` | It parses the markdown table, requires its header verbatim, and **deep-equals it against `GIT_OBJECT_LAYOUT` row by row** (`:187-236`). It also asserts that a kind claiming `committed` names a module that exists and reaches `commitTree`/`commitSubtree` (`:93-101`), that a module importing those primitives is claimed by **some** kind (`:127-131`), that a `backlog` row carries a reason (`:115`), and that exactly `dataset`, `metric`, `dashboard`, `agent-system`, `software` and `lifecycle-pin` are committed with `knowledge-workflow` and `connection-config` the honest backlog (`:154-169`). It fails in **both** directions on readers: a committed kind with no registered reader fails, and a backlog kind that gains one fails too. |
| Adding a git object kind | the same test | Four edits in order: a row in `GIT_OBJECT_KINDS` + `GIT_OBJECT_LAYOUT`; the same row in `docs/components/git.md`; `registerGitObject('<kind>', resolver)` from the owning tab in `instrumentation.ts`; optionally `registerGitObjectRestorer`. |
| "The MCP is the same path, not a back door" | `os-ui/tabs/data/lib/mcp-parity.test.ts` | Drives each data tool through `handleRpc` and the same input through the service, then compares the **committed tree, the author, the `OS-Actor` trailer and the Dagster launch args**. |
| "Both doors write the same files" (the coin test) | `os-ui/tabs/agents/lib/git/coin-test.test.ts`, `os-ui/tabs/data/lib/dbt/ingest.test.ts` | The same change made over the MCP and by a `git push` must leave identical files and identical registry state, differing only in the `OS-Surface` trailer. |
| The LiteLLM master key never reaching a run | `os-ui/core/runtime/runtime.test.ts:241` | An **equality** assertion on the exact set of four files allowed to name it — `core/infra/litellm-admin.ts`, `core/infra/litellm-write.ts`, `core/kernel/config.ts`, `tabs/agents/lib/build/live-clients.ts` — so a file dropping out is as interesting as one appearing. `:252` drives a real completion and asserts the authorization header is not the master key. |
| Which MCP writes a governed agent can be made to hold | `os-ui/core/mcp/write-tool-meta.test.ts` | Membership of `WRITE_TOOL_TABS` in both directions, and held-eligibility. Its own header records the thirteen platform writes that are **not** in the table. |
| Audience and lifecycle staying orthogonal | `os-ui/core/kernel/object-lifecycle.test.ts` | A tripwire that fails if any function ever derives one axis from the other. |
| The optional `lifecycle` list filter | `os-ui/core/mcp/lifecycle-filter.test.ts` | That `LIFECYCLE_TOOLS_WITHOUT_LIFECYCLE` and the tool registry agree in **both** directions, so a new artifact list tool cannot quietly skip the filter. |
| `go_live` writing no git tag | `os-ui/core/kernel/go-live.test.ts` | `res.tag.written === false`. |
| Which of the agents store's writers commit | `os-ui/tabs/agents/lib/git/commit.test.ts` | Enumerates all 24 writers and pins which decision each made (17 commit; 7 are bookkeeping). |
| Which of the data store's writers commit | `os-ui/tabs/data/lib/dbt/commit.test.ts` | Enumerates the store's exports — a new mutator fails until it is classified. |
| The reserved subtree surviving a whole-tree reconcile | `os-ui/tabs/data/lib/dbt/boot-reconcile.test.ts` | Both directions: the reserved subtree survives a real reconcile, and without the reservation it does not. |
| One ECharts registration surface | `os-ui/core/ui/charts/echarts-surface.test.ts` | Greps the whole tree and fails on a second `echarts.use([...])`. |
| The vendored Superset slice's licence obligations | `os-ui/vendor/vendor-licence.test.ts` | Upstream ASF header verbatim, a `Modified from <repo> <path> @ <40-char sha>` notice, a `Changes:` list, an SPDX id, exactly one sha, and that sha present in `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md` and `NOTICE`; plus no package named `/superset/i` and no dependency on `@superset-ui/*`. |
| The MetricFlow BSL floor | `scripts/metricflow-floor.mjs` (run as pass 3 of `scripts/license-check.sh`, invoked by `.github/workflows/license-gate.yml`), `os-ui/tabs/data/lib/dbt/semantic/metricflow-floor.test.ts` | `metricflow >= 0.209.0`; an **unpinned** mention is also a violation; absence is a pass, not a skip. |
| No model-authored markup on the chat path | `os-ui/core/ui/ask-artifacts-guard.test.ts` | A hardcoded, self-asserted list of chat-path files, scanned for `dangerouslySetInnerHTML`, `eval(`, `new Function(`, `srcdoc` and `<iframe`. |
| Honest text (no stale tool claims) | `os-ui/tabs/metrics/lib/honest-text.test.ts`, `os-ui/core/mcp/cube-honesty.test.ts` | A `TREES` list of directories scanned for named patterns, including a bare `cube:` key, with a no-op guard. |
| The DLS filter actually being pushed down | `os-ui/core/security-route-guards.test.ts:116` | `assert.match(src, /dlsFilter\(principal\)/, 'GET pushes down the DLS grant filter')`. |
| The panel and the MCP returning the same structure | `os-ui/core/engineering/engineering-parity.test.ts` | Deep equality between `get_engineering_view` and what `UnderTheHood` renders. |
| The generated dbt project and dashboard YAML, byte for byte | `os-ui/tabs/data/lib/dbt/fixtures/*.golden.json`, `os-ui/tabs/dashboards/lib/git/generate.test.ts:125-180` | Whole generated file maps, asserted byte-equal to the generator. |
| The structure rules themselves | `scripts/check-structure.mjs` (a ratchet, baselined in `scripts/structure-baseline.json`) | `components/` upstream-only; a tab imports only `@core/*` and itself; the kernel never imports a tab; every tab has a `manifest.ts`; every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header; and the hard `VENDOR-LICENCE-HEADER` rule for `os-ui/vendor/**`. |

Two tables on this page are **not** pinned by anything and will drift: Appendix C (Helm flags) and
Appendix D (the glossary). Appendix D at least has a partial guard — `os-ui/core/engineering/vocabulary.ts`
is the tool-noun table, and `vocabularyViolations` fails a label that uses only an OS-invented noun.

---

## 1. The one-page map

Three ideas hold the whole system together, and everything after this follows from them. The first is
that there are exactly two doors onto the same files. The second is that an object has two independent
coordinates, not one. The third is that nothing in the execution path has an identity of its own.

### 1.1 Two doors, one git

Git is the system of record. One bare repository per domain lives under `config.reposDir` and is
written in-process by os-ui through `isomorphic-git`; the tab stores (the "registry") are a derived
index plus governance metadata — ownership, tier, approvals, audit. Where a file and a registry row
disagree, **the file wins and the row is re-derived**. `os-ui/ARCHITECTURE.md:1198-1201`

There are three entry points but only two kinds of door, because the UI and the MCP meet at the same
function before anything is written. `os-ui/ARCHITECTURE.md:1203-1209`

| Door | Enters at | Identity | Commit surface |
|---|---|---|---|
| UI | `app/**/route.ts` → the tab's governed service (`tabs/data/lib/mutations-server.ts`, `tabs/agents/lib/store.ts`) | the signed-in `CurrentUser` | `ui:<route>` |
| MCP / Ask the OS | `core/mcp/server.ts` `handleRpc` → the *same* governed service | the signed-in `CurrentUser` | `mcp:<tool>` |
| `git push` | the repo's `pre-receive` hook → `app/api/git/receive` → `core/infra/git-receive.ts` → the *same* governed service | an OS personal access token resolved to a live principal | `git:push` |

Three structural rules keep the doors from drifting, and none of them is a convention someone has to
remember:

1. **Read is unconditional; write is gated.** `/api/git/authenticate` gates reading on domain
   membership and nothing else — the whole tree, `os/*.yml` included. Path ownership, validation and
   serialisation apply only to a push. `os-ui/ARCHITECTURE.md:1214-1216`
2. **One validator, not a second copy.** `core/` may not import a tab, so `core/infra/git-receive.ts`
   holds no validator at all: each kind *registers* the validator the UI already calls, through
   `registerRepoKind({ kind, matches, validate, ingest })` — `parseSystem` for an agent system, the dbt
   gate for `schema.yml`. There is nowhere to put a second copy.
   `os-ui/core/infra/git-receive.ts:36-37`, `:143`
3. **One lock.** A push and an OS commit are mutually exclusive because the receive gate chains on the
   *same* per-repository mutex the git store serialises its own writers on — the global
   `Symbol.for('soa.git-store.locks')` map — held from `pre-receive` to `post-receive`.
   `os-ui/core/infra/git-store.ts:92-96`, `:104-112`; `os-ui/core/infra/git-receive.ts:30-33`

### 1.2 Two axes: audience and lifecycle

**Audience** is `My → Domain → Company`: who may use the object as an official artefact, changed only
by the promotion path with its roles and approvals. **Lifecycle** is `Draft → Testing → Live`, attached
to a *version*: whether this version is being built, tried out, or run. A `My` object can be Live; a
`Company` object can have a Draft. `os-ui/ARCHITECTURE.md:1239-1245`

The two axes land in different places in the repository, which is the clearest evidence they are not
the same thing. Audience is expressed **positionally** — an un-promoted object lives in its owner's
personal lane (`models/personal/<uid>/`, `dashboards/personal/<uid>/<slug>/`,
`agents/personal/<uid>/<slug>/`) and a promotion *moves the directory out of the lane in the same
commit* that changes the visibility. Lifecycle is expressed in one OS-owned file,
`os/lifecycle/pins.yml`. `os-ui/core/infra/git-objects.ts:115`, `:122`, `:135`, `:144`;
`os-ui/core/infra/lifecycle-pins.ts:55`

The rule to carry into every later section: **what operates reads the pin, not the head.** A scheduled
agent run reads the pinned `system.yaml` out of the repository, and a dashboard's Run view resolves the
pinned spec. Both fail closed, and neither ever falls back to the draft.
`os-ui/ARCHITECTURE.md:1265-1271`

### 1.3 Identity is the architecture

The engine is TypeScript inside os-ui rather than a Python service, and that is an identity decision
rather than a language preference. Every tool call executes as the signed-in `CurrentUser` through the
in-process governed dispatcher, so there is no hop at which a service account could be substituted.

- **One dispatcher.** `handleRpc(user, req, opts)` takes the `CurrentUser` as its first parameter —
  there is no variant that takes a key. `os-ui/core/mcp/server.ts:403-407` Every `tools/call` runs
  inside a `runWithSurface(`mcp:${tool.name}`, …)` scope, so a write it causes is attributed to that
  tool rather than to the process. `os-ui/core/mcp/server.ts:523`
- **Authorisation runs as the acting user.** OPA, fail-closed: an agent can exceed neither its own
  grants nor the rights of whoever runs it. `os-ui/ARCHITECTURE.md:121-122`
- **No service identity in the data path.** A read runs on Trino as the caller's domain principal — or
  as their uid when the SQL touches their own `personal_<uid>` lane, because even the owner is denied
  their own personal table under a domain principal. `os-ui/ARCHITECTURE.md:707-713`;
  `os-ui/tabs/data/lib/store-fqn.ts:62-80`
- **The LiteLLM master key is never in the run path.** `callerCredential` is deliberately not a
  fallback chain ending in the master key: a per-agent virtual key by secret *reference*, else the
  shared agent key, else the caller refuses with `NoRunCredentialError`.
  `os-ui/core/infra/litellm-credential.ts:96-116`, `:118-129` See "How to keep this honest" for the two
  tests that pin it.

### 1.4 Which tool does what

| OS surface | Tool that works | What the OS adds, and where the artefact lands |
|---|---|---|
| Data products | dbt + Dagster + Trino + Iceberg | generates a clonable dbt project per domain in git; Dagster code location `sovereign` loads it; Trino executes as the principal |
| Metrics (labelled KPIs) | dbt `semantic_models:` + `metrics:` | emits the YAML into `models/semantic/`; serves numbers with its own Trino SQL compiler, not MetricFlow |
| Dashboards | Apache ECharts + vendored Superset transformers | dashboard-as-code YAML in git; panels reference metrics by member id |
| Ask the OS | LiteLLM + Langfuse | one trace per turn, governed read tools only, artefacts as MCP `structuredContent` |
| Agents | LangGraph (TypeScript) + Langfuse + LiteLLM | `system.yaml` → `StateGraph`; PostgresSaver checkpoints; approvals are `interrupt()` |
| Software | git + the OS's own SDK | app source tree as a git subtree `apps/<slug>/`; no image builder in the stack |
| Knowledge / Files | OpenSearch + Docling + Presidio | document-level security filters per caller; PII detection on ingest |
| Lifecycle | git | a committed, readable, not-pushable `os/lifecycle/pins.yml` |
| Versioning | git | one generic read-back over the domain repos for every object kind |
| The engineer's door | `git-http-backend` + lighttpd | authenticated git HTTP; the OS writes no git protocol |

> **Not yet true:**
> - **Two of the seven declared engineering tools have no producer.** `ENGINEERING_TOOLS` declares
>   `trino` and `litellm` alongside the five that work (`os-ui/core/engineering/types.ts:23`) and
>   `os-ui/core/engineering/vocabulary.ts:26-27` gives both a noun list, but no adapter emits a section
>   for either: the builders in `os-ui/core/engineering/sections.ts` are `dbtSection`, `dagsterSection`,
>   `langgraphSection`, `gitSection` and `langfuseSection` and nothing else (`:58`, `:128`, `:190`,
>   `:238`, `:291`). The enum has two dead members. Gap-report row T10.
> - **Trino does not authenticate its clients.** `trinoAuthMethod` defaults to `'none'`
>   (`os-ui/core/kernel/config.ts:513`) and the chart sets no value for it, so there is no authenticated
>   `original_user` for the generated impersonation rules to match. The schema-ownership half of
>   `rules.json` bites immediately; impersonation does not. `os-ui/ARCHITECTURE.md:722-728`
> - **`sanitizeIdent` is not collision-free, and it names a security boundary.**
>   `os-ui/tabs/data/lib/store-fqn.ts:38-40` lower-cases and maps every non-alphanumeric run to `_`, so
>   `a.b`, `a-b`, `a_b` and `A_B` all become `a_b`. `personalSchema()` builds `personal_<that>` (`:45-47`)
>   and the dbt generator builds `models/personal/<that>/`, so two principals whose ids differ only in
>   punctuation or case share one Iceberg namespace and collide in the repository. The push door already
>   refuses a lane two principals share; the Trino side has no such withhold. The gap report calls this
>   the one item it would wake someone up for (§4).

---

## 2. The repository layout

### 2.1 One bare repo per domain, on a PVC

There is no new cluster component for git. Each domain gets a **bare** repository at
`<OS_REPOS_DIR>/<domain>.git` — default `/repos`, which is the `os-repos` PVC — with **`main` only**.
The path builder enforces that a domain is a safe single path segment
(`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, no `..`) `os-ui/core/infra/git-store.ts:73-81`, and every
repo-relative file path is checked for a leading slash and for `.`/`..` segments `:84-90`.

The writer is `isomorphic-git` (MIT, pure JS) over `node:fs` — there is no git binary in the os-ui
image and no shell. `:10-11`, `:34-35` The PVC is RWO and os-ui is single-replica, so the in-process
per-repository mutex is a sufficient writer lock. `:16`

Two primitives, and the difference between them is load-bearing. `commitTree` writes the *whole*
desired tree and commits only when the root tree hash changed, which makes regeneration idempotent;
`commitSubtree` replaces exactly one prefix and keeps every other path at its current blob, so an
*empty* file map is how an archive or a delete is recorded. A subtree owner declares its prefix with
`reserveSubtree` so that a whole-tree writer cannot clobber it. `:12-13`, `:19-23`

The boot order in `instrumentation.ts` is therefore load-bearing: data commit hook → agents commit hook
(which reserves `agents/`) → data boot reconcile → agents boot reconcile. If the agents hook fails to
install, the data reconcile is **skipped** rather than allowed to commit the subtree's deletion.
`os-ui/ARCHITECTURE.md:548-555`

One more guard, because it exists for a reason. A commit carrying `OS-Reason: boot-reconcile` that
would delete more than half the files it already tracks in its own scope is **refused** with
`DestructiveReconcileError`. A store can hydrate empty without throwing — that is deliberate, so read
paths degrade rather than 500 — and an empty generated tree committed by a reconcile is indisputably a
bad read rather than a deletion. A human-initiated commit is never subject to the rule.
`os-ui/core/infra/git-store.ts:24-29`, `:478-482`; `os-ui/ARCHITECTURE.md:745-767`

### 2.2 Every top-level directory and what owns it

The authoritative table is `GIT_OBJECT_LAYOUT` (reproduced in [Appendix A](#appendix-a--git_object_layout-verbatim)
and mirrored in [`docs/components/git.md`](components/git.md)). Its paths are **selectors**, exactly as
the code states them: `a/b/` means everything under that directory, `a/b.yml` one file.

| Path | What it is | Owner / writer |
|---|---|---|
| `dbt_project.yml`, `profiles.yml`, `packages.yml`, `macros/`, `tests/generic/` | the domain's dbt project scaffolding, exactly as `dbt parse` wants it. `profiles.yml` is `env_var()` only, with `impersonation_user: env_var('OS_PRINCIPAL')` and **no default**, so a run without a principal fails. | `tabs/data/lib/dbt/commit.ts` — `git-objects.ts:116`; `ARCHITECTURE.md:651-653` |
| `models/<layer>/` | promoted (Domain / Company) dbt models. Model name == physical table name, so FQNs hold. | same generator — `ARCHITECTURE.md:645-648` |
| `models/personal/<uid>/` | the personal lane: un-promoted work, with `+schema: personal_<uid>` | same generator — `git-objects.ts:115` |
| `models/**/schema.yml` | descriptions and the quality rules, as dbt tests (`range` and `not_blank` are generator-shipped generic tests) | same generator — `ARCHITECTURE.md:648-650` |
| `models/semantic/<model>.yml` | the dbt semantic layer: `semantic_models:` + `metrics:`. Personal lane: `models/personal/<uid>/semantic/<model>.yml` | `tabs/data/lib/dbt/commit.ts` via `tabs/data/lib/dbt/semantic/` — `git-objects.ts:121-129` |
| `dashboards/index.yml`, `dashboards/<slug>/` | dashboard-as-code. The index resolves slug → id, because slug ≠ id. Personal lane: `dashboards/personal/<uid>/<slug>/` | `tabs/dashboards/lib/git/commit.ts` — `git-objects.ts:134-138` |
| `agents/index.yml`, `agents/<slug>/` | LangGraph systems. The index is slug → the system's frozen OS id, owner, scope, source version. A directory holds `system.yaml`, `agents/<agent-id>.md`, `graph.json` and `README.md`. Personal lane: `agents/personal/<uid>/<slug>/` | `tabs/agents/lib/git/commit.ts` — `git-objects.ts:143-145`; `ARCHITECTURE.md:524-534` |
| `apps/<slug>/` | an app's whole source tree, written with `commitSubtree` under a boot-time `reserveSubtree('apps/')` | `tabs/software/lib/git-commit.ts` — `git-objects.ts:152-154`; `ARCHITECTURE.md:886-892` |
| `os/lifecycle/pins.yml` | what is **live** in this domain — the pin the OS runs from. Its own reserved subtree. | `core/infra/lifecycle-pins.ts` — `git-objects.ts:164-166`; `lifecycle-pins.ts:54-55` |
| `os/schedules.yml`, `os/sources.yml`, `os/external.yml` | the OS's own record: schedules Dagster turns into `ScheduleDefinition`s, source declarations, and Kafka offsets / API-batch sources that are *listed rather than faked* | the Data tab's generator — `git-objects.ts:114`; `ARCHITECTURE.md:650-651` |
| `os/promotion.yml`, `os/grants.yml` | promotion state and grants — governance metadata, not an object kind. Readable in every clone, never pushable. | OS-owned — `docs/components/git.md:47` |
| `knowledge/<slug>/` | **declared, not written.** See the callout below. | backlog — `git-objects.ts:168-177` |
| `connections/<slug>.yml` | **declared, not written.** Connection *configuration*, never a credential. | backlog — `git-objects.ts:178-187` |

Two generators share one tree without clobbering each other: the dbt generator writes the whole tree
with `commitTree`, the agents and software generators write exactly their prefixes with
`commitSubtree`, and `reserveSubtree` tells the whole-tree writer to keep paths it does not itself
mention. Both primitives are generic — the store holds path prefixes and knows nothing about datasets
or systems. `os-ui/ARCHITECTURE.md:541-547`

`os/` is readable on purpose, and that is a policy rather than an oversight: transparency must never
require write access, and write access must never be the only way to see what the OS did.
`docs/components/git.md:22-27`

### 2.3 The `OS-*` commit trailers

One subject line plus a trailer block. The subject is
`<area>(<domain>): <action> <object> — via <surface>`, built by `commitMessage`; `appendTrailers` joins
an existing trailing block when there is one and **drops** any trailer whose value is empty, so there
is never a fabricated line. `os-ui/core/infra/git-store.ts:267-278`, `:281-292`

```
agents(sales): set schedule cron support — via mcp:commit_agent_files

OS-Action: set schedule cron
OS-Object: sys_7f3a (Support triage)
OS-Surface: mcp:commit_agent_files
OS-Request-Id: req_01J…
OS-Run-Id: run_…           # only when an agent run caused it
OS-Actor: amir             # the principal id, even when the author is a display name
OS-Reason: boot-reconcile  # only when the cause is not a person's action
```

| Trailer | Meaning, and where it is set |
|---|---|
| `OS-Action` | the verb, one line. `git-store.ts:272` |
| `OS-Object` | **one** object as `<id>` or `<id> (<name>)` — what a per-write commit sets. This is the object's *identity*, which is why a rename, a lane move and a delete all stay in one history. `core/infra/git-trailers.ts:13-14`, `:28`; `git-store.ts:273` |
| `OS-Objects` | a **space-separated list** of ids, for a commit that genuinely touched many — the boot reconcile writes a domain's whole `agents/` subtree in one commit and cannot name one object without lying about the rest. A repeated `OS-Object` line is not an option: `parseTrailers` returns a `Record`, so N lines keep only the last. Matching is whole-token, so `sys_a` does not match `sys_ab`. `core/infra/git-trailers.ts:13-21`, `:30`, `:33-36`, `:45-50` |
| `OS-Surface` | `ui:<route>`, `mcp:<tool>`, `git:push` or `boot:reconcile`. Supplied by an `AsyncLocalStorage` request scope (`core/infra/request-surface.ts`); a writer outside any scope is recorded as the tab's default and **logged once as a gap**. `git-store.ts:274`; `ARCHITECTURE.md:567-570`, `:676-679` |
| `OS-Request-Id` | the request that caused it. `git-store.ts:275` |
| `OS-Run-Id` | the agent run this write happened inside — taken from the ambient request scope when the writer does not thread it, so a nested granted-tool call inside a run is attributed without every writer carrying a run id in its signature. Outside a run there is no trailer at all. `git-store.ts:252-258`, `:276-278` |
| `OS-Actor` | the principal id, even when the git author is a display name. `lifecycle-pins.ts:539`; `tabs/software/lib/git-commit.ts:179` |
| `OS-Reason` | only when the cause is not a person's action; `boot-reconcile` is the one value in use, and it is what the destructive-delta guard keys on. `git-store.ts:478-482` |
| `OS-Author-Email` | `synthesized` — set when the user has no e-mail address and the author therefore had to be minted as `<mailbox>@os.local`. Never a silent invention. An id that is already e-mail-shaped keeps only the part before the first `@`, because `amir@acme.com@os.local` is malformed and git writes it verbatim. `git-store.ts:308-313`, `:319-332` |

Author is the acting user; committer is always `{ name: 'Sovereign OS', email: 'os@sovereign.local' }`.
`os-ui/core/infra/git-store.ts:41`

### 2.4 How to clone it

```sh
git clone https://<os-host>/git/<domain>.git
# username: anything (it is ignored)   password: your OS access token
```

The token is created at **Platform → Access tokens** and shown once. Its format is
`sos_<prefix>_<secret>`, where the prefix is 12 hex characters and is the *public* lookup handle, and
the secret is 32 bytes of `randomBytes` as base64url — `/^sos_([0-9a-f]{12})_([A-Za-z0-9_-]{32,64})$/`
is the only shape accepted. `os-ui/core/auth/access-tokens.ts:26-32`, `:44-49` It is stored hashed as
`sha256$<hex>` over the *whole* token string; a slow KDF was rejected because the secret half has no
guessable input to grind and every `git push` would pay for it. `:15-17`, `:51-53` Every message out of
the receive module passes through `redact`, which rewrites any token-shaped substring to
`sos_<prefix>_***`. `:84-88`; `os-ui/core/infra/git-receive.ts:38`

A token acts as exactly one OS identity — yours — and carries no authority of its own: role and domains
are re-read live on every request, so a demotion or an offboarding takes effect on the next command
rather than the next token. It is revocable, expires in 365 days by default, and is never logged or
echoed in an error. `docs/components/git.md:243-254`

To run the project the way the OS does:

```sh
export TRINO_HOST=trino TRINO_PORT=8080 TRINO_USER=dbt-runner OS_PRINCIPAL=<your-principal>
dbt parse --profiles-dir .
dbt build --profiles-dir . --select <model>+
```

### 2.5 What the receive gate refuses, and why

A push is authorised at the ingress by a sub-request to `/api/git/authenticate`, then gated by
`core/infra/git-receive.ts` in two phases. During `pre-receive` the pushed objects live in git's
**quarantine** directory (`GIT_QUARANTINE_PATH`), visible only to the hook's own process tree — so the
**hook**, which runs where git is, computes the fast-forward verdict and the change list with git's own
plumbing (`git merge-base --is-ancestor`, `git diff-tree -r --name-status`, `git cat-file`) and posts
paths plus base64 blobs. The OS reads nothing from the repository during `pre`. At `post-receive` the
refs are updated and the objects are real, so `completeReceive` re-derives the changed files **from the
repository** and ingests those: the hook gates, the repository is the record.
`os-ui/core/infra/git-receive.ts:10-22`

| Refused | Reason, and the constant |
|---|---|
| `os/**`, `macros/**` | `OS_OWNED_PREFIXES`. `os/` is the OS's own voice; a pushed macro runs SQL as the OS's dbt principal on every build. `git-receive.ts:69`, `:342-344` |
| `dbt_project.yml`, `profiles.yml`, `packages.yml`, `agents/index.yml` | `OS_OWNED_FILES`. dbt *executes* the first three (`on-run-start:` SQL, every macro a model calls, the connection, a package fetch); the fourth is the slug → identity map, and rewriting identities is not something a push may do. `git-receive.ts:77`, `:345` |
| someone else's personal lane | a personal lane is the one place the OS promises is yours, whatever your role. A lane two principals **share** (the `sanitizeIdent` collision) is **withheld from both** rather than granted to either. `git-receive.ts:253-283` |
| a non-fast-forward push to `main`, or its deletion | the OS never rewrites a human's history and never accepts a rewrite of it either. `docs/components/git.md:268-270` |
| a push that empties an object's directory | `DESTRUCTIVE_PUSH` — the same rule the boot reconcile applies to itself. Retiring an object is a governed action with a dependents check; `git rm -r` is not it. `git-receive.ts:52-58`, `:305` |
| a pushed `tier` / `visibility` that disagrees with the registry | `AUDIENCE_MANAGED` — audience changes only through promotion. The field is in the file so the file is self-describing; the OS owns the value. `git-receive.ts:66` |
| credential-shaped content | `looksSecretShaped`. Connections hold secrets by reference; `profiles.yml` reads environment variables only. `git-receive.ts:285` |
| a file over 1 MiB, or a push over 16 MiB | `MAX_FILE_BYTES = 1_048_576`, `MAX_PUSH_BYTES = 16_777_216`. A domain repository holds definitions, not artefacts. `git-receive.ts:86-87`, `:748-753` |
| a push while the OS is writing | the lock wait is bounded at `DEFAULT_LOCK_TIMEOUT_MS = 20_000`; on timeout the push fails with a sentence a developer can act on instead of hanging their terminal. A lease (`DEFAULT_LEASE_TTL_MS = 180_000`) expires by itself. `git-receive.ts:80-83` |

Everything the gate *does* accept goes through the validator the UI already calls:
`agents/**/system.yaml` through `parseSystem`, and `models/**/schema.yml` plus every `.sql` model
through the dbt gate. Afterwards `reconcileFromGit(domain, from, to, pusher)` dispatches to each kind's
`ingest` — `tabs/data/lib/dbt/ingest.ts` and `tabs/agents/lib/git/ingest.ts` — writing through the
governed services, attributed to the pusher, inside `runWithSurface('git:push')`.
`git-receive.ts:590`; `os-ui/ARCHITECTURE.md:1223-1229`

Two things the OS deliberately will **not** infer from a push: deleting a file does not delete the
object (retirement is governed), and a push never changes an object's audience — a system an engineer
creates by pushing is `My` / Personal. `docs/components/git.md:324-332`

> **Not yet true:**
> - **Knowledge workflows and connection configurations are not in git at all.** Both kinds have a
>   layout row and an honest `backlog` writer state with a reason.
>   `os-ui/core/infra/git-objects.ts:168-187`
> - **No tags are written by anything.** `annotatedTag` landed in `os-ui/core/infra/git-store.ts` with
>   no caller; neither a release tag (`app/<slug>/v<x.y.z>`) nor a live tag exists in any repository,
>   and `os-ui/core/kernel/go-live.test.ts` asserts `tag.written === false`.
>   `docs/components/git.md:57-60`; gap-report row V3
> - **Branches are not proposals.** `main` is the only ref the server accepts. A `proposal/*` branch
>   surfacing as a promotion request, and PR-like review in the UI, are not built.
>   `docs/components/git.md:424-427`
> - **Only two kinds map back from a push.** Datasets (via `schema.yml`) and agent systems (via
>   `system.yaml`). Metrics, dashboards and apps are written *to* git by the OS, but a push of them
>   changes the files only. `docs/components/git.md:428-435`
> - **The dbt gate is not `dbt parse`.** There is no dbt in the os-ui process. The gate checks valid
>   YAML, `version: 2`, a `models:` list, and a model or column name dbt can resolve — the invariant
>   whose violation breaks the *whole* project. A `ref()` to a name that does not exist is found by
>   Dagster's own `dbt parse` on the pushed commit, not at the door. `docs/components/git.md:436-441`
> - **Conflicts resolve at the git level — last writer wins.** There is no OS-level merge.
>   `docs/components/git.md:220`
> - **A rename or a lane move hides the old path from the path fallback.** A resolver derives its
>   selectors from where the object lives *now*, so commits made under a previous directory are found
>   only by the `OS-Object` trailer. `os-ui/core/infra/git-objects.ts:30-37`
---

## 3. Data products — dbt, Dagster, Trino, Iceberg

**What the user sees.** A dataset with a Bronze / Silver / Gold shape, a schedule, quality rules with
pass-fail results, a lineage graph and a "Run" button. Nothing in the UI says "dbt".

**What actually runs.** A domain's data product *is* a dbt project an engineer could clone and run,
living in that domain's bare repository. Users never edit the repo from the UI; the OS is generator,
committer and reader. Dagster loads the committed project and schedules it. Trino executes it as the
principal. Iceberg tables live in MinIO behind an Apache Polaris REST catalogue.

The generator is pure and byte-stable — sorted keys, one newline, no timestamps — which is what makes
regeneration idempotent and a golden fixture possible. `generateProject(domain, snapshot, opts)` returns
a sorted `Map<path, content>`; `snapshot.ts` is the only impure read.
`os-ui/tabs/data/lib/dbt/generate.ts:31-55`; `os-ui/tabs/data/lib/dbt/snapshot.ts:31-41`, `:53`

The write path is an event seam rather than a direct call, for a reason worth knowing:
`os-ui/tabs/data/lib/store.ts` is reachable from the **client** bundle, so it may not import `node:fs`
or `isomorphic-git` even dynamically. Every writer emits a `ProjectChange` through
`os-ui/tabs/data/lib/project-events.ts:45` and `os-ui/tabs/data/lib/dbt/commit.ts` subscribes at boot.
`os-ui/ARCHITECTURE.md:629-640`

A listener installed at boot sees only writes from then on, and a crash between the store write and the
commit loses that commit — so `boot-reconcile.ts` closes both ends: at startup, for every domain the OS
knows (datasets in the registry ∪ repositories on disk), it commits the difference between the generated
project and the repository head as the platform principal with `OS-Reason: boot-reconcile`. It commits
only where the tree moved, survives one broken domain, launches nothing — and refuses to run at all
unless the registry reports `'hydrated'`. `os-ui/tabs/data/lib/dbt/boot-reconcile.ts:45`, `:138-146`,
`:163`; `os-ui/ARCHITECTURE.md:642-647`

### Where the real artefact is

| Path | When it is written, and what is in it |
|---|---|
| `dbt_project.yml` | always — `generate.ts:34`; `project.ts:27-55` |
| `profiles.yml` | always — `generate.ts:35`; `project.ts:81-111` |
| `README.md`, `.gitignore` | always; the ignore file is `target/ dbt_packages/ logs/` — `generate.ts:37-38`; `project.ts:264` |
| `macros/generate_schema_name.sql`, `macros/os_maintenance.sql` | always. The first returns a custom schema verbatim; the second runs `alter table … execute optimize` plus `expire_snapshots(retention_threshold => '7d')` — `generate.ts:39`; `project.ts:116-127`, `:130-150` |
| `tests/generic/range.sql`, `tests/generic/not_blank.sql` | always — the two generator-shipped generic tests carrying the OS's own quality predicates — `generate.ts:40`; `project.ts:159`, `:179` |
| `models/sources.yml` | iff at least one source — `generate.ts:42`; `sources.ts:23-44` |
| `models/<layer>/<name>.sql`, `models/personal/<uid>/<name>.sql` | per model — `generate.ts:43`; `models.ts:157-159`, `:419` |
| `models/<layer>/schema.yml` | one per **model directory** — there is deliberately no root `models/schema.yml` — `generate.ts:44`; `schema.ts:168-179` |
| `os/schedules.yml` | iff at least one sync model — `generate.ts:46`; `schedules.ts:28-49` |
| `os/external.yml` | iff a Kafka or API-batch sync — `generate.ts:48`; `schedules.ts:51-69` |
| `os/sources.yml` | iff a federated sync source with a resolved catalogue — `generate.ts:50`; `source-assets.ts:58-81` |
| `models/semantic/<sm>.yml` | section 4 — `generate.ts:53`; `semantic/render.ts:54-58` |
| `models/os/os_time_spine_day.sql`, `models/os/schema.yml` | iff any emitted semantic model has a `time` dimension. Model `os_time_spine_day`, column `date_day`, span 2015-01-01 to `current_date + 365d` — `semantic/time-spine.ts:29-37`, `:73-78` |

All paths above are relative to `os-ui/tabs/data/lib/dbt/`.

Names, which is where the FQN contract lives:

| Thing | Rule |
|---|---|
| model name | `<layer>_<physicalSlug>`, and **model name == physical table name** so FQNs hold. A collision becomes `<name>__<sanitizeIdent(id)>`. The layers `bronze\|silver\|gold` are table **prefixes**, never schemas. `models.ts:318-319` |
| `physicalSlug` | `d.slug ?? slug(d.name)` — pinned at the moment of a rename, so a display-name change never moves the physical identity. `store-fqn.ts:12-14`, `:28-30` |
| Trino schema | `personal_<sanitizeIdent(uid)>` or `sanitizeIdent(domain)`. The domain is normalised because a hyphen makes `iceberg.<domain>.<t>` a Trino syntax error and leaves the catalogue reading a schema that can never be created. `store-fqn.ts:38-41`, `:46-48`, `:51-60` |
| model directory | `schema.startsWith('personal_') ? models/personal/<uid> : models/<layer>`; the lane rule is `d.tier === 'dataset'` → personal. `models.ts:150-159` |
| source name | Iceberg → the schema name; federated → `<catalog>__<schema>`; an unresolved catalogue → `conn_<sanitizeIdent(connectionId)>` with `meta: {os_connection, os_catalog: 'unresolved'}` — reported, never guessed. `models.ts:334`, `:355`, `:363` |
| sync batch id | `b_<datasetId>_<yyyymmddHHMM>` UTC, reused on a retry. `launch.ts:87-90` |

Two pieces of generated content are worth reading verbatim, because they are the contract with dbt.

```yaml
# dbt_project.yml — os-ui/tabs/data/lib/dbt/project.ts:27-55
name: sales
version: 1.0.0
config-version: 2
profile: sovereign
model-paths: [models]
macro-paths: [macros]
test-paths: [tests]
clean-targets: [target, dbt_packages]
models:
  sales:
    +materialized: table
    silver: { +schema: sales, +on_table_exists: replace }
    gold:   { +schema: sales, +on_table_exists: replace }
    personal:
      bea: { +schema: personal_bea }
```

Bronze deliberately gets no `+on_table_exists` (`project.ts:33`).

```yaml
# profiles.yml — os-ui/tabs/data/lib/dbt/project.ts:81-111
sovereign:
  target: trino
  outputs:
    trino:
      type: trino
      method: none
      host: "{{ env_var('TRINO_HOST', 'trino') }}"
      port: "{{ env_var('TRINO_PORT', '8080') | as_number }}"
      user: "{{ env_var('TRINO_USER', 'dbt-runner') }}"
      impersonation_user: "{{ env_var('OS_PRINCIPAL') }}"
      http_scheme: "{{ env_var('TRINO_HTTP_SCHEME', 'http') }}"
      catalog: "{{ env_var('TRINO_CATALOG', 'iceberg') }}"
      schema: sales
      threads: 4
```

`OS_PRINCIPAL` has **no default**, so a run without a principal fails (`project.ts:9-11`). `password:`
is spliced in textually after `user:` only when the method is not `none` (`project.ts:103-110`).

**Provenance decides what is a model.** `buildVersion({compiled: true})` records that a body came from
the OS's own compilers, and *only those bodies become dbt models*. An authored body — the free-text
`body` of `add_dataset_version` or the version route — is stored and rendered as a dbt **source**: dbt
reads that table and never rewrites it, so no user-authored text is ever handed to Jinja at `dbt parse`,
and a scheduled `<model>+` run cannot replace someone's table with a copy of the layer below.
`os-ui/ARCHITECTURE.md:666-672`

A Silver or Gold body is the recorded CTAS with `create … as` stripped and every
`iceberg.<schema>.<table>` rewritten to `{{ ref() }}` for a table of this project and
`{{ source() }}` otherwise — `source()` being exactly the governance boundary a cross-domain product
sits behind. `models.ts:183-199`; `os-ui/ARCHITECTURE.md:641-645`

A sync is an incremental model — `delete+insert` on `_batch_id` with a lookback predicate, or `merge`
on the keys (`models.ts:210`, `:232`, `:239-256`):

```sql
{{ config(materialized='incremental', incremental_strategy='delete+insert',
          unique_key='_batch_id', on_schema_change='append_new_columns') }}
select *, current_timestamp as _loaded_at,
       '{{ var("os_batch_id", invocation_id) }}' as _batch_id
from {{ source('wh__public', 'events') }}
{% if is_incremental() %}
where "updated_at" > (select max("updated_at") from {{ this }}) - interval '15' minute
{% endif %}
```

**Quality rules are dbt tests.** A rule becomes a `data_tests` entry under its column: `not_null`,
`unique`, `not_blank`, `accepted_values`, `range` or `relationships`. A column name must match
`/^[A-Za-z_][A-Za-z0-9_]*$/` because it is interpolated **unquoted** into the generated test SQL;
anything else is refused at the store gate and recorded as `meta.os_intentions` — never emitted as a
weaker test. `schema.ts:15-27`, `:55-95`, `:142-179`; `os-ui/ARCHITECTURE.md:672-676`

### Dagster: the `sovereign` code location

One code location, named `sovereign`. The name is not in the Python: it is the Helm user-deployment
name, echoed into every consumer.

| Thing | Value and source |
|---|---|
| code location name | `sovereign` — `charts/sovereign-agentic-os/values.yaml:779`, port 3030 `:787`; echoed as `DAGSTER_RELOAD_LOCATION` `:814`, `:877`; read by os-ui as `config.dagsterLocation = env('DAGSTER_LOCATION','sovereign')` `os-ui/core/kernel/config.ts:535`; repository `__repository__` `:536` |
| the Python | `images/extensions/dagster/repo.py` (446 lines) + `images/extensions/dagster/os_projects.py` (800 lines, no Dagster import). Entrypoint `defs = build_definitions()` — `repo.py:446`, `:210` |
| gRPC args | `["--python-file", "/opt/dagster/app/repo.py"]` — `values.yaml:784-786` |
| asset keys, models | `[<domain>, <node>]` — the default dagster-dbt key `.with_prefix(domain)` via `PrefixedTranslator`, declared as `@dbt_assets(manifest=…, name=f"{dom}_dbt", …)` — `repo.py:77-89`, `:315-320`; `os-ui/tabs/data/lib/dbt/asset-keys.ts:36` |
| asset keys, sources | `[<domain>, <source>, <table>]` — `os_projects.py:369-371` |
| per-domain job | `<sanitize(domain)>__all`, launched by the OS with an explicit asset subset — `os_projects.py:217-219`; `os-ui/core/infra/dagster.ts:191` |
| sync job + schedule | `<sanitize(domain)>__<sanitize(dataset)>`, a UTC `ScheduleDefinition` per `os/schedules.yml` entry — `os_projects.py:210-214`; `repo.py:399-408` |
| maintenance | job `<domain>__maintenance__<schema>` + schedule `…_weekly`, cron `0 3 * * 0` — `os_projects.py:41`, `:222-223`; `repo.py:411-443` |
| observation | `<domain>__observe_<sha256(cron)[:6]>` — `os_projects.py:325-334`; `repo.py:347-376` |
| sensors | `os_quarantine` (a `@run_failure_sensor`, threshold `QUARANTINE_THRESHOLD = 10` consecutive failures) and `os_principals` (a 300 s `@sensor` polling `GET /api/data/projects` with the runtime bearer, pausing the schedules of a principal the OS reports inactive) — `repo.py:242-243`, `:264-265`; `os_projects.py:39`, `:687-696` |
| dbt invocation | `DbtCliResource(project_dir=p.path, profiles_dir=p.path)` per domain, then `dbt build [--vars {"os_batch_id":…}] [--full-refresh]` — `repo.py:312-313`, `:321-334` |
| the validating checkout | the user-code pod's `repo-sync` sidecar fetches each repo over the read-only `git daemon` (Service `os-repos:9418`, NetworkPolicy: Dagster user-code only), runs `dbt parse --profiles-dir . --no-use-colors --quiet` under an allow-listed env, and repoints `current` only on success. A broken commit stays in history; the gate is deployment, as in any CI. `os_projects.py:105-117`, `:140-144`, `:488-490`, `:565-596`; `os-ui/ARCHITECTURE.md:674-678` |
| run identity | connect user `TRINO_USER=dbt-runner` `values.yaml:800`; `OS_PRINCIPAL` injected per run through the `dagster-k8s/config` tag — from the schedule's principal, the maintenance schema's owner, or the principal the OS passed `os_projects.py:602-608`; `OS_PINNED_COMMITS=<domain>=<sha>` tells a run pod (whose `/repos-checkout` `emptyDir` starts empty) which commit to check out `os-ui/tabs/data/lib/dbt/launch.ts:157-179` |
| run tags | `os/dataset`, `os/domain`, `os/principal`, `os/user`, `os/action`, `os/layer`, `os/commit`, optionally `os/surface`, `os/full_refresh`, `os/batch_id` — all principals and shas; **no secret is ever a tag or a repo file**. `launch.ts:157-179`; `os-ui/ARCHITECTURE.md:688-692` |
| the OS's client | `os-ui/core/infra/dagster.ts` — one typed GraphQL client, `Fetched<T>` like the LiteLLM reader, hard timeout, injectable `fetch`, nothing thrown and nothing logged: `launchRun`, `run`, `runsForDataset`, `recentOsRuns`, `assetChecks`, `allAssetChecks`, `latestMaterialization`, `assetGraph`, `reloadLocation`, `nextTick`. An outage is reported as an outage — empty rows and a reason, never a fabricated run and never a fake green. `os-ui/ARCHITECTURE.md:694-701` |

Since B4 nothing in the OS provisions a `batch/v1` CronJob for data: the provisioning module and both
fallback sweep routes are deleted, and all that survives is a delete-only cleanup so an upgrade removes
what a pre-B2 save left behind. `os-ui/ARCHITECTURE.md:668-672`; `launch.ts:241-275`

Quality results come from Dagster asset checks — one dbt test is one check
(`os-ui/tabs/data/lib/dq-status-server.ts`) — and lineage is dbt's graph rather than the OS's memory:
`datasetLineage` reads Dagster's `assetNodes`, which dagster-dbt derives from `manifest.json`'s
`parent_map`, and folds it into the same `LineageGraph` the registry path returns with one additive
field saying which source answered. Reading `target/manifest.json` directly was rejected because it
lives in a pod volume os-ui cannot mount. `os-ui/ARCHITECTURE.md:730-736`

### Trino and the object layout

| Thing | Value |
|---|---|
| catalog | exactly one by default: `iceberg` (`connector.name=iceberg`). `externalCatalogs: []` and `cloudCatalog.provider: ""`, so federated catalogues are absent out of the box. The OPA policy's `internal_catalogs := {"iceberg","system"}` mirrors it. `charts/sovereign-agentic-os/templates/extensions/lakehouse/trino.yaml:220-221`; `values.yaml:1180`, `:1184`; `policies/trino.rego:215` |
| table FQN | `iceberg.<schema>.<layer>_<slug>` — `os-ui/tabs/data/lib/store-fqn.ts:87-95`, `:168-194` |
| how a query is issued | os-ui **never speaks the Trino REST protocol** — there is no `/v1/statement` and no `X-Trino-*` header anywhere under `os-ui/`. It POSTs JSON to the query-tool: `POST ${QUERY_TOOL_URL}/query {sql, principal?, schema?}` with an 8 s timeout and no retry, and `POST /execute {sql, principal, uid, domains, role}` with 15 s. `os-ui/core/infra/governed.ts:117-137`, `:190-214` |
| query-tool → Trino | Python `trino.dbapi.connect(host, port, user=principal, catalog, schema, http_scheme, request_timeout, session_properties={"query_max_run_time"})`, with `QUERY_MAX_RUN_TIME="60s"` and `QUERY_MAX_ROWS=10000`. `images/extensions/query-tool/execute_guard.py:374-386`; `app.py:33`, `:54-55` |
| who runs as whom | derived server-side by `readPrincipalFor(sql, user)`: the caller's uid iff the SQL touches their own `personal_<uid>.`, else `user.domains[0]`. Never trusted from the request body. `store-fqn.ts:62-81`; `os-ui/tabs/data/mcp/data-query-tools.ts:61` |
| two chained access controls | `access-control.config-files=/etc/trino/access-control-opa.properties,/etc/trino/access-control-file.properties` — both must allow, so the second can only narrow. The OPA plugin keeps row filters, column masks and the foreign-`personal_*` deny; the generated `rules.json` adds impersonation and schema ownership. `trino.yaml:57`, `:83-87` |
| `rules.json` shape | `{catalogs:[{allow:'all'}], schemas:[{user?,schema?,owner}], tables:[{user?,schema?,table?,privileges[]}], impersonation:[{original_user,new_user,allow}]}` — **no `group` key**. Personal lanes first and closed, then domains (owner plus read-only), then a catch-all. `os-ui/core/infra/trino-rules.ts:41-51`, `:119-156` |
| the impersonation rules | `^dbt-runner$ → ^(amir\|bea\|cleo\|finance\|sales)$ allow`, then `^dbt-runner$ → .* deny`, then `(.*) → $1 allow`, then `.* → .* deny`. The golden-tested property that matters: the service user can become an OS principal and nothing else — not `root`, not a deactivated user, not `admin; drop`. `os-ui/tabs/data/lib/dbt/fixtures/trino-rules.golden.json:112-131`; `trino-rules.ts:104-114`; `os-ui/ARCHITECTURE.md:715-722` |
| delivery and refresh | ConfigMap `trino-access-rules`, key `rules.json`, mounted as a **directory** (not a `subPath`, so updates propagate), `security.refresh-period=30s`. The os-ui reconciler PATCHes on a byte diff at boot, on a 2 s debounce and on a 10-minute repair. The chart's bootstrap form is permissive (`schemas:[{owner:true}]`) so a fresh install works, and a `helm upgrade` resets it. `trino.yaml:146-149`, `:154`, `:163-208`, `:380-382`; `os-ui/core/infra/trino-rules-server.ts:38-39`, `:58-86`, `:118`, `:158`, `:253` |
| buckets | `langfuse`, `lakehouse`, `sandbox`, `files` — `values.yaml:69-74`; `templates/base/object-storage/bucket-init.yaml:59-65` |
| warehouse | `s3://lakehouse/wh`, registered with Polaris as `default-base-location` with `allowedLocations [BASE, BASE/*]` — `values.yaml:1072`; `polaris-bootstrap.yaml:165`, `:183`, `:196` |
| upload prefixes | `uploads/<sanitizeIdent(uid)>/<file>` in bucket `lakehouse`; the Files tab uses `s3://files/<owner>/` or `s3://files/<domain>/` — `os-ui/tabs/data/lib/object-store.ts:40`; `os-ui/core/kernel/config.ts:142`; `os-ui/tabs/files/lib/asset-schema.ts:145-147` |
| the catalogue | Apache Polaris as an Iceberg REST catalogue: `iceberg.catalog.type=rest`, `uri=http://polaris:8181/api/catalog`, `warehouse=lakehouse`, `security=OAUTH2`, `oauth2.scope=PRINCIPAL_ROLE:ALL`. `apache/polaris:1.1.0-incubating`, realm `default-realm`. **No Hive Metastore, no Nessie.** `trino.yaml:220-228`; `values.yaml:1045-1065`, `:1164-1175` |
| Bronze writer | the data-runner, using PyIceberg (`load_catalog("lakehouse", type="rest", …)`) — dbt never writes Bronze; it is a `source`. `images/extensions/data-runner/app.py:116-132`; `os-ui/ARCHITECTURE.md:641` |

### How to inspect it yourself

```bash
# the whole data product, as a dbt project
git clone https://<os-host>/git/sales.git && cd sales
dbt parse --profiles-dir .                      # needs TRINO_HOST/PORT/USER + OS_PRINCIPAL
dbt build --profiles-dir . --select gold_orders+

# or the native export, which dbt accepts as-is
curl -s .../api/data/project/sales/archive | tar -xz -C /tmp/sales

# what the OS committed, and why
git log --oneline -- models/ os/
git log -1 --format=%B -- models/gold/gold_orders.sql     # the OS-* trailers

# in Dagster: code location "sovereign"
#   asset key  ["sales","gold_orders"]      job  sales__all
#   schedule   sales__<dataset>             sensors  os_quarantine, os_principals
#   on the pod: python /opt/dagster/app/os_projects.py --parse /repos-checkout/sales/current

# in Trino
SHOW SCHEMAS FROM iceberg;                 -- sales, personal_bea, …
SELECT * FROM iceberg.sales.gold_orders LIMIT 10;
```

> **Not yet true:**
> - **Trino does not authenticate its clients, so the impersonation rules have nothing to match.** No
>   `http-server.authentication.type` and no password or JWT authenticator anywhere in `charts/` or
>   `images/`; `http-server.http.port=8080` and `discovery.uri=http://localhost:8080`.
>   `TRINO_AUTH_METHOD` is set nowhere in the chart, so `config.trinoAuthMethod` stays `'none'`.
>   `trino.yaml:44-45`; `os-ui/core/kernel/config.ts:513`; [`docs/components/trino.md`](components/trino.md)`:125-132`
> - **`sanitizeIdent` collides, and the Trino side has no withhold.** Two principals whose ids differ
>   only in punctuation or case share one Iceberg namespace *and* one `models/personal/<uid>/`
>   directory. `os-ui/tabs/data/lib/store-fqn.ts:38-41`; gap-report §4
> - **The resource-group selectors expect a client tag nothing sets.** `trino.yaml:127-132` selects on
>   `domain=<d>`, and no `X-Trino-Source` or client-tag header is set anywhere in the tree.
> - **`os/external.yml` is written and never read.** Zero references in `repo.py` or `os_projects.py`;
>   [`docs/components/dagster.md`](components/dagster.md)`:229` admits it. The Kafka-offset and
>   API-batch sources are *listed rather than faked*, which is the honest choice, but no asset
>   materialises from them.
> - **There are no `@asset_check`s.** The `checks` bundle is freshness checks only
>   (`build_last_update_freshness_checks`); dbt tests surface through dagster-dbt's defaults.
>   `images/extensions/dagster/repo.py:201-206`
> - **Dagster is disabled in the managed overlay.** `values.stackit-managed.yaml:302` sets
>   `dagster.enabled: false` with the comment "the `sovereign-os/dagster:0.2.0` image build failed in
>   the current push run", and pins an image tag containing the unresolved token
>   `0.2.0@sha256:REPLACE-DAGSTER-DIGEST` (`:310`, `:314`). The chart default is `true` at `0.3.1`.
>   Nothing else in the documentation says this.
> - **The parity test proves translation, not rows.** `os-ui/tabs/data/lib/dbt/parity.ts:4-17` compares
>   the SQL the OS runs today with the SQL dbt will run. Because a model body *is* the recorded CTAS
>   after rewriting, it proves the translation is faithful and invertible and catches any future change
>   to the rewriter, the stripper or the lane/FQN mapping — but not that two materialisations agree row
>   for row. That needs `EXCEPT ALL` both ways on a cluster, and it has never been run.
> - **Nothing in the tree has ever run `dbt parse` on a generated project.** Real dbt is not installed
>   anywhere in the repository; the OS's own offline whitelist validator is green over every generated
>   file, which is a different claim. Gap-report §7 rows M2, T9
> - **The OS→Dagster GraphQL call is unauthenticated.** The web UI is gated only by nginx basic-auth on
>   its Ingress. `os-ui/core/infra/dagster.ts:132-138`; `templates/base/ingress.yaml:18-35`
> - **A Secret the Dagster subchart reads is created by nothing in this repository** —
>   `dagster-postgresql`, key `postgresql-password`. `values.yaml:750` names it and no template creates
>   it; `dagster.postgresPasswordLocal` is not an upstream key.
> - **A second, unrelated demo dbt project still ships and still loads.**
>   `images/extensions/dbt/project/` has *no* `impersonation_user`, a default user of `dbt-sales`, a
>   `schema.yml` using the legacy `tests:` key and still mentioning Cube — and it is loaded into the
>   `sovereign` location as `sovereign_demo_dbt` and run as a Helm `post-install` hook.
>   [`docs/components/dbt.md`](components/dbt.md)`:13-14` claims "nothing in the OS path reads it".
>   `images/extensions/dbt/project/profiles.yml:9-19`; `images/extensions/dagster/repo.py:223-229`;
>   `templates/extensions/dbt/dbt-build.yaml:24`
> - **Documentation drift to know before quoting it.**
>   [`docs/components/dbt.md`](components/dbt.md)`:51-53` says `TRINO_AUTH_METHOD` is read through
>   `env_var()` in `profiles.yml` — it is a generator literal; `dbt.md:105-106` states a
>   `dbt-core>=1.8` pin where both Dockerfiles pin `>=1.9,<1.10`;
>   [`docs/components/dagster.md`](components/dagster.md)`:179-180` names image `0.3.0` and a
>   `psycopg[binary]` driver the Dockerfile explicitly forbids;
>   [`docs/components/trino.md`](components/trino.md)`:21` puts `readPrincipalFor` in
>   `core/infra/governed.ts` when it lives in `os-ui/tabs/data/lib/store-fqn.ts:76`;
>   [`docs/components/minio.md`](components/minio.md)`:3-5` says two buckets where there are four, and
>   describes MinIO as never bundled while `objectStorage.mode` defaults to `bundled`;
>   [`docs/components/polaris.md`](components/polaris.md) describes a `relational-jdbc` managed
>   persistence that `values.stackit-managed.yaml` does not configure (the default stays `in-memory`)
>   and a health endpoint on the wrong port. The MinIO Deployment also lives in a file called
>   `seaweedfs.yaml` and no SeaweedFS is deployed.
> - **Carried from the concept audit and still true:** the Files connector's `launchPipelineExecution`
>   targets a job `repo.py` never defines (`os-ui/tabs/files/lib/connectors-server.ts:73`);
>   `sync_quality_to_catalog` does not exist; `list_dags`/`trigger_dag`/`get_dag_run` are an Airflow
>   connection *template*, not an OS capability; volume and schema-drift monitors are deliberately not
>   built because dbt has no native equivalent; the planned deletions of `/execute`,
>   `execute_guard.py`, the demo project and `dbt-build.yaml` have not happened; and
>   `tag_concurrency_limits` on `os/dataset` is not in `repo.py` or the chart.
>   `docs/superpowers/plans/2026-11-13-data-products-concept.md:32`, `:36`, `:42-43`, `:48`, `:83`,
>   `:87-88`, `:146`, `:159`

---

## 4. Metrics — dbt semantic models, and the OS compiler

The folder is `os-ui/tabs/metrics/`; the user-facing label is **KPIs**. Folder names are stable, labels
are not. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

**What the user sees.** A guided path — Define · Refine · Preview · Publish · Monitor
(`os-ui/tabs/metrics/lib/stages.ts:39-74`) — that turns a column and an aggregation into a named KPI
with a number next to it, then a promote button.

**What actually runs.** Two things that are deliberately not the same system. **The artefact** is a dbt
semantic model: `semantic_models:` plus `metrics:` YAML, emitted by six pure modules under
`os-ui/tabs/data/lib/dbt/semantic/` and committed by the same dbt commit path a dataset uses. **The
number** is computed by the OS's own SQL compiler against Trino, as the viewer. MetricFlow is never on
the request path.

The spec version is pinned in one constant, because the published dbt documentation cannot be trusted
for it: `docs.getdbt.com` serves the 1.12 ("Fusion") spec by default and its `?version=` selector is
client-side only, so a fetch always returns a breaking redesign of this exact spec. The authoritative
source is the `dbt-semantic-interfaces` pydantic spec at the version dbt-core pins.
`os-ui/ARCHITECTURE.md:1044-1051`

| Pinned constant | Value |
|---|---|
| `dsiVersion` | `'0.8.5'` — `os-ui/tabs/data/lib/dbt/semantic/spec.ts:27-40` |
| `dbtCore` / `minDbtCore` | `'1.10'` / `'1.9'` |
| `imagePin` | `'dbt-core>=1.9,<1.10'` |
| `METRIC_TYPES` | `['simple','ratio','cumulative','derived','conversion']` — `spec.ts:77` |
| `AGGREGATION_TYPES` | nine entries — `spec.ts:47-57` |
| `DIMENSION_TYPES` | `['categorical','time']` — `spec.ts:85` |
| `SEMANTIC_NAME_RE` | `/^[a-z_][a-z0-9_]*$/` — `spec.ts:108` |
| `timeSpineProperty` | `'time_spine'`; the legacy `metricflow_time_spine` model is never emitted — `spec.ts:27-40` |

Three invariants shape the emitter, and each cost somebody real debugging time.

**dbt names are project-global.** Two datasets each with a `revenue` measure, or a metric name used
twice, fails `dbt parse` for the *whole* domain — every other dataset included. So every measure and
metric name goes through one allocator per namespace, shared across the domain, which qualifies a
collision with the semantic model's name (`sales__draft_signups__revenue`), and the OS identity is
carried in `config.meta.os_metric` / `os_member` rather than in the name. Measures and metrics are
*separate* namespaces: a measure and its `type: simple` metric sharing a name is the canonical dbt
shape, not a collision. `os-ui/ARCHITECTURE.md:1052-1058`;
`os-ui/tabs/data/lib/dbt/semantic/from-measures.ts:73-94`

**One unknown key takes the domain down, so validate before writing.** `validateSemanticDoc` runs on
the plain object the emitter produces — not a parallel model that could drift — and `render.ts` *drops*
a document with violations and records them as refusals rather than emitting something that fails the
parse. The validator is a key/enum **whitelist**, so an unknown DSI key is a violation.
`os-ui/tabs/data/lib/dbt/semantic/validate.ts:108`; `render.ts:77-83`; `os-ui/ARCHITECTURE.md:1059-1063`

**dbt renders YAML through Jinja before reading it.** Authored prose goes through `stripJinja`; the one
field that must keep its Jinja is `filter:`, so it is held to a closed grammar —
`{{ Dimension('e__d') }} <op> <literal>`, conjunctions only, no Jinja delimiter in the literal. A
predicate outside that grammar refuses the whole metric rather than emitting a weaker filter.
`validate.ts:67-71`; `os-ui/ARCHITECTURE.md:1064-1069`

### Where the real artefact is

| Thing | Where |
|---|---|
| the YAML, domain lane | `models/semantic/<semanticModel>.yml` — `os-ui/tabs/metrics/lib/git-object.ts:51-53` |
| the YAML, personal lane | `models/personal/<uid>/semantic/<semanticModel>.yml` — `git-object.ts:56-58`. Both lanes are always returned together, because a promotion moves the file and a history stopping at the move would hide everything before it (`:69-76`). |
| which lane | decided by `semanticPathFor()`, keyed off `model.schema.startsWith('personal_')` — `os-ui/tabs/data/lib/dbt/semantic/render.ts:54-58` |
| the file basename | `semanticModelName()` — one accessor, so the path and the content cannot diverge; the lane uid is `sanitizeIdent(owner)`. `os-ui/tabs/metrics/lib/model.ts:134-136`, `:143-145` |
| the commit trailer | `OS-Object: metric:<datasetId>.<measure>` via `metricObjectId()`. A dataset-shaped trailer would make every metric's history empty. `os-ui/tabs/data/lib/dbt/commit.ts:127-140`; `os-ui/tabs/metrics/lib/git-object.ts:61-63` |
| the canonical member | `<viewName-without-spaces>.<measure.name>` — frozen, the single source of the number. The source comment reads: "Changing this formula would split the number — don't." `os-ui/tabs/metrics/lib/model.ts:123-125` |
| the metric id | `<datasetId>.<measure.name>` — `os-ui/tabs/metrics/lib/governance.ts:54`; `os-ui/tabs/metrics/lib/store.ts:53` |
| Trino target | catalog `iceberg`, schema `personal_<uid>` (tier `dataset`) or `<sanitised domain>`, table `gold_<physicalSlug>` — `os-ui/tabs/metrics/lib/build/explore-server.ts:59-62` |
| durable state | OpenSearch, not Postgres: `os-metric-lifecycle` (`os-ui/tabs/metrics/lib/lifecycle.ts:69`) and `os-alert-rules` (`alert-store.ts:39`). A metric has no store row of its own — it *is* a measure on a dataset (`store.ts:9-15`). |

The emitted YAML is pinned byte-for-byte by a golden fixture
(`os-ui/tabs/data/lib/dbt/fixtures/metrics-semantic-layer.golden.json:14`, key
`"models/semantic/sales__orders.yml"`). Abridged, but verbatim in shape:

```yaml
semantic_models:
  - name: sales__orders
    description: Web-shop orders, one row per order.
    model: ref('gold_orders')
    defaults:
      agg_time_dimension: order_date
    entities:
      - name: orders
        type: primary
        expr: order_id
    dimensions:
      - name: order_date
        type: time
        type_params:
          time_granularity: day
        expr: order_date
    measures:
      - name: revenue
        agg: sum
        description: Net revenue booked.
        expr: net_amount
        label: Revenue
      - name: customers
        agg: count_distinct
        expr: customer_id
        config:
          meta:
            os_agg: count_distinct_approx
metrics:
  - name: aov
    type: ratio
    type_params:
      numerator: revenue
      denominator: orders
    label: Average Order Value
    config:
      meta:
        os_dataset: ds_orders1
        os_member: sales__Orders.aov
        os_metric: ds_orders1.aov
  - name: revenue_eu
    type: simple
    type_params:
      measure: revenue_eu
    filter: "{{ Dimension('orders__region') }} = 'eu'"
  - name: revenue_t7d
    type: cumulative
    type_params:
      measure: revenue_t7d
      cumulative_type_params:
        window: 7 day
```

Two details worth naming. The OS→dbt aggregation map is explicit — `avg → average`, and
`count_distinct_approx → count_distinct` **plus** `config.meta.os_agg`, so the approximation is recorded
rather than lost (`from-measures.ts:44-53`). And the OS-side classifier that decides the dbt metric
*type* is one function: a rolling window becomes `cumulative`, a non-numeric measure `simple`, a
canonical `1.0 * {a} / {b}` expression `ratio`, anything else `derived`
(`os-ui/tabs/metrics/lib/model.ts:431-437`).

### The compiler: what serves the number

`os-ui/tabs/metrics/lib/explorer.ts` compiles one governed Trino `SELECT` per metric read. Its own
header states the position plainly: *"The OS compiler is not MetricFlow and does not pretend to be."*
`explorer.ts:279-283`

| Step | Code |
|---|---|
| entry point | `previewTrinoSql(dataset, measure, spec, readTarget)` — `explorer.ts:254-273` |
| slice → spec | `exploreSpec()` reconciles requested members against `viewMembers(dataset)` and records every dropped member on `spec.dropped` — never a silent de-dimensioning. `:45-84`, `:62-72` |
| the aggregate | `baseAggExpr()`: `COUNT(*)`, `COUNT(DISTINCT …)`, `approx_distinct(…)`, `SUM/AVG(CAST(… AS double))`, `MIN/MAX`; a guided filter becomes `FILTER (WHERE …)`; a ratio expands its siblings *one level* with every divisor wrapped `NULLIF(…, 0)`. `:106-146` |
| windows | `windowTrinoSql()` + `windowFrame()`: `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` or `ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW`, and it *requires* the window unit to equal the slice granularity. `:176-199`, `:214-237` |
| grouping | `date_trunc('<granularity>', "<timeCol>")`, `GROUP BY 1,2,…`, `LIMIT spec.limit ?? 100`. `:228`, `:263`, `:267`, `:272` |
| refusals | `ServeRefusal` with the codes `window_needs_time_dimension`, `window_grain_mismatch`, `unservable_shape`. `:285-327` |
| execution | `exploreMetric()` → `propagate(token)` (throws unless user-delegated) → compile → `queryRun(sql, identities.trino.user)` — `os-ui/tabs/metrics/lib/build/explore-server.ts:144`, `:189`, `:195`, `:216` — over `POST ${config.queryToolUrl}/query` with `{sql, principal, schema}`, default `http://query-tool:8000`. `os-ui/core/infra/governed.ts:117-158`; `os-ui/core/kernel/config.ts:116` |

No SQL comments are ever emitted, because the governed executor rejects `--` and `/* */`
(`explorer.ts:269-271`).

**The MetricFlow licence floor is a CI gate, not a note.** `scripts/metricflow-floor.mjs` enforces
`METRICFLOW_FLOOR = '0.209.0'` — the first Apache-2.0 release — because *"those releases are Business
Source License 1.1 and the BSL's Additional Use Grant excludes exactly this product's use — and BSL
does not relax retroactively, so the relicensing to Apache-2.0 at v0.209.0 is NOT backdated"*. An
unpinned mention is also a violation, and `dbt-metricflow` (the extras package) counts the same.
`scripts/metricflow-floor.mjs:6-19`, `:18`, `:33`, `:80` It runs as pass 3 of
`scripts/license-check.sh:150-159` and is invoked from `.github/workflows/license-gate.yml:37-38`; the
deny-list carries `BUSL` and `BSL-1.1` as SPDX ids (`licenses/denied-licenses.txt:11-12`). MetricFlow
is **not installed anywhere today**, and the floor test treats absence as a pass rather than a skip
(`os-ui/tabs/data/lib/dbt/semantic/metricflow-floor.test.ts:78`).

### MCP tools

| Tool | What it reads and writes |
|---|---|
| `suggest_metrics` | reads the operating manual, processes and visible datasets; writes **nothing** — "A draft is NOT a metric". `os-ui/tabs/metrics/mcp/metric-write-tools.ts:123`, `:137-140` |
| `preview_metric` | builds a draft dataset in memory and calls `exploreMetric`; persists **nothing**, returns rows + `sql` + `mode`. `:264`, `:332-335` |
| `define_metric` | `defineMeasure(datasetId, …)` → a store upsert keyed by measure name → `persist(…)` → the project-change hook regenerates the project and commits `models/semantic/<model>.yml` (personal lane where applicable). It also runs `buildMetric` to verify the number resolves, and returns the scaffold YAML. `:165`, `:247-258`; `os-ui/tabs/data/lib/store.ts:1446-1474` |
| `promote_metric` | a creator-owner files `{kind:'artifact_promote'}` into the approvals queue and **writes no git**; a builder or above calls `governMetric` then `transitionDataset`, which moves the dataset's tier and therefore moves the semantic file between lanes in the next regeneration commit. `:345`, `:370-394` |
| `list_metrics` | derived from datasets, DLS-scoped; each row carries `metricType` and `grain`. `os-ui/tabs/admin/mcp/discovery-read-tools.ts:314`, `:322` |
| `query_metric` | `getMetric` → `delegate(claimsFromUser(…), 'domain')` → `exploreMetric`. It **withholds** the scalar when the row bound was hit, rather than flagging it: "A flagged wrong number still gets read, copied and pasted into a slide; an absent one with a reason cannot be." `:325`, `:386-420` |

### How to inspect it yourself

```bash
# the metric artefact, in a clone
git show main:models/semantic/sales__orders.yml
git log --oneline -- models/semantic/ models/personal/<you>/semantic/

# the metric's own history, by identity rather than by path
git log --grep='OS-Object: metric:ds_orders1.revenue'

# what dbt makes of it (needs a dbt install; there is none in this stack)
dbt parse --profiles-dir .
python -c "import json;print([n for n in json.load(open('target/manifest.json'))['metrics']])"
```

> **Not yet true:**
> - **The honesty gate that suppresses synthetic numbers is inert on a real deployment.**
>   `metricsMustBeLive()` is `config.deploymentProfile !== 'local'`
>   (`os-ui/tabs/metrics/lib/build/explore-server.ts:44-46`), and `deploymentProfile` is
>   `env('OS_PROFILE', 'local')` (`os-ui/core/kernel/config.ts:596`) with `OS_PROFILE` set **nowhere**
>   in `charts/`, `values*.yaml`, `deploy/` or `scripts/` — and `config.ts` says so itself, twice: "the
>   live deploy runs `OS_PROFILE=local` yet with `NODE_ENV=production`, so a profile-keyed guard would
>   be inert exactly where it matters" (`:655-658`, `:672-676`). So on the deployed cluster an
>   unreachable Trino does **not** return `mode: 'unavailable'` with an empty row set; it returns
>   `mode: 'offline-mock'` with hash-seeded rows from `Math.abs(h % 90000) + 10000` over a hard-coded
>   `['DE','FR','US']` (`explore-server.ts:69-84`). The mode *is* surfaced on every tile, so the number
>   is labelled rather than disguised — but it is synthetic, and the guard written to stop exactly that
>   was keyed on the one variable the deployment does not set. **This is the most consequential single
>   finding on this page.**
> - **The SQL identifier gate lives one layer out from the boundary it guards.** `explorer.ts:228` and
>   `:263` write `date_trunc('${spec.granularity}', "${timeCol}")` and `:158` writes
>   `CAST("${col}" AS varchar) IN (…)`, and none of them checks anything locally: `assertColumn` exists
>   only at define time (`os-ui/tabs/metrics/lib/model.ts:95`, `:103-110`) and the runtime allow-list
>   (`PANEL_TIME_GRAINS`, `assertServableFilters`) lives at the *dashboards* door. There is no un-gated
>   caller today; the architecture's own rule is that a gate living in three call sites is missing from
>   the fourth. Filter values are escaped by doubling quotes (`explorer.ts:157`), not bound. Gap-report
>   row M11 and §5's only MEDIUM finding.
> - **The compiler resolves no joins.** Every metric `SELECT` is single-table over one gold mart; a
>   cross-dataset metric is pushed back to the Data tab — "build a curated/joined dataset in Data first
>   — never an invented join" (`os-ui/tabs/metrics/mcp/metric-write-tools.ts:127`). dbt entity joins are
>   explicitly out of scope (`docs/superpowers/plans/2026-11-14-metrics-dashboards-chat-software.md:526`,
>   `:684-686`).
> - **A trailing window counts buckets, not calendar units.** Without a time spine, "last 7 days" means
>   "the last 7 buckets that happen to exist", and the result carries that warning rather than hiding it.
>   `os-ui/tabs/metrics/lib/build/explore-server.ts:100-109`; `explorer.ts:193-198`
> - **There is no MetricFlow parity oracle.** No file, no test, no `mf query` execution anywhere — the
>   only in-code reference is a forward-looking comment
>   (`os-ui/tabs/data/lib/dbt/semantic/from-measures.ts:17`). The separate
>   `os-ui/tabs/data/lib/dbt/parity.ts` harness compares the dbt model body with the OS's recorded CTAS
>   and explicitly cannot prove row equality. A future differential must exclude zero-denominator rows,
>   because the OS wraps divisors in `NULLIF` and MetricFlow's `ratio` does not. Gap-report row M15
> - **The metric lifecycle overlay commits nothing.** `archiveMetric`, `unarchiveMetric` and
>   `moveMetric` write only flags into the OpenSearch overlay and reach no commit primitive, and
>   "promote" has no metric-shaped commit either — so a metric's archive state and folder exist in no
>   file. Define, upsert, label and remove do own files. `os-ui/tabs/metrics/lib/lifecycle.ts:148`,
>   `:212`, `:219`; gap-report row M7
> - **`promote_metric` has no MCP-parity case**, unlike `define_metric`. Gap-report row M8
> - **A pushed metric YAML is read but not applied.** The ingest's `IngestedMetric` lacks `agg`, so
>   `agg`/`expr`/`filter` are reported rather than applied; only the display label lands.
>   `os-ui/tabs/data/lib/dbt/semantic/receive.ts:18-25`; gap-report §3 item 14
> - **The row-level-security proof is simulated.** The two-viewers test stubs the executor with a region
>   filter rather than exercising Trino RLS, and `dbt parse` has never run against a generated project.
>   Gap-report §7 rows M2, M10
> - **No `mf export` exists**, so an `exports:` block is portable documentation and the docs must not
>   imply dbt runs it. Plan `:756-758`
> - **Doc/code divergence on the define gate.** `os-ui/tabs/metrics/context.md:20` and
>   `define_metric`'s own description say the dataset must already be a governed asset; the code
>   requires only a *built* Gold of any tier, so personal-gold metrics are supported.
>   `os-ui/tabs/data/lib/metrics.ts:124-143`; `os-ui/tabs/data/lib/store.ts:1449-1452`
> - **The images run dbt 1.9, not the pinned 1.10**, and `spec.ts`'s own header comment contradicts its
>   constants on this point. `os-ui/tabs/data/lib/dbt/semantic/spec.ts:14` vs `:17-19`, `:35`
---

## 5. Dashboards — dashboard-as-code and vendored Superset

**What the user sees.** A grid of tiles — a big number, a line, a bar, a pie, a table — with filter
chips, drill-down and expand. Nothing on the page is a SQL editor.

**What actually runs.** A dashboard is a YAML file in the domain repository. Rendering is Apache ECharts
5.6.0 driven by a small, vendored slice of Apache Superset's *pure* transformers. Numbers come from the
metric path in section 4 — one governed Trino `SELECT` per panel member, resolved live as the viewer.

Four literal constants shape the layout: `DASHBOARDS_PREFIX = 'dashboards/'`,
`PERSONAL_DIR = 'personal'`, `API_VERSION = 'os.sovereign/v1'`, `UNRESOLVED_REF = 'unresolved'`.
`os-ui/tabs/dashboards/lib/git/generate.ts:34`, `:37`, `:40`, `:43` The directory is
`dashboards/<slug>` or `dashboards/personal/<ownerToken>/<slug>` (`:77-80`, `:86`), and the slug is
derived from the dashboard's *name* with a numeric suffix on collision — so **slug ≠ id**, and the slug
is not stable across a rename (`:81-84`). `ownerToken` is the first 12 hex characters of
`sha256(principal id)`, deliberately opaque: the index file travels to every mirror and clone, so it
must not carry a username or an e-mail address. `os-ui/tabs/dashboards/lib/git/snapshot.ts:36-38`;
`generate.ts:224-253`

The one structural guarantee is that a dashboard file cannot smuggle a query past the metric registry.
`FORBIDDEN_KEYS = ['sql','query','rawsql','expression','adhoc','subquery','datasource']` is enforced by
the parser on every push and import. `os-ui/tabs/dashboards/lib/git/parse.ts:63`, `:65-83`

### Where the real artefact is

| Artefact | Where |
|---|---|
| `dashboards/index.yml` | slug → frozen id, path, name, opaque owner token, scope, tier, view, panel count, folder, and the live ref when there is one — `generate.ts:343`, `:224-253` |
| `dashboards/<slug>/dashboard.yaml` | the dashboard itself — `generate.ts:330` |
| `dashboards/<slug>/README.md` | generated prose — `generate.ts:331` |
| panel ids | `p_<slug(name)>`, with `-<n>` on collision — `snapshot.ts:124-130` |
| viz types | `VIZ_TYPES = ['big_number','big_number_total','line','area','bar','pie','table']` — declared as an array so there is something to check at runtime, and the MCP enum spreads the same array with a drift tripwire. `os-ui/tabs/dashboards/lib/model.ts:37`; `mcp/dashboard-write-tools.ts:140`; `honesty.test.ts:47-53` |
| filter operators | `SERVABLE_FILTER_OPERATORS = ['equals','in']` — `model.ts:110`; `parse.ts:103-110` |
| time grains | `PANEL_TIME_GRAINS`, carrying a compile-time assertion that it still equals the metrics `Granularity` union — `model.ts:59`; `os-ui/ARCHITECTURE.md:875-879` |
| registry mirror | OpenSearch `os-dashboards`, version log `os-versions-dashboard` — `os-ui/tabs/dashboards/lib/store.ts:54`; `os-ui/core/kernel/versioning.ts:79`. No Postgres. |
| commit subject | `dashboards(<domain>): <action> <object> — via <surface>`, default surface `ui:dashboards`, byte-identical to the kernel's `commitMessage` by assertion — `os-ui/tabs/dashboards/lib/git/commit.ts:48`, `:66-76`; `commit.test.ts:70-71` |

The emitted file is pinned by a golden fixture and asserted byte-equal to the generator
(`os-ui/tabs/dashboards/lib/git/generate.test.ts:125-180`). The header is part of the artefact, because
it is what an engineer reads first:

```yaml
# A Sovereign OS dashboard, as code. Generated by the OS; safe to hand-edit and push back —
# the receive gate validates this file with the SAME schema the UI and the MCP use.
#
# `spec.sources[].ref` is a STABLE OS ID (`metric:<id>` / `dataset:<id>`). A panel addresses
# governed metric members ONLY: there is no SQL field, and there never will be, so a dashboard
# file cannot smuggle a query past the metric registry. Every number is still resolved live,
# as the VIEWER, with that viewer's row-level security applied.
apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: dash_sales_overview_ab12cd
  name: Sales Overview
  domain: analytics
  owner: fc4a050fe512   # opaque token for the owning principal (sha256 prefix)
  tier: domain          # personal | domain | marketplace (the AUDIENCE ladder)
  folder: '/weekly'
spec:
  view: Orders
  sources:
    - ref: dataset:ds_orders_gold
      view: Orders
    - ref: metric:met_orders_revenue
      member: Orders.revenue
  filters:
    - member: Orders.region
      operator: equals
      values: [DE]
  panels:
    - id: p_revenue-over-time
      name: Revenue over time
      viz: line
      metrics: [Orders.revenue, Orders.order_count]
      timeDimension: Orders.order_date
      timeGrain: month
      gridPos: { x: 0, y: 0, w: 8, h: 2 }
```

A panel references a metric **by governed member name**, in a field literally called `metrics`
(`generate.ts:139`); the stable OS id lives only in `spec.sources[]` and is keyed back by member
(`parse.ts:185`, `:217`) against the grammar `^(metric|dataset):[A-Za-z0-9._:-]+$` or `unresolved`
(`parse.ts:178`). An import with an unresolvable ref is refused by name and never rebound to something
plausible (`parse.ts:304-321`).

`spec.layout` is deliberately **not** emitted — the parser still reads a `layout.items[]` block and
refuses one that disagrees with `gridPos`, so a hand-authored file can carry it, but the OS does not
write two descriptions of the same thing. `generate.ts:212-219`; `parse.ts:238-268`

### The chart surface

`os-ui/core/ui/charts/` is the **only** place the OS registers ECharts. Before night run 2 there were
three independent `echarts.use([…])` call sites, each with its own tree-shaken bundle, theme bridge,
number formatter and canvas lifecycle — which is how the same number came to be drawn three slightly
different ways.

| File | What it owns |
|---|---|
| `register.ts` | the single `echarts.use([…])` — Line, Bar, Pie, Grid, Tooltip, Legend, `CanvasRenderer` — and `initChart`; the only module allowed to name the `echarts` package. `:20-26`, `:34-36` |
| `theme.ts` | the CSS-custom-property → concrete-colour bridge; `resolveChartColors` is pure, so it is tested without a DOM |
| `format.ts` | `leaf` · `num` · `fmtCompact` · `fileSlug` · `toCsv` — one formatting rule for the whole product |
| `spec.ts` | the pure `ChartSpec → EChartsOption` builder and `fromRows`; pie is built locally, line/area/bar delegate to the vendored `transformTimeseries`. `:93-109`, `:129-181` |
| `Chart.tsx` | a shell: canvas lifecycle, resize, dispose, point click. No option building. `:46-52` |

**The vendored Superset slice** is the one carve-out from "never copy upstream source into this repo".
It is `os-ui/vendor/superset/`, exactly four files — `README.md`, `echarts/types.ts`,
`echarts/series.ts`, `echarts/timeseries.ts` — carrying `sortAndFilterSeries`, `extractSeries`,
`formatSeriesName`, `getChartPadding`, `dedupSeries`, `getAxisType`, `transformSeries` and
`transformTimeseries`, Apache-2.0 into Apache-2.0, pinned to `apache/superset` @
`c83fb2bb1dcfac41ac51bcebd82471f4a7180d18` (tag 6.1.0). `os-ui/vendor/superset/README.md:16-20`;
`series.ts:156`, `:278`, `:338`, `:392`, `:428`, `:442`; `timeseries.ts:155`, `:212`

Three traps are recorded and worth repeating, because each is a specific way this would rot: `npm i`-ing
an `@superset-ui/*` package installs a second React tree (every one was last published 2024-12-10 and
peers on React `^16.13.1` against this repo's React 19); the vendored tree imports **nothing**, so
lodash's `orderBy`/`sumBy` are reimplemented locally with lodash's own null-last ordering; and a
TypeScript `enum` anywhere a test reaches is refused by Node's type-stripping loader, so upstream enums
became `as const` objects plus a union type of the same name. Superset's default branch also sorts
series reverse-alphabetically, so the OS passes `seriesOrder` to keep the measure order the panel author
declared. `os-ui/ARCHITECTURE.md:836-852`

### Panel → metric → rows, at render time

1. `DashboardGrid.tsx` builds the queried panel and `POST`s it to `/api/dashboards/panel-query` with a
   30 s abort. `os-ui/tabs/dashboards/ui/DashboardGrid.tsx:107`, `:120-126`
2. The route gates with `requirePrincipal`, mints a `delegatedToken('domain', …)` and calls
   `runPanelQuery`. `os-ui/app/api/dashboards/panel-query/route.ts:22`, `:34-37`
3. `runPanelQuery` propagates the token, normalises the panel, runs `assertServableFilters`, then
   resolves each member: `listMetrics(user)` → match on `.member` → `getMetric(summary.id, user)`. An
   unresolved member is pushed onto `missing` and surfaced as a loud warning, never dropped.
   `os-ui/tabs/dashboards/lib/build/panel-query.ts:54-67`, `:114-117`, `:140`, `:182-183`, `:216`,
   `:234-243`
4. Each resolved member goes to `exploreMetric` — the section-4 Trino path — and the rows are merged by
   slice key. `panel-query.ts:116`, `:190-207`
5. `PanelChart.tsx` maps rows through `panelChartSpec` → `buildChartOption` → `<Chart>`.
   `os-ui/tabs/dashboards/ui/PanelChart.tsx:62-65`, `:156`

**Three honesty lines, never merged.** A table can be clipped by the backend, *and* not sliced as asked
(a dimension the governed view does not expose was dropped), *and* longer than the view shows. Those are
three separate facts with three separate sentences — `message` (the backend's, verbatim), `warning` (the
tool's own loud degradation, verbatim) and the view's own row-cap note — and `rowCount` always stays the
tool's count, never `rows.length`. `os-ui/ARCHITECTURE.md:1176-1181`

### How to inspect it yourself

```bash
git show main:dashboards/index.yml
git show main:dashboards/sales-overview/dashboard.yaml
git log --oneline -- dashboards/sales-overview/

# the panel's own query, by hand: resolve the member, then run the metric
# (the dashboard file deliberately contains no SQL to copy)
query_metric { metricId: "ds_orders.revenue", grain: "month" }
```

> **Not yet true:**
> - **A dashboard is not a Superset artefact and is not importable by Superset.** The engineering view
>   says so on the panel itself, alongside: "Layout, a native filter bar, tabs, a dashboard-level time
>   range and a pivot table are NOT built yet." `os-ui/tabs/dashboards/lib/engineering.ts:148-149`
> - **The lifecycle pin points at a content digest, not a commit.**
>   `os-ui/tabs/dashboards/lib/lifecycle-adapter.ts:10-13`, `:45-48` states "A dashboard is not
>   git-backed today … so its lifecycle ref is a CONTENT DIGEST of the spec — `spec:<12 hex>` of
>   canonical JSON", which sits oddly beside the `GIT_OBJECT_LAYOUT` row's `committed` writer state: the
>   *files* are committed, but the pin does not name a sha.
> - **One write tool only.** `dashboardWriteTools` holds exactly `create_dashboard`;
>   `update_dashboard`, `add_chart`, `remove_chart`, `render_dashboard_data`, `delete_dashboard` and
>   `archive_dashboard` do not exist. `os-ui/tabs/dashboards/mcp/dashboard-write-tools.ts:117-201`;
>   `os-ui/tabs/dashboards/manifest.ts:19`
> - **A deleted `dashboard.yaml` in a push is never acted on**, and a pushed audience tier is read and
>   then discarded — both deliberate, because retirement and promotion are governed actions.
>   `os-ui/tabs/dashboards/lib/git/receive.ts:103-105`; `git/ingest.ts:39-47`
> - **Report delivery is in-app only.** "In-app is the only delivery channel (email/Slack were UI
>   fiction, no real path)", and the previous `sendReport()` "only advanced `lastSentAt` … nothing was
>   ever sent". `os-ui/tabs/dashboards/lib/reports.ts:15`; `delivery.ts:9-17`
> - **There is no real ECharts time axis.** `spec.ts` always forces a categorical x-axis, and a test
>   asserts the chart "must not claim to be a time axis it did not get".
>   `os-ui/core/ui/charts/spec.ts:162-165`; `os-ui/tabs/dashboards/lib/chart-spec.test.ts:57` Scatter and
>   step series are reachable in the vendored `transformSeries` but neither chart type is registered, so
>   they are latent rather than broken. `os-ui/vendor/superset/echarts/timeseries.ts:174`, `:190-194`;
>   `os-ui/core/ui/charts/register.ts:26`
> - **The committed SBOM lists no `echarts` component at all** (137 components, zero matches) and
>   carries a `package-lock.json` path from a different agent worktree, so it was generated from a dirty
>   tree. `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md` and `os-ui/core/kernel/licenses.ts` *do*
>   carry the row. Gap-report row X11
> - **The Superset Helm chart is still in the stack.** Removing it is tied to this stream's completion,
>   and the stream's own MUST list is priced at roughly 41.5 engineer-days. Plan `:1372-1373`, `:519`;
>   `values.stackit-managed.yaml:282-288`
> - **Four API routes still carry stale "Cube" prose** in their header comments, two lines above the
>   code that calls Trino. The tab's own files were cleaned; the routes were not.
>   `os-ui/app/api/dashboards/route.ts:15`; `panel-query/route.ts:16-19`; `build/route.ts:16`;
>   `[id]/route.ts:17`, `:72`
> - **Every dashboard git write is gated on one flag** — with `DATA_PROJECT_GIT=false`,
>   `commitDashboards` returns `null` and nothing is written at all. It is `true` by default.
>   `os-ui/tabs/dashboards/lib/git/commit.ts:81-83`, `:132`; `os-ui/core/kernel/config.ts:497`
> - **The synthetic-number caveat from section 4 applies here too**, because a panel's rows come from
>   `exploreMetric`. On a deployment where `OS_PROFILE` is unset, an unreachable Trino yields hash-seeded
>   mock rows labelled `offline-mock`; the tile shows the label (and "mixed · N live / M mock" when a
>   dashboard has both), so it is disclosed — but it is not an outage, which is what the gate was written
>   to produce. `os-ui/tabs/dashboards/ui/DashboardGrid.tsx:317`, `:362`

---

## 6. Ask the OS — one Langfuse trace per turn

**What the user sees.** A chat drawer. You ask a question, the OS calls governed read tools, and the
answer comes back with a table or a citation beside it. A number that came from the semantic layer looks
different from a number that came from ad-hoc SQL, and the difference is a field rather than a sentence
the model chose.

**What actually runs.** A turn is `POST /api/assistant/chat` → `runOsAssistant` → the `runAgentic`
harness, with model calls going to LiteLLM and governed tools dispatched through the same registry the
MCP uses. `os-ui/app/api/assistant/chat/route.ts:36`; `os-ui/core/runtime/agent-loop.ts:309` A turn
returns `{ content, plan, tools[], artifacts[], traceId }`. `os-ui/ARCHITECTURE.md:1116-1120`

**One trace per turn.** `runOsAssistant` mints a per-turn id server-side and passes
`observe: { traceId }` into `runAgentic`, which forwards it to every model call — the plan, each act
iteration and the cap synthesis — so LiteLLM's own Langfuse callback logs *into* that trace
(`existing_trace_id`) instead of starting a fresh trace per call. The id is `ask-<uuid>` from
`crypto.randomUUID`, with a timestamped random fallback. It is minted server-side on purpose: a
client-chosen trace id would let one user write into another user's trace.
`os-ui/core/runtime/agent-loop.ts:296-300`, `:311`, `:324`; `os-ui/core/runtime/runtime.ts:192-198`

**The cost dimension is `tab:ask`, not the tab you are standing on.** `ASK_COST_TAB = 'ask'`, and the
turn is tagged `tab:ask` plus `run:<turnId>` — because an Ask turn taken on the Data tab used to be
tagged `tab:data` and was indistinguishable from the Data tab's own calls.
`os-ui/core/runtime/agent-loop.ts:294`, `:330-331`; `os-ui/ARCHITECTURE.md:1145-1151`

### The artifact protocol

The `artifacts[]` are the governed tools' own MCP `structuredContent`, carried to the browser unchanged,
so the drawer and an external MCP client render identical bytes. One serialiser,
`os-ui/core/runtime/chat-artifacts.ts`, and six kinds: `table`, `chart`, `metric_draft`,
`dashboard_draft`, `citation`, `clarification`. Six read tools declare it — `query_data`,
`query_metric`, `preview_metric`, `suggest_metrics`, `get_metric`, `get_dashboard` — each setting
`outputSchema` to `ARTIFACT_OUTPUT_SCHEMA` plus an `artifacts` projection that is a **pure** function of
the result its own governed `call` already produced. A projection may not read, may not compute and may
not throw usefully: the dispatcher guards it, so a renderer bug degrades to "no artifacts" and never
turns a successful governed read into an error. `os-ui/ARCHITECTURE.md:1114-1126`

Three rules this path exists to enforce.

**1. Truncation is never laundered, and the semantic layer is not exempt.** `QUERY_MAX_ROWS` clips to
the *first* n rows, not a sample, and `query_metric`'s compiled serve SQL carries a `LIMIT n` of its own
— so the layer that "accepts no SQL by construction" can clip a grouped result exactly as raw SQL can.
When a metric query reaches its bound the scalar is **withheld**, not flagged (`value: null` +
`valueWithheld`): a flagged wrong number still gets pasted into a slide, an absent one with a reason
cannot be. `rowLimitTruncation()` is the shared decision and it treats "returned exactly n" as
possibly-clipped, because SQL cannot report what it did not return. The notice is also *prepended* to
the text the model reads (`⚠ TRUNCATED: …`), because the truncation keys sit near the end of the
pretty-printed JSON and `truncateToTokens` keeps the *head* — so on exactly the big results most likely
to be clipped, the notice was the first thing dropped. `os-ui/ARCHITECTURE.md:1128-1148`;
`os-ui/core/runtime/agent-loop.ts:209`, `:219-223`

**2. An ad-hoc number says so.** A `query_data` answer is labelled *"Ad hoc SQL — unverified"* with the
SQL shown, because its aggregation and joins were chosen for that question and reviewed by nobody; a
`query_metric` answer is the governed number and carries no caveat. The label is a field on the artifact
— `source: 'semantic-layer' | 'ad-hoc-sql'` — not a sentence we hope the model wrote.
`os-ui/core/runtime/chat-artifacts.ts:70`; `os-ui/tabs/admin/mcp/discovery-read-tools.ts:329`, `:367`;
`os-ui/tabs/data/mcp/data-query-tools.ts:35`, `:37`

**3. No model-authored markup, ever.** An artifact carries data. The protocol declares no `html`,
`markup`, `svg`, `href`, `src`, `style` or `url` field — asserted by a test — and
`os-ui/core/ui/ask-artifacts-guard.test.ts:41-52`, `:57-71` scans every file on the chat path (the list
is hardcoded and self-asserted) for `dangerouslySetInnerHTML`, `eval(`, `new Function(`, `srcdoc` and
`<iframe`. A citation's link comes from a fixed in-app route map, never from the payload.
`os-ui/ARCHITECTURE.md:1160-1168`

### Semantic-layer-first: what it actually is

It is *prompt text plus artifact labels*, and it is worth being precise about that because the phrase
sounds like an enforcement mechanism.

- The rule block is spliced in as the last element of `OS_RULES`, and the same verbatim text is pinned
  on five surfaces by a tripwire test — `os-ui/core/guides/overview.guide.md:58`,
  `os-ui/tabs/metrics/guide.md:83`, `os-ui/tabs/dashboards/guide.md:134`,
  `os-ui/tabs/data/guide.md:161`. `os-ui/core/runtime/agent-loop.ts:75`, `:116`;
  `os-ui/core/runtime/ask-rules.test.ts:36-60`
- Before any `query_data` the prompt directs a discover-first step: "call `list_datasets` then
  `get_dataset` to obtain the EXACT fully-qualified table name (`iceberg.<schema>.<table>`) — never
  guess". `os-ui/core/runtime/agentic.ts:250-257`
- Tool **ordering** is a tab lens, not a metric-over-SQL preference: `osToolSpecs` sorts the current
  tab's tools first and the full registry after, so on Metrics or Dashboards `query_metric` precedes
  `query_data` and on the Data tab the order reverses. `os-ui/core/runtime/agent-loop.ts:153-164`
- The allowed set is `listToolsForRole(user.role, ALL_MCP_TOOLS)` — the role floor over the *full*
  registry, with no per-turn narrowing. `:154`
- A tool denial is never rendered as data: `if (result.isError) return [];` `:187`

### Where the real artefact is

| Artefact | Tool-side name |
|---|---|
| the turn | a Langfuse trace with `id = ask-<uuid>`, returned to the client as `traceId` on the response — `os-ui/core/runtime/ask-response.ts:39`; `os-ui/app/api/assistant/chat/route.ts:87` |
| trace tags | `domain:<domain>`, `tab:ask`, `run:<turnId>` — built by `callerCredential` — `os-ui/core/infra/litellm-credential.ts:102-107` |
| LiteLLM nesting | `metadata.existing_trace_id` + `metadata.parent_observation_id` (+ `trace_user_id`) — `os-ui/core/runtime/runtime.ts:192-199` |
| LiteLLM end user | `user = os-<id>`, which becomes `end_user` in the gateway's spend ledger — `os-ui/core/infra/litellm-credential.ts:90-93` |
| the rows | Trino, through `query_data` or the section-4 metric path; nothing is persisted by a turn |

### Guardrails, with their values

| Guardrail | Value |
|---|---|
| conversation window | the last 20 messages the client sent, user/assistant only — `os-ui/app/api/assistant/chat/route.ts:51-60` |
| max tool steps per turn | `ASSISTANT_MAX_STEPS`, default **50** — `os-ui/core/runtime/agent-loop.ts:335`; `os-ui/core/kernel/config.ts:343` |
| harness defaults | `DEFAULT_MAX_ITERATIONS = 6`, `DEFAULT_MAX_REPEATED_CALLS = 4`, `DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS = 4`, `DEFAULT_MESSAGE_BUDGET = 24_000` — `os-ui/core/runtime/agentic.ts:134`, `:142`, `:152`, `:290` |
| per-model-call timeout | `LLM_TIMEOUT_MS`, default 240 000 ms — `os-ui/core/runtime/runtime.ts:152`, `:203` |
| `query_metric` row cap | `QUERY_METRIC_DEFAULT_LIMIT = 100` — `os-ui/tabs/admin/mcp/discovery-read-tools.ts:86`, `:340` |
| `query_data` row cap | enforced by the query-tool (`QUERY_MAX_ROWS`), passed through as `truncated` / `rowLimit` / `message` — `os-ui/core/infra/governed.ts:108-115`, `:153-156` |
| `query_data` SQL guard | single statement only, then `authorize(domainPrincipal,'query')`, then the Trino principal — `os-ui/tabs/data/mcp/data-query-tools.ts:46-64` |

### How to inspect it yourself

```
# the turn's trace, by the id the response handed you
#   Langfuse → Traces → filter  id = ask-<uuid>
#   or tags:  tab:ask   run:ask-<uuid>   domain:<domain>

# the spend for the same turn
#   LiteLLM → Usage → filter tag  run:ask-<uuid>  /  tab:ask  /  end_user os-<id>
```

> **Not yet true:**
> - **Threads are not durable.** The drawer holds messages in `useState` and the route trusts the last
>   20 messages the client sent. Durable threads are deferred in code — "(tests, and the durable-thread
>   work that comes later)". `os-ui/ARCHITECTURE.md:1183-1185`;
>   `os-ui/core/runtime/agent-loop.ts:270-271`
> - **The Ask trace carries no session id and no OS-authored name.** `session_id` is gated on
>   `caller?.systemId`, which the Ask caller does not pass (`os-ui/core/runtime/runtime.ts:200`;
>   `agent-loop.ts:327-332`), so Langfuse has no conversation grouping for Ask turns — each
>   `ask-<uuid>` trace stands alone. The trace is also **flat**: `observe` carries only `traceId`, so
>   calls nest directly under the turn rather than under a per-step OS span, which needs the engine
>   migration. `os-ui/ARCHITECTURE.md:1189-1191`
> - **Three of the six artifact renderers are not built.** `chart`, `metric_draft` and
>   `dashboard_draft` have no renderer; the drawer *counts* what it cannot render and says so, rather
>   than discarding it silently. `os-ui/ARCHITECTURE.md:1185-1187`
> - **There is no `os.analyst` LangGraph system and no write path from chat.** The migration off
>   `runAgentic` onto the LangGraph engine is staged behind a flag with a parity harness per decision
>   D12 and has not been started. A grep for `langgraph`/`@langchain` under `os-ui/core/runtime/`
>   (non-test) returns zero hits; the dependency runs one way only — the LangGraph engine imports the
>   Ask harness's prompt and cap primitives, never the reverse.
>   `os-ui/ARCHITECTURE.md:1187-1189`; `os-ui/tabs/agents/lib/engine/build-graph.ts:89-108`
> - **The confirm before a write is prompt-level only.** `writeToolNames` stops a failed write re-firing
>   byte-identically, but it is not a confirmation gate; the structural one is the writer node's tool
>   allowlist, which is backlog (C15). `os-ui/ARCHITECTURE.md:1191-1193`
> - **There is a second, independent NL→SQL engine.** `POST /api/data/ask` → `runAsk` in
>   `os-ui/tabs/data/lib/ask.ts` is described in its own header as "Talk-to-your-data v2 (NL→SQL)", with
>   its own limits (`MAX_SQL_LENGTH = 8000`, `MAX_SUMMARY_ROWS = 50`, `MAX_CELL_CHARS = 200`) and its own
>   honest-miss token `NO_ACCESSIBLE_DATASET`. It is not the Ask-the-OS path and does not share its
>   trace. `os-ui/app/api/data/ask/route.ts:17`, `:30`; `os-ui/tabs/data/lib/ask.ts:43-46`, `:74`,
>   `:154`, `:164-165`
> - **The Ask route's own timeout is inert.** `CHAT_TIMEOUT_MS` (`LLM_CHAT_TIMEOUT_MS`, default 90 000)
>   is read, an `AbortController` is created and `setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS)` is
>   armed — but `ctrl.signal` is never passed to `runOsAssistant`, so the `AbortError` catch is
>   unreachable from that timer. The only timeout that fires on a chat turn is the per-model-call 240 s.
>   `os-ui/app/api/assistant/chat/route.ts:32`, `:76-79`, `:95-99`;
>   `os-ui/core/runtime/runtime.ts:203` **Not in either plan document.**
> - **`exploreMetric` discards the query-tool's own truncation signal** before `query_metric` can see
>   it, so a `QUERY_MAX_ROWS` clip landing *below* the metric's own `LIMIT` is not yet detected.
>   `os-ui/tabs/metrics/lib/build/explore-server.ts`; `os-ui/ARCHITECTURE.md:1191`
> - **The builder's own model calls are tagged `tab:assistant`, a dimension nothing reads.**
>   `os-ui/core/runtime/complete.ts:93` hardcodes `tab: 'assistant'` and `:115` adds the literal
>   `'assistant'` tag, while `os-ui/core/runtime/agent-loop.ts:294` defines `ASK_COST_TAB = 'ask'`. A
>   one-line rename that moves a cost series, so it is recorded rather than done. Gap-report §3 item 6
---

## 7. Agents — LangGraph TS, PostgresSaver, interrupts, the worker

**What the user sees.** A team of agents with a supervisor, a Run panel that streams what each member
did, an approval card in Governance when a member wants to write something, and a Resume button after a
restart.

**What actually runs.** A real `@langchain/langgraph` graph, and since A5 of the engine rebuild it is
the *only* executor: no flag, no `runtime:` choice, no fallback. The hand-rolled IR walker, its mock twin
and the Python `agent-runtime` interpreter are gone; an `AGENTS_ENGINE` left in an environment is ignored
with one deprecation line at boot. `os-ui/ARCHITECTURE.md:216-220`

```
system.yaml ─ parseSystem ─> System ─ compile ─> IR ─ buildGraph(ir, deps) ─> CompiledStateGraph
 (tabs/agents/lib/system-schema.ts)  (langgraph-compile.ts)  (tabs/agents/lib/engine/build-graph.ts)
```

**State** is an `Annotation.Root`. `messages` is the shared conversation in the OpenAI wire shape
(`LlmMessage[]`, append) — *not* LangChain `BaseMessage`, because every model call goes to LiteLLM as
chat-completions. Each `state.channels` entry of the YAML becomes a *typed* state key: `add_messages`
appends; `boolean`/`number`/`string`/`json` is last-write-wins starting at that type's default; any other
declaration (the legacy `last_value`) becomes an untyped `json` channel, so a file written before the
types runs unchanged. The engine adds its own keys — `task`, `current`, `handoffs`, `nodeRuns`, `routes`,
`budget`, `held`, `final`, `failed`, `routeNext` — and a channel that shadows one of them is a compile
error. `os-ui/ARCHITECTURE.md:228-239`

**Four nodes per agent**, named from one helper so the engineering view and the engine cannot disagree:
`safeNodeName(id)` produces
`{ plan: plan_<safe>, act: act_<safe>, tools: tools_<safe>, route: route_<safe> }`.
`os-ui/tabs/agents/lib/engine/build-graph.ts:301`, `:601-602`

| Node | What it does |
|---|---|
| `plan_<id>` | runs the reasoning tier with **no** tools, checks the team step budget, emits `node-started`. Every agent visit costs one budget step here. `build-graph.ts:23`, `:64`, `:752` |
| `act_<id>` | runs the execution tier with the node's advertised tools (`toOpenAiTools`); if the gateway rejects `tools` it flips a `react` flag and retries with the ReAct text protocol; a cap or loop-guard triggers a one-shot synthesis. `:24-26`, `:806-808` |
| `tools_<id>` | the **node-level narrowing gate**: only tools this node is advertised reach `grantedToolExecutor` — an un-advertised call gets a typed `not_found` and never executes. Two phases: first the hold decision for the *whole batch*, then **one executed call per superstep**, so every execution is checkpointed before the next begins. `:26-33`, `:146`, `:883` |
| `route_<id>` | records the visit (`nodeRuns`, `handoffs`, `node-completed`), then routes. `act → tools` is a conditional edge on "the reply carried tool calls"; `tools → tools` while calls remain, else back to `act`. `os-ui/ARCHITECTURE.md:244-250` |

**Supervisor.** `route_<sup>` asks the model through a mandatory `route` tool
(`{ next: <member>|'END', brief }`, text fallback `NEXT: <member>`) and `addConditionalEdges` fans out to
members ∪ handoff targets ∪ END. A member's route returns to the supervisor's *route* node — one decision
call per return, the standard LangGraph supervisor shape. `os-ui/ARCHITECTURE.md:252-257`;
`build-graph.ts:36`, `:1100`

**Handoffs.** `when` is evaluated by a hand-written parser in
`os-ui/tabs/agents/lib/engine/when.ts` — literals, string literals, `state.<channel>`, bare identifiers,
`==`/`!=`, `&&`/`||`, parentheses — never `eval`. A true guard returns
`new Command({ goto: 'plan_<to>' })`; an absent `when` is unconditional; a guard over a channel nothing
*can* set is a **compile warning carried on the run report**, not a silent false.
`os-ui/ARCHITECTURE.md:259-264`; `build-graph.ts:43`

Which matters because of the companion decision: the agent whose turn a guard follows is advertised one
extra built-in tool, `os_set_state({ channel, value })`, closed to the *declared* channels and
type-checked against the declaration. It is not an MCP tool and not a grant — it writes the team's own
state, so it never reaches `grantedToolExecutor`, is never held for approval, and an undeclared channel
or a mistyped value returns a typed `invalid_argument` the model can correct. Each writer's system prompt
gains a generated `--- STATE CHANNELS ---` block so the instructions cannot drift from the YAML, and the
supervisor's routing prompt carries a `--- TEAM STATE ---` line of the current values. Before this, every
`when` guard in the OS evaluated false by construction. `os-ui/ARCHITECTURE.md:266-278`;
`build-graph.ts:644`, `:999`

**Bounds.** A run ends when the supervisor routes END, when a leaf's handoffs all evaluate false, or when
`budget.stepsUsed` (tool rounds plus supervisor decisions) reaches the team step budget — gracefully,
with `final` = what completed plus the budget note. `recursionLimitFor(stepBudget)` = `×4 + 8` is the
hard backstop; hitting it is reported, never a 500. `build-graph.ts:347-350`, `:1208`;
`os-ui/ARCHITECTURE.md:280-285`

**Build compiles the same graph.** `os-ui/tabs/agents/lib/build/compile-verify.ts` calls the *same*
`buildGraph` with inert deps — a model and a tool executor that throw if touched, because compiling calls
neither — so Build's `langgraph` row means "the graph this `system.yaml` describes can be constructed",
and a bad guard, an unmapped grant, a disabled entrypoint or a channel shadowing an engine key fails at
Build rather than mid-run. `os-ui/ARCHITECTURE.md:300-310`

### Approvals are interrupts

A write that needs a human *pauses the run*; the decision *resumes it*. Nothing executes in between —
not the held call, and not the other calls of the same batch.

```
act_<id> ──tool calls──▶ tools_<id>  phase 1: holdDecisionFor(preset, tool) for EVERY call
                            │          held → ApprovalPort.enqueueOnce(<threadId>:<callId>)
                            │          pending → interrupt({approvalId, tool, node, args}) — run PARKS
   Governance inbox / MCP decide_approval ── decide() ── onDecided hook ── resume.ts
                            │          runner re-read LIVE: disabled / role lost / domain lost → refused
                            │          Command({ resume: {[approvalId]: decision} }) as the RUNNER
                            ▼
                         tools_<id>  phase 2: one call per superstep
```

`os-ui/ARCHITECTURE.md:320-340`

The rule itself is the pure module `os-ui/tabs/agents/lib/build/hold.ts` (`writeTargetScope`,
`holdDecision`, `holdDecisionFor`) — lifted out of the executor so the graph builder, which has no
`server-only`, can call it before anything executes. The executor runs with `holdAt: 'node'` and no
longer re-holds; `'executor'` remains its default as defence in depth for any caller that is not a graph
node. `os-ui/ARCHITECTURE.md:342-347`

**Idempotency** matters because LangGraph re-runs an interrupted node from its start on every resume. The
node enqueues through `enqueueOnce` keyed on `interruptKey = <threadId>:<callId>` — one approval per held
call however many times the node re-runs — and **the queue is the source of truth**: on every re-run the
node reads each approval's state back, so a decided one never interrupts again and a pending one parks
again. A resume payload meant for another approval therefore cannot unblock the wrong call.
`os-ui/ARCHITECTURE.md:349-355`

**The approver authorises; the runner executes.** The approval record carries `runId`, `threadId`,
`interruptKey`, `systemId`, `node`, `tool`, `args` and the *runner's* principal snapshot.
`os-ui/core/policy/approvals.ts` `decide()` fires the `onDecided` handlers registered at boot from
`os-ui/tabs/agents/lib/engine/resume-boot.ts` (the kernel never imports the tab); the handler re-reads the
runner live and refuses — typed, stamped on the record's `resume` field — when the runner is gone or no
longer clears the tool's role floor, otherwise it rebuilds the run context *as the runner* and continues
the thread. `applyEffect` performs *no* approver-side effect for a run approval. A rejection also
resumes: the agent receives the typed `rejected` result and continues. `os-ui/ARCHITECTURE.md:357-369`

### Where the real artefact is

| Artefact | Where, and its tool-side name |
|---|---|
| the definition | `agents/<slug>/system.yaml` — the canonical definition; `agents/<slug>/agents/<agent-id>.md` each agent's instruction file; `agents/<slug>/graph.json` the compiled LangGraph IR the engine runs; `agents/<slug>/README.md`; personal lane `agents/personal/<uid>/<slug>/`. `os-ui/ARCHITECTURE.md:524-534` |
| the identity map | `agents/index.yml` — slug → frozen OS id, owner, scope, source version. Not pushable. `os-ui/core/infra/git-receive.ts:77` |
| the commit | `agents(<domain>): <action> <object> — via <surface>`, trailers as section 2; writer `os-ui/tabs/agents/lib/git/commit.ts:187-190` |
| checkpoints | **LangGraph `PostgresSaver`** from `@langchain/langgraph-checkpoint-postgres`, on `AGENT_RUNS_DATABASE_URL` (the chart's `agent_runs` database). Its tables are created by the idempotent `setup()` — "`CREATE TABLE IF NOT EXISTS` + versioned migrations" — run once per process and also at os-ui boot from `instrumentation.ts`. The four tables are the upstream package's, not the OS's — `checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes` (`os-ui/node_modules/@langchain/langgraph-checkpoint-postgres@1.1.3/dist/migrations.js:10`, `:13`, `:23`, `:32`). Unset ⇒ LangGraph's `MemorySaver`, and the run report says which (`checkpointer: 'postgres' \| 'memory'`). An unreachable configured database **throws** rather than degrading quietly. `os-ui/tabs/agents/lib/engine/checkpointer.ts:11-20`, `:44-65`, `:68-70` |
| thread id | **thread id = run id**, minted in the run route by `os-ui/core/kernel/run-id.ts` (`crypto.randomUUID`). A run id is a capability. `os-ui/ARCHITECTURE.md:287-299` |
| the run queue | two Postgres tables in the same `agent_runs` database, idempotent DDL in `RUN_JOBS_DDL`: `run_jobs` (`run_id` PK, `system_id`, `domain`, `requested_by`, `principal_snapshot jsonb`, `input jsonb`, `kind`, `status`, `locked_by`, `locked_at`, `attempts`, `error`, `created_at`, `updated_at`) and `run_events` (`(run_id, seq)` PK, `event`, `data jsonb`, `at`), plus indexes `run_jobs_queued_idx (status, created_at)` and `run_jobs_lease_idx (status, locked_at)`. `os-ui/tabs/agents/lib/engine/jobs-postgres.ts:48-75`, `:77-80` |
| the trace | one Langfuse trace per run, **id = run id = thread id**. `name = <the system's name>`, `userId =` the runner's OS user id, `sessionId =` the system id, `environment = studio\|test\|run` when the lifecycle established one. Tags: `domain:<domain>`, `agent:<systemId>`, `run:<runId>`, `engine:langgraph`, and `env:<word>` when set. `os-ui/tabs/agents/lib/engine/observe.ts:191-199`, `:209`, `:221-229` |
| the spans | every `plan_`/`act_`/`tools_`/`route_` node runs inside a span; each completion is recorded as a **generation** named `llm.plan_<id>` / `llm.act_<id>` / `llm.route_<id>`; each governed tool call is a span carrying the hold *decision*; the outcome is a terminal `run.result` span rather than a trace update (a trace update is a second trace event in the SDK, and the recorded-ingestion test asserts exactly one). `build-graph.ts:752`, `:806`, `:1100`; `observe.ts:18-19`; `os-ui/ARCHITECTURE.md:385-391` |
| the model spend | LiteLLM, keyed by tag: `domain:`, `agent:`, `tab:`, `run:`, `env:` — in that order — with `user = os-<id>` as the `end_user`. The system's own virtual key is resolved by secret *reference* when Build minted one, else the shared agent key, else refuse. `os-ui/core/infra/litellm-credential.ts:84-88`, `:102-116` |
| nesting into LiteLLM | `metadata.existing_trace_id` + `metadata.parent_observation_id` (+ `trace_user_id`, `session_id`). `os-ui/core/runtime/runtime.ts:192-199` |

**Redaction has two levels**, chosen by `LANGFUSE_REDACTION`. `structure` (the default): message content
as roles plus character counts, the tool-call structure (names, ids, arguments) in full, each tool result
as a character count plus a 160-character preview. `strict`: argument *key names* and their sizes only, no
preview — for tenants whose tool arguments can carry personal data. Neither level reaches LiteLLM's own
nested generation, which carries the full prompt unless the gateway is told otherwise
(`turn_off_message_logging`). `os-ui/core/kernel/config.ts:405`; `os-ui/ARCHITECTURE.md:401-407`

### Runs execute in a worker

Before A4 a run was bound to the request that started it, so `maxDuration = 300` was the real ceiling and
an os-ui rolling restart killed whatever was in flight. Now the route files the run and tails its events;
something else executes it.

**The port** is `engine/jobs.ts` (`RunJobStore`) with two implementations: Postgres, and an in-memory one
that *is* the contract every implementation must meet — it is what the tests drive and what a laptop
without `AGENT_RUNS_DATABASE_URL` runs on. `os-ui/ARCHITECTURE.md:447-450`

**The loop** (`engine/worker-loop.ts`, pure; wired by `build/run-jobs-server.ts`; entrypoint
`os-ui/worker/agent-runs.ts`) claims the oldest `queued` row with
`UPDATE … WHERE run_id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` — two workers never take the same run
and neither blocks — stamps `locked_by`/`locked_at`, re-reads the runner *live*, runs it, writes every
engine event to `run_events`, and settles the row. A `running` lease nobody heartbeats is re-queued
*once* (as a `resume` when there is a checkpoint to continue, keeping `kind='start'` when the run never
reached one) and then *failed*, so a run never sits `running` for ever. SIGTERM stops new claims and
aborts the run in flight at its next superstep boundary: what completed is checkpointed and the row goes
back to `queued`. `os-ui/ARCHITECTURE.md:452-459`

**A lost lease is an abort.** The heartbeat is a watch (`leaseWatch`): the first beat that reports the row
is no longer `running` under this pod aborts the run *and* marks the job abandoned, so this process
settles nothing and re-queues nothing — the pod that re-claimed the row owns it. The settle itself is
lease-guarded in SQL (`AND locked_by=… AND status='running'`), so a stale holder's `done` updates no rows.
`run_events` appends are deliberately *not* guarded: a late event is ordered after the new holder's by
`seq` and is at worst a duplicate line in the panel, whereas a stale settle would end a run somebody else
is still driving. `os-ui/ARCHITECTURE.md:461-468`

**A run id is not an authorisation.** `engine/run-visibility.ts` `assertRunVisible` is the one gate every
run-id door calls *before* any side effect — `POST …/run` with `{ resume: true }`, `GET …/run/stream`,
MCP `resume_agent_run` — and the store refuses a resume whose `requested_by` differs from the row's as
defence in depth. Always 404, never 403: a 403 would confirm that the run exists and belongs to someone
else. `os-ui/ARCHITECTURE.md:475-479`

**Identity, again.** The job carries a `principal_snapshot` — what was true when the run was filed, never
the authority. Before executing, `engine/runner-identity.ts` re-reads the runner from the live directory
and refuses typed: `runner_unavailable` (gone or disabled), `runner_role_changed` (downgraded below the
filed role), `runner_domain_lost`. A role *upgrade* is not a refusal — the YAML is re-governed against the
owner's live role on every run. `os-ui/ARCHITECTURE.md:481-486`

**One switch, `AGENTS_WORKER`.** `inline` (the default) means the process that files the job also executes
it, immediately, writing the same `run_events` — so a kind install, a laptop and the whole test suite need
no worker process. `worker` means os-ui only enqueues and tails, and the `os-ui-worker` Deployment (same
image, `node --experimental-strip-types worker/start.mjs`, `AGENTS_WORKER=worker`) executes. The chart
sets it only when `osUI.worker.enabled`, which is **false by default**.
`os-ui/core/kernel/config.ts:373`; `os-ui/ARCHITECTURE.md:497-503`;
`charts/sovereign-agentic-os/values.yaml:1313`

**Every door is the same door, and the door is `enqueueRun`.** Nothing executes a run without a job row.
Three callers sit on top of it: the SSE run route calls `enqueueRun` directly and then tails `run_events`
(it owns the stream); `build/scheduled.ts` and the MCP `run_agent_system` call `startQueuedRun`;
`resume_agent_run` and the owner's Resume call `resumeQueuedRun`; and the Governance `onDecided` hook calls
`enqueueResumeAfterDecision`. A decision no longer drives the graph inside the decider's request — it files
a `resume` job, and the approval card says `queued` until the run reports back.
`os-ui/ARCHITECTURE.md:505-510`

The tail is a *poll* of `(run_id, seq)` every 400 ms — a primary-key range scan, not `LISTEN/NOTIFY` —
because that is correct across pods and after any reconnect, needs no dedicated connection per watcher, and
a few hundred milliseconds is invisible next to a model call. At 240 s both doors emit a
`queued { runId, afterSeq }` frame and the panel re-attaches from that cursor. One pod holds at most 64
tails (`engine/tail-limit.ts`); the next gets `503` + `Retry-After`, because a tail borrows a pooled
connection every 400 ms and sign-in must not lose to a wall of open Run panels.
`os-ui/ARCHITECTURE.md:488-496`

### How to inspect it yourself

```bash
# the definition and the compiled graph, in a clone
git show main:agents/support-triage/system.yaml
git show main:agents/support-triage/graph.json | jq '.nodes[].id'
git show main:agents/index.yml                      # slug -> frozen id

# the run, in Postgres (the agent_runs database)
select run_id, status, kind, locked_by, attempts, error from run_jobs order by created_at desc limit 5;
select seq, event, at from run_events where run_id = '<runId>' order by seq;

# the checkpoint tables PostgresSaver.setup() created in the same database
\dt   -- checkpoint_migrations, checkpoints, checkpoint_blobs, checkpoint_writes

# in Langfuse
#   Traces → id = <runId>     name = <the system's name>     sessionId = <systemId>
#   tags: domain:<d>  agent:<systemId>  run:<runId>  engine:langgraph  [env:run]
#   observations: plan_<id>, act_<id>, tools_<id>, route_<id>, llm.act_<id>, run.result

# in LiteLLM
#   Usage → filter tag  agent:<systemId>  /  run:<runId>  /  env:run ; end_user os-<id>
```

> **Not yet true:**
> - **The worker is off by default.** `osUI.worker.enabled: false`, so agent runs execute *inline* in
>   the os-ui process on a stock install — the request that files the job also drives the graph. The
>   durability story (lease reaping, SIGTERM at a superstep boundary, two pods never claiming one run) is
>   implemented and tested, and is not what a default deployment exercises. `inline` mode still reaps:
>   `ensureRunJobsReady()` runs one `reapStale` sweep at boot and an inline run heartbeats its own lease.
>   `charts/sovereign-agentic-os/values.yaml:1313`; `os-ui/ARCHITECTURE.md:492-496`
> - **A parked approval has no TTL.** An open policy question in v1, recorded in
>   [`docs/components/os-ui.md`](components/os-ui.md) rather than decided. `os-ui/ARCHITECTURE.md:369`
> - **Checkpoints are kept indefinitely, raw tool results included.** Retention is an open item (plan
>   A13 follow-up). `os-ui/ARCHITECTURE.md:298-299`
> - **Thirteen platform MCP writes are never held by any preset.** `PLATFORM_WRITE_TOOLS` is
>   `{ commit: 'software', push_app_files: 'software' }`, and `create_software`, `request_deploy`,
>   `start_preview`, `promote`, `archive`, `delete`, `set_app_spec`, `design_software`, `decide_deploy`,
>   `use_connection`, `use_data`, `use_knowledge` and `use_as_data` are absent from `WRITE_TOOL_TABS` —
>   which is the table the agent hold gate reads. So `holdDecisionFor(preset, tool)` answers "not a
>   write" for every preset on all thirteen. The test's own header records this honestly, which is why
>   it is visible at all; adding them moves the shipped Software Delivery Team's governance posture and
>   the frozen engine goldens. `os-ui/core/mcp/write-tool-meta.test.ts:29`; gap-report §3 item 1
> - **Build's Langfuse row is `pending` until the system has really run.** Its probe reads the traces a
>   *run* leaves behind, and a build no longer stages a fake one — which is honest, and means a freshly
>   built system shows an empty observability row. `os-ui/ARCHITECTURE.md:308-310`
> - **No run artefact is committed.** Activity markers, the run checkpoint, the last-run report and
>   restart recovery deliberately do not commit: 7 of the store's 24 writers are classified
>   "bookkeeping, not a commit", because a run's artefacts are the LangGraph checkpoint, the `run_events`
>   rows and the Langfuse trace. `os-ui/ARCHITECTURE.md:525-532`
> - **A `system.yaml` that does not parse is still committed verbatim**, with a README that says so —
>   losing the source would be worse than keeping an unreadable one. `os-ui/ARCHITECTURE.md:589-592`
> - **Three tests in the agents build suite are `todo`, not passing** — resource narrowing (×2) and
>   held-action arguments — and one more in `os-ui/core/infra/os-mirror.test.ts` (mirror durability).
>   They are pre-existing Phase-1/2 markers.
> - **Two commits after the head this page describes touch the worker entrypoint.** `ac91c803` ("do not
>   demand the session/MCP signing secrets at worker boot — the worker has none, by design") changes
>   `os-ui/worker/agent-runs.ts` and `os-ui/core/kernel/config-secret-guard.test.ts`; nothing else here
>   moves.

---

## 8. Software — `apps/<slug>/`, the SDK, serve modes

**What the user sees.** A Design → Build → Test → Deploy flow that produces a working internal app on
the OS's own domain, with a review card and an approval before it goes live.

**What actually runs.** An app is not an OpenSearch document any more. Its source tree lives in the
domain's bare git repository at `apps/<slug>/`, written through the one commit path with `commitSubtree`
and a boot-time `reserveSubtree('apps/')` so the dbt generator's whole-tree commit keeps every app. The
OpenSearch `os-app-files` mirror is *a cache of the committed tree*, not the home of record, and every
read is labelled `governed-commit` | `mirror-cache` | `template-seed`.
`os-ui/tabs/software/lib/git-commit.ts:27-28`, `:48`, `:148-150`; `os-ui/ARCHITECTURE.md:886-895`

The slug is validated against `^[a-z0-9][a-z0-9-]{0,62}$`, and a path escape (`..`, absolute, empty
segment) is **refused rather than silently dropped**. `git-commit.ts:53`, `:56-60`, `:66-78` Idempotence
comes from the primitive: `commitSubtree` commits only when the tree hash changed, so two identical
pushes are one commit. `:25-26`

### Where the real artefact is

| Artefact | Where |
|---|---|
| the source tree | `apps/<slug>/` in the domain repo — the default `sovereign-app` scaffold writes `src/main.tsx`, `src/App.tsx`, `src/template/{app-meta.ts,roles.ts,identity.tsx,scope.ts,sections.tsx,shell.tsx}`, `src/template/pages/{Overview,Admin}.tsx`, `src/core/store.ts`, `src/core/pages/Workspace.tsx`, `app.yaml`, `.app/decisions.md`, `README.md`, plus the vendored `vendor/@sovereign-os/{app-sdk,ui}/` trees. `os-ui/tabs/software/lib/scaffolds/sovereign-app.ts:53-79`, `:889`, `:911`, `:946` |
| `app.yaml` | the metadata convention — `name`, `owner`, `connections`, `data`, `knowledge` — re-parsed on *every* commit; an exact-root match is preferred over `manifests/app.yaml`. `os-ui/tabs/software/lib/metadata.ts:59-60`, `:96`, `:150` |
| `actions.yml` | **authored by the app, not scaffolded** — it is in no scaffold list and is parsed on every push. `os-ui/tabs/software/lib/app-actions.ts:62` |
| the commit | subject `software(<domain>): <action> <slug>[ — <note>] — via <surface>`, default surface `ui:software`; trailers `OS-Action`, `OS-Object: app:<id> (<name>)`, `OS-Surface`, `OS-Request-Id`, plus `OS-Actor`, `OS-Reason` and `OS-Author-Email: synthesized` where they apply, plus `OS-Run-Id` added by the store from the ambient scope. `git-commit.ts:51`, `:100-112`, `:179-181`; `os-ui/core/infra/git-store.ts:278` |
| the head for this app | `readAppTreeFromGit` returns the sha of the commit that last changed *this app's prefix*, not the repository head, and returns `null` rather than throwing when git cannot answer. `git-commit.ts:222-243` |
| app records | OpenSearch `os-apps` — `os-ui/core/kernel/config.ts:190` |
| the file cache | OpenSearch `os-app-files` — `config.ts:197` |
| the app's own data | OpenSearch `os-app-records`, every query scoped by `appSlug` — app A's records are never visible under app B — then My ∪ Domain. `config.ts:201`; `os-ui/tabs/software/lib/app-records-store.ts:22-25` |
| deploy review cards | OpenSearch `os-software-reviews` — `os-ui/tabs/software/lib/review.ts:78` |

`actions.yml` verbatim, with its hand-rolled parser (no YAML dependency) and its closed scope list:

```yaml
actions:
  - name: list_invoices
    description: List invoices the caller may see.
    write: false
    scopes: [records, data]
    input:
      status: string
```

`os-ui/tabs/software/lib/app-actions.ts:71-85`. Allowed scopes:
`['records','data','knowledge','metrics','files']` (`:43`); name regex `^[a-z][a-z0-9_]{2,47}$` (`:64`);
a malformed entry becomes an `ActionParseIssue` and is dropped, never half-declared (`:83-84`,
`:100-114`).

### The app ↔ agent ↔ data triangle

`os-ui/core/app-sdk/agents.ts` gives a governed app `os.agents.run/get/decide`, and all three post to the
*same routes the OS UI posts to* — the run route (`enqueueRun`), that run's `run_events` stream, and the
one `/api/governance/approvals` inbox — same-origin with the ambient session. No token exchange, no app
principal, no key of the app's own; a held write surfaces as `state: 'parked'` with its approval id. The
other direction: an app *declares* its actions in `actions.yml` and an agent may call one only through the
four-layer fail-closed intersection **capability ∩ declaration ∩ adoption ∩ grant**, with a
`domain_admin` consent step and a write *held* under the reads-on/writes-off preset. Data goes only
through the governed paths as the end user, so two sessions of the same app see different rows.
`os-ui/ARCHITECTURE.md:909-922`; `app-actions.ts:5-6`, `:30-34`, `:186-200`

The SDK is vendored as *source*, never a published npm package, so an air-gapped build resolves locally:
five files in dependency order (`errors.ts`, `types.ts`, `agents.ts`, `client.ts`, `index.ts`) read from
`core/app-sdk` plus a synthesized `package.json` (`@sovereign-os/app-sdk`, `main: index.ts`) so bare
imports resolve. It is injected at three points: the Sandpack/instant preview and the runtime at
`node_modules/@sovereign-os/app-sdk`, the compile gate at the same prefix, and the repository at
`vendor/@sovereign-os/app-sdk`. `os-ui/tabs/software/lib/app-sdk-vendor.ts:7-16`, `:27-32`, `:47-59`,
`:74-75`; `compile-gate.ts:80-81`; `preview-runtime.ts:217-218` `os-ui/core/app-ui` mirrors it with 13
required source files; its `README.md` is *optional* because the shipped docker image excludes markdown
(`app-ui-vendor.ts:30-51`). Both must keep their own imports **relative**: an `@core/*` alias does not
exist inside a generated tree, and aliasing them silently degrades the vendored package's types to `any`.
`os-ui/ARCHITECTURE.md:125-131`

What an app may call: `os.whoami()`, `os.context()`, `os.datasets.{list,get,query}`,
`os.metrics.{list,query}`, `os.knowledge.search`, `os.files.{list,get}`,
`os.records.{list,add,get,update,remove,export}`, `os.agents.{run,get,decide}`.
`os-ui/core/app-sdk/client.ts:127-197`, `:308-550` Five invariants are documented as such: every method
hits a governed OS route and the SDK cannot widen what the session may see; reads are read-only and the
*one* write surface is `os.records.*` (so a hallucinated `os.datasets.update` is a TS2339 the compile gate
catches); `os.records.*` requires `appSlug`; raw client SQL is refused locally
(`datasets.query({sql})` throws `UnsupportedQuery`); and errors are honest — `401 → NotAuthenticated`,
`403 → Forbidden` with the server's reason verbatim. `os-ui/core/app-sdk/README.md:44-50`

A second cap applies server-side, because an app runs under the user's ambient `soa_session` and would
otherwise read anything the *user* can see: `os-ui/tabs/software/lib/app-origin.ts:11-25` caps the app's
data plane at **(user access ∩ app grants)** — "it only ever DENIES artifacts the app was not granted. It
never widens access."

### App intent: what an app may ask the OS for

Three layers stand between an app and the two actions that used to be free (starting agent runs and
approving held writes), and each is claimed for exactly what it does.
`os-ui/ARCHITECTURE.md:928-953`

1. **A scoped, signed intent.** When the OS renders an app it mints an HMAC intent
   (`os-ui/core/kernel/app-intent.ts`) for *that* user and *that* app, carrying `agent-run` **only**, and
   injects it into the app document. The SDK sends it back as `x-os-app-intent` with
   `x-os-app-origin: app`. `guardAppIntent` runs on the run route and the approvals route: a request that
   announces itself as an app, or presents a token at all, must present a valid one — minted for the
   session's user, unexpired, scoped — or it is a 403 with the reason. A cross-site `Sec-Fetch-Site` is
   refused outright. *No code path mints `approval-decide` for an app*, so approving is refused by
   construction.
2. **The app does not post the approval.** `os.agents.decide` sends `os:app-decide-request` to the host
   shell; the shell renders the ask in OS chrome and links the user into the top-level Governance inbox.
   The app cannot drive the top level — `allow-top-navigation` and `allow-popups` are both omitted from
   the sandbox — and the shell holds no token in its DOM, because an `allow-same-origin` child could read
   it.
3. **The app frame's `connect-src` is an allowlist.** This is the layer that binds a *hostile* app, which
   could otherwise simply omit the headers: a header guard cannot tell such an app from the OS UI on our
   own origin.

### Serve modes

```ts
export type ServeMode = 'image' | 'runtime' | 'spec';
export function normalizeServeMode(raw: unknown): ServeMode {
  return raw === 'runtime' ? 'runtime' : raw === 'image' ? 'image' : 'spec';
}
```

`os-ui/tabs/software/lib/apps.ts:148`, `:164-166`

| Mode | Default | What actually serves |
|---|---|---|
| `spec` | **yes** | real. The OS renders the validated AppSpec same-origin at `/apps/<slug>` under the viewer's session — no pod, no registry — live "the moment its spec validates". A nil or empty spec renders an honest "nothing to render yet", never a blank screen. `apps.ts:142-148`, `:164-166`; `served-app.ts:14-15`, `:26-30`; `os-ui/tabs/software/guide.md:5` |
| `runtime` | no | real but narrow: bundles the committed tree and serves one HTML document mounting the app in a sandboxed same-origin iframe. Gated three ways — must be `serveMode==='runtime'` (409), must be Vite-shaped (422), and the compile gate must be **green**; a red gate yields the diagnostics page, never a broken bundle. `os-ui/tabs/software/lib/app-runtime.ts:14-33`, `:255-265`, `:266-300` |
| `image` | no | partial. The runner provisions a real Kubernetes Deployment, Service and Ingress and reports readiness from actual pod state — but the OS has no image builder, no CI runner and no registry, so the image must be one the operator built and published. `os-ui/tabs/software/lib/runner.ts:8-23` |

The reason the default moved is the clearest example in the codebase of a default that reported success
while doing the wrong thing. The default *used* to be `'image'`, so every legacy or nil record normalised
to the container path, where `appImageRef` fell back to `config.softwareRunnerImage` — and the chart's
default for that was `traefik/whoami:latest`. An app that flipped live therefore served **a stranger's
placeholder container on the customer's own domain**, and reported success. Now the default is the mode
that needs no image or pod, an explicit `'image'` app with no image fails closed and loudly with
`MissingAppImageError` (409), and `softwareRunnerImage` is deliberately empty. `apps.ts:155-162`;
`runner.ts:107`, `:118`, `:138`; `os-ui/core/kernel/config.ts:277`; `os-ui/ARCHITECTURE.md:899-904`

The other trap closed in the same pass: a `demo-seed` result is now *structurally* unusable as evidence.
`os-ui/tabs/software/lib/seeded-evidence.ts` `assertNotSeeded` refuses it at `requestDeploy`, on the
review card, at `decideDeploy` and in the `verify_software` verdict — because a label in a response field
is one a caller can drop. `os-ui/ARCHITECTURE.md:904-908`

### Deploy flow

| Tool | What it writes |
|---|---|
| `push_app_files` | the one documented verb for "code in Claude, push to the OS". One service, two doors: the MCP tool is a thin delegate over `pushAppFiles`, the exact function `POST /api/software/<id>/files` calls. The compile gate runs *before* any write — a red gate is a 422 with the diagnostics and nothing is committed — and a push is a *changeset merged over the current tree*, so a partial push never deletes untouched files. Every input rule is checked before `commitToApp`, deliberately, because `commitToApp` writes the mirror cache even when the git commit throws. Role: owner or owning-domain admin. `os-ui/tabs/software/lib/platform-mcp.ts:168-170`, `:419-432`; `push-app-files.ts:130`, `:135-153`, `:176-192`, `:203-214` |
| `read_app_files` | a three-source cascade, each answer labelled: the committed subtree (`governed-commit`), else the `os-app-files` mirror (`mirror-cache`), else the template (`template-seed`) — because "a substituted source that reads as the real thing is the failure this label prevents". Files are truncated at `APP_FILE_CAP` (~24k chars) with an explicit note. `os-ui/tabs/admin/mcp/discovery-waveb-tools.ts:231-235`, `:245-291` |
| `start_preview` | sets `app.deploy.state` to `preview`, provisions the real Deployment via `deployApp`, then `applyRunnerOutcome` + `persistApp` → `os-apps`. `runnerNote` is `null` when the pod is running, the runner's own failure detail otherwise — never a silent hang. `review.ts:265-299` |
| `request_deploy` | three outcomes: auto-deploy when already live ∧ in-envelope ∧ scan clean ∧ no dataset warning; builder self-serve go-live for an own Personal app on a passing scan; otherwise a `ReviewCard` into `os-software-reviews` plus `state: 'review'` and a Governance approval. `review.ts:316-420` |
| `decide_deploy` | role gate first (Builder or Admin in the app's domain, else 403); an approval *requires* `card.scan.passed`, else 409. Writes the decision onto the card, applies it to the app, and mirrors it into the Governance inbox. An orphaned card is auto-retired with a 409 telling you what to do. `review.ts:493-560` |
| `verify_software` | writes nothing to git or the runner. It returns the five-dimension TEST directive plus the spec, the committed files and the normalised refinements — and the verdict is **self-reported by the agent**, not computed. `platform-mcp.ts:291-325` |
| `get_software_status` | read-only, but reconciles at read time: `reconcileDeployStatus` re-polls the real Deployment and self-heals a stale `previewUrl`, failing soft on 403 or an outage. `discovery-waveb-tools.ts:294`, `:307-320` |

### The agentic app builder

`os-ui/tabs/software/lib/builder/**` is a second, flag-gated builder: a bounded
**planner → coder → build → reviewer** loop. `SoftwareBuilderMode = 'spec' | 'agentic'`, with `spec` the
default and anything that is not exactly `'agentic'` meaning `spec` — so a typo'd env can never silently
enable a different builder. There is exactly *one* guarded call site.
`os-ui/tabs/software/lib/builder/dispatch.ts:10-13`, `:18`, `:21-28`;
`os-ui/core/kernel/config.ts:637`; `charts/sovereign-agentic-os/values.yaml:1476`

Four properties are load-bearing. The core is pure with injected edges — `grounding.ts`,
`acceptance.ts`, `prompts.ts`, `loop.ts` and `dispatch.ts` have no model client, store, `fs` or `fetch`,
which is why the loop's headline property ("the first coder output fails to compile and the loop recovers
on iteration 2") is a deterministic unit test with a scripted coder rather than a live-model hope. The API
surfaces are *extracted from source*, never written down: the pack parses the shipped `core/app-sdk` /
`core/app-ui` source for the `OsClient` interface and each `*Props` type, because hand-writing that list
is how the prompt drifts from what the compile gate actually checks and the model gets blamed for a stale
brief. **Compile is the write gate** — the loop never writes anything itself, it calls `commitToApp`,
which runs the gate before any write and throws the diagnostics as a typed 422. And a machine check over
model-authored content must read the **AST**, not the text: scoring "this file reaches governed data" with
`String.includes('os.records.add')` is forgeable by a comment, a string literal or a JSX text node.
`os-ui/ARCHITECTURE.md:1284-1312`

One trap is recorded because the next person will hit it: anything the Build dispatch can reach must not
take a *static* import edge back to `@core/mcp/server`. That module top-level-awaits its experimental
bundle registration, one of those bundles imports `os-ui/tabs/software/lib/platform-mcp`, so a static edge
closes a cycle on a pending top-level await and **every test file that touches the MCP server hangs** — 28
of them, reported only as "unsettled top-level await". `os-ui/ARCHITECTURE.md:1314-1320`

### How to inspect it yourself

```bash
git show main:apps/invoices/app.yaml
git show main:apps/invoices/actions.yml
git log --oneline -- apps/invoices/
git log --grep='OS-Object: app:' --oneline      # every app commit, by identity
git tag --list 'app/invoices/v*'                # the release scheme — currently always empty
```

> **Not yet true:**
> - **There is no CI/CD path, no image builder and no registry.** Stated in six places in the tab,
>   including the engineering panel the user reads: "There is no external git forge, no CI runner and no
>   image registry in the OS." The archived Kaniko build service was deleted with zero call sites and
>   `config.ts` records that it is "NOT to be revived" (read-only upstream since June 2025, no CVE
>   fixes). `os-ui/tabs/software/lib/engineering.ts:107`; `os-ui/tabs/software/context.md:3`;
>   `os-ui/core/kernel/config.ts:281-286`
> - **The security scan is always the offline mock.** `securityScan(files, mode = 'offline-mock')`, and
>   the only production caller passes `opts.scanMode ?? 'offline-mock'` — *no caller anywhere passes
>   `'live'`*. The scanner is a real deterministic baseline (6 secret regexes, 4 SAST patterns and a
>   **two-entry hardcoded "known-bad deps" list standing in for Trivy/OSV**), and its own header says "a
>   live deploy swaps in the real scanners (Semgrep / Trivy / gitleaks) behind the same shape". Yet
>   `decide_deploy` *requires* `card.scan.passed` to approve, so an approval gate depends on a mocked
>   scanner. `os-ui/tabs/software/lib/scan.ts:9-11`, `:19-43`, `:116`; `review.ts:359`, `:541-546`
> - **`verify_software` runs no tests.** It returns a directive and trusts the agent's PASS/FAIL.
>   `platform-mcp.ts:291-325`
> - **No release tags are written.** `annotatedTag` exists in the git store with *zero callers*; the
>   `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>` scheme is documented and unimplemented, `release_software` did
>   not land, and `apps/<slug>/.app/release.json` was deliberately removed from the layout table because
>   declaring it would describe a file nothing writes. `os-ui/core/infra/git-store.ts:1304`;
>   `os-ui/core/infra/git-objects.ts:148-152`; gap-report rows S11, G10, V3
> - **App-declared actions never reach the agent tool catalogue.** The *enforcement* half is real —
>   `callAppTool` refuses an unported call at the adoption layer (403), executes an adopted read, holds an
>   adopted write (202) and refuses an ungranted one at the grant layer. The *registration* half is not:
>   app actions never enter `list_adoptable_actions`/`adopt_entity_actions`, which is the *connections*
>   exposure path and knows nothing about `parseAppActions` — a grep for `parseAppActions`/`appActions`
>   under `os-ui/tabs/agents/` and `os-ui/core/mcp/` returns nothing. Gap-report row S8
> - **An ungranted dataset reference is a warning, not a refusal.** `ungrantedDatasetWarningForApp` is a
>   *string*, consumed as a warning on the review card and at the server; nothing refuses, and lifecycle
>   rules are not in that path either. Gap-report row S9
> - **A same-origin frame is not fully isolated, and the code says so.** An app that simply sends neither
>   intent header is indistinguishable from the OS UI on our own origin —
>   `os-ui/core/kernel/app-intent.test.ts` carries that as a named GUARD. The complete fix is a
>   null-origin frame with a postMessage RPC for every OS call, recorded as deviation S-9 rather than
>   assumed. `os-ui/ARCHITECTURE.md:950-953`; gap-report §3 item 12
> - **No resource quota is imposed on a `runtime` app** — "whatever the iframe naturally constrains".
>   `os-ui/tabs/software/lib/app-runtime.ts:32-33`
> - **`commit` bypasses the staged governance.** It is a Developer-mode verb that skips the
>   Design→Build→Test flow and the design-before-build gate; Builder and Admin only, so a creator cannot
>   use it. `platform-mcp.ts:174`
> - **Coded apps are off by default** (`codedAppsEnabled: false`), enforced in three places.
>   `os-ui/tabs/admin/lib/settings.ts:97`; `os-ui/tabs/software/lib/apps.ts:1601`;
>   `os-ui/core/mcp/server.ts:211`
> - **The software runner is off by default** (`softwareRunner.enabled: false`), and
>   `softwareRunner.runnerImage` is empty, so `image` apps fail closed on a stock install.
>   `charts/sovereign-agentic-os/values.yaml:994`, `:1003`
> - **The engineering panel's git caveat is conditional, and the architecture note describing it is
>   stale.** `os-ui/ARCHITECTURE.md:1110` says the app's git section "states that app source is in the OS
>   file mirror and not yet an `apps/<slug>/` subtree"; the code reads the committed tree first and only
>   says that when `committed.length === 0`. `os-ui/tabs/software/lib/engineering.ts:78-92`
> - **`os-ui/tabs/software/build-spec/software.md` is superseded and should not be quoted**: it still
>   says the source lives "in the OS's own governed file store — there is no git server and no CI" and
>   describes a `nextjs-supabase` template, where the default scaffold is `sovereign-app`. `:10`, `:18-20`
---

## 9. Knowledge and Files — OpenSearch, DLS, Presidio, Docling

**What the user sees.** Upload a document, have it become searchable, and get answers that cite it —
with other people's documents absent rather than redacted.

**What actually runs.** OpenSearch, with a per-caller filter pushed into the query *and* re-checked in
code, because the real `security-plugin` document-level security is deferred to the managed platform. The
source says it in as many words: "real `security-plugin` DLS is **deferred to STACKIT** — here we add the
grant filter to the query AND re-check in code". `os-ui/tabs/knowledge/lib/retrieve.ts:29-31`;
`retrieve-core.ts:11-12`

| Index (literal) | Created by, and shape |
|---|---|
| `knowledge` | `ensureKnowledgeIndex()` — HEAD then PUT, mapping from `knowledgeIndexMapping(dim = config.embedDim)`: `settings.index.knn: true`, `embedding` as `knn_vector`, keywords `domain`/`workflow_id`/`step_id`/`type`/`actor`/`owner`/`version`/`visibility`, floats `trust`/`authority`. `os-ui/tabs/knowledge/lib/index-pipeline.ts:67-88`, `:95-102`; `os-ui/core/kernel/config.ts:176` |
| `files` | `ensureFilesIndex()`, mapping `filesIndexMapping(dim = config.filesEmbedDim)`: keywords `file_id`/`rep_type`/`owner`/`tier`/`domain`/`granted_users`/`tags`, a `freshness` date, `vector` as `knn_vector`. `os-ui/tabs/files/lib/index-store.ts:138-155`, `:158-163`; `config.ts:215` |
| `os-knowledge-records` | the workflow metadata mirror — `os-ui/tabs/knowledge/lib/store.ts:142-161` |
| `os-personal-knowledge` | personal knowledge — `os-ui/tabs/knowledge/lib/personal-store.ts:69` |
| `os-file-records` | file metadata — `os-ui/tabs/files/lib/store.ts:142-158` |
| `os-versions-<kind>` | the generic version log — `os-ui/core/kernel/versioning.ts:79`; `os-ui/tabs/files/lib/store.ts:164` |

Chart literals: `retrieval.indexName: knowledge` with `knnDimension: 384`;
`osUI.knowledgeIndex: "knowledge"`; `osUI.filesIndex: "files"`.
`charts/sovereign-agentic-os/values.yaml:608-610`, `:1346`, `:1348`

### The DLS filters, verbatim

There are **three** builders, two of them named `dlsFilter`. Knowledge, where audience is the
`visibility` keyword:

```ts
export function dlsFilter(principal: Principal): Record<string, unknown> {
  const visible: Record<string, unknown>[] = [
    { term: { visibility: 'Marketplace' } },
    { bool: { must: [{ term: { visibility: 'Shared' } }, { terms: { domain: principal.domains } }] } },
    { term: { owner: principal.id } },
  ];
  if (roleAtLeast(principal.role, 'builder')) {
    visible.push({ bool: { must: [{ term: { visibility: 'Personal' } }, { terms: { domain: principal.domains } }] } });
  }
  return { bool: { should: visible, minimum_should_match: 1 } };
}
```

`os-ui/tabs/knowledge/lib/retrieve.ts:62-72`. Pushed down at `:128` into the hybrid body
(`must: bm25Clause`, `should: knn.embedding`, `filter`) and into the BM25 fallback at `:148-152`, then
re-checked per hit at `:199`, `:205` against the authoritative predicate `canSee`
(`retrieve-core.ts:25-33`). A byte-identical private copy lives in
`os-ui/core/infra/agent-governed.ts:427-439` for the agent retrieve path, with its own per-hit re-check.

Files, where audience is the `tier` keyword:

```ts
export function compileDls(reader: Reader): DlsFilter {
  const should: Clause[] = [
    { term: { owner: reader.id } },
    { term: { tier: 'product' } },
    { bool: { filter: [{ term: { tier: 'asset' } }, { terms: { domain: reader.domains } }] } },
    { bool: { filter: [{ term: { tier: 'asset' } }, { term: { grantedUsers: reader.id } }] } },
  ];
  return { bool: { should, minimum_should_match: 1 } };
}
```

`os-ui/tabs/files/lib/dls.ts:55-63`; `Reader = { id, domains }` at `:26`; in-process evaluator
`evaluateDls` at `:110`.

### Docling

Docling converts the `FileKind`s `['doc','archive','other']` into a `'text'` representation chunked by
`'section'`, with OCR on, over the contract
`POST {DOCLING_URL}/convert {source} → { document: { texts: [{text}] } }` and an 8000 ms timeout; a second
adapter handles `['table']` with `options: { tables: true }`. It is the default adapter
(`liveAdapterFor(kind) ?? doclingLive`), reached from `reindexFile`/`reindexById`/`bootstrapFilesIndex`
and from `upload_file`. If it is unreachable the pipeline falls back to `mockAdapterFor(input.kind)` and
labels the result `mode: 'mock'`. `os-ui/tabs/files/lib/ingest/live.ts:30-45`, `:71`, `:81-82`,
`:90-99`, `:126-128`, `:138-140`; `os-ui/tabs/files/lib/pipeline-server.ts:34-54`;
`os-ui/tabs/files/mcp/file-write-tools.ts:227`

### Where the real artefact is

| Artefact | Where |
|---|---|
| a knowledge unit | a document in the `knowledge` index. Indexing is a `_delete_by_query` for the scope followed by a `_bulk?refresh=true`, plus an in-process `upsertUnits`. `os-ui/tabs/knowledge/lib/index-pipeline.ts:121`, `:149`, `:181`, `:194` |
| a knowledge identity | `RESOURCE_PREFIX = 'sovereign-os://knowledge/'` — knowledge is *not* a git-addressed object today. `os-ui/tabs/knowledge/lib/okf-model.ts:44` |
| a file | metadata in `os-file-records`, bytes in MinIO under `s3://files/<owner>/` or `s3://files/<domain>/`, representations in the `files` index. `os-ui/tabs/files/lib/asset-schema.ts:145-147` |
| embeddings | the `sovereign-embed` LiteLLM model, which on a kind install is the mock-model emitting deterministic 384-dimension vectors, with a deterministic local hash embedding as the fallback. `os-ui/core/kernel/config.ts:177-181` |
| Postgres | **nothing.** Neither tab references Postgres at all. |
| git | **nothing.** `knowledge/<slug>/` is declared in the layout table with an honest `backlog` writer; files are not a git object kind at all. `os-ui/core/infra/git-objects.ts:68-77`, `:168-177` |

### How to inspect it yourself

```
GET /_cat/indices?v
GET /knowledge/_mapping
GET /files/_mapping

# what a specific caller can see, by hand: the same filter the code pushes down
POST /knowledge/_search
{ "query": { "bool": {
    "filter": { "bool": { "minimum_should_match": 1, "should": [
      { "term": { "visibility": "Marketplace" } },
      { "bool": { "must": [ { "term": { "visibility": "Shared" } },
                            { "terms": { "domain": ["sales"] } } ] } },
      { "term": { "owner": "amir" } } ] } } } } }
```

> **Not yet true:**
> - **Presidio is absent, not stubbed.** Six occurrences exist in the whole repository: two in a
>   `gateway-mirror.test.ts` fixture (`{ guardrail_name: 'presidio-pii' }`) and four in a plan document
>   that proposes deploying it. There is no Presidio HTTP call, no `apply_guardrail`, no
>   `/guardrails/register`, no entity list (`EMAIL_ADDRESS`, `CREDIT_CARD`, `IBAN` … appear nowhere), no
>   chart key, no Deployment and therefore no fallback path. The only guardrail code is a read-only
>   mirror of whatever LiteLLM already has
>   (`readGuardrails = () => rows('/guardrails/list','guardrails')`). The PII control that *is*
>   implemented is the `restricted` sensitivity opt-out: `'restricted' ⇒ not indexed`.
>   `os-ui/tabs/admin/lib/gateway-mirror.test.ts:121`, `:125`;
>   `docs/superpowers/plans/2026-10-29-litellm-integration.md:22`, `:212`;
>   `os-ui/core/infra/litellm-admin.ts:176`; `os-ui/tabs/files/mcp/file-write-tools.ts:152`;
>   `os-ui/tabs/files/lib/index-pipeline.ts:64-66`
> - **Docling is deployed but unused by default.** `docling.enabled: true` stands up the pod, but
>   `osUI.doclingUrl: ""` — and empty means mock (`os-ui/tabs/files/lib/README.md:86`: "`DOCLING_URL` /
>   `TRANSCRIBE_URL` / `OCR_URL` (empty = off → mock)"). So the shipped chart runs the deterministic mock
>   ingest path even though the Docling pod is running. The code default *is* set
>   (`doclingUrl: base(env('DOCLING_URL','http://docling:5001'))`) and the admin console says "(Off by
>   default locally.)" — three sources, three different stories. The chart also pins the Docling image to
>   `tag: "latest"`. `charts/sovereign-agentic-os/values.yaml:733-737`, `:1351`;
>   `os-ui/core/kernel/config.ts:226`; `os-ui/tabs/admin/lib/platform.ts:92`
> - **The files named-grant DLS clause cannot match a live document.** The compiled filter emits
>   `grantedUsers` (`os-ui/tabs/files/lib/dls.ts:60`) while the index mapping and the bulk writer use
>   `granted_users` (`os-ui/tabs/files/lib/index-store.ts:148`, `:177`). The clause therefore matches only
>   in-process via `fieldValues` (`dls.ts:82`); a file shared with a named user *by grant alone* is
>   invisible in OpenSearch-backed retrieval. **This gap is in no plan document.**
> - **An agent's `search_files` is substring matching, not hybrid retrieval.** The real hybrid OpenSearch
>   search is `filesRetrieve` (`os-ui/tabs/files/lib/retrieve.ts:63`) and it has exactly one caller — the
>   UI route `os-ui/app/api/files/retrieve/route.ts:6`. `search_files` calls
>   `searchFiles(P(user), query)`, which is in-process token/substring scoring sliced to 20. The code
>   admits the split: "This is the UI search box; the agent-grade hybrid … lands in Phase 5's
>   `retrieve.ts`". `os-ui/tabs/files/lib/store.ts:722-727`, `:741-757`;
>   `os-ui/tabs/admin/mcp/discovery-read-tools.ts:296`, `:310`
> - **`get_knowledge` reads the in-process store, not OpenSearch**, so it can answer differently from
>   `search_knowledge`. `os-ui/tabs/admin/mcp/discovery-read-tools.ts:274`, `:283`
> - **Indexing on publish is best-effort.** `publish_knowledge` promotes through the governance seam and
>   then indexes inside a `try`/`catch` — "indexing is best-effort; publish already succeeded" — so a
>   published workflow can be unsearchable. `os-ui/tabs/knowledge/mcp/knowledge-write-tools.ts:253-262`
> - **There are no OpenSearch index templates and no aliases anywhere in the repository.** Index creation
>   is a per-index `PUT` with an inline mapping, so there is no reindex-behind-an-alias path.
>   `opensearch.securityConfig.enabled: false` and `opensearch.persistence.enabled: false` are the chart
>   defaults, meaning plain HTTP and ephemeral storage.
>   `charts/sovereign-agentic-os/values.yaml:566`, `:568`
> - **Several knowledge surfaces are explicitly stubs.** The tacit-knowledge recorder is "a *mocked*
>   in-app transcription" with a literal stub transcript and a button reading `● Record (stub)`;
>   `mock-entities.ts` is a "Mock entity resolver (kind-only)" whose `resolveEntityIndex` returns four
>   empty sets; the Rego guardrails are "the enforced default-deny-on-violation **stub**", and when OPA is
>   unreachable `guardrails-apply.ts` runs an "HONEST *in-process mock*" reporting `mode: 'opa-mock'`.
>   `os-ui/tabs/knowledge/ui/TacitPanel.tsx:11-12`, `:56-60`, `:114`;
>   `os-ui/tabs/knowledge/lib/mock-entities.ts:7-23`; `guardrails.ts:36`; `guardrails-apply.ts:13-37`
> - **The agent retrieve path has a hardcoded fallback passage.** `RETRIEVE_SEED` ("Discount Policy
>   (Certified)") is returned when OpenSearch has no hits. `os-ui/core/infra/agent-governed.ts:452-461`
> - **Neither Knowledge nor Files was scored by the acceptance report.** The streams are M, D, C, S, G, T,
>   E, V, X and H; there is no Knowledge row and no Files row, and the strings "docling", "OCR", "upload",
>   "index_knowledge" and "search_knowledge" do not appear in it. The three findings above are therefore
>   *unlogged* gaps rather than tracked ones. Gap-report `:30-39`

---

## 10. Connections — records without secrets

**What the user sees.** A catalogue of things to connect to, a form, a Test button, and a promotion
ladder from Personal to Shared to Certified.

**What actually runs.** The home of record is an in-process map plus an OpenSearch mirror —
`os-connections`, with siblings `os-exposures`, `os-action-adoptions`, `os-catalog-snapshots` and
`os-catalog-classifications`. There is no Postgres table for connection records; the `CREATE TABLE`
strings in the tab are Trino/Iceberg CTAS for warehouse *imports*.
`os-ui/tabs/connections/lib/store.ts:323`, `:333-335`, `:349-353`; `exposures.ts:107`;
`action-adoptions.ts:49`; `warehouse/catalog-snapshot.ts:58`; `warehouse/catalog-classification.ts:103`

### "Secrets are never in the records" — verified

The mechanism is a Secrets-Manager abstraction whose one rule is stated in the module header: "**the
secret never leaves Secrets Manager. The connection RECORD holds only a reference (`{ name, key }`)**".
`putSecret(name, key, value): SecretRef` stores the value; `getSecretServerSide` reads it server-side
only; `secretFingerprint` returns `sha256:<12 chars>`. `os-ui/core/infra/secrets.ts:9-19`, `:21-27`,
`:36-40`, `:51-55`, `:62-64`

The record carries a reference, a presence boolean and a fingerprint, and nothing else:
`secretRef: SecretRef` — "Reference into Secrets Manager — NEVER the secret value" —
`secretSet: boolean`, `secretFingerprint: string`. `os-ui/tabs/connections/lib/schema.ts:176`,
`:202-207` On create, the secret name is `connection-<slug>` and the constructed `Connection` literal has
no `credential` field at all; the warehouse branch does one `putSecret` per secret field with the comment
"NEVER put a secret value on the record (the ONE rule holds)"; the audit trace carries the *reference*
only. OAuth token sets are vaulted under the same reference — "The token set is the credential: it never
leaves the server, never enters a trace, log, or client response" — and a rename freezes the secret name,
pinned by a test. `os-ui/tabs/connections/lib/store.ts:612`, `:626`, `:631`, `:704-706`, `:718-731`,
`:783-788`; `os-ui/core/auth/connection-token.ts:22-23`, `:33-35`;
`os-ui/tabs/connections/lib/store.test.ts:85`

Kubernetes Secrets *do* exist, but only as a derived copy for Trino federation, one data key per
environment variable, named `trino-ext-<catalog>` — and keyless platforms (Glue via IRSA, BigQuery via
Workload Identity) declare no env vars, so no Secret is created. No secret *value* is ever returned or
logged; the outcome report lists key names only.
`os-ui/tabs/connections/lib/warehouse/k8s-registration.ts:16-20`, `:28`, `:52`, `:84-86`

Two caveats, because "secrets are never in the records" is true of the *credential* field and not of
every field.

- **The `endpoint` field is a real leak surface.** It is stored verbatim on the record and goes into the
  audit trace, and the template hint invites a URL (`postgres://db.example.com:5432/app`) — so a pasted
  `postgres://user:pass@host/db` persists the credential on the record. The mitigation exists only on the
  *error* path: a non-hostname-shaped host is redacted with "did you paste a credential into the endpoint
  field?". A dotted host with an embedded `user:pass` passes the allowlist check and is stored
  unredacted. `os-ui/tabs/connections/lib/store.ts:682-688`, `:723`, `:787`; `schema.ts:582`;
  `os-ui/tabs/connections/ui/shared.ts:142-161`
- **Four per-template config blocks are unscreened.** `airflow` (including `username`), `atlassian`
  (including `email`), `odata` (including `tokenUrl`) and `workday.reports` are populated straight from
  MCP arguments with no secret-name screening. The `warehouse` block alone is secret-filtered and rejects
  unknown keys. `os-ui/tabs/connections/lib/schema.ts:50-56`, `:69-73`, `:85-89`, `:105-107`;
  `mcp/discovery-connection-tools.ts:221-253`; `warehouse/connection.ts:57-76`

For contrast, the app-grant path *does* refuse an inline credential:
`if (!resource.ref || /password|secret|token|key=/i.test(resource.ref)) throw … 'A consumed resource is a
reference, never a raw credential'`. `os-ui/tabs/software/lib/lifecycle.ts:275-278`

### Where the real artefact is

| Tool | What it writes |
|---|---|
| `create_connection` | record → map + `os-connections`; credential → the vault as `connection-<slug>`/`tpl.secretKey`; an egress-allowlist check on the host; trace with the reference only. No Kubernetes Secret, no git. `os-ui/tabs/connections/mcp/discovery-connection-tools.ts:130`, `:205-267`; `lib/store.ts:575`, `:680` |
| `configure_connection` | `rename` → display name only (the secret name is frozen); `move` → `folder` + a folder row; `demote` → `visibility`; `capabilities` → `tools[].mode/limits`, recompiled into OPA via `compileProfile`/`registerConnectionProfile`. Demote and capabilities are re-gated to Builder and above. `discovery-connection-tools.ts:334`, `:338`, `:361-388`; `lib/store.ts:338-347`, `:801`, `:1538`, `:2813`, `:2894`, `:2911` |
| `test_connection` | reads the vault server-side and writes `mode`, `health`, `updatedAt`. Where no safe probe exists the status is an honest `untested`, never "verified". `lib/store.ts:1095`, `:1112`, `:1118-1155`, `:1187` |
| `promote_connection` | `promoteThroughSeam('connection', …)` → `visibility` Personal → Shared → Certified, write-through, trace. `domain_admin`. `discovery-connection-tools.ts:283-295`; `lib/store.ts:1501-1529` |
| `retire_connection` | `archive`/`unarchive` keeps the secret and the OAuth token. `delete` is physical: revoke exposures and adoptions, remove the live Trino catalogue and its credential-copy Secret, unregister the OPA profile, delete the record and the mirror doc, purge the version log, and `purgeConnectionSecrets`. The trace carries references only. `discovery-connection-tools.ts:303-327`; `lib/store.ts:2998`, `:3047-3070`; `lib/connections-physical-delete.ts:57-78` |
| `refresh_connection_catalog` | `admin`, re-gated in-call. Runs governed `SHOW SCHEMAS`/`SHOW TABLES` or the registry discover, and writes a snapshot document to `os-catalog-snapshots` with `takenAt`, `status` and `prevDiff`. `os-ui/core/mcp/experimental/exposure-write-tools.ts:225-237`; `lib/warehouse/catalog-snapshot.ts:162-193` |
| `use_connection` | not in this tab — it writes the *app* record (`app.consumes`, `app.manifest.connections`), not the connection. `os-ui/tabs/software/lib/platform-mcp.ts:136`, `:454-465`; `lifecycle.ts:263`, `:280-290` |

### How to inspect it yourself

```
# the record, and the absence of a secret in it
GET /os-connections/_search     # look for secretRef {name,key}, secretSet, secretFingerprint
                                # there is no `credential` field to find

# the derived copy, if a warehouse catalogue was registered
kubectl -n agentic-os get secret trino-ext-<catalog> -o jsonpath='{.data}' | jq 'keys'
```

> **Not yet true:**
> - **The Secrets Manager is itself a mock.** It is a module-scoped, server-only `Map` keyed
>   `"name/key"` on `Symbol.for('soa.secrets.vault')` — not a Kubernetes Secret, not Vault, not an
>   encrypted column. The header says so: "locally it is an in-process vault so the teaching flow works
>   with no cluster". The reference discipline is real and testable; the *store* behind it is not yet the
>   managed one. `os-ui/core/infra/secrets.ts:10`, `:17-27`
> - **The egress allowlist in code is a mirror, not the enforcement point** — "the live source of truth
>   is the egress proxy + Cilium FQDN policy". `os-ui/core/infra/secrets.ts:74-77`
> - **Data-source registration counts are fabricated, and the code says so.** "no live sync client is
>   injected here (the real fetch-backed clients are a server-side wire that does not exist yet), so
>   `sync.mode` is 'offline-mock' and the row/item counts are **FABRICATED**." The UI surfaces that
>   honestly, with badges and a banner. `os-ui/tabs/connections/lib/store.ts:1945-1950`;
>   `ui/ConnectionBuilder.tsx:526-527`, `:619-620`, `:885`
> - **The adapter layer is a deterministic offline mock** (`OpMode = 'live' | 'offline-mock'`), including
>   the OAuth consent on create (`authCode: 'mock-consent-grant'`).
>   `os-ui/tabs/connections/lib/connection-adapters.ts:25-28`, `:42`, `:169`; `lib/store.ts:700`
> - **The whole catalogue is declared preview.** "**UNDER CONSTRUCTION (PREVIEW): every connector in
>   this catalog is a preview that has NOT been end-to-end tested yet**."
>   `os-ui/tabs/connections/mcp/discovery-connection-tools.ts:52`, `:134`
> - **Connection configuration is not in git.** The layout table declares `connections/<slug>.yml` with a
>   `backlog` writer and the reason "connection CONFIGURATION (never a credential) has no git writer
>   yet"; no path-building or commit code exists in the tab. The nearest thing is a rendered YAML snippet
>   an operator pastes by hand into `.Values.trino.externalCatalogs[]` — and the connection's own endpoint
>   hint says so: `'trino-catalog (registered via GitOps values, not a URL)'`.
>   `os-ui/core/infra/git-objects.ts:178-187`;
>   `os-ui/tabs/connections/lib/warehouse/registration.ts:13-19`, `:38-39`; `lib/schema.ts:602`
> - **The ~45 vendor connectors have not been purged.** There are 28 templates (26 user-facing), 10
>   warehouse platforms, 36 install guides, and hand-built typed vendor clients still in the tree —
>   `salesforce`, `kajabi`, `github`, `supabase`, `atlassian`, `slack`, `gmail`, `gcal`, `outlook`,
>   `teams`, `entra`, `purview`, `ai-foundry`, `sagemaker`, `gcp-identity`, `gcp-directory`,
>   `snowflake-governance`, `notion`, `workday-raas`, `airflow` and `odata/*`.
>   `os-ui/tabs/connections/lib/schema.ts:385-1119`; `lib/warehouse/types.ts:37-49`; `lib/github.ts:38`
> - **Connections were not scored by the acceptance report either.** There is no Connections stream and
>   no row for any of its tools; the only mentions are `use_connection` among the thirteen unheld
>   platform writes, and `list_adoptable_actions` being the connections-exposure path that app actions
>   cannot reach. Gap-report `:80`, `:104`
> - **Stated non-support, in the templates themselves:** SOAP WWS incremental sync is v2, and the SAP
>   Cloud Connector is **not supported**. `os-ui/tabs/connections/lib/schema.ts:268`, `:277`;
>   `lib/install-guides.ts:320`

---

## 11. Lifecycle — the pin file, go-live and retire

**What the user sees.** A badge saying **Draft**, **Testing** or **Live**, a *Studio* / *Run* toggle on
the surfaces that have both, and a "Go live" dialog that names its dependencies before it does anything.
The words are a closed set: `LIFECYCLE_WORDS = ['draft','testing','live']` and
`AUDIENCE_WORDS = ['my','domain','company']`, declared as arrays so there is something to check at
runtime. `os-ui/core/kernel/object-lifecycle.ts:28`, `:35` The two view surfaces are
`['studio','run']` (`:56`).

**What actually runs.** Lifecycle is total over seven kinds — `dataset`, `metric`, `dashboard`, `agent`,
`app`, `knowledge`, `connection` — the same seven the audience ladder covers (`:69-78`).
`lifecycleOf(kind, id, head, index)` is pure, import-free and **never throws**: an unknown kind, a
missing index and an empty head all yield a well-formed value, because "there is something to edit" is
true even before the first commit lands (`:162-170`).

| Module | Job |
|---|---|
| `os-ui/core/kernel/object-lifecycle.ts` | pure, total: the words, the badges, the confirm copy, the go-live dependency guard, the migration and the `env:` mapping |
| `os-ui/core/kernel/lifecycle-adapters.ts` | the per-kind registry. The kernel may not import a tab, so each tab's `lib/lifecycle-adapter.ts` registers itself at boot from `instrumentation.ts`. A kind with no adapter is an honest typed refusal from `go_live`. |
| `os-ui/core/infra/lifecycle-pins.ts` | **the pin** — a durable index plus the committed, readable, not-pushable `os/lifecycle/pins.yml` in its own reserved subtree |
| `os-ui/core/kernel/go-live.ts` | the one service both doors call (`os-ui/core/mcp/lifecycle-tools.ts` and `os-ui/app/api/lifecycle/route.ts`). *There is no setter that takes a lifecycle word.* |
| `os-ui/core/mcp/list-args.ts` | the one optional `lifecycle` list filter. `withLifecycleArg` adds the property without touching a tool's `required`; `LIFECYCLE_TOOLS_WITHOUT_LIFECYCLE` names every exception with a reason. |

`os-ui/ARCHITECTURE.md:1247-1263`

The pin's own rule is the September-2026 outage lesson in a new place.
`os-ui/core/infra/lifecycle-pins.ts` records *how* it hydrated — the durable mirror, the committed
`os/lifecycle/pins.yml` in the domain repos, or nothing — through
`pinsHydrationState(): 'cold' | 'hydrated' | 'offline'`, and every writer refuses with a 503 unless one
of the first two answered. A mirror that answers but knows no pins is the dangerous shape, because a
rebuilt index looks exactly like a tenant that never went live; in that case the committed files are read
and adopted. `:19-22`, `:218`

The second rule is that a new gate must not break what already works. Before the one-time migration has
established the index nothing has a pin, so a scheduled agent run falls open to the head — once, loudly,
naming the fallback — and fails closed for ever after. `migrateExistingToLive` is idempotent by
construction: an object that already carries a pin keeps the pin it has, so re-running the migration
never re-pins a retired object back to life. `os-ui/core/kernel/object-lifecycle.ts:338-356`;
`os-ui/ARCHITECTURE.md:1272-1280`

### Where the real artefact is

| Artefact | Where |
|---|---|
| the pin file | `os/lifecycle/pins.yml` in every domain repo — `LIFECYCLE_PIN_PATH`, inside the reserved prefix `LIFECYCLE_PREFIX = 'os/lifecycle'`. `os-ui/core/infra/lifecycle-pins.ts:54-55` |
| the pin key | `pinKey(kind, id)`, parsed back by `parsePinKey` — this is also the `OS-Object` trailer id for a pin commit. `os-ui/core/kernel/object-lifecycle.ts:143`, `:148`; `lifecycle-pins.ts:588` |
| the commit | subject `lifecycle(<domain>): <action> <object> — via <surface>`, trailers `OS-Action` / `OS-Object` / `OS-Surface` / `OS-Request-Id: lifecycle-<base36>`, plus `OS-Actor` and `OS-Author-Email: synthesized` where it applies. `lifecycle-pins.ts:280-288`, `:539-540` |
| the durable index | the standard `globalThis` + OpenSearch write-through mirror (`os-ui/core/infra/os-mirror.ts`), so a laptop with no cluster works. `lifecycle-pins.ts:12-14`, `:30` |
| the LiteLLM dimension | `env:studio` / `env:test` / `env:run`, from `runEnvOf(word)` — `live → run`, `testing → test`, otherwise `studio`. Langfuse sets the trace `environment` to the same word. `os-ui/core/kernel/object-lifecycle.ts:378-386` |
| the budget split | `LIFECYCLE_BUDGET_SHARE` per `RunEnv`, surfaced to the gateway as `{ os_env, os_env_budget_share, max_budget }` — so a draft cannot drain the live key. `:394`, `:401-404` |

The file is written with a long comment header, on purpose, because it is the one OS-owned file an
engineer is most likely to open first in a clone (`renderPinFile`,
`os-ui/core/infra/lifecycle-pins.ts:500-521`):

```yaml
# What is LIVE in this domain — the pin the OS runs from.
#
# Lifecycle (Draft - Testing - Live) is a second axis beside audience (My - Domain -
# Company): this file answers "which version is running", not "who may use it".
# Everything that operates reads these refs: an agent schedule runs the pinned
# definition and Run serves the pinned spec. Editing an object moves its draft and
# leaves the pin alone until someone goes live again.
#
# This file is OS-owned: readable in every clone, and NOT pushable. A push that
# changes it is rejected with "managed by the OS; change it in the UI or over the MCP".
# Go live or retire in the UI, or over the MCP with go_live / retire.

version: 1
domain: sales
live:
  - …
```

### How to inspect it yourself

```bash
git show main:os/lifecycle/pins.yml
git log --oneline -- os/lifecycle/pins.yml   # a pin is a first-class versioned object kind
```

> **Not yet true:**
> - **`go_live` writes no git tag.** `GoLiveResult` carries `tag: { name, written }` and
>   `os-ui/core/kernel/go-live.test.ts` asserts `res.tag.written === false`: `liveTagName(kind, id)`
>   (`live/<kind>/<id>`) is computed but nothing calls `annotatedTag`, which landed in the git store with
>   no caller. The pin is the YAML file plus the durable index, and `tagged: false` says so honestly.
>   `os-ui/core/kernel/go-live.ts:186-187`; `os-ui/core/infra/lifecycle-pins.ts:22-24`;
>   `os-ui/core/kernel/object-lifecycle.ts:158`; gap-report row V3
> - **The pin path is not the flat file the plan described.** A single `os/lifecycle.yml` is not
>   representable with today's git-store exports without either reserving all of `os/` (which would
>   change the dbt generator's delete semantics) or a read-merge-commit race against it, so the file is
>   `os/lifecycle/pins.yml` inside its own reserved subtree. A rename, not a weakening — but the earlier
>   docs named the flat path. `os-ui/core/infra/lifecycle-pins.ts:15-18`
> - **Two kinds deliberately do not mount the badge.** Software and Knowledge have a per-kind row in
>   `os-ui/core/ui/lifecycle/lifecycle-cache.test.ts` reading "the badge is deliberately not mounted".
>   Gap-report §3 item 7
> - **There is no `__dev` schema and no lifecycle-conditioned Dagster schedule generation.** The `env:`
>   mapping exists and is tagged; a preview/staging/prod *physical* separation does not. Gap-report row
>   V14

---

## 12. Git versioning and the engineering view

**What the user sees.** One line in a detail header — `git <sha7> · <author> · <when>` — whose tooltip
carries the full sha, the action, the surface, the actor and the `git log --` command that would
reproduce it. Clicking it opens a drawer with the commit list, a per-commit unified diff against the
current version, and a restore confirm. Separately, an **Under the hood** panel shows the same object as
each tool sees it. `docs/components/git.md:201-203`

**What actually runs.** `os-ui/core/infra/git-objects.ts` is the single generic read-back.

| Function | MCP tool | Answers |
|---|---|---|
| `objectGitInfo(user, kind, id)` `:468` | `get_history` — `os-ui/core/mcp/git-tools.ts:92` | `{ head, history[], truncated, via, paths }` |
| `getVersion(user, kind, id, sha)` `:519` | `get_version` — `git-tools.ts:117` | the object's files exactly as they were at that commit |
| `diffVersions(user, kind, id, a, b)` `:566` | `diff_versions` — `git-tools.ts:139` | a unified diff an engineer could `git apply` — 40 lines of LCS, no diff dependency |
| `restoreVersion(user, kind, id, sha)` `:618` | *not on the MCP surface* | **one new commit** through the object's normal writer |

Four properties, each a decision rather than an implementation detail.

**1. `head` is never a wrong `null`.** The lookup keys on the `OS-Object` trailer *and* falls back to a
path-scoped `git log -- <paths>`, merged newest-first. The fallback is the point: boot reconciles commit
as the platform with `OS-Object: <domain>`, so a trailer-only lookup answered `null` for objects that
plainly have files in the tree, and the UI then said "never committed" about a system sitting in the
tree. `via` reports which source answered — `'trailer' | 'path' | 'trailer+path' | 'none'`.
`os-ui/core/infra/git-objects.ts:15-20`, `:296`

**2. The window is bounded and says so.** One domain repo mixes the dbt project, the agent systems, the
dashboards and every app, so a per-object history scans far more than it returns:
`DEFAULT_OBJECT_SCAN = 200` commits scanned, `DEFAULT_OBJECT_HISTORY = 10` returned, hard ceiling
`MAX_LOG_DEPTH = 2000`. `truncated: true` means "this is what fitted", never "this is all there is".
`git-objects.ts:307-309`; `os-ui/core/infra/git-store.ts:593`

**3. One `not_found`, byte-identical.** The owning tab's own governed read decides visibility; the
resolver answers `null` both for "you may not see this" and for "it does not exist", and this module
turns both into one message, `no <kind> '<id>'` — so an id cannot be probed for existence.
`git-objects.ts:21-23`, `:274-281` An unregistered kind is a *different* answer: a typed 501
`kind_not_wired` that names the gap, raised *after* the `not_found` gate so a refusal never confirms an
object exists. `:431-444`

**4. A restore is a new commit, never a rewrite.** `restoreVersion` reads the files at the old commit and
hands them to the kind's *normal* writer, so every invariant, validation, approval and trailer on the
normal path still applies. Nothing in `@core` knows how to write a dataset or a system, by design.
`:24-27`

Redaction sits at the read-out boundary and nowhere else, and the asymmetry is the whole design.
`readFilesAt` in the git store is raw on purpose; `getVersion` and `diffVersions` scrub, because they are
the only paths that hand repository bytes to a browser or an AI client. A redaction performed in the
primitive would be *written back* into the tree by a restore, replacing a real value with
`***REDACTED-BY-OS***`. `os-ui/core/infra/git-store.ts:932`; `os-ui/ARCHITECTURE.md:1018-1030` Two
consequences: a diff compares raw content and *then* redacts, so a change entirely inside a redacted value
is reported as a redacted change rather than as "no change"; and the patterns are shape-based, never
entropy-based, because a commit sha, a blob oid and a UUID are all high-entropy and redacting them would
corrupt every diff the drawer renders. A binary file comes back with `binary: true`, its size and an
*empty* content, and a version containing one cannot be restored (`binary_in_version`) because
re-applying that empty content would truncate the file. A version read is bounded at
`MAX_VERSION_FILES = 500` and `MAX_VERSION_BYTES = 4 MiB`. `git-store.ts:736`, `:902`

### The engineering view

One panel, one adapter per object kind, one structure over both doors.
`os-ui/core/engineering/types.ts` defines `EngineeringView` — per-tool sections, each with the tool's own
noun, the artefact (the real bytes), the repo path, a deep link and *the command an engineer would run* —
plus `sealView`, which refuses a view that is not honest: a section with no artefact and no reason, an
artefact with no body and no note, a link that does not resolve and does not say why. `:10-17`, `:44-61`,
`:63-68`, `:70-77`

`os-ui/core/engineering/registry.ts` maps kind → adapter and `register.ts` fills it with dynamic
`import()`, so the kernel still never imports a tab. Each tab owns `lib/engineering.ts`: it calls its own
visibility gate first — so the refusal a client sees is the tab's own `not_found` / `forbidden`, with no
new visibility rule anywhere — and then maps its record onto the shared builders in
`os-ui/core/engineering/sections.ts`. `os-ui/core/ui/engineering/UnderTheHood.tsx` is the only renderer,
and `GET /api/engineering/<kind>/<id>` and the MCP tool `get_engineering_view` both call
`engineeringViewFor`. `os-ui/ARCHITECTURE.md:1080-1090`; `os-ui/core/mcp/engineering-tools.ts:51`

**The vocabulary rule is data, not prose.** `os-ui/core/engineering/vocabulary.ts` lists each tool's own
nouns — `'dbt model'`, `'Dagster asset check'`, `'LangGraph interrupt'`, `'Langfuse observation'`,
`'Trino catalog'`, `'LiteLLM key alias'` — and the OS's own nouns separately (`'data product'`, `'KPI'`,
`'AI team'`, …). A label that uses only an OS-invented noun fails `vocabularyViolations`, which both the
panel copy test and every adapter test run; the bridge form ("dbt metric (KPI)") is allowed once.
`:20-28`, `:43-45`, `:50-60`

The five kinds with an adapter are `dataset`, `metric`, `dashboard`, `agent_system` and `app`
(`os-ui/core/engineering/types.ts:27`), and each builds its sections from the same five builders:
`dbtSection`, `dagsterSection`, `langgraphSection`, `gitSection`, `langfuseSection`
(`sections.ts:58`, `:128`, `:190`, `:238`, `:291`).

### Registered readers, as of this head

| Kind | Registered reader | Registered restorer |
|---|---|---|
| `agent-system` | `os-ui/tabs/agents/lib/git/history.ts` `registerAgentSystemGitObject()` — `instrumentation.ts:512-513` | none |
| `software` | `os-ui/tabs/software/lib/git-object.ts` `installSoftwareGitObject(registerGitObject)` — `instrumentation.ts:523-525` | none |
| `dashboard` | `os-ui/tabs/dashboards/lib/git/git-object.ts` `dashboardGitObjectResolver` — `instrumentation.ts:534-536` | none |
| `dataset` | `os-ui/tabs/data/lib/git-object.ts` `datasetGitObjectResolver` — `instrumentation.ts:547-549` | none |
| `metric` | `os-ui/tabs/metrics/lib/git-object-server.ts` `metricGitObjectResolver` — `instrumentation.ts:555-557` | none |
| `lifecycle-pin` | `os-ui/core/infra/lifecycle-pins.ts` `lifecyclePinGitObjectResolver` — the one kind whose writer is in `@core`, so its resolver lives beside its writer — `instrumentation.ts:565-567` | none |
| `knowledge-workflow` | **none** — typed 501 `kind_not_wired` | none |
| `connection-config` | **none** — typed 501 `kind_not_wired` | none |

Each registration stands alone inside its own `try`/`catch` and logs either
`git versioning: <kind> registered` or `git versioning: <kind> NOT registered — <reason>`, so a resolver
that cannot be installed leaves *its* kind answering the typed 501 rather than breaking boot.
`os-ui/instrumentation.ts:505-507`

### How to inspect it yourself

```bash
git log --oneline -- agents/<slug>/            # the per-object history the drawer renders
git show <sha>:agents/<slug>/system.yaml       # one version of one file
git diff <a> <b> -- agents/<slug>/             # the diff the drawer renders
```

Two surfaces in `/api/git` are tenant-wide and unscoped by domain — `?action=repos` (every repository,
with its mirror URL and push errors) and `?action=repolog&domain=…` (one repository's commit log, whose
subjects carry each object's slug, which for a Personal object is somebody's own artefact name). Both are
therefore admin-only, and the commit log carries a *second*, independent gate on top of the role: a row
appears only when its `OS-Object` trailer resolves — through the owning tab's own governed read, as the
caller — to an object that caller may see. Rows that do not resolve are counted and reported with a reason
(`hidden`), never silently dropped, and a kind whose resolver is not registered counts as not resolvable:
this surface fails closed. `docs/components/git.md:175-196`; `os-ui/core/infra/git-objects.ts:822`

The mirror verdict has four states for one reason: `pushMirror` records the sha it last pushed, and a push
that succeeded two commits ago is not a healthy mirror. `ok` requires the last successful push to be *at*
the repository's current head; an older one reads `behind` and names both shas; a failed attempt reads
`failed` and carries the real error; no configuration reads `none`. A boolean would have made the most
common real state — configured, working, one commit behind until the next write — look identical to either
health or failure. `os-ui/ARCHITECTURE.md:1004-1016`

> **Not yet true:**
> - **Restore is wired for no kind.** The gate, the refusals and the "new commit, through the writer"
>   contract are implemented and tested, but no tab has called `registerGitObjectRestorer`, so
>   `restoreVersion` answers `restore_unsupported` for every kind today. The UI's "Restore this version"
>   button surfaces exactly that refusal rather than hiding it.
>   `os-ui/core/infra/git-objects.ts:240-245`; `docs/components/git.md:212-215`; gap-report row G9
> - **`restore_version` is not an MCP tool.** A write tool must be declared in the governed write
>   catalogue (`os-ui/core/mcp/write-tools.ts` + `write-tool-meta.ts`), and today its only possible answer
>   is `restore_unsupported`; it is one row in two files once a kind registers a writer.
>   `docs/components/git.md:208-211`
> - **Two of eight kinds have no reader at all.** `knowledge-workflow` and `connection-config` answer the
>   typed 501 `kind_not_wired` — honest, and also no history, no diff and no git badge for either.
> - **No `trino` or `litellm` engineering section exists.** Both are members of `ENGINEERING_TOOLS` with
>   vocabulary entries and no producer; a preview button without a query budget was judged a live
>   incident, so the sections were not built. `os-ui/core/engineering/types.ts:23`;
>   `vocabulary.ts:26-27`; gap-report row T10
> - **The release panel is hidden, not empty.** `os-ui/core/ui/git/ReleaseList.tsx` reads an app's release
>   tags, and since no annotated tag is ever written it is hidden entirely rather than shown empty.
>   `docs/components/git.md:203`; gap-report row G10
> - **`repoFileHref` has no caller.** The clone card is mounted on all five detail surfaces and tested,
>   but no surface passes a `filePath`, so no artefact links to its own file in the repository. Threading
>   a path per kind is not a one-line mount, because a dashboard's directory is slugged from its *name*
>   and slug ≠ id. Gap-report iteration-2 decision 7 (row E10, half)

---

## 13. The engineer's door — git-http, tokens, the receive gate

**What the user sees.** A clone command on a detail page, a token screen under **Platform → Access
tokens**, and afterwards an ordinary VS Code working copy. A rejected push is a readable sentence on the
terminal naming the file and the reason.

**What actually runs.** `git clone` and `git push` are served by **git's own `git-http-backend` CGI**
behind lighttpd. The OS writes no git protocol. The whole server configuration is one CGI, one URL
prefix, no document root and no directory listing:

```
server.modules = ( "mod_alias", "mod_setenv", "mod_cgi" )
server.port = 9419
index-file.names = ( )
dir-listing.activate = "disable"
setenv.add-environment = (
  "GIT_PROJECT_ROOT"             => "/repos",
  "GIT_HTTP_EXPORT_ALL"          => "1",
  "GIT_HTTP_MAX_REQUEST_BUFFER"  => "200M"
)
alias.url += ( "/git" => "/usr/libexec/git-core/git-http-backend" )
```

`images/base/git-http/lighttpd.conf:6-36`

`GIT_HTTP_EXPORT_ALL=1` is required because the bare repos are written by `isomorphic-git` and carry no
`git-daemon-export-ok` marker — the same allowance the read-only `git-daemon` sidecar already makes
(`:30-31`). A push is a POST whose body lighttpd buffers to disk, and the body cap matters:
`max-request-size` is in kilobytes, so `524288` is 512 MiB, comfortably under the 2 GiB `emptyDir` and
matching the git Ingress's own `proxy-body-size: 512m`. An uncapped body on a read-only root filesystem
can take the whole pod out (`:19-25`).

It runs as a separate non-root process in a sidecar on the os-ui pod with the `os-repos` volume mounted
(`charts/sovereign-agentic-os/templates/base/os-ui/os-ui.yaml:238`), and the `NetworkPolicy` admits port
9419 from the ingress controller's namespace only (`os-repos.yaml:74-83`). The read-only clone path for
Dagster is a different port on the same pod: a
`git daemon --export-all --base-path=/repos --port=9418` sidecar whose own policy admits only the Dagster
user-code pod (`os-ui.yaml:258-260`; `os-repos.yaml:45`, `:72`).

**Authentication is the OS's, not the transport's.** The Ingress sends every `/git/**` request to os-ui's
`/api/git/authenticate` as an `auth-url` sub-request, which resolves an OS personal access token to a
live principal and checks domain membership; only then does nginx forward to the sidecar, copying the
resolved principal onto the request as `X-Os-Principal`, `X-Os-Principal-Role` and `X-Os-Token-Prefix`.
TLS is not optional on this path, because a token travels in every request: the Ingress carries
`force-ssl-redirect: "true"` and `os-ui/core/infra/git-clone.ts` only ever prints an `https://` remote,
loopback excepted. `templates/base/os-ui/os-git-http.yaml:11-19`, `:71-77` The whole object renders only
when `osUI.dataProjectGit.enabled` **and** its `gitHttp.enabled` are set (`:29`).

No token, an expired one or a revoked one is a `401`; a domain you are not a member of is a `404`, because
naming it would tell a stranger it exists. `docs/components/git.md:263-267`

### The push, in order

1. **The ingress authenticates you**, as above.
2. **The OS takes the repository's lock.** The `pre-receive` hook calls one OS endpoint,
   `RECEIVE_ENDPOINT = '/api/git/receive'` (`os-ui/core/infra/git-receive.ts:662`), which holds the *same*
   per-domain lock the OS's own commit path uses, for the duration of `receive-pack`. It is held as a
   *lease* keyed on the domain, because two hook processes cannot pass a handle — hence `acquireRepoLock`
   rather than `withRepoLock`, which is why the git store exports a release handle at all.
   `os-ui/core/infra/git-store.ts:104-112`; `git-receive.ts:29-33` The wait is bounded
   (`DEFAULT_LOCK_TIMEOUT_MS = 20_000`) and the lease expires by itself
   (`DEFAULT_LEASE_TTL_MS = 180_000`), so a push never hangs a terminal (`git-receive.ts:80-83`).
3. **The hook, not the OS, computes the verdict.** During `pre-receive` the objects are in git's
   quarantine (`GIT_QUARANTINE_PATH`), visible only to the hook's process tree. The first version of this
   module called `isomorphic-git` against the bare repo and therefore failed *every* push:
   `isDescendent` threw, which read as "not a fast-forward" (409), and a first push into an empty repo was
   a 500. So the hook script — generated by `receiveHookScript('pre' | 'post')` — uses git's own plumbing
   (`git merge-base --is-ancestor`, `git diff-tree -r --name-status`, `git cat-file blob`) and posts paths
   plus base64 blobs. `git-receive.ts:10-18`, `:680`
4. **Fast-forward only.** `docs/components/git.md:268-270`
5. **Path ownership.** `decidePath(filePath, pusher)` is pure, which is what lets the unit tests enumerate
   it. Your own personal lane is always yours; shared domain paths need `builder` or above; someone
   else's personal lane is never writable whatever your role; and the OS-owned prefixes and files are
   refused with the verbatim constant `MANAGED_BY_OS` — *"managed by the OS; change it in Governance or
   over the MCP"*. `git-receive.ts:49`, `:337-346`
6. **The same validators the UI and the MCP call**, through `registerRepoKind` (`:143`).
7. **The `post-receive` hook reconciles from the repository.** `completeReceive` re-derives the changed
   files from the now-real refs and `reconcileFromGit(domain, from, to, pusher)` dispatches to each kind's
   `ingest`, inside `runWithSurface('git:push')`. `:528`, `:590`

### Where the real artefact is

| Thing | Where it lives |
|---|---|
| the clone URL | `https://<os-host>/git/<domain>.git` — built by `os-ui/core/infra/git-clone.ts`, HTTPS-only with loopback excepted, and "nothing rather than half a command" when it cannot build one. `os-ui/core/infra/git-clone.test.ts` |
| the token | `sos_<12 hex>_<43 base64url>`, stored as `sha256$<hex>` of the whole string. `os-ui/core/auth/access-tokens.ts:26-32`, `:51-53` |
| the hooks | `<reposDir>/<domain>.git/hooks/{pre,post}-receive`, installed idempotently by `ensureReceiveHooks(domain)` and memoised on a global symbol. `git-receive.ts:790`, `:809` |
| the lighttpd image | `images/base/git-http` — `Dockerfile` + `lighttpd.conf`; the build **fails** if `git-http-backend` or `mod_cgi` is missing from the distro packages, the same guard `images/base/git-daemon` carries, because the first rollout of the read-only daemon crash-looped on a stock image that silently omitted the binary. `docs/components/git.md:383-389` |
| the Service and Ingress | `os-git-http` (port 9419) and `os-git-http-ingress`, a second Ingress on the same host for the `/git` prefix only — ingress-nginx merges rules per host, so it adds one path without touching the shared ingress template. `os-git-http.yaml:30-44`, `:48-53` |

Licensing, since all three are distro packages run as separate processes with nothing linking to our
code: `git` is GPL-2.0, `lighttpd` BSD-3-Clause, `curl` MIT-like. `docs/components/git.md:375-378`

### How to inspect it yourself

```bash
# the whole domain repo over authenticated HTTPS
git clone https://<os-host>/git/<domain>.git
#   username: anything (ignored)   password: sos_…

# the read-only path Dagster uses, from inside the cluster
git clone git://os-ui.agentic-os.svc.cluster.local/<domain>.git

# build the sidecar image
docker build -t ghcr.io/aborek/sovereign-os/git-http:1.0.0 images/base/git-http
```

### Troubleshooting, in the messages the OS actually prints

| What you see | What it means |
|---|---|
| `fatal: Authentication failed` | no token, wrong token, expired or revoked |
| `remote: '…' is managed by the OS; change it in Governance or over the MCP` | you changed a file the OS owns; drop it from the commit |
| `remote: this push is not a fast-forward of main` | rebase onto the current `main`; the OS never accepts a rewrite |
| `remote: the OS is writing to '<domain>' right now…` | an OS write held the lock past the bounded wait. Nothing changed; push again. `os-ui/core/infra/git-store.ts:113-122` |
| `remote: dataset: 0 created, 0 updated` | the push landed but nothing in it maps to an OS object — for example a `.sql` change with no `schema.yml`. The files are stored; the registry is unchanged *by design*. |
| `remote: '…/' would be emptied by this push` | you removed every file of an object. Retire it in the OS instead. |
| `remote: audience is managed by the OS; use promotion` | the file's `tier`/`visibility` disagrees with the OS |
| `remote: '…' is …; this door accepts files up to 1048576 bytes` | a large (usually binary) file. A domain repository holds definitions, not artefacts. |

`docs/components/git.md:393-404`

> **Not yet true:**
> - **The image is not built or pushed.** `git-http:1.0.0` does not exist in a registry, so there is no
>   HTTPS endpoint to clone from and the live clone/push round trip has never run. Everything above is
>   covered offline by a fake receive — a real bare repo in a temp dir, a synthetic push, the endpoint
>   called directly — and the real round trip is a deploy-time check.
>   `docs/components/git.md:443-445`; gap-report §3 item 10 (row E1)
> - **A creator cannot reach the token screen.** `POST /api/git/tokens` has no role floor — any signed-in
>   user may mint one — but the Access-tokens section is gated at `minRole: 'builder'`, and it is the only
>   UI that shows the token once. That contradicts "read is unconditional; anyone with access to a domain
>   can clone". The fix is one word; it is a posture decision.
>   `os-ui/tabs/admin/lib/sections.ts:64`; gap-report §3 item 4
> - **`kubectl port-forward` goes around the NetworkPolicy.** The policy admits 9419 from the ingress
>   controller only, and the Ingress is where authentication runs — so a port-forward to the pod reaches
>   `git-http-backend` with *no authentication in front of it* and can read every domain repository. That
>   is a cluster-admin capability (`pods/portforward`), and anyone holding it can read the PVC anyway, but
>   it means repository read access is not limited to token holders for operators.
>   `docs/components/git.md:409-416`
> - **With `ingress.enabled=false` there is no authentication in front of the sidecar at all.** On the
>   bundled / local profile nothing outside the cluster can reach it and the policy admits only an ingress
>   namespace that does not exist, so in practice the port is reachable only from inside the pod. The
>   *push* path authenticates itself either way — the hook forwards the token and the OS re-resolves it —
>   but the *read* path on that profile is protected by the network, not by a credential.
>   `docs/components/git.md:417-422`
> - **The gate skips `agents/index.yml` ids unknown to the registry** — by design, and correctly: an
>   empty-hydrated registry is the September-2026 outage shape. Gap-report §3 item 15
> - **Branches as proposals, PR-like review in the UI, apps by push and VS Code snippets** are all named
>   in `docs/components/git.md` → "What is NOT true yet" and none is in the tree. Gap-report row E12
---

## Appendix A — `GIT_OBJECT_LAYOUT`, verbatim

This is the canonical kind → path → writer table, reproduced from
`os-ui/core/infra/git-objects.ts:110-187` with its comments intact, because the comments are where the
corrections live. `os-ui/core/infra/git-objects-kinds.test.ts` parses the mirrored table in
[`docs/components/git.md`](components/git.md) and deep-equals it against this object, so the two cannot
drift.

```ts
export const GIT_OBJECT_KINDS = [
  'dataset',
  'metric',
  'dashboard',
  'agent-system',
  'software',
  'lifecycle-pin',
  'knowledge-workflow',
  'connection-config',
] as const;

/**
 * THE REPO LAYOUT TABLE — authoritative, and mirrored in `docs/components/git.md`. One bare repo
 * per domain at `<OS_REPOS_DIR>/<domain>.git`, `main` only.
 */
export const GIT_OBJECT_LAYOUT: Record<GitObjectKind, GitObjectLayout> = {
  dataset: {
    kind: 'dataset',
    label: 'dbt model',
    paths: ['dbt_project.yml', 'profiles.yml', 'models/', 'os/schedules.yml', 'os/sources.yml', 'os/external.yml'],
    personalLane: 'models/personal/<uid>/',
    writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'engine rebuild B1' },
  },
  metric: {
    kind: 'metric',
    label: 'dbt metric',
    paths: ['models/semantic/<model>.yml'],
    personalLane: 'models/personal/<uid>/semantic/<model>.yml',
    // Night-2 merge: stream M landed the semantic emitter, which writes
    // `models/semantic/<model>.yml` (personal lane `models/personal/<uid>/semantic/`) through the
    // SAME dbt commit module as a dataset, stamping `OS-Object: metric:<datasetId>.<measure>`
    // (`metricObjectId`). ITERATION 2: the reader is wired too —
    // `tabs/metrics/lib/git-object-server.ts` resolves `{domain, semanticModel, ownerUid}` through
    // the tab's own governed `getMetric` read, so this kind no longer answers `kind_not_wired`.
    writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'night 2, stream M' },
  },
  dashboard: {
    kind: 'dashboard',
    label: 'dashboard-as-code',
    paths: ['dashboards/index.yml', 'dashboards/<slug>/'],
    personalLane: 'dashboards/personal/<uid>/<slug>/',
    // Night-2 merge: stream D landed the writer, so the row is flipped. The resolver resolves the
    // slug through the committed `dashboards/index.yml` (`pathsForDashboard`) — slug != id.
    writer: { state: 'committed', via: 'tabs/dashboards/lib/git/commit.ts', since: 'night 2, stream D' },
  },
  'agent-system': {
    kind: 'agent-system',
    label: 'LangGraph system',
    paths: ['agents/index.yml', 'agents/<slug>/'],
    personalLane: 'agents/personal/<uid>/<slug>/',
    writer: { state: 'committed', via: 'tabs/agents/lib/git/commit.ts', since: 'engine rebuild D' },
  },
  software: {
    kind: 'software',
    label: 'app source tree',
    // Night-2 merge: `apps/<slug>/.app/release.json` is NOT a path tonight — `release_software`
    // did not land, so declaring it would describe a file nothing writes.
    paths: ['apps/<slug>/'],
    personalLane: null,
    writer: { state: 'committed', via: 'tabs/software/lib/git-commit.ts', since: 'night 2, stream S' },
  },
  'lifecycle-pin': {
    kind: 'lifecycle-pin',
    label: 'lifecycle pin',
    // Night-2 merge: V landed the writer, and the PATH is not what this row guessed. A single
    // `os/lifecycle.yml` is not representable with today's git-store exports, so V commits
    // `os/lifecycle/pins.yml` inside its own reserved subtree (`LIFECYCLE_PIN_PATH`), and the
    // writer is `core/infra/lifecycle-pins.ts` — `core/kernel/lifecycle.ts` reaches no commit
    // primitive. Both corrected here rather than left describing a file nothing writes.
    paths: ['os/lifecycle/pins.yml'],
    personalLane: null,
    writer: { state: 'committed', via: 'core/infra/lifecycle-pins.ts', since: 'night 2, stream V' },
  },
  'knowledge-workflow': {
    kind: 'knowledge-workflow',
    label: 'knowledge workflow',
    paths: ['knowledge/<slug>/'],
    personalLane: 'knowledge/personal/<uid>/<slug>/',
    writer: {
      state: 'backlog',
      reason: 'the knowledge store has no git writer yet; the workflow definition still lives only in the registry (plan: stream G backlog)',
    },
  },
  'connection-config': {
    kind: 'connection-config',
    label: 'connection configuration',
    paths: ['connections/<slug>.yml'],
    personalLane: null,
    writer: {
      state: 'backlog',
      reason: 'connection CONFIGURATION (never a credential) has no git writer yet (plan: stream G backlog)',
    },
  },
};
```

The supporting types, from `os-ui/core/infra/git-objects.ts:90-104`:

```ts
export type GitWriterState =
  | { state: 'committed'; via: string; since: string }
  | { state: 'landing'; via: string; stream: string }
  | { state: 'backlog'; reason: string };

export type GitObjectLayout = {
  kind: GitObjectKind;
  /** The tool's own noun, for a UI label (vocabulary rule). */
  label: string;
  /** Repo paths, exactly as `docs/components/git.md`'s table states them. */
  paths: string[];
  /** The personal lane, or null for a kind that is owned rather than laned. */
  personalLane: string | null;
  writer: GitWriterState;
};
```

The **reader** is not in this table. Readers are registered at boot by each owning tab (see section 12);
a committed kind with no registered reader answers a typed 501 `kind_not_wired`.

---

## Appendix B — every MCP tool that touches git or a tool

Grouped by what they touch. "Commits" means the tool's write reaches `commitTree`/`commitSubtree` on a
domain repository, directly or through the owning tab's change hook.

### B.1 Generic git and engineering reads

| Tool | Reads / writes |
|---|---|
| `get_history` | reads `objectGitInfo(kind, id)` → `{head, history[], truncated, via, paths}` — `os-ui/core/mcp/git-tools.ts:92` |
| `get_version` | reads the object's files at a sha, secret-scrubbed, binaries named not decoded — `:117` |
| `diff_versions` | reads a unified diff of two shas — `:139` |
| `get_engineering_view` | reads the per-tool sections (dbt / Dagster / LangGraph / git / Langfuse) for one object, identical to the panel — `os-ui/core/mcp/engineering-tools.ts:51` |
| `get_lineage` | reads Dagster's asset graph, folded into the unified `LineageGraph` with a field saying which source answered — `os-ui/core/mcp/governance-tools.ts:239` |
| *`restore_version`* | **not on the MCP surface.** The function exists and is gated; its only possible answer today is `restore_unsupported` — `docs/components/git.md:208-211` |

### B.2 Lifecycle — writes `os/lifecycle/pins.yml`

| Tool | What it writes |
|---|---|
| `go_live` | commits the pin file for the object's domain; returns `tag: {name, written}` with `written: false` always — `os-ui/core/mcp/lifecycle-tools.ts:84`; `os-ui/core/kernel/go-live.ts:186-187` |
| `retire` | commits the pin file, removing the live row — `lifecycle-tools.ts:96` |

### B.3 Data — every write regenerates and commits the whole dbt tree

The surface is recorded as `mcp:<tool>` in `OS-Surface` and as `os/surface` on the Dagster run. All in
`os-ui/core/mcp/experimental/data-write-tools.ts` unless noted.

| Tool | What it writes |
|---|---|
| `create_dataset` | commits `create dataset` — `:113` |
| `add_dataset_version` | commits; an *authored* body becomes a dbt **source**, not a model — `:143` |
| `document_dataset` | commits — descriptions land in `schema.yml` — `:181` |
| `ingest_dataset` | Bronze landing via the data-runner and PyIceberg; the table becomes a dbt `source` — `:211` |
| `transform_silver` | commits *and* launches a Dagster run — `:260` |
| `build_gold_join` | commits *and* launches a Dagster run — `:312` |
| `define_quality_rules` | commits — rules become `data_tests` in `schema.yml` — `:433` |
| `run_quality_checks` | no git; reads Dagster asset checks — `:476` |
| `propose_quality_fixes` / `apply_quality_fixes` | no git; `queryRun`/`executeRun` as the resolved principal — `:495`, `:528` |
| `set_dataset_sync` | commits `os/schedules.yml` and `os/sources.yml`; removes a pre-B2 CronJob and provisions none — `:642` |
| `sync_dataset_now` | launches a Dagster run as the *dataset owner*, reusing `os/batch_id` on a retry — `:712` |
| `reconcile_domain_tables` | no direct git write — `:745` |
| `retire_dataset` | commits `retire` / `archive` — `:603` |
| `query_data` | no git. OPA `authorize(domainPrincipal,'query')`, then `queryRun(sql, readPrincipalFor(sql, user))` on Trino. Labelled `ad-hoc-sql`. `os-ui/tabs/data/mcp/data-query-tools.ts:16`, `:35-37`, `:46-66` |
| `profile_dataset` | no git — `os-ui/tabs/admin/mcp/discovery-read-tools.ts:145` |
| `adopt_exposed_table` | commits `adopt connected table` — `os-ui/core/mcp/experimental/exposure-write-tools.ts:298` |
| `create_exposure_set` | no dbt git write; recompiles the OPA and Trino rules — `exposure-write-tools.ts:118`, `:145-154` |
| `refresh_connection_catalog` | no git; writes a snapshot to `os-catalog-snapshots` — `exposure-write-tools.ts:225` |

### B.4 Metrics — commits `models/semantic/<model>.yml`

| Tool | What it writes |
|---|---|
| `suggest_metrics` | nothing — "A draft is NOT a metric" — `os-ui/tabs/metrics/mcp/metric-write-tools.ts:123`, `:137-140` |
| `preview_metric` | persists nothing; returns rows, `sql` and `mode` — `:264` |
| `define_metric` | commits the semantic YAML with `OS-Object: metric:<datasetId>.<measure>` — `:165`; `os-ui/tabs/data/lib/dbt/commit.ts:135-140` |
| `promote_metric` | a creator-owner *files an approval* and writes no git; a builder or above moves the dataset tier, which moves the file between lanes on the next regeneration — `:345`, `:370-394` |
| `list_metrics` / `query_metric` | no git; `query_metric` is labelled `semantic-layer` and withholds a scalar at the row bound — `os-ui/tabs/admin/mcp/discovery-read-tools.ts:314`, `:325`, `:367`, `:410-420` |

### B.5 Dashboards — commits `dashboards/`

| Tool | What it writes |
|---|---|
| `create_dashboard` | the *only* dashboard write tool. `saveDashboard` → `announce` → `emitDashboardChange` → `commitSubtree`, writing `dashboards/index.yml`, `dashboards/<slug>/dashboard.yaml` and `README.md` — `os-ui/tabs/dashboards/mcp/dashboard-write-tools.ts:119`; `lib/store.ts:173`, `:298-304`; `lib/git/commit.ts:147`, `:227` |
| `get_dashboard` / `list_dashboards` | no write — `os-ui/tabs/admin/mcp/discovery-waveb-tools.ts:128`; `discovery-read-tools.ts:462` |

### B.6 Agents — commits `agents/`, writes Postgres and Langfuse

| Tool | What it writes |
|---|---|
| `create_agent_system` | commits `agents/<slug>/` + `agents/index.yml` |
| `commit_agent_files` | commits the system's files — `system.yaml`, the per-agent `.md` files, `graph.json`, `README.md` — `os-ui/tabs/agents/lib/git/commit.ts` |
| `build_agent_system` | compiles the graph with `buildGraph` and inert deps; may mint the system's own LiteLLM virtual key (held by secret reference) — `os-ui/ARCHITECTURE.md:300-310`; `os-ui/core/infra/litellm-credential.ts:62-68` |
| `run_agent_system` | files a `run_jobs` row through `startQueuedRun`; the run writes `run_events`, LangGraph checkpoints and one Langfuse trace `id = runId` |
| `resume_agent_run` | re-queues the same `run_jobs` row as `kind='resume'`, after `assertRunVisible` |
| `get_agent_run` | reads state, path and held approvals |
| `get_run_trace` / `list_runs` | read Langfuse observations filtered by `traceId=<runId>`, or by the caller's user id and a time window — `observationsQuery` throws on anything looser, and that rule has a test. `os-ui/ARCHITECTURE.md:393-399` |
| `decide_approval` | writes the approval decision; the `onDecided` hook files a `resume` job as the *runner* |

### B.7 Software — commits `apps/<slug>/`

| Tool | What it writes |
|---|---|
| `push_app_files` | compile gate, then `commitSubtree('apps/<slug>')` as a changeset merged over the current tree; also updates the `os-app-files` cache — `os-ui/tabs/software/lib/push-app-files.ts:180` |
| `commit` | the Developer-mode verb that writes app source bypassing the staged governance (Builder/Admin) — `os-ui/tabs/software/lib/platform-mcp.ts:174` |
| `read_app_files` | reads the committed subtree, else the mirror, else the template — each answer labelled — `os-ui/tabs/admin/mcp/discovery-waveb-tools.ts:231` |
| `request_deploy` / `decide_deploy` / `start_preview` | no git; write `os-apps` and `os-software-reviews`, and provision real Kubernetes objects in the `image` path — `os-ui/tabs/software/lib/review.ts:265`, `:316`, `:493` |
| `verify_software` / `get_software_status` | no git; the first writes nothing at all — `platform-mcp.ts:291`; `discovery-waveb-tools.ts:294` |

### B.8 Knowledge, Files, Connections — no git today

| Tool | What it writes |
|---|---|
| `author_knowledge` | `os-knowledge-records`. No OpenSearch index write, no git. `os-ui/tabs/knowledge/mcp/knowledge-write-tools.ts:119` |
| `index_knowledge` | `_delete_by_query` + `_bulk?refresh=true` on the `knowledge` index — `:267` |
| `publish_knowledge` | promotes through the governance seam, then indexes *best-effort* — `:235`, `:260-262` |
| `search_knowledge` | `knowledge/_search` with the DLS filter pushed down and re-checked per hit; `k` capped at 20 — `os-ui/tabs/knowledge/mcp/knowledge-search-tools.ts:13` |
| `get_knowledge` | the in-process store only — `os-ui/tabs/admin/mcp/discovery-read-tools.ts:274` |
| `upload_file` | `os-file-records` + MinIO `putBlob` + Docling-or-mock + a `_bulk` into the `files` index — `os-ui/tabs/files/mcp/file-write-tools.ts:115` |
| `list_files` / `search_files` / `get_file` | in-process reads; `search_files` does *not* use the `files` index — `discovery-read-tools.ts:287`, `:296`; `discovery-waveb-tools.ts:186` |
| `create_connection` … `retire_connection` | `os-connections` + the secrets vault by reference; `retire` with `delete` also removes the live Trino catalogue and its `trino-ext-<catalog>` Secret — see section 10 |

The hold table a governed agent reads is `WRITE_TOOL_TABS` in
`os-ui/core/mcp/write-tool-meta.ts:20-89`, plus `PLATFORM_WRITE_TOOLS`. Thirteen platform writes are
missing from it and are therefore never held by any preset — see section 7's callout.

---

## Appendix C — Helm flags and their defaults

All keys from `charts/sovereign-agentic-os/values.yaml` (1478 lines). "Default" is the chart's own value.
Keys marked **NOT FOUND** were looked for and do not exist — which is itself a fact worth recording,
because several capabilities people assume are chart-gated are not.

> **Not yet true:** this appendix and Appendix D are the two tables on this page that **no test pins**.
> They will drift. If you change a chart default, change the row here by hand.

### C.1 The flags that gate the capabilities above

| Capability | Key | Default | Switches on |
|---|---|---|---|
| domain git repos | `osUI.dataProjectGit.enabled` | **true** `:1387` | the `os-repos` PVC, the read-only `git daemon` sidecar, Service `os-repos:9418` and the Dagster-only NetworkPolicy; env `DATA_PROJECT_GIT` / `OS_REPOS_DIR` |
| git-http sidecar | `osUI.dataProjectGit.gitHttp.enabled` | **true** `:1404` | the port-9419 sidecar, Service `os-git-http` and the authenticating Ingress. Image `ghcr.io/aborek/sovereign-os/git-http` `:1406-1407` |
| agent-run worker | `osUI.worker.enabled` | **false** `:1313` | the second `os-ui-worker` Deployment; flips `AGENTS_WORKER`. Runs are *inline* by default. |
| builder harness | `softwareBuilder.mode` | **`"spec"`** `:1476` | env `SOFTWARE_BUILDER`; only exactly `"agentic"` enables the loop. `softwareBuilder.coderModel: ""` `:1477` |
| app runner (`image` serve mode) | `softwareRunner.enabled` | **false** `:994` | `apps-runner.yaml`. `softwareRunner.runnerImage: ""` `:1003` — empty, so `appImageRef` fails closed |
| dbt | `dbt.enabled` | true `:910` | the *demo* dbt build Job (a `post-install` hook), not the generated projects |
| Dagster | `dagster.enabled` | true `:745` | subchart v1.13.11 — webserver + daemon |
| the `sovereign` code location | `dagster.dagster-user-deployments.enabled` | true `:775` | the code-server Deployment and its `repo-sync` sidecar |
| Dagster bundled Postgres | `dagster.postgresql.enabled` | **false** `:752` | uses the OS's own `pg-rw` instead |
| Trino | `trino.enabled` | true `:1149` | `extensions/lakehouse/trino.yaml`; co-gates the os-ui rules-reconcile RBAC |
| Trino OPA plugin | `trino.opa.enabled` | true `:1193` | the first of the two chained access controls |
| Trino file ACL | `trino.accessControl.enabled` | true `:1221` | the `rules.json` ConfigMap, chained *after* OPA |
| Trino resource groups | `trino.resourceGroups.enabled` | true `:1197` | selectors keyed on a client tag nothing sets |
| Trino client auth | *`trinoAuthMethod` / `TRINO_AUTH_METHOD`* | **NOT FOUND** | no chart value exists, so `config.trinoAuthMethod` stays `'none'` — `os-ui/core/kernel/config.ts:513` |
| Langfuse | `langfuse.enabled` | true `:233` | subchart v1.5.36 — web + worker. Its four backends are `deploy: false` each `:290`, `:303`, `:313`, `:326`; telemetry off `:246` |
| LiteLLM | `litellm.enabled` | true `:411` | litellm-helm v1.90.0 proxy Deployment |
| the scoped agent key | `litellmAgentKey.enabled` | true `:385` | the Secret plus the key-init Job. Without it the run path refuses rather than using the master key. |
| OpenSearch | `opensearch.enabled` | true `:552` | subchart v3.7.0. `securityConfig.enabled: false` `:566` ⇒ plain HTTP; `persistence.enabled: false` `:568` ⇒ ephemeral |
| Presidio | *any `presidio.*` key* | **NOT FOUND** | zero occurrences in `values.yaml` and zero in `templates/**` |
| Docling | `docling.enabled` | true `:733-734` | `extensions/docling/docling.yaml`, image `quay.io/docling-project/docling-serve-cpu` at `tag: "latest"` `:736-737`. But `osUI.doclingUrl: ""` `:1351`, and empty means the mock ingest path. |
| object storage (MinIO) | `objectStorage.enabled` | true `:60` | `base/object-storage/seaweedfs.yaml` (a MinIO image, despite the filename) plus the bucket-init Job. **No `minio.*` key exists.** `persistence.enabled: false` `:90`; `mode: bundled` `:62` |
| Polaris | `polaris.enabled` | true `:1043` | the Polaris Deployment and its bootstrap Job; `persistenceType: in-memory` `:1060` |
| ClickHouse | `clickhouse.enabled` | true `:205` | `base/clickhouse/clickhouse.yaml`; `persistence.enabled: false` `:220` |
| OPA | `opa.enabled` | true `:639` | `base/opa/opa.yaml` plus the principal re-assert hook |
| egress proxy | `egressProxy.enabled` | true `:958` | tinyproxy, with a 17-entry allowlist `:964-977` |
| web fetch | `webFetch.enabled` | true `:984` | `base/egress/web-fetch.yaml` |
| mock model | `mockModel.enabled` | true `:339` | `base/mock-model/mock-model.yaml` — also what `sovereign-embed` resolves to on a kind install |
| query-tool | `queryTool.enabled` | true `:1084` | the service every governed Trino read goes through; image tag `"0.6.2"` `:1087` |
| data-runner | `dataRunner.enabled` | true `:1113` | the PyIceberg Bronze writer |
| metrics | *`metrics.enabled`* | **NOT FOUND** | only `metrics.alerts.cron.enabled` exists, default **false** `:1244` |
| dashboards | *`dashboards.enabled`* | **NOT FOUND** | dashboards are an os-ui tab, gated only by `osUI.enabledTabs` |
| software / serve mode | *`software.enabled`, a serve-mode flag* | **NOT FOUND** | `serveMode` is an *app-level field*, not a Helm value; `spec` and `runtime` never reach the runner at all |
| which tabs exist | `osUI.enabledTabs` | `""` `:1336` | `OS_ENABLED_TABS`. **Empty is the base tier**, which hides Data, Files, Knowledge, Metrics, Dashboards, Software, Connections and Workflows. |

### C.2 The rest of the toggles

| Key | Default | Component |
|---|---|---|
| `priorityClasses.enabled` | true `:4` | two PriorityClasses |
| `networkPolicies.defaultDeny` | true `:29` | `base/network/egress-policies.yaml` |
| `backup.pgDump.enabled` | **false** `:34` | the pg-dump CronJob |
| `ingress.enabled` | **false** `:45` | every tool Ingress *and* the git-http Ingress — so with it off there is no authentication in front of the git sidecar |
| `postgres.enabled` / `postgres.engine` | true / `plain` `:99`, `:101` | the plain StatefulSet, or the CNPG cluster |
| `postgres.cnpg.highAvailability.enabled` | false `:161` | CNPG replicas |
| `postgres.cnpg.backup.enabled` | false `:169` | Barman + ObjectStore + ScheduledBackup |
| `valkey.enabled` | true `:191` | `base/valkey/valkey.yaml` |
| `stackitPremium.enabled` | false `:350` | **not a render gate** — no `if` anywhere; its siblings always land in the LiteLLM Secret |
| `stackitPremium.externalSecrets.enabled` | false `:362` | **referenced by no template** |
| `litellm.migrationJob.enabled` | true `:429` | the subchart migration Job |
| `opensearch.sysctlInit.enabled` | true `:570` | a privileged init container setting `vm.max_map_count` |
| `opensearchSnapshots.enabled` | **false** `:584` | the snapshot PVC and repo-register Job. Its child `cronJob.enabled: true` `:601` is therefore *inert*. |
| `dagsterAnalytics.warehousePrincipal.enabled` | false `:927` | adds the principal to the OPA governance ConfigMap |
| `marts.enabled` | true `:935` | the demo gold-mart seed Job |
| `softwareRunner.networkPolicy.enabled` | true `:1009` | *inert* — the parent is false |
| `connections.enabled` | true `:1015` | only co-gates the connections ExternalSecrets; **no workload of its own** |
| `connections.catalogRefresh.enabled` | **false** `:1018` | the catalog-refresh CronJob (not co-gated on `connections.enabled`) |
| `connections.externalSecrets.enabled` | **false** `:1024` | two ExternalSecret CRs |
| `serviceBearer.enabled` | **false** `:1141` | injects the shared bearer into query-tool, data-runner and os-ui |
| `osUI.enabled` | true `:1272` | the os-ui Deployment and session secret; co-gates worker, graph, smtp and git-http |
| `osUI.externalConnectorsEnabled` | **false** `:1276` | extra RBAC; env `EXTERNAL_CONNECTORS_ENABLED`; also what hides the `warehouse` connection template |
| `osUI.waitForOpenSearch` | true `:1281` | the boot init container |
| `osUI.allowOfflineUserSeed` | **false** `:1284` | dev only; production fails closed with a 503 |
| `osUI.graph.enabled` / `osUI.smtp.enabled` | false / false `:1428`, `:1436` | the two mailer Secrets |
| `trino.externalCatalogs` | `[]` `:1180` | federated catalogues — none |
| `agentRuntime.schedules` | `[]` `:632` | per-schedule CronJobs |

Components recorded as *removed* in `values.yaml` itself:
`agentRuntime.enabled`/`image`/`replicas`/`resources` `:617`, the Admin Console `:1268`, the
personal-query sandbox engine `:1144`, and `data.quality.cron`/`dataSync.sweep` `:1254-1261`.

### C.3 Deployed by default, and not

**Deployed out of the box:** MinIO, Postgres (plain), Valkey, ClickHouse, Langfuse, LiteLLM plus the
agent key, OpenSearch, OPA, Docling, Dagster with its user deployments, the demo dbt Job, Trino
(OPA-governed, resource groups, file ACL), Polaris, query-tool, data-runner, mock-model, egress proxy,
web-fetch, the demo marts, and os-ui *with both the git-daemon and git-http sidecars on*.

**Off out of the box:** ingress and TLS; *all* persistence (MinIO, ClickHouse and OpenSearch are
ephemeral); *all* backups (pg-dump, CNPG Barman, OpenSearch snapshots); the software runner; the os-ui
worker; the metrics alert cron; catalog refresh; external secrets; the service bearer; both mailers;
STACKIT premium models; external connectors. The builder harness is present in `spec` mode.

### C.4 Root-overlay differences

`values.local.yaml` changes **no feature flag except two** — everything else is resources, JVM sizing and
storage class:

| Key | Chart default | Local override |
|---|---|---|
| `global.storageClass` | `""` | `"standard"` — `values.local.yaml:15` |
| `osUI.allowOfflineUserSeed` | false | **true** — `values.local.yaml:98` |
| `osUI.enabledTabs` | `""` | all 13 tabs, listed explicitly — `values.local.yaml:102` |

`values.stackit-managed.yaml` (Mode B) changes rather more, and some of it matters for everything above:

| Key | Chart default | Mode B |
|---|---|---|
| `global.profile` | `local` | `stackit` `:18` |
| `objectStorage.enabled` | true | **false** — external STACKIT object storage `:31` |
| `postgres.enabled` | true | **false** — external PG Flex `:38` |
| `opensearch.enabled` | true | **false** — external OpenSearch `:46` |
| `mockModel.enabled` | true | false `:60` |
| `stackitPremium.enabled` / `…externalSecrets.enabled` | false / false | true / true `:69`, `:71` |
| `dagster.enabled` | true | **false** — "the `sovereign-os/dagster:0.2.0` image build failed in the current push run" `:302` |
| `dagster…image.tag` | `"0.3.1"` | `"0.2.0@sha256:REPLACE-DAGSTER-DIGEST"` — an unresolved placeholder `:310`, `:314` |
| `ingress.enabled` | false | **true**, 7 hosts `:355`, `:359-370` |
| `queryTool.image.tag` | `"0.6.2"` | `"0.3.0@sha256:310342ad…"` — an *older* query-tool, losing the promote-as-view allowlist `:276` |
| LiteLLM `model_list` | 4 aliases | 7 — adds `sovereign-vision`, `sovereign-premium`, `sovereign-reasoning-fast` `:89-128` |
| LiteLLM `litellm_settings` | `success_callback` + `failure_callback` + Valkey cache | **only** `success_callback` + `drop_params` — the response cache *and* the failure callback are dropped `:139-141` |
| LiteLLM `general_settings` | includes `store_model_in_db: true` | `master_key` only — `store_model_in_db` dropped `:143` |
| `egressProxy.allowlist` | 17 entries | 29 — adds GitHub, Supabase, Atlassian, Slack, Gmail, Purview, AzureML, AWS, GCP and Snowflake hosts, but **drops `api.kajabi.com`** `:234-266` |
| `trino.catalog.iceberg.vendedCredentials` | false | true, with `oauth2SecretName: polaris-trino-oauth` `:385-386` |

Neither overlay touches `softwareRunner.enabled`, `osUI.worker.enabled`,
`metrics.alerts.cron.enabled`, `serviceBearer.enabled`, `backup.pgDump.enabled`,
`opensearchSnapshots.enabled`, `connections.{externalSecrets,catalogRefresh}.enabled`,
`osUI.{graph,smtp}.enabled`, `osUI.externalConnectorsEnabled`,
`osUI.dataProjectGit.gitHttp.enabled` or `softwareBuilder.mode` — so the chart defaults above stand in
the managed deployment too.

> **Not yet true:**
> - **The git-http sidecar is on by default and its image was first built on 2026-11-14.**
>   `osUI.dataProjectGit.gitHttp.enabled: true` with image `ghcr.io/aborek/sovereign-os/git-http:1.0.0`,
>   and the acceptance report records that `git-http:1.0.0` is "not built/pushed … E must stay undeployed
>   until the image exists". The image has since been built and pushed on 2026-11-14 (digest `sha256:598ac199…`) after the Dockerfile's own build guard caught that Alpine ships `git-http-backend` in the `git-daemon` package (PR #49). The lesson stands: a default-on sidecar pointing at an unbuilt image is the one direct
>   contradiction between the chart and the report. `values.yaml:1404`, `:1406-1407`; gap-report §3 item 10
> - **`OS_PROFILE` is set nowhere.** Not in `charts/`, not in either root overlay, not in `deploy/` or
>   `scripts/` — so `config.deploymentProfile` stays `'local'` on a real deployment. Section 4's
>   synthetic-metric gate depends on it. (Mode B sets `global.profile: stackit`, which is a different key
>   and does not reach that env var.)
> - **Several orphan overrides remain in `values.stackit-managed.yaml`** — keys the chart no longer has,
>   so they are dead values: `llm.mode`/`provider`/`secretRef`, `openmetadata.*`, `osUI.supersetUrl`,
>   `osUI.openmetadataUrl`, `sampleAgent.*`, `haystack.*`, `superset.*`, `mlflow.*`, `mlAgent.*`,
>   `terminal.*`, `workbench.*`, plus a new-but-unbacked `ingress.dagsterBasicAuthSecret`.
> - **A Secret the Dagster subchart reads is created by nothing here** — `dagster-postgresql`, key
>   `postgresql-password`. `dagster.postgresPasswordLocal` is not an upstream key.
> - **Two chart comments are stale:** `templates/base/os-ui/_os-ui-env.tpl:323` says `dataProjectGit`
>   "defaults false" (it is `true`), and `templates/extensions/dbt/dbt-build.yaml:18` claims
>   `post-install,post-upgrade` where the template is `post-install` only.

---

## Appendix D — glossary: OS term to tool term

The OS's own vocabulary rule is data rather than prose: `os-ui/core/engineering/vocabulary.ts` lists each
tool's nouns and, separately, the OS's own, and a label that uses only an OS-invented noun fails
`vocabularyViolations` — which both the panel copy test and every adapter test run. The bridge form,
"dbt metric (KPI)", is allowed once. `:20-28`, `:43-45`, `:50-60`

| OS term | Tool term | Where to find the object |
|---|---|---|
| data product | **dbt project** | the root of the domain repo: `dbt_project.yml` + `models/` |
| dataset (Silver / Gold) | **dbt model** | `models/<layer>/<layer>_<slug>.sql`; Dagster asset key `[<domain>, <model>]`; Trino `iceberg.<schema>.<layer>_<slug>` |
| dataset (Bronze) | **dbt source** | `models/sources.yml`; written by the data-runner with PyIceberg, never by dbt |
| an authored version body | **dbt source** | deliberately *not* a model: no user-authored text reaches Jinja at `dbt parse` |
| quality rule | **dbt test** | `models/**/schema.yml` under `columns[].data_tests`; result as a **Dagster asset check** (one test = one check) |
| KPI / metric definition | **dbt metric** + **dbt semantic model** | `models/semantic/<model>.yml`; identity in `config.meta.os_metric` / `os_member` |
| metric number | **Trino query** | the OS compiler's SQL, run as the viewer — *not* MetricFlow, which is never on the request path |
| schedule | **Dagster schedule** | `os/schedules.yml` → `<domain>__<dataset>`, UTC |
| pipeline run | **Dagster run** | job `<domain>__all` with an explicit asset subset; tags `os/dataset`, `os/principal`, `os/commit`, … |
| quarantine | **Dagster sensor** | `os_quarantine`, a `@run_failure_sensor` pausing a schedule after 10 consecutive failures |
| lineage | **dbt graph** | Dagster's `assetNodes`, derived by dagster-dbt from `manifest.json`'s `parent_map` |
| personal lane | **Trino schema** + a repo directory | `iceberg.personal_<uid>.*` and `models/personal/<uid>/` |
| domain | **git repository** + **Trino schema** | `<OS_REPOS_DIR>/<domain>.git` and `iceberg.<sanitised domain>` |
| audience (My / Domain / Company) | *a directory position* | inside or outside `…/personal/<uid>/`; moved by a promotion commit, never by a push |
| lifecycle (Draft / Testing / Live) | *a committed pin file* | `os/lifecycle/pins.yml`; becomes `env:studio\|test\|run` on LiteLLM and the Langfuse trace `environment` |
| dashboard | **ECharts** option over a YAML spec | `dashboards/<slug>/dashboard.yaml`; series built by the vendored Superset transformers. *Not* a Superset artefact. |
| panel | **ECharts series** | `spec.panels[]`, referencing metrics by governed member name |
| AI team / agent system | **LangGraph graph** (a `CompiledStateGraph`) | `agents/<slug>/system.yaml` and the compiled IR in `graph.json` |
| agent | four **LangGraph nodes** | `plan_<id>`, `act_<id>`, `tools_<id>`, `route_<id>` |
| team state | **LangGraph channels** | `state.channels` in the YAML, typed into an `Annotation.Root` |
| run | **LangGraph thread** = **Langfuse trace** | thread id = run id = trace id; the trace's `name` is the system's name, `sessionId` the system id |
| approval / held write | **LangGraph `interrupt()`** | keyed `<threadId>:<callId>`; the approvals queue is the source of truth across re-runs |
| resume | **LangGraph `Command({resume})`** | filed as a `run_jobs` row with `kind='resume'`, executed as the *runner* |
| run checkpoint | **LangGraph checkpointer** | `PostgresSaver` on `AGENT_RUNS_DATABASE_URL`, tables created by its own `setup()`; `MemorySaver` when unset, and the report says which |
| run step / tool call | **Langfuse observation** | a span per node, a *generation* per completion (`llm.act_<id>`), a span per governed tool carrying the hold decision |
| run outcome | **Langfuse span** `run.result` | a terminal span, not a trace update — a trace update would be a second trace event |
| spend / cost lens | **LiteLLM tag** | `domain:`, `agent:`, `tab:`, `run:`, `env:`, with `end_user = os-<id>` |
| an agent's own budget | **LiteLLM key alias** + budget | a per-system virtual key minted at Build, held by secret *reference*; the master key is confined to four files |
| app | **git subtree** | `apps/<slug>/`; the `os-app-files` OpenSearch index is a *cache* of it |
| app action | *a declaration in `actions.yml`* | callable only through capability ∩ declaration ∩ adoption ∩ grant |
| knowledge unit | **OpenSearch document** | index `knowledge`, with a `knn_vector` `embedding` field |
| file representation | **OpenSearch document** | index `files`; bytes in MinIO under `s3://files/…` |
| row-level security | **Trino OPA** row filters and column masks | plus a generated `rules.json` chained after it, which can only narrow |
| document-level security | *an OpenSearch filter clause* | `dlsFilter(principal)` / `compileDls(reader)`, pushed into the query *and* re-checked in code |
| who a query runs as | **Trino user** (impersonated) | `readPrincipalFor(sql, user)`, or `env_var('OS_PRINCIPAL')` in a dbt run pod |
| catalogue | **Iceberg REST catalogue** (Apache Polaris) | `iceberg.catalog.type=rest` at `http://polaris:8181/api/catalog`, warehouse `s3://lakehouse/wh` |
| version / history / diff | **git commit** | `git log -- <paths>`, or the `OS-Object` trailer, which is the identity |
| "what the OS did, and why" | **git trailers** | `OS-Action`, `OS-Object`, `OS-Surface`, `OS-Request-Id`, `OS-Run-Id`, `OS-Actor`, `OS-Reason`, `OS-Author-Email` |
| the engineer's door | **`git-http-backend`** | git's own CGI behind lighttpd, authenticated by an OS `auth-url` sub-request |

---

## See also

- [`docs/components/git.md`](components/git.md) — the authoritative repo-layout table and the engineer's door
- [`docs/components/dbt.md`](components/dbt.md), [`docs/components/dagster.md`](components/dagster.md),
  [`docs/components/trino.md`](components/trino.md), [`docs/components/polaris.md`](components/polaris.md),
  [`docs/components/minio.md`](components/minio.md) — per-component detail (see the drift notes in section 3)
- [`docs/components/langfuse.md`](components/langfuse.md), [`docs/components/litellm.md`](components/litellm.md),
  [`docs/components/opensearch.md`](components/opensearch.md), [`docs/components/docling.md`](components/docling.md)
- [`docs/components/lifecycle.md`](components/lifecycle.md), [`docs/components/os-ui.md`](components/os-ui.md)
- `os-ui/ARCHITECTURE.md` — the kernel-and-tabs contract, and "Things this codebase will punish you for"
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — the structure rules, the ratchet, and the `os-ui/vendor/` carve-out
