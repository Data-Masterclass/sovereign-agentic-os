<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# Strategy — pillars, value roll-up & adoption (server spine)

The server-side spine for the **Strategy tab** (`app/strategy`, `app/api/strategy`).
Strategy is the cockpit where a company plans its agentic transformation: the
**strategic pillars** it invests in, the **business value** each realizes, the
**Big Bets** contributing to each, and an **adoption scoreboard** against
**targets** — by domain. It implements `stackit/strategy-golden-path.md` (design
decisions 2026-06-30).

> **Where it sits.** Strategy answers *where & why to invest* (pillars + value +
> targets + the contribution roll-up); **Big Bets** deliver it (each bet links up
> to a pillar); **Metrics** defines the governed Cube metrics a pillar tracks;
> **Monitoring** watches what's live. Values are **RLS-scoped governed metrics** —
> the same number agents and Dashboards resolve, no privileged side-channel.

## Modules

| File | Role | Server? |
|---|---|---|
| `model.ts` | Pure types + helpers: pillars, scope, targets, entitlement/role gates, trend pacing, and the **`distributeValue` RLS spine** (top-down value distribution + reconcile). No server imports. | no |
| `bets-bridge.ts` | The **cross-tab pillar↔bet share interface** (`BetShareSource`) + a deterministic **stub** for `kind`. Defines the reconcile contract (Σ bet shares = 1; Σ component weights = 1 per bet). Swap `defaultBetShareSource` for the real Big Bets registry adapter later. | yes |
| `pillars.ts` | **Pillar/target adapter** — CRUD pillars (tenant/domain scope · governed-metric links · annual+quarterly targets · linked bets), role-gated + audited. Registry-backed: in-process cache (offline) + best-effort OpenSearch (`os-strategy-pillars`). Exports `METRIC_CATALOGUE`. | yes |
| `value-rollup.ts` | **Value-rollup adapter** — resolves the pillar's governed Cube metric total (basis-adjusted), then hands off to `distributeValue` for the RLS-scoped per-bet/component decomposition. | yes |
| `adoption-core.ts` | Pure **adoption tally** — registry rows + role map → promoted/certified counts by domain + active-people split. No server imports. | no |
| `adoption.ts` | **Adoption-metrics adapter** — supplies the live registry (`allArtifacts`) + roster to `adoption-core`; resolves per-pillar actuals. | yes |
| `snapshots.ts` | Monthly **actuals snapshots** + the **target-vs-actual** view (annual + quarterly, trend on-track/behind). | yes |
| `audit.ts` | **Audit trail** — every pillar/target edit → a Langfuse trace (offline-safe in-process ring buffer for the local feed). | yes |

Tests: `model.test.ts` (distribution reconcile + RLS masking + role gates +
pacing), `adoption-core.test.ts` (by-domain tier counts + active-people split +
live increment on certify). Run with `npm test`.

## The value model (top-down, RLS-correct)

A pillar's **business value metric is the TOTAL**. It is distributed:

```
pillar metric total
  → per bet:        value = total × bet.sharePct        (Σ sharePct = 1)
    → per component: value = betValue × component.weight  (Σ weight   = 1 per bet)
```

So **every component carries a € value** and the decomposition **reconciles back
up** (Σ components = bet; Σ bets = total — checked to the euro by
`reconciles()`).

**RLS is enforced twice.** The total is the governed Cube metric (already
RLS-scoped at the semantic layer). On top, `distributeValue` masks the € value of
any bet/component in a domain the viewer is **not entitled to** (`entitledToDomain`)
— so two viewers of the same pillar see different, correctly-scoped numbers. The
**full** decomposition is still summed server-side for the reconcile check, so
reconciliation holds regardless of who is looking; only *visibility* differs
(`visibleTotal` / `maskedTotal`).

Realized-value **basis** is per-pillar (decided): `uplift` over a captured
baseline (default), `absolute`, or `declared` (corroborated by the metric).

## Targets & adoption

- **Targets** — annual north-star with quarterly sub-targets for **value
  generated**, **active Creators & Builders**, and **promoted/certified counts**
  of six kinds (data · metrics · dashboards · agents · software · ML), **by
  domain**. Actuals **snapshot monthly**; each row shows target vs actual + a
  trend (`on-track`/`behind`) paced against the elapsed year.
- **Adoption scoreboard** — counts derived **live** from the artifact registry +
  OpenMetadata (visibility tier: `Shared`→promoted, `Certified`→certified) by
  domain; **active people** from recent authoring activity (registry + audit),
  split Creator/Builder by role. **Never hand-kept** — certifying a data product
  increments the count with no manual edit.

## Governance

`canViewPillar` / `canEditPillar` / `canCreatePillar` (in `model.ts`) are the
authoritative server-side gates, enforced in every adapter + API route:

- **Admin** defines shared **tenant** pillars + targets; **Builder** defines
  **domain** pillars for a domain they belong to; **Creators/Users**
  (participant) **view only**.
- Every create/update/delete/target/link/snapshot is **audited** (`audit.ts`).
- Pillar values are RLS-scoped; counts are aggregate-only.

## Offline / `kind`-only

Everything degrades gracefully with **no cluster**: Cube unreachable → the
metric's deterministic `seedTotal`; OpenSearch unreachable → in-process registry
cache; Langfuse unreachable → in-process audit ring. The whole gate (define
Retention → link two bets → reconcile under RLS → drill → targets → certify →
live scoreboard → snapshot → role-gate → audit) runs on a laptop. No STACKIT, no
publish, no cluster required.

## API

| Route | Method | Who |
|---|---|---|
| `/api/strategy/pillars` | GET (RLS list) · POST (create) | view all · create: Builder/Admin |
| `/api/strategy/pillars/[id]` | GET (rollup+progress+audit) · PATCH · DELETE | view · edit: Builder/Admin |
| `/api/strategy/pillars/[id]/targets` | PUT | Builder/Admin |
| `/api/strategy/pillars/[id]/bets` | POST link · DELETE unlink | Builder/Admin |
| `/api/strategy/pillars/[id]/snapshot` | POST | Builder/Admin |
| `/api/strategy/adoption` | GET (RLS by domain) | view |
| `/api/strategy/catalogue` | GET (metrics · bets · domains) | view |

## Cross-tab merge note (Big Bets)

`bets-bridge.ts` is the seam with the **Big Bets** tab (parallel branch). Today it
serves a stub. At consolidation, replace `defaultBetShareSource` with an adapter
that reads bets tagged to the pillar (`pillar_id`) and their real value
distribution (selectable allocation + upstream credit — Big Bets mechanics).
Nothing else in Strategy changes; the reconcile contract (Σ shares = 1) is fixed
here.
