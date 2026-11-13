# dbt — transforms (dbt-trino)

**What it is:** dbt Core (Apache 2.0) with the **dbt-trino** adapter, executing on the central
governed Trino (Iceberg via the Polaris REST catalog). One adapter, one engine, one SQL dialect.

## What ships today, honestly

Two things exist side by side; be clear which one you are looking at.

**1. The demo project (`images/extensions/dbt/project`).** `raw_orders` → `stg_orders` →
`daily_revenue`, baked into the dbt and Dagster images. It runs once as a non-blocking
`post-install` Helm hook (`templates/extensions/dbt/dbt-build.yaml`) and on manual materialisation
in Dagster. **No OS dataset is part of it.** Until the engine rebuild lands, every transform,
composition, sync and quality check a user builds in the Data tab is TypeScript-compiled SQL run
through the query-tool as the acting principal — not a dbt model.

**2. The generated project per domain (engine rebuild, Phases B1–B2 — behind `DATA_PROJECT_GIT`).**
With `osUI.dataProjectGit.enabled: true` (env `DATA_PROJECT_GIT=true`), every dataset,
composition, quality rule, sync, publish and retire change — made in the UI or through the OS MCP —
regenerates the owning domain's **dbt project** and commits it to a bare git repository the OS owns
(`/repos/<domain>.git`, PVC `os-repos`), authored as the acting user. The OS is the writer; users
read, export and mirror the repo (`GET /api/data/projects/<domain>`, `…/blob`, `…/export`; admin
`PUT /api/platform-admin/data-projects/<domain>/mirror`).

The generated project is what an engineer would write:

| OS object | In the project |
|---|---|
| Ingested Bronze (`iceberg.personal_<uid>.bronze_<slug>`, written by the data-runner) | `models/sources.yml` source — dbt never writes Bronze; `freshness` on `_loaded_at` when the table carries it |
| A layer the OS did **not** compile (`add_dataset_version`'s free-text `body`, a seeded or adopted table) | a `models/sources.yml` **source** with `meta.os_built: out-of-band` — dbt reads that table and never rewrites it. The dataset's quality rules attach to it as source tests, so `dbt build` still runs them. This is why the store records *provenance* (`compiled: true`) alongside the body: an authored body must never be handed to Jinja at `dbt parse`, and a scheduled `<model>+` run must never replace someone's table with a copy of the layer below |
| Silver (guided clean / pass-through) | `models/…/silver_<slug>.sql`, `materialized: table`, `+on_table_exists: replace`; body = the compiled SELECT the OS recorded, FQNs rewritten to `{{ source() }}` |
| Gold / composition | `models/…/gold_<slug>.sql`; body = today's `compileGoldJoin` SELECT with every joined dataset as `{{ ref() }}` and another domain's product as `{{ source('<domain>', …) }}` |
| Personal lane vs promoted | un-promoted dataset → `models/personal/<uid>/` with `+schema: personal_<uid>`; promoted → `models/<layer>/` in the domain schema (`generate_schema_name` returns the custom schema verbatim) |
| Quality rules | `schema.yml` `data_tests`: `not_null`, `unique`, `accepted_values`, plus generator-shipped `tests/generic/range.sql` and `not_blank.sql` carrying the predicates of `dq.ts`. A column name is interpolated **unquoted** into the test SQL, so a rule whose column is not `/^[A-Za-z_][A-Za-z0-9_]*$/` — or an `accepted_values` with no values, or a `range` with neither bound — is recorded as `meta.os_intentions`, never emitted as a test (the store refuses such a column at the gate too). Free-text intentions likewise: never a fake test |
| Sync full-refresh | `materialized: table` over the federated `{{ source() }}` |
| Sync append (cursor, 15-min lookback, `_batch_id`) | `incremental`, `incremental_strategy: delete+insert`, `unique_key: _batch_id`, `where cursor > (select max(cursor) from {{ this }}) - interval '15' minute` |
| Sync merge | `incremental`, `incremental_strategy: merge`, `unique_key: [merge keys]`, `on_schema_change: append_new_columns` |
| Kafka offsets / API-batch sources | **not** faked as models: listed in `os/external.yml` for the Dagster assets B2 adds |
| Sync schedule | `os/schedules.yml` `{dataset, select: "<model>+", cron, timezone: UTC, principal, enabled}` → one UTC `ScheduleDefinition` in the Dagster `sovereign` location |
| Iceberg maintenance | `macros/os_maintenance.sql` — `ALTER TABLE … EXECUTE optimize` + `expire_snapshots(retention_threshold => '7d')` per schema, run weekly by Dagster as the schema's owner |

`profiles.yml` uses `env_var()` only: `TRINO_HOST/PORT/USER/CATALOG`, `TRINO_AUTH_METHOD`
(default `none`) and **`impersonation_user: env_var('OS_PRINCIPAL')`** with no default — a run
without a principal fails loudly instead of impersonating the domain. No credential is ever in the
repository.

The Dagster user-code pod's `repo-sync` sidecar fetches each domain repo over the read-only git
daemon and runs `dbt parse` in a worktree, repointing `current` only on success; in **B2** the
`sovereign` code location then loads that checkout, so the project is parsed *and* run —
`dbt build --select <assets>` in a Dagster run pod, launched by the OS after the commit or by the
schedule (see `dagster.md`). Verifying the Trino **impersonation** half end to end (`dbt-trino`
`impersonation_user` with `method: none`, OPA's `ImpersonateUser` for `dbt-runner`) is B3.

**Who can read the project.** `GET /api/data/projects/<domain>` is gated on **domain membership**,
and the repository is the whole domain's project — so every member of a domain can read every
member's dataset *definitions*: model SQL, column descriptions, quality rules, sync schedules and
the commit log naming who changed what, including un-promoted personal-lane models under
`models/personal/<uid>/`. That is deliberate (it is how an engineering team works) but it is wider
than the dataset list: a dataset whose **rows** you cannot see still has a readable definition here.
The data itself stays governed — a model reads only what Trino→OPA allows the impersonated
principal — and no credential is ever in the tree. Definition-level privacy inside a domain would be
a new per-path read gate, not a property of this design.

## Code

- Generator: `os-ui/tabs/data/lib/dbt/{generate,models,sources,schema,schedules,project}.ts`
  (pure; golden tests in `generate.test.ts`, fixtures in `fixtures/*.golden.json`).
- Commit path: `tabs/data/lib/dbt/commit.ts` over `core/infra/git-store.ts` (isomorphic-git, MIT).
- Read access + mirror: `tabs/data/lib/dbt/{read,mirror}.ts`; repo index `GET /api/data/projects`.
- Launch after commit: `tabs/data/lib/dbt/{launch,asset-keys}.ts` over `core/infra/dagster.ts`.
- Read-back: `tabs/data/lib/{sync-status-server,dq-status-server}.ts`.

## FAQ
**Q: Can I run the generated project myself?** Yes — export it (`GET …/export?ref=<sha>`), set the
`TRINO_*` env vars and `OS_PRINCIPAL`, `dbt parse --profiles-dir .`. Inside the cluster only the
Dagster user-code pod may reach the git daemon (NetworkPolicy).
**Q: Why dbt-trino?** Trino is the single governed engine: it writes/maintains Iceberg natively and
applies OPA row/column governance to the impersonated principal — the same identity the UI uses.
