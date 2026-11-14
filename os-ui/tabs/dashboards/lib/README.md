<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# `lib/dashboards` — governed BI on metrics (Dashboards tab)

The viewing/BI layer. **Tier 1 (default):** NATIVE dashboards rendered with **Apache
ECharts** — each panel resolves its numbers through the SAME governed **compiled-SQL**
metrics path the Metrics tab uses (`exploreMetric`, Trino run AS the viewer), so per-viewer
RLS applies (two viewers, different rows) with **no BI tool in the loop** and a chart's
number is BY CONSTRUCTION the explorer's number for the same member + slice + viewer.
**Nothing sits between a panel and Trino** — no BI server, no semantic-layer server, no guest
token. **Tier 2:** Power BI / Tableau connection export (connected tools, not embedded,
`/api/dashboards/connect-info`). All on **governed metrics** (defined in the Metrics tab), so
numbers match the explorer and the agent `metrics` tool. Built on `lib/data` + `lib/metrics`
**read-only**. Dashboards **consumes** metrics; it never defines them.

Specs: `stackit/dashboards-golden-path.md`, `…/metrics-dashboards-deep-design.md`,
`…/data-policy-compiler.md`.

## Modules
| file | role |
|---|---|
| `model.ts` | The dashboard spec — a governed view + `Panel[]`. A `Panel` charts governed metric **members** (`metrics`, with a legacy `metric` alias `normalizePanel` folds in), optionally grouped by dimensions / a time dimension at a grain, optionally filtered. **Dual-mode:** `fromTiles` (drag-drop) and `fromAgent` both produce the SAME normalized, deduped `DashboardSpec`. It also owns the two runtime allow-lists a panel is checked against at every door — `PANEL_TIME_GRAINS` and `SERVABLE_FILTER_OPERATORS`. |
| `build/panel-query.ts` | **Tier 1 server boundary.** `runPanelQuery(view, panel, token, user)` resolves each panel measure to its governed metric (registry resolver, RLS-scoped) and serves it through `exploreMetric` (governed Trino SQL, run AS the viewer). Honest offline-mock + window-metric pending + LOUD missing/dropped-member warnings all come from `exploreMetric`. |
| `reports.ts` | Scheduled reports on a governed dashboard — a dashboard snapshot on a cadence. Pure: decides which reports are **due** and records a send (`dueReports` / `sendReport`). (Metric alerts moved to `lib/metrics/alerts.ts`.) |
| `delivery.ts` | The REAL delivery boundary for scheduled reports and fired alerts — renders + delivers in-app (the one delivery surface) instead of a notification that dies in the JSON response. |
| `governance.ts` | Personal → Domain (Builder) → Marketplace (Admin), reusing `canTransition`. Broadening the tier never broadens the rows — every panel stays per-viewer RLS-scoped at query time. |
| `store.ts` | In-memory dashboard registry, principal-scoped like every governed surface (spec-shape-agnostic; reads only `spec.charts.length`). |

## R3 / identity
Every panel-query runs under the viewer's **delegated** token (`lib/identity-server` →
`propagate` → governed Trino via `exploreMetric`), so RLS is enforced once, run AS the
viewer — the same rows the explorer and the agent see. No semantic-layer server sits in the
path, so no security context is forwarded to one: the viewer's own identity reaches Trino. A
shared/certified dashboard stays per-viewer
scoped; the tier never broadens the rows.

## Routes
`/api/dashboards` (tiles) · `/api/dashboards/build` (dual-mode, **persist-only**) ·
`/api/dashboards/[id]` (GET spec / archive / delete) · `/api/dashboards/panel-query`
(one panel's governed rows, per-viewer RLS) · `/api/dashboards/connect-info` (Tier-2
connected-tools meta) ·
`/api/dashboards/[id]/promote` · `/api/dashboards/reports` (scheduled send).

Tier 2 reuses the Power BI connection export (`lib/powerbi/*`, `/api/powerbi/*`).

## Tests
`node --test 'lib/dashboards/**/*.test.ts'`. The full vertical slice is in
`lib/metrics/gate.test.ts`.
