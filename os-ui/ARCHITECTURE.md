<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# os-ui architecture

The Sovereign Agentic OS web app. One rule governs the layout: **everything is
either a tab, infrastructure, or core.** A contributor who learns one tab can
work on any tab, because every tab is shaped the same way.

## The three layers

```
lib/core/     Cross-cutting primitives every layer may import.
              session · config · auth · scopes · lifecycle · versioning ·
              artifact-model · nav (tabs, tab-nav) · errors · small utils
              (markdown, url-params, password, ratelimit). NO tab logic,
              NO external-service IO.

lib/infra/    The governed spine + every external-service client. The ONLY
              layer that talks to OPA, Trino, OpenSearch, LiteLLM, MinIO,
              Forgejo, k8s, the OS-mirror, secrets, mail.
              governed.ts (authorize → queryRun → trace) is the spine every
              tab write goes through. mcp/ is the MCP transport + registry.

lib/<tab>/    ONE module per OS tab (data, knowledge, files, metrics,
              dashboards, strategy, bigbets, agents, software, science,
              connections, governance, marketplace, monitoring, platform-admin,
              home, tutorials). Uniform internal shape (below). A tab imports
              DOWN into core + infra, and NEVER sideways into another tab's
              internals — only through that tab's index.ts.
```

Dependency direction is strict and one-way: **`<tab>` → `infra` → `core`.**
core imports nothing but core; infra imports core; tabs import infra + core.
A tab reaching into another tab's internals is the one thing code review rejects
— cross-tab needs go through the other tab's `index.ts` public API (or an event
/ the os-mirror).

## The tab-module contract

Every `lib/<tab>/` has the same shape. Not every file is required, but when a
concern exists it lives in the file with this name:

| File | Responsibility |
|---|---|
| `index.ts` | The tab's **public API** — the only thing other tabs / routes import. Re-exports the store's operations + the schema types. |
| `schema.ts` | The tab's types (artifact shape, tiers, visibility). Pure. |
| `store.ts` | The **governed adapter** — CRUD/list/promote/lifecycle, each running through `infra/governed` (authorize → act → trace). The seam between the tab and the world. |
| `<feature>.ts` | Pure, unit-tested domain logic (e.g. `promote.ts`, `refine.ts`). No IO — IO is injected so it stays testable. |
| `*.test.ts` | Co-located with the file it tests. |
| `README.md` | One screen: what the tab does, its golden path, its public API, its invariants. |

The matching UI + HTTP:

```
app/<tab>/page.tsx        thin — renders components/<tab>, no business logic
app/api/<tab>/**/route.ts thin — parse request → call lib/<tab> → shape response;
                          auth/authorize/trace happen in lib, not the route
components/<tab>/*.tsx     the tab's React components
components/core/*.tsx      shared UI primitives (PageHeader, tiles, lifecycle
                          controls, badges, DomainTag, ArtifactPanel, useApi/useUser)
```

## Why this shape

- **Consistency = robustness.** Same layout everywhere means fewer surprises,
  easier review, and a collaborator can add a tab by copying the contract.
- **The governed spine is one place.** All authz/trace lives in `infra/governed`
  and each tab's `store.ts` — never scattered — so the governance invariant is
  auditable.
- **Pure logic is testable.** Domain logic (`<feature>.ts`) takes its IO as
  injected dependencies, so it unit-tests without a cluster.

## Migration status

Moving to this layout in phases; the live system stays up (tsc + full suite green
+ deploy between phases). See `CHANGELOG.md` for the phase releases.

**Current state (Phase A complete):** the three-layer contract is in place and
fully inhabited. All `lib/` modules listed in the Phase 1 map below have been moved
to their destinations; `lib/connections` is the reference template (index.ts + schema.ts
+ store.ts + README, full contract). Every `lib/<tab>/` has a README.

- **Phase 0** ✓ — this document + a pilot tab on the contract.
- **Phase 1** ✓ — carved `lib/core` + `lib/infra` out of the loose `lib/*.ts` files.
- **Phase 2** ✓ — all `lib/<tab>` modules have the contract shape + README.
- **Phase A** ✓ — dead-code pruned (`components/knowledge/ContextPanel.tsx` deleted),
  READMEs added to the 13 previously doc-less `lib/` modules.
- **Phase B** (planned) — barrel cleanup: `index.ts` + `schema.ts` in every tab that lacks them.
- **Phase C** (planned) — `lib/models/roles.ts` role-resolution audit.
- **Phase D** (planned) — `components/core` thin-route-handler pass.
- **Phase E** (planned) — `lib/agents/build/live.ts`, `lib/infra/forgejo.ts`, `lib/core/git-versioning.ts` (live-adapter hardening; do NOT touch until Phase E).
- **Phase F** (planned) — OpenMetadata connector promotion.
- **Phase G** (planned) — Hermes lib wiring (currently pure + unwired; the gateway is configured via `lib/core/config` + agent schema, not a lib import).
- **Phase H** (planned) — `components/core` + thin route handlers (Phase 3 original intent).

### Where the loose files landed (Phase 1 map — complete)

| Loose file(s) | Destination |
|---|---|
| `governed.ts`, `agent-governed.ts`, `os-mirror.ts`, `app-registry.ts`, `capability-compiler.ts`, `secrets.ts`, `k8s.ts`, `identity-server.ts`, `mailer.ts`, `tool-proxy.ts`, `tool-sso-langfuse.ts` | `lib/infra/` |
| `config.ts`, `session.ts`, `auth.ts`, `scopes.ts`, `lifecycle.ts`, `versioning.ts`, `git-versioning.ts`, `artifact-model.ts`, `artifacts.ts`, `tabs.ts`, `tab-nav.ts`, `url-params.ts`, `markdown.ts`, `password.ts`, `ratelimit.ts`, `licenses.ts`, `componentDocs.ts` | `lib/core/` |
| `useApi.ts`, `useUser.ts` | `lib/` root (client hooks — `components/core/` move is Phase H) |
| `connections.ts`, `connection-adapters.ts`, `connection-model.ts`, `connections-physical-delete.ts`, `connectors.ts`, `egress-requests.ts` | `lib/connections/` (reference template, fully on contract) |
| `apps.ts` | `lib/software/` |
| `agent-chat-response.ts`, `agent-memory.ts` | `lib/agents/` |
| `governance.ts`, `approvals.ts` | `lib/governance/` |
| `platform.ts`, `platform-components.ts`, `users.ts`, `recovery.ts` | `lib/platform-admin/` |
| `gateway-usage.ts` | `lib/monitoring/` (LLM Gateway lives under Monitor) |
| `data-handoff.ts`, `planning.ts` | `lib/data/` / `lib/strategy/` respectively |

The compiler + the full test suite are the safety net for every move.
