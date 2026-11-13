# Data · Context

Datasets, SQL, the lakehouse and the catalog. Ingestion, federation of external warehouses, and scheduled syncs.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/data`

**APIs**

- `/api/data`
- `/api/tables`
- `/api/query`
- `/api/catalog`

**MCP tools**

- `data-query`
- `data-write`

**Needs deployed**

- `postgres`
- `opensearch`
- `minio`
- `trino`
- `polaris`
- `dbt`
- `dagster`
- `data-runner`
- `query-tool`

## Layout

- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## A data product is a dbt project in a git repository (engine rebuild B1–B4)

**This is the shipped architecture.** `DATA_PROJECT_GIT` is **on by default** since B4
(`osUI.dataProjectGit.enabled: true`), and the whole path is:

```
a change in the Data tab  ─┐
a call to the data MCP    ─┴─▶ tabs/data/lib/mutations-server.ts   (ONE service per mutation)
                                 │
                                 ├─▶ the governed store write  ──▶ ProjectChange event
                                 │                                   │
                                 │        core/infra/git-store ◀──  lib/dbt/commit.ts
                                 │        git commit as the acting user in /repos/<domain>.git
                                 │        (the generated dbt project: models, schema.yml tests,
                                 │         os/schedules.yml, os/sources.yml)
                                 │                                   │
                                 │                      repo-sync sidecar: dbt parse per commit,
                                 │                      reload the `sovereign` code location
                                 │                                   │
                                 └─▶ lib/dbt/launch.ts ──▶ Dagster run of THAT commit's assets
                                                              │
                                                              ▼
                                                      dbt-trino → Trino, impersonating
                                                      the acting principal (OPA governs)
                                                              │
   the Data tab, Monitoring and the MCP read run state, asset checks, freshness and lineage
   BACK from Dagster — the OS keeps no parallel ledger.
```

Both doors are the same door: a route adds HTTP shaping, an MCP tool adds argument coercion, and
`tabs/data/lib/mcp-parity.test.ts` proves per tool that the commit (files, author, `OS-Actor`) and
the Dagster launch are identical — the `via mcp:<tool>` / `via ui:<route>` half of the commit
subject is the one deliberate difference.

### The commit, in detail (B1)

With `DATA_PROJECT_GIT=true` (chart: `osUI.dataProjectGit.enabled`), every mutation of a dataset,
composition, quality rule, sync, publish or retire — through a route or an MCP tool — regenerates
the owning domain's **dbt project** and commits it to a bare repository the OS owns
(`$OS_REPOS_DIR/<domain>.git`, PVC `os-repos`), authored as the acting user, committed by
`Sovereign OS`, message `data(<domain>): <action> <object> — via ui:<route> | mcp:<tool>` with
trailers `OS-Action`, `OS-Object`, `OS-Surface`, `OS-Request-Id` (and `OS-Author-Email: synthesized`
when the user has no e-mail). A regeneration that changes nothing commits nothing.

**How it is wired.** `lib/store.ts` emits a `ProjectChange` from its one `persist()` and from the
writers that bypass it (`lib/project-events.ts`, pure — the store is reachable from the client bundle
and may not import git). `lib/dbt/commit.ts` subscribes at boot (`instrumentation.ts`), reads the
ambient request surface (`core/infra/request-surface`, set by `withRoute` for routes and by the data
MCP tools for `mcp:<tool>`), snapshots the domain (`lib/dbt/snapshot.ts`), generates
(`lib/dbt/generate.ts`, pure, byte-stable) and commits through `core/infra/git-store.ts`.
`lib/dbt/commit.test.ts` enumerates the store's exports: a new mutator fails until classified.

**Read access** (domain members only): `GET /api/data/projects/<domain>` → `{head, tree, log}`;
`GET …/blob?ref=&path=`; `GET …/export?ref=` (tar). Admin:
`PUT /api/platform-admin/data-projects/<domain>/mirror` `{url, tokenSecretRef:{name,key}}` — the
token is a Secret reference, pushed after every changed commit, failures reported never blocking.

**Generated layout** (`lib/dbt/fixtures/*.golden.json` are the three canonical shapes):

```
dbt_project.yml  profiles.yml (env_var() only; impersonation_user = OS_PRINCIPAL)  README.md  .gitignore
macros/generate_schema_name.sql          # +schema is the exact Iceberg schema
tests/generic/range.sql, not_blank.sql   # the OS rules dbt has no built-in for (predicates from dq.ts)
models/sources.yml                       # Bronze landings + federated tables (freshness on _loaded_at)
models/silver/, models/gold/             # promoted layers (domain schema)      + schema.yml
models/personal/<uid>/                   # un-promoted layers (+schema: personal_<uid>) + schema.yml
os/schedules.yml                         # {dataset, select "<model>+", cron, UTC, principal}
os/external.yml                          # Kafka-offset / API-batch syncs (Dagster assets, not models)
```

**Who can read what.** The repository is the **whole domain's** project, and
`GET /api/data/projects/<domain>` is gated on domain membership — so **every member of a domain can
read every member's dataset *definitions***: model SQL, column descriptions, quality rules, sync
schedules and the commit history naming who changed what. That is deliberate (it is how an
engineering team works, and the Data tab already lists domain datasets), but it is **wider than the
dataset list**: a dataset whose rows are invisible to you still has a readable *definition* here,
including an un-promoted personal-lane model under `models/personal/<uid>/`. The **data** stays
governed — a model only reads what Trino→OPA lets the impersonated principal read — and no
credential is ever in the tree (`profiles.yml` uses `env_var()` only). If a domain needs
definition-level privacy, that is a per-path read gate on the project routes, not a property of the
current design.

### B2 — Dagster schedules the repo, and the OS reads Dagster

With the flag on, the OS stops being its own run ledger (checklist D7–D11):

- **Launch after commit.** Build, `transform_silver`, `build_gold_join` and `sync_dataset_now`
  commit, then `lib/dbt/launch.ts` waits for the location to expose the dataset's assets and calls
  `launchRun` (`core/infra/dagster.ts`) for exactly that subset — tags `os/dataset`, `os/domain`,
  `os/principal`, `os/user`, `os/action`, `os/layer`, `os/commit`, `os/surface`, and run-pod env
  `OS_PRINCIPAL` + `OS_PINNED_COMMITS`. The version record keeps `{commit, dagsterRunId}`, or
  `launchError` saying honestly why no run exists.
- **Schedules, not CronJobs.** `set_dataset_sync` provisions **no** `batch/v1` CronJob and removes a
  pre-B2 one (`reconcileSyncSchedule`); the schedule is the `os/schedules.yml` entry this same write
  committed. B4 **deleted** `/api/data/sync-due` and `/api/data/dq/run-all` (and the CronJob
  provisioning itself) so nothing can fire twice.
- **Read-back.** `lib/sync-status-server.ts` (`syncStatusFor`, `latestSyncSignals`) reads
  `runsForDataset` + `nextTick`; `lib/dq-status-server.ts` (`latestDqRun`, `dqTrend`,
  `latestDqRuns`) reads `assetChecks` — one dbt test = one asset check, with
  `dagster_dbt/failed_row_count` as the violation count. `quarantined` means the schedule is STOPPED
  in Dagster while the OS config says enabled. A Dagster outage is reported in `dagster.error` with
  no rows; it is never a fabricated run or a fake green.
- **Launch provenance.** `buildVersion({compiled: true})` marks a body the OS's own compilers
  produced. Only those become dbt models; an authored body (`add_dataset_version`, the version
  route) is recorded and rendered as a dbt **source** — dbt reads that table and never rewrites it.
- **Authored text is inert, not absent.** dbt renders every generated `.yml` **and** `.sql` through
  Jinja before reading it — a `--` comment is no shelter — so a dataset name, a description or a
  column name reading `{{ env_var('…') }}` would be evaluated by `dbt parse`, in a pod that holds
  the OS's cluster-internal runtime bearer. Every authored string the generator emits therefore
  passes through `lib/dbt/emit.ts` `stripJinja`, which removes the delimiters and keeps the words.
  The MODEL bodies are a separate, stronger rule (provenance, above): authored SQL never becomes a
  model at all.
- **A quality rule's value set is checked at the gate.** dbt emits each `accepted_values` entry as
  `'{{ value }}'` — a SQL literal with no escaping — into a test executed as the dataset's owner, so
  `store.addCheck` refuses a value carrying a quote, backslash, backtick, control character or Jinja
  delimiter (`isSafeCheckValue`, `dataset-schema.ts`), and `lib/dbt/schema.ts` records such a check
  as a `meta.os_intentions` entry rather than a test. One bad value disqualifies the whole check:
  emitting the surviving values would enforce a narrower rule than the author wrote.
- **"dbt test" vs "OS probe".** `DqRunRecord.source` is rendered next to the last-run time in the
  Validate stage and in Monitoring (`dqSourceLabel`, `lib/dq.ts`): a verdict Dagster produced on the
  last build is not the same thing as the OS's own ad-hoc check run, and a record from before the
  distinction says nothing rather than guessing.

### B3 — Trino executes as the principal, lineage comes from dbt

With the flag on (checklist D7, D14, D15, D16):

- **Trino's rules file is generated.** Trino chains a **file-based** system access control after the
  OPA plugin (`access-control.config-files`); its `rules.json` lets the dbt service user act as an
  OS principal and as **nothing else**, and makes a domain's Iceberg schema writable only by that
  domain's principals (`core/infra/trino-rules.ts`, pure + golden-tested;
  `trino-rules-server.ts` reconciles the ConfigMap from the user directory at boot). Read
  `docs/components/trino.md` for the who-runs-as-whom table and for the honest limit: **Trino does
  not authenticate clients today**, so the impersonation rules have no authenticated `original_user`
  to match and the network boundary is still what makes a claimed session user trustworthy.
- **External sources are assets.** `lib/dbt/source-assets.ts` writes `os/sources.yml` — one entry
  per federated sync source — and the code location turns each into an observable source asset keyed
  `[<domain>, <source>, <table>]`, the same key dagster-dbt gives the dbt source, so the silver model
  depends on it and the lineage graph has no dangling upstream. Freshness is two schedule intervals,
  derived from the sync's own cron (`cronIntervalMinutes`); an unfamiliar cron shape makes **no
  claim** instead of a wrong one.
- **Lineage is dbt's.** `lib/lineage-server.ts` `datasetLineage` folds Dagster's asset graph (which
  dagster-dbt derives from `manifest.json`'s `parent_map`) into the same `LineageGraph` shape through
  `lib/dbt/lineage.ts`, and falls back to `lib/lineage.ts` — **labelled** `source: 'registry'` —
  when the flag is off, Dagster is unreachable, or the dataset has no model in the graph yet.
  Column-level lineage is not derived; dbt Core's manifest does not carry it.
- **Parity is a test, not a hope.** `lib/dbt/parity.ts` + `parity.test.ts` compare the CTAS the OS
  runs today with the SQL dbt will run, per fixture, including the concept's worked example
  `gold_order_customer`: same projection and aliases in order, same FROM/JOIN sequence and ON
  predicates, same WHERE conjuncts, same GROUP BY. A model with no recorded CTAS is reported
  **skipped with a reason**, never as a pass. What it cannot prove — that the two produce the same
  ROWS — needs a cluster and stays checklist D15's `kind` half.

#### B3 review round — what changed after the review

- **The reconciler now actually runs**, and runs more than once: boot, every user/domain write (the
  kernel `directory-changed` event — the stores emit, `instrumentation.ts` subscribes, nothing in a
  write path imports a reconciler), and a jittered periodic repair pass, because `helm upgrade`
  rewrites the chart's permissive bootstrap over the OS's file. Its last outcome is a row on
  Platform → Components & Health, red on failure or staleness.
- **Lineage is all-or-nothing.** `graphLineage` returns null unless every model of the dataset is in
  the asset graph, so a half-parsed project falls back to the registry graph instead of showing a
  truncated one labelled `dbt`. The `source` label now reaches MCP `get_lineage` too.
- **The parity harness no longer checks the plan against itself.** `ref()` resolves to the FQN the
  OS actually WROTE (the recorded CTAS's own target), and a model read through `source()` instead of
  `ref()` is a mismatch — that is the signature of a lane mapping that disagrees with the CTAS, and
  it used to round-trip and pass.
- **`profiles.yml` can carry a password** (`env_var()` only, inside a Jinja guard so the key is
  absent under `method: none`). `docs/components/trino.md` has the numbered procedure for turning
  real impersonation on, and states plainly that a governed READ runs as the caller's FIRST DOMAIN,
  not as the person — pre-existing, and a follow-up.

### B4 — the MCP is the UI, the repository catches up at boot, and the old paths are gone

- **One service per mutation** (`lib/mutations-server.ts`): `createDatasetService`,
  `commitVersionService`, `transformSilverService`, `buildGoldJoinService`,
  `defineQualityRulesService`, `runQualityChecksService`, `saveDatasetSyncService`,
  `syncDatasetNowService` (+ `rematerializeDomainTableService` for the repair mode). Each is the
  whole mutation: validation that names the offending field, the governed store write, the physical
  build, the commit and the Dagster launch. Failures are thrown status-tagged, so `withRoute` renders
  `{error}` + status and `handleRpc` the typed `{code, reason, hint}` — from the same throw.
  Tests: `lib/mcp-parity.test.ts` (checklist X8, in `gate.sh`), `lib/mcp-conformance.test.ts`
  (checklist X7's data half: every data tool `list_capabilities` advertises dispatches, has a usable
  schema, refuses a foreign dataset as `not_found`/`forbidden` with a hint and no stack, names the
  role a gate needs, and writes nothing when it refuses).
- **The data MCP tools** — 23 under `tab: 'data'` plus `get_lineage`, which is registered under
  `governance` with `extraTabs: ['data', …]`. Where they live:

  | File | Tools |
  |---|---|
  | `core/mcp/experimental/data-write-tools.ts` | `create_dataset` · `add_dataset_version` · `document_dataset` · `ingest_dataset` · `transform_silver` · `build_gold_join` · `define_quality_rules` · `run_quality_checks` · `propose_quality_fixes` · `apply_quality_fixes` · `set_dataset_sync` · `sync_dataset_now` · `retire_dataset` · `reconcile_domain_tables` |
  | `core/mcp/experimental/promotion-write-tools.ts` | `request_promotion` · `approve_promotion` |
  | `core/mcp/experimental/exposure-write-tools.ts` | `list_exposed_tables` · `adopt_exposed_table` |
  | `tabs/admin/mcp/discovery-read-tools.ts` | `list_datasets` · `get_dataset` · `profile_dataset` · `get_sync_status` |
  | `tabs/data/mcp/data-query-tools.ts` | `query_data` |
  | `core/mcp/governance-tools.ts` | `get_lineage` |

  The golden path is `guide.md` / `sovereign-os://guide/path/data`. NOT present, by decision:
  `dbt_run`, `dbt_test`, `dagster_materialize` — they address asset keys rather than objects, so
  they would bypass the dataset guard; the same work is reachable through `transform_silver`,
  `build_gold_join` and `sync_dataset_now`, which commit and then launch `dbt build --select` for
  that dataset's assets. A `get_dagster_run {runId}` read is a recorded gap (plan deviation B4-1).
- **Boot reconcile** (`lib/dbt/boot-reconcile.ts`): the commit hook only sees writes from the moment
  it is installed, so at boot the OS commits, for every domain it knows (datasets in the registry ∪
  repositories on disk), the difference between the generated project and the repository HEAD — as
  the platform principal, trailer `OS-Reason: boot-reconcile`. That is both the migration for an
  install that ran with the flag off and the repair for a crash between a store write and its commit.
  It commits only where the tree moved, is fail-soft per domain, and launches nothing.
- **Deleted** (checklist D7/D12): `lib/sync-cron.ts` (CronJob provisioning, manifest builder, cron
  matcher), `/api/data/sync-due`, `/api/data/dq/run-all`, the two chart CronJob templates and their
  values, `store.datasetsWithSync`. What remains is `lib/sync-cron-removal.ts` — delete-only, so an
  upgrade from a pre-B2 install still has its per-dataset CronJob removed; a test asserts the module
  cannot create one.
- **What the one-release opt-out still covers.** `enabled: false` restores the OS's own CTAS
  execution, the `os-sync-runs` / `os-dq-results` ledger reads and the OS DQ probe — but it no
  longer **schedules** anything. What that means on the surfaces, precisely (B4-review H-3):
  `reconcileSyncSchedule` returns `ok: true` with "nothing schedules it" in `detail`, and the panel
  shows that detail on every save (it used to show it only on a failure, i.e. never);
  `syncStatusFor` returns `nextRunAt: null` rather than an estimate from `nextCronRun`, because
  nothing fires that cron; both schedule pickers carry "scheduling is off (DATA_PROJECT_GIT
  disabled)"; and Platform → Components & Health carries an amber `data-products-git` row.
  Removing the flag is a recorded follow-up.
- **Still the OS's own, deliberately:** the query-tool's `/execute` (the build CTAS, but also
  `apply_quality_fixes`'s MERGE, physical deletes, the warehouse import and the publish CTAS) and
  the ad-hoc DQ probe (labelled `OS probe`, written to `os-dq-results`). Deleting the CTAS build
  path needs the row-set parity run in kind (checklist D15) first — the honesty gate registers a
  version only after a real apply+verify, and without the CTAS that gate would have to wait on a
  Dagster asset check.

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
