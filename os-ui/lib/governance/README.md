<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->

# Governance — the control plane

Governance **consolidates, decides, and records**. It does **not** author policy —
that stays in each tab (Connections authors capability profiles, Agents authors
safety presets, Data authors grants). Here you **approve · see policy · audit ·
cap cost · manage access**. Spec: [`governance-golden-path.md`](../../../../stackit/governance-golden-path.md).

## The one principle: an approval **is** an action

On **Approve**, the platform doesn't just flip a flag — it **executes the governed
effect** behind the card (deploy the app · grant access · allowlist the endpoint ·
promote/certify · run the queued action) **and** writes **audit** + (optionally) a
**standing policy**. The user sees a card; the effect happens behind it.

## Five sections → five adapters

| UI section | Adapter (lib) | What Approve does | Live backend | Offline-mock |
|---|---|---|---|---|
| **Approvals inbox** | `effects.ts` (per-source) | deploy · grant · egress · promote · run | Argo / OPA / egress proxy / OpenMetadata | marked `live:false`, plane mutated in-process |
| **Policies** | `policy-view.ts` | Admin **override** (revoke a grant) | reads live OPA grants | role-derived plane compiled in-process |
| **Audit** | `audit.ts` | — (records every effect) | Langfuse mirror + OpenMetadata lineage | hash-chained in-process log |
| **Cost & limits** | `cost.ts` | set cap → enforce over-cap | LiteLLM budgets | in-process caps + `checkCap` |
| **Users & access** | `roles.ts` (+ `lib/users`) | role-per-domain → **OPA grants** | Ory identities + OPA write-through | placeholder Ory seam + in-process compile |

The **approval queue itself** is `lib/approvals.ts` (reused, extended with the five
async sources + scope/approver/preview). `standing.ts` is the "approve & remember"
store. `seed.ts` stubs the upstream sources (Software/Agents/Data/Connections) so
the gate runs on `kind`; the real sources reconcile at consolidation.

## Roles & scope (`roles.ts`)

Roles are **User · Creator · Builder · Admin** (wire value for User stays
`participant`). A user's **role-per-domain** is the source; `roles.ts` is the
compiler → **OPA grants** every tab enforces.

- **User** — sees + acts on **their own** requests.
- **Builder** — **their domain's** queues / policy / audit / memberships; assigns
  roles up to Builder, within their own domain.
- **Admin** — **tenant-wide** (all domains, egress, tenant defaults, caps, users).

`canSee`, `canApprove`, `canManageRole` enforce this; egress / tenant items are
Admin-only (`scope: 'tenant'`).

## Credentials

This module **never handles raw credentials**. Inviting a user assigns **role +
membership** only; account creation / passwords / SSO go through **Ory's secure
flow** (here a server-only placeholder seam, swappable for the Ory identity API).
Sending a `password` to the users route is rejected (400).

## Dual pattern (live + offline-mock)

Every adapter is authoritative **in-process** (so it works with no cluster) with a
**best-effort write-through** to the real backend (OPA `PUT /v1/data/grants`,
Langfuse ingestion, OpenSearch mirror). When the backend is unreachable the effect
is **clearly marked `live:false`** and the teaching flow still proves the decision.

## API (`app/api/governance/*`)

| Route | Verbs | Purpose |
|---|---|---|
| `/api/governance/approvals` | GET · POST | scoped queue; decide → effect → audit (+ standing) |
| `/api/governance/approvals/seed` | POST | seed the demo queue (Builder/Admin) |
| `/api/governance/policies` | GET · POST | consolidated plane; Admin override |
| `/api/governance/audit` | GET | searchable record + chain integrity |
| `/api/governance/cost` | GET · POST | list / set caps |
| `/api/governance/cost/check` | POST | enforcement seam (over-cap → 403) |
| `/api/governance/users` | GET · POST · PATCH | invite / role-per-domain / deactivate |

## Tests

`node --test 'lib/governance/*.test.ts'` (part of `npm test`). Covers the gate:
scope (Builder=domain vs Admin=tenant; non-Builder can't deploy), approval→effect
(deploy / access-grant / egress / promote / autonomous), Admin override, cost caps
(over-cap blocked), audit who/when/why + chain, approve-&-remember.

## What's mocked on `kind`

Argo deploy, the egress proxy, OpenMetadata promote, and live LiteLLM/Ory calls are
**mocked** (marked `live:false`). The **policy/access/egress plane is real
in-process** (so the consumer truly can query, the endpoint truly is allowlisted).
A real deploy reconciles these into OPA/LiteLLM/Ory.
