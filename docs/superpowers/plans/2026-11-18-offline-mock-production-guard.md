# Offline-mock must be impossible in a deployed cluster — one kernel tripwire

**Filed:** 2026-11-18 · **Branch:** `fix/offline-mock-production-guard` (from `public/main`
`7c524586`) · **Phases:** PLAN → DESIGN → IMPLEMENT (test-first) → TEST, one commit each.

## 1. The defect, as verified on this head

`tabs/metrics/lib/build/explore-server.ts` decides whether a metric may fall back to a
hash-seeded fabricated number with:

```ts
function metricsMustBeLive(): boolean {
  return config.deploymentProfile !== 'local';
}
```

and `core/kernel/config.ts:596` reads that profile from the environment:

```ts
deploymentProfile: env('OS_PROFILE', 'local'),
```

`OS_PROFILE` is set **nowhere** in `charts/`, `values*.yaml`, `deploy/` or `scripts/` — verified
by grep on this head. `config.ts` itself records the consequence twice, at lines 655 and 673:

> *"the live deploy runs `OS_PROFILE=local` with `NODE_ENV=production`, so a profile-keyed guard
> would be inert precisely where it matters"*

…which is exactly why `runtimeBearerAuthAllowed` and `assertNoDevDefaultSecretsInProd` are keyed
on `NODE_ENV`. The honesty gate in the metrics path was keyed on the one variable the deploy does
*not* set, so on the STACKIT cluster `metricsMustBeLive()` is **false** and an unreachable Trino
yields `mockRows()` — labelled `offline-mock`, but fabricated.

The same inversion holds for every other engine the OS degrades around:

| Decision site | Decides on | On the cluster today |
|---|---|---|
| `tabs/metrics/lib/build/explore-server.ts` | `metricsMustBeLive()` → `OS_PROFILE` | fabricated rows |
| `tabs/data/lib/ingest.ts` | `dataRunnerReachable()` | fabricated table + preview, `mode:'offline-mock'` |
| `tabs/data/lib/build/server.ts` | `queryToolReachable()` | in-memory build reported as a build |
| `tabs/data/lib/publish-server.ts` | `queryToolReachable()` | `verifyDomainTable → true` (a fallback that reports success) |
| `tabs/data/lib/reconcile-server.ts` | `queryToolReachable()` | sweep verifies nothing, reports fine |
| `tabs/agents/lib/build/server.ts` | reachability of the build adapters | `mode:'offline-mock'` build report |
| `tabs/software/lib/scan.ts` / `review.ts` | nothing — the label is a **default parameter** | `scan.mode` is *always* `offline-mock`, and the scan gates deploy approval |
| `tabs/connections/lib/connection-adapters.ts` | which live clients were injected | fabricated "128 rows ingested" op rows |
| `tabs/connections/lib/store.ts` `executeMock` | no live executor registered | fabricated tool answers to agents |

In the agent run of 2026-11-18 the create / transform / build data tools all ran in offline-mock
and no agent noticed, because the only signal was a `mode` field in a response body — advisory,
droppable, and never consulted by the caller.

This is the failure mode `os-ui/ARCHITECTURE.md` already names under *Things this codebase will
punish you for*: **"Beware a fallback that reports success."** The repo's own answer to the same
problem in the Software tab (`tabs/software/lib/seeded-evidence.ts`) is instructive: it made the
label **structural at the gate** instead of advisory at the edge. That is the shape to copy.

## 2. Required outcome

In a deployed cluster offline-mock must be **impossible by default**, and the fallback must be an
**honest refusal** instead. The local teaching flow (laptop, kind, `./scripts/os up`) must keep
working exactly as today.

## 3. The design choice

Two candidate designs were considered.

**(A) Fix `OS_PROFILE`** — set it in the chart and keep every gate keyed on `deploymentProfile`.
Rejected: it keys the guarantee on a variable that is *absent by default*, so a chart regression,
a `--reuse-values` upgrade or a hand-rolled manifest silently re-opens the hole. It also leaves
nine independent gates with nine chances to forget one, which is how we got here.

**(B) One explicit kernel switch + one predicate — CHOSEN.**

```
core/kernel/offline-mock.ts        offlineMockAllowed() · refuseOfflineMock(reason)
                                   offlineMockRefusal(reason) · OfflineMockRefusedError
```

* `OS_OFFLINE_MOCK` takes `allow` | `refuse`. Unset ⇒ **`refuse` whenever
  `NODE_ENV === 'production'`**, `allow` otherwise. `NODE_ENV` is the one variable the deploy
  *does* set (`images/base/os-ui/Dockerfile:36`), and it is the same key the two existing
  fail-closed guards at `config.ts:655` / `config.ts:673` use — deliberately, for this exact
  reason. Anything other than the exact string `allow` resolves to `refuse`, so a typo can never
  open the door (the `softwareBuilder` precedent in `config.ts`).
* Every site that *chooses* offline-mock calls `offlineMockAllowed()` — nothing else. One
  predicate, one tripwire, one place to read to answer "can this cluster fabricate?".
* Refusing is typed: `OfflineMockRefusedError` carries `status: 503` and
  `code: 'ENGINE_UNAVAILABLE'`, so `core/mcp/server.ts` `structuredError` — the one error-mapping
  door — surfaces it to an agent as `{ error: { code: 'ENGINE_UNAVAILABLE', … } }` with
  `isError: true`. Value-returning paths use `offlineMockRefusal(reason)`, which is
  `{ ok: false, code: 'ENGINE_UNAVAILABLE', unavailable: true, reason }` — the shape the metrics
  explorer's existing `unavailable` branch already serves. **Never a row.**
* The chart sets the variable **explicitly** in `soa.osUI.runEnv`, which is the one list both the
  `os-ui` Deployment (via `soa.osUI.env`) and the `os-ui-worker` Deployment include — so the
  worker that executes agent runs cannot diverge from the UI. A new `osUI.offlineMock` values key
  documents it, defaulting to `refuse`.

`deploymentProfile` keeps its job (deployment identity on Settings) and is **not** removed; it
simply stops being load-bearing for honesty.

## 4. Scope — what changes, and what deliberately does not

### Deciders (must consult the predicate)

| File | Change |
|---|---|
| `core/kernel/offline-mock.ts` | **new** — the predicate, the refusal, the typed error |
| `core/mcp/server.ts` | `structuredError` maps the typed refusal to `ENGINE_UNAVAILABLE` |
| `tabs/metrics/lib/build/explore-server.ts` | `metricsMustBeLive()` → `!offlineMockAllowed()` |
| `tabs/data/lib/ingest.ts` | unreachable runner + refuse ⇒ throw the typed refusal |
| `tabs/data/lib/build/server.ts` | unreachable query-tool + refuse ⇒ throw |
| `tabs/data/lib/publish-server.ts` | the verifier no longer returns `true` when it cannot verify |
| `tabs/data/lib/reconcile-server.ts` | the sweep refuses rather than verifying nothing |
| `tabs/agents/lib/build/server.ts` | unreachable build adapters + refuse ⇒ throw |
| `tabs/software/lib/scan.ts` | the `offline-mock` default parameter is gone; the mode is decided |
| `tabs/software/lib/review.ts` | the review card carries the scan's decided mode |
| `tabs/connections/lib/connection-adapters.ts` | one gate before any mock adapter branch |
| `tabs/connections/lib/store.ts` | `executeMock` refuses instead of answering |

### Not changed (labels and propagators)

Type unions, UI badges and functions that merely carry a `mode` they were handed are *not*
decisions and are left alone: `tabs/metrics/lib/build/server.ts`,
`tabs/dashboards/lib/build/panel-query.ts`, `tabs/monitoring/lib/**` (its demo fixtures are
already `NODE_ENV`-keyed off in production — `config.ts:430`), every `*.tsx`, and every
`ui/shared.ts`. `tabs/data/lib/reconcile-server.ts` `domainTableMissing` keeps its
don't-cry-wolf `false`: it fabricates nothing, it declines to *flag*, and throwing out of a
detail read would break the page. Recorded as an open item rather than silently changed.

## 5. The tests

Test-first, in this order.

1. **`core/kernel/offline-mock.test.ts`** — the predicate's truth table: unset +
   `NODE_ENV=production` ⇒ refuse; unset + dev ⇒ allow; `allow` ⇒ allow in both; `refuse` ⇒
   refuse in both; `ALLOW`/`yes`/`true`/`''` ⇒ refuse (closed allow-list, not a boolean parse).
   The typed error's `status`/`code`, and the refusal value's shape.
2. **`core/kernel/offline-mock-tripwire.test.ts`** (requirement d) — greps every non-test file
   under `tabs/**` and `core/**` for the literal `'offline-mock'` and partitions them against two
   pinned lists, `DECIDERS` and `LABELS`. Every `DECIDER` must import
   `@core/kernel/offline-mock`; a file in neither list fails the test by name. So a *new*
   offline-mock code path cannot be added without either routing through the predicate or being
   deliberately classified as a label.
3. **`core/kernel/offline-mock-production.test.ts`** (requirement e) — with
   `NODE_ENV=production` and `OS_OFFLINE_MOCK` unset, and the engines made unreachable:
   the metrics explorer returns `rows: []` + `mode: 'unavailable'`; the data ingest throws
   `ENGINE_UNAVAILABLE` and registers no Bronze; the software security scan refuses rather than
   returning `passed: true`. Each asserts on the *absence of a fabricated value*, not on a label.
4. **`core/mcp/offline-mock-tool-error.test.ts`** — `structuredError` maps the typed refusal to
   `{ code: 'ENGINE_UNAVAILABLE' }`, so an agent tool call never receives a row.
5. **A chart assertion** in `scripts/check-worker-env.mjs`'s sibling gate: `OS_OFFLINE_MOCK` is
   present in the rendered `os-ui` **and** `os-ui-worker` env.

Local dev stays green because the suite does not set `NODE_ENV=production` — the default is
`allow`, byte-identical to today. The three tests above set it per-case with a restore.

## 6. Gates

`npm --prefix os-ui test` · `bash os-ui/scripts/gate.sh` · `node scripts/check-structure.mjs`
(ceilings `TAB-ISOLATION 419` / `LEGACY-IMPORT 1` / `CORE-INDEPENDENCE 200` / `FILE-HEADER 1233`)
· `helm lint charts/sovereign-agentic-os -f values.local.yaml`. New files carry the SPDX and
`FEATURE:` / `USER STORY:` / `ARCHITECTURE:` headers, so the FILE-HEADER count must not move.

## 7. What an operator must do

The chart sets the flag explicitly, so a normal `helm upgrade` needs **no** value change:
`osUI.offlineMock` defaults to `refuse`. A teaching install that wants the laptop flow in a
cluster sets `--set osUI.offlineMock=allow`, deliberately and visibly.

---

## 8. Outcome (TEST phase, 2026-11-18)

### Gates, measured on `fix/offline-mock-production-guard`

| Check | Result |
|---|---|
| `npm --prefix os-ui test` | **exit 0** — 6310 tests, 6306 pass, **0 fail**, 4 todo |
| `bash os-ui/scripts/gate.sh` | **exit 0** — 436 tests, 432 pass, 0 fail, 4 todo; all four chart/allowlist checks pass |
| `node scripts/check-structure.mjs` | **exit 0** — "ok (no new violations)" |
| ratchet | `TAB-ISOLATION 419` · `LEGACY-IMPORT 1` · `CORE-INDEPENDENCE 200` · `FILE-HEADER 1233` — all unmoved |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| `helm lint charts/sovereign-agentic-os -f values.local.yaml` | **exit 0** — 1 linted, 0 failed |
| `node scripts/check-worker-env.mjs` | **exit 0** — and now also asserts `OS_OFFLINE_MOCK` is explicit on both pods and renders `refuse` on a DEFAULT install |

No baseline moved. The whole suite stays green because it never sets
`NODE_ENV=production`, so the predicate answers `allow` and every pre-existing offline-mock
test is unaffected — which is the property that made it safe to change nine places at once.

### What the tripwire now pins

53 non-test files under `tabs/**` + `core/**` name `offline-mock`. They are partitioned into
**9 deciders** (import *and* call the predicate), **1 recogniser** (`core/mcp/server.ts` —
imports it to map a refusal, must not decide) and **43 labels** (types, badges, propagators,
tool descriptions, reachability probes — must not import it at all). A file in no list fails
by name.

The two judgement calls, recorded because a later reader will want them:

* **`tabs/connections/lib/connection-adapters.ts` is gated at the three branches that invent
  a fact** — an unprobed "reachable ✓", and the `128` / `42` / `17`-row sync seeds. The static
  tool PRESETS, the credential capture and the placeholder OAuth token the real callback
  overwrites keep their `offline-mock` label ungated: they ran offline but invent nothing, and
  refusing them would break connection creation for no honesty gain.
* **`tabs/software/lib/review.ts` moved from decider to label.** It used to decide via
  `securityScan(files, opts.scanMode ?? 'offline-mock')`; that default is gone, so the engine
  is decided once, in `scan.ts`.

### Open items, with reasons

1. **No live security scanner is wired.** With the gate closed, a software deploy on a real
   cluster **cannot be approved** until Semgrep / Trivy / gitleaks is wired behind
   `securityScan(files, 'live')`. That is the honest state — `decide_deploy` approves only on
   `scan.passed`, and a pass from an engine that never ran is the defect — but it is a real
   product gap, not a side effect to be shrugged at. The two-entry hardcoded "known-bad deps"
   list standing in for an OSV/Trivy feed is untouched.
2. **No live connection sync client exists** (`lib/connection-clients.ts` was never written),
   so "Enable data usage" and "Test connection" now refuse on a cluster instead of returning a
   seed. Same shape of gap: the refusal is correct, the missing client is the work.
3. **`tabs/data/lib/reconcile-server.ts` `domainTableMissing` keeps its don't-cry-wolf
   `false`** when the engine is unreachable. It fabricates nothing — it declines to *flag* —
   and throwing out of a single-dataset detail read would break the page. Deliberate, not
   overlooked.
4. **`runVerified`'s `catch` still labels a thrown exception `mode: 'offline-mock'`**
   (`connection-adapters.ts`). It is a mislabel on an `ok: false` row, never a fabricated
   success, so it was left alone to keep this change inside its brief.
5. **`OS_PROFILE` is still unset everywhere.** Deliberately not fixed: `deploymentProfile` is
   now deployment *identity* only (shown on Settings), and the tripwire fails if a decider
   ever keys on it again. Setting it would re-create the temptation.
6. **Not deployed, not merged** — per the brief. The branch is pushed and one PR is open.

### The Helm value an operator must set

**None.** `osUI.offlineMock` defaults to `refuse` and the chart writes `OS_OFFLINE_MOCK`
explicitly into both the `os-ui` and `os-ui-worker` env, so a normal `helm upgrade` closes the
hole with no values change. Verified on a default render by `scripts/check-worker-env.mjs`.

The only reason to set anything is to go the *other* way — a teaching install that wants the
labelled worked examples inside a cluster:

```
--set osUI.offlineMock=allow
```

`values.local.yaml` (the kind/laptop profile) already carries `osUI.offlineMock: allow`.
