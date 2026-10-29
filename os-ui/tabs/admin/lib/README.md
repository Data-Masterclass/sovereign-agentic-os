<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->
# Platform Admin — tenant control room

The **tenant-scoped, Admin-only** area that sits **above** the per-domain workspace.
Platform Admin **configures** tenant structure + platform operation; **Governance**
enforces/sees it and **Monitoring** watches it. Reached at `/platform` (gated to
`role === 'admin'`); a Builder/User can never open it.

> Scope boundary (do not cross): Platform Admin = tenant-wide & structural. Per-domain
> / per-artifact work is **not** here. **Governance keeps** approvals · policy view ·
> audit · operational caps · in-domain role assignment. **Monitoring keeps** live
> health & spend. Identity / models / egress set here **compile through the policy
> compiler → OPA**, which the rest of the platform enforces.

## Sections (`app/platform/*`) → adapters (`lib/platform-admin/*`) → routes (`app/api/platform-admin/*`)

| Section | Page | Adapter | Route |
|---|---|---|---|
| Overview (cockpit) | `page.tsx` | aggregates all | `overview/` |
| Domains | `domains/` | `domains.ts` | `domains/`, `domains/[id]/` |
| Users & Access | `access/` | `tenant-users.ts` (Ory seam) | `access/`, `access/[id]/` |
| Cost & Billing | `billing/` | `billing.ts` + `tenant.ts` | `billing/` |
| Models & Providers | `models/` | `models.ts` | `models/`, `models/[id]/` |
| Components & System | `components/` | `components-extra.ts` + `lib/platform.ts` | `components/` |
| Security & Egress | `security/` | `security.ts` | `security/` |
| Backups & Restore | `backups/` | `backups.ts` | `backups/` |
| Plugins & Marketplace | `plugins/` | `plugins.ts` | `plugins/` |
| Settings | `settings/` | `settings.ts` | `settings/` |

## The spine

- **`tenant.ts`** — single-tenant context + **multi-tenant isolation**: `assertTenantAccess`
  is a hard 403 on any tenant id other than this cluster's, so one tenant's admin can
  never see another's. (Mirrors the app-tier RLS guarantee, enforced in-process so it
  holds offline too.)
- **`policy-compiler.ts`** — the **one identity/structure source → OPA**. `compile()`
  turns users + roles + domain layers + egress + model enablement into the
  `principal → tools` grant map (low-cardinality attributes encoded as groups, per
  `data-policy-compiler.md`); `publish()` best-effort `PUT /v1/data/grants` to OPA, and
  is honest (`opa-unreachable`) offline. Governance's policy view then reflects the
  compiled rights. Re-run after every identity/domain/egress/model change
  (`app/api/platform-admin/_compile.ts`).
- **`audit.ts`** — the **shared audit record** Governance surfaces. Every mutation calls
  `audit()` (in-process ring + best-effort OpenSearch `os-audit` mirror).
- **`guard.ts`** — **typed-confirmation guard** for destructive actions. `assertGuarded`
  throws `412` unless the caller echoes the exact phrase (`restore <id>`, `disable <id>`).
  The UI mirror is `components/GuardedConfirm.tsx`.
- **`app/api/platform-admin/_ctx.ts`** — every route passes `adminCtx()`: Admin-only
  (`requireAdmin`) → **OPA scope** (`authorize('user:<id>','admin')`, fail-open + marked
  offline) → **tenant isolation** (`assertTenantAccess`).

## Safety invariants (non-negotiable)

1. **Never surface raw secrets.** Provider keys go through `lib/secrets.putSecret`; the
   catalog stores only a `{name,key}` **reference + sha256 fingerprint**. Settings rejects
   any raw-secret field. SSO/account flows go through Ory; invite generates a server-side
   credential that is **never returned** ("no password seen").
2. **Guarded + confirmed + audited** restore and destructive toggles (`guard.ts` + audit).
3. **No prod provisioning from the UI.** Toggles only scale already-provisioned, governed
   workloads `0↔1`; layer flags flip a governed bit. Nothing here creates infrastructure.
4. **Multi-tenant isolation** via `assertTenantAccess` (verify RLS in a real deploy).

## Operational + offline-mock

Each adapter is a thin, **pure** in-memory store/logic module (no `server-only`, no `@/`
alias) so it is unit-testable under `node --test`; the `server-only` wiring
(Ory/users, secrets vault, k8s status, OPA publish, Langfuse audit) lives in the API
routes. With a cluster the routes read live status / publish to OPA; **offline (kind)**
they degrade gracefully (registry status `unknown`, `offline-mock` spend, `opa-unreachable`
compiled-locally) so the teaching flow always renders.

## Tests

`lib/platform-admin/platform-admin.test.ts` — 14 cases: tenant isolation, guard,
policy-compiler (role/active/layers/archived/egress), domains, security allowlist,
**models keys never raw**, billing hard-stop, **guarded restore is 412-without-confirm +
audited**, plugins trust. Run: `npm test` (or `node --test lib/platform-admin/*.test.ts`).
