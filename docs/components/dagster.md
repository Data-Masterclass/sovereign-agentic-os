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
against the webserver Service — all of it is verified at deploy, not here.
