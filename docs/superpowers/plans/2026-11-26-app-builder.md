# App Builder: implementation plan (tonight)

Spec: [`docs/superpowers/specs/2026-11-26-app-builder-design.md`](../specs/2026-11-26-app-builder-design.md).
Base: `public/main`. Every workstream: its own branch `wp/app-builder-<letter>` from `public/main` **after W0 merged**,
its own PR with tests, Rebase-and-merge, no deploy. Read `CONTRIBUTING.md` and `os-ui/ARCHITECTURE.md` ("Things this
codebase will punish you for") first. Every new source file carries the SPDX header and the
`FEATURE / USER STORY / ARCHITECTURE` block. New UI text goes into a `strings.ts` per view (next-intl is not on
`main`; if its foundation PR merges before you start, use it instead).

## Order and dependencies

```
W0 contracts (orchestrator, ~1 h, merged first)
 ├── A  living spec + Stories view ─────────┐
 ├── F  go-live rule table + Dev/Prod labels │
 ├── E  app identity token D1                │
 ├── C1 build platform chart ───────┐        │
 ├── D  Postgres per app + env/secrets       │
 │                                  ▼        ▼
 ├── B  classifier + build loop + lights (merges after A)
 └── C2 releases, deploy, previews, logs, rollback, needs-rebuild (merges after C1, D)
        ▼
 H  kind e2e journey + dev values (last; needs everything)
```

Everything except H can be **coded** in parallel from W0. Merge order: W0 → {A, F, E, C1} → {B, D} → C2 → H.

| WS | Cluster change on dev | New long-running requests (dev) |
|---|---|---|
| W0, A, B, F | none | none |
| C1 | Tekton install (`scripts/tekton/install.sh`), Zot, `apps-dev`/`apps-prod`, build task | Tekton ~450m / 700Mi, Zot 100m / 256Mi |
| C2 | none (uses C1's RBAC) | apps: see capacity |
| D | CNPG operator install (`scripts/cnpg/install.sh`), two `apps-pg` clusters | operator 100m / 256Mi, 2 × 100m / 256Mi |
| E | Secret `os-app-token-key`, NetworkPolicy pair | none |
| H | `values.dev.yaml` enables all of it | — |

## W0 — contracts (orchestrator, before anything else)

Purpose: freeze every cross-workstream name so parallel agents never edit each other's files.

Create `os-ui/tabs/software/lib/app-builder-contracts.ts` (types and constants only, no I/O):

```ts
export type EpicId = `EP-${number}`;
export type StoryId = `US-${number}`;
export type CriterionId = `AC-${number}`;
export type CriterionRef = `${StoryId}/${CriterionId}`;
export type Criterion = { id: CriterionId; title: string; given: string[]; when: string[]; then: string[] };
export type StoryState = 'draft' | 'agreed';
export type StoryStatus = 'draft' | 'agreed' | 'built' | 'verified';
export type StoryLight = 'green' | 'partial' | 'untested';
export type StoryDoc = { id: StoryId; epic: EpicId; title: string; asA: string; iWant: string; soThat: string;
  state: StoryState; criteria: Criterion[]; notes: string; path: string };
export type EpicDoc = { id: EpicId; title: string; description: string;
  requirements: { technical: string; ux: string; governance: string }; path: string };
export type LivingSpec = { sha: string; epics: EpicDoc[]; stories: StoryDoc[] };
export type SpecSource = 'ui' | 'chat' | 'mcp' | 'git' | 'migration';
export type SpecVersion = { sha: string; at: string; author: { id: string; name: string }; source: SpecSource;
  proposalId?: string; diff: string };
export type SpecIssue = { path: string; line?: number; reason: string; fix: string };
/** A change to the living spec = whole-file writes/deletes under stories/. Produced by B, committed by A. */
export type SpecChange = { writes: { path: string; content: string }[]; deletes: string[]; summary: string };
export type Classification = 'refine-story' | 'refine-epic' | 'new-story' | 'new-epic';
export type SpecProposal = { id: string; appId: string; classification: Classification; targetId?: StoryId | EpicId;
  rationale: string; confidence: number; alternatives: Classification[]; change: SpecChange;
  source: SpecSource; requestedBy: string; status: 'pending' | 'approved' | 'rejected' | 'superseded';
  decidedBy?: string; decidedAt?: string; reason?: string; createdAt: string };
/** Tekton result `criteria` of the gates task (written by factory-gates.mjs, read by tekton-record.ts). */
export type CriteriaResults = { v: 1; truncated?: true; results: Record<CriterionRef, { pass: number; fail: number }> };
export const CRITERIA_RESULT = 'criteria';
export const DIGEST_RESULT = 'digest';
export const STORIES_DIR = 'stories';
export const STORY_TRAILER = 'Story';            // commit trailer `Story: US-3`
export const OS_SOURCE_TRAILER = 'OS-Source';
export const OS_PROPOSAL_TRAILER = 'OS-Proposal';
export type AppEnv = 'dev' | 'prod';
export type AppRelease = { id: string; slug: string; env: AppEnv; sha: string; digest: string; at: string; by: string;
  previous: string | null; preview?: { host: string; expiresAt: string };
  migrations: { applied: string[]; status: 'ok' | 'failed' | 'none' };
  state: 'deploying' | 'running' | 'failed' | 'rolled-back' };
export const APP_ENV_NAMESPACE_DEFAULT: Record<AppEnv, string> = { dev: 'apps-dev', prod: 'apps-prod' };
/** Called by C2 before a rollout; D registers the migration hook. */
export type PreDeployHook = (input: { slug: string; domain: string; env: AppEnv; namespace: string; image: string; sha: string })
  => Promise<{ ok: true; applied: string[] } | { ok: false; reason: string }>;
export const appDbSecretName = (slug: string) => `app-${slug}-db`;
export const appEnvSecretName = (slug: string) => `app-${slug}-env`;
```

Create `os-ui/core/policy/go-live-rules.ts` (pure; F adds persistence and UI on top):

```ts
export type GoLiveKind = 'app' | 'agent';
export type GoLiveScope = 'my' | 'domain' | 'company';
export type Reviewer = 'none' | 'builder' | 'domain_admin' | 'admin';
export type GoLiveRule = { kind: GoLiveKind; scope: GoLiveScope; reviewer: Reviewer };
export const DEFAULT_GO_LIVE_RULES: GoLiveRule[];            // app/agent × my:none, domain:domain_admin, company:admin
export type GoLiveDecision =
  | { mode: 'auto' }                                          // reviewer 'none'
  | { mode: 'review'; reviewer: Exclude<Reviewer, 'none'>; domain: string };
export function goLiveDecision(rules: GoLiveRule[], kind: GoLiveKind, scope: GoLiveScope, domain: string): GoLiveDecision;
export function canReview(rules: GoLiveRule[], req: { kind: GoLiveKind; scope: GoLiveScope; domain: string; requesterId: string },
  reviewer: { id: string; role: Role; domains: string[] }): { ok: true } | { ok: false; reason: string }; // self → never
export function scopeOfVisibility(v: Visibility): GoLiveScope;  // Personal→my, Shared→domain, Certified/Company→company
export let currentGoLiveRules: () => GoLiveRule[];           // returns DEFAULT until F wires the store
```

Modify (W0 only): `lib/model.ts` `DeployState` += `'needs-rebuild'`; `lib/check-record.ts` `CheckRecord` += optional
`digest?: string; criteria?: CriteriaResults; storyless?: boolean`; create `ui/app-builder/AppBuilderShell.tsx` with
tabs Stories | Chat | Code and runs and env switch, importing `StoriesView`, `ChatView`, `CodeRunsView` from
`ui/app-builder/{stories,chat,runs}/` where W0 commits three honest placeholder components ("This view is being
built") each with its own `strings.ts`; route golden-path apps (`isGoldenPath(app.template)`) from
`SoftwareBuilder.tsx` to the shell. Tests: contracts compile, `goLiveDecision`/`canReview` table incl. self-approval,
shell routing pure helper.

## A — Living spec: files, versioning, sync, Stories view

**Owns:** `os-ui/tabs/software/lib/stories/{files,ids,store,history,migrate,receive}.ts` (+ tests),
`os-ui/tabs/software/ui/app-builder/stories/**`, `os-ui/app/api/apps/[id]/stories/**`,
`templates/nextjs-web/stories/**`. **Modifies:** `lib/apps.ts` (field `stories?`), `lib/app-receive.ts` (call
`receive.ts`, stories-only detection), `lib/git-commit.ts` (pass `OS-Source`/`OS-Proposal` trailers if not already
supported).

Exports (exact):
- `files.ts`: `parseStoryFile(path, content): { story: StoryDoc } | { issues: SpecIssue[] }`,
  `parseEpicFile(path, content): { epic: EpicDoc } | { issues }`, `renderStoryFile(s: StoryDoc): string`,
  `renderEpicFile(e: EpicDoc): string`, `storyPath(epic: EpicDoc, s: Pick<StoryDoc,'id'|'title'>): string`,
  `parseLivingSpec(files, sha): { spec: LivingSpec; issues: SpecIssue[] }`. Round-trip render∘parse = identity.
- `ids.ts`: `nextEpicId(spec)`, `nextStoryId(spec)`, `nextCriterionId(story)`; never reuse.
- `store.ts`: `readSpec(appId, user, sha?): Promise<LivingSpec>`;
  `commitSpecChange(appId, user, change: SpecChange, meta: { source: SpecSource; proposalId?: string; message: string }): Promise<{ sha: string }>`
  (validates every written file with the parser first; refuses ids that collide; refuses paths outside `stories/`);
  `saveStory(appId, user, story: StoryDoc, source)` and `saveEpic(...)` (thin wrappers building a `SpecChange`).
- `history.ts`: `specHistory(appId, user, id: StoryId | EpicId): Promise<SpecVersion[]>`.
- `migrate.ts`: `migrateEpicsToFiles(appId, user): Promise<{ sha: string } | { skipped: string }>` (spec §3.4, idempotent).
- `receive.ts`: `isStoriesPath(p)`, `validateStoriesFile(file): string | null` (for the receive gate),
  `rebuildStoriesIndex(app, tree, sha)`, `onlyStoriesChanged(changed): boolean` (consumed by C1 via a run param, see C1).
- UI `StoriesView` (props `{ app, env }`): epics, story cards (status chip from B's `storyStatus`, read via
  `GET /api/apps/[id]/stories`, which returns `{ spec, status, lights }` — A returns `status`/`lights` as
  `undefined` until B merges), inline edit, criteria editor (Given/When/Then rows), history drawer with diff,
  pending proposals strip (renders `SpecProposal[]` from `GET /api/apps/[id]/proposals`; B implements the route,
  A tolerates 404).
- Routes: `GET/PUT /api/apps/[id]/stories` (PUT = `saveStory`/`saveEpic`, governance `authorize()`),
  `GET /api/apps/[id]/stories/[sid]/history`.
- MCP: `get_stories`, `get_story_history`; `design_software` on golden-path apps writes files through `store.ts`.

Tests: parser fixtures (valid, each malformed shape → named issue), round-trip, id allocation, duplicate id refusal
at receive, migration idempotence, `commitSpecChange` refuses non-`stories/` paths, history maps trailers to source,
push of a stories-only change does not start a build (flag set), UI pure helpers.

Acceptance: a story edited in UI appears as a commit with author and `OS-Source: ui`; the same file edited and pushed
by git re-indexes and shows `source: git` in history; malformed push refused with path and line.

## B — Classifier, chat/MCP build loop, tests from criteria, lights

**Owns:** `lib/stories/{classify,proposals,lights,story-ref}.ts` (+ tests), `lib/builder/criteria-tests.ts`,
`ui/app-builder/chat/**`, `app/api/apps/[id]/requirements/route.ts`, `app/api/apps/[id]/proposals/**`,
`templates/nextjs-web/scripts/factory-gates.mjs` **and** its byte-identical chart copy
`charts/sovereign-agentic-os/files/tekton/platform/factory-gates.mjs`, `templates/nextjs-web/AGENTS.md` section
"Stories and tests". **Modifies:** `lib/builder/{loop,prompts,tools}.ts`, `lib/platform-mcp.ts`,
`mcp/software-write-tools.ts`.

Exports:
- `classify.ts`: `classifyRequirement(app, user, input: { text: string; source: SpecSource; commit?: { message: string; paths: string[] } }): Promise<SpecProposal>`
  — reasoning model role via LiteLLM, JSON-schema validated, server-assigned ids, typed `ClassifierUnavailable` error.
- `proposals.ts`: `createProposal`, `listProposals(appId, user)`, `decideProposal(id, user, 'approve'|'reject', { edits?: SpecChange; reason?: string })`
  → on approve calls A's `commitSpecChange` with `source` and `proposalId`, sets touched stories `state: agreed`;
  supersedes pending proposals on the same story. Persisted with the app record store (same durability as `App`).
- `lights.ts`: `storyLights(spec, criteria?: CriteriaResults): Record<StoryId, { light: StoryLight; covered: CriterionRef[]; missing: CriterionRef[]; failing: CriterionRef[] }>`;
  `storyStatus(story, light, { greenBuildHasTests: boolean; devReleaseLight?: StoryLight }): StoryStatus`.
- `story-ref.ts`: `storyRefsInMessage(msg): StoryId[]` (`Story: US-n` trailer and `[US-n]`), `isStoryless(changedPaths, messages): boolean`.
- `factory-gates.mjs`: test gate runs `node --test --test-reporter=junit --test-reporter-destination=<tmp>` plus the
  default reporter; maps `[US-n/AC-m]` in test names to counts; writes `CRITERIA_RESULT` JSON to `$CRITERIA_RESULT_PATH`
  when set (≤ 3.5 KB, else truncated marker). Exit code semantics unchanged.
- Build loop: refuses code writes for stories not `agreed` or with a pending proposal; writes tagged failing tests
  first, then code; commits carry `Story: US-n`.
- MCP: `propose_requirement`, `decide_requirement`; `build_software` (agreed-only, returns refs and tagging rule),
  `verify_software` (returns lights).
- Chat view: requirement → diff card (approve / edit / reject / switch classification) → build progress → Dev URL.
- "Change without a story": `isStoryless` result stored as `CheckRecord.storyless` by C2's record reader; B's chat
  offers the classifier on it.

Tests: classifier with stubbed model (each classification, invalid JSON → typed error, refine with unknown id →
refused, ids server-assigned), proposal lifecycle incl. supersede and non-editor refusal, lights table (all, some,
none, failing, truncated), status derivation, story-ref parsing, factory-gates criteria mapping on a fixture test run,
byte-identity check still green.

Acceptance: "add a CSV export" in chat on an app with an Orders epic yields a `new-story` card under that epic with
GWT criteria; approving commits it; no code changes before approval.

## C1 — Build platform (chart, scripts, components)

**Owns:** `charts/sovereign-agentic-os/files/tekton/pipelines/app-checks.yaml`,
`charts/.../files/tekton/tasks/buildkit-build.yaml` (own Task, BuildKit rootless), `charts/.../templates/base/os-ui/software-registry.yaml`
(Zot: Deployment, Service, PVC, Ingress, config with retention/access, htpasswd Secret refs, NetworkPolicies),
`charts/.../templates/base/os-ui/software-apps-envs.yaml` (namespaces `apps-dev`/`apps-prod`, PSS restricted,
default-deny + DNS + ingress-nginx, ResourceQuota, os-ui RBAC: deployments/services/ingresses/jobs/secrets/pods/log in both,
pull secret on `default` SA), `charts/.../templates/base/os-ui/software-tekton.yaml` (build pod egress to Zot, push
Secret), `scripts/check-software-apps-envs-chart.mjs`, `components/{zot,buildkit}/UPSTREAM.md`, licences,
`THIRD-PARTY-LICENSES.md`, `sbom.cdx.json`, `licenses/components.tsv`. **Modifies:** `values.yaml`
(`osUI.software.registry.{mode,host,storage,retention}`, `softwareRunner.environments.{dev,prod}.namespace`,
`softwareRunner.environments.enabled`), `templates/base/os-ui/_os-ui-env.tpl` (`SOFTWARE_ENV_NAMESPACES`,
`SOFTWARE_IMAGE_REGISTRY` from the registry host), apps admission policy bindings to both namespaces,
`scripts/check-software-tekton-chart.mjs`, `capacity*.yaml`, `tests/software-factory/tekton-up.sh` (Zot + kind
containerd registry config).

Pipeline contract (consumed by C2 and B):
- Params added: `storiesOnly` (`"true"|"false"`, set by os-ui from A's `onlyStoriesChanged`), `imageRepo`
  (`<registry>/apps/<domain>/<slug>`).
- `gates` task declares result `criteria` and passes `CRITERIA_RESULT_PATH=$(results.criteria.path)` to the test step.
- New tasks `build-image` (runAfter gates + scan; `when storiesOnly == "false"`) with result `digest`, and
  `scan-image` (vendored Trivy task, image mode) after it. Pipeline results `digest`, `criteria`.
- BuildKit: `buildctl-daemonless.sh build --frontend dockerfile.v0 --local context=… --local dockerfile=…
  --output type=image,name=<imageRepo>,push=true --metadata-file …`, `BUILDKITD_FLAGS=--oci-worker-no-process-sandbox`,
  uid 1000, RuntimeDefault seccomp/AppArmor, resources req 500m/1Gi, limit 2/3Gi, docker config from the push Secret.
  **Stop and report if it cannot run under `baseline` on kind; no privileged fallback.**
- Pin every image by digest; licence-check BuildKit and Zot images.

Tests: chart checks (pipeline shape, results, `when`, digests pinned, byte-identical gate files, both namespaces
restricted with policies bound, NetworkPolicies: apps egress only DNS/os-ui/apps-pg, build egress only proxy/Zot/git,
Zot ingress only from build + nodes via ingress), `helm lint`, capacity gate, licence gate, kind: a pushed fixture app
produces a digest in Zot and a `scan-image` verdict (`tests/software-factory/e2e.sh` extended).

## C2 — Releases, Dev/Prod deploy, previews, logs, rollback, needs-rebuild

**Owns:** `lib/releases/{store,overlay,auto-dev,previews,logs,rollback,needs-rebuild}.ts` (+ tests),
`ui/app-builder/runs/**`, `app/api/apps/[id]/{releases,logs,rollback}/**`, `core/adapters/zot/client.ts` (digest
existence check, retention reads). **Modifies:** `lib/runner.ts` (namespace per env, overlay, pre-deploy hooks),
`lib/native-deploy.ts` (env host derivation, overlay validation), `lib/review.ts` (request/decide go-live of a dev
release to Prod via W0 `goLiveDecision`/`canReview`, auto-approve on `none`), `lib/tekton-record.ts` (read results
`digest`, `criteria`; set `storyless` via B's `isStoryless`), `lib/checks-sync.ts` (green run with digest →
`auto-dev`), `lib/tekton-checks.ts` (pass `storiesOnly`, `imageRepo` params), `lib/lifecycle-adapter.ts` **only**
`consequences` (F owns `canGoLive`), `core/kernel/config.ts` (env namespaces, preview TTL/max), MCP tools.

Exports:
- `store.ts`: `listReleases(appId, user, env?)`, `recordRelease(r: AppRelease)`, commits `os/releases/apps/<slug>.yml`.
- `overlay.ts`: `applyEnvOverlay(objects, { env, namespace, image, host }): objects` — changes exactly namespace,
  image, ingress host/TLS (test asserts nothing else differs).
- `auto-dev.ts`: `deployDevRelease(app, record)`; `registerPreDeployHook(h: PreDeployHook)` (D registers).
- `previews.ts`: per-sha preview Deployment/Service/Ingress, max 2, TTL 8 h, reconciler sweep on `scheduleEvery`.
- `logs.ts`: `appLogs(app, env, { preview?, tail, follow })` with redaction of the app's secret values and token patterns.
- `rollback.ts`: `rollbackApp(appId, user, env)` (rule table for Prod).
- `needs-rebuild.ts`: boot reconcile (spec §14): mark, scale old `agentic-apps` Deployment to 0, rebuild button →
  `startChecksRun(head, trigger: 'button')`; delete old objects after first Prod release.
- Code and runs view: commits, runs with steps/logs, storyless flag, releases with URLs, rollback, app logs; env and
  database panels render D's components (`ui/app-builder/runs/EnvPanel` and `DatabasePanel` are D's files).
- MCP: `list_app_runs`, `get_app_run`, `list_app_releases`, `get_app_logs`, `rollback_app`; changed `start_preview`,
  `request_deploy`, `decide_deploy`, `get_software_status`.

Tests: release state machine, overlay exactness, auto-dev only on green+digest+scan-image pass, Prod refuses a digest
not in a dev release, rule table paths (auto, review, self refused, no eligible reviewer), rollback picks `previous`,
preview cap/TTL, redaction, needs-rebuild detection on a foreign registry, MCP parity.

## D — Postgres per app, env and secrets, migrations

**Owns:** `scripts/cnpg/{install.sh,versions.env}`, `charts/.../templates/base/os-ui/software-app-databases.yaml`
(CNPG `Cluster` `apps-pg` per env namespace, post-init `REVOKE CONNECT FROM PUBLIC` on template1, NetworkPolicy:
5432 only from app pods of that namespace and os-ui), values `osUI.software.databases.{enabled,instances,storage,resources}`,
`components/postgresql/UPSTREAM.md` (operator pin added), `core/adapters/cnpg/client.ts`,
`lib/appdb/{database,migrations,env-secrets}.ts` (+ tests), `ui/app-builder/runs/{EnvPanel,DatabasePanel}.tsx` +
`strings.ts`, `app/api/apps/[id]/{env,database}/**`, template: `templates/nextjs-web/src/lib/db/index.ts`,
`templates/nextjs-web/db/migrations/0001_init.sql`, platform-owned `k8s/deployment.yaml` env wiring (in
`native-deploy.ts appDeployFiles` **env block only** — coordinate: C2 edits other functions of that file),
`AGENTS.md` section "Own database", `policy/app-rules.rego` + its chart copy (pg only in `src/lib/db/`).

Exports:
- `database.ts`: `ensureAppDatabase(slug, env): Promise<{ database: string; secretName: string; host: string }>`
  (Secret, managed role patch, `Database` CR; idempotent), `dropAppDatabase` (only on app delete, prod refused
  without admin).
- `migrations.ts`: a `PreDeployHook` running the node-pg-migrate Job from the release image, waiting for completion,
  returning applied files; registered via C2's `registerPreDeployHook`.
- `env-secrets.ts`: `listAppEnv`, `setAppEnv`, `unsetAppEnv` (name rules, reserved prefixes, write-only, audit,
  Prod right via W0 rules, rollout checksum annotation).
- MCP: `list_app_env`, `set_app_env`, `unset_app_env`, `get_app_database`; `create_software` `database: boolean`.

Tests: name validation, reserved prefixes, value never returned or logged, CNPG object shapes (golden fixtures
validated with the CRD schema per glue rule), migration Job spec (fixed command, release image, restricted pod),
failed migration blocks rollout, rego allows pg only in `src/lib/db/`; kind: two apps cannot connect to each other's
database.

## E — App identity token (D1)

**Owns:** `core/auth/{app-token,app-login-codes}.ts` (+ tests), `app/api/auth/{app-login,app-token,app-jwks}/route.ts`,
`core/app-sdk` token-forwarding helper, `templates/nextjs-web/src/app/os/callback/route.ts`,
`templates/nextjs-web/src/middleware.ts` (login redirect), `templates/nextjs-web/src/lib/os/index.ts`,
`AGENTS.md` identity section, chart `templates/base/os-ui/app-token.yaml` (Secret ref, NetworkPolicy pair),
values `osUI.appToken.signingKeySecret`, `scripts/dev/bootstrap-secrets.sh` (generate dev key). **Modifies:**
`core/kernel/auth.ts` (accept app bearer on the allowlist only), `package.json` (`jose`, MIT, exact pin + lock +
attribution).

Exports: `mintAppToken(user, { slug, env }): Promise<string>`, `verifyAppToken(token, { slug, env }): Promise<AppTokenClaims>`,
`APP_TOKEN_ROUTES: readonly string[]`, `issueLoginCode(...)`, `redeemLoginCode(code, verifier)`.

Tests: aud mismatch, expired, revoked user, unknown `kid`, route outside allowlist refused, no `approval-decide`
ever, code reuse refused, redirect host mismatch refused, user without visibility refused at login, key missing →
fail closed. Template tests: callback stores HttpOnly cookie, middleware redirects with PKCE.

## F — Go-live rule table in Platform, Dev/Prod labels

**Owns:** `core/policy/go-live-rules-store.ts` (governance Postgres, versioned, audited), `tabs/admin/ui/GoLiveRules.tsx`
+ `strings.ts`, `tabs/admin/lib/sections.ts` entry, `app/api/admin/go-live-rules/route.ts`, MCP
`get_go_live_rules`/`set_go_live_rules` in `core/mcp/governance-tools.ts`. **Modifies:** `core/policy/go-live-rules.ts`
(wire `currentGoLiveRules` to the store; W0 signatures unchanged), `tabs/software/lib/lifecycle-adapter.ts`
`canGoLive` (rule table), `core/kernel/object-lifecycle.ts` `VIEW_SURFACE_LABELS` → Dev / Prod (ids unchanged),
`core/ui/lifecycle/StudioRunToggle.tsx`, badge tests.

Tests: default table, admin-only write, non-admin refused, audit record old/new, invariant (self-approval) cannot be
configured away, labels.

## H — kind e2e journey and dev enablement (last)

`tests/software-factory/app-builder-journey.sh` + workflow `.github/workflows/app-builder-e2e.yml` (spec §15 journey
and negative twins, `mockModel` for the classifier), `values.dev.yaml` (enable tekton, registry, environments,
databases, app token), `charts/.../capacity.dev.yaml` updated with the real numbers. No prod values.

## Dev capacity estimate

Long-running additions (requests / memory limits):

| Item | CPU req | Mem req | Mem limit | Storage |
|---|---|---|---|---|
| Tekton Pipelines + Triggers + interceptors + EventListener (~7 pods) | 450m | 700Mi | 1.5Gi | — |
| Zot | 100m | 256Mi | 1Gi | 20Gi PVC |
| CNPG operator | 100m | 256Mi | 512Mi | — |
| `apps-pg` dev + prod (1 instance each) | 200m | 512Mi | 2Gi | 2 × 5Gi PVC |
| Apps: 3 demo apps × (Dev + Prod) + 2 previews = 8 pods × 100m / 256Mi | 800m | 2Gi | 4Gi | — |
| **Total long-running** | **~1.65 CPU** | **~3.7Gi** | **~9Gi** | **30Gi** |

Transient per run (one at a time on dev): gates pod ~350m / 800Mi req (bursts to 1 CPU / 1Gi), BuildKit 500m / 1Gi
req (limit 2 CPU / 3Gi), Trivy 100m / 256Mi, migration Job 50m / 128Mi. Peak ≈ **+1 CPU / 2.2Gi requests,
+4 CPU / 5Gi limits**.

The dev node (g2i.8, ~7.9 CPU / ~26 GiB allocatable, `capacity.dev.yaml`) is already sized to the 85 % threshold
for the current chart. **Recommendation: add one node of 4 vCPU / 16 GB to the dev pool** (covers ~2.7 CPU /
~6 GiB requests with headroom for concurrent builds), or move to a single 16 vCPU / 64 GB node. Update
`capacity.dev.yaml` `count`/`allocatable` in H after `kubectl describe node`.

## Dev acceptance checklist (owner, on dev, before any prod)

1. Create an app with a database from the Software tab; Stories view opens.
2. Type a requirement in chat; a diff card classifies it; approve; the story file is in git with your name.
3. Watch the build: tests first, then code; run turns green; Dev URL opens after sign-in via the app token.
4. A story light is green, another partial; push a test from VS Code; it turns green; a push without `Story:` shows
   "change without a story" and the chat offers a story.
5. Set an env secret; it never shows again; the app sees it after rollout.
6. Go live in My scope (no review). Promote an app to Domain and request go-live: you cannot approve it; a domain
   admin can. Change the rule in Platform; the change is audited.
7. Roll back Prod; the previous digest serves.
8. A legacy image app shows Needs rebuild and comes back through the pipeline.
