<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Power BI

Computes the **Power BI connection details** a builder needs to wire Power BI Desktop
to their domain's governed metrics via Cube's Postgres-wire SQL API. This module
never touches live data and never dereferences a password — it returns exact
`Get Data → PostgreSQL` field values plus a `passwordRef` (a vault path) that the
caller resolves through the secrets manager. Everything here is pure computation.

## Golden path

1. **Request** — `app/api/powerbi/connection-info/route.ts` receives a GET from the
   UI (builder or above, domain-scoped).
2. **BI principal** — `biUserForDomain(domain)` in `principal.ts` returns the
   deterministic, domain-scoped read-only username (e.g. `bi_acme`).
3. **Security context** — `securityContextForDomain(domain)` returns the Cube
   `securityContext` object that enforces domain-level RLS in query routing (NOT
   per-user — all BI users in a domain share one principal).
4. **Connection info** — `getPowerBiConnectionInfo(domain, exposure)` in
   `connection-info.ts` assembles the final response: `server`, `database`, `user`,
   and `passwordRef`. The `passwordRef` is a vault path struct — the actual credential
   is never fetched here.
5. **Display** — the UI renders the three plain-text fields and shows a "Copy from
   vault" action for the password; the builder pastes them into Power BI Desktop.

## Public API

- **`connection-info.ts`** — `getPowerBiConnectionInfo(domain, exposure)`: returns
  `{ server, database, user, passwordRef }`. The sole entry point; called from
  `app/api/powerbi/connection-info/route.ts`.
- **`principal.ts`** — `biUserForDomain(domain)`: deterministic BI username string.
  `securityContextForDomain(domain)`: Cube security context for domain-scoped RLS.

Both files are pure functions — no I/O, no side effects, safe to test without mocks.

## Invariants & Dependencies

**Invariants**

- **Password is never dereferenced.** `getPowerBiConnectionInfo` returns
  `{ source: 'vault', secretName, key }` — a pointer, not a value. The caller (the
  route handler or the UI) is responsible for the secrets-manager retrieval path.
- **Domain-scoped RLS only.** `securityContextForDomain` enforces a domain boundary,
  not a per-user boundary. All BI principals for a domain are identical; individual
  user identity is not propagated to Power BI.
- **Read-only by construction.** The SQL API host/port/enabled flag comes from
  `lib/core/config`; there is no write path, no DDL, and no mutation surface in this
  module.
- **Pure.** Neither file performs network I/O, database queries, or file system access.
  Inputs are domain slug + exposure config; outputs are plain objects.
- **Enabled gate.** If `lib/core/config` reports the SQL API as disabled,
  `getPowerBiConnectionInfo` throws before returning any struct.

**Dependencies**

- `lib/core/config` — SQL API host, port, and enabled flag (`sqlApiHost`,
  `sqlApiPort`, `sqlApiEnabled`).
