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

---

## 9. Review round (PR #56, 2026-11-18) — H1–H3 blocked merge

An independent review found that §8's partition was **incomplete, and in a way that mattered**:
the tripwire grepped one string over two roots, so it proved less than §8 claimed. The claim is
narrowed throughout the docs accordingly. Per finding:

### H1 (block) — platform-admin spend was invented and raised a real alert. **Fixed.**
`billing/route.ts` and `overview/route.ts` called `offlineSpend(tenant.envelopeEUR)`
**unconditionally** and stamped `source: 'offline-mock'`, so a deployed cluster reported 62% of
its own envelope as spend — derived from the ceiling it was compared against — and
`overview/route.ts` pushed a genuine `Spend at 62% of envelope` warning off it.
*How:* the decision moved OUT of the routes into one door, `tenantSpendView(envelope, cap, live?)`
in `tabs/monitoring/lib/spend.ts`, which consults the predicate. Refused ⇒ `unavailableBilling()`:
`source: 'unavailable'`, **null** `spendEUR` / `premiumSpendEUR` / `pctUsed` / `premiumPctUsed`,
empty `trend`, a `reason`. Null and not zero, because "cannot read spend" and "nothing spent" are
different facts. The overview's alert condition is now an explicit `pctUsed !== null &&` rather
than relying on JS coercion. `SpendSection.tsx` and `OverviewHealth.tsx` render `—` / "not
readable" and the reason. Real LiteLLM figures bypass the gate entirely — it governs only the
invented fallback. `'app'` was added to the tripwire's roots.
*Test:* `tabs/monitoring/lib/spend-honesty.test.ts` (5) — null not zero, the exact alert condition
cannot fire, the typo case, the `allow` opt-in, and that real figures bypass the gate. The routes
are `route.ts` files a test may not import, which is precisely why the decision was moved out.

### H2 (block) — the Files/Knowledge ingest fabricated documents. **Fixed.**
The worst of the lot, and the first tripwire was blind to it because this pipeline spells its
stand-in `mode: 'mock'`. Three sites, six branches: `connectors-live.ts` fell back to the FAKE
DRIVE on a missing token, a non-OK Drive/Graph response **or** an unparseable body — so a broken
connection *indexed files that do not exist in the customer's Drive*; `ingest/live.ts` returned
`mockAdapterFor(kind).apply(input)` when Docling/ASR/OCR was unreachable, so the chunks,
embeddings and every quote drawn from them described a document nobody had read; `embed.ts` wrote
`mockEmbed` **hash vectors**, which have no semantic relationship to each other, so k-NN search
over those rows ranks by a hash while looking exactly like retrieval.
*How:* all six go through `refuseOfflineMock()` with a reason naming the real cause (no token /
HTTP status / unparseable body / which parser / which model), via a small `fakeDrive(provider,
why)` helper in `connectors-live.ts`. Nothing is parsed, embedded or indexed. The tripwire now
greps a marker **set** over three roots.
*Test:* `tabs/files/lib/offline-mock-production.test.ts` (8) — no `RemoteFile`, no representation,
no vector, for each cause; plus three laptop cases proving the teaching flow is intact.
**Not remediable by this PR:** rows written before the fix are in the OpenSearch index and are not
retroactively identifiable. A re-index once the parsers and the embeddings gateway are reachable
is the only remedy. Recorded in `docs/under-the-hood.md` §9.

### H3 (block) — the sandbox upload route flattened every error to 400. **Fixed.**
*How:* `(e as {status?: number}).status ?? 400`, and the error `code` is forwarded when present,
so the refusal reaches the browser as a 503 with its own message instead of "bad request".
*Test:* covered by the typed-status assertions in `tabs/data/lib/offline-mock-production.test.ts`;
the route itself is a `route.ts` a test may not import.

### M1 — the approver UI showed a binary badge. **Fixed.**
"security scan FAILED (0 findings)" read as "we looked and it is broken" when it meant "nothing
looked" — and only one of those is fixed by changing the code.
*How:* `ReviewCard.tsx` renders a third state, `security scan NOT RUN` (warn, not err) with
`scan.reason` beneath, and **disables Approve** with the reason on the button's title and beside
it; Deny stays enabled, because refusing a deploy needs no scanner. `ReviewCardData.scan` gained
optional `unavailable` / `reason`, so a card serialised before this still renders. The Governance
inbox preview string in `review.ts` says `NOT RUN` and labels the counts "from the offline
baseline".

### M2 — no per-subsystem lever. **Documented, deliberately not built.**
Per the owner decision, no per-scan exemption was added. `values.yaml`'s `osUI.offlineMock`
comment and the `_os-ui-env.tpl` comment now state that there is ONE lever, that `refuse` means a
software deploy cannot be approved until a real scanner is wired behind
`securityScan(files, 'live')`, and that flipping the key to `allow` to unblock a deploy re-enables
fabrication tenant-wide — wire the scanner instead. A per-subsystem escape hatch would be filed
under pressure by whoever hit the refusal first, and the whole value of one tripwire is that there
is exactly one place to read to answer "can this cluster fabricate?".

### M3 — `BuildMode` folded `unavailable` into `live`. **Fixed.**
`tabs/metrics/lib/build/server.ts:44` mapped everything that was not `offline-mock` to `live`, so
the one outcome meaning "nothing ran" reported as the one meaning "it really ran". `BuildMode` is
now `'live' | 'offline-mock' | 'unavailable'` and the mapping is explicit.

### M4 — `runVerified` swallowed the typed refusal. **Fixed.**
Its `catch` turned the refusal into `mode: 'offline-mock'` with an error string — the exact label
the refusal exists to prevent, and a 200 where the caller needed a 503. It now rethrows when
`isOfflineMockRefused(e)`.

### M5 — the tripwire's guarantee. **Fixed.**
Its docstring now states, in numbered form, exactly what it guarantees (coverage of a marker SET
over three roots; deciders import *and* call; recognisers import and do not decide; labels do not
import; no decider keys on the profile) **and what it does not**: that no fabrication exists under
a spelling outside the set. H2 is cited there as the reason, so the next reader learns it from the
test rather than from an incident.

### M6 — "Nothing was written." was not always true. **Fixed.**
`publish-server` and `reconcile-server` refuse at the VERIFY step, which runs *after* the promote
CTAS, so a table may exist even though the tier was not flipped. `structuredError` now carries the
refusal's **own** `reason` into the hint and claims only that nothing was *invented*; each site
states its own consequence.

### L1 — `MONITORING_DEMO_FIXTURES` is a second switch. **Documented.**
`core/kernel/config.ts:427-432` keys it on `NODE_ENV !== 'production'`, so it is already off where
it matters; it is deliberately NOT folded into the predicate, so the Monitoring demo fixtures stay
independently switchable. Recorded here, in `docs/under-the-hood.md` Appendix C, and in the
tripwire's LABELS commentary (which is why `monitoring/lib/adapters/*` are labels, not deciders).

### L2 — `tabs/software/lib/scan.ts` is now `server-only`. **Fixed.**
It reads the process environment to decide a verdict, and a decision like that must be unreachable
from the browser bundle, where `process.env` is whatever the build inlined. Both existing importers
are already server-only, so this constrains the next one, not them.

### L3 — `run-trace.ts` `mockTrace(id)` was ungated. **Fixed.**
The run LIST has always been `config.monitoringDemoFixtures ? [...MOCK_RUNS] : []`; the DETAIL was
not, so a deployed Monitoring tab answered "open this run" with invented node timings and invented
logs. Now gated the same way; `fetchTrace` already returns `TraceDetail | null`, so the honest
answer needed no new shape.

### Gates after the review round

| Check | Result |
|---|---|
| `npm --prefix os-ui test` | **exit 0** — 6323 tests, 6319 pass, **0 fail**, 4 todo |
| `bash os-ui/scripts/gate.sh` | **exit 0** — 436 tests, 432 pass, 0 fail, 4 todo |
| `node scripts/check-structure.mjs` | **exit 0** — ratchet unmoved: `419 / 1 / 200 / 1233` |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| `helm lint charts/sovereign-agentic-os -f values.local.yaml` | **exit 0** |

Tripwire partition after the round: **13 deciders · 1 recogniser · 49 labels**, over
`tabs/**` + `core/**` + `app/**`, on five markers.

### The claim, narrowed

The honest headline is **not** "offline-mock is impossible". It is:

> On a deployed cluster, every fabrication path **the marker set covers** is refused by default,
> through one predicate, with a typed `ENGINE_UNAVAILABLE` and no row. Monitoring's demo fixtures
> are governed by a second, `NODE_ENV`-keyed switch. A stand-in introduced under a spelling outside
> the marker set is **not** covered until the set is widened — which is what H2 was, and why the
> tripwire now says so itself.

Two residual labelled-but-ungated `offline-mock` returns remain, deliberately and recorded in §8:
the connection adapters' static tool presets / credential capture / placeholder OAuth token (they
invent nothing), and `domainTableMissing`'s don't-cry-wolf `false` (it declines to flag rather than
asserting anything).

---

## 10. Re-review round (PR #56, 2026-11-18) — two more of the same class

The re-review said MERGE and named two live ungated sites the marker set still missed. **Both are
the same failure as H2, and both were missed for the same reason: a NAME, not a missing gate.**
Twice now. That is itself the finding, and the tripwire's docstring says so.

### (1) `tabs/knowledge/lib/embed.ts` — the identical defect to Files, on the corpus agents cite. **Fixed.**
On a timeout, a transport failure, a 5xx or a wrong-dimension reply it returned
`hashEmbed(t, config.embedDim)` with `source: 'offline-hash'`. A hash of the text is not an
embedding: the vectors bear no semantic relationship, so a k-NN search over them ranks by a hash
while looking exactly like retrieval — and this is the OS's *own* knowledge base, which agents
quote **with a citation**. `index-pipeline.ts:24` propagates `embedSource`, so the rows are written
before anything notices; `core/infra/context/librarian-live.ts:47,68` returning `[]` for an
`offline-hash` batch mitigates the **read** side only. The gate therefore belongs at the write.
*How:* `refuseOfflineMock()` before the hash fallback, with a reason that says why a hash is not an
acceptable stand-in. A **4xx still throws `GatewayRejectedError`** — a decision about this caller
(key, model allowlist, budget) is not an unreachable dependency, and collapsing the two would hide
a fixable misconfiguration behind an outage message. That distinction is asserted.
*Test:* `tabs/knowledge/lib/offline-mock-production.test.ts` (6) — unreachable, 5xx, wrong-dim,
the 4xx distinction, the empty batch (nothing in ⇒ nothing invented), and two laptop cases.

> ⚠️ **Pre-existing `offline-hash` rows in the Knowledge index need a re-index**, exactly as the
> Files index does (§9, H2). They are not retroactively identifiable from the rows themselves: a
> hash vector is indistinguishable from a real one once written. Re-index once the embeddings
> gateway is reachable. This is the second index with this debt, and the two should be re-indexed
> together.

### (2) `tabs/software/lib/app-records.ts:209` — "Sample record A". **Fixed.**
`result ?? seedToolResult(tool, args)` returned two invented rows labelled `source: 'demo-seed'`
whenever the app runner answered nothing. `seeded-evidence.ts` already makes that label
*structural* at the deploy GATES — but the tool RESULT still reached the caller, and `source` is a
response field: an agent that reads `items[]` and summarises them never looks at it. That is
precisely the "a label is not a guard" failure this whole branch exists to close, surviving inside
the module that documents it.
*How:* gated at the one `??`; refused ⇒ a typed `ENGINE_UNAVAILABLE` naming the app, the slug, the
tool and the runner phase, so an agent can route on it and a person knows what to start.
*Test:* `tabs/software/lib/offline-mock-seed-production.test.ts` (4) — all five tool-name shapes
refuse, the refusal carries no seed row, it names the app and tool, plus the laptop and `allow`
cases.

### Marker set, now seven strings plus one pattern
Added `hashEmbed(`, `'offline-hash'`, `seedToolResult(`. The `mode: mock` family moved to a
**quote- and space-tolerant pattern** (`/\bmode\s*:\s*['"]mock['"]/`), because `mode: "mock"`
and `mode:'mock'` are the same fact and a literal `includes` would have missed either variant.
Partition: **15 deciders · 1 recogniser · 56 labels**.

Six files joined LABELS with the widened set, and the reasoning is worth keeping: `embed-core.ts`
*defines* `hashEmbed`; `eval-harness.ts` hashes **both sides** of a comparison over its own
fixtures, which is a self-consistent offline scoring harness standing in for no real read;
`index-pipeline.ts` and `retrieve.ts` carry `embedSource`; `librarian-live.ts` and
`agentic-graph.ts` **read** it as a guard; `tool-exec.ts` defines `seedToolResult`. Defining a
stand-in is not choosing one.

### Gates for this round (scoped, as instructed — not the full suite)

| Check | Result |
|---|---|
| `tabs/knowledge/**` + `tabs/software/**` + the tripwire + the predicate | **exit 0** — 1350 tests, 1350 pass, 0 fail |
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| `node scripts/check-structure.mjs` | **exit 0** — ratchet unmoved `419 / 1 / 200 / 1233` |
