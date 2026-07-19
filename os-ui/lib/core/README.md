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
- **`stages.ts`** — the OS-wide staged-builder model (pure, no React): ordered
  `StageDef`s with `enabled`/`completed` gates plus the `StageState` transitions
  (`advance`, `goTo`, `markDone`, …). Rendered by
  `components/core/StageShell.tsx`. See "Staged builders" below.
- **`url-params.ts`** — typed search-param helpers.
- **`markdown.ts`** — server-side markdown → HTML renderer (no client bundle).
- **`password.ts`** — bcrypt helpers for local credential hashing.
- **`ratelimit.ts`** — sliding-window rate-limit primitive (Redis-backed).
- **`componentDocs.ts`** — component metadata registry used by the design system.
- **`licenses.ts`** — SPDX license list and validation helpers.

## Staged builders (`stages.ts` + `components/core/StageShell.tsx`)

Every tab's guided path wears the SAME staged UX: a numbered stepper rail with
✓ marks, per-stage entry gates, and honest session-tracked progress. The model
lives here (`stages.ts`, unit-tested, framework-free); the visual shell is
`components/core/StageShell.tsx`, which renders the shared `.sb-step*` rail
classes ("guided step rail" in `app/globals.css`). The Agents builder
(`components/agents/SimpleBuilder.tsx`, Define · Design · Build · Run ·
Evaluate) is the reference adoption.

The contract the model guarantees:

- **Opens on the first stage, nothing pre-marked.** A freshly opened artifact
  shows no ✓s even when its persisted state satisfies a stage's condition.
- **`enabled(ctx)` gates entry** — later stages stay unreachable until earlier
  work exists (omit for always-reachable stages).
- **`completed(ctx)` is the live condition.** A ✓ shows only when the user has
  ALSO worked the stage this session (`advance` past it with the condition met,
  or `markDone` when in-stage work settles) — and it clears if later invalidated.
- **`advance` never fakes progress**: it moves only when the next stage is
  enterable and records the current stage only if genuinely satisfied.

### Adoption recipe (per tab)

1. **Declare the path** as a module-level `StageDef<Id, Ctx>[]`, where `Ctx` is
   a small plain object of the live booleans the gates read. Planned stage sets:
   - Data — Define · Ingest · Refine · Publish · Use
   - Metrics — Define · Refine · Preview · Publish · Monitor
   - Dashboards — Define · Design · Build · View · Govern
   - Science — Define · Train · Deploy · Predict · Monitor
   - Software — Describe · Build · Preview · Publish · Operate
2. **Own one `useState`**: `useState(() => initialStageState(STAGES))`, and
   derive `ctx` fresh each render from the tab's stores/props.
3. **Mount `StageShell`** with `stages/state/ctx/onState`. Defaults give you the
   standard stage header (title + one-line `hint`) and gated back/next footer;
   give each stage a `hint` ("what you do here" in one line). Pass an
   `assistant` render prop to mount a stage-scoped helper, `aside` for rail-row
   badges. Tabs with bespoke per-stage headers/footers (Agents) pass
   `showHeader={false} showNav={false}` and drive nav via the `StageApi`
   render-prop (`back`/`next`/`goTo`/`markDone`/`canNext`) or their own
   `goTo`/`advance` calls.
4. **Record in-stage settles** (a build finishing, a run landing) with a
   `markDone(state, stageId)` effect gated on `isSatisfied` and the current
   stage — exactly like the Agents Build/Run/Evaluate effect.

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
