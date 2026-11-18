# Software app-building, end to end — drive it as a real user, fix what breaks

> **Owner's words (2026-11-19):** *"make sure that the software app building is truly working end to
> end. and check and fix everything for that."*
>
> **Method.** Not a code review. Drive the WHOLE chain in-process through the real dispatchers —
> `callPlatformMcp` (the Software tab's MCP door) and the extracted service functions the HTTP
> routes call — as **creator**, **builder**, **domain_admin** and **admin**, with the configuration a
> deployed cluster actually has (`NODE_ENV=production`, `OS_OFFLINE_MOCK=refuse`,
> `SOFTWARE_BUILDER=spec` and `=agentic` with the LLM stubbed deterministically). Every stage gets a
> row in the table below: **what the user sees · what actually runs · what broke · the fix · the test
> that pins it.** Where a step cannot be true on the cluster today, this plan says so plainly **and**
> the UI/MCP is changed to say so honestly — never a fabricated "deployed".

**Branch:** `fix/software-e2e`, from `public/main` at `7c45bd95`.
**Deliverable test:** `os-ui/tabs/software/lib/e2e-golden-path.test.ts` — the entire chain, in process,
as four principals, asserting each stage's governance (holds, refusals, SoD) and its artefacts.

**Not mine, by agreement (other agents own them, in parallel):**
- the **security scan** — `tabs/software/lib/scan.ts`, the scan half of `review.ts`, the `ReviewCard`
  scan block, a Trivy Job, the admin "approve without scan" hatch. Treated here as a **dependency**
  with the two shapes it already declares: `live` and `unavailable`.
- `.github/**`, `scripts/deploy.sh`, `scripts/gate.sh`.

---

## 0. The chain, as the OS actually defines it

There are **two** paths, and conflating them is the root of most of what is broken.

| | **Declarative (`serveMode: 'spec'`)** | **Coded (`serveMode: 'image'`)** |
|---|---|---|
| Default? | **yes** — `create_software` defaults to `kind:'spec'` (`platform-mcp.ts:243`) | no — **off** unless a platform admin enables coded apps (`apps.ts:1596-1603`, 403) |
| What the app *is* | a validated **AppSpec** of cookbook-pattern tabs over governed data | a source tree under `apps/<slug>/` in the domain git repo |
| Who serves it | the trusted OS renderer, **same-origin**, at `/apps/<slug>` (`app/apps/[slug]/page.tsx`) | an image/pod at its own subdomain — **no CI runner and no image builder exists in this repo** |
| Author verb | `generate_app_spec` → review → `set_app_spec` (= versioned publish, live immediately) | `build_software` → author code → `push_app_files` / `commit` → `verify_software` → `request_deploy` → `decide_deploy` |
| Go-live gate | **none** — `setAppSpec` flips `serveMode` and the app is live | the review card + a second pair of eyes |

The stage *numbering* in the MCP tool descriptions (`STAGE 1 · DEFINE`, … `STAGE 4 · BUILD APP`)
is written for the **coded** path only, while the **default** app kind is declarative. That mismatch
is finding **F2** below and it is the single biggest cause of the owner's dead end.

### The doors, located

| Stage | MCP tool (registered) | Service function it delegates to | Role floor |
|---|---|---|---|
| 1 Define | `create_software` — `platform-mcp.ts:99` | `createApp` — `apps.ts:1580` | creator |
| 2 Design + Choose Context | `design_software`, `set_app_design` | `patchAppDesign` — `apps.ts` | owner / owning-domain builder+ |
| 3 Author (declarative) | `generate_app_spec` — `platform-mcp.ts:117` | `generateAppSpecForApp` — `appspec/generate-server.ts:46` | owner / owning-domain builder+ |
| 3 Author (declarative) | `set_app_spec` — `platform-mcp.ts:111` | `setAppSpec` — `apps.ts:1317` | owner / owning-domain builder+ |
| 3 Read-modify-write | `get_app_spec` | `getAppForUser` + `describeApp` | visibility-gated |
| 4 Build (coded) | `build_software` — `platform-mcp.ts:103` | `buildGate` + `stageDirective` — `mcp-stages.ts:105,143` | visibility + design-before-build |
| 4 Build (agentic) | `build_software` with `SOFTWARE_BUILDER=agentic` | `agenticBuild` — `builder/loop-server.ts` | same |
| 4 Push code | `push_app_files` — `platform-mcp.ts:168` | `pushAppFiles` — `push-app-files.ts` | owner / owning-domain admin |
| 5 Test | `verify_software` | `stageDirective(…, 'test')` + `assertNotSeeded` | visibility |
| 6 Scan + request | `request_deploy` | `requestDeploy` — `review.ts:316` | creator (owner) |
| 7 Decide | `decide_deploy` | `decideDeploy` — `review.ts:502` | **builder+**, requester ≠ approver |
| 8 Preview | `start_preview` | `startPreview` — `review.ts:265` | owner only |
| 9 Serve | — | `resolveServeTarget` — `served-app.ts`; page `app/apps/[slug]/page.tsx` | app visibility |
| 10 SDK | — | `core/app-sdk/*`; `callAppTool` — `app-tool-call.ts` | four-layer intersection |
| 11 Lifecycle | `promote`, `archive`, `delete` | `promoteThroughSeam`, `archiveApp`, `deleteApp` | builder+/admin for promote |
| 12 Git | `push_app_files`, `read_app_files` | `commitAppTree` — `git-commit.ts:158` | — |

---

## 1. Findings — stage by stage

Filled in as the chain is driven. Each row: **what the user sees · what actually runs · what broke ·
the fix · the test that pins it.**

### F1 — `set_app_spec` never normalises the model's shapes · **the owner's error, on the door Claude uses**

- **What the user sees.** `set_app_spec` returns `{ ok:false, issues:[{ reason: "metric must be an
  object", fix: "use { metricId }" }] }` and persists nothing — for a spec the OS can read perfectly
  well. This is the error the owner hit.
- **What actually runs.** `setAppSpec` (`apps.ts:1330`) calls `parseAppSpec(spec)` **directly**.
  The tolerant pre-validation normaliser `normaliseSpecShapes` (`appspec/normalise.ts:97`) — written
  for exactly this bug — is wired into `parseGeneratedSpec` (`appspec/generate.ts:224`) only, so it
  protects `generate_app_spec` and the spec *assistant* and **nothing else**.
- **What broke.** Three doors onto the same bytes bypass it: `setAppSpec` (the MCP author =
  publish door, and `PUT /api/apps/[id]/spec`), `saveAppDraft` (`apps.ts:1386`, the composer's
  autosave) and `publishApp` (`apps.ts:1410`, which re-parses the stored draft). An agent that hand-
  authors a spec — the documented alternative to `generate_app_spec`, see `guide.md` — gets the
  rejection the normaliser exists to prevent.
- **The fix.** Normalise at the **door**, not at one caller: `setAppSpec` / `saveAppDraft` /
  `publishApp` run `normaliseSpecShapes` before `parseAppSpec`, and the rewrites come back as
  `warnings` (the user is told what was tidied, so the coercion is never silent). `parseAppSpec`
  itself stays strict — the stored spec remains canonical.
- **The test.** `e2e-golden-path.test.ts` stage 3 authors a spec with a bare `"metric": "<id>"` and a
  `{ id }` metric through `set_app_spec` and asserts `ok:true` + the warning naming the rewrite;
  plus a unit case in `set-app-spec.test.ts` for each of the three doors.

### F2 — `build_software` / `verify_software` are kind-blind, and route the **default** app into a 403 dead end

- **What the user sees.** On the default (declarative) app, `build_software` returns a directive that
  says *"Author the code, then call `commit`"* with a code-structure convention
  (`src/epics/<epic>/<story>/Page.tsx`) and a vendored-React API contract. The agent writes code and
  calls `commit`, which answers **403 — "Coded apps are disabled by the platform administrator"**
  (`platform-mcp.ts:369-374`). There is no onward move the directive offers.
- **What actually runs.** `platform-mcp.ts:263` (`build_software`) and `:289` (`verify_software`)
  branch only on `agenticBuilderEnabled()`. `stageDirective` (`mcp-stages.ts:143-168`) is kind-blind
  and ends with the coded-path instruction unconditionally. The UI's own stage model **does** know
  the difference (`ui/stages.ts` carries an `isSpecApp` gate), so this is an **MCP-only** dead end —
  on the door the owner and Claude actually use.
- **What broke.** The declarative golden path has no stage-4 verb. `guide.md` documents
  `generate_app_spec`/`set_app_spec` for step 3 and never mentions `build_software`; an agent
  following the tools' own `STAGE 1…4` numbering walks into the coded path instead.
- **The fix.** Make both stage tools kind-aware off `serveModeOf(app)`:
  - a **spec** app's `build_software` returns the **declarative** build directive — the granted
    context, the implemented pattern cookbook, the current spec state and honest story coverage, and
    `next: generate_app_spec → review → set_app_spec`. It never mentions `commit` or `src/`.
  - a **spec** app's `verify_software` verifies the **live spec** (its validation verdict, the
    `describeApp` legibility summary, per-story coverage) instead of instructing the agent to read
    committed code that does not exist.
  - the coded directives are unchanged byte-for-byte for `serveMode: 'image'`.
- **The test.** `e2e-golden-path.test.ts` stage 4, both kinds; plus `mcp-stages.test.ts` cases
  asserting the spec directive never contains `commit`/`src/epics` and the image directive still does.

### F3 — the same-origin render does not apply the app-grant intersection

- **What the user sees.** A **Shared** spec app shows a viewer everything **they** may see among the
  app's sources, not the grant-narrowed subset the app declared.
- **What actually runs.** `app/apps/[slug]/page.tsx` documents this in its own header
  (`NOTE(appspec-grant-scope)`): the same-origin render applies `canView` + RLS but **not**
  `checkAppGrant`, which only fires for cross-origin requests carrying the app slug.
- **Posture.** More-permissive, never less — and already written down. **Recorded, not fixed here:**
  carrying the app slug into the same-origin data reads is a change to every pattern renderer's
  fetch, which is outside a bounded end-to-end pass. It is in §4 "still not true".

*(further findings appended as the chain is driven)*

---

## 2. The stage-by-stage table

| # | Stage | Broke? | Fix | Test |
|---|---|---|---|---|
| 1 | create | | | |
| 2 | design | | | |
| 3 | spec | **yes — F1** | normalise at the three spec doors | `e2e-golden-path` s3, `set-app-spec` |
| 4 | build (spec + agentic) | **yes — F2** | kind-aware stage directives | `e2e-golden-path` s4, `mcp-stages` |
| 5 | verify | **yes — F2** | kind-aware verify | `e2e-golden-path` s5 |
| 6 | scan | *(other agent)* | dependency: `live \| unavailable` | `e2e-golden-path` s6 |
| 7 | request_deploy | | | |
| 8 | decide_deploy | | | |
| 9 | preview / serve | | | |
| 10 | the app's SDK | | | |
| 11 | lifecycle | | | |
| 12 | git | | | |

---

## 3. Phases

- [x] **PLAN** — this document: the two paths, every door located, the first findings.
- [ ] **DESIGN** — the shape of each fix, written before it is built.
- [ ] **IMPLEMENT** — test-first, iterating: `e2e-golden-path.test.ts` drives the chain; each red
      stage gets its fix at the source and a test that pins it.
- [ ] **TEST** — tsc, targeted tests, ONE full-suite run (`--test-concurrency=2`),
      `bash os-ui/scripts/gate.sh`, `node scripts/check-structure.mjs`.

---

## 4. What is true on the cluster today / what is still not

*(the plan's final section — written from what the driven chain actually proved, not from intent)*
