# Plan: data ownership for Dagster, dbt and Trino

Date 2026-11-22. Basis: `public/main` at 6feaa01e. Paths are under `os-ui/` unless noted. Nothing here is deployed.

**Rule.** Each object type has one owner and one writer. The other side reads live, or reconciles and raises a drift alert. The platform team may work directly in the native tool, and what they do must show up in the OS.

| Object | Owner (writer) | OS role |
|---|---|---|
| dbt models, tests, sources | git (engineers, in their own lane); the OS only its OS-owned generated files | Reads the dbt verdict and manifest from repo-sync |
| Dagster runs, backfills, schedule and sensor pause state | Dagster (platform team, Dagster UI) | Reads live over GraphQL; never writes pause state |
| Which assets and schedules exist | git (OS-generated plus the engineer's own lane code) | Dagster loads them through the code-server reload |
| Trino catalogs and connectors | Trino and the chart (platform team) | Reads `system.metadata.catalogs` live |
| Tables created directly in Trino | Trino | Discovers them, offers registration, alerts on unregistered ones |
| Access rights | OS, through OPA only | Detects and alerts when a Trino-side rule diverges |
| Quality rules and their results | dbt tests in git; results are Dagster's check executions | Writes the rules as dbt tests; reads results live; evaluates nothing itself |

## 1. Current state, with evidence

### Dagster
- **The OS writes Dagster in exactly three ways.** Launch (`core/infra/dagster.ts:181`), reload of the code location (`:378`) and stop of a schedule or sensor (`:474`). `stopInstigator` has one caller, the domain-delete cleanup (`core/kernel/domain-delete-components.ts:127`). Nothing starts or resumes a schedule. The OS does not fight Dagster's pause state today, but no test says it must stay that way.
- **Schedule state is read live for one dataset.** `nextTick` (`core/infra/dagster.ts:392`) returns RUNNING or STOPPED. `syncStatusFor` turns "enabled in the OS and STOPPED in Dagster" into `quarantined` (`tabs/data/lib/sync-status-server.ts:238`).
- **The wording is wrong when a person paused it.** The panel says "Paused after N consecutive failures ... press Sync now to resume" (`tabs/data/ui/SyncPanel.tsx:267`). With Dagster as the scheduler a manual sync does not restart the schedule, and a platform engineer who paused the schedule in the Dagster UI is told it failed. Gap G-D1.
- **Monitoring reads runs only.** `collectPipelines` calls `recentOsRuns(25)` (`tabs/monitoring/lib/adapters/pipeline-health.ts:72`). No schedule or sensor state, so a schedule a person paused for days shows nowhere. Gap G-D2.
- **Failure state is read live.** Run status comes from `runsOrError` (`core/infra/dagster.ts:262`), and failed runs show red (`pipeline-health.ts:34`).
- **Reload.** repo-sync polls and Dagster reloads the code location (#267, `images/extensions/dagster/tests/image/code-server-reload.sh`). The generated and lane-owned definitions arrive without an OS write.

### dbt
- **A push is ingested.** A model or `schema.yml` pushed through the OS git server becomes a dataset record (`tabs/data/lib/dbt/ingest.ts`, registered with `core/infra/git-receive.ts`). `config.meta.os_dataset` is the identity the OS wrote; a model without it is created in the OS.
- **Lineage comes from Dagster's asset graph** (`tabs/data/lib/lineage-server.ts`, `assetGraph`), so a model committed in git appears after the reload.
- **The dbt verdict is stored and never shown.** repo-sync's `dbt parse` verdict is copied into `os_governance.commit_checks` (`core/adapters/dagster/commit-checks.ts:24`, started at `instrumentation.ts:183`). No code reads that table (grep: only the writer and the migration). A commit that dbt refused leaves Dagster on the last good commit, and the engineer sees nothing in the OS except the generic "has not loaded" sentence (`sync-status-server.ts:139`), without dbt's own error text. Gap G-B1.
- **`repoManifest` has no consumer** (`core/adapters/dagster/graphql-read.ts:93`). WP-16 recorded this as not done. It is out of scope here because the verdict, not the manifest, is what an engineer needs first. Recorded as G-B2.
- **Asset colours come from Dagster checks** (`graphql-read.ts:119`), which map dbt tests one to one.

### Trino
- **Catalogs.** The OS mounts a catalog when a warehouse connection is registered (`tabs/connections/lib/warehouse/k8s-registration.ts`). Nothing reads `system.metadata.catalogs`; the only reads are `SHOW SCHEMAS FROM <catalog>` for catalogs the OS itself registered (`tabs/connections/lib/warehouse/catalog-snapshot.ts:238`). A catalog the platform team adds in the chart is invisible, and a catalog the OS thinks it mounted but that is gone is not flagged. Gap G-T1.
- **Tables.** The reconcile sweep (`tabs/data/lib/reconcile.ts`) goes registry to physical: it probes registered domain tables and rebuilds missing ones. The other direction does not exist: a table created directly in a domain schema is never listed or flagged. Gap G-T2.
- **Access.** The OS writes `trino-access-rules` from membership (`core/infra/trino-rules-server.ts:65`), chained after OPA. The periodic pass overwrites any other content (`:21-23`) and records only "written" or "unchanged". An overwrite of someone's hand edit is silent. Gap G-T3. The OS issues no `GRANT` or `REVOKE` today, and nothing enforces that.

### Quality rules (owner report, 2026-11-22)
The report said rules run only by hand and Monitoring never shows them. Read in code, that is **not true on production**, where `DATA_PROJECT_GIT=true` (read-only `kubectl get deploy os-ui`). What is true, with evidence:
- **Rules are dbt tests.** `checkToTest` maps not_null, unique, not_blank, accepted_values, range and reference to `data_tests` in the OS-owned `schema.yml` (`tabs/data/lib/dbt/schema.ts:57-103`). Free-text intentions and a reference to a model not in the project stay "intentions" and are never run (`schema.ts:57`). Gap G-Q3.
- **Scheduled runs evaluate them.** The dbt assets run `dbt build` (`images/extensions/dagster/repo.py:475`), so every scheduled materialization runs the tests as Dagster asset checks. Proof: `lakehouse.sh` section 2b (below).
- **The read-back is Dagster's.** With the flag on, `latestDqRun` maps `assetChecks` to the quality record (`tabs/data/lib/dq-status-server.ts:153`); Monitoring's `/api/monitoring/data-quality` and the dataset detail use it. The TS compiler (`dq.ts`, `dq-run.ts`) is only the labelled `source: 'os'` fallback before any dbt test ran, and the body of the manual "Run checks" / `run_quality_checks`.
- **Gaps found.** G-Q1: a dbt test with `severity: warn` was shown as a hard fail, and the per-rule severity and timestamp that Dagster returns were dropped (`checkToResult`). G-Q2: the owner alert fired only when someone read the quality (`alertOnNewFailure` is called from the read functions), never on the schedule. G-Q3: intentions never run, and the manual "Run checks" is still an OS-side evaluator. G-Q4: freshness, volume and schema monitors are absent with the flag on.
- **Where per-rule results land for Monitoring.** `DatasetDetail.checks[]` (`tabs/monitoring/lib/detail-view.ts`): per rule `id, label, verdict (pass|warn|fail|not_run), violations (dbt failed row count), severity, at (Dagster execution time)`; roll-ups in `DqSummary` and `DatasetTelemetry.checksWarning`. No OS store: it is read live from Dagster.
- **PR Q (`own/dq-dagster`)** closes G-Q1 and G-Q2, with a real-container proof (a seeded NULL row fails the not_null test in the schedule's job and Dagster's check says FAILED, failed_row_count 1). G-Q3 and G-Q4 are follow-ups: removing the manual evaluator needs a check-only Dagster job (`AssetSelection.checks_for_assets`) launched through `launchRun`, which is a separate, larger change.

## 2. Gaps and phased PRs

Each PR is independent, has red-first tests plus a negative twin, and ships behind no flag unless noted (all are read-only or alert-only).

| PR | Closes | Change | Proof |
|---|---|---|---|
| P1 `own/dbt-verdict` | G-B1 | Read `commit_checks` (`dbt-parse`) for each domain head. A failed head raises a Monitoring alert with dbt's text. The sync panel names it. | Unit twins; real postgres for the SQL; repo-sync container where a harness exists |
| P2 `own/dagster-state` | G-D1, G-D2 | Read all schedule and sensor states live. Monitoring shows paused schedules and stopped failure sensors. The panel says "paused in Dagster, resume it there". A test pins the three write mutations. | Unit twins; real dagster-webserver (`tests/dagster/up.sh` harness) if the image builds |
| P3 `own/trino-catalogs` | G-T1 | Read `system.metadata.catalogs`. Platform shows them as data sources. Alert on catalogs without an OS connection and the reverse. | Real Trino 476 (`tests/lakehouse/up.sh`) |
| P4 `own/trino-unregistered-tables` | G-T2 | List tables in domain schemas not in the registry. Alert, with the existing adopt route as the offer. | Real Trino with a hand-made table |
| PQ `own/dq-dagster` | G-Q1, G-Q2 | A dbt warn is a warn; severity and time kept; periodic read-back alerts the owner | Real Trino + dagster-dbt (`lakehouse.sh` 2b) |
| P5 `own/access-drift` | G-T3 | The periodic rules pass detects foreign content and raises an alert. A guard test forbids `GRANT`/`REVOKE`/`CREATE ROLE` in os-ui. | Unit twins; real Trino with the rules file |

Not planned as a PR: G-B2 (consumers for `repoManifest`), the F4 query-log detective, and OPA bundle drift (already handled by `core/policy/opa-reconcile.ts`).

## 3. Rollback and risks
- Every PR adds reads and alerts only. Rollback is a revert; no data migration.
- Alerts must never describe a platform engineer's deliberate action as a fault. Paused schedules and extra catalogs are information; refused commits and foreign access rules are warnings.
- A Dagster or Trino outage must read as "unknown", never as zero findings.
