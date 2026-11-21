# Monitoring · Manage

Run traces, component health, and gateway spend. Observation only; configuration lives in Platform.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/monitoring`

**APIs**

- `/api/monitoring` (incl. `/api/monitoring/panels?view=agents|data|platform`)
- `/api/traces`
- `/api/status`
- `/api/platform-admin/billing`

**MCP tools** (`core/mcp/monitoring-tools.ts`)

- `get_monitoring_overview`, `get_monitoring_panels` (`view`: agents · data · platform), `list_runs`, `get_run_trace`

**Needs deployed**

- `langfuse`
- `clickhouse`
- `opensearch`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Where the numbers come from (engine rebuild B2–B4)

- **Pipelines lens** (`lib/adapters/pipeline-health.ts`) reads **Dagster runs** through the one typed
  client (`core/infra/dagster.ts` `recentOsRuns`, READ-ONLY — no launch or terminate here) and
  labels each row from the run's `os/*` tags: `os/dataset`, `os/domain`, `os/principal`,
  `os/action`, `os/commit`. A run without those tags keeps its job name rather than being hidden.
  Dagster unreachable ⇒ nothing, or the demo fixtures where `monitoringDemoFixtures` is on — never a
  red alert no one can act on.
- **Data quality, freshness and last-sync** (`lib/artifacts-view.ts`, `lib/detail-view.ts`) read
  `@tabs/data/lib/dq-status-server` and `@tabs/data/lib/sync-status-server`, which resolve to
  **Dagster asset checks and runs** — the default since B4 (`DATA_PROJECT_GIT` is on) — and to the
  OS's own `os-dq-results` / `os-sync-runs` series only under the emergency opt-out. One function per
  signal, shared with the Data tab, so the two tabs cannot disagree. This tab holds no ledger read
  of its own — `grep -rn "sync-runs\|dq-results" tabs/monitoring` finds no import, only the
  comments that explain the opt-out fallback. Unknown is `null`, never a guess.
- **Which engine produced a verdict is visible.** `DqRunRecord.source` reaches the dataset detail as
  a `sourceLabel` the `.ts` payload computes (`dqSourceLabel` in `@tabs/data/lib/dq` — `dagster` →
  "dbt test", `os` → "OS probe", absent → nothing, because a pre-B2 record cannot know). The UI
  renders what the payload says; a tab's UI may not import another tab.
- **`lastSync` means when the newest run ENDED** (its start while it is still running) on the
  Dagster path, which is when the data actually landed. An unreadable dataset is `unknown: true`,
  distinct from "never synced" — a read that failed is not a fact.
- **Agent run traces** still come from Langfuse / the in-process ring (Part A of the engine rebuild).

## The Agents · Data · Platform panels (2026-11-21)

Design and the per-panel upstream table: [`docs/superpowers/plans/2026-11-21-monitoring.md`](../../../docs/superpowers/plans/2026-11-21-monitoring.md).
`lib/panels/` builds them; every number is read from the component that holds it:

- **Agents** — run store (Postgres `run_jobs`, `adapters/run-stats.ts`), Langfuse Metrics API
  (`core/adapters/langfuse/metrics.ts`), LiteLLM `/key/list` (alias `os-<id>`), OPA's decision log in
  VictoriaLogs (`core/adapters/victoria-logs/query.ts`), the approvals store.
- **Data** — Dagster runs, asset checks, `assetCheckExecutions` and `dependedByKeys`
  (`core/adapters/dagster/monitoring-read.ts`).
- **Platform** (admin only) — `COMPONENT_HEALTH` probes, VictoriaMetrics PromQL
  (`core/adapters/victoria-metrics/query.ts`), VictoriaLogs LogsQL, backups, alerts firing now.
- Each upstream read is narrowed to the viewer's systems / datasets in the request; a source that
  does not answer is `unavailable` with its reason; what no component offers is listed in
  `notUpstream` (freshness SLA, Trino query errors, storage growth, guardrails per agent, alert history).
- Real-component tests: `tests/monitoring/up.sh` (VictoriaMetrics, VictoriaLogs, Postgres 17,
  dagster-webserver) with `MON_IT=1`; Langfuse via `tests/langfuse/compose.yaml` with `TRACING_E2E=1`.

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
