# Data products as dbt + Dagster + Trino, in git: audit and concept (Phase B0)

> Detail for Part B of `2026-11-13-engine-rebuild.md`. Produced read-only on 2026-11-13 from `feat/engine-rebuild`. Agents executing B1–B4 read this first. Where a decision here differs from the plan's one-line outline, this document wins and the plan is updated to match.

---

## Part I — Audit: how data products execute today

Legend: **Docs** = what docs/README claim · **Code** = what exists · **Runtime** = what is wired; "live" = needs the cluster.

### 1. Ingest and landing
- Upload → MinIO `uploads/<uid>/` → **data-runner** `/ingest` → **PyIceberg via Polaris REST** writes `iceberg.personal_<uid>.bronze_<slug>`. Trino is **not** the Bronze writer; it only verifies/previews (`tabs/data/lib/ingest.ts:21-30, 97-113`; `images/extensions/data-runner/app.py:14, 207-250`).
- Principal is forced to the session `user.id`; the namespace is derived server-side and a mismatched `schema` is rejected (`ingest.ts:72, 144`; `app.py:207-212`).
- `ingestAndRegisterBronze` then fire-and-forgets Silver → Gold pass-through CTAS and auto-DQ (`ingest.ts:179-186`; `auto-pipeline.ts:102-156`).
- **Reads:** os-ui → query-tool `/query` `{sql, principal}` with a shared service bearer; query-tool opens a Trino session **as `principal`**; Trino→OPA (`trino.rego`) applies row filters, column masks and a hard deny on foreign `personal_*` (`core/infra/governed.ts:110-122`; `query-tool/app.py:43, 64-73, 144-160`; `policies/trino.rego:126, 171-178`).
- **Writes:** os-ui → query-tool `/execute` `{sql, principal, uid, domains, role}`; **`execute_guard.py` is the authoritative allowlist** (CTAS / INSERT…SELECT / MERGE / DELETE-by-batch / expire_snapshots / optimize) and role floor (builder for domain schemas, anyone for own `personal_<uid>`). OPA's write floor is "additive" (`governed.ts:157-194`; `execute_guard.py:12-36, 55, 307-333`; `trino.rego:33, 38-50, 87-90`).

### 2. Transforms and compositions — Trino CTAS composed in TypeScript (confirmed)
- `transform.ts` is a pure compiler whose output is shaped to pass `execute_guard.py`: one `CREATE OR REPLACE TABLE iceberg.<schema>.<table> AS SELECT …`, no comments, no `;` (`transform.ts:5-22`).
- `silverSchema(uid) = personalSchema(uid)`: **every Silver/Gold build lands in the caller's personal lane**; the domain copy exists only after a *publish* CTAS/VIEW (`publishPlan`) (`transform.ts:264-265, 683-701`).
- `goldJoinPlan` → `compileGoldJoin` → `iceberg.personal_<uid>.gold_<slug>`; a curated dataset passes an explicit `baseSource`. Persisted spec = `goldSpec` + `upstreams` (`transform.ts:725-743`; `dataset-schema.ts:303, 307`; `store.ts:1011-1029`).
- The "dbt" and "dbt-trino" Build adapters are **names only**: both end in `executeRun(sql)`. No dbt binary, no model file, no manifest (`build/live.ts:109-115, 154-178, 185-205`; `build/live-clients.ts:161-174, 204-219`).
- FQN rule: `iceberg.<schema>.<layer>_<slug>`, schema = `personal_<sanitizeIdent(uid)>` or `sanitizeIdent(domain)`; `physicalSlug` frozen across renames; reads flip the Trino principal to the uid only when SQL touches the caller's own lane (`store-fqn.ts:28-30, 46-60, 76-81, 168-195`).
- Lineage labels *pretend* dbt files exist (`silver/stg_<s>.sql`, `gold/mart_<s>.sql`): cosmetic strings (`lineage.ts:45-49`).

### 3. Scheduled syncs — Kubernetes CronJob curling os-ui, not Dagster (confirmed)
- `reconcileSyncCron` upserts a `batch/v1` CronJob (`timeZone: UTC`, `concurrencyPolicy: Forbid`, `startingDeadlineSeconds: 60`) whose `curlimages/curl` container POSTs `<dataSyncUrlBase>/<id>/sync` with the runtime bearer (`sync-cron.ts:59-121, 142-184`; `core/kernel/config.ts:94-100`).
- The route resolves the **dataset owner's live identity** and runs as them; refuses a service fallback (`sync/route.ts:28-31, 47, 59`; `sync-run-server.ts:50-60, 303-312, 337-347`).
- Fallback sweep: a chart CronJob POSTs `/api/data/sync-due` (`templates/extensions/metrics/data-sync-cronjob.yaml`; `sync-due/route.ts:33-60`).
- `sync-sql.ts` compiles exactly the semantics the plan names: full-refresh CTAS; append = `DELETE … WHERE _batch_id` + `INSERT … WHERE cursor > W − lookback AND cursor <= HW` (15-min default lookback, timestamp cursors only); merge = staging CTAS + `MERGE INTO` + `DROP`; Kafka per-partition offsets; Iceberg `expire_snapshots`/`optimize` (`sync-sql.ts:10-27, 99-104, 116, 133-144, 164-179, 198-232, 302-362, 366-377`).
- Run ledger, watermark and quarantine live in the OS's own OpenSearch index `os-sync-runs` (`sync-runs.ts:9-19, 73-96, 174-182`).
- **Dagster is not in this path.** The only Dagster calls: Monitoring reads `/graphql` runs; the Files connector fires `launchPipelineExecution` for a job `repo.py` does not define (likely a silent no-op; live check) (`monitoring/lib/adapters/pipeline-health.ts:11-13, 30`; `files/lib/connectors-server.ts:80`; `images/extensions/dagster/repo.py:19-34`).

### 4. Quality rules
- `not_null | not_blank | unique | accepted_values | range` compile to one `select count(*) … where <violation>` each, run via `queryRun` as the owner principal; results in `os-dq-results`; freshness/volume/schema monitors are heuristics over that history. The file itself calls dbt tests "the future path" (`dq.ts:9-21, 53-120`; `dq-run.ts:49-82`; `dq-run-server.ts:84-134`; `dq-results.ts:1-30`; `dataset-schema.ts:187`).
- MCP: `define_quality_rules` → `addCheck`; `run_quality_checks` → counts via `queryRun`. **`sync_quality_to_catalog` does not exist in the tree.** Scheduled DQ is another chart CronJob POSTing `/api/data/dq/run-all`.

### 5. Dagster
- **Docs:** "loads the dbt project as assets and runs `dbt build`; spine for ingestion"; README "scheduled syncs and pipelines".
- **Code:** image = dagster 1.13.11 + dagster-dbt + dbt-trino; the **Postgres driver fix is present** (`psycopg[binary]`, `psycopg2-binary`). `repo.py` = `hello_sovereign` + one `dbt_assets` over the baked demo manifest; **no schedules, no sensors, no OS datasets** (`images/extensions/dagster/Dockerfile:8-24`; `repo.py:19-34`).
- **Chart:** official subchart 1.13.11, one user-code deployment `example-user-code`, CNPG `dagster` DB. Drift: user-code `TRINO_SCHEMA: analytics` vs dbt job `schema: sales`; the Admin UI claims Dagster `v1.9.1` (`values.yaml:712-780`; `profiles.yml:14-19`; `components-extra.ts:65`).
- **Runtime:** image tag still `0.2.0` while the Dockerfile changed 2026-10-29; whether the deployed image carries the driver, and whether any run ever completed, **needs the live cluster**.
- `list_dags` / `trigger_dag` / `get_dag_run` are the **Apache Airflow connector template**, unrelated to Dagster (`connections/lib/schema.ts:612-665`).

### 6. dbt
- **Docs:** "the single governed transform path"; README "transforms".
- **Code:** a demo project (seed `raw_orders` → `stg_orders` → incremental `daily_revenue`, merge on `order_date`) with `profiles.yml` targeting Trino `method: none`, `user: dbt-sales`.
- **Runtime:** dbt runs **once**, as a non-blocking `post-install` Helm hook, and on manual Dagster materialisation. **No OS dataset ever becomes a dbt model; nothing in os-ui invokes dbt** (`templates/extensions/dbt/dbt-build.yaml:24, 86-89`).
- History: Epic #146 (Forgejo `analytics` repo, `dbt.projectSource: git`) existed default-off; Forgejo is gone from values. Treat as retired.

### 7. Lineage, catalog, MCP surface
- `get_lineage` → `core/lineage/unified.ts` → registry-derived (built versions + `upstreams` + measures). No manifest.
- Catalog = registry ∪ `information_schema` of the caller's domain schema; "the OS registry is the system of record" (`catalog.ts:8-22`).
- Data MCP tools → `queryRun` / `ingestAndRegisterBronze` / `buildStage` → `executeRun` CTAS / `addCheck` / `reconcileSyncCron` / `runDatasetSync` / `os-sync-runs` (`core/mcp/experimental/data-write-tools.ts:233-860`).
- `docs/components/trino.md` does not exist. Licences: Trino, dbt Core, Dagster, Polaris Apache-2.0; MinIO AGPL-3.0 as the local stand-in.

**Net:** the README/docs rows for Dagster and dbt describe intent, not behaviour. Every transform, sync and quality check today is TypeScript-compiled SQL executed through query-tool as the acting principal; Dagster and dbt run a demo mart and nothing of the user's.

---

## Part II — Concept

### 0. Decisions
1. **A domain's data product is a dbt project in a git repo the OS owns.** The OS is generator, committer and reader. Users do not edit the repo from the UI; they read, export and mirror it.
2. **Git mechanism: isomorphic-git inside os-ui, bare repos on a PVC, a read-only `git daemon` sidecar for in-cluster consumers, optional push-mirror** (§2).
3. **One repo per domain; one Dagster code location for all domains** (§2.3 — changes the plan's implied per-domain code location).
4. **dbt-trino connects as a service user and impersonates the acting principal** (`impersonation_user`), so Trino→OPA governs the same identity the UI uses today. Role floors move from `execute_guard.py` into os-ui + OPA (§3).
5. **Commit first, validate second.** A failed `dbt parse` never reaches the running code location; Dagster keeps the last good commit; the failure is shown on the dataset.
6. **The OS keeps no run ledger.** Run state from Dagster GraphQL, test results from Dagster asset checks (dbt tests), lineage from the asset graph plus the repo's `schema.yml`.

### 1. Mapping: OS object → engineer artifact

| OS object | Artifact | Constraint from the code |
|---|---|---|
| Ingested Bronze (`iceberg.personal_<uid>.bronze_<slug>`, data-runner) | dbt **`source`** in `models/sources.yml`, `loaded_at_field` where present | Bronze stays PyIceberg-landed; dbt never writes Bronze. Not a seed. |
| Silver pass-through / guided clean | `models/silver/silver_<slug>.sql`, `materialized: table`, `+on_table_exists: replace` | Model name == physical table name, so the FQN is unchanged. |
| Gold / composition (`goldSpec`, `upstreams`) | `models/gold/gold_<slug>.sql` with `{{ ref() }}`; cross-domain product → `{{ source('<other_domain>', 'gold_<slug>') }}` | `compileGoldJoin` becomes the body generator with FQNs rewritten to `ref()`/`source()`. dbt Core has no cross-project `ref`; `source` is exactly the governance boundary `reuseSourceFqn`/`listJoinable` already enforce. |
| Personal-lane layers | Same models under `models/personal/<uid>/…`, `+schema: personal_<uid>`, a `generate_schema_name` macro returning the custom schema verbatim | Standard dbt practice. |
| Publish / promote (`publishPlan`) | The generator **moves** the model from `models/personal/<uid>/` to `models/<layer>/` in one commit, or emits a `materialized: view` model when `asView` | The materialisation run is launched with the approver's principal; no master key. |
| Quality `not_null` / `unique` / `accepted_values` | `schema.yml` column tests, 1:1 | |
| Quality `range`, `not_blank` | Generator-shipped **custom generic tests** `tests/generic/range.sql`, `not_blank.sql` with the predicates from `dq.ts:95-116` | Avoids `dbt_utils` → no `dbt deps` network at build. |
| Monitor freshness | `sources.yml` `freshness` on `_loaded_at`, run by Dagster as `dbt source freshness` | Only sources carrying `_loaded_at`. |
| Monitors volume / schema | **Dagster asset checks** over materialisation metadata and `information_schema` | dbt has no native volume/drift monitor; say so in docs. |
| Sync full-refresh | `materialized: table`, body `select * from {{ source(...) }}` of the federated catalog | |
| Sync append (cursor, 15-min lookback, `_batch_id`) | `materialized: incremental`, `incremental_strategy: 'delete+insert'`, `unique_key: '_batch_id'`, body adds `_loaded_at`, `_batch_id = '{{ var("os_batch_id") }}'`, `{% if is_incremental() %} where cursor > (select max(cursor) from {{ this }}) - interval '15' minute {% endif %}` | Exactly "delete the batch, re-insert the slice". Prefer `microbatch` (`event_time`, `batch_size`, `lookback: 1`) **if the image's dbt-trino ≥ 1.9**; verify in the image. |
| Sync merge | `incremental_strategy: 'merge'`, `unique_key: [mergeKeys]`, `+on_schema_change: append_new_columns` | What the demo mart already does. |
| Kafka offsets cursor | **Not a clean dbt model**: a Dagster Python asset renders the existing `kafkaAppendSql` shape via Trino | dbt has no per-partition watermark; do not fake it. |
| API-batch sources (Salesforce, Kajabi → data-runner) | Dagster **external-source asset** `src_<slug>` whose op calls the OS's governed slice executor over the runtime-bearer route | The only cross-process hop; os-ui resolves the owner identity as now. |
| Iceberg maintenance | dbt `post-hook` `ALTER TABLE {{ this }} EXECUTE optimize` on a weekly Dagster job | |
| Sync schedule (cron, UTC, missed-slot skip) | `os/schedules.yml` → `ScheduleDefinition(cron_schedule, execution_timezone="UTC")`, `RunRequest(tags={os/principal, os/dataset})`, selection `gold_<slug>+` | Dagster does not fire missed ticks unless catch-up is configured — matches today. |
| Quarantine after 10 errors | Dagster **run-failure sensor** pausing the schedule after N consecutive failures | Replaces `isQuarantined`. |

### 2. Git as the artifact store

**2.1 Decision and reasons.** isomorphic-git (MIT, pure JS) in os-ui, bare repo per domain on an RWO PVC `os-repos` mounted at `/repos`, a read-only `git daemon` sidecar (`alpine/git`, `--export-all --base-path=/repos`, port 9418, Service `os-repos`, NetworkPolicy allowing only the Dagster user-code pod), optional mirror push.
- *vs git CLI in the image:* os-ui is `node:22-alpine` without git; shelling out from Next routes adds a shell surface for user-controlled names. isomorphic-git commits **in-process under the governed dispatcher**, so the author is the `CurrentUser` with zero hop.
- *vs committing straight to a remote:* every Build would depend on GitHub/Forgejo availability; breaks laptop/offline and sovereignty. The remote is a **mirror**: push after each local commit; a failed push never fails the save; the UI shows "mirror behind by N".
- *PVC consistency:* os-ui runs `replicas: 1`, so one RWO writer is consistent with today's single in-process store; writes per repo serialised by an in-process mutex. If os-ui scales out, the writer moves to a `repo-writer` Deployment behind the same governed call.
- The repo contains no secrets (`profiles.yml` uses `env_var()`), so read-only in-cluster exposure is acceptable. git binary GPL-2.0 runs as a separate process from a stock image, not linked or shipped.

**2.2 Commit model.** Every mutating store op touching dataset/composition/check/sync (`buildVersion`, `setGoldSpecAndUpstreams`, `addCheck`/`removeCheck`, `setDatasetSync`, publish/promote, retire) calls `projectGit.commit(domain, user, {action, surface})`: regenerate the whole tree deterministically, write only changed blobs, commit **iff the tree hash changed**. Author `${user.name} <${user.email}>`; committer `Sovereign OS <os@<tenant>>`. Message `data(<domain>): <action> <dataset> — via <mcp:tool | ui:<route>>` with trailers `OS-Action`, `OS-Dataset`, `OS-Surface`, `OS-Request-Id`. The version record stores `commit: <sha>`. The same mechanism serves agent systems (`system.yaml`, `graph.ts`, README) under `agents/<system>/`.

**2.3 One repo per domain, one code location.** Domain repos follow the dbt project boundary, Trino resource groups per domain, OPA domain principals, and `listJoinable`'s rule that only products cross domains. A code location per domain would need a Helm entry and gRPC server each; instead one location `sovereign` whose `repo.py` enumerates `/repos-checkout/*/current/` and builds `dbt_assets` per project with a `DagsterDbtTranslator` key prefix `<domain>`. Isolation comes from per-domain parse gating.

**2.4 Picking up a commit without breaking schedules.** A `repo-sync` sidecar on the Dagster user-code Deployment (same sovereign image, `git` added) shares an `emptyDir` `/repos-checkout`: every 15 s fetch each `git://os-repos/<domain>.git`; on a new `main` sha, `git worktree add /repos-checkout/<domain>/<sha>`; run `dbt parse` there; **success** → atomically repoint `current → <sha>`, write `status.json`, call GraphQL `reloadRepositoryLocation("sovereign")`; **failure** → leave `current`, write `status.json {head, lastGood, error}`. os-ui reads `/status` and shows on the dataset: "commit `abc123` failed `dbt parse`: … — schedules still run `def456`". Broken commits stay in history; the gate is deployment, as in any CI.

**2.5 User read access.** `GET /api/data/projects/<domain>` (tree, log, blob at ref) via isomorphic-git; `export` = tar at a commit; admin-only `mirror` config (URL + token Secret) → push after each commit.

### 3. Execution path
Build (UI) or MCP `transform_silver` / `build_gold_join` / `define_quality_rules` / `set_dataset_sync`: `handleRpc(user)` → store mutation (canEdit, role floors) → **generate + commit** → return `{commit}` → `repo-sync` validates → os-ui calls Dagster GraphQL `launchRun` (new `core/infra/dagster.ts`) with selection `<domain>/gold_<slug>+` and tags `os/user`, `os/action`, `os/commit`, `os/dataset`, plus `dagster-k8s/config` setting `OS_PRINCIPAL` → run pod executes `dbt build --select …` from `current/` → os-ui polls `runOrError`, stores `{runId, commit}`.

**Principal.** `profiles.yml`: `user: dbt-runner`, `password: {{ env_var('TRINO_PASSWORD') }}`, **`impersonation_user: "{{ env_var('OS_PRINCIPAL') }}"`**. Domain models run as the domain principal; personal-lane models and owner-run syncs as the owner uid. `dbt-runner` is impersonation-only; OPA grants it `ImpersonateUser` and nothing else. No master key.

**What dbt-trino bypasses, and how each gate is re-homed:**
- `execute_guard.py` statement allowlist → dbt executes only SQL the OS generated from structured specs; once `/execute` is deleted there is no free-text SQL entry point, so the shape check lives in the generator's tests.
- `execute_guard.py` role floor → os-ui enforces the builder floor before generating/launching; **OPA's write floor becomes authoritative**: add `principal.role` to governance data and require `role ∈ {builder, domain_admin, admin}` for non-`personal_` schemas. Row filters, masks and the `personal_*` deny apply unchanged because the impersonated session user is the same identity.

### 4. Read-back

| Need | Source | Replaces |
|---|---|---|
| Run status/history per dataset | GraphQL `runsOrError(filter:{tags:[{key:"os/dataset"}]})`, `runOrError` | `os-sync-runs`, version-record flags |
| Test results | `assetChecksOrError` / `assetCheckExecutions` (dagster-dbt maps each dbt test to an asset check) | `os-dq-results`, `runQualityChecks` |
| Lineage | `assetNodes{assetKey dependencyKeys}` + `schema.yml` descriptions via isomorphic-git | `lineageFor` for datasets (kept only for metric/dashboard edges) |
| Freshness / last sync | `assetMaterializations(limit:1)` | `latestSyncRun`, Monitoring `lastSync` |
| Watermark | `select max(cursor) from {{ this }}` | `currentWatermark` |
| Project state | `repo-sync /status` + `GET /api/data/projects/<domain>` | — |

MCP returns the same shapes; `get_dagster_run` → `{runId, status, startedAt, endedAt, assets[], checks[]}`; `get_lineage` keeps `{nodes, edges}`, nodes gain `commit` and `model`.

### 5. Phases B1–B4

**B1 — dbt project generation + git store** (no runtime change; flag `DATA_PROJECT_GIT`).
- `tabs/data/lib/dbt/`: `project.ts` (dbt_project.yml, profiles.yml with `env_var()` only, `generate_schema_name`, generic tests), `sources.ts`, `models.ts` (reuses `compileGoldJoin`/`silverPlan` bodies with a FQN→`ref()/source()` rewriter), `schema.ts` (checks → tests, docs → descriptions), `schedules.ts` (`os/schedules.yml`). Byte-stable; a test asserts two regenerations give an identical tree hash.
- `tabs/data/lib/git/`: isomorphic-git wrapper (`openOrInit`, `commitTree`, `log`, `readBlob`, `archive`, `push`), author from `CurrentUser`, message/trailer builder. Shared with agents via `@core/infra/git-store` if both tabs need it (kernel must not import a tab).
- Chart: PVC `os-repos`; `git-daemon` sidecar + Service + NetworkPolicy; `repo-sync` sidecar on the Dagster user-code Deployment; `git` in `images/extensions/dagster/Dockerfile`; fix `TRINO_SCHEMA` drift.
- Hook every mutating store op to commit (behind the flag). Golden-file tests for three shapes (ingested pass-through; two-dataset composition with tests; append sync).
- **Gate:** repo gates; generated project passes `dbt parse` in the sidecar on kind; a composition's model body string-equals today's `compileGoldJoin` SELECT after FQN substitution (pure test). Docs: `docs/components/dbt.md` rewritten honestly.

**B2 — Dagster as the scheduler.**
- Confirm the driver live; bump the image tag. `repo.py` → multi-project loader + schedules from `os/schedules.yml` + failure sensor (quarantine) + maintenance job; `core/infra/dagster.ts` GraphQL client; Data tab run history and Monitoring read Dagster. `set_dataset_sync` stops calling `reconcileSyncCron` when the flag is on.
- **Gate:** a scheduled sync materialises through Dagster in kind under the owner principal; the OS shows the Dagster run id. **Delete:** `sync-cron.ts`, `sync-next-run.ts`, `/api/data/sync-due`, `data-sync-cronjob.yaml`, `dq-cronjob.yaml`, `/api/data/dq/run-all`.

**B3 — Trino as the engine, lineage from dbt.**
- `profiles.yml` with `impersonation_user`; OPA `ImpersonateUser` for `dbt-runner` and the role-aware write floor; incremental configs per the mapping; `post-hook` maintenance. Lineage view and `get_lineage` read the asset graph + `schema.yml`.
- **Gate (kind):** parity — the same composition via old CTAS and via `dbt run` yields identical row sets (`EXCEPT ALL` both ways = 0) and identical `DESCRIBE`; a re-run append yields no duplicates. **Delete:** query-tool `/execute` + `execute_guard.py` (keep `/query`), the dbt/dbt-trino Build adapters and their clients, `sync-sql.ts` executor use (keep the Kafka builders as the Python asset's template), `sync-run-server.ts`, `sync-runs.ts`, `dq-run*.ts`, `dq-results.ts`, `auto-pipeline.ts` (becomes commit + launch), the dbt demo project and `dbt-build.yaml` hook.

**B4 — MCP, docs, deletion.**
- Tools on the same governed path: `dbt_run {datasetId|select}`, `dbt_test`, `dagster_materialize {assetKeys}`, `get_dagster_run {runId}`, `get_lineage` (kept), `get_project {domain, ref?}` (tree/log/export), `set_project_mirror` (admin). Old names become aliases for one release, then go.
- Docs: `docs/components/{dagster,dbt}.md` real flow; **create `trino.md`**; `tabs/data/README.md` MCP list; `os-ui/ARCHITECTURE.md` "a data product is a dbt project in a git repo the OS owns"; README rows corrected; Admin's Dagster version string fixed.

### 6. Risks and open questions
- dbt-trino incremental on Iceberg: `merge` and `delete+insert` supported; `microbatch` needs dbt-trino ≥ 1.9; `on_table_exists: replace` needs ≥ 1.8. Pin and test in the image.
- Watermark timing: `max(cursor) from {{ this }}` vs today's pre-probed high-watermark; Trino snapshot isolation decides; document it.
- Dagster image tag not bumped; deployed state unknown; the Files tab targets a non-existent job.
- `reloadRepositoryLocation` reloads the whole location; parse per domain in parallel and reload only on change.
- `TRINO_PASSWORD` only in the Dagster run pod env; on STACKIT verify the Trino OPA plugin exposes `ImpersonateUser`.
- A deactivated owner's scheduled personal sync must be **paused** by a sensor (today refused per run).
- Concurrency: Dagster run queue with `tag_concurrency_limits` on `os/dataset` = 1 replaces the lease.
- Git: RWO means one writer; mirror pushes report, never block; confirm every `CurrentUser` has an e-mail.
- Licences: dbt Core, Dagster, Trino, dagster-dbt, dbt-trino Apache-2.0; isomorphic-git MIT; git GPL-2.0 as a separate process; MinIO AGPL dev-only.
- Needs the live system: Dagster run history and driver, kind parity, `dagster-k8s/config` env propagation.

### 7. Worked example — composition `gold_order_customer` (domain `sales`)
Alex composes shared Silver `orders` and `customers` (inner join on `customer_id`, measure `sum(amount)`), adds `not_null(customer_id)`, schedules daily 06:00 UTC via MCP.

```
repo: /repos/sales.git   branch: main
commit 7f3a9c2
Author:    Alexander Borek <alex@datamasterclass.com>
Committer: Sovereign OS <os@tenant>

    data(sales): build gold order_customer — via mcp:build_gold_join

    OS-Action: build_gold_join
    OS-Dataset: ds_9kq2 (order_customer)
    OS-Surface: mcp:build_gold_join
    OS-Request-Id: req_01HX…

 models/gold/gold_order_customer.sql | 12 +
 models/gold/schema.yml              |  9 +
 os/schedules.yml                    |  5 +
```

```yaml
# dbt_project.yml (once per repo)
name: sales
profile: sovereign
models:
  sales:
    silver: {+materialized: table, +on_table_exists: replace}
    gold:   {+materialized: table, +on_table_exists: replace}
```
```yaml
# models/sources.yml
sources:
  - name: personal_alex
    schema: personal_alex
    tables: [{name: bronze_orders}, {name: bronze_customers}]
```
```sql
-- models/silver/silver_orders.sql
select * from {{ source('personal_alex', 'bronze_orders') }}
```
```sql
-- models/gold/gold_order_customer.sql  (body = today's compileGoldJoin, FQNs → ref)
select
  t0.customer_id,
  t1.customer_name,
  sum(t0.amount) as total_amount
from {{ ref('silver_orders') }} t0
inner join {{ ref('silver_customers') }} t1 on t0.customer_id = t1.customer_id
group by t0.customer_id, t1.customer_name
```
```yaml
# models/gold/schema.yml
models:
  - name: gold_order_customer
    description: "Orders joined to customers (OS composition ds_9kq2)."
    columns:
      - name: customer_id
        tests: [not_null]
```
```yaml
# os/schedules.yml
- dataset: ds_9kq2
  select: "gold_order_customer+"
  cron: "0 6 * * *"
  principal: sales
```
```python
# repo.py (generated loader, excerpt)
for dom in domains():                                   # /repos-checkout/<dom>/current
    @dbt_assets(manifest=dom.manifest, dagster_dbt_translator=Prefixed(dom.name))
    def _assets(context, dbt: DbtCliResource):
        yield from dbt.cli(["build"], context=context).stream()
    for s in dom.schedules:                             # os/schedules.yml
        defs.append(ScheduleDefinition(
            name=f"{dom.name}__{s.dataset}", cron_schedule=s.cron, execution_timezone="UTC",
            job=define_asset_job(f"{dom.name}__{s.dataset}", selection=s.select),
            tags={"os/dataset": s.dataset, "os/principal": s.principal,
                  "dagster-k8s/config": {"container_config": {"env": [{"name": "OS_PRINCIPAL", "value": s.principal}]}}}))
```

What happens: `repo-sync` sees `7f3a9c2`, `dbt parse` passes, `current → 7f3a9c2`, the location reloads; os-ui launches a run for `sales/gold_order_customer` as `OS_PRINCIPAL=sales`; dbt-trino impersonates `sales`; Trino→OPA governs the two reads and the CTAS into `iceberg.sales.gold_order_customer`; the `not_null` test becomes an asset check; the Data tab shows commit `7f3a9c2`, the run id, the check, and the next tick, all read from Dagster and the repo, none from an OS ledger.
