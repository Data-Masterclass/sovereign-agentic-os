# Dagster — the scheduler and executor of every data product

**What it is:** Dagster (Apache-2.0) schedules and runs the OS's data products. arm64-native image
(the official images are amd64-only), run state in CNPG `dagster`. Since the engine rebuild **B2**
it is not a demo any more: **every OS dataset in a domain with a repository is a Dagster asset**,
scheduled from a validated git commit, and the OS **reads run state back from Dagster instead of
keeping its own ledger** (checklist D7–D11, D9).

Everything below is behind `osUI.dataProjectGit.enabled` / `DATA_PROJECT_GIT`, which is **on by
default since B4**. With the flag off the OS falls back to its own CTAS execution, its
`os-sync-runs` / `os-dq-results` ledger reads and its own DQ probe — but it **schedules nothing**:
B4 deleted the CronJob provisioning (`tabs/data/lib/sync-cron.ts`) and both fallback sweeps, so a
saved sync in that state waits for a manual "Sync now". The flag is an emergency opt-out for one
release and then goes.

## The flow, end to end

```
 user (UI or MCP)                os-ui                         git                 Dagster
 ────────────────                ─────                         ───                 ───────
 Build / transform_silver  →  store mutation (canEdit)
 build_gold_join           →  generate dbt project
 set_dataset_sync          →  commit as the acting user  →  /repos/<domain>.git
                                                              │  main = <sha>
                                                              ▼
                                           repo-sync (sidecar):  fetch → worktree <sha>
                                                                 → `dbt parse` → target/manifest.json
                                                                 → current → <sha>   (only on success)
                                                                 → reloadRepositoryLocation("sovereign")
 launchRun(selection, tags) ───────────────────────────────────────────────────────▶ run pod
                                                       dbt build --select … (OS_PRINCIPAL impersonated)
 Data tab / Monitoring  ◀── runsForDataset · assetChecks · latestMaterialization · nextTick
```

One commit, one validated checkout, one run. The OS writes no `os-sync-runs` or `os-dq-results`
row for anything Dagster executed.

## The domain repo's own code location (WP-49)

Every domain repo carries its data products as **plain Dagster code**: the OS generates
`data/dagster/definitions.py` (`tabs/data/lib/dbt/dagster-definitions.ts`) next to the dbt project
at `data/dbt/` (component design 12). It is a normal code location — from a clone, with no OS:

```sh
pip install dagster dagster-webserver dagster-dbt dbt-trino 'dlt[sqlalchemy,sql-database]' 'trino[sqlalchemy]'
cd data/dagster
export DBT_TARGET=local TRINO_HOST=localhost TRINO_USER=$USER \
       DESTINATION__SQLALCHEMY__CREDENTIALS=trino://$USER@localhost:8080/iceberg \
       SOURCES__<CONNECTION>__CREDENTIALS=postgresql+psycopg2://…   # one per database connection
dagster dev -m definitions                 # assets, checks, schedules in the UI
dagster asset materialize -m definitions --select '*'
```

| Piece | What it is |
|---|---|
| `<domain>_dbt` | `@dbt_assets` over `DbtProject(data/dbt)` (`prepare_if_dev()` runs `dbt parse` under `dagster dev`), keys `[<domain>, …]` via a translator prefix, group = the domain, dbt tests on sources as checks (`enable_source_tests_as_checks`) |
| `[<domain>, landing_<domain>_<owner>, raw_<slug>]` | one **dagster-dlt `@dlt_assets`** per database sync (decision O8) over a dlt source that is a credential-free declaration at load time; the run binds `sql_table(credentials=dlt.secrets["sources.<connection>.credentials"], …, incremental=dlt.sources.incremental(<cursor>))` through `DagsterDltResource.run(dlt_source=…)`, into `dlt.pipeline(pipeline_name=<dataset id>, destination="sqlalchemy", dataset_name=landing_<domain>_<owner>)`. The `sqlalchemy` destination over Trino's dialect makes the landing a Trino write into Iceberg as the principal. Its key is the dbt source's key, so the sync model depends on it; a `build_last_update_freshness_checks` check (two schedule intervals) watches it |
| `<domain>__all` | the job the OS launches with an explicit **asset subset** (Build, transform, gold join, sync now) |
| `<domain>__<datasetId>` | one job + `ScheduleDefinition` per sync: the dlt asset and everything downstream (or `<model>+` for a sync dbt reads directly), `execution_timezone="UTC"`, `default_status` from `enabled` |
| `<domain>__maintenance__<schema>` | weekly (Sun 03:00 UTC) `dbt run-operation os_maintenance` (optimize + `expire_snapshots`), as the schema's owning principal |

**User text only as literals.** No dataset name, owner, table, cron, SQL or domain is ever written into a comment or an identifier of the module (`dagster-definitions.fuzz.test.ts`).

**Adopted bronze is guarded.** Sync models carry `full_refresh=false`: "reset and full re-sync" runs them incrementally and never drops bronze history (review N2).

**OS metadata only in tags** (artifact contract C2, GLUE-10): `os/domain`, `os/dataset`,
`os/principal`, `os/schedule`, `os/action`, `os/schema` on jobs; `os/dataset` as asset metadata.
`os/run_grant` is WP-15's to add as one more tag. The module reads no OS file.

**No out-of-band layer** (C3). Every built silver and gold layer is a dbt model: a body the OS
compiled, a pass-through, or an **authored** body committed as written. An authored model adopts its
existing table with `config(materialized='table', on_table_exists='replace', full_refresh=false)`:
Iceberg's `CREATE OR REPLACE TABLE` keeps the table's snapshot history. A built layer with **no
recorded SQL**, or authored SQL carrying dbt Jinja, makes the generator refuse the dataset, with the
reason in `os/skipped.yml`; its tables stay untouched. GLUE-10 fails any generated `sources.yml` that
declares a silver/gold layer as a source.

## The `sovereign` code location: a platform wrapper

`images/extensions/dagster/repo.py` owns **no asset, job or schedule**. It loads each repo-sync
checkout's `data/dagster/definitions.py` and merges them (`Definitions.merge`), adding only:

| Piece | What it is |
|---|---|
| hash check (C5) | `os_projects.load_project` imports a module only when its sha256 equals `os/generated.yml` (written by the OS; `os/**` and `data/dagster/**` are unpushable). A tampered copy is skipped with the reason |
| run-pod env | every schedule is re-declared with `dagster-k8s/config`: `OS_PINNED_COMMITS`, and — from the job's own `os/principal` tag — `OS_PRINCIPAL` (dbt impersonation) and `DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME` (dlt). OS launches pass the same env (`launch.ts`) |
| `os_quarantine` | run-failure **sensor**: after `OS_QUARANTINE_THRESHOLD` (10) consecutive failures it **pauses the schedule** |
| `os_principals` | **sensor** (5 min): pauses the schedules whose principal the OS reports **inactive** |

**Tags on every run** — `os/domain`, `os/commit`, `os/pinned`, and where applicable `os/dataset`,
`os/principal`, `os/schedule`, `os/action`, `os/layer`, `os/user`, `os/surface`, `os/batch_id`,
`os/full_refresh`. A K8s run pod starts with an **empty** `/repos-checkout`, so
`os_projects.ensure_checkout` clones the pinned commit and `dbt parse`s `data/dbt` before it imports
the module.

**Per-domain gating.** A domain without a parsed manifest, without definitions, with a hash
mismatch, or refused by `Definitions.validate_loadable` is logged and **skipped**.

**Batch idempotency.** A sync's `delete+insert` model keys on `_batch_id = {{ var("os_batch_id") }}`;
the module passes `--vars` from the run's `os/batch_id` tag, so a retry re-covers the same slice.

## Lineage comes from the manifest (engine rebuild B3)

`get_lineage` and the Data tab's lineage view read **dbt's own `ref()`/`source()` graph**, not the
OS's version records, whenever `DATA_PROJECT_GIT` is on. It is **all of a dataset's models or none**
(B3-review-M-1): a half-parsed project would otherwise yield a graph missing a layer while still
labelled `source: 'dbt'`, which reads as "dbt says there is no Silver here" rather than "dbt has not
caught up". A missing model falls back to the registry graph, and the `source` label (`dbt` /
`registry`) is carried all the way out through MCP `get_lineage` (B3-review-M-2) so a caller can
always tell which graph it got.

```
tabs/data/lib/lineage-server.ts  datasetLineage(dataset)
  → core/infra/dagster.ts assetGraph()        # assetNodes { assetKey dependencyKeys }
  → tabs/data/lib/dbt/lineage.ts graphLineage(dataset, nodes, datasetAssetKeys(...))
  → fall back to tabs/data/lib/lineage.ts lineageFor(dataset)   # labelled source: 'registry'
```

Dagster derives `dependencyKeys` from `manifest.json`'s `parent_map`, so this IS the manifest —
reached over a path the OS already authenticates to. Reading `target/manifest.json` directly was
rejected: it lives in the Dagster pod's `/repos-checkout`, which os-ui cannot mount, and the
repo-sync status port has no Service.

The payload gained one additive field, `source: 'dbt' | 'registry'`, so a surface can say where the
graph came from. The fallback triggers on: flag off · Dagster not configured · the call failed · the
dataset has no model in the graph yet (its first commit has not been parsed).

**Column-level lineage is not derived.** dbt's manifest does not carry column-level edges in dbt
Core; per-node columns stay the OS's documented columns. Recorded as a follow-up, not implied.

## repo-sync sidecar

The user-code Deployment carries a second container, `repo-sync`
(`images/extensions/dagster/repo-sync.sh`, same image), sharing an `emptyDir` at `/repos-checkout`.
Inert until `REPO_SYNC_ENABLED=true`.

Every `REPO_SYNC_INTERVAL` seconds it:

1. **discovers domains** from the OS repo index `GET /api/data/projects` (`REPO_SYNC_INDEX_URL`,
   authenticated with the cluster-internal runtime bearer) ∪ the explicit `REPO_SYNC_DOMAINS` list —
   the git protocol cannot enumerate repositories, which is why the index exists;
2. fetches `git://os-repos/<domain>.git`; when `main` moved, adds a worktree
   `/repos-checkout/<domain>/<sha>` and runs **`dbt parse`** there (this is what writes
   `target/manifest.json`, the file the code location loads);
3. **only on success** repoints `/repos-checkout/<domain>/current → <sha>`, then calls GraphQL
   `reloadRepositoryLocation("sovereign")` against the webserver Service — once per pass;
4. writes each domain's `{head, current, lastGood, error, checkedAt}` to
   `/repos-checkout/status.json` and serves **that file only** on `REPO_SYNC_STATUS_PORT` (8089).

A commit that fails to parse never replaces the last good checkout: the schedules keep running the
previous commit and the OS can show *"commit abc123 failed `dbt parse`: … — schedules still run
def456"* (checklist D8).

**Secrets.** `dbt parse` renders Jinja from a repository, so it runs under `env -i` with a fixed
allowlist. The sidecar holds exactly **one** secret, `AGENT_RUNTIME_TOKEN` (the bearer the OS index
route accepts), and `env -i` keeps even that out of dbt's environment. No Trino password, no mirror
token, nothing else may ever be put in this container's env — a generated `profiles.yml` reads its
credentials from the **run pod's** env instead.

## Image and chart

- **Image** `sovereign-os/dagster:0.3.0` — dagster 1.13.11 + dagster-dbt + dbt-trino, the Postgres
  drivers (`psycopg[binary]`, `psycopg2-binary` — their absence is why Dagster showed 0 runs in 90
  days), `git`, `repo.py`, `os_projects.py`, `repo-sync.sh`.
- **Chart** — the user-code deployment is named **`sovereign`**, because the deployment name *is* the
  code location name that `reloadRepositoryLocation` and the OS's `DAGSTER_LOCATION` address.
  `DAGSTER_RELOAD_LOCATION=sovereign`, `OS_INDEX_URL`/`REPO_SYNC_INDEX_URL` point at os-ui,
  `OS_QUARANTINE_THRESHOLD=10`. The Admin Console's version string now reads the real 1.13.11.

## What a dbt run sees

dbt runs through `repo.py ScrubbedDbtCliResource` (the legacy wiring and, swapped in, a repo's own
native `DbtCliResource`). It is dagster-dbt's resource unchanged, except that the dbt process gets
only `os_projects.dbt_run_env()`: an exact list of names — the variables the generated `profiles.yml` reads, dbt's own run settings, `OS_PRINCIPAL` and the process basics
(`PATH`, `HOME`, `LANG`, `TZ`, CA bundles). Nothing else the run pod holds reaches dbt. Proof:
`tests/image/dbt_env.py` (real dagster-dbt + dbt-core: credentials render as their default, a Trino
setting passes, `dbt build` works on a real Trino; the stock resource is the negative twin).

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80
# http://localhost:3070  (no login locally)
kubectl -n agentic-os exec deploy/agentic-os-dagster-sovereign -c repo-sync -- cat /repos-checkout/status.json
```

## Engineering view ("Under the hood")

A data product's **Dagster** tab shows, in Dagster's own vocabulary: the `Dagster asset` key
(`["<domain>","<model>"]`), the `Dagster job` (`<domain>__all`), the `Dagster schedule`
(`<domain>__<datasetId>`), and the last `Dagster run` with its run id and status — read over the
GraphQL API, as the signed-in user's view of a shared scheduler.

- "Open in Dagster" goes to **Dagster's own console** (`dagsterConsoleUrl`), *not* through
  `/tools/dagster`: `core/infra/tool-proxy.ts` declares `ownTab` for Dagster precisely because its
  Next.js chunks load from the site root and render blank behind the proxy prefix. Linking into the
  proxy would have handed every engineer a blank page, so the panel links the address that works
  and the proxy keeps the embedded-tool job it can actually do.
- The tool's own `minRole` (**builder**) gates the link. A creator is not handed a link the ingress
  would refuse: the panel says the role it needs, and the asset key and the `dagster asset
  materialize` command are shown to them regardless.
- When this deployment exposes no console (`DAGSTER_CONSOLE_URL` empty) or Dagster is not
  configured at all, the link is **not** hidden: it says which of the two it is.
- When Dagster is unreachable, the last run is reported as *unknown with the transport error* —
  never as "no runs".
- The command is the real one: `dagster asset materialize --select <domain>/<model>`.

Kinds other than a data product say plainly that Dagster does not schedule them: an agent system is
scheduled by the OS (a CronJob per schedule), a dashboard and a KPI are read on demand, and an app
is served rather than materialised.

## FAQ

**Q: Does it run the OS's datasets?** Yes, with the flag on — a dataset's models are assets of the
`sovereign` location, its quality rules are dbt tests surfaced as **asset checks**, and its sync is a
`ScheduleDefinition`. With the flag off it still hosts only the demo mart.

**Q: What is NOT a Dagster asset?** Kafka-offset syncs and API-batch sources (Salesforce, Kajabi,
the Files connectors) — dbt cannot express a per-partition watermark or an API pull. The generator
lists them honestly in `os/external.yml`. **Database** syncs are dlt ingestion assets in the repo's
`data/dagster/definitions.py` since WP-49 (the B3 observation of a federated catalog and
`os/sources.yml` are gone); the Kafka (WP-17) and SaaS/API (WP-18, dlt `rest_api`) halves stay out. The Files
connector's old `launchPipelineExecution` call targeted a job that never existed and is now a logged
no-op with that TODO.

**Q: Where did my CronJob go?** Saving a sync provisions **no** CronJob and removes any pre-B2 one,
so a slice cannot run twice. The schedule lives in the repo (`data/dagster/definitions.py`, WP-49) and runs in Dagster.
Since **B4** this is not a flag-dependent behaviour but the only behaviour: the provisioning code,
the two fallback sweep routes (`/api/data/sync-due`, `/api/data/dq/run-all`) and their chart
CronJobs are deleted. All that survives is the delete-only
`tabs/data/lib/sync-cron-removal.ts`, so an upgrade still cleans up what a pre-B2 save left behind.

**Q: Volume and schema monitors?** They are not dbt tests. dbt has no native volume or drift monitor,
so with the flag on they are **absent**, not faked (concept §1); Dagster asset checks over
materialisation metadata are the planned home.

**Q: Needs the live cluster.** That a scheduled sync materialises in kind under the owner principal,
that `dagster-k8s/config` propagates the env to run pods, that the `sidecarContainers`/`volumes`
keys of the user-deployment schema render as expected, and that `reloadRepositoryLocation` succeeds
against the webserver Service — all of it is verified at deploy, not here. The exact commands are
below.

## Verify it in a cluster

Five things were written against Dagster 1.13's published schema and behaviour but **never probed**.
Each is a one-command check against a live install; run them on the first deploy and fix the code,
not the cluster, if one disagrees.

```bash
NS=agentic-os
PF() { kubectl -n $NS port-forward svc/agentic-os-dagster-webserver 3070:80; }   # leave running
GQL() { curl -s localhost:3070/graphql -H 'content-type: application/json' -d "{\"query\": $1}"; }
```

**1. The GraphQL field names `core/infra/dagster.ts` sends.** The documents use
`assetChecksOrError` as a ROOT field, `Schedule.futureTicks` and
`ExecutionParams.selector.assetSelection`. Introspect each before trusting a silent empty answer:

```bash
GQL '"{ __type(name: \"Query\") { fields { name } } }"'            # expect: assetChecksOrError
GQL '"{ __type(name: \"Schedule\") { fields { name } } }"'          # expect: futureTicks
GQL '"{ __type(name: \"ExecutionParams\") { inputFields { name } } }"'
GQL '"{ __type(name: \"JobOrPipelineSelector\") { inputFields { name } } }"'  # expect: assetSelection
```
A missing field makes the client return `ok:false` with the server's message — the surfaces then say
"unknown", never a fabricated value — so the failure mode is honest, but the feature is dead until
the name is right.

**2. Does a `dagster-k8s/config` run tag MERGE with the code location's container context, or
REPLACE it?** `os_projects.k8s_env_tag` sends only `container_config.env` (`OS_PRINCIPAL`,
`OS_PINNED_COMMITS`) and ASSUMES the location's `env` (TRINO_*, the repos volume) survives the merge.
If it replaces, every scheduled run loses its Trino settings:

```bash
kubectl -n $NS get job -l dagster/job -o name | head -1 | xargs kubectl -n $NS get -o jsonpath='{.spec.template.spec.containers[0].env[*].name}'
# expect BOTH OS_PRINCIPAL and TRINO_HOST
```

**3. Is the repository name of a `Definitions`-based location really `__repository__`?** The client
addresses schedules through it (`scheduleNameFor` / `nextTick`):

```bash
GQL '"{ repositoriesOrError { ... on RepositoryConnection { nodes { name location { name } } } } }"'
```

**4. Do launched RUN pods carry `component: user-deployments`** — the label the `os-repos`
NetworkPolicy admits to the git daemon on 9418? Without it a run pod cannot clone its pinned commit
and every scheduled sync fails at `ensure_checkout` (review B2-review-H1):

```bash
kubectl -n $NS get pods -l component=user-deployments -o custom-columns=NAME:.metadata.name
# expect the code-server pod AND any dagster-run-* pod currently alive
kubectl -n $NS logs job/<a dagster-run job> | grep -i 'git clone'   # must not say "unreachable"
```

**5. Does the repo-sync container in a RUN pod exit?** It is copied into every run pod through
`run_k8s_config.pod_spec_config.containers`, and a Job only completes once every container exits; it
self-exits on `POD_NAME` (review B2-review-M1):

```bash
kubectl -n $NS get job -l dagster/job -o custom-columns=NAME:.metadata.name,DONE:.status.succeeded
kubectl -n $NS logs job/<a dagster-run job> -c repo-sync   # expect "in a Dagster run pod … exiting 0"
```
If a run Job stays Running with its main container done, the guard did not fire — set
`includeConfigInLaunchedRuns.enabled: false` on the deployment and move the run pods' `volumes`,
`volumeMounts` and env to `dagster.runLauncher.config.k8sRunLauncher` instead.

## Status from dbt and Dagster, one parse gate (WP-16)

Off by default (`dagsterRepoStatus.enabled`). repo-sync stays the single dbt gate (10 F10); its
status server is the feed, through Service `dagster-repo-status:8089` (bearer: the runtime token;
NetworkPolicy: os-ui, os-ui-worker, metric-compile):

- `GET /status.json` — every domain's head, the commit Dagster runs (`current`), dbt's error.
- `GET /verdicts/<domain>/<sha>.json` — dbt's verdict for that commit, `{ok:true}` or the refusal
  with dbt's own text. A refused sha is parsed once until `main` moves.
- `GET /manifests/<domain>/<sha>/{manifest,semantic_manifest}.json` — dbt's own artifacts of a
  commit that parsed (the current and the previous good one), for metric-compile and lineage.

os-ui reads them in `core/adapters/dagster/graphql-read.ts` (`repoStatus`, `repoVerdict`,
`repoManifest`) and copies each head's verdict into `os_governance.commit_checks(domain, sha,
'dbt-parse')` every 30 s (`commit-checks.ts`). `assetHealth(key)` reads each asset check's
execution for the latest materialization from Dagster GraphQL; Dagster OSS 1.13 serves no
`assetHealth` rollup (`dagster_asset_health_queries_supported()` is False outside Dagster+).
repo.py's translator turns dbt source tests into asset checks on the source asset
(`enable_source_tests_as_checks=True`, 01 R6). Proof: `tests/dagster/repo-status.int.test.ts`.

## Known limits

- **WP-49 needs the WP-55 layout.** The generated module expects the dbt project at `data/dbt/`
  and repo-sync must `dbt parse` there (`os_projects.DBT_PROJECT_DIR`); until a repo is migrated,
  the wrapper skips it with "no data/dbt/target/manifest.json". Deploy WP-49 with or after WP-55.
- **dlt connects to Trino as the principal** (no authentication today, like dbt's `dbt-runner`
  impersonation). WP-15 moves both to `svc-dagster-runner` with run grants; the module needs no
  change for that — only the run-pod env and `os/run_grant` tag the platform adds.
- **`os/external.yml` is written but not read** (live audit 2026-11, track H). Kafka-offset and
  API-batch syncs (Salesforce, Kajabi, OData, Workday — any connection without a Trino catalog)
  are planned as *external assets*: the generator lists them in `os/external.yml`, but neither
  `repo.py` nor `os_projects.py` reads that file, so **no schedule exists for them** and, with
  `DATA_PROJECT_GIT` on, "Sync now" returns `no dbt model for bronze of this dataset`. The Sync
  panel and `get_sync_status` say so (`notRunning`: "Scheduled sync is not running: … not run by
  Dagster yet"). Closing it needs a Dagster asset per external entry that calls the OS's governed
  slice executor as the dataset owner — a new os-ui runtime endpoint plus `repo.py` wiring.
- **One bad dataset no longer fails the domain's `dbt parse`** (live incident 2026-11, track H). A
  quality rule recorded twice used to become two identical tests, which dbt 1.9 refuses
  (`dbt found two data_tests with the name …`), so repo-sync kept the domain on its last good
  commit — or on nothing — and no schedule ran. The generator now de-duplicates identical tests
  (`schema.ts` `pushUniqueTest`) and, before returning a tree, runs `project-check.ts`; any dataset
  an issue is attributed to is **left out** and listed in `os/skipped.yml`, which the Sync panel
  reads back. repo-sync now logs the dbt error itself (`os_projects.parse_error_summary`). A
  `ScheduleNotFoundError` for an enabled sync is surfaced as "Scheduled sync is not running".

- **A schedule that has never ticked cannot be paused** (review B2-review-L2). `os_quarantine` and
  `os_principals` pause through the instance's stored instigator state, and Dagster exposes no
  name-addressed `stop_schedule`; a brand-new schedule therefore pauses on its FIRST tick, not
  before it. Visible as the log line `schedule … has no stored state yet`.
- ~~**Cold start costs one checkout per domain**~~ **CLOSED in B3** (review B2-review-L4). Every
  tag a domain's jobs carry now pins **only that domain** (`os_projects.pinned_one`,
  `repo.py` `wrap_domain`), so a run pod clones and `dbt parse`s exactly what its own job needs
  and cold start stays flat as domains are added. The location-wide `pinned_env` is still computed
  for the code-server pod, which legitimately loads every domain.
- ~~**The repo-sync status server binds `0.0.0.0:8089`**~~ **CLOSED in B3** (review B2-review-L5).
  It now binds `POD_IP` (downward API; `127.0.0.1` when unset — fail-closed) and requires
  `Authorization: Bearer <REPO_SYNC_STATUS_TOKEN or AGENT_RUNTIME_TOKEN>` when one is configured,
  refusing the shipped dev placeholder as a credential. It still serves `status.json` and nothing
  else, **no Service exposes the port**, and os-ui does not read it — the OS learns a domain's head
  commit from its own git store, not from the sidecar.
- ~~**A collided domain's schedule could not be addressed by the OS**~~ **CLOSED in B3**
  (review B2-review-M2's recorded consequence). `core/infra/dagster.ts` `sanitizeAll` is a
  transcription of `os_projects.sanitize_all`, and both assert the same golden
  (`images/extensions/dagster/tests/sanitize-collisions.golden.json`, regenerate with
  `tests/regen_sanitize_golden.py`). `scheduleNameFor(domain, datasetId, allDomains)` therefore
  computes the digest form the location really used; `sync-status-server.ts` passes the domains that
  have a repo. Without a domain list it still returns the plain form, which is correct whenever
  nothing collides.
