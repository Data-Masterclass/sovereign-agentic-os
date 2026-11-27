# App Builder: implementation plan (tonight)

Spec: [`docs/superpowers/specs/2026-11-26-app-builder-design.md`](../specs/2026-11-26-app-builder-design.md).
Base: `public/main`. Every workstream: its own branch `wp/app-builder-<letter>` from `public/main` **after W0 merged**,
its own PR with tests, Rebase-and-merge, no deploy. Read `CONTRIBUTING.md` and `os-ui/ARCHITECTURE.md` first. Every new
source file carries the SPDX header and the `FEATURE / USER STORY / ARCHITECTURE` block. New UI text: the i18n foundation HAS merged, so every view uses
`useTranslations('software')` (admin views: `'admin'`) with keys in all seven `os-ui/messages/<locale>/<namespace>.json`
(informal address, docs/i18n/how-to.md) and registers its files in `scripts/i18n-converted.json`; no `strings.ts`
(see "W0 as built" below for the key subtrees).

**Prod safety (every workstream).** Everything is behind `softwareRunner.environments.enabled` (default `false`) →
`SOFTWARE_APP_BUILDER`. Acceptance check in every PR: *flag off ⇒ zero behaviour change* — default chart render
byte-identical to `public/main` for the objects you touch, existing UI/labels/routes unchanged, every new route and
MCP tool answers `app_builder_disabled`, **every `_os-ui-env-*` partial renders nothing (no os-ui env change, no
pod restart)**, and the `nextjs-web` v1 template is byte-identical (all template changes go to `nextjs-web@2`, selectable
only with the flag on). Only H turns it on, in `values.dev.yaml`.

**Names (every workstream).** Never key an object on slug alone: use `appResourceName(domain, slug, part?)` and
`appDbIdent(domain, slug)` from W0 (spec §2b). Every workstream that creates a name has a test with the same slug in
two domains.

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
| `lib/platform-mcp.ts`, `mcp/software-write-tools.ts` | W0 | `mcp/app-builder/{a,b,c2,d}-tools.ts` (tool arrays + handlers), dispatched by `mcp/app-builder/index.ts`; changed existing tools route `templateVersion: 2` apps to `appBuilderHandlers[name]` |
| `lib/native-deploy.ts` | C2 | D owns `lib/deploy-env-block.ts` (`appDeploymentEnv(domain, slug)`), called from `appDeployFiles` |
| `lib/lifecycle-adapter.ts` | F | C2 owns `lib/releases/consequences.ts` (`releaseConsequences(app)`), called from `consequences` |
| `lib/check-record.ts`, `lib/model.ts` | W0 | fields added in W0 |
| `lib/app-receive.ts` | W0 | `lib/receive-hooks.ts` registry: A registers stories index/validate, B registers post-hoc proposals |
| `templates/nextjs-web/**` (v1) | frozen | nobody edits v1 |
| `templates/nextjs-web-v2/AGENTS.md` | W0 (index + contradictions fixed) | `templates/nextjs-web-v2/docs/rules/{stories-and-tests (B), own-database (D), identity (E)}.md` |
| `templates/nextjs-web-v2/{Dockerfile,package.json,migrate/**,k8s/**}` | D | — |
| `templates/nextjs-web-v2/{src/lib/os/**,src/middleware.ts,src/app/os/**}` | E | — |
| `templates/nextjs-web-v2/policy/app-rules.rego` + `files/tekton/platform/v2/app-rules.rego` | D | B/E add no Rego |
| `templates/nextjs-web-v2/scripts/factory-gates.mjs` + `files/tekton/platform/v2/factory-gates.mjs` | B | — |
| `lib/golden-path.ts` (versions, `PLATFORM_OWNED` per version) | D after W0 | — |
| `templates/base/network/egress-policies.yaml` (os-ui egress to `apps-*`) | E | — |
| `templates/base/priority-classes.yaml` (`soa-build-low`) | C1 | — |
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
/** `app-<domain>-<slug>-<h8>[-<part>]`, RFC 1123, ≤ 63 chars, h8 = first 8 hex of sha256("<domain>/<slug>"); `<domain>-<slug>` cut when longer (W0 decision, see "W0 as built"). */
export function appResourceName(domain: string, slug: string, part?: 'db' | 'env' | 'p1' | 'p2' | 'migrate' | 'revoke'): string;
/** `app_<domain>_<slug>_<h8>` in [a-z0-9_], ≤ 63 bytes; `<domain>_<slug>` cut when longer. Database AND role name. */
export function appDbIdent(domain: string, slug: string): string;
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
   `database?: { dev?: …; prod?: … }`, `templateVersion?: 1 | 2` (absent ⇒ 1); consents live in E's own store), `DeployState += 'needs-rebuild'`,
   `CheckRecord += digest?, criteria?, storyless?`, all new `config.ts` keys.
7. Extension points from the ownership table: `mcp/app-builder/*` stubs + dispatch; `deploy-env-block.ts` stub
   (returns `[]`); `releases/consequences.ts` stub (returns `[]`); values blocks and env partial stubs; licence
   fragment support in `scripts/license-gate.mjs` (fragments count as inventory, gate rules unchanged);
   **template versioning**: `templates/nextjs-web-v2/` as a copy of v1 whose `AGENTS.md` is an index pointing at
   `docs/rules/*.md` stubs ("never a datastore client" and identity statements replaced by pointers); `golden-path.ts`
   versions (`nextjs-web@2` selectable only with the flag), `gate-policy.ts` and the platform-owned check compare each
   app with its `templateVersion`; chart gate files moved to `files/tekton/platform/v1/` with a `v2/` copy,
   `app-checks-platform` ConfigMap keyed per version, pipeline param `templateVersion` (W0 makes this move before C1
   owns the pipeline; `check-software-tekton-chart.mjs` compares per version).
8. UI: `ui/app-builder/AppBuilderShell.tsx` (Stories | Chat | Code and runs, env switch) with three placeholder views
   in `ui/app-builder/{stories,chat,runs}/` (text from the `software` namespace); `SoftwareBuilder.tsx` routes `templateVersion: 2` apps to
   the shell **only when the flag is on**.

Acceptance: with the flag off the rendered os-ui Deployment (env included) is byte-identical to `public/main`, v1
apps' gate verdicts are unchanged, `nextjs-web@2` is not selectable.
Tests: `appResourceName`/`appDbIdent` (length, charset, hash suffix, same slug in two domains ⇒ different); contracts compile; `canReview` table (admin satisfies domain_admin, self never, no eligible reviewer);
pre-deploy and receive hook registries; flag off ⇒ routing unchanged and guard refuses; default chart render
unchanged.

### W0 as built (decisions where the plan was open, and the exact names later workstreams use)

Everything below is on `main` after the W0 PR; later workstreams code against these names.

**Contracts** — `os-ui/tabs/software/lib/app-builder-contracts.ts`: every type and constant of item 1 verbatim, plus
`TemplateVersion = 1 | 2`, `TEMPLATE_VERSIONS`, `templateVersionOf(app)` (absent ⇒ 1; re-exported by `apps.ts`),
`AppResourcePart`, `APP_RESOURCE_PARTS`, `APP_NAME_MAX`, `appNameHash(domain, slug)`, `sha256Hex` (pure, client-safe),
`AppDatabaseRecord` (D's per-env record: `name`, `secret`, `namespace`, `createdAt`, `migrations`).
- **Decision (names):** the hash is ALWAYS part of the name: `appResourceName` = `app-<domain>-<slug>-<h8>[-<part>]`,
  `appDbIdent` = `app_<domain>_<slug>_<h8>`, cut before the hash when longer than 63. "Hash only when too long" collides:
  (domain `a`, slug `b-c`) and (domain `a-b`, slug `c`) both give `app-a-b-c`, and app `x`'s preview `app-d-x-p1` is app
  `x-p1`'s Deployment. A fixed-length hash before the closed part set makes every name decode to one (domain, slug,
  part). Characters outside the charset (`.`, `_`, capitals in a domain) become `-` / `_`; the hash is of the raw
  `"<domain>/<slug>"`. An unknown `part` throws.

**Hooks** — `lib/pre-deploy-hooks.ts`: `registerPreDeployHook(name, h)`, `runPreDeployHooks(i)`, types `PreDeployInput`,
`PreDeployResult`, `PreDeployHook` (in order; first refusal wins, prefixed `<name>: `; a throw is a refusal; the same name
replaces in place). `lib/receive-hooks.ts`: `registerReceiveHook(name, h)`, `runReceiveHooks(i)`, `onlyStoriesChanged`,
types `ReceiveHookInput { app, changed, sha, pusher, messages }`, `ReceiveHook` (a throw becomes a note). `app-receive.ts`
runs them per ingested app **only with the flag on**, for the app of THAT domain (`getAppByDomainSlugInternal`), with the
app's changed files; `messages` = the pushed head commit's message (the receive gate hands no old sha; a hook that needs
the whole range reads the log itself).

**Go-live rules** — `os-ui/core/policy/go-live-rules.ts`: `GoLiveKind`, `GoLiveScope`, `Reviewer`, `GoLiveRule`,
`DEFAULT_GO_LIVE_RULES` (frozen; app and agent rows), `GoLiveRequest { kind, scope, domain, requestedBy }`,
`GoLiveUser { id, role, domains }`, `goLiveDecision(rules, kind, scope, domain) → { rule, reviewer, autoApprove, reason }`,
`canReview(rules, req, reviewer) → { ok: true } | { ok: false, reason }`, `noEligibleReviewer(rules, req, candidates)`,
`scopeOfVisibility(v)`, `async currentGoLiveRules()` (async so F's store fits). Decisions: below admin the reviewer must
belong to the app's domain; a missing row fails closed to `admin`; with reviewer `none` nobody "reviews" (`canReview`
refuses, the go-live auto-approves).

**Flag** — `config.appBuilderEnabled` (getter; only `SOFTWARE_APP_BUILDER=on`). `os-ui/core/kernel/app-builder-flag.ts`:
`appBuilderEnabled()`, `appBuilderGuard()`, `assertAppBuilderEnabled()` (throws `AppBuilderDisabledError`, status 403,
`code: 'app_builder_disabled'`, mapped by `core/mcp/server.ts structuredError`), `appBuilderDisabledResponse()` (403 JSON
or null — every new API route starts with it), `isAppBuilderDisabled(e)`, `APP_BUILDER_DISABLED`. Kernel, because F's
labels (core/ui) read it. Other new config keys (rendered by their owners' partials): `appsDevNamespace`,
`appsProdNamespace`, `appRegistry`, `appRegistryPull` (C1: `SOFTWARE_APPS_DEV_NAMESPACE`, `SOFTWARE_APPS_PROD_NAMESPACE`,
`SOFTWARE_APP_REGISTRY`, `SOFTWARE_APP_REGISTRY_PULL`), `appDatabasesMode`, `appDatabasesCluster` (D:
`SOFTWARE_APP_DATABASES_MODE`, `SOFTWARE_APP_DATABASES_CLUSTER`), `appTokenKeyFile`, `appTokenIssuer` (E:
`OS_APP_TOKEN_KEY_FILE`, `OS_APP_TOKEN_ISSUER`).

**App record** — optional `templateVersion`, `stories`, `proposals`, `releases`, `unreviewed`, `database` (types from the
contracts); `stories`/`proposals`/`releases` persist as `<field>Json` strings (like `spec`). `DeployState` gains
`'needs-rebuild'`. `CheckRecord` gains `digest?`, `criteria?: CriteriaResults`, `storyless?`. Also in `apps.ts`:
`receiveTemplateVersion(slug)` (sync, for the receive gate; fails closed to the highest version while the cache is cold),
`getAppByDomainSlugInternal(domain, slug)`, `createApp(user, { …, templateVersion?: 2 })` (only with `template:
'nextjs-web'`, only with the flag on, else `app_builder_disabled` before anything is written; v1 records carry no field).

**MCP** — `tabs/software/mcp/app-builder/{a,b,c2,d}-tools.ts` each export `<ws>Tools: McpTool[]` (NEW tools) and
`<ws>Handlers: Record<string, AppBuilderHandler>` (keyed by an EXISTING Platform MCP tool name). `types.ts`:
`AppBuilderHandler = (user, args, app) => Promise<unknown>`. `index.ts` (W0): `appBuilderTools` (each guarded, spread into
`softwareWriteTools`), `appBuilderHandlers`, `routeToAppBuilder(tool, user, args)` (called first in `callPlatformMcp`;
null with the flag off, without a handler, without `appId`, or for a non-v2 app), `guardAppBuilderTool`, `mergeUnique` (a
name registered twice is a load error). `create_software` accepts `template: 'nextjs-web@2'`; `get_app_template` lists and
reads `nextjs-web@2` only with the flag on.

**Extension stubs** — `lib/deploy-env-block.ts`: `appDeploymentEnv(domain, slug): AppDeploymentEnvBlock` =
`{ env: K8sEnvVar[]; envFrom: K8sEnvFrom[] }` — **decision:** an object, not a list, because `envFrom` is not an env
entry. `appDeployFiles` merges it only for `DeployContext { domain, templateVersion: 2 }` (new optional fields).
`lib/releases/consequences.ts`: `releaseConsequences(app): Promise<string[]>`; the app lifecycle adapter's
`consequences` calls it only with the flag on.

**Template versioning** — `templates/nextjs-web-v2/` = v1 copy whose `AGENTS.md` is an index, with
`docs/rules/{stories-and-tests,own-database,identity}.md` stubs carrying the moved v1 text (owners B, D, E); `app.yaml`
says `template: nextjs-web@2`. `golden-path.ts`: `TemplateVersion`, `GOLDEN_PATH_VERSIONS`, `templateDirOf`,
`templateRef`, `parseTemplateRef`, `selectableTemplateVersions(key, appBuilderOn)`, `PLATFORM_OWNED_BY_VERSION`,
`platformOwnedOf(version)`, and an optional trailing `version` (default 1) on `readTemplate`, `rulesOf`,
`goldenPathFiles`, `instantiateGoldenPath`, `gateFilesOf`, `applyGateOverlay`, `isPlatformOwnedPath`,
`platformOwnedViolations`, `platformOwnedRemovals`, `assertNoPlatformOwnedChange`. `gatePolicyFor(app).version`;
`templateFiles(…, version?)`. Chart: `files/tekton/platform/v1/` (moved) and `v2/` (copy); ConfigMap
`app-checks-platform` keys `v1.factory-gates.mjs`, `v1.app-rules.rego`, `v2.…`; Pipeline params `templateVersion`
(default "1") and `storiesOnly` (default "false"); the gate volumes select `v$(params.templateVersion).<file>` (Tekton
substitutes params in configMap item keys; an unknown version has no key, so the pod would stay in FailedMount — the CEL
filter prevents it); both fields are OPTIONAL at the listener (an os-ui older than W0 omits them during a rolling
upgrade): the CEL filter admits an absent field or `templateVersion in ['1','2']` / `storiesOnly in ['true','false']`,
and CEL `overlays` default them to "1"/"false", which the TriggerBinding reads as `$(extensions.<name>)`. `tekton-checks.ts StartInput
{ templateVersion?, storiesOnly? }` posts both (W0 never sets `storiesOnly`). `scripts/check-software-tekton-chart.mjs`
compares each version with its template.

**Chart** — values: `softwareRunner.environments.enabled: false` (C1's block), `osUI.software.registry: {}` (C1),
`osUI.software.databases: {}` (D), `osUI.appToken: {}` (E). Partials: `_os-ui-env-appbuilder.tpl`
(`soa.osUI.env.appBuilder`), `_os-ui-env-registry.tpl` (`soa.osUI.env.registry`), `_os-ui-env-databases.tpl`
(`soa.osUI.env.databases`) — in `soa.osUI.runEnv` — and `_os-ui-env-apptoken.tpl` (`soa.osUI.env.appToken`) in
`soa.osUI.adminEnv` only (a signing key is an HTTP-path credential). Each renders nothing while the flag is off.
`scripts/check-app-builder-flag-off.mjs [--base <ref>]` proves flag off ⇒ the os-ui Deployment and every non-Secret object
render byte-identical to the merge-base and no object is added or removed (default and prod-like values). Run it in every
App Builder PR (CI's shallow checkout has no base, so it is a PR-description proof, not a CI step).

**Licence fragments** — `licenses/fragments/<ws>.json`: `{ "components": [{ name, version, spdx, bundled, license_file?,
note? }], "attributions": ["…"] }`, read by `scripts/license-gate.mjs` (`--fragments DIR`; `scanFragment` in
`scripts/lib/license-policy.mjs`) as inventory with unchanged rules; attribution lines count until H folds them.

**UI** — `ui/app-builder/AppBuilderShell.tsx` (`AppBuilderView`, `AppBuilderApp`, `AppBuilderViewProps { app, env,
onReload }`), placeholders `stories/StoriesView.tsx`, `chat/ChatView.tsx`, `runs/RunsView.tsx`; `ui/app-builder/routing.ts`
`usesAppBuilder(app, appBuilder)`. GET `/api/apps/[id]` adds `appBuilder: true` only with the flag on. i18n keys
`software.appBuilder.{shell,stories,chat,runs}.*` in all seven locales; the folder `os-ui/tabs/software/ui/app-builder` is
registered in `scripts/i18n-converted.json`. Each workstream adds keys only under its own subtree (`appBuilder.stories` A,
`appBuilder.chat` B, `appBuilder.runs` C2, `appBuilder.env`/`appBuilder.database` D).

**Not in W0:** v2 `k8s/` names still come from `native-deploy.ts` (`app-<slug>`); C2 switches v2 to `appResourceName`.
`regen-golden-path-lock.mjs` regenerates v1 only; D extends it for v2 when it changes v2's dependencies.

## A — Living spec: files, versioning, sync, Stories view

**Owns:** `lib/stories/{files,ids,store,history,migrate,receive-index}.ts` (+ tests), `ui/app-builder/stories/**`,
`app/api/apps/[id]/stories/**`, `mcp/app-builder/a-tools.ts`, `templates/nextjs-web-v2/stories/**`. **Modifies:**
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
`templates/nextjs-web-v2/docs/rules/stories-and-tests.md`, v2 `factory-gates.mjs` (template and `files/tekton/platform/v2/`). **Modifies:**
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

**Step 1 — proof before anything else (stop-and-report gate), on BOTH kind and the dev SKE cluster** (record the
SKE Kubernetes version; user namespaces must be supported). The builder image builds the v2 template in a pod with
`hostUsers: false`, RuntimeDefault seccomp/AppArmor, no privileged, `baseline` namespace, native snapshotter,
`--oci-worker-net=host`, output OCI tar; Trivy SBOM of the builder image has no GPL/AGPL. **Approved fallback** if
RuntimeDefault seccomp blocks it: a Localhost seccomp profile distributed by security-profiles-operator (Apache-2.0,
`scripts/spo/install.sh`, value `osUI.software.build.seccomp: runtime-default | localhost`), **dev only**, still no
privileged and no capability beyond `baseline`. If that fails too, **stop and report; build nothing else in C1** (the
other workstreams continue).

Then: pipeline `fetch → gates (criteria result, CRITERIA_RESULT_PATH) → scan-tree → build-image (when
storiesOnly == "false") → push-image (crane, only pod with the per-domain push Secret, result digest) →
scan-image`; Zot (ClusterIP, PVC, retention, sync mirror for base images via egress proxy, Ingress only with
non-empty `allowedSourceRanges`, exposure modes `ingress-restricted | internal-lb | external`); `apps-dev`/`apps-prod`
(PSS restricted, admission policies bound, default-deny, DNS on **53 and 8053** (SKE CoreDNS), **ingress 8080 from
ingress-nginx and from os-ui**,
quotas, os-ui RBAC, pull secret). Build pods (`build-image`, `push-image`, gates) use PriorityClass `soa-build-low` (added to `priority-classes.yaml`).
Zot users: os-ui writes a random password Secret per domain; the chart-owned `zot-users` Job (a small Go tool in
`images/builder`, `golang.org/x/crypto/bcrypt` BSD-3) renders the htpasswd Secret Zot reloads; no new os-ui
dependency. NetworkPolicies owned here: app default-deny/DNS/ingress, build pod egress
(proxy, Zot, git-http), push pod egress (Zot), Zot ingress (build, push, ingress controller) and egress (proxy).

Tests: chart checks (§15 of the spec), DNS policies include 8053, build pods low priority, Zot repository paths per
domain, flag off ⇒ default render unchanged, licence gate with fragment, kind: fixture
app → digest in Zot, build pod has no registry credential, scan-image verdict.

## C2 — Releases, Dev/Prod deploy, previews, logs, rollback, needs-rebuild

**Owns:** `lib/releases/{store,overlay,auto-dev,previews,logs,rollback,needs-rebuild,consequences}.ts`,
`ui/app-builder/runs/**` (except D's panels), `app/api/apps/[id]/{releases,logs,rollback}/**`,
`mcp/app-builder/c2-tools.ts`, `lib/native-deploy.ts`, `lib/runner.ts`, `lib/review.ts`, `lib/tekton-record.ts`,
`lib/checks-sync.ts`, `lib/tekton-checks.ts` (params `storiesOnly`, `imageRepo`).

- names through `appResourceName` everywhere (Deployment, Service, Ingress, TLS, preview slots);
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

Tests: same slug in two domains deploys side by side, release state machine, overlay exactness, auto-dev conditions, preview slot reuse, rule paths, unreviewed
block, rollback, redaction, needs-rebuild never touches the cluster without the explicit action, flag off.

## D — Postgres per app, env and secrets, migrations

**Owns:** `scripts/cnpg/{install.sh,versions.env}`, `templates/base/os-ui/software-app-databases.yaml` (Cluster
`apps-pg` per env with `pg_hba` `hostssl sameuser all all scram-sha-256` + `host all all all reject`; NetworkPolicies:
5432 from app pods and `soa.dev/role: app-migrate` Jobs of the namespace, 5432/8000 between instances, 8000 from
the operator namespace, egress to the API server and DNS; migrate Job egress to apps-pg and DNS), values block
`osUI.software.databases` (`mode: cnpg | external`, external designed only), `_os-ui-env-databases.tpl`,
`core/adapters/cnpg/client.ts`, `lib/appdb/{database,migrations,env-secrets}.ts`, `lib/deploy-env-block.ts`,
`templates/base/os-ui/software-app-databases-rbac.yaml` (os-ui Role in `apps-dev`/`apps-prod`: `clusters.postgresql.cnpg.io`
get/patch on `apps-pg`, `databases.postgresql.cnpg.io` create/get/delete, Secrets and Jobs it creates),
`lib/golden-path.ts` (v2 `PLATFORM_OWNED` += `migrate/`), `ui/app-builder/runs/{EnvPanel,DatabasePanel}.tsx` (`software.appBuilder.env|database.*`), `app/api/apps/[id]/{env,database}/**`,
`mcp/app-builder/d-tools.ts`, `components/postgresql/UPSTREAM.md` (operator pin), `licenses/fragments/d.json`;
template **`nextjs-web-v2` only**: `Dockerfile` (`migrate` stage → `/app/migrate/` in the run image), `package.json` (`pg`), `migrate/package.json`
+ lockfile (node-pg-migrate, pg), `src/lib/db/index.ts`, `db/migrations/0001_init.sql`, `docs/rules/own-database.md`,
`policy/app-rules.rego` + chart copy (pg only in `src/lib/db/`); scaffold lockfile regenerated with the documented
script, never by hand.

- `database.ts`: `ensureAppDatabase(app, env)` → Secret, managed role, `Database` CR (names `appResourceName(…,'db')`,
  `appDbIdent`), then the one-shot Job (label `soa.dev/role: app-migrate`) **as the app role** running `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`; idempotent; no superuser in os-ui.
- `migrations.ts`: registers a pre-deploy hook running the migrate Job from the release image (fixed command).
- `env-secrets.ts`: list/set/unset, name rules, reserved prefixes, write-only, audit, Prod right via W0 rules.

Tests: same slug in two domains ⇒ two databases/roles/Secrets, name rules, value never returned/logged, CNPG object golden fixtures validated against the CRD schema, migrate
Job spec, failed migration blocks rollout, Rego; kind: **role A cannot connect to database B** (both layers), app pod
in `apps-dev` cannot reach `apps-pg` in `apps-prod`; image built from the template contains `/app/migrate`.

## E — App identity token (D1) and consent

**Owns:** `core/auth/{app-token,app-login-codes,app-consent}.ts`, `app/api/auth/{app-login,app-token,app-jwks,
app-consent}/**`, consent screen component, My Settings consent list, `core/app-sdk` token helper,
`templates/nextjs-web-v2/src/lib/os/**`, `src/middleware.ts`, `src/app/os/callback/route.ts`,
`templates/base/network/egress-policies.yaml` (os-ui egress to `apps-dev`/`apps-prod` :8080 for action calls),
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
signatures unchanged), `tabs/admin/ui/GoLiveRules.tsx` (`admin.goLiveRules.*`), the `sections.ts` entry,
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
| security-profiles-operator, **only if C1 needs the fallback** | 30m | 128Mi | 256Mi |
| **Long-running total** | **190m** (79 % → ~84 %); **220m** with the fallback (~84.8 %) | ~1.7Gi | ~6Gi |
| Transient, one at a time (`agentic-build` quota `cpu: 600m`, `pods: 4`, PriorityClass `soa-build-low`): gates 200m, build 300m, push/scan/migrate 50m each, sequential | **≤ 600m** | ~1.5Gi | ~4Gi |

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
