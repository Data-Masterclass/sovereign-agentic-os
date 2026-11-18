<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# The My → Domain → Company promotion audit (every artefact kind)

**Date:** 2026-11-18 · **Branch:** `fix/promotion-audit` · **Trigger:** the owner hit
`0 requested · 1 failed` promoting files as an admin. The cause was a *documentation gate*
(description + ≥1 tag) whose refusal text the bulk UI discarded — and the question that
followed: *"check also promotion of all other artifacts."*

## The axis under audit

**Audience** — `My → Domain → Company` — moved ONLY by promotion:
a creator/builder **proposes** (`request_promotion`), a **domain_admin** approves My→Domain,
an **admin** certifies →Company. The approval record is always
`kind: artifact_promote | dataset_promote | file_promote`, `approverRole: 'domain_admin'`,
`scope: 'domain'` for rung 1 and `promote_certify` / `approverRole: 'admin'`, `scope: 'tenant'`
for rung 2.

**Lifecycle** — `Draft · Testing · Live` — is the OTHER axis
(`core/kernel/object-lifecycle.ts`, pins in `core/infra/lifecycle-pins.ts`). It is version-pin
based, `lifecycle-adapters.ts` states *"the persisted tier … for the audience badge only. Never a
lifecycle input"*, and **no promotion effect in this audit touches a pin**. Stream V of
`docs/superpowers/plans/2026-11-14-metrics-dashboards-chat-software.md` owns that axis. The one
place the two words collide is the Knowledge workflow's own legacy `status: 'draft'|'live'` field,
which `publishWorkflow` flips alongside visibility — that field is NOT the lifecycle pin and is
not read by `lifecycleOf`; it is recorded below and deliberately left alone.

## The seam, as built

```
UI button / MCP tool
      │
      ├─ promoteOrRequest(kind,id,user)            core/policy/ladder.ts
      │     ├─ owner + NOT approver  → fileArtifactPromotion → approvals queue
      │     └─ otherwise             → promoteThroughSeam → applyEffect
      │
      └─ decide_approval / POST /api/governance/approvals
            └─ applyEffect(approval, approver, buildEffectDeps())   core/policy/effects.ts
                  └─ applyLadder → the ONE per-kind promote/certify dispatch
```

`canApprove` (`core/policy/roles.ts:157`) refuses **the requester**, whatever their rank —
four-eyes (A2 review L-G). That rule is correct and stays; it is also the root of two dead ends
found below.

---

## AUDIT MATRIX

Legend: ✓ = correct · ✗-fixed = broken, fixed on this branch · ✗-open = broken/divergent, left
open with a reason.

### a) UI entry point → route/tool

| Kind | UI entry | calls |
|---|---|---|
| dataset | `tabs/data/ui/DataBuilder.tsx:1059` (`requestPromote` L594) · certify L1080/L1084 | `POST/GET /api/data/datasets/[id]/promote`, `…/certify` · MCP `request_promotion`, `approve_promotion`, `request_certification` |
| file (server side) | `tabs/files/ui/FilePreview.tsx:179` · `FilesBrowser.tsx:370` (bulk — **owned by another agent**) | `POST/GET /api/files/[id]/promote` · `POST /api/files/[id]/transition` (certify/unshare/decertify) · MCP `request_promotion`, `approve_promotion` |
| knowledge (workflow) | `tabs/knowledge/ui/WorkflowView.tsx:669-692` | `POST /api/knowledge/workflows/[id]/publish` `{action:'publish'\|'certify'}` · MCP `publish_knowledge`, `request_promotion`, `request_certification` |
| knowledge (personal) | `app/(experimental)/knowledge/page.tsx:344` | `POST /api/knowledge/personal/[id]/promote` |
| connection | `tabs/connections/ui/ConnectionBuilder.tsx:635` → shared `PromoteButton` | `POST/GET /api/connections/[id]/promote` · MCP `promote_connection`, `request_promotion` |
| metric | `tabs/metrics/ui/MetricBuilder.tsx:665` → shared `PromoteButton` | `POST/GET /api/metrics/[id]/promote` · `POST /api/metrics/govern` · MCP `promote_metric` |
| dashboard | `tabs/dashboards/ui/DashboardBuilder.tsx:315` → shared `PromoteButton` | `POST/GET /api/dashboards/[id]/promote` · MCP `request_promotion` (`kind:'dashboard'`) |
| agent system | `tabs/agents/ui/SystemView.tsx:456` (`post('promote')`) | `POST/GET /api/agents/systems/[id]/promote` · MCP `request_promotion` (`kind:'agent_system'`) |
| software app | `tabs/software/ui/SoftwareBuilder.tsx:581` (`promote()` L473) | `POST/GET /api/apps/[id]/promote` · app-tab MCP `promote` (`platform-mcp.ts:472`) |
| artifact (kernel) | **none** — `/api/artifacts/[id]/promote` is orphaned (no UI caller; only `…/dependents` is fetched) | MCP `request_promotion` (`kind` enum omits it, `isLadderKind` accepts it) |
| app deploy | `SoftwareBuilder.tsx:435` `deployAction` | `POST /api/apps/[id]/deploy` → `request_deploy` / `decide_deploy`. **Lifecycle, not audience** — recorded for completeness only. |

### b) Gates + exact refusal text / status

| Kind | Gates | Refusal text · status |
|---|---|---|
| dataset | owner-only trigger; tier must be `dataset`; **silver or gold built**; transparency (docs) gate; approver in-domain + `canTransition`→**builder**; physical publish must succeed | `Only the dataset owner can request its promotion` 403 · `This dataset is already promoted` 409 · `Promote a Silver or Gold version — Bronze raw data is not shareable` 400 · `Cannot promote — <gap>. Complete the documentation first.` 400 · `A promotion is approved by a Builder in the dataset's domain` 403 · `Physical publish FAILED — "<name>" stays a private dataset (tier unchanged): <err>` |
| file | owner-only trigger; tier `dataset`; **documentation gate** `promotionGate` = owner + domain + **description** + **≥1 tag**; approver in-domain + `canTransition`→builder; docs gate re-checked; `assertGrantsWithinAuthority` | `Only the file owner can request its promotion` 403 · `This file is already shared` 409 · **`Cannot promote — add a description, at least one tag first.` 400** ← *the owner's 1 failed* · `Promotion blocked — add … first` 400 · `A promotion is approved by a Builder in the file's domain` 403 |
| knowledge (workflow) | `canPromote(role,'Personal')` = **domain_admin+** to publish; `canPromote(role,'Shared')` = admin to certify; view gate; status/visibility conflicts | `Only domain admins and admins can publish workflows` 403 · `Workflow is already published` 400 · `Only admins can certify workflows to the marketplace` 403 · `Workflow must be published before marketplace certification` 400 · `Workflow is already in the marketplace` 400 |
| knowledge (personal) | `roleAtLeast('domain_admin')` / `admin`; view gate | `Only domain admins and admins can promote knowledge` 403 · `This knowledge is already promoted` 409 · `Promote this knowledge to the domain before certifying` 409 |
| connection | ladder: owner-only trigger, tier Personal; applier `promoteConnection` re-gates role+domain | `Only the connection owner can request its promotion` 403 · `This connection is already promoted` 409 |
| metric | role via `canTransition` (**builder** promote / admin certify); **consistency gate** (documented + defined + resolves); **dataset tier ceiling**; dataset must already be materialised | `This metric is already certified` 409 · `consistency gate: <detail>` 403 · `dataset tier ceiling: '<ds>' is <tier>, so this metric cannot be promoted to <tier> — promote the dataset first` 403 · `Promote the underlying dataset to a governed asset in the Data tab first …` 409 |
| dashboard | `canTransition`→**builder** promote / admin certify (`governDashboard`) | `promote (dataset→asset) requires Builder` 403 · `certify (asset→product) requires Admin` 403 |
| agent system | `canGovern` (owner/domain_admin/admin) then `canPromote` = **domain_admin+** / admin | `Not permitted to promote this system` 403 · `An installed (forked) system cannot be re-published` 400 · `Promoting to Shared requires a Domain admin or Admin` 403 · `Publishing to the Marketplace requires an Admin` 403 |
| software app | in-domain; `canPromote` = **domain_admin+** / admin; cascades the app's data artifact through the same ladder | `You can only promote apps in a domain you belong to` 403 · `Promoting to Shared requires a Domain admin or Administrator` 403 · `Already in the Marketplace` 400 |
| artifact | in-domain; `canPromote`; `certified-copy` refused | `Certified copies cannot be promoted` 400 · `You can only promote artifacts in a domain you belong to` 403 · `Promoting to Shared requires a builder or admin` 403 (message says *builder*, the gate is domain_admin — **text/gate mismatch**) |

### c) Does the UI SHOW that refusal verbatim?

| Kind | single path | bulk path |
|---|---|---|
| dataset | ✓ `setShareErr(data.error …)`, rendered at L1287. Minor: a failed **gate** GET is swallowed (`if (pRes.ok)` + bare `catch{}`) so the button renders enabled with an unknown gate → **✗-fixed** | n/a |
| file | server already answers verbatim; `FilePreview` surfaces it | bulk UI discarded the reason — **owned by the other agent**; server side adds `requested:true` so the bulk counter can be honest → ✗-fixed (server half) |
| knowledge (workflow) | `setPubError(d.error ?? 'Failed')` ✓ **but** `publish()` has **no `catch`** and a bare `res.json()`: a 502/HTML/network failure shows **nothing**; no `reload()` after filing; the route's `indexing:{ok:false,…}` warning is never read (published-but-unretrievable reads as success) → **✗-fixed** | n/a |
| knowledge (personal) | ✓ verbatim + `requested` branch + reload | n/a |
| connection · dashboard · metric | ✓ shared `PromoteButton` (`setErr(msg)` + `toast.error`) | n/a |
| agent system | **✗-fixed** — the route's `{requested:true}` 200 hits no branch in `post()`; the user gets no error, no toast, no pill, and `reloadAll()` shows unchanged visibility: promote looks like a **no-op** | n/a |
| software app | **✗-fixed** — `promote()` dereferences `body.app.visibility` unconditionally, so the `{requested:true}` 200 throws `Cannot read properties of undefined` and the user is shown that TypeError instead of "request filed" | n/a |
| artifact | no UI → ✗-open (documented, not invented) | n/a |
| approvals inbox (every kind) | **✗-fixed** — the route flattens an effect throw to the literal `error: 'Effect failed'` (the real message goes only to audit + `effect.applied`), and the inbox does **not** `load()` on a non-ok response, so the card still reads *pending* and the verbatim cause never appears | n/a |

### d) Approval kind · approverRole/scope · can an owner-approver request *and* approve?

| Kind | kind / approverRole / scope | owner-who-is-also-approver |
|---|---|---|
| dataset | `dataset_promote` / `domain_admin` / `domain` (default) | **✗-fixed — DEAD END.** The route and `request_promotion` ALWAYS file. `canApprove` then refuses the requester → a single-admin tenant can never promote its own dataset. |
| file | `file_promote` / `domain_admin` / `domain` | **✗-fixed — DEAD END** (same shape; this is the owner's actual situation). |
| every ladder kind via MCP | `artifact_promote` / `domain_admin` / `domain` | **✗-fixed** — `fileArtifactPromotion` files for ANY owner, including a domain_admin/admin owner, who is then barred from approving. The UI routes avoid it via `promoteOrRequest`; MCP did not. |
| every ladder kind via UI | as above | ✓ — `promoteOrRequest` one-shots for an owner with the authority. |
| metric | `artifact_promote` with `payload.artifactKind:'metric'` | **✗-fixed — the request can NEVER be applied** (see (e)). |
| rung 2, all kinds | `promote_certify` / `admin` / `tenant` | ✓ owner-admin certifies in one shot; a builder/domain_admin files. |
| creator approving | — | ✓ refused everywhere: `minRole` floor on `decide_approval`/`approve_promotion`, `canApprove` rank check, and the per-kind store gate as defence in depth. |

### e) What approve actually does

| Kind | effect |
|---|---|
| dataset | `publishPromotion` → **physical** governed CTAS **as the approver**, probe + OPA push + conformance, tier flips only on ✓; `publish:{ok,fqn,mode}` recorded. Lineage via the store. Lifecycle untouched. ✓ |
| file | `applyApprovedFilePromotion` → tier dataset→asset, **bytes re-governed to the domain prefix** (`deepLink` re-derived), grants persisted after `assertGrantsWithinAuthority`, `file_promoted` lineage edge. Lifecycle untouched. ✓ |
| knowledge (workflow) | `publishWorkflow` → `visibility: 'Shared'` **and `status: 'live'`** (legacy field, not the lifecycle pin); certify → `Marketplace` + best-effort OKF freeze. git write-through. ✓ (noted) |
| knowledge (personal) | `promotePersonalKnowledge` / `certifyPersonalKnowledge` → visibility flip + write-through. ✓ |
| connection / artifact / app | injected `LadderApplier` → single-rung visibility flip as the approver; app cascades its data artifact and files. ✓ |
| dashboard | `transitionDashboard` → tier flip + a real git commit (the directory moves between the personal lane and the domain tree). ✓ |
| agent system | `promoteSystem` → visibility flip + `writeThrough` with an `OS-*`-trailered commit. ✓ |
| **metric** | **`applyLadder` has NO `metric` case** → `throw new Error('unknown ladder artifactKind: metric')`. MCP: `Effect failed — request left pending: …` 502; UI: the literal `Effect failed` 502. Worse, a metric's tier **IS** its dataset's tier (`tabs/metrics/lib/store.ts`: `tier: TIER_OF[d.tier]`), so `tier==='personal'` ⟺ the dataset is still private, and the approver path then always answers `Promote the underlying dataset … first` 409. **A metric has no independent audience rung at all.** ✗-fixed as an honest refusal — *not* by inventing a path. |

### f) UI refresh after approve

Inbox `load()` on success ✓, **not** on 502 → ✗-fixed. `useApprovalNotifier`'s inline *Approve now*
(`core/policy/approval-notice.ts:68` `canApproveInline`, fail-closed) calls `onApproved`, which
re-fetches in each host ✓ — except the two hosts that never wired the notifier
(`SystemView`, `SoftwareBuilder.promote`) → ✗-fixed.

### g) Company certification path

| Kind | request → approve → Company |
|---|---|
| dataset | ✓ `request_certification` / `/certify` → `dataset_certify` → admin |
| knowledge (workflow/personal) · connection · dashboard · app · agent system | ✓ `promote_certify` → admin (`request_certification` enum, or the per-kind route's rung-2 branch) |
| artifact · personal_knowledge | path exists via `isLadderKind` but the tool **enums omitted them** → ✗-fixed (enum extended) |
| file | **no request path** — certify is a direct admin `POST /api/files/[id]/transition {transition:'certify'}`. ✗-open, documented. |
| metric | derived from the dataset: an admin's certify transitions the **dataset** asset→product. ✗-open by design, documented. |

---

## FIX LIST

**Server**

- **S1** dataset + file promote become *promote-or-propose*: an OWNER who already holds rung-1
  approver authority (`canPromote(role,'Personal')`) promotes in ONE shot through the existing
  apply path (`publishPromotionLive` / `applyApprovedFilePromotion` — every gate, including
  `assertGrantsWithinAuthority`, unchanged); everyone else files as before. Closes the dead end
  without touching four-eyes. Routes + MCP `request_promotion`.
- **S2** MCP `request_promotion` for ladder kinds routes through `promoteOrRequest`, so MCP and the
  UI are the same front door.
- **S3** `/api/knowledge/workflows/[id]/publish`: `canAct` for rung 1 becomes
  `canPromote(role,'Personal')` (domain_admin+), matching `publishWorkflow`. A **builder owner**
  now FILES a request instead of taking a 403 dead end.
- **S4** metric: stop filing the un-appliable `artifactKind:'metric'` request. Refuse with the real
  reason — *"A metric's audience is its dataset's audience: promote the dataset '<name>' to Domain
  in the Data tab and this metric follows."* 409 — in the route, its GET, and `promote_metric`.
- **S5** `request_promotion` / `request_certification` enums gain `personal_knowledge` and
  `artifact`.
- **S6** `/api/files/[id]/promote` adds `requested: true` beside `approval` (additive; the bulk
  counter can then be honest).
- **S7** `/api/governance/approvals` 502 carries the **real** thrown message in `error`.

**UI**

- **U1** `SystemView.tsx` — handle `{requested:true}` (notifier + pill).
- **U2** `SoftwareBuilder.tsx` `promote()`/`demote()` — guard `body.app`, handle `{requested:true}`.
- **U3** `WorkflowView.tsx` — `res.json().catch(()=>({}))`, a real `catch`, reload after filing,
  and surface `indexing:{ok:false}`.
- **U4** `ApprovalsInbox.tsx` — refresh on failure too, so `effect.applied` becomes visible.
- **U5** `DataBuilder.tsx` — report a failed gate fetch instead of silently enabling the button.

**Docs** — `tabs/files/guide.md` (the documentation gate's exact reason), `tabs/metrics/guide.md`
(the dataset-derived audience), `tabs/data/guide.md` (the Silver/Gold + transparency refusals).

## NOT fixed, on purpose

- **The rung-1 approver floor is of two minds.** `canPromote` says **domain_admin+**
  (knowledge/connection/artifact/app/agent_system) while `canTransition` says **builder**
  (dataset/file/dashboard/metric) — and `ladder.ts`'s own docstring says *"APPROVE = a Builder+ of
  that domain"* while every enqueued record says `approverRole: 'domain_admin'`. The queue is
  fail-closed at domain_admin, so no creator ever approves; but a *builder* can still one-shot a
  dashboard or metric it owns. Aligning the floor is a governance decision for the owner, not a
  bug fix, so it is recorded here and left alone.
- **`/api/artifacts/[id]/promote` has no UI.** Kernel artifacts are promoted as a side effect of
  the owning app. Left as-is rather than inventing a surface.
- **Metrics / files have no independent certification request.** Stated above; documented, not
  invented.
- **Knowledge's legacy `status:'live'`** stays coupled to publish. Decoupling it is stream V's
  lifecycle work, not this branch's.

## Tests

`core/policy/promotion-matrix.test.ts` — ONE cross-kind file that imports **only `@core/*`**
(so `CORE-INDEPENDENCE` cannot grow) and drives every kind in-process through the real dispatcher
`handleRpc` as creator / builder / domain_admin / admin principals, pinning per kind:

1. the refusal text is surfaced verbatim with the right code;
2. a request is enqueued with the right `kind` / `approverRole` / `scope`;
3. approve flips the audience and leaves the lifecycle pin untouched;
4. a creator can never approve, and a requester can never approve their own item;
5. an owner who holds the authority has a working one-shot path (no dead end).

Plus source tripwires (files read as TEXT — a test may not import a `.tsx`) for U1–U5.

## Gates

`os-ui/node_modules/.bin/tsc --noEmit -p os-ui` · targeted tests · ONE full-suite run
(`node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test
--test-concurrency=2 'core/**/*.test.ts' 'tabs/**/*.test.ts'`) · `bash os-ui/scripts/gate.sh` ·
`node scripts/check-structure.mjs` must not exceed 419 / 1 / 200 / 1230.

---

# DESIGN

## The one constraint that shapes every fix

`scripts/check-structure.mjs` counts **CORE-INDEPENDENCE per import statement** (a regex over
`from '…'`), and the baseline is exactly **200**. So *no file under `os-ui/core/` may gain a new
`@tabs/*` import statement* — not even the test file. Two consequences:

1. New shared logic must live in a module `core/` **already** imports, so the added names ride an
   existing `import { … } from '@tabs/…'` statement (adding names to the braces matches no new
   `from`). That is why `promoteDatasetOrPropose` goes into `tabs/data/lib/publish-server.ts` and
   `promoteFileOrPropose` into `tabs/files/lib/store.ts` — both are already imported by
   `core/mcp/experimental/promotion-write-tools.ts` and by `core/policy/effects.ts`.
2. `core/policy/promotion-matrix.test.ts` drives everything through `handleRpc`
   (`@core/mcp/server`) and `@core/policy/approvals` **only**. No tab import, no reset-store
   import — `node --test` gives each file its own process, so a fresh queue per file plus
   `__resetApprovals()` per test is enough.

The same constraint rules out adding a `metric` case to `applyLadder` (it would need
`@tabs/metrics`), which is a second, independent reason the metric fix is an honest refusal rather
than a new applier.

## Signatures

```ts
// tabs/data/lib/publish-server.ts  (server-only, already holds publishPromotionLive)
export async function promoteDatasetOrPropose(
  id: string, user: Principal, opts?: { visibility?: DataVisibility; grants?: Grant[] },
): Promise<
  | { promoted: true; dataset: Dataset; publish: { ok: boolean; fqn: string; mode?: string } }
  | { propose: true; request: PromotionRequest }
>;

// tabs/files/lib/store.ts
export function promoteFileOrPropose(
  id: string, user: Principal, opts?: { visibility?: DataVisibility; grants?: Grant[] },
): { promoted: true; asset: FileAsset } | { propose: true; request: FilePromotionRequest };
```

Both are pure compositions of code that already exists:

```
promote…OrPropose(id, user, opts)
  req = requestPromotion(id, user, opts)      // owner-only + docs/transparency gate, verbatim
  if canPromote(user.role, 'Personal')        // the rung-1 APPROVER authority, unchanged
      -> apply as the owner-approver          // publishPromotionLive | applyApprovedFilePromotion
                                              //   (in-domain + canTransition + docs re-check
                                              //    + assertGrantsWithinAuthority all intact)
  else -> { propose: true, request: req }     // the caller enqueues, exactly as today
```

Why `requestPromotion` runs **first** on both branches: it is the owner-only trigger and the
documentation gate. Running it before the direct apply means the one-shot path cannot skip a gate
the proposing path enforces, and the refusal the owner sees is byte-identical either way.

Why the enqueue stays in the callers: `tabs/files/lib/store.ts` must not grow a `server-only`
dependency (`@core/policy/approvals` imports it) — the store is imported from non-server places.
The function therefore returns the *request*, and the route and the MCP tool enqueue it with their
existing wording.

Why this does not widen access: the direct branch requires **owner AND
`canPromote(role,'Personal')`** — i.e. a domain_admin/admin promoting their own asset, which is
precisely the pair of authorities the two-step path would have combined anyway. Nobody gains a
right they did not already hold; the only thing removed is the impossibility of exercising both.

## The metric refusal, verbatim

```
A metric's audience is its dataset's audience — promote the dataset “<name>” to Domain in the
Data tab and this metric follows.
```

409, from `/api/metrics/[id]/promote` (POST), its GET (which must stop reporting a phantom pending
request) and `promote_metric`. Written into `tabs/metrics/guide.md` as the documented gate.

## Ordering

IMPLEMENT is test-first: `core/policy/promotion-matrix.test.ts` is written and red before any
production edit, then S1–S7 and U1–U5 turn it green. The `.tsx` fixes are pinned by source
tripwires in the same file (a test may not import a `.tsx`, so the file is read as text and the
required branch asserted by pattern).

---

# TEST — what was run, and what it proved

`core/policy/promotion-matrix.test.ts` — **19 tests**, importing `@core/*` only and driving every
kind in-process through `handleRpc` as creator / builder / domain_admin / admin (plus a builder in
a foreign domain, who is the only principal that can prove the no-existence-leak answer, because a
creator never clears `decide_approval`'s rank floor at all).

Per kind — knowledge, agent system, app, dashboard, file, dataset — it pins:

1. **the refusal is verbatim.** The documentation gate answers
   `Cannot promote — add a description, at least one tag first.` and, when only one half is
   missing, names only that half. Bronze-only answers
   `Promote a Silver or Gold version — Bronze raw data is not shareable`.
2. **the request is the right request** — `artifact_promote` / `file_promote` /
   `dataset_promote`, `approverRole: 'domain_admin'`, `scope: 'domain'`, requester recorded,
   and filing twice is idempotent (exactly one pending row).
3. **approve flips the audience and nothing else** — read back through each kind's own getter,
   and `livePin(kind, id)` is unchanged across the promotion, so the lifecycle axis is untouched.
4. **a creator can never approve** — not their own request, not anyone else's; a plain builder
   cannot decide a domain_admin rung; an out-of-domain builder gets `not_found`; and a refused
   decision leaves the request pending.
5. **rung 2** — `promote_certify` / `approverRole: 'admin'` / `scope: 'tenant'`; a domain admin is
   refused with "a platform Admin", and the admin's approve reaches Company.
6. **the owner-approver is not dead-ended** — dana files and then decides her own audience
   request, and the asset really reaches Domain.
7. **the carve-out is narrow** — a creator owner is still refused (rank), a domain admin still
   cannot certify her own filing (scope), and a parked agent run (`runId`) still refuses the
   requester absolutely.
8. **metrics** — a legacy `artifactKind: 'metric'` queue item refuses with the sentence that names
   the dataset, and stays pending; and a source tripwire asserts neither front door files one.

Six source tripwires cover the `.tsx` fixes (a test may not import a `.tsx`, so each component is
read as text and the required branch asserted by pattern — a tripwire proves the branch exists,
never that it renders).

## Gate results

| Gate | Result |
|---|---|
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | clean |
| targeted suites (MCP waves, policy, data, files, dashboards) | 185 / 185 |
| full suite, one run | **6466 tests · 6462 pass · 0 fail · 4 todo** (the 4 todo are pre-existing `{ todo: 'fixed in Phase 1/2' }` markers in `tabs/agents/lib/build/os-tools.test.ts`) |
| `bash os-ui/scripts/gate.sh` | exit 0 — 436 tests, 0 fail, 4 todo; `check-litellm-allowlist: PASS` |
| `node scripts/check-structure.mjs` | 419 / 1 / 200 / 1230 — at baseline, no new violations |

## Design notes that changed during IMPLEMENT

The DESIGN section above proposed promote-or-propose at BOTH front doors. Driving it through the
real dispatcher showed that was the wrong half of the problem to fix: twenty existing assertions
across `core/mcp/wave-a`, `wave-b`, `refine-0164`, `write-tools` and `tabs/data/lib/*` encode an
owner-who-is-also-approver filing and then applying their own request through
`approve_promotion` — which **never had the four-eyes check**. So the deadlock was not that
`request_promotion` files; it was that the two front doors disagreed about whether an
owner-approver may decide, and the Governance inbox said no. Fixing `canApprove` instead keeps
`request_promotion`'s contract ("it files"), makes both doors agree, and needs no test rewritten.
The promote-or-propose helpers were kept for the two UI routes, where a one-click promote matches
every other kind's route, and are pinned by a tripwire.

Two findings the audit matrix did not predict, both found by the tests rather than by reading:

- **dashboard promotions were unapprovable** — `transitionDashboard` read through the owner-only
  view gate, so the appointed approver could not see the record.
- **a metric's tier IS its dataset's tier**, so `tier === 'personal'` can only mean the dataset is
  private; the "file a request" branch was unreachable-by-design in one direction and
  un-appliable in the other.

---

# REVIEW ROUND — what the independent review found, and what it changed

The first pass fixed the dead ends and the swallowed refusals. The review found that two of those
fixes had their own holes, and that one of them had quietly widened a different thing.

## H1 — a pending request was readable by anyone authenticated

Both promote routes and the MCP tool ran the duplicate-request lookup **before** the owner check
and returned the whole `Approval`. So while a request was open, any authenticated principal —
including a creator in another domain — could POST a guessed id and read the asset's name, owner,
domain and the queued payload *including its policy grants*. The first pass had even written a
test that documented the leak ("the dedup branch would otherwise hand ben the owner's existing
pending handle") instead of closing it, which is the worst possible artefact: a test that pins a
bug in place.

Fixed by ordering: `requestPromotion` (the owner-only trigger and the documentation gate) runs
first on every branch, so the dedup is only ever reached by the owner, and it answers
`{ requested: true, already: true, approvalId }` — a handle, never the record. The test now walks
five foreign principals against a pending request and asserts both the refusal and that no
response contains the asset's name, its grants or its payload keys.

## H2 — a one-shot promotion left no trace

`promoteThroughSeam` dropped `effect.audit`, and the new one-shot routes wrote no approval record
at all. So the audience moves most likely to matter — the ones an admin makes on their own
artefact — appeared in no audit log and in no Governance queue. An un-recorded promotion is
invisible to exactly the people the queue exists for.

Both paths now mint the record, self-approve it (`source: 'ladder'`, `decidedBy` naming who did
it), record the effect on it, and write the effect's own audit entry. The two routes additionally
go **through `applyEffect`** rather than calling the appliers directly, so there is one seam, one
audit shape and one failure contract for every audience move, whoever makes it. The two
`promote…OrPropose` helpers are gone — the flow belongs at the server boundary, not in a store.

## DECISION — four-eyes stays at Company

`AUDIENCE_PROMOTION_KINDS` included the certify kinds, which would have let a lone platform admin
file **and** certify their own artefact company-wide. That is a much larger blast radius than
sharing inside one domain, and not the deadlock the carve-out exists to clear (rung 2 is filed by
a Builder/Domain-admin of the domain, so there is normally somebody else to ask). The set is now
rung-1 only — `artifact_promote`, `dataset_promote`, `file_promote` — and a test pins both halves:
the certify kinds refuse the filer, the rung-1 kinds admit them.

**Open for the owner:** relaxing this for a genuinely single-admin tenant is a one-line change to
that set. It is deliberately *not* taken here.

## M1–M5, L1–L4

- **M1** The HTTP door decided and then applied, so a request whose effect could not run (a legacy
  metric request, a gate refusal) was marked `approved` with nothing applied. It now applies first
  and leaves a failure **pending**, matching the MCP door. **L3**: the catch keeps the gate's own
  status (`e.status ?? 502`) — a refusal and an outage are different facts.
- **M2** `approve_promotion` consulted neither `canApprove` nor `runId`, so a parked agent run's
  promotion could be cleared there *as the approver*, skipping resume-as-runner and silently
  re-attributing the write. Both gates added; a parked run is now a typed 409 pointing at
  Governance.
- **M3** One documented response shape per route, in the route header:
  `{requested:true, promoted:false, approval}` · `{requested:true, already:true, approvalId}` ·
  `{promoted:true, requested:false, approvalId, applied, …}`.
- **M4** `publishWorkflow` guarded on `rec.status === 'live'` while lines below are its only
  setter, so a Personal-but-live workflow filed a request this function would always reject. The
  guard is now on the AUDIENCE axis (`visibility !== 'Personal'`), which is what a promotion moves.
- **M5** Driving `connection`, `personal_knowledge` and `artifact` end-to-end found **a third
  unapprovable kind**: a "My knowledge" entry is owner-only to view — stricter than a workflow
  draft, which Builder+ in-domain may read — so `promotePersonalKnowledge` could not see the record
  it was approving. Same resolution as dashboards: the owner's filed request is the consent, and
  the fix is a governance read, not a weaker privacy rule. `personal_knowledge` has no MCP door, so
  its row of the matrix lives in `tabs/knowledge/lib/promotion-matrix.test.ts` (a tab test may
  import its own tab; the core file may not).
- **L1** The metric promote GET answered `{request:null}`, so the button rendered enabled and every
  click was a 409. It now returns `gate: { ok:false, reason, datasetId }` for the Personal tier and
  the shared `<PromoteButton>` disables itself and shows the sentence.
- **L2** The widened dashboard read had been applied in `resolveLadderArtifact`, which five call
  sites reach — including certification filing, where it would have let an in-domain builder read a
  Personal dashboard's name. It is now opt-in per call site (`forGovernanceAct`), passed only by the
  approve-half and the effect's own `transitionDashboard`.
- **L4** Two tripwires were satisfied by the comment prose they were meant to police. Every tripwire
  now matches against a comment-stripped copy of the source, and asserts identifiers, property
  names, status codes and **call ordering** (gate before dedup, apply before decide) rather than
  sentences.
