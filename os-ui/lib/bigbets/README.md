<!-- SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Borek Data Ventures UG -->
# Big Bets — app-tier spine

A **Big Bet** is a *goal + roadmap* that **references** (never copies) real
artifacts living in their own tabs (Data, Agents, Dashboards, Software, ML,
Metrics, Knowledge, Files, Connections), links **up** to a Strategy pillar +
its governed business metric, and tracks delivery on a dated Gantt with a
top-down value model. This module is the kind-only, offline-mock implementation
of that surface; STACKIT/publish/cluster are out of scope.

## Files (the six adapters + the spine)

| File | Role |
|---|---|
| `model.ts` | Domain types + the **`ComponentSource`** cross-tab interface + the `Actor` (human/planner) contract. |
| `sources.ts` | **bet/reference + cross-tab sources** — 9 mock tab sources behind `ComponentSource` (governed `scaffold`/`tag`/`advance`) + the Strategy pillar/metric (RLS). The seam every tab's real flow plugs into at consolidation. |
| `status.ts` | **status-derivation adapter** — reads each artifact's real lifecycle → `planned/in-progress/completed`; dependency-aware `blocked`; owner override shown *beside* the derived state. |
| `roadmap.ts` | **roadmap/rollup adapter** — dates + dependencies → `on-track/at-risk/blocked/done` per component, % complete, go-live realism, slippage cascade. |
| `value.ts` | **value adapter** — realized basis (uplift/absolute/owner-declared) vs target; pillar→bet→component allocation (manual/usage/equal); upstream credit along the composition map; reconciles back up; RLS-scoped. |
| `composition.ts` | **composition-map adapter** — builds-on-top graph from registry consume-edges + OpenMetadata lineage (mock); doubles as the value-attribution graph. |
| `planner.ts` | **planner adapter** — goal → breakdown + dated roadmap + deps → on approval **scaffolds via each tab's governed flow**; two-mode governance; OPA+Langfuse hooks; **never self-promotes**. |
| `store.ts` | OPA-scoped registry CRUD + audit; `remove ≠ delete`; dependency-cycle guard. |
| `server.ts` | Server boundary — `CurrentUser → Principal`, composes the `BetView`, wires live OPA + Langfuse into the planner. |

## Key invariants (enforced in code, not just docs)

- **Status is never stored on the bet.** It is derived live from each artifact's
  lifecycle (`status.deriveBet`). Certifying a data product in its own tab flips
  the bet's view to `completed` with no edit here.
- **The planner can scaffold but never ship.** It runs as a `kind:'planner'`
  actor; `sources.advance` rejects it for every *ready* transition
  (certified/promoted/published/deployed/live/production/tested-governed).
  Promotion stays human (Builder/Admin).
- **Reference, not copy.** `addComponent` either links an existing artifact
  (tagging it with `big_bet_id`) or scaffolds through the tab's own governed
  flow. `removeComponent` untags — the artifact survives, and can belong to many
  bets.
- **No governance shortcut.** A not-yet-shared (personal/draft) component's
  detail is members-only (`canViewComponentDetail`); the bet inherits each
  component's real tier.
- **Value reconciles.** Component shares sum back to the bet; bets sum to the
  pillar (`value.distribute` / `value.pillarRollup`), within €0.50.

## Live vs offline-mock

For `kind` the mock is the operational path — no STACKIT, no live tab backends
(they ship on parallel branches). `sources.sourceMode()` reports `live`/`mock`
honestly. Going live = swap the body of a `ComponentSource`'s
`list/scaffold/advance` to call the tab's API + OpenMetadata; nothing above the
seam changes. OPA (`@/lib/governed`) and Langfuse are wired live through
`server.ts` and fail-open + marked when off.

## API (`app/api/big-bets`)

| Method · path | Action |
|---|---|
| `GET /api/big-bets` | list viewable bets + rollup signal + realized value |
| `POST /api/big-bets` | create (problem statement required) |
| `GET /api/big-bets/strategy` | pillars + metrics for the form |
| `GET /api/big-bets/{id}?basis=&allocation=` | full `BetView` (status/roadmap/value/composition/audit) |
| `PATCH /api/big-bets/{id}` | update bet fields |
| `POST /api/big-bets/{id}/components` | add (link or scaffold) |
| `PATCH·DELETE /api/big-bets/{id}/components/{ref}` | plan/override · remove (untag) |
| `POST /api/big-bets/{id}/components/{ref}/advance` | advance lifecycle (human-only ready) |
| `POST /api/big-bets/{id}/planner` | `propose` · `approve` (scaffold) |

## Tests

`node --test 'lib/bigbets/*.test.ts'` — 22 unit tests covering the status
mapping, dependency-blocked, roadmap at-risk/cascade/realism, value
basis/allocation/upstream-credit/reconcile, and the end-to-end gate (planner
scaffolds → certify auto-flips → planner-cannot-promote → composition lineage →
OPA redaction → remove≠delete → override-beside-derived).
