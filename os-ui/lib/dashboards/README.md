<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# `lib/dashboards` — governed BI on metrics (Dashboards tab)

The viewing/BI layer. **Tier 1 (default):** NATIVE dashboards rendered with **Apache
ECharts** on the **governed Cube layer** — each panel resolves under the viewer's delegated
identity, so per-viewer RLS applies (two viewers, different rows) with **no BI tool in the
loop**. **Tier 2:** Power BI / Tableau connection export + an "Open in Superset" console
link (connected tools, not embedded). All on **Cube metrics** (defined in the Metrics tab),
so numbers match the explorer and the agent `metrics` tool. Built on `lib/data` +
`lib/metrics` **read-only**. Dashboards **consumes** metrics; it never defines them.

Specs: `stackit/dashboards-golden-path.md`, `…/metrics-dashboards-deep-design.md`,
`…/data-policy-compiler.md`.

## Modules
| file | role |
|---|---|
| `model.ts` | The dashboard spec — a Cube view + `Panel[]`. A `Panel` charts governed metric **members** (`metrics`, with a legacy `metric` alias `normalizePanel` folds in), optionally grouped by dimensions / a time dimension at a grain, optionally filtered. **Dual-mode:** `fromTiles` (drag-drop) and `fromAgent` both produce the SAME normalized, deduped `DashboardSpec`. `buildPanelCubeQuery(panel)` → the exact Cube `load` query the viewer resolves. |
| `build/panel-query.ts` | **Tier 1 server boundary.** `runPanelQuery(view, panel, token)` resolves one panel's rows via `cubeLoad` under the viewer's `securityContext` (R3 RLS), with the honest offline-mock + Cube sync-lag fail-soft (`pending`). Mirrors `lib/metrics/build/explore-server.ts`. |
| `cube-meta.ts` | `narrowCubeMeta(members, meta)` — narrows Cube `/meta` to the caller's governed views (the panel builder palette), never exposing a view they can't see. |
| `alerts.ts` | A threshold on a metric member → **notify** + (optional) **trigger a governed agent run** (`traced: true`). Plus scheduled reports (`dueReports` / `sendReport`). |
| `governance.ts` | Personal → Domain (Builder) → Marketplace (Admin), reusing `canTransition`. Broadening the tier never broadens the rows — every panel stays per-viewer RLS-scoped at Cube. |
| `store.ts` | In-memory dashboard registry, principal-scoped like every governed surface (spec-shape-agnostic; reads only `spec.charts.length`). |

## R3 / identity
Every panel-query runs under the viewer's **delegated** token (`lib/identity-server` →
`propagate` → `securityContext`); `cubeLoad` forwards it as `x-cube-security-context` so
Cube enforces RLS once — the same rows the explorer and the agent see. A shared/certified
dashboard stays per-viewer scoped; the tier never broadens the rows.

## Routes
`/api/dashboards` (tiles) · `/api/dashboards/build` (dual-mode, **persist-only**) ·
`/api/dashboards/[id]` (GET spec / archive / delete) · `/api/dashboards/panel-query`
(one panel's governed rows, per-viewer RLS) · `/api/dashboards/cube-meta` (governed-view
palette) · `/api/dashboards/connect-info` (Tier-2 connected-tools meta) ·
`/api/dashboards/[id]/promote` · `/api/dashboards/reports` (scheduled send).

Tier 2 reuses the Power BI connection export (`lib/powerbi/*`, `/api/powerbi/*`).

## Tests
`node --test 'lib/dashboards/**/*.test.ts'`. The full vertical slice is in
`lib/metrics/gate.test.ts`.
