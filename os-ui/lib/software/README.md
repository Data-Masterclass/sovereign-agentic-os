# `lib/software` — the Software golden path (2026-06-30)

The governed surfaces the **Software tab** layers on top of `lib/apps.ts` (the
app home-of-record). `lib/apps.ts` already owns create → scaffold → promote; this
module adds the 2026-06-30 golden path: the **deploy state machine**, the
**Builder-reviewed deploy gate**, the **auto-MCP → OPA** capability pipeline, the
**metadata convention**, the four **authoring front doors**, app **lifecycle**,
and the **Platform MCP**.

Two design rules hold throughout:

- **One convergent pipeline.** However an app is authored (chat, Platform MCP,
  git push, git import) and whatever its template (web / service / script /
  dashboard), it ends up on the *same* commit → metadata-parse → auto-MCP → OPA →
  review plumbing, governed identically.
- **Honest live/offline-mock.** Every effectful step reports
  `mode: 'live' | 'offline-mock'`, mirroring `lib/agents/build/server.ts`. On a
  cluster the real Forgejo/Argo plumbing runs (`live`); on a laptop the in-process
  teaching mock runs (`offline-mock`). The *governed* logic is identical either way.

## Module map

| Module | Role | Key exports |
|---|---|---|
| `model.ts` | Pure, client-safe types (no secrets, no server imports) so both UI and server import it. | `RunMode`, `DeployState`, `AppStatus`, `DeployEnvelope`, `ResourceFootprint`, `ScanResult`/`ScanFinding`, `ReviewCard`/`DiffSummary`, `AppManifest`, `ConsumedResource`, `OpenApiSpec`, `GeneratedTool`, `ScaffoldFile`, `AdapterStep` |
| `scan.ts` | Deterministic security scan (SAST · deps · secrets) feeding the review card; runs offline, live swaps in Semgrep/Trivy/gitleaks behind the same shape. | `securityScan(files, mode)` |
| `auto-mcp.ts` | OpenAPI → MCP tools → reads-on/writes-off preset → compiled into OPA via the *same* Connection gate. | `toolsFromOpenApi`, `applyReadsOnWritesOff`, `compileToOpa`, `generateAndCompile` |
| `metadata.ts` | The repo metadata convention (`app.yaml` / `/.app/` / OpenAPI), parsed on every commit; derives what it can, flags the rest in `missing`. | `parseAppManifest`, `parseOpenApi`, `renderAppYaml`, `defaultOpenApi` |
| `adapters.ts` | The two adapter interfaces + the DI `PipelineBackend`. Template-specific knowledge lives on the adapter; effects run against an injected backend. | `templateAdapter`, `TEMPLATE_KEYS`, `FRONT_DOORS`, `TemplateAdapter`, `FrontDoorAdapter`, `PipelineBackend` |
| `review.ts` | The deploy review gate — preview-free, Builder-reviewed go-live, scope envelope, scan-blocks-approval. | `startPreview`, `requestDeploy`, `decideDeploy`, `requestedEnvelope`, `scopeBroadened`, `getReviewCard`, `listReviewCards` |
| `lifecycle.ts` | Archive, lineage-aware delete, Use-as-Data, consume a granted resource (no raw creds). | `archiveApp`, `unarchiveApp`, `deleteApp`, `dependentsOf`, `useAsData`, `consumeResource` |
| `server.ts` | The live/offline-mock dual + the single convergent commit + the four front-door authors. | `pickBackend`, `forgejoReachable`, `commitToApp`, `authorThroughFrontDoor`, `snapshotFiles`/`getSnapshot` |
| `platform-mcp.ts` | Front door #2 — full UI parity, delegated identity, never a back door. | `callPlatformMcp`, `PLATFORM_MCP_TOOLS`, `platformMcpToolNames`, `mcpGetApp` |

The home-of-record `App` (`lib/apps.ts`) carries the fields this module reads and
writes: `status`, `deploy` (`{ state, previewUrl, approved, reviewCardId }`),
`manifest`, `consumes`, `usedAsData`, `mcpProfileCompiled`, the 4th template
`dashboard`, and the internal accessors the governed modules orchestrate through
(`getAppByIdInternal`, `persistApp`, `listAllAppsInternal`, `removeAppInternal`,
`templateFiles`, `newId`). These accessors carry **no** visibility filter — the
caller (this module) is the security boundary and enforces role/owner/lineage
gates before touching them.

## The two adapter interfaces (`adapters.ts`)

Both interfaces exist to *guarantee convergence*: no matter the template/runtime
or the front door, everything lands on the same Forgejo / Harbor / Argo CD /
Secrets / LiteLLM+OPA / Langfuse plumbing.

**(a) `TemplateAdapter`** — per-template / per-runtime, over `web` · `service` ·
`script` · `dashboard`. Exposes the 7 capabilities
`scaffold · commit · preview · ciScan · deploy · autoMcp · capabilityToOpa`. Pure
steps (`scaffold`, `ciScan`, `autoMcp`) carry template knowledge (seed files,
tools, `ResourceFootprint`); effectful steps (`commit`, `preview`, `deploy`) run
against an injected `PipelineBackend`, so the *same* adapter runs live or
offline-mock. `templateAdapter(key)` builds one; `TEMPLATE_KEYS` lists all four.

**(b) `FrontDoorAdapter`** — per-front-door, over `chat · platform-mcp ·
git-push · git-import`. Each authors content its own way (a chat turn, an MCP
commit, a pushed tree, a repo URL) and returns a uniform `AuthorResult`
(`files` + `manifest` + `message` + `missing`). Git is the bridge: git-push and
git-import both arrive as a file tree.

**The single convergent pipeline.** Every front door's `AuthorResult` flows into
`commitToApp` (`server.ts`), which writes the files (live or mock), then runs the
commit hook: re-parse the metadata convention (`parseAppManifest`) and, when an
OpenAPI spec is present, recompile the auto-MCP into OPA (`generateAndCompile`).
"Whatever is committed is seen in the app."

## The deploy review gate (`review.ts`)

The platform's top deploy control. The flow over `DeployState`
(`building → preview → review → live`):

- **Preview is free.** `startPreview` runs a private sandbox the creator drives
  themselves — no review. Any owner (or a Builder in the domain) may preview.
- **Go-live is Builder-reviewed.** `requestDeploy` assembles a **review card**:
  the security `scan` + the **requested** `DeployEnvelope` (write tools +
  connection/data/knowledge grants) + the `ResourceFootprint` (rough $/mo) + the
  change `diff`. The card is held in-process and also enqueued into the
  Governance approval inbox.
- **A non-Builder cannot approve.** `decideDeploy` gates on
  Builder/Admin-in-domain → otherwise **403** (a creator cannot self-approve).
- **Routine in-envelope updates auto-deploy.** `scopeBroadened` returns `false`
  when the requested envelope is a subset of the approved one *and* the footprint
  did not rise; a live app then redeploys without re-review.
- **Scope-broadening or a failing scan re-reviews.** Adding any write tool,
  connection, data or knowledge grant, or raising the footprint, opens a fresh
  card. A scan finding forces a card even on an otherwise-routine update.
- **Secret blocks go-live.** Approval additionally *requires* `scan.passed`; a
  leaked secret (or high/critical finding) blocks the approval with **409**, even
  for a Builder. On approval the app goes `live` and the approved envelope is
  recorded for later routine auto-deploys.

This holds regardless of which front door requested the deploy — they all
converge here.

## Auto-MCP → OPA (`auto-mcp.ts`)

The key automation: an app's OpenAPI spec is the source of truth.

1. `toolsFromOpenApi` — derive tools from paths × methods. `GET`/`HEAD`/`OPTIONS`
   are **read** tools; every side-effecting verb is a **write** tool.
2. **reads-on / writes-off preset** (`applyReadsOnWritesOff`) — every read tool is
   enabled `Read`; every write tool is held `Write-approval` (never auto-on). The
   Builder review curates which writes graduate to write-bounded later.
3. `compileToOpa` / `generateAndCompile` — register the per-tool capability
   profile into the **same** Connection capability gate via
   `registerConnectionProfile` (`lib/agent-governed.ts`). After this,
   `authorizeConnectionCall(principal, tool)` governs the app MCP exactly like any
   other connection: reads `allow`, writes `requires_approval`, anything not in
   the profile `deny`.

## Metadata convention (`metadata.ts`)

Every app repo carries `app.yaml` (name · owner · description · declared
connections/data/knowledge), `/.app/` docs, and an OpenAPI spec. `parseAppManifest`
runs on **every** commit so the app page, catalog and auto-MCP stay in sync. It is
the universal backstop: a raw `git push` or an imported/legacy repo still flows
through it — it derives what it can (e.g. a description from README) and lists
anything it cannot in `missing`, so the app page / build chat prompts for the
rest instead of failing. Pure (no server imports), so it runs both in the commit
hook and in-process.

## Lifecycle (`lifecycle.ts`)

- **Archive** (`archiveApp`) disables the app + drops its MCP grant and OPA
  profile, but **retains** the data artifact (restorable via `unarchiveApp`).
- **Delete** (`deleteApp`) is **lineage-aware**: `dependentsOf` scans every app's
  `consumes` for a reference to this app's MCP / connection / data product; a
  delete that would orphan a dependency in use is **blocked (409)**.
- **Use as Data** (`useAsData`) marks the explicit Bronze snapshot of the app's
  operational data into the Data golden path.
- **Consume** (`consumeResource`) records a granted Connection / Data / Knowledge
  / other-app MCP as a **reference, never a raw credential** (an inline secret is
  rejected 400). Recording a consumed connection broadens the declared scope, so
  the next domain deploy re-opens the review gate.

## Platform MCP — the governance invariant (`platform-mcp.ts`)

Front door #2 gives **full capability parity with the UI**, governed
**identically**, under **delegated identity** — a **front door, never a back
door**. The invariant holds *by construction*: every tool in `callPlatformMcp`
delegates to the exact same governed library function the UI route calls, passing
the caller's `CurrentUser` (never a service identity). There is no privileged
path, so:

- a Creator calling `promote` gets the same 403 as in the UI;
- `request_deploy` opens the same Builder review card — the MCP cannot
  self-approve; only `decide_deploy` (role-gated to a Builder) can;
- a consumed resource is a reference, never a raw credential;
- every call is Langfuse-traced with the caller's identity.

`platformMcpToolNames` exposes the surface so a test can diff it against the UI
and assert no hidden escalation tool exists.

## Testing

The governed modules import the `@/` path alias and `import 'server-only'`, which
plain `node --test` cannot resolve. An **additive** test resolver fixes both:

- `scripts/test-alias-hook.mjs` maps the `@/` tsconfig alias to files and
  short-circuits `server-only`/`client-only` to an empty stub. Non-`@/`
  specifiers pass straight through, so existing relative-import tests are
  unaffected.
- `scripts/test-setup.mjs` registers that hook.
- `npm test` = `node --import ./scripts/test-setup.mjs --test 'lib/**/*.test.ts'`.

The seven test files prove the gate evidence directly:

| Test | Asserts |
|---|---|
| `scan.test.ts` | clean repo passes; a committed secret / `eval()` / known-bad dep blocks; a hardcoded URL is low (non-blocking). |
| `auto-mcp.test.ts` | GET=read / POST=write; writes never auto-enable; compiled profile governs the principal (read `allow`, write `requires_approval`, undeclared `deny`). |
| `metadata.test.ts` | `app.yaml` parses into declared resources; an imported repo with no `app.yaml` derives what it can + flags `missing`. |
| `adapters.test.ts` | all 4 template adapters expose the 7 capabilities + a footprint and seed the convention; the offline-mock backend reports `mode`; all 4 front doors author + converge. |
| `review.test.ts` | preview is free; first deploy opens a card; non-Builder can't approve, domain Builder can; routine auto-deploys, scope-broadening re-reviews; a committed secret blocks approval. |
| `platform-mcp.test.ts` | MCP has UI parity; it is a front door not a back door (no privileged path); the surface is exactly the governed ops. |
| `lifecycle.test.ts` | archive disables MCP but retains data; consume rejects raw creds; delete is lineage-aware; Use-as-Data marks the snapshot. |

## Route map

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/apps` | List the caller's apps / create a new app (`createApp`). |
| `GET` / `PATCH` | `/api/apps/[id]` | Read one app / update captured docs. |
| `POST` | `/api/apps/[id]/promote` | Promote one tier (Personal→Shared→Marketplace; role-gated). |
| `POST` | `/api/apps/[id]/chat` | Persist the build-chat conversation. |
| `POST` | `/api/apps/[id]/tool` | Invoke an app MCP tool through the governed gate. |
| `POST` | `/api/apps/[id]/deploy` | `?action=preview` → free preview; default → `requestDeploy` (review or auto-deploy). |
| `POST` | `/api/apps/[id]/lifecycle` | `archive` / `unarchive` / `delete` / `use-as-data` / `consume`. |
| `POST` | `/api/apps/import` | Front door #4 — git import; wrap an external repo as a governed app. |
| `GET` | `/api/software` | The Software-tab summary (Forgejo repos + CI). |
| `POST` | `/api/software` | (tab actions) |
| `GET` / `PUT` | `/api/software/[id]/files` | Monaco code editor — list/read repo files / save = commit (Builder/Admin-gated). |
| `GET` | `/api/software/reviews` | The Builder deploy-review inbox (pending cards for the caller's domains). |
| `GET` / `POST` | `/api/software/reviews/[cardId]` | One card's full detail / decide it (`decideDeploy`, role-gated). |
| `GET` / `POST` | `/api/software/platform-mcp` | List the MCP tool surface / `callPlatformMcp` under the caller's identity. |
