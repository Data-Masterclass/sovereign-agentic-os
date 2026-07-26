<!-- SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG -->

# `lib/git` — per-user Forgejo token mint

## Purpose

Handles per-user short-lived, repo-scoped Forgejo access token minting (ADR 0006, #146 Phase 2 Option B). The `sos git` credential helper — used by the analytics monorepo CLI flow — calls the mint route, which calls this module.

The module is a pure orchestration layer: it takes a `ForgejoAdminClient` interface (injected by the route), the caller's OS identity (from the session, never from the request body), and mint options. It ensures the caller's mirrored Forgejo user exists and mints a short-lived, repo-scoped token AS that user. No network code lives here — the real Forgejo client is injected — making the mint logic unit-testable against an in-memory fake.

## Public API surface

- **`forgejo-admin.ts`** — `ForgejoAdminClient` interface + `MintedForgejoToken` type. The three admin-API operations needed: `ensureUser`, `createToken`, `deleteTokensByPrefix`.
- **`forgejo-users.ts`** — `ensureForgejoUser`: idempotently mirror an OS user into Forgejo (no usable password exposed).
- **`token-mint.ts`** — `mintForgejoToken`: the top-level orchestration. Sweeps stale OS-minted tokens for the caller, ensures the user exists, mints a new token, returns the `MintResult` contract (`{ token, username, expiresAt, scopes, forgejoBaseUrl }`).
- **`live-clients.ts`** — the real `ForgejoAdminClient` implementation backed by the Forgejo `/api/v1` admin REST API (basic-auth, same credentials as the registry→git mirror).
- **`token-route.test.ts`**, **`token-mint.test.ts`**, **`forgejo-users.test.ts`** — unit tests against in-memory fakes (no network).

There is no `index.ts`; the route imports specific files directly.

## Invariants

- **Token value is write-only / one-time.** The `token` field appears only in the `MintResult` returned to the authenticated caller. It is never logged, stored in the registry, or committed. The token name (non-secret; carries username + mint epoch) is what the revoke path uses.
- **Identity comes from the session.** The OS principal is resolved server-side; the request body cannot influence who the token is minted for.
- **Bounded token footprint.** Minting first sweeps the caller's prior OS-minted tokens by name-prefix so stale tokens don't accumulate. A sweep failure for a single stale token is swallowed; a wholly-unreachable Forgejo throws.
- **No `server-only` / Next imports in the pure mint logic.** `token-mint.ts` and `forgejo-admin.ts` are free of framework imports and unit-testable directly. `live-clients.ts` is the network boundary.
- **Scope is always at minimum `['analytics']`** (the shared analytics monorepo). Additional repos can be requested but are filtered to what the caller may access.
