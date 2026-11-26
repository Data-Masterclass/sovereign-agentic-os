# App Builder: implementation plan (tonight)

Spec: [`docs/superpowers/specs/2026-11-26-app-builder-design.md`](../specs/2026-11-26-app-builder-design.md).
Base: `public/main`. Every workstream: its own branch `wp/app-builder-<letter>` from `public/main` **after W0 merged**,
its own PR with tests, Rebase-and-merge, no deploy. Read `CONTRIBUTING.md` and `os-ui/ARCHITECTURE.md` first. Every new
source file carries the SPDX header and the `FEATURE / USER STORY / ARCHITECTURE` block. New UI text goes into a
`strings.ts` per view (next-intl is not on `main`; if its foundation PR merges before you start, use it instead).

**Prod safety (every workstream).** Everything is behind `softwareRunner.environments.enabled` (default `false`) →
`SOFTWARE_APP_BUILDER`. Acceptance check in every PR: *flag off ⇒ zero behaviour change* — default chart render
byte-identical to `public/main` for the objects you touch, existing UI/labels/routes unchanged, every new route and
MCP tool answers `app_builder_disabled`. Only H turns it on, in `values.dev.yaml`.

**Single ownership.** After W0 every shared file has exactly one owner (table below). If you need a change in a file
you do not own, it goes through the W0 extension point for it; if there is none, stop and ask the orchestrator.

## Order and dependencies

```
W0 contracts + extension points (orchestrator, merged first)
 ├── A  living spec + Stories view
 ├── F  go-live rule table + Dev/Prod labels
 ├── E  app identity token D1 + consent
 ├── C1 build platform chart (BuildKit proof first)
 ├── D  Postgres per app + env/secrets + migrate image stage
 ├── B  classifier + build loop + lights + post-hoc proposals   (merges after A)
 └── C2 releases, deploy, previews, logs, rollback, needs-rebuild (merges after C1 and D)
        ▼
 H  licence fold, capacity, dev values, kind e2e journey (last)
```

Merge order: W0 → {A, F, E, C1, D} → B → C2 → H. All can be coded in parallel once W0 is merged.

## Ownership after W0

| Shared file | Owner | Others contribute through (created by W0) |
|---|---|---|
| `tabs/software/lib/apps.ts` | W0 (all new optional fields added there) | `persistApp` only; no workstream edits `apps.ts` |
| `lib/platform-mcp.ts`, `mcp/software-write-tools.ts` | W0 | `mcp/app-builder/{a,b,c2,d}-tools.ts` (tool arrays + handlers), dispatched by `mcp/app-builder/index.ts`; changed existing tools route golden-path apps to `appBuilderHandlers[name]` |
| `lib/native-deploy.ts` | C2 | D owns `lib/deploy-env-block.ts` (`appDeploymentEnv(slug)`), called from `appDeployFiles` |
| `lib/lifecycle-adapter.ts` | F | C2 owns `lib/releases/consequences.ts` (`releaseConsequences(app)`), called from `consequences` |
| `lib/check-record.ts`, `lib/model.ts` | W0 | fields added in W0 |
| `lib/app-receive.ts` | W0 | `lib/receive-hooks.ts` registry: A registers stories index/validate, B registers post-hoc proposals |
| `templates/nextjs-web/AGENTS.md` | W0 (index + contradictions fixed) | `templates/nextjs-web/docs/rules/{stories-and-tests (B), own-database (D), identity (E)}.md` |
| `templates/nextjs-web/Dockerfile`, `package.json`, `migrate/**` | D | — |
| `templates/nextjs-web/src/lib/os/**`, `src/middleware.ts`, `src/app/os/**` | E | — |
| `templates/nextjs-web/policy/app-rules.rego` + chart copy | D | B/E add no Rego |
| `templates/nextjs-web/scripts/factory-gates.mjs` + chart copy | B | — |
| `charts/.../values.yaml` | W0 creates disjoint blocks | each owner edits only its block: `softwareRunner.environments` (C1), `osUI.software.registry` (C1), `osUI.software.databases` (D), `osUI.appToken` (E) |
| `templates/base/os-ui/_os-ui-env.tpl` | W0 | includes `_os-ui-env-appbuilder.tpl` (W0, flag), `_os-ui-env-registry.tpl` (C1), `_os-ui-env-databases.tpl` (D), `_os-ui-env-apptoken.tpl` (E) |
| `THIRD-PARTY-LICENSES.md`, `licenses/components.tsv`, `sbom.cdx.json` | H | per-workstream fragments `licenses/fragments/{c1,d,e}.json`, read by the licence gate (W0 adds that) and folded by H |
| `capacity*.yaml` | H | C1/D put measured numbers in their PR description |
| `files/tekton/pipelines/app-checks.yaml`, `software-tekton.yaml` | C1 | B's contract: `CRITERIA_RESULT_PATH` env on the test step |
| `core/kernel/config.ts` | W0 (all new keys added there) | — |

## W0 — contracts, flag, extension points (orchestrator)

1. `os-ui/tabs/software/lib/app-builder-contracts.ts` (types and constants only):

```ts
export type EpicId = `EP-${number}`; export type StoryId = `US-${number}`; export type CriterionId = `AC-${number}`;
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
export type SpecChange = { writes: { path: string; content: string }[]; deletes: string[]; summary: string };
export type Classification = 'refine-story' | 'refine-epic' | 'new-story' | 'new-epic' | 'code-change';
export type SpecProposal = { id: string; appId: string; classification: Classification; targetId?: StoryId | EpicId;
  rationale: string; confidence: number; alternatives: Classification[]; change: SpecChange;
  source: SpecSource; posthoc: boolean; commitShas?: string[]; requestedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded'; decidedBy?: string; decidedAt?: string; reason?: string;
  createdAt: string };
export type CriteriaResults = { v: 1; truncated?: true; results: Record<CriterionRef, { pass: number; fail: number }> };
export const CRITERIA_RESULT = 'criteria'; export const DIGEST_RESULT = 'digest';
export const STORIES_DIR = 'stories'; export const STORY_TRAILER = 'Story';
export const OS_SOURCE_TRAILER = 'OS-Source'; export const OS_PROPOSAL_TRAILER = 'OS-Proposal';
export type AppEnv = 'dev' | 'prod';
export type PreviewSlot = 'p1' | 'p2';
export type AppRelease = { id: string; slug: string; env: AppEnv; slot?: PreviewSlot; sha: string; digest: string;
  at: string; by: string; previous: string | null; migrations: { applied: string[]; status: 'ok' | 'failed' | 'none' };
  state: 'deploying' | 'running' | 'failed' | 'rolled-back' };
export const APP_ENV_NAMESPACE_DEFAULT: Record<AppEnv, string> = { dev: 'apps-dev', prod: 'apps-prod' };
export const appDbSecretName = (slug: string) => `app-${slug}-db`;
export const appEnvSecretName = (slug: string) => `app-${slug}-env`;
export const appDbName = (domain: string, slug: string) => `app_${domain}_${slug}`.replace(/[^a-z0-9_]/g, '_');
export const appAudience = (domain: string, slug: string, env: AppEnv) => `app:${domain}/${slug}:${env}`;
```

2. `os-ui/tabs/software/lib/pre-deploy-hooks.ts`: `type PreDeployHook = (i: { slug; domain; env: AppEnv; namespace;
   image; sha }) => Promise<{ ok: true; applied: string[] } | { ok: false; reason: string }>`;
   `registerPreDeployHook(name, h)`, `runPreDeployHooks(i)` (no hooks ⇒ `{ ok: true, applied: [] }`). D registers,
   C2 calls.
3. `os-ui/tabs/software/lib/receive-hooks.ts`: `registerReceiveHook(name, h: (i: { app; changed: ChangedFile[];
   sha; pusher; messages: string[] }) => Promise<string[] /* notes */>)`; `app-receive.ts` calls all hooks after
   ingest (flag on only). Also `onlyStoriesChanged(changed)` lives here (used by `tekton-checks.ts` for the
   `storiesOnly` param, which W0 already passes as `"false"`).
4. `os-ui/core/policy/go-live-rules.ts` (pure): `GoLiveKind`, `GoLiveScope`, `Reviewer`, `GoLiveRule`,
   `DEFAULT_GO_LIVE_RULES`, `goLiveDecision(rules, kind, scope, domain)`, `canReview(rules, req, reviewer)` (role
   **at least** the row's reviewer, admin satisfies any row, never the requester), `scopeOfVisibility(v)`,
   `currentGoLiveRules()` returning the default until F wires the store.
5. Flag: `config.appBuilderEnabled` from `SOFTWARE_APP_BUILDER`; `appBuilderGuard()` returning the typed
   `app_builder_disabled` refusal; `_os-ui-env-appbuilder.tpl` maps `softwareRunner.environments.enabled`.
6. All new optional fields on `App` (`stories?`, `proposals?`, `releases?`, `unreviewed?: string[]`,
   `database?: { dev?: …; prod?: … }`, `consents` live in E's own store), `DeployState += 'needs-rebuild'`,
   `CheckRecord += digest?, criteria?, storyless?`, all new `config.ts` keys.
7. Extension points from the ownership table: `mcp/app-builder/*` stubs + dispatch; `deploy-env-block.ts` stub
   (returns `[]`); `releases/consequences.ts` stub (returns `[]`); values blocks and env partial stubs; licence
   fragment support in `scripts/license-gate.mjs` (fragments count as inventory, gate rules unchanged);
   `templates/nextjs-web/AGENTS.md` rewritten as an index pointing at `docs/rules/*.md` stubs, with today's
   "never a datastore client" and identity statements replaced by pointers (contradictions removed).
8. UI: `ui/app-builder/AppBuilderShell.tsx` (Stories | Chat | Code and runs, env switch) with three placeholder views
   in `ui/app-builder/{stories,chat,runs}/` (each with `strings.ts`); `SoftwareBuilder.tsx` routes golden-path apps to
   the shell **only when the flag is on**.

Tests: contracts compile; `canReview` table (admin satisfies domain_admin, self never, no eligible reviewer);
pre-deploy and receive hook registries; flag off ⇒ routing unchanged and guard refuses; default chart render
unchanged.

## A — Living spec: files, versioning, sync, Stories view

**Owns:** `lib/stories/{files,ids,store,history,migrate,receive-index}.ts` (+ tests), `ui/app-builder/stories/**`,
`app/api/apps/[id]/stories/**`, `mcp/app-builder/a-tools.ts`, `templates/nextjs-web/stories/**`. **Modifies:**
`lib/git-commit.ts` (trailers `OS-Source`/`OS-Proposal`).

- `files.ts`: `parseStoryFile(path, content): { story } | { issues: SpecIssue[] }`, `parseEpicFile`,
  `renderStoryFile`, `renderEpicFile`, `storyPath`, `parseLivingSpec(files, sha)`; render∘parse = identity.
- `ids.ts`: `nextEpicId`, `nextStoryId`, `nextCriterionId`; never reuse.
- `store.ts`: `readSpec(appId, user, sha?)`, `commitSpecChange(appId, user, change, { source, proposalId?, message })`
  (parser-validates every file, refuses id collisions and paths outside `stories/`), `saveStory`, `saveEpic`.
- `history.ts`: `specHistory(appId, user, id): Promise<SpecVersion[]>`.
- `migrate.ts`: `migrateEpicsToFiles(appId, user)` (spec §3.4, idempotent).
- `receive-index.ts`: registers a receive hook (rebuild `App.stories` index) and the stories validator for the receive
  gate through `registerRepoKind` (`stories` kind; malformed or duplicate id ⇒ push refused with path and line).
- `StoriesView`, routes `GET/PUT /api/apps/[id]/stories`, `GET …/stories/[sid]/history`; MCP `get_stories`,
  `get_story_history`, golden-path `design_software` handler writing files.

Tests: parser fixtures, round-trip, ids, duplicate id refusal, migration idempotence, non-`stories/` refusal, history
trailers → source, flag off ⇒ guard. Acceptance: UI edit = commit with author and `OS-Source: ui`; git edit
re-indexes with `source: git`.

## B — Classifier, build loop, tests from criteria, lights, post-hoc proposals

**Owns:** `lib/stories/{classify,proposals,lights,story-ref,posthoc}.ts`, `lib/builder/criteria-tests.ts`,
`ui/app-builder/chat/**`, `app/api/apps/[id]/{requirements,proposals}/**`, `mcp/app-builder/b-tools.ts`,
`templates/nextjs-web/docs/rules/stories-and-tests.md`, both copies of `factory-gates.mjs`. **Modifies:**
`lib/builder/{loop,prompts,tools}.ts`.

- `classify.ts`: `classifyRequirement(app, user, { text, source, commit? }): Promise<SpecProposal>` (reasoning role
  via LiteLLM, JSON schema, server-assigned ids, typed `ClassifierUnavailable`).
- `proposals.ts`: `createProposal`, `listProposals`, `decideProposal(id, user, decision, { edits?, reason? })` →
  A's `commitSpecChange` (not for post-hoc: files already in git); supersede; app editors only.
- `posthoc.ts`: receive hook: story-file changes and storyless code changes ⇒ post-hoc proposal (`posthoc: true`,
  `commitShas`), `App.unreviewed` updated; `unreviewedBlocksGoLive(app, scope): string | null` (Domain/Company ⇒
  reason naming proposals). C2 calls it in the go-live path.
- `lights.ts`: `storyLights(spec, criteria?)`, `storyStatus(story, light, evidence)`.
- `story-ref.ts`: `storyRefsInMessage`, `isStoryless`.
- `factory-gates.mjs`: JUnit reporter → `[US-n/AC-m]` counts → `$CRITERIA_RESULT_PATH` (≤ 3.5 KB else truncated);
  exit codes unchanged.
- Build loop: code writes only for `agreed` stories without pending proposals; tests first; commits carry `Story:`.
- MCP: `propose_requirement`, `decide_requirement`; golden-path handlers for `build_software`, `verify_software`.

Tests: classifier (stubbed model) incl. invalid JSON and unknown ids; proposal lifecycle; post-hoc creation and
go-live block; lights table incl. truncated; story refs; gates criteria mapping on a fixture; byte-identity check.

## C1 — Build platform (chart, builder image, Zot)

**Owns:** `files/tekton/pipelines/app-checks.yaml`, `files/tekton/tasks/{buildkit-build,crane-push}.yaml`,
`templates/base/os-ui/{software-registry,software-apps-envs}.yaml`, `software-tekton.yaml`,
`images/builder/` (Dockerfile building buildkitd/buildctl/runc/rootlesskit from source, FROM scratch),
`.github/workflows/build-images.yml` entry for `builder`, `_os-ui-env-registry.tpl`, values blocks
`softwareRunner.environments` and `osUI.software.registry`, `scripts/check-software-apps-envs-chart.mjs`,
`scripts/check-software-tekton-chart.mjs`, `components/{zot,buildkit,crane}/UPSTREAM.md`, `licenses/fragments/c1.json`,
`tests/software-factory/tekton-up.sh` (kind 1.35, Zot, containerd registry config). `core/adapters/zot/client.ts`
(per-domain push user + access policy, digest check).

**Step 1 — proof before anything else (stop-and-report gate).** On kind 1.35: the builder image builds the template
in a pod with `hostUsers: false`, RuntimeDefault seccomp/AppArmor, no privileged, `baseline` namespace, native
snapshotter, `--oci-worker-net=host`, output OCI tar. Trivy SBOM of the builder image has no GPL/AGPL. If either
fails, **stop, report what failed, build nothing else in C1.**

Then: pipeline `fetch → gates (criteria result, CRITERIA_RESULT_PATH) → scan-tree → build-image (when
storiesOnly == "false") → push-image (crane, only pod with the per-domain push Secret, result digest) →
scan-image`; Zot (ClusterIP, PVC, retention, sync mirror for base images via egress proxy, Ingress only with
non-empty `allowedSourceRanges`, exposure modes `ingress-restricted | internal-lb | external`); `apps-dev`/`apps-prod`
(PSS restricted, admission policies bound, default-deny, DNS, **ingress 8080 from ingress-nginx and from os-ui**,
quotas, os-ui RBAC, pull secret). NetworkPolicies owned here: app default-deny/DNS/ingress, build pod egress
(proxy, Zot, git-http), push pod egress (Zot), Zot ingress (build, push, ingress controller) and egress (proxy).

Tests: chart checks (§15 of the spec), flag off ⇒ default render unchanged, licence gate with fragment, kind: fixture
app → digest in Zot, build pod has no registry credential, scan-image verdict.

## C2 — Releases, Dev/Prod deploy, previews, logs, rollback, needs-rebuild

**Owns:** `lib/releases/{store,overlay,auto-dev,previews,logs,rollback,needs-rebuild,consequences}.ts`,
`ui/app-builder/runs/**` (except D's panels), `app/api/apps/[id]/{releases,logs,rollback}/**`,
`mcp/app-builder/c2-tools.ts`, `lib/native-deploy.ts`, `lib/runner.ts`, `lib/review.ts`, `lib/tekton-record.ts`,
`lib/checks-sync.ts`, `lib/tekton-checks.ts` (params `storiesOnly`, `imageRepo`).

- `overlay.ts` `applyEnvOverlay` (namespace, image digest, ingress host/TLS only); `auto-dev.ts` (green + digest +
  scan-image pass ⇒ `runPreDeployHooks` ⇒ rollout to `apps-dev`; also fills a preview slot); `previews.ts` (slots
  `p1`/`p2`, oldest sha replaced, idle 8 h ⇒ scale 0); `logs.ts` (redaction); `rollback.ts`; `store.ts` (release
  records, commit to `os/releases/apps/<slug>.yml`).
- `review.ts`: go-live of a dev release to Prod: `goLiveDecision`/`canReview` (W0), auto-approve on `none`, refuse
  while `unreviewedBlocksGoLive` (B) says so, Prod refuses a digest that is not a dev release.
- `needs-rebuild.ts`: mark-only reconcile when the flag is on; `run_app_migration` (admin, explicit) scales the legacy
  Deployment to 0; legacy objects deleted after the first Prod release.
- MCP: `list_app_runs`, `get_app_run`, `list_app_releases`, `get_app_logs`, `rollback_app`, `run_app_migration`;
  golden-path handlers for `start_preview`, `request_deploy`, `decide_deploy`, `get_software_status`.

Tests: release state machine, overlay exactness, auto-dev conditions, preview slot reuse, rule paths, unreviewed
block, rollback, redaction, needs-rebuild never touches the cluster without the explicit action, flag off.

## D — Postgres per app, env and secrets, migrations

**Owns:** `scripts/cnpg/{install.sh,versions.env}`, `templates/base/os-ui/software-app-databases.yaml` (Cluster
`apps-pg` per env with `pg_hba` `hostssl sameuser all all scram-sha-256` + `host all all all reject`; NetworkPolicies:
5432 from app pods and `soa.dev/role: app-migrate` Jobs of the namespace, 5432/8000 between instances, 8000 from
the operator namespace, egress to the API server and DNS; migrate Job egress to apps-pg and DNS), values block
`osUI.software.databases` (`mode: cnpg | external`, external designed only), `_os-ui-env-databases.tpl`,
`core/adapters/cnpg/client.ts`, `lib/appdb/{database,migrations,env-secrets}.ts`, `lib/deploy-env-block.ts`,
`ui/app-builder/runs/{EnvPanel,DatabasePanel}.tsx` + `strings.ts`, `app/api/apps/[id]/{env,database}/**`,
`mcp/app-builder/d-tools.ts`, `components/postgresql/UPSTREAM.md` (operator pin), `licenses/fragments/d.json`;
template: `Dockerfile` (`migrate` stage → `/app/migrate/` in the run image), `package.json` (`pg`), `migrate/package.json`
+ lockfile (node-pg-migrate, pg), `src/lib/db/index.ts`, `db/migrations/0001_init.sql`, `docs/rules/own-database.md`,
`policy/app-rules.rego` + chart copy (pg only in `src/lib/db/`); scaffold lockfile regenerated with the documented
script, never by hand.

- `database.ts`: `ensureAppDatabase(app, env)` → Secret, managed role, `Database` CR, then the one-shot Job **as the
  app role** running `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`; idempotent; no superuser in os-ui.
- `migrations.ts`: registers a pre-deploy hook running the migrate Job from the release image (fixed command).
- `env-secrets.ts`: list/set/unset, name rules, reserved prefixes, write-only, audit, Prod right via W0 rules.

Tests: name rules, value never returned/logged, CNPG object golden fixtures validated against the CRD schema, migrate
Job spec, failed migration blocks rollout, Rego; kind: **role A cannot connect to database B** (both layers), app pod
in `apps-dev` cannot reach `apps-pg` in `apps-prod`; image built from the template contains `/app/migrate`.

## E — App identity token (D1) and consent

**Owns:** `core/auth/{app-token,app-login-codes,app-consent}.ts`, `app/api/auth/{app-login,app-token,app-jwks,
app-consent}/**`, consent screen component, My Settings consent list, `core/app-sdk` token helper,
`templates/nextjs-web/src/lib/os/**`, `src/middleware.ts`, `src/app/os/callback/route.ts`,
`docs/rules/identity.md`, `templates/base/os-ui/app-token.yaml` (Secret ref, NetworkPolicy pair apps → os-ui :3000),
values block `osUI.appToken`, `_os-ui-env-apptoken.tpl`, `scripts/dev/bootstrap-secrets.sh` (dev key),
`licenses/fragments/e.json` (`jose`). **Modifies:** `core/kernel/auth.ts` (app bearer on the allowlist only),
`os-ui/package.json` + lock (`jose`, exact pin).

Exports: `mintAppToken(user, { domain, slug, env, scope })`, `verifyAppToken(token, { domain, slug, env })`,
`APP_TOKEN_ROUTES`, `appTokenScope(app)` (read; `agent-run` if agent grants; `action:<name>` per declared write),
`issueLoginCode`, `redeemLoginCode`, `registeredCallbackHosts(app, env)` (prod host; dev host + `p1`/`p2`).

Tests: aud with domain, expired, revoked user, role re-read (a demoted user loses access with a valid token), scope
outside grants refused, no governed-write routes, consent required and widened-scope re-consent, code reuse,
unregistered callback host, unseeable app, missing key ⇒ fail closed, flag off.

## F — Go-live rule table in Platform, Dev/Prod labels

**Owns:** `core/policy/go-live-rules-store.ts`, `core/policy/go-live-rules.ts` (wires `currentGoLiveRules`; W0
signatures unchanged), `tabs/admin/ui/GoLiveRules.tsx` + `strings.ts`, the `sections.ts` entry,
`app/api/admin/go-live-rules/route.ts`, MCP `get_go_live_rules`/`set_go_live_rules` in `core/mcp/governance-tools.ts`,
`lib/lifecycle-adapter.ts` (`canGoLive` via rules), `core/kernel/object-lifecycle.ts` labels and
`core/ui/lifecycle/StudioRunToggle.tsx`: Dev/Prod **only when the flag is on** (ids unchanged).

Tests: defaults, admin-only write, audit old/new, self-approval not configurable, admin satisfies domain_admin,
labels with flag on and off.

## H — Licence fold, capacity, dev values, kind journey (last)

Folds `licenses/fragments/*` into `THIRD-PARTY-LICENSES.md`, `licenses/components.tsv`, `sbom.cdx.json`; updates
`capacity.dev*.yaml`; `values.dev.yaml` enables the flag and every block **with the dev requests below**;
`tests/software-factory/app-builder-journey.sh` + `.github/workflows/app-builder-e2e.yml` (spec §15). No prod values.

## Dev capacity

Dev is one **m2i.4** (3920m CPU allocatable) at **79 % CPU requests**; the pool cannot grow tonight. The capacity gate
threshold is 85 %, i.e. ~235m of long-running requests left. Budget: **≤ 0.8 CPU extra requests in total**, of which
long-running ≤ 0.2 CPU (stays under 85 %) and one transient build at a time ≤ 0.6 CPU. Memory is not the constraint.

| Item (dev overlay) | CPU req | Mem req | Mem limit |
|---|---|---|---|
| Tekton Pipelines/Triggers/interceptors/EventListener (7 pods × 10m) | 70m | 7 × 64Mi | 7 × 256Mi |
| Zot | 20m | 128Mi | 512Mi |
| CNPG operator | 20m | 128Mi | 256Mi |
| `apps-pg` dev + prod | 2 × 15m | 2 × 192Mi | 2 × 512Mi |
| Apps: 2 demo apps × Dev/Prod + 1 preview slot active (5 × 10m) | 50m | 5 × 128Mi | 5 × 512Mi |
| **Long-running total** | **190m** (79 % → ~84 %) | ~1.6Gi | ~6Gi |
| Transient, one at a time (`agentic-build` quota `cpu: 600m`, `pods: 4`): gates 200m, build 300m, push/scan/migrate 50m each, sequential | **≤ 600m** | ~1.5Gi | ~4Gi |

`values.yaml` keeps realistic defaults (Tekton controllers 50–100m, Zot 100m/256Mi, apps-pg 100m/256Mi, build
500m/1Gi, app 100m/256Mi). **Owner follow-up:** enlarge the dev pool (one extra 4 vCPU / 16 GB node, or g2i.8) before
anyone builds more than one app at a time on dev; with the dev overlay, builds queue on the quota.

## Dev acceptance checklist (owner, on dev, before any prod)

1. Create an app with a database; Stories view opens.
2. Chat a requirement; a diff card classifies it; approve; the story file is in git with your name.
3. Tests first, then code; run green; Dev URL opens after the consent screen.
4. One light green, one partial; push a test from VS Code ⇒ green. Push a criterion change from VS Code ⇒ post-hoc card,
   "unreviewed changes", Domain go-live refused until approved. A push without `Story:` ⇒ "change without a story".
5. Set a secret; never shown again; the app sees it after rollout.
6. Go live in My scope without review. Domain go-live: you cannot approve it; a domain admin or admin can. Change the rule
   in Platform; audited.
7. Roll back Prod; the previous digest serves.
8. A legacy image app shows Needs rebuild (nothing scaled); `run_app_migration` scales it down; rebuild brings it back.
9. With the flag off (prod today) none of this is visible.
