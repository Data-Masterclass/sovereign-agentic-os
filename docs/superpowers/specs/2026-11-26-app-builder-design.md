# App Builder: living stories, push-to-build, Postgres per app, Dev and Prod

Design spec, 2026-11-26. Branch `docs/app-builder-design` from `public/main` at `de069ab5f`. Plan:
[`docs/superpowers/plans/2026-11-26-app-builder.md`](../plans/2026-11-26-app-builder.md).
Builds on [`2026-11-22-software-factory.md`](../plans/2026-11-22-software-factory.md) (template, gates, Tekton,
owner decisions D3/D4/CI engine) and does not repeat it.

## 0. The product in one paragraph

A Vercel/Supabase-class builder for real apps (Next.js frontend and backend, own Postgres, code in git), where
**epics and user stories are the steering wheel, not a by-product of the chat**. Every requirement, whether typed in
chat, sent over MCP or pushed from an IDE, is classified as *refine a story*, *refine an epic*, *new story* or *new
epic*, shown as a diff card and approved before any code or test changes. Every acceptance criterion
(Given/When/Then) has at least one automated test tagged with its id, and after every build each story shows a
status light. Every push builds an image, every green build runs in **Dev**, and **Prod** gets the same digest after
the go-live rule allows it.

## 1. What exists and what this design changes

| Exists today (read in code) | This design |
|---|---|
| `AppEpic`/`AppStory` on the app record (`apps.ts`); `acceptance` is one free-text string; status `todo/building/done` | Stories become **files in the app's git tree**; the record keeps a derived index. Criteria are structured Given/When/Then. |
| 5-stage builder UI (`ui/SoftwareBuilder.tsx`, `ui/stages.ts`) | Golden-path apps open in a 3-view **App Builder**: Stories, Chat, Code and runs. Declarative (`serveMode: 'spec'`) apps keep the current composer. |
| Tekton `app-checks` pipeline: fetch, gates (typecheck, lint, test, build, policy), Trivy (`files/tekton/pipelines/app-checks.yaml`); verdict per sha in `App.checks` | Same pipeline gains **image build (rootless BuildKit) → push to Zot → image scan**, and the test step emits a **criteria result**. |
| Runner deploys committed `k8s/` into one namespace `agentic-apps`; "the OS builds no images"; image must be `<registry>/<slug>@sha256:…` (`native-deploy.ts`, `runner.ts`) | Two env namespaces **`apps-dev`, `apps-prod`**; a **release** record pins `{sha, digest}` per env; the runner applies the committed manifests with a closed overlay (§6.4). |
| Deploy review: any image app needs a builder's `decide_deploy` (`review.ts`) | Go-live is decided by a **global rule table** in Platform (§9). Scan and checks stay hard gates. |
| Identity reaches only OS-rendered apps (host-only cookie) | **D1 app token**: OS-issued, audience-bound, short-lived (§8). |
| Lifecycle surfaces labelled Studio / Run (`object-lifecycle.ts`) | Labels become **Dev / Prod**; ids `studio`/`run` stay (load-bearing). |
| No database per app | **CloudNativePG** cluster per env, one database and role per app, migrations from git (§7). |

## 2. Architecture

```
            Stories view ─┐          ┌─ Chat view (Ask the OS / MCP) ─┐        IDE: git clone/push
                          ▼          ▼                                ▼              │
                   living spec (stories/*.md in apps/<slug>/, git = source of truth) ◄┘
                          │  approve diff card → commit (author + OS-Source trailer)
                          ▼
   build loop (agent): tests from criteria first, then code → commit to apps/<slug>/
                          │  post-receive (core/infra/git-receive) → Tekton EventListener
                          ▼
   app-checks PipelineRun (agentic-build):  fetch → gates(+criteria result) → scan-tree
                                             → build-image (BuildKit rootless) → push Zot → scan-image
                          │  os-ui reads PipelineRun status (no log parsing) → CheckRecord{verdict, digest, criteria}
                          ▼
   release (sha, digest) ── auto ──► apps-dev  (migrate → rollout)  + preview URL per sha
                          └─ go-live rule table ──► apps-prod (same digest; migrate → rollout); rollback = previous release
```

Everything new in os-ui stays inside the Software tab, except four kernel pieces that other tabs will reuse:
the go-live rule table (`core/policy`), the app token (`core/auth`), the CNPG and Zot adapters (`core/adapters`,
glue rule: only adapters talk to a component), and the Dev/Prod labels.

## 3. Data model: the living spec

### 3.1 Files (source of truth)

```
apps/<slug>/stories/
  EP-1-order-intake/
    _epic.md              # front matter: id, title; body: description + requirements (technical/ux/governance)
    US-3-submit-order.md  # one file per story
```

Story file:

```markdown
---
id: US-3
epic: EP-1
title: Submit an order
state: agreed          # draft | agreed — the only human-decided part of status
---
As a **sales rep** I want **to submit an order** so that **the warehouse can ship it**.

## Acceptance criteria

### AC-1 Valid order is accepted
- Given a signed-in sales rep
- When they submit an order with a customer and at least one line
- Then the order is saved with status "new"

### AC-2 Empty order is refused
- Given a signed-in sales rep
- When they submit an order with no lines
- Then they see "Add at least one line" and nothing is saved

## Notes
Free text, never parsed.
```

Decisions:
- **Git is the single source of truth.** UI, chat and MCP edits are commits through the one commit path
  (`git-commit.ts commitAppTree`); a developer edits the same files. No second version store, no merge logic:
  "two-way sync" is git plus an index re-derived on every push (`app-receive.ts`).
- **IDs are server-assigned, app-unique, never reused**: `EP-<n>`, `US-<n>`, `AC-<n>` (unique within its story).
  The full criterion ref is `US-3/AC-2`. The next free number is the max found in the tree plus one. A model
  never assigns ids.
- **File names are cosmetic** (`US-3-<slug>.md`); the `id` front matter is authoritative. Duplicate ids in a push
  are refused by the receive validator with the two paths named.
- **Status is split**: `draft | agreed` lives in the file (a human decision); `built | verified` is **derived**
  from build evidence (§5), so no bot commits status and a regression drops it automatically.
- Parser is strict on structure (front matter, `## Acceptance criteria`, `### AC-n`, `Given/When/Then` bullets;
  `And` continues the previous keyword) and returns `{path, line, reason, fix}` issues. A malformed file pushed by
  git is **refused by the receive gate** (same validator the UI uses), never half-indexed.

### 3.2 Types (os-ui; exact definitions in the plan's W0 contracts)

```ts
type EpicId = `EP-${number}`; type StoryId = `US-${number}`; type CriterionRef = `${StoryId}/AC-${number}`;
type Criterion = { id: `AC-${number}`; title: string; given: string[]; when: string[]; then: string[] };
type StoryState = 'draft' | 'agreed';                         // in the file
type StoryStatus = 'draft' | 'agreed' | 'built' | 'verified'; // displayed (derived)
type StoryLight = 'green' | 'partial' | 'untested';
type StoryDoc = { id: StoryId; epic: EpicId; title: string; asA: string; iWant: string; soThat: string;
                  state: StoryState; criteria: Criterion[]; notes: string; path: string };
type EpicDoc = { id: EpicId; title: string; description: string;
                 requirements: { technical: string; ux: string; governance: string }; path: string };
type LivingSpec = { sha: string; epics: EpicDoc[]; stories: StoryDoc[] };
type SpecSource = 'ui' | 'chat' | 'mcp' | 'git' | 'migration';
type SpecVersion = { sha: string; at: string; author: { id: string; name: string }; source: SpecSource;
                     proposalId?: string; diff: string };   // unified diff of that file at that commit
```

`App.stories?: { sha: string; index: LivingSpec; lights?: Record<StoryId, StoryLight> }` is a cache rebuilt from
the tree; losing it loses nothing.

### 3.3 Versioning, diff, author

A version is a commit touching the file. `git log --follow` over the file gives sha, time and diff; the author is
the commit author (the acting OS user on UI/chat/MCP commits, the developer's identity on a push, mapped through the
personal access token). Two trailers are added by the OS commit path: `OS-Source: ui|chat|mcp|migration` and
`OS-Proposal: <id>` when a diff card was approved. A push without `OS-Source` is `git`. History view shows each
version's diff, author and source.

### 3.4 Migration of today's design data

On first open of a golden-path app in the App Builder (or `design_software` on it), `epics` on the record are
rendered to files in **one commit** (`OS-Source: migration`): `acceptance` free text becomes the story's Notes and
the story gets `state: draft` with zero criteria (so its light is `untested`, honestly). `epics` stays on the
record, read-only, for declarative apps and rollback; golden-path code stops writing it.

## 4. Requirement classifier and the diff card

Flow (one function behind chat, MCP and the "change without a story" offer):

1. **Input**: requirement text, the current `LivingSpec` (ids, titles, criteria), the source and, for a push, the
   commit message and changed paths.
2. **Classify** with the reasoning model role through LiteLLM, **structured output** validated by a JSON schema:
   `{ classification: 'refine-story'|'refine-epic'|'new-story'|'new-epic', targetId?, epicId?, rationale,
   confidence, change }`. A `refine-*` must name an existing id; new ids are assigned server-side.
3. **Diff card** (`SpecProposal`, persisted, status `pending|approved|rejected|superseded`): classification with
   rationale, the alternative classifications when `confidence < 0.7`, and per file the unified diff plus a
   readable summary (criteria added/changed/removed). The user may switch the classification or edit the proposal
   before approving.
4. **Approve** = any app editor (owner, app `admin` members, owning-domain builder+); self-approval is allowed here
   because this is agreeing a requirement, not shipping. Approval commits the files (`OS-Proposal`), sets touched
   stories to `agreed`, and only **then** may the build loop change code and tests for them.
5. **Reject** records the reason; nothing changes in git.

Rules:
- A newer proposal touching the same story supersedes a pending one (the card says so).
- **Model unavailable** is a typed error on the card ("classifier unavailable"); the user can still write or edit
  the story in the Stories view. No heuristic stand-in pretends to classify.
- The classifier never sees secrets: it receives spec text and commit metadata only.

## 5. Tests from criteria, status lights, story status

- **Tagging convention** (rule in the template's `AGENTS.md`, checked by policy): every test that proves a criterion
  carries the ref in its name: `test('[US-3/AC-2] empty order is refused', …)`. Several refs per test are allowed.
- **Test first**: when a story becomes `agreed`, the build loop first writes one failing test per criterion (from
  Given/When/Then), commits, then writes code until the gates pass. The in-OS write tool refuses code changes for a
  story that is `draft` or has a pending proposal.
- **Criteria result**: the platform's `factory-gates.mjs` runs `node --test` with the built-in JUnit reporter to a
  file, maps test names to refs and writes the Tekton result `criteria`:
  `{"v":1,"results":{"US-3/AC-2":{"pass":1,"fail":0}}}` (no log parsing; the verdict stays the step's exit code). A
  result over the Tekton result size is truncated to a `{"v":1,"truncated":true}` marker and lights show
  `partial` with that reason, never green.
- **Light per story** (from the CheckRecord of the latest finished run on head):
  `green` = every criterion has ≥1 tagged test and none failed; `partial` = some criteria covered, or any tagged
  test failed, or truncated; `untested` = no tagged test for any criterion. Each light lists the criteria behind it.
- **Displayed status**: `draft` (file) → `agreed` (file) → `built` (agreed and its tests are in a green build) →
  `verified` (light `green` on the release currently in Dev). A refined criterion is untested again, so the story
  falls back to `agreed`/`partial` until its tests exist.
- **Developer push without a story**: a push that changes code (anything outside `stories/` and docs) and whose
  commit messages carry no `Story: US-n` trailer or `[US-n]` reference is marked **change without a story** on the
  run. The chat offers "create or update a story for this change", which runs the classifier over the commit message
  and diff summary. Nothing is blocked.

## 6. Build platform

### 6.1 Push-to-build

Triggers stay the three of go-live 1 (push, Run checks, MCP). The `app-checks` pipeline (platform-owned, chart
ConfigMap, never resolved from the app's commit) becomes:

`fetch → gates → scan-tree (Trivy fs) → build-image → scan-image (Trivy image) `

- **build-image**: rootless BuildKit (`moby/buildkit:<v>-rootless`, Apache-2.0, digest-pinned), `buildctl-daemonless.sh`
  building the template's platform-owned `Dockerfile` from the gates' workspace, pushing
  `<registry>/apps/<domain>/<slug>@sha256:…` with `--output type=image,push=true` and writing the Tekton result
  `digest`. Runs only when gates and scan-tree passed. Build args: none from the app; no secrets in the build.
- **Pod security**: the build pod runs in the existing `agentic-build` namespace (Pod Security `baseline`
  enforced, `restricted` audited). BuildKit runs as uid 1000 with `--oci-worker-no-process-sandbox`, `RuntimeDefault`
  seccomp and AppArmor, no privileged, no host paths. **If rootless BuildKit cannot start under `baseline` on SKE or
  kind, workstream C1 stops and reports**; there is no privileged fallback without an owner decision.
- **scan-image**: Trivy over the pushed digest; high/critical blocks the release exactly as the tree scan does.
- Stories-only commits (every changed path under `stories/`) skip build-image and scan-image; gates still run so
  lights refresh.
- A newer sha cancels the app's running PipelineRun (existing supersede).

### 6.2 Registry (Zot)

Zot (Apache-2.0), one Deployment, PVC (20 Gi default), behind the platform ingress at `registry.<appsDomain>` with
TLS (kubelets pull over the node network, so it needs a resolvable TLS host). htpasswd with two identities:
`build` (push to `apps/**`, Secret only in `agentic-build`) and `pull` (read, `imagePullSecret` on the `default`
ServiceAccount of `apps-dev` and `apps-prod`). Retention: keep every digest referenced by a release record plus the
newest 10 per repository; Zot's own retention and GC run it. `softwareRunner.imageRegistry` points at it.
Install-anywhere: `osUI.software.registry.mode: bundled | external` (external = any OCI registry and two
credentials; Zot is not rendered).

### 6.3 Releases

```ts
type AppEnv = 'dev' | 'prod';
type AppRelease = { id: string; slug: string; env: AppEnv; sha: string; digest: string; at: string; by: string;
                    previous: string | null; migrations: { applied: string[]; status: 'ok'|'failed'|'none' };
                    state: 'deploying'|'running'|'failed'|'rolled-back' };
```

- Every green run with a digest creates a **dev release** automatically: migrate (§7) then roll out to `apps-dev`.
- **Prod** takes an existing dev release (same sha, same digest; never a rebuild) after the go-live rule (§9).
- Release records are stored on the app record and **committed** to `os/releases/apps/<slug>.yml` in the domain
  repo (outside `apps/<slug>/`, so it never triggers a build). The live pin (`live/app/<id>` tag, `go-live.ts`) names
  the prod release's sha. What runs is in git: manifests at the sha, digest in the release file.
- **Rollback** = deploy the `previous` release of that env (its digest and sha), no rebuild, no migration run.
  Migrations are forward-only and stay applied; the rollback card lists the migrations applied since the previous
  release and warns that the older code runs against the newer schema (the expand/contract rule in `AGENTS.md` is
  what makes that safe).

### 6.4 Environments and the deploy overlay

`apps-dev` and `apps-prod`: Pod Security `restricted` enforced, the existing ValidatingAdmissionPolicies and ingress
annotation allow-list bound to both, default-deny NetworkPolicies, a ResourceQuota each. The legacy `agentic-apps`
stays until it is empty (§12).

The runner applies the committed `k8s/` manifests at the release sha with a **closed overlay**, shown on the review
card and in the eject docs (`kustomize edit set image` equivalent):

| Field | Dev | Prod |
|---|---|---|
| `metadata.namespace` | `apps-dev` | `apps-prod` |
| container image | `<registry>/apps/<domain>/<slug>@<release digest>` | same digest as the dev release |
| Ingress host and TLS secret | `<slug>.<domain>.dev.<appsDomain>` | `<slug>.<domain>.<appsDomain>` |

Nothing else may differ; `native-deploy.ts` keeps validating the committed files (kinds, names, digest-only,
own secrets only).

### 6.5 Preview per change

Each dev release also gets an immutable **preview** `<slug>-<sha7>.<domain>.dev.<appsDomain>` (a second Deployment
`app-<slug>-p-<sha7>` in `apps-dev`, same overlay). At most 2 previews per app (oldest removed), TTL 8 h, removed by
the reconciler. Previews share the dev database (migrations are forward-only, so an older sha runs against a newer
schema; the expand/contract rule is in `AGENTS.md`). The Dev URL always serves the newest green sha.

### 6.6 Logs

Build logs: TaskRun pod logs (existing). App logs: `pods/log` of the env's Deployment through os-ui's k8s client,
tail and follow, per env and per preview. Redaction before display: the values of the app's own secret env (§7, env and secrets) and
the OS token patterns (`sos_…`, JWTs) are replaced by `[redacted]`. os-ui never logs log content or secret values.

## 7. Postgres per app (CloudNativePG)

- **Operator**: CloudNativePG (Apache-2.0), installed as a pinned platform component (`scripts/cnpg/install.sh`,
  sha256-verified, like Tekton); the chart refuses to render the app databases when the CRDs are missing.
- **One CNPG `Cluster` per env namespace** (`apps-pg` in `apps-dev`, `apps-pg` in `apps-prod`), one instance on
  dev, three on prod clusters later (value). **One database and one role per app**, created by os-ui through the
  CNPG adapter: a Secret `app-<slug>-db` (basic-auth, generated password), a managed role on the Cluster
  (`spec.managed.roles`, `passwordSecret`), a `Database` CR owned by that role. `REVOKE CONNECT … FROM PUBLIC` on
  each database (CNPG post-init SQL), so roles cannot reach each other's databases. Dev and prod databases are
  different clusters in different namespaces: separate by construction.
- Decision: a shared cluster per env, not a cluster per app (a cluster per app costs a pod and a PVC each).
  `dedicated: true` per app is out of scope tonight.
- **Injection**: the platform-owned `k8s/deployment.yaml` gains `envFrom` `app-<slug>-env` (optional) and `PGHOST`,
  `PGPORT`, `PGDATABASE` plain env plus `PGUSER`/`PGPASSWORD` from `app-<slug>-db` (optional). `pg` (MIT) reads
  `PG*` natively; no URL is composed. Same Secret names in both namespaces, so the manifest is identical across envs.
- **Migrations from git**: `apps/<slug>/db/migrations/*.sql` (node-pg-migrate SQL format, `-- Up Migration` /
  `-- Down Migration`; node-pg-migrate is already an approved component). Before each rollout the deploy runs a Job
  in the env namespace from **the release image**, command fixed by the platform:
  `node-pg-migrate up -m db/migrations --migration-file-language sql --single-transaction`. A failed migration
  fails the release before rollout; the previous release keeps running. The prod go-live card lists the pending
  migration files with their SQL.
- **Template rule change**: the factory rulebook says "never a datastore client". It becomes: the app's **own**
  database only through `src/lib/db/` (the one file that imports `pg`), governed shared data still only through the
  OS SDK. The Rego policy enforces both.
- Backups: CNPG barman backups of `apps-pg` in prod are **not** built tonight; the Prod database panel says
  "no backup configured" until they are.

**Env and secrets.** Per app and env: plain variables and secrets in the Secret `app-<slug>-env` (written by os-ui; names validated
`^[A-Z][A-Z0-9_]{0,63}$`, reserved prefixes `PG`, `OS_`, `APP_` refused). Values are write-only in UI and MCP
(the list shows name, kind, updated-by, updated-at). A change rolls the Deployment (checksum annotation). Changing
**prod** env needs the same right as going live in that scope (§9), is audited (name, never value), and never
passes through a model.

## 8. App identity token (D1)

- **Login**: the app server redirects an unauthenticated user to
  `GET /api/auth/app-login?app=<slug>&env=<env>&state=<s>&code_challenge=<c>&code_challenge_method=S256`. The OS
  requires its own session (sign-in round trip if absent), checks the user may **see** the app (its visibility and
  scope), and redirects to the registered callback `https://<app host for env>/os/callback?code&state` with a
  one-time code (60 s, single use, bound to app, env, challenge). No other redirect host is accepted.
- **Exchange**: the app server `POST`s `{code, code_verifier}` to `/api/auth/app-token` over the cluster network
  and receives the token. PKCE (existing `core/auth/pkce.ts`), no client secret: the app holds no standing
  credential.
- **Token**: JWS (Ed25519, `jose` MIT) `{iss: <OS base URL>, aud: "app:<slug>:<env>", sub, role, domains,
  scope: ["read","write","agent-run"], exp: +15 min, jti}`. Never `approval-decide`, never admin verbs. The app stores
  it in a host-only `HttpOnly; Secure; SameSite=Lax` cookie and forwards it as `Authorization: Bearer` from its
  server. Expiry = silent re-login (the OS session makes it one redirect). JWKS at `/api/auth/app-jwks`.
- **Acceptance**: os-ui accepts an app bearer only on the SDK route allowlist (`whoami`, datasets, metrics,
  knowledge, files reads, records, governed writes, agent run/get), verifies signature, `aud` against the app the
  route serves, expiry, and that the user is still active (`user-revocation.ts`). The request then runs as that user
  with the existing OPA checks; the audit records `via: app:<slug>:<env>`.
- **Signing key**: Secret `os-app-token-key` (Ed25519 private key), required when apps are enabled (fail closed);
  rotation = add a second key, JWKS serves both, `kid` selects.
- **Network**: one NetworkPolicy pair: `apps-dev`/`apps-prod` egress to os-ui `:3000` only, os-ui ingress from those
  namespaces. Path restriction is enforced in os-ui (the allowlist), not by the NetworkPolicy.
- App's own identity (background jobs) stays as designed (`app-<slug>`, adopted declared actions only); not built.

## 9. Go-live governance (global rule table in Platform)

```ts
type GoLiveKind = 'app' | 'agent';            // agent rows exist, wired later
type GoLiveScope = 'my' | 'domain' | 'company';
type Reviewer = 'none' | 'builder' | 'domain_admin' | 'admin';
type GoLiveRule = { kind: GoLiveKind; scope: GoLiveScope; reviewer: Reviewer };
```

| kind | scope | reviewer (default) |
|---|---|---|
| app | my | none: the creator or builder goes live alone |
| app | domain | domain_admin of the app's domain |
| app | company | admin |

- **Invariant, not configurable: nobody approves their own go-live.** When the requester is the only eligible
  reviewer, the request stays pending and says "no other eligible reviewer; an admin can change the rule".
- `reviewer: 'none'` still requires green checks, both scans and the request coming from someone allowed to edit the
  app. Rules decide **who reviews**; they never skip a gate.
- Admin edits the table in **Platform → Go-live rules** (UI and MCP `set_go_live_rules`); every change is versioned
  and audited with old and new value. The table is read by `decideDeploy` (approver check), by the app lifecycle
  adapter's `canGoLive`, and by the request path (auto-approve when `none`).
- This governs **going live in Prod**. Audience promotion (My → Domain → Company, `core/policy/ladder.ts`) is
  unchanged; its own-approval carve-out stays as it is.
- Prod env changes, rollback in Prod and retiring a Prod app follow the same row as go-live.

## 10. Agents and apps, both ways

Existing and kept: apps call agents (`os.agents.run/get`, a parked run surfaces as `parked`); agents call app
functions declared in `actions.yml` through the four-layer intersection.

New:
- **Plug an agent** (Stories and Chat): pick an agent system from the Agents tab; the OS adds the `AppAgentGrant`
  and proposes a story ("As a … I can run <agent> on …") whose criteria the build loop implements with the template's
  agent route. The grant follows the existing approval rules for scope.
- **Env-bound actions**: an app's declared actions are registered per env; an agent run in Prod calls the Prod
  release's Service, a Dev run the Dev one (`app-<slug>.apps-<env>.svc`). os-ui reaches the app Service through a
  NetworkPolicy allowing ingress from os-ui to app pods on `8080`.
- The app token never lets an app approve a parked run; approving stays in the OS shell.

## 11. UI: three views

Golden-path apps open in `AppBuilderShell` with three views and an env switch (Dev / Prod) in the header:

1. **Stories** (default for business users): epics as sections, story cards with status chip
   (`draft/agreed/built/verified`) and light (`green/partial/untested`), criteria in Given/When/Then, edit in place
   (each save is a commit), version history with diffs and author/source, pending diff cards on top, "Plug an
   agent".
2. **Chat**: the build loop. Requirements become diff cards inline; approved changes show the build progress
   (tests written, code committed, run status) and end with the Dev/preview URL.
3. **Code and runs**: commits (with "change without a story"), runs per sha with gate/scan/build steps and logs,
   releases per env with Dev/preview/Prod URLs, rollback, app logs, env and secrets, database panel (migrations
   applied, connection names, backup state), clone URL.

Strings: next-intl has **not** merged on `main` (checked 2026-11-26), so every new view keeps its strings in a
`strings.ts` next to it (one object per view, no inline literals), ready for conversion. If the i18n foundation PR
merges before a workstream starts, that workstream uses it instead.

## 12. MCP and chat tools

New (each an MCP twin of a UI action, delegated identity, OPA `authorize()` on writes):

| Tool | Purpose |
|---|---|
| `get_stories(appId, sha?)` | the living spec with status and lights |
| `get_story_history(appId, id)` | versions with diff, author, source |
| `propose_requirement(appId, text)` | classify and open a diff card |
| `decide_requirement(proposalId, decision, edits?)` | approve (commit) or reject |
| `list_app_runs(appId)` / `get_app_run(appId, sha)` | runs, steps, digest, criteria, change-without-story flag |
| `list_app_releases(appId, env?)` | releases with URLs |
| `get_app_logs(appId, env, preview?, tail?)` | redacted app logs |
| `rollback_app(appId, env)` | deploy the previous release |
| `list_app_env(appId, env)` / `set_app_env(appId, env, name, value, secret)` / `unset_app_env` | env and secrets |
| `get_app_database(appId, env)` | database, migrations, backup state (no credentials) |
| `get_go_live_rules` / `set_go_live_rules` | rule table (set: admin) |

Changed: `create_software` (golden path: `template: 'nextjs-web'`, `database: boolean`), `design_software` (writes
story files on golden-path apps; epics accept structured criteria), `build_software` (target must be `agreed`;
returns criteria refs and the tagging rule), `verify_software` (returns lights), `start_preview` (Dev/preview URL),
`request_deploy` / `decide_deploy` / `go_live` (go-live to Prod of a release under the rule table),
`get_software_status` (env URLs, lights, `needs-rebuild`).

## 13. Security model

- Pod Security `restricted` in `apps-dev`/`apps-prod`; build pod `baseline` (BuildKit), gates pod restricted.
- Egress deny-by-default everywhere: apps → DNS, os-ui `:3000`, own env `apps-pg:5432`; build → egress proxy (npm),
  Zot, git-http; Zot → nothing.
- Images by digest only, from the platform registry only, scanned twice (tree and image); deploy refuses anything
  else (`native-deploy.ts`, admission policy).
- Secrets: generated or user-entered values only in Kubernetes Secrets; write-only APIs; redaction in logs; never in
  prompts, git, audit records or error messages.
- Every new mutating route and MCP tool calls governance `authorize()`; audit events for proposal decisions,
  releases, rollbacks, env changes, rule changes.
- App token: audience-bound, 15 min, PKCE, allowlisted routes, user-revocation checked, no approval scope.
- Platform-owned files (Dockerfile, `k8s/`, `.tekton/`, `policy/`, gate script, `vendor/`, `.npmrc`) stay
  unwritable by any author path.
- Licences: BuildKit, Zot, CloudNativePG, Tekton (Apache-2.0); `jose`, `pg`, node-pg-migrate (MIT). Each new image
  and package goes through `licenses/policy.json`, `THIRD-PARTY-LICENSES.md`, `components/<name>/UPSTREAM.md`, SBOM.

## 14. Migration of existing apps

- **Declarative apps**: untouched.
- **Image apps whose manifests reference a registry other than the configured one** (the removed Forgejo registry):
  a boot reconcile sets `deploy.state = 'needs-rebuild'` with the reason, scales their `agentic-apps` Deployment to 0
  (reversible, recorded), and the App Builder shows **Needs rebuild** with one button: run the pipeline on head →
  dev release → go-live to Prod under the rule table. After the first Prod release succeeds, the app's objects in
  `agentic-apps` are deleted. `agentic-apps` is removed from the chart when no app uses it.
- **Golden-path apps on the record-only epics**: §3.4.
- Coded apps on legacy templates stay on their current path; moving them to the golden path is a manual rebuild.

## 15. Testing strategy

- **Unit** (node:test, per workstream): story parser/renderer round-trip and issue reporting; id allocation;
  classifier schema validation and refusal paths (model stubbed); proposal lifecycle; lights and status derivation
  tables; criteria result mapping incl. truncation; release state machine and rollback refusal; overlay (exactly three
  fields change); redaction; env name validation; rule table evaluation incl. self-approval and "no eligible
  reviewer"; token mint/verify (aud, exp, revocation, scope), code single-use and redirect binding.
- **Chart checks**: `check-software-tekton-chart.mjs` extended (pipeline has build-image/scan-image, criteria result,
  byte-identical gate files), new `check-software-apps-envs-chart.mjs` (both namespaces restricted, policies bound,
  NetworkPolicies), capacity gate with the new workloads, licence gate.
- **kind e2e journey** (`tests/software-factory/app-builder-journey.sh`, kind + Calico + Tekton + CNPG + Zot, model
  stubbed by `mockModel`): create app with database → propose and approve a story with two criteria → push code and
  tagged tests (one criterion untested) → run → build → Zot digest → dev release with migration → curl Dev URL through
  app-login → lights `partial` → push the second test → `green`/`verified` → request go-live in Domain scope → same
  user cannot approve → domain admin approves → Prod serves the same digest → rollback → negative twins: unscanned
  digest refused, foreign registry refused, app token with wrong `aud` refused, cross-app database connect refused.
- **Dev acceptance** (after deploy to dev, before any prod): the owner's checklist in the plan, run with synthetic
  data on `dev.agentic.datamasterclass.com`.

## 16. Out of scope tonight

A cluster per app database, database branches per preview, CNPG backups for app databases, custom domains,
autoscaling and scale-to-zero, D2 governed dataset writes, app OpenTelemetry tracing, branches other than `main`
(proposal branches), a Python template, Jira sync of stories, converting existing tabs to i18n, wiring the rule table
into the Agents go-live (rows exist, enforcement later), end-user roles inside apps beyond OS roles, image signing,
"Use as data" from an app database, enabling any of this on prod (dev first; prod after the owner tests on dev).
