<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# `lib/metrics` — the KPI semantic layer (Metrics tab)

Define, explore and govern **measures + views in Cube** on top of the auto-cube the Data
tab scaffolds from dbt (`cube_dbt`). The single source of truth for "Revenue", "Active
customers" — the **same** member dashboards chart and the agent `metrics` tool resolve,
so numbers always match. This module is **imported on top of `lib/data` read-only**
(identity R2/R3, the `cube_dbt` scaffold, `canTransition`, the transparency gate).

Specs: `stackit/metrics-golden-path.md`, `…/metrics-dashboards-deep-design.md`,
`…/data-policy-compiler.md`.

## The split (one verb per tab)
- **Data** produces the auto-cube (`sql_table` + dimensions) from the dbt manifest; OM
  ingests dbt **in parallel** (no OM→Cube step).
- **Metrics (this)** defines the **measures/views**, the **explorer**, and
  **promote/certify**. Data owns the base cube file; Metrics owns the measures layer that
  references it (the recommended ownership split — resolved here).
- **Dashboards** (`lib/dashboards`) consumes governed metrics in Superset.

## Modules
| file | role |
|---|---|
| `model.ts` | The metric artifact + the **three converging define paths**: `measureFromForm` / `measureFromAgent` / `measureFromYaml` all produce the SAME `Measure`; `measureMember(dataset, measure)` is the **canonical Cube member** (`ViewNoSpaces.measure`) — byte-for-byte what `lib/data` live-clients builds for the agent `metrics` tool, so define / explore / chart / ask all read one number. |
| `consistency.ts` | **Metric-consistency.** `convergence` proves form==agent==YAML (define-time). `numbersMatch` proves explorer==dashboard==agent for a member (resolve-time). `consistencyCheck` is the **promotion gate content**: documented (transparency gate) + defined + resolves on its member. |
| `explorer.ts` | The metric explorer. `explore(spec, token, exec)` runs **under the viewer's `securityContext`** (R3) — two viewers, different rows. `dropToSql` is the analyst escape hatch (Cube SQL API / Trino). |
| `governance.ts` | Personal → Domain (Builder) → Marketplace (Admin). Reuses `canTransition` from `lib/data` so metrics never drift from datasets on who-may-do-what; gates on the consistency check. |
| `store.ts` | Metrics derived **read-only** from `lib/data` datasets (a metric IS a measure on a governed dataset) — no second store, no drift. |
| `fixtures.ts` | Shared test fixture (`goldSales`). |
| `build/` | The **metric** + **metric-explorer** adapters (the live+offline-mock dual pattern). |

## The adapters (`build/`)
One generic `BuildAdapter<Ctx>` (apply→verify; a row is ✓ **only when both pass**) shared
with `lib/dashboards`. `live.ts` is pure (the Cube client is injected); `live-clients.ts`
is the server-only fetch client (reuses the governed `cubeLoad`/`cubeScalar`, which
forward the per-user `securityContext` to Cube — R3). `mocks.ts` is an honest in-process
Cube. `server.ts` (`buildMetric`) picks **live** when Cube is reachable, else **offline-
mock** — labelled either way, same adapter logic, so a ✓ is always a real apply+verify.
`explore-server.ts` (`exploreMetric`) runs the explorer live or offline (the offline mock
itself enforces region RLS, so the two-viewer demo is real on a laptop).

- **metric (`cube`)** — reload the measures/views YAML → verify the measure **resolves**.
- **metric-explorer** — run the explorer under the viewer's context → verify
  **numbers match** (explorer value == agent value).

## R3 / identity (Opus-owned, the bit to get right)
Every governed call runs under a **user-delegated token** (`lib/identity-server`
`delegatedToken` → `delegate` refuses a service account, R2). `propagate(token)` derives
the Cube `securityContext` (R3); the explorer, the agent `metrics` tool and (in
`lib/dashboards`) the Superset guest token all carry the **same** identity, so RLS is
enforced **once at Cube** and can't collapse to a shared identity.

## Routes
`/api/metrics` (list) · `/api/metrics/define` (form/agent/YAML → convergence + build) ·
`/api/metrics/explore` (per-viewer RLS + drop-to-SQL) · `/api/metrics/govern`
(promote/certify, role + consistency gate).

## Tests
`node --test 'lib/metrics/**/*.test.ts'`. `gate.test.ts` walks the **whole kind-gate**
end-to-end (define → numbers match → two-viewer RLS → Builder/Admin governance → dashboard
both ways → embed RLS → alert→agent → report → numbers match).
