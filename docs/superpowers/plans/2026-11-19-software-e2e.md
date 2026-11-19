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

### F4 — `request_deploy` on a declarative app reviews the TEMPLATE SCAFFOLD, not the app

- **What the user sees.** A review card whose security scan and diff are over `package.json`,
  `src/App.tsx`, `Dockerfile` … of the `sovereign-app` template — files the app does not use and
  that will never ship.
- **What actually runs.** `appFilesForScan` (`review.ts:199`) returns `getSnapshot(app.id) ??
  templateFiles(...)`. A declarative app has no snapshot, so it always falls through to the
  template seed.
- **Posture.** Recorded in §4. The declarative app is already live at `/apps/<slug>` the moment
  `set_app_spec` validates, so this card is not what gates it — but an approver reading evidence
  about the wrong artefact is still evidence about the wrong artefact. The right shape is to scan
  the spec's own shippable surface (the spec JSON plus each custom block's html/css/js and the
  theme CSS, where a pasted secret actually would live). Not done here: `review.ts`'s scan half is
  another agent's module this round.

### F5 — a missing runner image is reported as a Kubernetes outage

- **What the user sees.** *"Preview runner unreachable — … pending until the Kubernetes API is
  reachable"* — when the Kubernetes API is fine and the app simply has no image.
- **What actually runs.** `deployApp` catches `MissingAppImageError` and returns
  `{ ok:false, live:false, phase:'failed', detail:<the honest reason> }` (`runner.ts:388`). But
  `startPreview`'s note ladder forwards `detail` only when `runner.live && !runner.ok`
  (`review.ts:281`), and `previewPendingNote` keyed solely on `live` — so the explained failure
  fell through to the unreachable note and `detail` was discarded.
- **The fix.** `previewPendingNote` returns `outcome.detail` for an explained `phase: 'failed'`
  outcome. Only a genuinely silent cluster gets the unreachable note.
- **The test.** `review.test.ts` — a fail-closed missing-image outcome's note names the image.

### F6 — `start_preview` attempted an image deploy for the DEFAULT app kind

- **What the user sees.** `start_preview` on a declarative app reports a runner failure for an app
  that is already viewable at `/apps/<slug>`.
- **What actually runs.** `startPreview` never branched on `serveMode`; `runnerAppFor(app)` just
  passes the slug/host/image, so every app went to `deployApp`.
- **The fix.** A `serveMode: 'spec'` app's private preview IS its same-origin served URL, gated by
  the app's own visibility (Personal ⇒ only the owner reaches it). `startPreview` now returns that
  and — when there is no spec yet — says so and names the verb that authors one. No pod is
  attempted, and nothing is fabricated.
- **The test.** `e2e-golden-path.test.ts` stage 9 + `review.test.ts`.

### F7 — `.app/acceptance.json` is honest in its content, and its claim about who reads it is not

- **Content: honest.** `builder/acceptance.ts` derives rather than asserts: `compile` runs the real
  compile gate; `route`/`render` are AST checks whose evidence strings literally say
  `static check (AST)`; `manual` is never machine-passed; anything undecidable is `unknown`, never
  `pass`; and `scored:false` is first-class so `total: 0 · failed: 0` cannot read as clean.
- **Claim: not honest.** `loop-server.ts:71-80` says the record is *"readable by `read_app_files` /
  the review card / the MCP with no new tool"*. A tree-wide grep finds **no reader anywhere**: the
  review card does not carry it. `read_app_files` can read it (it is a file in the committed tree),
  the review card cannot.
- **The fix.** Correct the claim to what is true, and pin the half that is true with a test that
  round-trips the record through `read_app_files`.

### F8 — stale chart fiction: "the runner serves each app as a static SPA (nginx)"

`charts/.../apps-runner.yaml:71` says so; there is no nginx image, and no app-runner image, in
`images/`. The template itself deploys **no workload** — a Namespace, a Role/RoleBinding for the
os-ui ServiceAccount and five NetworkPolicies, so that the os-ui process *could* create per-app
Deployments — and is `enabled: false` by default with `runnerImage: ""`. Comment corrected.

### F9 — `start_preview`'s tool description promises a running instance nothing backs

*"a running instance only you can reach"* (`platform-mcp.ts:131`). With `softwareRunner.enabled:
false` and no image, nothing backs that for a coded app; for the default declarative app the
truth is better than the promise (it is served same-origin, now). Description corrected to say
what each kind actually gets.

### F10 — a grant without `access` was dropped SILENTLY, and the loop had no error in it

- **What the user sees.** `design_software({ grants: { data: [{ id: 'ds_…' }] } })` answers **200**.
  Then `set_app_spec` refuses: *"dataset ds_… is not granted to this app — grant it in Context"*.
  So the author goes back and grants it again. Which drops it again. Three times, and then the
  build is abandoned — with no error message anywhere in the loop.
- **What actually runs.** `normalizeContextGrants` (`core/kernel/context-grants.ts:73`) required a
  **valid `access`** on every entry and filtered the rest out. The declared JSON schema marks
  `access` required, but the dispatcher does not validate against it, so the shape a model writes
  from a worked example (`{ id }`) vanished.
- **The fix.** `normalizeContextGrantsWithReport` is now the implementation and reports everything
  it had to do; `normalizeContextGrants` delegates to it. A **missing** `access` takes `read-only`
  — the narrowest level, so defaulting can only ever under-privilege — rather than vanishing. An
  **unrecognised** access value is still refused (the caller asked for something that does not
  exist and must not be quietly handed a different level) but is now **named** in the report.
  `design_software` and `set_app_design` return the report as `grantNotes`.
- **The test.** `e2e-golden-path.test.ts` stage 2 drives both shapes through the real dispatcher.

### F11 — a creator's app could never leave their lane through the governed ladder

- **What the user sees.** The creator files a My→Domain promotion. The appointed `domain_admin`
  opens it and gets **`not_found`** — on the very artefact they were asked to decide.
- **What actually runs.** `resolveLadderArtifact` passes `forGovernanceAct: true` from
  `promoteThroughSeam` and honours it for `personal_knowledge` and `dashboard`, each of which has
  a dedicated `*ForGovernance` reader. The `'app'` case (`core/policy/ladder.ts:124`) called plain
  `getAppForUser`, whose Personal-visibility gate hides a creator's own app from everyone else.
- **The fix.** `getAppForGovernance` in `tabs/software/lib/apps.ts`, mirroring
  `getDashboardForGovernance` exactly: it widens the read by precisely the set of principals the
  ladder can appoint as THIS app's approver (an in-domain `domain_admin`, or an `admin`), and only
  through the two call sites that pass the flag. Everyone else still gets the 404.
- **The test.** `e2e-golden-path.test.ts` stage 11 — the creator files, the domain_admin approves,
  and the domain_admin is then refused the Company rung that only an admin holds.

---

## 2. The stage-by-stage table

| # | Stage | Broke? | Fix | Test |
|---|---|---|---|---|
| 1 | create | no | — | `e2e` s1 (default kind is `spec`; coded fails closed) |
| 2 | design | **yes — F10** silent grant drop | report, and default a missing `access` to the narrowest level | `e2e` s2 |
| 3 | spec | **yes — F1** the owner's error, on three doors | normalise at the door, report the rewrite as a warning | `e2e` s3, `set-app-spec` |
| 4 | build | **yes — F2** the default kind had no verb | kind-aware directives | `e2e` s4, `platform-mcp` |
| 5 | verify | **yes — F2** read absent code | verify the live spec instead | `e2e` s5, `platform-mcp` |
| 6 | scan | *(other agent)* | dependency: `live \| unavailable`; `unavailable` closes the gate | `e2e` s6 |
| 7 | request_deploy | **F4** reviews the template scaffold | recorded, not fixed (other agent's module) | `e2e` s7 |
| 8 | decide_deploy | no | — | `e2e` s8 (SoD both ways; no verdict ⇒ unapprovable) |
| 9 | preview / serve | **yes — F5, F6** | explained failures explain themselves; a spec app's preview is its served URL | `e2e` s9, `review` |
| 10 | the app's SDK | no | — | `e2e` s10, `triangle` |
| 11 | lifecycle | **yes — F11** the ladder could not see the app | `getAppForGovernance` | `e2e` s11 |
| 12 | git | no | — | `e2e` s12 (trailers, one commit for identical bytes, round trip) |

---

## 3. Phases

- [x] **PLAN** — this document: the two paths, every door located, the first findings.
- [x] **DESIGN** — the shape of each fix, above, written against the driven chain.
- [x] **IMPLEMENT** — test-first, iterating: `e2e-golden-path.test.ts` drove the chain; each red
      stage got its fix at the source and a test that pins it.
- [x] **TEST** — tsc clean; targeted suites green; ONE full-suite run (`--test-concurrency=2`);
      `bash os-ui/scripts/gate.sh` exit 0; `node scripts/check-structure.mjs` at baseline.

---

## 4. What is true on the cluster today / what is still not

Written from what the driven chain actually proved. The evidence is
`os-ui/tabs/software/lib/e2e-golden-path.test.ts` (32 cases, `NODE_ENV=production` +
`OS_OFFLINE_MOCK=refuse`, four principals, a real temp-dir git repository, one stubbed seam —
the reasoning model).

### True today, for a DECLARATIVE app — which is the default and the golden path

- **Create → design → author → live.** `create_software` (defaults to `kind:'spec'`) →
  `design_software` (epics, per-story spec, grants **by reference**) → `generate_app_spec`
  (the real reasoning-model call, grounded in the granted dataset's REAL columns) →
  `set_app_spec` → the app is **live at `/apps/<slug>`**, same-origin, rendered by the trusted
  OS renderer under the viewer's own session. No image, no pod, no CI, no registry, no build
  latency. This whole path now works for an agent that writes the model's natural reference
  shorthand instead of the canonical object.
- **The validation gate is real and machine-actionable.** An invented column, an ungranted
  dataset, a duplicate tab id: each is a blocking `{ path, reason, fix }` and **nothing is
  persisted**. What is genuinely ambiguous is still refused — the gate was loosened for nothing.
- **Governance holds at every door.** An app you cannot see is `not_found` from the write doors
  too. A creator cannot `promote`; they file, and the appointed `domain_admin` approves the
  My→Domain rung; Domain→Company is the admin's alone. An owner can never approve their own
  deploy; a builder who is not the requester can. An archived app refuses every write with a 409.
- **`start_preview` tells the truth.** A declarative app's preview is its served URL; with no
  spec it says so and names the verb that authors one.
- **Git is the home of record for a coded app.** `push_app_files` commits under `apps/<slug>/`
  in the domain repository, authored as the acting user, with `OS-Action` / `OS-Object` /
  `OS-Surface` / `OS-Request-Id` trailers. Identical bytes pushed twice yield **one** commit.
  `read_app_files` round-trips what was pushed.
- **The app's SDK is same-origin and carries no credential of its own.** `os.whoami` hits the
  OS UI's own identity door with the ambient session. A record written through the governed
  store is stamped with the **writing user**, and two sessions on the same app see different row
  sets. An app action outside its declared `actions.yml` scopes is not in scope, and a malformed
  declaration comes back as an issue rather than being dropped.
- **The agentic builder (`SOFTWARE_BUILDER=agentic`) is honest.** The **scorecard is the gate,
  not the reviewer**: a tree that compiles but never reaches governed data is NOT committed even
  when the reviewer says `pass`, and the result says "Nothing was committed" and "Nothing is done
  yet". A tree that does satisfy its checks commits, with `.app/acceptance.json` in the **same**
  commit. In that record, `manual` checks are never machine-passed, static checks say
  `static check (AST)`, and an `unknown` can never add up to `ok: true`. The real compile gate
  refuses a non-compiling tree — it caught this plan's own first fixture.
- **Nothing fabricates.** Under `OS_OFFLINE_MOCK=refuse` a scan with no engine is `unavailable`
  with `passed: false` and a reason; `decide_deploy` then refuses with a 409 naming the absence.
  No placeholder container is ever substituted, and no preview URL is ever invented.

### NOT true today — say this plainly, do not imply otherwise

1. **There is no CI runner and no image builder in this repository, and no app-runner image is
   shipped.** `images/` contains no such image; `softwareRunner.runnerImage` is empty by design
   and must stay empty; `softwareRunner.enabled` is `false`. The `apps-runner` chart template
   deploys **no workload** — it is Namespace + RBAC + NetworkPolicy scaffolding so the OS process
   *can* create per-app Deployments. **A coded app can therefore not be served by this repo
   alone**: an operator must publish an image and set the reference.
2. **A coded app cannot go live on a cluster with no security scanner.** The scan has no engine,
   so `decide_deploy` refuses — correctly, fail-closed. Wiring a scanner (the Trivy Job another
   agent is adding) is what opens that gate. *This is a feature, not a defect, but it means
   "deploy a coded app" is not an available end-to-end path today.*
3. **A declarative app goes live with no review gate and no scan.** `set_app_spec` validates and
   the app serves. That is the design — the renderer is trusted, the patterns are fixed, a custom
   block is a null-origin iframe, and data access is grant- + RLS-gated — but it is worth stating
   next to the review-card machinery, which gates something else.
4. **`request_deploy` on a declarative app reviews the wrong artefact** (F4). `appFilesForScan`
   falls back to the template scaffold, so the card's scan and diff are over files the app does
   not use. Not fixed this round: `review.ts`'s scan half is another agent's module. The right
   shape is to scan the spec's own shippable surface — the spec JSON, each custom block's
   html/css/js and the theme CSS, which is where a pasted secret would actually live.
5. **The same-origin render does not apply the app-grant intersection** (F3, documented in
   `app/apps/[slug]/page.tsx` itself). A Shared spec app shows a viewer everything **they** may
   see among its sources, not the grant-narrowed subset. More-permissive, never less. Fixing it
   means carrying the app slug into every pattern renderer's data fetch.
6. **The deploy review card does not carry the acceptance scorecard** (F7). The record is
   committed and readable by `read_app_files`; the card does not show it. The false claim that it
   did has been removed from `builder/loop-server.ts`.
7. ~~**`set_app_spec` is not in the hold table.**~~ **CLOSED in the review round — see §4.7.**
8. **`promote` over the MCP has a builder floor, so a creator cannot reach it at all** — they
   must use the UI's Promote button / `request_promotion` to file. The ladder's own rule is the
   same, but the two doors are not symmetric, and an agent acting as a creator gets a refusal
   rather than a filed request. Worth closing; not closed here.
9. **No browser verification.** Every claim above is in-process. `/apps/<slug>` rendering, the
   composer, and the review inbox were not opened in a browser this round.

### The honest one-line answer to the owner's question

*Building and running a **declarative** app — the default — now works end to end, from
`create_software` to a live, governed, same-origin app at `/apps/<slug>`, and the two dead ends
you hit (the reference-shape rejection and the stage-4 directive that led to a 403) are fixed and
pinned by tests. Building a **coded** app works up to and including a governed commit with a real
compile gate and an honest acceptance scorecard; it cannot be **served** by this repository
because there is no image builder and no runner image, and it cannot be **approved** on a cluster
with no security scanner. Both of those are now said out loud by the tools instead of being
dressed up as a cluster outage.*

### §4.7 — The review round: `set_app_spec` is now held-eligible

**The finding (HIGH).** `set_app_spec` **publishes**: it writes the app's LIVE served surface and
snapshots a version, so the app becomes reachable at `/apps/<slug>` by everyone its visibility
admits. It is declared `write: true` on the platform-MCP surface — but the agent hold gate reads
`WRITE_TOOL_TABS` (`core/mcp/write-tool-meta.ts`), and it was absent. So
`holdDecisionFor(preset, 'set_app_spec')` answered **"not a write" for every preset**, and an agent
granted it — **including under `read-only`** — could put an app live with no hold. That contradicts
the owner's standing rule that writes happen only on explicit confirmation.

**The fix.** `set_app_spec: 'software'` in `WRITE_TOOL_TABS`, with the reasoning in place.

**The resulting posture**, pinned in `tabs/agents/lib/builtin/appsmith.test.ts` next to `commit`'s:

| preset | decision | why |
|---|---|---|
| `read-only` | **HELD**, approver `admin` | every write is blocked and queued — this is the gap that was open |
| `read-propose` | not held | `writeTargetScope` is `personal`: the app is the runner's own and `setAppSpec` re-gates owner-or-in-domain-builder itself. Gate 2 — the run-as-user governed dispatch — is the authority. |
| `full-in-scope` | not held | same |

**What that posture does and does not claim** (narrowed on re-review — the first wording said
"publishing does not widen the audience", which is too strong). Publishing does **not change the
app's `visibility`**; climbing the ladder is `promote`, which stays separately role-gated. But on
an app that is **already Shared or Certified**, `set_app_spec` pushes a **new live surface to that
existing audience**, and under `read-propose` / `full-in-scope` that is unheld. The hold cannot
currently tell the two apart, because it is **name-only**.

**Frozen engine goldens changed: NONE.** A tree-wide search found **no system granting
`set_app_spec`** (`tabs/agents`, `core/runtime`, `seed`). The shipped App Smith team authors through
`commit`; a test now asserts it still does not grant `set_app_spec`, so if that ever changes the
golden is re-checked deliberately rather than silently.

**The other two spec doors need no entry, and must not get one.** `publishApp` and `saveAppDraft`
are HTTP routes (`/api/apps/[id]/publish`, `…/spec/draft`), not governed MCP tools. No agent can
reach them, and `WRITE_TOOL_TABS` classifies MCP tool names only. Recorded in the table's comment
so the next reader does not have to re-derive it.

**On the generic tripwire.** `set_app_spec` was the fourth occurrence of *"in the catalog ≠ held"*
— `commit`, `push_app_files`, `reindex_corpus`, `set_app_spec` — and `design_software` (§4.7a) made
it five in one evening. The cheap structural signal already exists and
is already wired: the platform-MCP table's own **`write: true`** declaration *is* the "this
persists a record" flag, and `tabs/software/lib/builder/dispatch.test.ts` asserts, by
`deepEqual` on a sorted list, that the set of declared platform writes **not** in
`WRITE_TOOL_TABS` is exactly a named literal. That is a two-way ratchet: a new unclassified
platform write fails it, and classifying one fails it until the list is edited deliberately. It is
what caught `push_app_files`, and `set_app_spec` was sitting in its named backlog — the mechanism
worked; nobody had paid the item down. So rather than build a second mechanism, this round
**shrank that list by one** and strengthened the positive half (`set_app_spec` must be both a
declared platform write *and* in the hold table).

A broader signal — "every tool whose handler imports a `*-store` or an `apps.ts` mutator" — was
considered and **not** built: the platform-MCP handlers all live in one `switch` in one module that
imports every mutator, so an import-based signal cannot distinguish the write cases from the read
cases (`build_software`, `get_app_spec`, `verify_software` are in the same file). The per-tool
`write` flag is strictly more precise, and it is declared next to the thing it describes.

### §4.7a — `design_software` classified: the fifth, and a twin that had been split

`design_software` and `set_app_design` land in the **same governed write**, `patchAppDesign`. The
tab's own tool was classified; the platform-MCP tool onto the same function was not — so **the hold
posture of one write depended on which of its two names an agent used**. Classified now, with the
posture asserted to be *identical to its twin's under every preset* rather than merely similar.

It matters more after **F10**: that door now **defaults a grant with no `access` to `read-only`
instead of dropping it**, so an unheld call can bind governed context the caller never explicitly
authorised. Trading a silent drop for a silent grant is only safe if the door is held-eligible.

**Frozen engine goldens changed: NONE** — nothing grants `design_software`. (The one hit in
`agentic-graph.test.ts` is a role-floor assertion about the tool *catalogue*, not a grant, and the
hold table does not touch it.)

### §4.7b — Follow-up (NOT done tonight): make `set_app_spec`'s hold follow the TARGET's visibility

**The gap.** The hold should scale with what is being published to: a **Domain**-visible app held
to a `domain_admin`, a **Company**-visible one to an `admin`, a Personal one not held. Today all
three decide identically, because the rule is name-only.

**Why it is not a small change.** `tabs/agents/lib/build/hold.ts` is deliberately **pure and
synchronous** and receives **only the tool name** — that is what lets the pure graph builder and its
tests call it without a store. The engine binds it as
`decide: (tool) => holdDecisionFor(sys.safetyPreset, resolveAlias(tool))`, and the `decide` port in
`tabs/agents/lib/engine/build-graph.ts` is typed to take a tool name and nothing else. Target
awareness therefore needs, at minimum:

1. the `decide` port to carry the tool **arguments** (so `appId` is reachable);
2. an **async, governed read** of that app's `visibility` inside what is currently a pure sync rule
   — which makes the pre-execution batch gate async;
3. the same change at the executor's independent gate 1b (`os-tools.ts:654`, `holdDecision`), kept
   in step or the two gates disagree;
4. updates to `agentic-graph-server.ts`, the parity harness, and three test harnesses that
   construct `decide`.

That is five non-test modules, a port-signature change and a sync→async conversion of a security
decision — well past the ≤30-line bar, and it **moves posture for every team granted an app write
on a shared app**, so goldens can move. Deliberately deferred rather than rushed.

**The cheaper shape, if the port change is unwanted.** Put the target-aware check in
`setAppSpec` itself (or an overload) at the service boundary, where the app — and so its
`visibility` — is already loaded, and have it refuse rather than hold when the call arrives from an
agent run whose preset does not cover a Domain/Company publish. That keeps `hold.ts` pure, but it
splits the hold decision across two modules, so it needs a deliberate decision about which one is
the authority. Either way it is a posture change, not a patch.

**Still unclassified, and therefore still unheld** — the named ratchet list, **12 → 11**, ranked
worst-first as the reviewer ranked them:

| # | tool | why it ranks here |
|---|---|---|
| 1 | `decide_deploy` | **the approval verb itself.** An agent granted it can approve a go-live. It is role-gated to a builder+ and refuses the requester, so it is not *unguarded* — but an unheld approval verb inside an autonomous run is the single worst item on this list. |
| 2 | `promote` | **climbs the governance ladder** (My→Domain→Company). The applier re-gates each rung, so an agent cannot exceed its runner — but the whole point of the ladder is that a human decides, and this is the one tool whose *effect is* a visibility change. |
| 3 | `delete` | destructive and lineage-gated; archive is the reversible twin. |
| 4 | `request_deploy` | opens a review card and runs the scan; it cannot self-deploy, but it can self-serve a Personal app to live for a Builder owner. |
| 5 | `create_software` | creates a governed artefact (and an MCP principal + a data artifact with it). |
| 6 | `archive` | reversible, so low — but it takes a live app out of service. |
| 7–10 | `use_connection`, `use_data`, `use_knowledge`, `use_as_data` | bind/expose governed resources by reference; `use_as_data` additionally registers a **new Bronze dataset**. |
| 11 | `start_preview` | the mildest: provisions a private preview (or, for a declarative app, just returns the served URL). |

Each is a real posture decision, and classifying `decide_deploy` or `promote` needs an explicit
answer to "should an agent ever hold an approval verb, or should it simply never be granted one?" —
plausibly the latter. They are named here so the debt stays visible and a new platform write cannot
join them unnoticed.

### §4.8 — The review round: the four mediums and the lows

- **M1** `app/api/apps/[id]/route.ts` — the **UI's own** design PATCH still used the silent
  normaliser, so the composer could show a saved grant that was never stored. Now
  `normalizeContextGrantsWithReport`, returning `grantNotes`.
- **M2** `saveAppDraft` returns no `warnings` — kept, and the exemption is now **justified in the
  comment**: it is a debounced keystroke autosave, the draft is not the served artefact, and
  `publishApp` re-runs the same normalisation and *does* return the warnings at the one moment the
  author can act on them.
- **M3** e2e stage 12 asserted inside `if (commit)`, which would have turned a failed governed
  write into a silent pass. Now `assert.ok(commit, …)` and the trailer assertions run unguarded.
- **M4** `core/policy/promotion-matrix.test.ts` — the ladder tripwire checked the opt-in widened
  read for `dashboard` only; it now pins the `'app'` case in the same shape. Plus three unit cases
  in `apps.test.ts` for `getAppForGovernance`: the in-domain `domain_admin` and the `admin` can
  read a Personal app, while an **out-of-domain `domain_admin`** and a **plain in-domain builder**
  both still get 404 — a governance read that widens one step too far is the whole risk.
- **Lows:** the stray blank line in `platform-mcp.ts`; `stagePathKind` now takes a `ServeMode`
  parameter so `mcp-stages.ts` stays pure and imports no module from its own tab's store layer;
  `PreviewResult.runnerNote` documents all four cases it can carry; the chart comment is reflowed;
  the e2e header records that the single-walk stages are order-dependent through `S` (and which
  cases are independent); and `getAppForGovernance`'s comment says **one** call site, because there
  is one.
