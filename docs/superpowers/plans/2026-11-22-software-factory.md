# Software Factory: governed software from templates, by an in-OS agent or by Claude Code

Spec and pilot, 2026-11-22. Branch `wp/software-factory`, from `public/main` at `6feaa01e`. Not merged, not deployed.

**The owner's problem.** Today's Software builder works by configuration and does not produce usable software. **The goal**, in the owner's words: *Vercel with governance*. Business users build in a tight, regulated setting (templates only, guided, live preview); a developer using Claude Code reaches the same factory through the OS MCP. Both follow the same rules files and pass the same gates (tests, Trivy, OPA rules, docs). Publishing climbs My, Domain, Company with approval, like datasets and agents.

## 1. What exists today (read from the code, not assumed)

| Area | Fact | Source |
|---|---|---|
| Two paths | A declarative `AppSpec` (default, works, served by the OS renderer) and a coded path (off by default, admin switch). The coded path is the one that must become real. | `apps.ts` createApp; `2026-11-19-software-e2e.md` |
| Templates | `sovereign-app`, `website`, `api-service`, `empty`, `vite-os`, and a legacy `nextjs-supabase` label with no Next.js project behind it. They are TypeScript strings (`{path, content}`), not repositories. | `scaffolds/*.ts`, `apps.ts` |
| Rules | None per app. The build prompt carries a code-structure convention and a vendored-API contract. A rules file the tool can read does not exist. | `platform-mcp.ts`, `builder/prompts.ts` |
| Tests | Nothing runs an app's tests. The compile gate bundles with esbuild; `verify_software` returns a directive. | `compile-gate.ts`, `platform-mcp.ts` |
| CI/CD | No runner, no builder. The OS "builds no images" (07 B8-7); it commits a GitHub-Actions workflow, the image comes from a forge, the digest is pinned into `k8s/deployment.yaml`, the OS applies the committed manifests (dry run, then apply). | `native-deploy.ts`, `runner.ts` |
| Scan | Trivy as one Job per deploy request over the committed tree; scan failure or unavailability blocks approval. | `scan-trivy.ts`, `review.ts` |
| Approval | `request_deploy` opens a card (scan, envelope, diff); `decide_deploy` is builder+ and never the requester. | `review.ts` |
| Namespace | `agentic-apps`: Pod Security `restricted`; ValidatingAdmissionPolicies (kinds, ClusterIP only, one Ingress annotation, own TLS secret, Pods as dry run only: #259 and the apps-ingress allow-list); default-deny NetworkPolicies with **DNS-only egress** (#221 family). | `charts/.../apps-runner.yaml`, `files/apps-admission-policy.yaml` |
| Supply chain | `@sovereign-os/*` is vendored and pinned to an unresolvable registry (`.invalid`); a tree that would fetch it is a blocking scan finding (#90, #245). | `scope-pin.ts`, `scaffold-lock.ts` |
| Authorization | App tool calls: app registry grant, else OPA; writes held for approval; declared actions (`actions.yml`) pass a four-layer intersection (capability, declaration, domain adoption, grant). Apps reach agents with `os.agents.run/get/decide`. | `app-tool-call.ts`, `app-actions.ts`, `core/app-sdk` |
| Data writes | `os.records.add`: an append-only log in an OS store, envelope-gated. Not a governed dataset version. | `app-records-store.ts` |
| Git | Every app is `apps/<slug>/` in its domain repo; external clone and push work through git-http with tokens and a receive gate. | `git-commit.ts`, `app/api/git` |

Two findings shape the design. **Identity does not reach a deployed server-side app today**: the OS session cookie is host-only (a parent-domain cookie is ignored on purpose) and the apps namespace has no egress to os-ui. The SDK works inside the OS-rendered frame, not from a Next.js server on its own host. **Nothing enforces how an app is written**: no rules file, no test requirement, no policy over the source.

## 2. Principles

1. **Real code in real repos.** A template is a directory with its own `package.json`, tests, Dockerfile and CI file. An app is that tree in git. `docker build`, `npm test` and `kubectl apply` work with no OS (the eject test).
2. **One rulebook, two authors.** `AGENTS.md` is the single source of rules; `CLAUDE.md` is `@AGENTS.md` plus Claude-only notes, so the two cannot drift. The in-OS agent loads the same file as its system context.
3. **Rules that bind are checked.** Every rule that must hold is a gate. A rule that is only prose is a suggestion.
4. **Upstream tools as documented.** Node, Next.js, ESLint, OPA (Rego, REST API), Trivy, BuildKit. Apache/MIT/BSD/ISC only.
5. **The platform owns infrastructure.** Business users never write a Dockerfile, NetworkPolicy, secret or workflow. Those are platform-owned files, listed in `PLATFORM_OWNED`, and the template carries them.
6. **Fail closed.** A gate that fails, is unavailable or is missing from the report blocks the deploy. There is no skip.

## 3. Golden-path templates

`templates/<key>/` in the OS repo, versioned with it. First: **`nextjs-web`** (this PR). Next: `fastapi-service` (Python 3.12, FastAPI, pytest, same rules shape), `data-agent-app` (a Next.js app plus a dbt/Dagster data product and an agent system definition, deployed as three governed artifacts that share one lineage).

Each template ships:

| File | Purpose |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | The rules (section 4). |
| `README.md`, `docs/DECISIONS.md` | Documentation the gates require. |
| `src/**`, `tests/**` | A small working app that already uses the SDK, with tests. |
| `src/lib/os/` | The one door to the OS (identity, data, agents). |
| `actions.yml` + `openapi.yaml` | Functions the app exposes to agents. |
| `policy/app-rules.rego` | The rules as OPA policy over the tree. |
| `scripts/factory-gates.mjs` | The gates runnable anywhere: typecheck, lint, tests, policy. |
| `Dockerfile`, `k8s/**`, `.github/workflows/ci.yml` | Platform-owned build, deploy and CI definition. |
| `package.json` + lockfile | Exact pins; the OS SDK vendored under `vendor/`; the scope pin `.npmrc`. |

## 4. The rules file (AGENTS.md), ten sections

Language rules (strict TypeScript, no `any`, no `console`, pinned dependencies with a written reason). Code structure (routes thin; rules in pure `src/lib` functions; one route per directory; only `src/lib/os` talks to the OS). Code documentation (a `FEATURE / USER STORY / ARCHITECTURE` block in every file, README, `DECISIONS.md`). Unit tests (every route imported by a test, every rule tested including the failing input, test first). Security rules (no secrets, validate input, no raw HTML, no absolute-URL fetch, do not edit platform-owned files). **Identity and authorization**: identity from the OS; no role checks, no JWT or cookie parsing; the OS decides and a refusal is passed on. **Data access**: only `os.datasets / metrics / knowledge / files` for reads and the governed write door for writes; never a datastore client. Secrets and configuration (only `OS_BASE_URL` and `APP_SLUG`; secrets come from the OS). Exposing a function to agents. Definition of done: the gates.

## 5. Two authoring paths, one repo, one set of gates

The repo is the app's subtree in the domain git repository, in both paths.

**A. In-OS coding agent (business users).** An agent system on the LangGraph engine (a successor to `os.appsmith`), guided and template-only: it can create an app from a template and edit only files outside `PLATFORM_OWNED`. Tools: `get_template`, `read_file`, `write_file` (path-allow-listed, each write a governed commit authored as the user), `run_tests`, `run_gates` (both in the sandbox Job of section 7), `start_preview`, `request_deploy`. Its system context is `AGENTS.md`; its definition of done is a green gate report. It cannot approve anything. Live preview: an ephemeral sandbox pod running `next dev` behind an os-ui proxy under the user's session (design item, not in the pilot).

**B. External Claude Code.** `get_app_template` (rules, policy, platform-owned paths, files) then `create_software` with the template, `git clone` of the domain repo with a personal token (or `read_app_files` / `push_app_files`), local work under `CLAUDE.md`, `verify_app_gates` (the OS runs the same gates on the committed tree and returns the verdict per gate), then `request_deploy`. A person approves. The push door and the receive gate refuse edits to platform-owned files.

Both paths end in the same pipeline, so neither can ship what the other could not.

## 5a. Git round-trip (go-live #1, before the token flow)

**Owner requirement: the factory is git-native.** A developer opens `apps/<slug>/` in VS Code, commits and pushes, under the same rules and gates as the in-OS builder. The state of `docs/components/git.md` today: apps live at `apps/<slug>/` in the domain repo and clone/push works over HTTPS with a personal access token, but a push to a software app changes the files only (the registry is not derived from them), and `main` is the only accepted ref.

What go-live #1 builds, in order:

1. **A push runs the gates.** The receive hook for `apps/<slug>/` (the pattern the dashboards and agents kinds already use in `git/receive.ts`) runs the receive gate (platform-owned files, `k8s/` rules, scope pin) and then the same sandbox gates as `verify_app_gates`: typecheck, lint, tests, **build** (`next build`, which caught a type error `tsc` missed in the pilot) and the OPA policy. The verdict is stored against the pushed commit sha and shown on the app in the Software tab (per gate, with the failing detail), and `verify_app_gates` returns it. A red push is still accepted into `main` (normal git: no hidden rejection by a long job) but cannot be deployed; a receive-gate refusal (a platform-owned file changed) rejects the push synchronously.
2. **The registry follows the tree.** The hook calls `ingestFromRepo('app', files)` (`ingest-from-repo.ts`, built and tested, **not wired today**: no caller outside tests) so `app.yaml`, `actions.yml` and `openapi.yaml` re-derive the app's metadata and declared agent functions. The existing contract holds: **never apply audience, never retire**. A push cannot widen who sees an app, promote it or delete it; those stay OS decisions with their approvals. A push to a slug without an app record is `unmatched` (creating an app carries the role, domain and principal gates), reported back in the push output.
3. **A deploy request references the pushed commit.** `request_deploy` pins the commit it reviews (it already does through `pinCommitForReview`); it will take an explicit `sha` and refuse a sha whose stored gate verdict is not green or not for that exact commit. What is scanned, gated, approved and deployed is one commit.
4. **Ordinary commits by real authors.** An in-OS agent edit, an OS edit and a VS Code push are all plain commits in `apps/<slug>/`, authored by the actual person (the OS commit path already sets the actor as author and adds `OS-*` trailers; a VS Code push carries the developer's own identity, mapped to their OS user by the token). Concurrent edits follow normal git: a **non-fast-forward push is rejected** and the developer pulls and merges. The in-OS builder commits on top of the current head and, on a head that moved underneath it, re-reads and retries rather than overwriting.
5. **Create writes the template as a commit.** `create_software template: 'nextjs-web'` commits the whole template tree to `apps/<slug>/` at create time, authored by the creator (this PR; before it the scaffold lived only in the file cache until the first deploy request), so the clone URL works the moment the app exists.
6. **Later, optional:** `proposal/*` branches (today `main` is the only ref) become promotion requests: pushing `proposal/<slug>` opens the Domain-promotion approval carrying the commit range, and approval fast-forwards `main`.

**How checks are triggered (owner decision).** As on Vercel, three equal triggers run the SAME sandbox checks (typecheck, lint, test, **build**, OPA policy, security scan):

1. **Automatic on every push** to `apps/<slug>/`, whoever made it: a VS Code push, an OS commit or an in-OS agent commit. The post-receive hook starts the checks for that commit sha.
2. **A "Run checks" button** on the app in the Software tab, which re-runs the checks for the current head.
3. **Chat and MCP**: `verify_app_gates` (the Home chat and the in-OS agent call it after they commit; Claude Code calls it the same way).

All three record the result **against the commit sha** and show it on the app: a status per check, the logs and the time it ran. Deploy accepts only a sha whose checks are all green (a red or missing record blocks, as `evaluateGates` already does). A new push **supersedes** a run still in progress for the same app: the older Job is deleted and its record is marked `superseded`, so a stale result can never be read as the head's. The build check runs `next build` (the pilot's e2e showed `tsc` alone passes a type error that `next build` rejects), so `factory-gates.mjs` gains a `build` gate and `REQUIRED_GATES` gains `'build'` with go-live #1. Runs are idempotent per sha: a repeat trigger for a sha with a finished record returns that record unless "Run checks" is pressed.

Same rules in both doors: the rulebook is in the repo (`AGENTS.md`), the gates are the repo's own `scripts/factory-gates.mjs`, and nothing about the VS Code path is weaker than the in-OS path. Open points: mapping a git token to the OS user for author identity on the push (the git-http authenticator already resolves the principal), and the build gate's cost (about two minutes) against push latency, so it runs asynchronously after the push is accepted.

## 5b. Go-live #2: image build, registry and promotion (PENDING OWNER APPROVAL)

Not started and not to be started until the owner approves the image-build decision (D3). Proposed: a **rootless BuildKit Job** (Apache-2.0) builds the template's own Dockerfile from the green commit and pushes `<registry>/<slug>@sha256:<digest>` to a **Zot** registry (Apache-2.0) the platform owns; on green checks the OS **auto-deploys to `apps-dev`**; the **same digest is promoted to prod by approval** (builder or above, never the requester). This lifts "the OS builds no images" (07 B8-7) and needs: a build namespace with egress to the registry and the npm registry only, Zot with storage and pull credentials for the apps namespaces, and an `apps-dev` namespace with the same Pod Security and admission policies as `agentic-apps`. Rollback is a redeploy of the previous approved digest. Until approval the pilot's Docker build in the e2e stands in for the Job.

## 6. What an app may do: the OS SDK

All access goes through `@sovereign-os/app-sdk` (vendored, Apache-2.0), as the **signed-in user** by default.

- **Read** files, data, connections, KPIs, knowledge: `os.datasets / metrics / knowledge / files`, OPA-checked and row-filtered by the OS.
- **Write**: today `os.records.*`; the target model is in section 9.
- **Apps call agents**: `os.agents.run` returns the run; a run held for approval comes back as `parked` with its `approvalId` and the app shows that it waits (human in the loop); `os.agents.decide` only where the viewer's role allows.
- **Agents call app functions**: the app declares `actions.yml` (name, description, `write`, `scopes`, input) and a matching `operationId`; the OS registers each as a governed tool (four-layer intersection, OPA, Langfuse trace) and proxies the call to the app. The app is the agent's harness. Reserved names (`promote`, `decide_*`) are refused.
- **No hand-made authorization** (policy rule 1) and no direct datastore access (rule 2).

## 7. CI/CD per app and quality gates

One pipeline per app, run by the OS as Kubernetes Jobs (the pattern the Trivy scan already uses), on the exact committed commit:

1. **Gates** (pilot, built): sandbox Job = writer init, OPA native sidecar, `gates` container (`npm ci --ignore-scripts`, then `factory-gates.mjs`). Restricted pod, no token, read-only root, limits, deadline, payload in a Secret owned by the Job.
2. **Scan** (exists): Trivy over the tree (dependencies, committed secrets).
3. **Build**: rootless BuildKit Job (Apache-2.0) builds the template's own Dockerfile and pushes `<registry>/<slug>@sha256:<digest>`. This lifts "the OS builds no images" (07 B8-7) and is an owner decision (section 9). The pilot proves the build with Docker.
4. **Deploy to dev**, automatic when 1 to 3 are green.
5. **Deploy to prod** after approval: the same digest is promoted. Today `agentic-apps` is one namespace per cluster, so dev and prod are the dev and prod clusters (recommended) or `agentic-apps-dev` and `agentic-apps`.

| Gate | Check | Today | Blocks |
|---|---|---|---|
| Tests green | `npm test` (node:test) | pilot | yes |
| Type check, lint | `tsc --noEmit`, ESLint | pilot | yes |
| OPA rules respected | the template's Rego over the tree, evaluated by OPA | pilot | yes |
| Docs present | README, AGENTS.md, CLAUDE.md, DECISIONS.md, doc block in every source file | pilot (as policy) | yes |
| Every route tested and declared | policy rules 6 and 7 | pilot | yes |
| No critical CVE, no committed secret | Trivy | exists | yes (high and critical) |
| Scope pin and lockfile | `scopePinFindings` | exists | yes |
| Manifest and namespace rules | `planAppDeploy`, admission policies, Pod Security | exists | yes |
| Platform files untouched | hash against the template of record | design | yes |
| Budget within limit | LiteLLM key budget, ResourceQuota | design | yes |

The verdict is recomputed by the OS from the individual gates. A report's own `ok` is never trusted; `unavailable` and a missing gate block. `requestDeploy` refuses a golden-path app with 422 while any gate blocks.

**Publishing, budgets, rollback.** Promotion My, Domain, Company reuses the existing ladder and approvals (`request_promotion`, `approve_promotion`): domain admin to Domain, admin to Company, documentation first. Each app gets a **budget** at create time: a LiteLLM virtual key with `max_budget` for LLM spend, and a namespace `ResourceQuota` plus the existing footprint on the card for compute; an exhausted budget blocks the deploy request and pauses agent calls. **Rollback** is a redeploy of the previous approved digest (the OS already records `approvedSha`); data rolls back separately (section 9).

## 8. Keep and replace

| Keep | Replace |
|---|---|
| Domain-repo subtree, `commitAppTree`, git-http and receive gate | Templates as TypeScript strings: replaced by `templates/` directories (legacy ones stay until retired) |
| `native-deploy.ts` rules, runner dry run, admission policies, Pod Security | "The OS builds no images" (B8-7): replaced by the BuildKit Job after the owner's decision |
| Trivy scan Job, scope pin, lockfile evidence | The `nextjs-supabase` label with no Next.js project behind it |
| Review card, `decide_deploy`, four-eyes, approvals ladder | Prose-only build conventions: replaced by rules files plus gates |
| `os.appsmith` / agentic builder loop (its planner, coder, reviewer shape) | The AppSpec composer as the answer to "build software": it stays as the no-code path for dashboards and simple apps |
| SDK, `actions.yml`, four-layer action gate, `os.agents.*` | Host-only cookie as the only identity: replaced by an OS-issued app token (section 9) |
| `os.records` for app-local state | `os.records` as the only write: extended by governed dataset writes (section 9) |

## 9. Open decisions, with recommendations

**Order of go-lives:** #1 git round-trip and the three check triggers (section 5a), #2 image build, registry and promotion (section 5b, pending owner approval), then D1 token flow, D2 dataset writes, the build job, promotion and budgets.

**D1. App identity.** *Recommend:* default **delegated user**. The OS acts as identity provider for apps: the app host redirects to `/api/auth/app-login?app=<slug>`, the OS returns a short-lived signed token (audience = the app, sub, role, domains), the app's server forwards it as a bearer to an OS app gateway that runs the same OPA-checked handlers, and the SDK facade already forwards `authorization`. This needs one NetworkPolicy allowing app pods to reach the gateway path only. Browser-side calls stay possible for OS-rendered apps. **App's own identity** (background jobs, webhooks): the principal `app-<slug>` already exists and today carries only the reads-on/writes-off preset; for background work it gets nothing more until a domain admin adopts specific declared actions (the existing four-layer adoption), bounded to the declared scopes, writes held under the read-only preset, never any human-only verb. No standing service credential inside the app.

**D2. Write model.** *Recommend:* `os.datasets.write(datasetId, rows, { mode })` as the only governed write for shared data, implemented over the existing dataset-version machinery: every write is a **new dataset version** (Iceberg snapshot) with lineage `{app: slug@sha, agent, runId, actor}`, rollback through the existing version rollback, writes outside the app's approved envelope held for approval. `os.records` remains for app-local state. This makes app and agent output "one truth" in the lakehouse instead of in a side store. Not built in the pilot.

**D3. Image builds.** Lift B8-7 with a rootless BuildKit Job in a dedicated build namespace (egress to the registry and npm only). Alternative: keep forge CI and mirror domain repos to a forge; this keeps an external dependency in the critical path.

**D4. Dev and prod.** Separate clusters (recommended: clean blast radius, the digest is the promotion unit) or two namespaces.

**D5. Company scope.** Whether Company-scope apps need a second reviewer plus an admin.

**D6. Preview.** An ephemeral `next dev` pod per session behind os-ui, or a preview build per commit.

## 10. The pilot (this PR) and what it proves

Built: the `nextjs-web` template (rules files, SDK door with delegated identity, a governed write route, an agent-run route that surfaces `parked`, one function exposed as an agent tool, tests, Rego policy, Dockerfile, CI file); `instantiateGoldenPath` with the vendored SDK, scope pin and slug-named lockfile; sandbox gates Job; the verdict logic; `requestDeploy` blocking on gates; MCP tools `get_app_template` and `verify_app_gates`; `create_software template: 'nextjs-web'` (commits the template to `apps/<slug>/` at create); a real-cluster end-to-end proof (`tests/software-factory/e2e.sh`).

Not built, by design: D1 (token flow and gateway), D2 (dataset writes), the BuildKit Job, dev-to-prod promotion, budgets, the in-OS agent system, preview, chart wiring for the sandbox (RBAC, egress to the npm registry, `SOFTWARE_SANDBOX_*` env), and the UI create picker. Each is a separate small go-live.

## 11. Owner decisions of 2026-11-22 (record)

1. **App identity (D1): recommended, pending owner decision.** The OS issues a short-lived signed token for the user, used through an OS app gateway with one narrow egress rule; background jobs run as `app-<slug>` and get grants only after a domain admin adopts specific declared actions. Not built.
2. **Writes (D2): recommended, pending owner decision.** `os.datasets.write` always creates a new dataset version with app/agent/run lineage and the existing rollback; `os.records` stays for app-local state. Not built.
3. **Image builds (D3): APPROVED.** The OS builds images in a rootless BuildKit task and pushes to a Zot registry (digest-only references).
4. **Dev and prod for apps (D4): APPROVED.** Two namespaces on the existing clusters (`apps-dev`, `apps-prod`); promotion moves the same digest, by approval; rollback is the previous digest.
5. **CI engine: APPROVED.** Tekton Pipelines and Triggers (Apache-2.0) run the checks and the build; the pipeline lives in git under `apps/<slug>/.tekton/`; the OS reads PipelineRun and TaskRun status through Kubernetes and fills the engine-neutral per-sha result (`check-record.ts`); a superseded run is cancelled with Tekton's own `spec.status: Cancelled`; deploy stays in the OS (no Argo CD). The pilot's hand-made sandbox Job is replaced by Tekton tasks running the same gates.

### Status of go-live 1 in this branch
Built and tested: `build` is a required gate (template `factory-gates.mjs` runs `next build`); a push to `apps/<slug>/` re-derives the registry through `ingestFromRepo('app')` (never audience, never retire, never create, never another domain's app) and refuses edits to the gate files; check results are recorded per commit sha (`App.checks`: per-check status, detail, trigger, times, engine, run reference); `requestDeploy` takes an optional `sha`, reads the stored record instead of re-running, and refuses a red, missing, unfinished or other-sha record. Not yet built: the Tekton installation and pipelines, the push-triggered run, the "Run checks" button, supersede by cancellation, the chart wiring, the image build, Zot, apps-dev and promotion.

## 12. Gate integrity (decisions of record after the independent security verification)

1. **What requires the gates.** The decision is made from what the OS stored (`app.template` and `serveMode`, `gate-policy.ts`), never from the author's `app.yaml` `template:` line. Every app served as a container (`serveMode: image`) requires the gates, whatever its template; a golden-path app is judged by its own template's gate set, a legacy-template container app by the `nextjs-web` gate set (the only platform-owned set). A legacy app that cannot pass them is blocked until it moves to the golden path: blocked, not skipped. Apps the OS serves itself (`spec`, `runtime`) run no container of the author's, so no gates apply to them.
2. **Whose rules, whose verdict.** The sandbox runs the PLATFORM's copy of `scripts/factory-gates.mjs` and `policy/` (written to a read-only `/platform` volume and laid over the tree; OPA loads `/platform/policy` only). Each gate is its own container; the verdict is that container's exit code in the pod status (0 pass, 3 unavailable, other fail, never ran = unavailable). Log text is display-only, read only for a gate that did not pass. There is no log parser.
3. **PLATFORM_OWNED is enforced** on every user write path (MCP `push_app_files`, the UI editor `saveAppFile`, the commit tool: `commitToApp`; git receive in the git round-trip PR): a golden-path app's write that changes an owned file is refused with 403. `package-lock.json` is not owned (authors add dependencies; `npm ci` and the dependency scan cover it).
4. **Sandbox namespace.** Dedicated (`<release>-sandbox`, never the release namespace: the chart and `runGatesSandbox` both refuse it), Pod Security `restricted`, default-deny both ways, egress only to DNS and the egress proxy (npm registry through it); `software-gates` is excluded from the release namespace's blanket allows; RBAC in the sandbox namespace; a quota. Opt-in (`osUI.software.sandbox.enabled`, default off, because it adds the npm registry to the egress allowlist); while off, container-app deploy requests are blocked with the reason. Proven on kind with Calico (`tests/software-factory/isolation.sh`).
5. **Limits.** `verify_app_gates` is a governed action (write catalog, needs confirmation). One run per app (a new request deletes the older Job by label and the older call reports `superseded`), and a per-user ceiling (429).
6. **Licences.** `sharp` and `@img/*` are removed from the template lockfile (`images.unoptimized`); `os-ui/scripts/strip-lock-sharp.mjs` keeps them out after a regen.

**With Tekton (this PR) the same rules hold, by other means.** The PipelineRun references the chart-owned Pipeline `app-checks` by name (never `.tekton/pipeline.yaml` resolved from the app's commit; `.tekton/` stays platform-owned for the eject copy); its gate steps run the platform's gates script and policy from the ConfigMap `app-checks-platform` (byte-identical to the template, checked by `scripts/check-software-tekton-chart.mjs`); a gate's status is its step's exit code (0 pass, 3 unavailable, else fail), log text is display only; whether checks run (push, button, MCP, deploy) is decided from the stored app, not the tree. The hand-made sandbox Job and its namespace are retired with it; the build namespace's default-deny policies and Calico e2e prove the isolation.
