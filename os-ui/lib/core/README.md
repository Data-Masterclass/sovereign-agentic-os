<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Core

`lib/core` holds the **cross-cutting primitives that every other layer may import**.
It describes the platform's type vocabulary — users, roles, artifacts, scopes,
lifecycle states, versions, tabs — and the minimal runtime glue (config, session,
auth) that ties those types to the request context. Nothing in `lib/core` imports
from outside itself; it is the base layer of a strict one-way dependency graph.

## Public API

Import from `@/lib/core` or the named deep path — never from internal files
directly. The files below are the stable surface:

- **`config.ts`** — the single `config` object. All backend URLs, secret refs, and
  feature flags are read from environment variables here. `server-only`; never
  import in client components.
- **`auth.ts`** — `CurrentUser` type, `requireUser()` helper. Bridges the signed
  cookie session to a typed user object. Throws `401` when no valid session exists.
- **`session.ts`** — signed-cookie session helpers. Owns the `Role` union type
  (`creator | builder | domain_admin | admin`).
- **`scopes.ts`** — artifact visibility scopes: `Personal`, `Shared`, `Certified`.
  Used in OPA policy inputs and every store's filter logic.
- **`lifecycle.ts`** — `LifecycleState` enum (`Draft → Active → Deprecated →
  Archived`) plus the allowed-transition table.
- **`versioning.ts`** — semantic version parse/compare/bump utilities; used by
  stores that track `semver`-versioned artifacts.
- **`git-versioning.ts`** — Forgejo Git-commit versioning helpers (Phase E). Do
  **not** modify without consulting the Phase E spec.
- **`artifact-model.ts`** — the shared `Artifact` base type. Every governed
  artifact (dataset, metric, agent, …) extends this shape.
- **`artifacts.ts`** — in-process artifact registry and OS-mirror client for
  cross-tab discovery.
- **`tabs.ts`** / **`tab-nav.ts`** — tab-id constants and navigation utilities
  used by the shell and individual tab routes.
- **`url-params.ts`** — typed search-param helpers.
- **`markdown.ts`** — server-side markdown → HTML renderer (no client bundle).
- **`password.ts`** — bcrypt helpers for local credential hashing.
- **`ratelimit.ts`** — sliding-window rate-limit primitive (Redis-backed).
- **`componentDocs.ts`** — component metadata registry used by the design system.
- **`licenses.ts`** — SPDX license list and validation helpers.

## Invariants

- **Zero external imports.** `lib/core` imports no other `lib/` sub-package. Any
  utility that needs `lib/infra` or higher does not belong here.
- **Types first.** Types exported from here are the authoritative definitions;
  downstream layers must not redefine them.
- **Server-only where stated.** `config.ts`, `auth.ts`, and `session.ts` carry
  the `server-only` guard. Importing them in client components is a build error.
- **No side effects at module load.** Files here may initialise singletons lazily
  but must not fire network calls or DB queries at import time.

## Dependencies

| Imports from | — |
|---|---|
| External packages | `next`, `iron-session`, `bcryptjs`, `marked`, … |
| Internal `lib/` | **none** |

Layers that import `lib/core`: `lib/infra`, `lib/mcp`, `lib/tabs/*`, `lib/assistant`, and every app route.
