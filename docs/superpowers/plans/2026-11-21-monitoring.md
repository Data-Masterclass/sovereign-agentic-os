# Monitoring tab: Agents · Data · Platform panels (2026-11-21)

Goal: the Monitoring tab is the first place an operator, an agentic engineer and a data engineer
look. Every number on it is read from the component that owns it, through that component's own
documented API. The OS adds identity, scope and layout — never a re-implementation and never a
placeholder number. Where a component does not offer a signal, the panel says "not available
upstream" and why.

## Scope rule (all panels)

One rule, the one the rest of the OS already uses:

- **Agents** — the systems come from the Agents store's own scoped list
  (`agentHealthRows(principal)`, My · Domain · Company). Every upstream read is narrowed to those
  systems *in the request*: the run-store SQL carries the same `visibleTo` WHERE as `list_runs`,
  the Langfuse metrics query filters `sessionId any of [system:<id>…]`, the VictoriaLogs query
  filters `input.principal` to the systems' principals (`os-<id>`, `os-<id>:<node>`), LiteLLM keys
  are matched by alias `os-<id>` for in-scope systems only. Out-of-scope data is never fetched.
- **Data** — the datasets come from the Data store's scoped list (`listDatasets(principal)`).
  Dagster runs are kept only when their `os/dataset` tag is an in-scope dataset; asset checks and
  downstream assets only for the asset keys of in-scope datasets.
- **Platform** — tenant/cluster signals: admin only (the same `cluster: true` rule as today's
  system lens). A non-admin asking for it gets 403.

No new data path bypasses governance: the route is `withRoute` (session) and the MCP tool calls
the same function with the caller's identity.

## Panels → upstream API → scope

### Agents (per agent system)

| Panel | Upstream API (exact) | Notes |
|---|---|---|
| Runs over time (14 days, per day: done · failed · held for approval · other) | Postgres `run_jobs` + latest `run_events` `done` frame — the agent engine's own run store (os-ui *is* the LangGraph engine host). `SELECT date_trunc('day', created_at) …` with the `listRuns` scope predicate | The outcome rule is `runListStatusOf` (the same word `list_runs` shows) expressed in SQL |
| p50 / p95 latency, traces, tokens (7 days) | Langfuse Metrics API v1 `GET /api/public/metrics?query={view:"traces", dimensions:[{field:"sessionId"}], metrics:[count, latency p50, latency p95, totalTokens sum, totalCost sum], filters:[sessionId any of …]}` | Langfuse computes the percentiles; a run's session is `system:<id>` (05 §5.2) |
| Cost | LiteLLM `GET /key/list?return_full_object=true` → `spend` of key alias `os-<systemId>` (per-system keys, #98) | The key's own counter, lifetime of the key. Langfuse `totalCost` (7 days) shown next to it |
| Error classes (7 days) | VictoriaLogs LogsQL over OPA decision logs (#217): `msg:"Decision Log" input.principal:~"^os-(…)(:|$)" | stats by (path, result.effect, result.allow) count()` → **OPA deny**, **held for approval**, **guardrail violation**; run store failure frames → **budget exceeded** (LiteLLM's own error type `budget_exceeded` in the failure reason) and **other failure** | Grouping by OPA's and LiteLLM's own codes; no free-text guessing beyond LiteLLM's documented error type |
| Last failures (5) | `run_jobs` failed rows + `traceUrlFor(runId)` (Langfuse deep link) + `/agents?system=<id>&run=<runId>` | |
| Approvals waiting | OS approvals store (`listApprovals({status:'pending'})`, OS glue by design) filtered to the system and to approvals the viewer could see | |
| Guardrail violations | the `os/guardrails/decision` rows of the same LogsQL read | |

### Data (per dataset)

| Panel | Upstream API (exact) | Notes |
|---|---|---|
| Run health per job / schedule, last success | Dagster GraphQL `runsOrError(filter:{tags:[{key:"os/dataset",…}]})`: status, `startTime`/`endTime`, tags `dagster/schedule_name`, `os/dataset` | Grouped per job and per schedule; last success = newest `SUCCESS` |
| Freshness | the Data tab's `latestSyncSignals` (Dagster runs) — age since the newest run ended | **vs SLA: not available upstream** — the generated Dagster definitions declare no `FreshnessPolicy`, so Dagster has no SLA to evaluate. We show age, not a fake SLA verdict |
| dbt tests + source tests, failing tests listed | Dagster GraphQL `assetNodes { assetChecksOrError { checks { executionForLatestMaterialization { status evaluation } } } }` (dagster-dbt maps every dbt test and source test to an asset check) | |
| Quality trend | Dagster GraphQL `assetCheckExecutions(assetKey, checkName, limit)` per check of the dataset's tested asset → pass ratio per run | |
| Impacted downstream | Dagster GraphQL `assetNodes { assetKey dependedByKeys }` — Dagster's own lineage; transitive closure from the failing asset | |
| Trino query errors / slow queries | **not in this PR.** Trino documents `system.runtime.queries`, but the OS has no read path to Trino's system catalog today and per-user scoping needs Trino query-visibility rules. Follow-up | |
| Storage growth | **not available upstream as deployed.** The Collector's `kubelet_stats` receiver runs without the `volume` metric group, and per-table Iceberg `$snapshots` summaries would mean one Trino query per table. Follow-up: enable the `volume` group | |

### Platform (admin only)

| Panel | Upstream API (exact) |
|---|---|
| Component health (real probes) | `COMPONENT_HEALTH` — each component's own health/version endpoint (Trino `/v1/info`, OpenSearch, OPA `/health`, Langfuse, LiteLLM, Dagster, VictoriaMetrics/Logs `/health`, Collector) |
| Resource pressure | VictoriaMetrics `GET /api/v1/query` (PromQL) over the Collector's `kubelet_stats` series: node memory `k8s_node_memory_working_set_bytes / (k8s_node_memory_working_set_bytes + k8s_node_memory_available_bytes)`, node disk `k8s_node_filesystem_usage_bytes / k8s_node_filesystem_capacity_bytes`, top pods `topk(8, k8s_pod_memory_working_set_bytes)`, `topk(8, k8s_pod_cpu_usage)` |
| Error-log rate | VictoriaLogs `GET /select/logsql/query` with `_time:1h i(error) | stats by (k8s.namespace.name, k8s.container.name) count() as errors | sort by (errors desc) | limit 10` — lines that contain the word "error", labelled as such |
| Backup status | existing WP-56 / WP-05 readers (`collectBackups`, `collectBackupFailureAlerts`) |
| Alerts | the operational alerts of the overview, as firing now. **Firing history: not available upstream** — no Alertmanager / vmalert is deployed; alerts are derived on read |

## Failure honesty

Each panel carries `state: 'live' | 'unavailable' | 'not_upstream'` and, when not live, a reason
(`langfuse unreachable: …`). An unreachable component is never shown as zero.

## MCP

`get_monitoring_panels { view: 'agents' | 'data' | 'platform' }` returns the same payload as
`GET /api/monitoring/panels?view=…`, through the same function, with the caller's identity.

## Tests (red first)

- VictoriaMetrics / VictoriaLogs query adapters: the chart-pinned images in docker (series imported
  through `/api/v1/import/prometheus`, lines through `/insert/jsonline`), plus negative twins.
- Langfuse metrics adapter: the `tests/langfuse/compose.yaml` stack (Langfuse 3.194.1), traces
  ingested through Langfuse's public ingestion API; twin: another system's session is not counted.
- Run-store aggregates: real `postgres:17` (`core/testing/postgres/*.it.ts`), the run store's own
  DDL; twin: a run outside the viewer's scope is not counted.
- Dagster reads: `dagster-webserver` 1.13.31 (the image's pin) over a tiny code location with a
  failing asset check, a downstream asset and tagged runs; twin: an untagged dataset is not listed.
- Pure shaping and scope: unit tests.
