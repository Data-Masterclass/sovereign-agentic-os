# Dagster — the scheduler and executor of every data product

**What it is:** Dagster (Apache-2.0) schedules and runs the OS's data products. arm64-native image
(the official images are amd64-only), run state in CNPG `dagster`. Since the engine rebuild **B2**
it is not a demo any more: **every OS dataset in a domain with a repository is a Dagster asset**,
scheduled from a validated git commit, and the OS **reads run state back from Dagster instead of
keeping its own ledger** (checklist D7–D11, D9).

Everything below is behind `osUI.dataProjectGit.enabled` / `DATA_PROJECT_GIT` (default **off**).
With the flag off nothing changes: syncs are Kubernetes CronJobs calling os-ui, quality runs are the
OS's own probes, and Dagster hosts only the demo mart.

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

## The `sovereign` code location

`images/extensions/dagster/repo.py` wires Dagster objects; everything decidable without Dagster
lives in `os_projects.py` (pure, unit-tested with `python3 -m unittest discover -s tests`).

| Piece | What it is |
|---|---|
| `hello_sovereign` | the smoke asset, kept |
| `<domain>_dbt` | `@dbt_assets` over `/repos-checkout/<domain>/current/target/manifest.json`, keys `[<domain>, <node>]` via a `DagsterDbtTranslator` prefix, group = the domain |
| `<domain>__all` | the job the OS launches with an explicit **asset subset** (Build, transform, gold join, sync now) |
| `<domain>__<datasetId>` | one job + `ScheduleDefinition` per entry in the repo's `os/schedules.yml`: `cron_schedule`, `execution_timezone="UTC"`, selection `<model>+`, `default_status` from `enabled` |
| `<domain>__maintenance__<schema>` | weekly (Sun 03:00 UTC) `dbt run-operation os_maintenance` → `ALTER TABLE … EXECUTE optimize` + `expire_snapshots(retention_threshold => '7d')` for every table/incremental model in that schema, as the schema's owning principal |
| `os_quarantine` | run-failure **sensor**: after `OS_QUARANTINE_THRESHOLD` (10, the OS's own threshold) consecutive failures of a schedule's job it **pauses the schedule** — this replaces the OS's `isQuarantined` |
| `os_principals` | **sensor** (5 min): reads `GET /api/data/projects` and pauses the schedules whose principal the OS reports **inactive** (a deactivated owner), rather than running them |
| `[<domain>, <source>, <table>]` | **observable source asset** per entry in the repo's `os/sources.yml` (engine rebuild B3) — the federated warehouse table a sync reads. See below. |

**Tags on every run** — `os/domain`, `os/commit`, `os/pinned`, and where applicable `os/dataset`,
`os/principal`, `os/schedule`, `os/action`, `os/layer`, `os/user`, `os/surface`, `os/batch_id`,
`os/full_refresh`. Monitoring and the Data tab find runs by these tags; nothing else is needed.

**`dagster-k8s/config`** carries the run pod's env: `OS_PRINCIPAL` (the Trino user dbt-trino
impersonates — the schedule's principal, the maintenance schema's owner, or the principal the OS
passed on launch) and `OS_PINNED_COMMITS` (`<domain>=<sha>,…`). A K8s run pod starts with an
**empty** `/repos-checkout`, so `os_projects.ensure_checkout` clones the pinned commit from the
read-only git daemon and `dbt parse`s it before building definitions. Values are principals and
shas — **never a secret**.

**Per-domain gating.** A domain whose checkout has no parsed manifest, or whose wiring raises, is
logged and **skipped**. One broken repository can never take the location down.

**Batch idempotency.** A sync's `delete+insert` model keys on `_batch_id = {{ var("os_batch_id") }}`.
The OS passes `--vars os_batch_id=<id>` on a **retry** (re-using the failed run's `os/batch_id`), so
that retry re-covers exactly the same slice. A plain re-run gets dbt's `invocation_id` and therefore
re-delivers the lookback rows as a new batch — that is the honest semantic, not a bug.

## External sources are assets too (engine rebuild B3)

A sync copies a table the OS does not own — a Postgres/Supabase/Snowflake table mounted as a
federated Trino catalog through the Connections tab. Before B3 that table was an invisible edge: the
silver model read `{{ source('wh__public', 'events') }}` and the graph simply started there.

The generator now also writes **`os/sources.yml`** (`tabs/data/lib/dbt/source-assets.ts`), one entry
per federated sync source, and the code location turns each into an
`@observable_source_asset`:

| Field | Meaning |
|---|---|
| asset key | `[<domain>, <source>, <table>]` — **exactly** the key dagster-dbt derives for the dbt source under the OS's prefixing translator, so the silver model depends on this very node instead of a parallel one |
| `observe` | `max_updated` when the sync has a **timestamp cursor** (`select max("<cursor>") , count(*)`), else `row_count`. The probe runs **as the entry's `principal`** (the dataset owner) — one statement, Trino→OPA governs it like any other read |
| `freshness_minutes` | **two schedule intervals**, derived from the sync's own cron by `cronIntervalMinutes` (pure, tested): one missed tick is jitter, two is late. A cron shape the OS's picker does not produce yields **no claim** rather than a wrong one. Rendered as a `build_last_update_freshness_checks` asset check |
| `downstream` | the model that reads it, so the file is readable on its own |

**Who runs the observation** (review B3-review-M-3/M-4). An observable asset that is in no job and
no schedule is never observed — so B3's assets were defined and inert, and their freshness checks
measured a data version that never arrived. The code location now also builds, per domain:

- **one observation job + schedule per DISTINCT cron** among that domain's ENABLED sources, at the
  source's own cron (which the generator derived from the sync's schedule). The job is named
  `<domain>__observe_<sha6(cron)>` — stable, so adding or removing an unrelated source never
  renames an existing schedule;
- `enabled: false` on an entry keeps the ASSET (the graph and the lineage view still need the node)
  and leaves it out of the schedule — nothing probes a source whose sync the owner turned off;
- `os/principal` + `OS_PRINCIPAL` on the run tag only when every source in the group shares one
  principal, and the inactive-principal sensor only registers such a group — one deactivated owner
  must not pause other people's observations.

**Bounded** (review B3-review-M-5): the probe connects with `request_timeout` AND a
`query_max_run_time` session property (`OS_OBSERVE_TIMEOUT_SECONDS`, default 60 s). The HTTP
timeout bounds one poll; only the session property makes Trino itself abandon a `select count(*)`
over a source that has gone slow, instead of holding a run pod and a Trino slot indefinitely.

Safety: every identifier in an entry must match `^[A-Za-z_][A-Za-z0-9_$]{0,127}$` or
`os_projects.parse_source_assets` **drops the entry** — the probe interpolates them into SQL, and a
half-built probe is worse than none. The `principal` is validated separately against the OS
principal shape `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (a principal is not a SQL identifier — it
legitimately contains `-` and `.`) and a malformed one DROPS the entry rather than being coerced
into a different identity (B3-review-L-2); the same bound applies to a schedule's principal, which
becomes `OS_PRINCIPAL` for the whole build. The Iceberg Bronze landing is deliberately NOT a source asset:
it lives in the same lakehouse and already carries `_loaded_at` dbt source freshness. Kafka-offset
and API-batch syncs are still in `os/external.yml` and still not assets — see the FAQ.

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

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80
# http://localhost:3070  (no login locally)
kubectl -n agentic-os exec deploy/agentic-os-dagster-sovereign -c repo-sync -- cat /repos-checkout/status.json
```

## FAQ

**Q: Does it run the OS's datasets?** Yes, with the flag on — a dataset's models are assets of the
`sovereign` location, its quality rules are dbt tests surfaced as **asset checks**, and its sync is a
`ScheduleDefinition`. With the flag off it still hosts only the demo mart.

**Q: What is NOT a Dagster asset?** Kafka-offset syncs and API-batch sources (Salesforce, Kajabi,
the Files connectors) — dbt cannot express a per-partition watermark or an API pull. The generator
lists them honestly in `os/external.yml`; the external-source assets are B3/B4 work. The Files
connector's old `launchPipelineExecution` call targeted a job that never existed and is now a logged
no-op with that TODO.

**Q: Where did my CronJob go?** With the flag on, saving a sync provisions **no** CronJob and removes
any pre-B2 one, so a slice cannot run twice; `/api/data/sync-due` and `/api/data/dq/run-all` stand
down for the same reason. The schedule lives in the repo and runs in Dagster.

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

## Known limits

- **A schedule that has never ticked cannot be paused** (review B2-review-L2). `os_quarantine` and
  `os_principals` pause through the instance's stored instigator state, and Dagster exposes no
  name-addressed `stop_schedule`; a brand-new schedule therefore pauses on its FIRST tick, not
  before it. Visible as the log line `schedule … has no stored state yet`.
- ~~**Cold start costs one checkout per domain**~~ **CLOSED in B3** (review B2-review-L4). Every
  tag a domain's jobs carry now pins **only that domain** (`os_projects.pinned_one`,
  `repo.py` `_wire_project`), so a run pod clones and `dbt parse`s exactly what its own job needs
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
