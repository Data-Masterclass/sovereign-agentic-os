# Dagster — orchestrator

**What it is:** Dagster (Apache 2.0) orchestrates the data tier. arm64-native image (the official
images are amd64-only), backed by CNPG `dagster`.

## What ships today, honestly

- **Code location:** `images/extensions/dagster/repo.py` — `hello_sovereign` plus `dbt_assets` over
  the **demo** dbt project baked into the image. No schedules, no sensors, **no OS dataset** is a
  Dagster asset yet. Scheduled syncs still run as Kubernetes CronJobs that call os-ui
  (`tabs/data/lib/sync-cron.ts`); Monitoring reads Dagster's `/graphql` for run history only.
- **Image:** dagster 1.13.11 + dagster-dbt + dbt-trino, with the Postgres driver (`psycopg[binary]`,
  `psycopg2-binary`) and — since the engine rebuild B1 — `git` and the `repo-sync.sh` sidecar script.
- **Drift fixed (B1):** the user-code `TRINO_SCHEMA` was `analytics` while the dbt profile and the
  marts use `sales`; it is `sales` now.

## repo-sync sidecar (engine rebuild B1 — data products in git)

The Dagster user-code Deployment carries a second container, `repo-sync`
(`images/extensions/dagster/repo-sync.sh`, same sovereign image), sharing an `emptyDir` at
`/repos-checkout`. Inert until `REPO_SYNC_ENABLED=true` (flip together with
`osUI.dataProjectGit.enabled`, which gives os-ui the `os-repos` PVC + a read-only `git daemon`
sidecar, Service `os-repos:9418`, admitted to the Dagster user-code pod only by NetworkPolicy).

Every 15 s, for each domain in `REPO_SYNC_DOMAINS`: fetch `git://os-repos/<domain>.git`; when
`main` moved, `git worktree add /repos-checkout/<domain>/<sha>`, run **`dbt parse`** there, and
**only on success** repoint `/repos-checkout/<domain>/current → <sha>`. A commit that fails to parse
never replaces the last good checkout — the code location keeps the previous commit (checklist D8).
Each domain's outcome (`head`, `current`, `lastGood`, `error`) is written to
`/repos-checkout/status.json`, served on a cluster-local port (`REPO_SYNC_STATUS_PORT`, 8089), so
the OS can show *"commit abc123 failed dbt parse: … — schedules still run def456"*.

Not yet wired (B2): the multi-project code location (`sovereign`) that loads every
`/repos-checkout/<domain>/current/`, the `ScheduleDefinition`s from `os/schedules.yml`, the
failure sensor, and the `reloadRepositoryLocation` GraphQL call after a successful repoint
(`DAGSTER_RELOAD_LOCATION` is empty until then; the sidecar logs the skip). Domain discovery is an
explicit list in B1.

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80
# http://localhost:3070  (no login locally)
```

## How to use it
- **Assets tab:** the demo dbt models (`daily_revenue`, `stg_orders`, `raw_orders`) plus
  `hello_sovereign`. **Materialize** them to run `dbt build` against the warehouse.
- **Runs tab:** inspect run logs/status.
- **repo-sync:** `kubectl -n agentic-os exec deploy/<user-code> -c repo-sync -- cat /repos-checkout/status.json`.

## FAQ
**Q: Does it run the OS's datasets?** Not yet — see above. B1 makes every dataset change a commit
of a real dbt project and validates it here; B2 turns the project into assets and schedules.
**Q: Daemon/user-code pods?** webserver (UI) + daemon (schedules/sensors) + user-code (gRPC, hosts
the definitions; now with the `repo-sync` sidecar). All from one sovereign image.
