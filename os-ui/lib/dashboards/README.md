<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# `lib/dashboards` — governed BI on metrics (Dashboards tab)

The viewing/BI layer: governed **Superset** dashboards, **tiles → double-click → embed**,
**scheduled reports** and **alerts** — all on **Cube metrics** (defined in the Metrics
tab), so the numbers match the explorer and the agent `metrics` tool. Built on top of
`lib/data` + `lib/metrics` **read-only**. Dashboards **consumes** metrics; it never
defines them.

Specs: `stackit/dashboards-golden-path.md`, `…/metrics-dashboards-deep-design.md`,
`…/data-policy-compiler.md`.

## Modules
| file | role |
|---|---|
| `model.ts` | The dashboard spec (a Superset dataset on a Cube view + charts). **Dual-mode:** `fromTiles` (drag-drop) and `fromAgent` (the dashboard agent) both produce the SAME normalized, deduped `DashboardSpec` — both modes edit one dashboard. `supersetBundle` is the import bundle; charts reference governed metric **members**. |
| `embed.ts` | **R3 guest token.** `guestTokenRequest(token, dashboardId)` mints a Superset guest-token request with the **viewer's RLS in the token** (`rls:[{clause}]`), derived from the same delegated identity the explorer + agent use. Two viewers → two clauses; a service identity is refused; ~5-min ttl. `rlsFromSecurityContext` mirrors the policy compiler (low-card attribute → equality; else an entitlement-table join, R1). |
| `alerts.ts` | A threshold on a metric member → **notify** + (optional) **trigger a governed agent run** (event → LangGraph, `traced: true`). Plus scheduled reports (`dueReports` / `sendReport`). All on the canonical member, so an alert fires on the same number a viewer sees. |
| `governance.ts` | Personal → Domain (Builder) → Marketplace (Admin), reusing `canTransition`. Broadening the tier never broadens the rows — the guest token keeps a shared dashboard per-viewer RLS-scoped. |
| `store.ts` | In-memory dashboard registry (tiles, seeded "Sales Overview"), principal-scoped like every governed surface. |
| `build/` | The **dashboard** + **embed** (+ report + alert) adapters (live Superset/REST + offline-mock). |

## The adapters (`build/`)
Reuse the generic `BuildAdapter<Ctx>` from `lib/metrics/build` (apply→verify; ✓ only when
both pass). `live.ts` is pure (Superset + embed clients injected); `live-clients.ts` is
the server-only fetch client (dashboard import/list, report/alert create, guest-token
mint). `mocks.ts` is an honest in-process Superset (and a signer that refuses an
unscoped token). `server.ts` (`buildDashboard`, `mintEmbed`) picks **live** when Superset
is reachable, else **offline-mock** — same logic both paths.

- **superset** — import the dataset+charts bundle → verify the dashboard loads.
- **embed** — mint the per-viewer guest token → **verify it carries the viewer's RLS**
  (an empty filter fails — RLS would collapse).
- **report / alert** — create → verify listed.

## R3 / identity
The guest token is minted by a **service account** but its **payload carries the viewer's
RLS** (`req.rls`), so the embed is scoped to the viewer, not to whoever Superset connects
to Cube as. Same delegated identity (`lib/identity-server`) as the metric explorer and the
agent — RLS enforced once at Cube, the same rows everywhere.

## Routes
`/api/dashboards` (tiles) · `/api/dashboards/build` (dual-mode) ·
`/api/dashboards/embed` (guest token, RLS in token) · `/api/dashboards/govern`
(promote/certify) · `/api/dashboards/alerts` (notify + trigger agent, traced) ·
`/api/dashboards/reports` (scheduled send).

## Tests
`node --test 'lib/dashboards/**/*.test.ts'`. The full vertical slice is in
`lib/metrics/gate.test.ts`.
