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
| **Approvals inbox** | `effects.ts` (per-source) | deploy · grant · egress · promote · run | OPA / the app runner / egress proxy | marked `live:false`, plane mutated in-process |
| **Policies** | `policy-view.ts` | Admin **override** (revoke a grant) | reads live OPA grants | role-derived plane compiled in-process |
| **Audit** | `audit.ts` | — (records every effect) | Langfuse mirror + registry lineage | hash-chained in-process log |
| **Cost & limits** | `cost.ts` | set cap → enforce over-cap | LiteLLM budgets | in-process caps + `checkCap` |
| **Users & access** | `roles.ts` (+ `lib/platform-admin`) | role-per-domain → **OPA grants** | OS-native identities (scrypt, `lib/core/password.ts`) + OPA write-through | in-process directory + compile |

The **approval queue itself** is `lib/approvals.ts` (reused, extended with the five
async sources + scope/approver/preview). `standing.ts` is the "approve & remember"
store. `seed.ts` stubs the upstream sources (Software/Agents/Data/Connections) so
the gate runs on `kind`; the real sources reconcile at consolidation.

## Roles & scope (`roles.ts`)

Roles are **Creator · Builder · Domain admin · Admin** (lowest→highest; the wire
enum is `creator | builder | domain_admin | admin`). A user's **role-per-domain** is
the source; `roles.ts` is the compiler → **OPA grants** every tab enforces.

- **Creator** — sees + acts on **their own** requests.
- **Builder** — approves **Personal→Shared** in their domain (queues / policy /
  audit); an approver, not a people-admin.
- **Domain admin** — Builder rights + administers users in their **own** domain
  (invite / edit / deactivate; assigns roles up to Builder).
- **Admin** — **tenant-wide** (all domains, egress, tenant defaults, caps, users)
  and the only role that appoints a Domain admin.

`canSee`, `canApprove`, `canManageRole` enforce this; egress / tenant items are
Admin-only (`scope: 'tenant'`).

## The scope ladder — who can SEE an artifact

**My → Domain → Company.** Promotion moves an artifact up (My→Domain: the owner files, a
domain admin of its domain approves; Domain→Company: an admin certifies). Each rung decides
who may **read** it; **write/manage rights never change with the rung** — they stay with the
owner, an in-domain domain admin, or an admin (`core/kernel/edit-scope.ts`,
`canManageArtifact`; a My item is owner-only, absolutely).

| Rung | Stored as | Who can read it |
|---|---|---|
| **My** | `dataset` · `Personal` · `personal` · `private` | the owner only |
| **Domain** | `asset` · `Shared` · `domain` | members of the owning domain (+ named grants); narrowed to the **active** domain in lists |
| **Company** | `product` · `Marketplace` · `Certified` · `marketplace` | **every signed-in member of the tenant, in every domain** — whichever domain is active |

**Owner decision 2026-11-23:** *"When any of the artifacts is promoted to Company, it becomes
visible across all domains."* This replaced the earlier "strict domain isolation for every
tier" for the Company rung only (My and Domain are still narrowed to the active domain).

**One rule, one place:** `core/kernel/company-scope.ts` — `isCompanyScope(tierOrVisibility)`
knows every tab's Company word; `inLiveDomainScope({company, domain}, user.domains)` is the
list-narrowing predicate. Every kind uses it in its view gate and its list:
datasets (and the metrics derived from them), files, workflows, knowledge notes, dashboards,
agent systems, connections, software apps, kernel registry artifacts; the picker narrowing
(`core/kernel/domain-scope.ts`) uses it too. The non-TypeScript twins say the same thing:

- **Trino / OPA** — the policy compiler (`tabs/data/lib/policy/compiler.ts`) emits
  `visibility: "public"` for every product-tier dataset, so `package trino` lifts the row
  filter for every principal. **Column masks still apply** (`trino_test.rego`
  `test_company_dataset_column_still_masked_for_foreign_domain`).
- **OpenSearch DLS** — files: the `tier: product` clause (`tabs/files/lib/dls.ts`);
  knowledge/agent retrieval: the `visibility: Marketplace` clause (`retrieve.ts`,
  `retrieve-core.ts canSee`). Neither carries a domain term.

Every surface therefore agrees: the tab list (under **Company**, with the Company badge and the
source-domain tag), open by id, search, grant/context pickers, MCP `list_*`/`get_*`, agent
runs (they call the same tools as the running user) and Trino queries.

## Credentials

This module **never handles raw credentials in the approval path**. Inviting a user
assigns **role + membership** only; account creation / passwords are **OS-native**
(scrypt-hashed, `lib/core/password.ts` + `lib/platform-admin`) — no external identity
provider. The governance approval surface itself takes no `password`.

## Dual pattern (live + offline-mock)

Every adapter is authoritative **in-process** (so it works with no cluster) with a
**best-effort write-through** to the real backend (OPA `PUT /v1/data/grants`,
Langfuse ingestion, OpenSearch mirror). When the backend is unreachable the effect
is **clearly marked `live:false`** and the teaching flow still proves the decision.

## API (`app/api/governance/*`)

| Route | Verbs | Purpose |
|---|---|---|
| `/api/governance/approvals` | GET · POST | scoped queue; decide → effect → audit (+ standing) |
| `/api/governance/approvals/seed` | POST | demo-seed seam (Builder/Admin); `seedGovernanceDemo` now returns `[]` — the real sources (Software/Agents/Data/Connections) reconcile at consolidation |
| `/api/governance/policies` | GET · POST | consolidated plane; Admin override |
| `/api/governance/audit` | GET | searchable record + chain integrity |
| `/api/governance/cost` | GET · POST | list / set caps |
| `/api/governance/cost/check` | POST | enforcement seam (over-cap → 403) |
| `/api/platform-admin/access` | GET · POST · PATCH | invite / role-per-domain / deactivate (OS-native, scrypt) |

## Tests

`node --test 'lib/governance/*.test.ts'` (part of `npm test`). Covers the gate:
scope (Builder=domain vs Admin=tenant; non-Builder can't deploy), approval→effect
(deploy / access-grant / egress / promote / autonomous), Admin override, cost caps
(over-cap blocked), audit who/when/why + chain, approve-&-remember.

## What's mocked on `kind`

The egress proxy and live LiteLLM calls are
**mocked** (marked `live:false`). The **policy/access/egress plane is real
in-process** (so the consumer truly can query, the endpoint truly is allowlisted).
Identities are OS-native (no external IdP). A real deploy reconciles these into
OPA/LiteLLM.
