# Scheduled sync at scale — honest limits & the scale-up playbook

**Question:** can the scheduled-sync mode handle larger data volumes, what are its current
limits, and what cluster setup overcomes them?

**Short answer:** yes for its design point — *incremental slices* of warehouse tables, up to
roughly a few hundred thousand rows / tens-to-low-hundreds of MB per run. The ceiling is **not**
os-ui (the slice is a Trino `INSERT INTO … SELECT`; data flows engine-to-engine). The binding
constraints today are, in order: a **hard-coded 15 s client timeout per statement**, a
**single-node Trino** (6 GB heap / 2 GB query memory, spill on), the **source connector's read
parallelism**, and a **20 Gi MinIO volume** as the entire lakehouse. Each has a concrete fix
below.

Verification legend used throughout:
**[measured]** = read from the live cluster (`agentic-os` ns, 2026-07-26) ·
**[config]** = derived from chart/code in this repo ·
**[estimate]** = industry rule-of-thumb, not benchmarked on this cluster.

---

## 1. The execution path and where it can break

One sync run (`os-ui/lib/data/sync-run-server.ts` → `executeRun` in
`os-ui/lib/infra/governed.ts` → query-tool `/execute` → Trino) is a handful of statements:
watermark probe (`SELECT max(cursor)`), then per mode: full-refresh `CREATE OR REPLACE TABLE
… AS SELECT`; append `DELETE by _batch_id` + `INSERT INTO … SELECT` with a pushed-down cursor
window; merge staging-CTAS + `MERGE` + `DROP`. The query-tool does **not** buffer sync data:
for writes the Trino response is just a row count (`run_execute` drains it,
`images/query-tool/app.py`), and the rows themselves move Trino↔source↔MinIO. os-ui only
orchestrates.

The timeout chain **[config]**:

| Stage | Limit | Where |
|---|---|---|
| Watermark probe / DESCRIBE (`queryRun`) | **8 s** HTTP abort | `governed.ts` `withTimeout(…, 8000)` |
| Each write statement (`executeRun`) | **15 s** HTTP abort — **the binding limit** | `governed.ts` `withTimeout(…, 15000)` |
| query-tool → Trino | none (polls to completion) | `images/query-tool/app.py` |
| CronJob trigger curl | 300 s `--max-time` | `os-ui/lib/data/sync-cron.ts` |
| CronJob Job | `activeDeadlineSeconds: 900`, `backoffLimit: 1`, `concurrencyPolicy: Forbid` | `sync-cron.ts` |
| Lease TTL | 60 min (`SYNC_LEASE_TTL_MS`) — irrelevant in practice; the 15 s statement cap binds ~240× sooner | `sync-run-server.ts` |

**The failure mode of an oversized slice** is worth being honest about: os-ui aborts its HTTP
call at 15 s, but query-tool and Trino keep running the statement to completion. The run is
recorded `error` and the cursor does **not** advance. For full-refresh and merge that is
self-healing (replace / by-key). For **append**, if the statement later *succeeds* server-side
and the source's high watermark has moved before the retry, the retry computes a *different*
`_batch_id` — the idempotency delete misses the orphan batch and the lookback window re-covers
its rows → **duplicates are possible**. Keep append slices comfortably inside 15 s, or use
merge for anything near the edge. **[config — traced, not reproduced live]**

Sync v1 covers **warehouse connections only** (`template === 'warehouse'`, federated Trino
catalogs: Glue/Athena, Snowflake, BigQuery, Databricks, Fabric). File/API sources go through
the separate data-runner path (§3).

## 2. Live cluster sizing **[measured]**

Single-node STACKIT SKE cluster: **1 × m3i.16** (16 vCPU, ~116 Gi RAM). All replicas = 1.

| Component | Requests | Limits | Live usage | Notes |
|---|---|---|---|---|
| Trino | 1 CPU / 2 Gi | 4 CPU / **8 Gi** | 5.2 Gi | coordinator-as-worker, `replicas: 1` **hard-coded** in `charts/…/lakehouse/trino.yaml` |
| MinIO | 100m / 256 Mi | 1 CPU / **768 Mi** | 659 Mi (86 % of limit) | **20 Gi PVC** `minio-data` (premium-perf1-stackit) = the whole lakehouse |
| query-tool | 100m / 256 Mi | 1 CPU / 768 Mi | 43 Mi | |
| data-runner | 100m / 256 Mi | 1 CPU / **1 Gi** | 52 Mi | file/API ingest path |

Live Trino config (`trino-config` ConfigMap) **[measured]**: `-Xmx6G`,
`query.max-memory=4GB`, `query.max-memory-per-node=2GB`, `spill-enabled=true`,
`spiller-spill-path=/data/trino/spill` — but the spill path is an **emptyDir** (node ephemeral
disk), so spill capacity is node-disk-bound and not survivable across pod moves. Resource
groups **[config]**: per-domain `hardConcurrencyLimit: 3`, `maxQueued: 20`, soft memory 30 %;
root 100 / 80 %. No per-dataset `data-sync-*` CronJobs exist on the live cluster yet (no
schedules saved), and the fallback sweep (`dataSync.sweep.enabled`) is off — the live cluster
has **zero measured sync throughput history**; everything in §3 is therefore config-derived or
estimated.

## 3. Current practical limits

| Limit | Current value | Binding constraint | Status |
|---|---|---|---|
| Max slice duration | **~15 s** wall clock per statement | `executeRun` timeout (code constant, not a values key) | [config] |
| Max append slice, parallel source (Iceberg/Glue) | ~0.5–5 M narrow rows ≈ 50–500 MB | what single-node Trino moves in 15 s (~10–50 MB/s federated read + Iceberg/MinIO write) | [estimate] |
| Max append slice, JDBC source (Snowflake JDBC, Postgres) | ~50–500 k rows ≈ 10–100 MB | JDBC connectors read a table as **one split / one connection** → network-bound, not memory-bound | [estimate] |
| Max merge slice | smaller than append (staging CTAS + MERGE = 2 heavy statements, each <15 s; MERGE is merge-on-read) | same timeout + delete-file accumulation | [config+estimate] |
| First-run backfill / full refresh | same 15 s → roughly the same caps as one slice; a multi-GB table **will not** sync in one run | `watermark == null` ⇒ `cursor <= HW` covers the whole table in one statement | [config] |
| Query memory | 2 GB per node / 4 GB query, spill on → memory rarely the binder for INSERT-SELECT; matters for wide MERGE joins | `trino.query.*` | [measured] |
| Total lakehouse size | **20 Gi** (minus Langfuse/MLflow/files sharing MinIO) | `minio-data` PVC; also MinIO memory at 86 % of its 768 Mi limit | [measured] |
| Concurrent syncs | 3 per domain queued at Trino; **effectively ~1 in flight** — query-tool executes blocking Trino calls on its async loop, serialising concurrent statements; plus one lease per dataset | resource groups + `images/query-tool/app.py` | [config] |
| Rows/hour sustained | order of **1–10 M rows/h** per domain if slices are sized inside 15 s and scheduled minutely–hourly | statement cap × serialisation | [estimate] |
| File/API path (Salesforce & friends) | one file ≤ **200 MB** (`UPLOAD_MAX_BYTES` + ingress `proxy-body-size: 200m`), and it must fit in Arrow in a **1 Gi** data-runner (rule of thumb: RAM ≈ 2–5× CSV size → practically ~100–200 MB) + source API quotas (e.g. Salesforce daily REST/Bulk caps) | os-ui buffers uploads; data-runner materialises DuckDB→Arrow in memory | [config+estimate] |
| Small files | hourly append = 24 files+snapshots/day/dataset; `optimize` + `expire_snapshots` run at most **every 24 h** per dataset, only after a successful run | `MAINTENANCE_INTERVAL_MS` | [config] |
| Failure budget | 10 consecutive errors → auto-quarantine (manual "Sync now" resumes) | `sync-runs.ts` | [config] |

## 4. Scale-up playbook

Ordered by leverage. Values keys are for `charts/sovereign-agentic-os/values.yaml` unless noted.

1. **Raise the 15 s statement timeout** — the cheapest 10–40× on slice size, but it is a
   **code change, not a values key**: the `15000` (and probe `8000`) in
   `os-ui/lib/infra/governed.ts` (`executeRun`/`queryRun` `withTimeout` calls). Keep it well
   under the lease TTL (60 min) and the CronJob's 300 s curl / 900 s deadline (raise those in
   `sync-cron.ts` in step). This also closes the append-duplicate window in §1.
2. **Vertical Trino** (the only horizontal-free option the chart supports today —
   `replicas: 1` is hard-coded; the single-pod design is deliberate, cross-node exchange was
   broken on SKE-in-an-SNA): raise `trino.jvm.maxHeap` (e.g. `24G`), `trino.query.maxMemory`
   (`16GB`), `trino.query.maxMemoryPerNode` (`12GB`; keep ≤ ~70 % of heap), keep
   `trino.query.spillEnabled: true`, and raise `trino.resources` (e.g. requests 4 CPU/16 Gi,
   limits 8 CPU/32 Gi). The m3i.16 node has ~116 Gi — headroom exists **[measured]**. For
   durable spill under big merges, replace the `data` emptyDir with a PVC (template change in
   `trino.yaml`). True horizontal workers require adding a worker Deployment to the chart —
   not a values flip; plan it as a chart feature plus an SKE node pool with working pod-to-pod
   exchange.
3. **Object storage**: for anything beyond demo scale, stop growing MinIO and switch to
   managed storage — `objectStorage.mode: external` + `objectStorage.external.endpoint`
   (STACKIT Object Storage) removes the 20 Gi PVC, the 768 Mi MinIO memory limit and the
   single-writer pod in one move. Interim: raise `objectStorage.persistence.size` (currently
   20 Gi in `values.stackit-selfhosted.yaml`) and `objectStorage.resources`.
4. **Bound big backfills** instead of raising limits: do the initial load as slices. The
   cursor mechanics already support it — the slice is always `watermark → HW`, so seed the
   watermark (or land history via a one-time import with a `WHERE` window) and let scheduled
   runs walk forward; operationally, run "Sync now" repeatedly with a temporarily **tighter
   window** (e.g. import `cursor <= T0`, then sync from T0). Never point a fresh append sync
   at a multi-GB table and let the first run take everything.
5. **Concurrency**: raise `trino.resourceGroups.perDomainHardConcurrency` / `maxQueued` only
   after fixing the real serialiser — query-tool's blocking Trino calls (move them off the
   event loop or run >1 replica; `queryTool.resources` is not the issue at 43 Mi live).
6. **High-frequency pipelines**: for minutely appends or daily merges, tighten the
   maintenance cadence (`MAINTENANCE_INTERVAL_MS`, `sync-run-server.ts`; retention in
   `expireSnapshotsSql`, default `7d`) so `optimize` compacts small files and merge
   delete-files before reads degrade. Prefer **append** for high frequency; keep **merge**
   daily-ish (it is merge-on-read by design — see `sync-sql.ts` cadence note).
7. **Giant sources → staged-file loads**: when a source can't be read fast enough federated
   (JDBC single-split, API-quota-bound like Salesforce), export to Parquet on object storage
   and load via data-runner `/ingest mode=append` instead of federated SQL. To scale that
   path: `dataRunner.resources` (memory ≈ 2–5× file size), plus the coupled trio
   `UPLOAD_MAX_BYTES` (os-ui env) + ingress `proxy-body-size` + os-ui memory — GB-scale files
   need presigned direct-to-bucket upload (not built yet). Streaming Arrow writes in
   data-runner would lift the in-memory ceiling.

### Sizing table

| Tier | Practical slice | Values to set |
|---|---|---|
| **Small (default, today)** | ~10–100 MB / ≤ ~0.5 M rows per run, ≤ ~20 Gi total | none — as shipped (`maxHeap 6G`, `maxMemory 4GB/2GB`, spill on, MinIO 20 Gi) |
| **Medium** | ~0.5–2 GB per run, low-hundreds of GB total | code: `executeRun` timeout → 300 s; `trino.jvm.maxHeap: 24G`, `trino.query.maxMemory: 16GB`, `trino.query.maxMemoryPerNode: 12GB`, `trino.resources` limits 8 CPU/32 Gi; `objectStorage.mode: external` (STACKIT Object Storage); `dataRunner.resources` limits 2 CPU/4 Gi |
| **Large** | multi-GB slices, TB-scale lakehouse | all of Medium **plus**: chart work — Trino worker Deployment (coordinator `node-scheduler.include-coordinator=false`) on a dedicated SKE node pool (e.g. 3 × m3i.8, memory-optimized, verify cross-node pod networking first), PVC-backed spill, staged-file loads for API sources, maintenance cadence ≤ 6 h | 

All "Medium/Large" numbers are **[estimate]** — no load test has been run on this cluster;
treat them as planning figures and validate with one representative backfill before
committing to an SLA.
