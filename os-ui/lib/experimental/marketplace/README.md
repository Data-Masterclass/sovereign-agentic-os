<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Internal cross-domain Marketplace (`lib/marketplace`)

The **Consume** counterpart to every Build tab's **certify** step: discover and
share **Admin-certified products of every type** across the tenant's domains.
This is the *internal* tenant marketplace — distinct from the external STACKIT
listing (`marketplace-registration.md`).

Spec: `stackit/marketplace-golden-path.md` (+ `data-policy-compiler.md`,
`data-architecture-model.md`, `governance-golden-path.md`).

## The one idea: **import = a governed grant**

> The owner's certified artifact stays the **source of truth** and is consumed
> under the **consumer's identity + RLS** — except where a type needs its own
> instance / creds / editable copy.

| Product type | Import mode | Enforced by |
|---|---|---|
| data product · transformation | `read-grant` (+ `fork`) | Trino + OPA row filter |
| metric · dashboard | `read-grant` | Cube row-level security |
| knowledge · files | `read-grant` (knowledge: + `fork`) | OpenSearch Document-Level Security |
| app (Software) | `deploy-instance` | your own instance |
| connection | `template` (BYO creds) | new connection |
| agent | `fork` | editable copy you own |

`read-grant` is the default for every data-like product (single source,
consistent, RLS-scoped). A `fork` copies the artifact into the consumer's domain
(then governed there) and may drift from the source.

## Cross-domain RLS (the core proof)

`rls.ts` compiles a grant into a per-viewer row predicate bound to the
**consumer's** claims, never a service account (data-policy-compiler.md R1/R2).
Two domains importing the *same* product therefore see **different rows**:

```
compileRls('sales')      → domain = 'sales'
compileRls('marketing')  → domain = 'marketing'
applyRls(scope, cols, rows)   // the offline-mock stand-in for Trino/Cube/DLS
```

In a live deployment, `compileRls` is what the policy compiler emits to
Trino/OPA (`rowFilter`) and Cube (`securityContext`); `applyRls`/`rowMatches`
are the offline-mock engine that filters the preview/sample rows the same way,
so a grant yields the same rows on both paths. The evaluator **fails closed** on
any predicate it can't parse.

## Governance

`import-policy.ts#defaultAccessPolicy` decides `open` (auto-grant; RLS still
scopes the rows) vs `approval`. Modes that touch the owner's live creds/compute
(`template`, `deploy-instance`) default to `approval`; an owner can override per
listing. An approval-required import creates a **pending** grant and enqueues a
`marketplace_import` request in the **Governance** inbox (`lib/approvals`),
routed to the *owner's* domain. When Governance clears it,
`onApprovalDecided` flips the grant `active` (and materializes any
fork/template/instance) or `revoked`. Everything is **audited** (`store.ts`,
mirrored to Langfuse + OpenSearch).

## Lifecycle: certify → list → deprecate (lineage-aware)

An Admin **certifies** a product in its own tab → it is **listed** here.
**Deprecate** is lineage-aware (`lineage.ts`): importers are **warned** and the
listing is flagged `deprecated`, but active grants are **kept** — an in-use
product is never silently removed (`canHardRemove` is only true with zero live
importers).

## Adapters (live + offline-mock, same dual pattern as `lib/artifacts.ts`)

```ts
listingAdapter : ListingAdapter   // discovery over OpenMetadata /data-marketplace + the OS registry, with trust signals
publishAdapter : PublishAdapter   // certify → list / deprecate (lineage-aware)
importAdapter  : ImportAdapter    // per-type import → grant / fork / instance / template
```

Each probes the live backends (OpenSearch/OM) and falls back to the
**authoritative offline-mock** catalog (`store.ts`) so the teaching/gate flows
run with **no cluster**. `listingAdapter.source()` reports `'live'` |
`'offline-mock'`. The mock catalog also stubs the cross-tab product sources
(apps, connection templates, the worked-example fixtures) that live on parallel
product-tab branches; at consolidation they swap for the real per-tab registries
behind the same `MockProduct` shape.

## Files

| File | Responsibility | Pure? |
|---|---|---|
| `types.ts` | listing / grant / adapter contracts | ✅ |
| `import-policy.ts` | per-type modes · enforcement target · access policy | ✅ |
| `rls.ts` | compile + evaluate cross-domain RLS | ✅ |
| `lineage.ts` | importer set · lineage-aware deprecation | ✅ |
| `store.ts` | grants/ratings/usage/audit state + offline-mock catalog | server-only |
| `adapters.ts` | the three adapters (compose everything) | server-only |
| `index.ts` | public surface | — |
| `marketplace.test.ts` | spine tests (RLS divergence, deprecation, policy) | ✅ |

The pure modules carry no `server-only`/third-party imports, so
`node --test lib/marketplace/marketplace.test.ts` runs the spine proofs with no
cluster and no `node_modules`.

## API

```
GET  /api/marketplace?q=&type=&domain=&tag=&includeDeprecated=   discovery + trust + adapter source
GET  /api/marketplace/:id?as=<domain>                            detail: RLS-filtered preview · lineage · usage
POST /api/marketplace/:id/import   { mode?, as? }                import → grant (201) | pending approval (202)
POST /api/marketplace/:id/rate     { stars }                     rate 1..5
POST /api/marketplace/:id/deprecate                              admin · lineage-aware (returns warned importers)
GET  /api/marketplace/imports                                    the caller's grants ("My imports")
```

## Validation gate (kind / offline-mock)

Sales certifies a **metric** (Revenue), a **dashboard** (Sales Overview), a
**knowledge** product (Bank submission) and a **connection template**
(Salesforce) → they appear with badge/owner/lineage/preview → **Marketing
imports** Revenue (read grant; **different rows** via RLS than Sales) → embeds
the dashboard (own RLS) → **forks** the knowledge (editable copy in Marketing) →
imports the Salesforce **template** (its own creds; approval-gated → shows in
**Governance**) → the owner sees **usage**; deprecating an in-use product
**warns** importers → all grants **audited**. The spine of this is asserted in
`marketplace.test.ts`; the end-to-end HTTP walkthrough is in
`scripts/marketplace-gate.mjs`.
