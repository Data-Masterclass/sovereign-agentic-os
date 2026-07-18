<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Changelog

All notable changes to **Sovereign Agentic OS** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is **pre-beta** software: APIs, values, and surfaces may change between
`alpha`/`beta` pre-releases without notice.

## [Unreleased]

_Nothing yet._

## [os-ui 0.5.39] — 2026-07-18

### Added
- **OpenMetadata ingestion is live.** The native `metadata ingest` CronJob now crawls the bundled
  Trino/Iceberg lakehouse hourly and populates the Catalog (verified: 14 tables + 2 schemas ingested,
  zero auth errors). Fixed the job's securityContext (the `openmetadata/ingestion` image runs as the
  non-numeric `airflow` user, so a numeric `runAsUser: 50000` is required or the pod fails
  `CreateContainerConfigError`). The buggy query-lineage sub-pass is disabled by default (OM 1.13.0
  `DatabaseServiceQueryLineagePipeline` is missing `includeTags`/`overrideMetadata`).
- **Science tab — source dataset is now a file explorer.** Picking the source data product for a model
  is a `FolderTree` browser over all DLS-scoped datasets (reuses the shared primitive), with a manual
  FQN override kept as a fallback — instead of typing the FQN by hand.
- **#146 analytics-as-code monorepo (Phase 1+2, default-off).** Chart seeds an `analytics` Forgejo repo
  (dbt + Cube + Dagster + validate-only CI), and os-ui dual-writes generated Cube/exposure YAML to it
  fire-and-forget (byte-identical to what the Cube sidecar consumes; nothing reads the repo yet — zero
  behavior change).

### Changed
- **#174 connector hardening.** `testConnection` refactored into a `CONNECTION_HEALTH` registry (mirrors
  the executor registry — new connectors append one line instead of editing a 200-line if-chain), plus a
  per-call egress re-check in `runAllow`. Notion gained a real health probe, in-module secret handling,
  bounded cursor pagination, and 429 backoff. A shared `retry.ts` (capped exponential backoff + jitter,
  honoring `Retry-After`) + bounded cursor-follow pagination applied across Supabase, Atlassian, Gmail,
  Google Calendar, Outlook, and Teams.

## [os-ui 0.5.38] — 2026-07-18

### Added
- **Domain-namespaced Cube identity (back-compatible, zero migration).** Two domains can now each
  name a dataset "Sales" without their Cube models, views, or access policies colliding. A new
  opt-in per-dataset marker (`cubeNamespaced`) selects the identity scheme: **new** datasets get a
  domain-prefixed identity (`<domain>__<slug>` cube name, `<domain>__<View>` view, matching model
  file), while **existing** datasets (no marker) keep their legacy bare-slug identity **byte-for-byte**.
  All identity flows through one central place (`lib/data/metrics.ts`), the access-policy compiler key
  is derived the same way (so a cube never ships without its policy), and legacy resolvers keep any
  stored/hand-written reference working. Cross-domain same-name is now allowed; within-domain
  same-name is still rejected. Verified live against the deployed Cube — the existing Northpeak model
  is untouched.

### Removed
- **Dead component pruned: `admin-console`.** It was chart-only, default-off, already absent from the
  Components registry (superseded by the native Components tab that reads the live Kubernetes API), and
  nothing depended on it. Its Helm template and `values` blocks are gone. A normal apply prunes nothing
  new (it never rendered). Audited alongside it and **kept** (all verified live/used): the STACKIT
  external-secret, Argo CD (software deploy stage), Harbor (image pipeline), and Haystack (RAG
  retrieval) — the registry is now fully honest.

## [os-ui 0.5.37] — 2026-07-17

### Fixed
- **Embedded dashboard charts now render real data.** A chart's dataset was built against Trino's
  iceberg catalog with a `cube` schema, but the Cube semantic views live behind the **Cube SQL API**
  and require a **domain-scoped `bi_<domain>` principal**. Dashboard imports now point the Superset
  dataset at the Cube SQL API as that principal (same one Power BI uses), so an embedded chart
  returns real rows — verified end-to-end against live Cube/Trino. Per-viewer RLS in the guest token
  still applies on top. (Requires the `CUBE_SQL_PASSWORD` env, now wired from the existing
  `cube-sql-secrets` Secret.)
- **OpenMetadata native ingestion is now available (off by default).** A CronJob runs OpenMetadata's
  own `metadata ingest` over the Trino `iceberg` catalog (schemas/tables/columns) plus optional dbt
  models + lineage, so the catalog stops being hollow. Enable via `openmetadata.ingestion.enabled`
  after minting a fresh ingestion-bot token (see `docs/components/openmetadata.md`).

## [os-ui 0.5.36] — 2026-07-17

### Fixed
- **Software apps now have a visible Archive button.** The archive/restore/delete control was
  rendered with `surface="tile"` (which shows nothing) on the cards and was otherwise buried inside
  the detail "Manage" accordion — so there was no discoverable archive button. Archive (or Restore +
  Delete when archived) now sits in the app detail **header**, matching the other tabs; owner or
  domain-admin+ (server-enforced).

## [os-ui 0.5.35] — 2026-07-17

### Fixed
- **Creating a dashboard no longer fails with "only the owner … can edit this dashboard."** New
  dashboards took their id from the name slug, so two dashboards sharing a name (across users)
  collided on one id — "creating" the second was treated as editing the first's (often another
  owner's) record, tripping the fail-closed edit-scope check even for an admin. Each new dashboard
  now gets a unique id.

## [os-ui 0.5.34] — 2026-07-17

### Changed
- **MCP surface + in-product guides brought fully up to date.** The MCP server instructions, tool
  descriptions, and every in-product guide now reflect the current model: **"My" artifacts are yours
  — full rights, no approval** (for builders and their agents); Domain needs domain-admin approval,
  Company needs tenant-admin; the agent write-gate is scope-aware; agents inherit the full Define
  grant set by default; dashboards embed live; `create_software` takes a `surface` (ui/api/both);
  Console + Admin are builder-visible. Corrected the `create_dashboard` schema and role/approver
  wording throughout.
- **Official end-user guide refreshed + PDF regenerated** to match — governance model, agents
  capability model, live dashboards, Console/Admin, software surface + archive.

## [os-ui 0.5.33] — 2026-07-17

### Added
- **Software apps get a "Show archived" toggle** and full archive → restore/delete lifecycle on the
  list, matching every other tab (the backend was already there; the list affordance was missing).
- **Apps can declare their surface.** An app can set `surface: ui | api | both` in `app.yaml` (or via
  `create_software`), and that declaration wins over auto-detection.

### Changed
- **A UI app is no longer mislabelled "API."** Surface auto-detection now recognizes many more UI
  shapes — Streamlit/Gradio/Dash/Flask+templates/FastAPI static mounts, `templates/`/`static/` dirs,
  a top-level `index.html`, and Dockerfiles that expose a web port and run a serve command.
- **Lower LLM cost on the "Talk to…" copilots.** They now run on the standard model first and only
  escalate to the reasoning model when an answer looks weak — cutting the reasoning tier's share of
  token spend substantially while keeping answer quality. Admin-configurable (`TALK_COPILOT_TIER`,
  `TALK_ESCALATE_TO_REASONING`, `TALK_KNOWLEDGE_TOPK`).

## [os-ui 0.5.32] — 2026-07-17

### Fixed
- **Agents (and builders) have full rights over their own "My" artifacts — no admin approval.** The
  agent write-gate held EVERY write for review at the common `read-propose` preset, ignoring scope,
  so an agent creating a personal dataset/file/knowledge/metric/connection was wrongly queued. The
  hold is now scope-aware: **My → direct** (run as the builder, whose rights + ownership are the
  authority), **Domain → domain-admin approval**, **Company → tenant-admin approval**. Human create
  paths across all nine types were verified already ungated for builders.
- **Software apps no longer get stuck on "Awaiting review" after approval.** Apps approved before the
  0.5.30 write-back were orphaned (approval decided, app never transitioned). They now self-heal on
  load — an app in review whose approval is already decided flips to live (or preview if rejected),
  durably — which also prevents any future orphan.

### Deploy
- Live Superset now runs with `ENABLE_PROXY_FIX` so embedded dashboards render inside the OS
  same-origin proxy instead of a blank frame (applied to the running cluster).

## [os-ui 0.5.31] — 2026-07-17

### Added
- **A consistent "needs approval" experience across the whole OS.** Whenever an action files an
  approval request (promote/certify Files, Data, Knowledge, Metrics, Dashboards, Science; software
  deploy), you get one calm confirmation — "Request filed — awaiting approval to Domain/Company" —
  with a **Go to Policies & Approvals →** button that deep-links to and highlights the exact request.
  If you're an admin who can approve it, an **Approve now** button approves it inline (fail-closed:
  non-approvers never see it; the server re-checks).

### Changed
- **The Agent-tab PDF reports are now on-brand.** The Run "Results Report" and Evaluate "Evaluation
  Report" are fully redesigned to the datamasterclass style — embedded Marcellus/Rubik/Oswald/Fraunces
  fonts, a gold-lotus cover, gold section rules, styled tables, and a running footer. Same content,
  far better looking.

## [os-ui 0.5.30] — 2026-07-17

### Fixed
- **Agents added from a template now inherit datasets granted afterwards.** Root cause of "granted
  in Define but the agent still gets denied `query_data`/`get_dataset`": adding a template agent
  froze its tool set to a snapshot of the grants at that moment, so any dataset granted *later* in
  Define never reached it. Template agents now inherit the growing grant pool like blank agents do —
  every agent defaults to the full set of the system's Define grants, with per-agent narrowing still
  available. (The data-authorization layer itself was verified healthy end-to-end.)
- **Approving a software release in Policies & Approvals now clears "awaiting review."** The
  governance effect had no handler for software deploys, so an approval updated the queue but never
  the release. Approve now takes the release live; reject returns it to preview — durably, from
  either entry point.

### Changed
- **The Software builder uses the shared progress stepper** (same as Agents Build/Run): the real
  pipeline stages — Scaffold → Build image → Publish → Deploy → Live — light up in turn.

## [os-ui 0.5.29] — 2026-07-17

### Fixed
- **Dashboards now embed live instead of falling back to the offline mock.** Creating/opening a
  dashboard imported it into Superset via a bundle whose `extra` and chart `params` were emitted as
  JSON strings; the deployed Superset version needs those as objects, so every import 500'd and the
  dashboard was never created ("… not found in Superset"). Both are now emitted as YAML mappings —
  verified end-to-end against live Superset (import → embedded UUID → guest token). Existing
  dashboards self-heal on next open (the build-on-open now succeeds). Also made the offline-mock
  hint honest (it no longer always claims Superset is unreachable).

## [os-ui 0.5.28] — 2026-07-16

### Fixed
- **Write access granted in Define now actually reaches the agents (and Files can be granted write).**
  Previously, setting a capability to read+write in Define — even system-wide — still left every
  agent read-only in Design, so writes like uploading a file or creating a dataset were denied at
  run time. Now each agent **inherits exactly the rights the team was granted** (read+write as
  granted) by default, and a per-agent capability carries its write tools; narrowing per agent is
  still possible. **Files** also gained the Read / Read+propose / Read+write selector in Define, so
  file-writing agents (e.g. `upload_file`) work. A hard invariant guarantees an agent can never
  exceed the team's grants.

## [os-ui 0.5.27] — 2026-07-16

### Added
- **A shared, elegant progress indicator across the OS.** The polished progress stepper from the
  Agents Build phase (a determinate bar with each step lighting up — gold while active, teal when
  done, red on failure, with live commentary) is now a reusable primitive, and the **Run** phase
  uses it: a team run shows each agent progressing in turn instead of a bare spinner. This is the
  new house style for long-running operations; other slow surfaces will adopt it next.

## [os-ui 0.5.26] — 2026-07-16

### Changed
- **Simplified the Agents Design stage:** removed the separate "Short name (optional)" field per
  agent. An agent's **Name / Role** is now its label everywhere — the Run and Evaluate node cards,
  the multi-agent graph, and both PDF reports. One name, no duplication.

## [os-ui 0.5.25] — 2026-07-16

### Changed
- **Console is now available to builders** — they get the governed Query surface (Lakehouse SQL
  runs through Trino with the caller's OPA row/document-level security). The raw Shell and the
  unscoped Cube query mode remain admin-only, in both the UI and the API.
- **The Admin tab is now visible to builders, filtered to what they can actually use.** Every
  tenant-admin tile (Users, Security, Models, Backups, Cost, tenant Settings, …) stays admin-only
  and hidden; a builder sees a single tidy "My Settings" self-service tile. Deeper Admin sub-pages
  redirect non-admins back to the overview. Tile visibility is fail-closed (default-deny).

### Security
- **The raw terminal shell is admin-only by default** (`terminal.allowedRoles: ["admin"]`, env
  `TERMINAL_ALLOWED_ROLES`). Previously the token endpoint accepted builders; now that Console is
  builder-visible, the operator shell is locked to admins by default and remains admin-configurable.

## [os-ui 0.5.24] — 2026-07-16

### Added
- **Optional short name per agent.** In Design you can give any agent a friendly short name; it
  carries through the Run and Evaluate node cards, the multi-agent graph, and both PDF reports.
  The agent's identity/id is untouched and `system.yaml` stays byte-for-byte identical when no
  short name is set.
- **Build-phase progress indicator.** Building a team now shows a determinate progress bar that
  walks the real provisioning phases (scaffold → tools & grants → wire graph → traces → commit)
  with live commentary, then settles on the actual outcome — every stage ticked on success, or the
  failing step marked, straight from the build report.
- **Run — "Download PDF Results Report":** exactly what's on the Run screen (summary, final output
  with real tables, per-agent results), nothing else.
- **Evaluate — "Download PDF Evaluation Report":** opens with the multi-agent graph, then the
  on-screen evaluation content, then Appendix 1 Results, Appendix 2 Define-stage settings, and
  Appendix 3 each agent's description. Both reports reuse the Workflow-export PDF engine.

## [os-ui 0.5.23] — 2026-07-16

### Fixed
- **A Define grant is now automatically a usable capability, for every type.** Granting a resource in
  "What your team can use" surfaces its capability chip on the agent card by default and provisions
  the matching tools — this fixes Files and goals (which never surfaced), and a latent Connections
  case (the chip vanished when external connectors were off). Runtime authorization, folder/plan
  grant resolution, and access-level caps were already correct.
- **Files search reliability:** the file embeddings now enforce the index's vector dimension (a
  mis-pointed embeddings model could otherwise make files silently unsearchable) — matching the
  knowledge pipeline. Added end-to-end retrieval + grant-scoping tests for Knowledge and Files, and
  a test that Data surfaces the real table name to agents (no guessed FQNs).

## [os-ui 0.5.22] — 2026-07-16

### Added
- **Every action now visibly confirms itself.** A new OS-wide feedback pattern (a tasteful toast +
  a busy/disabled button state) makes button presses *feel* like they did something: async buttons
  show a spinner and disable while working (no double-submit), then a clear success — or error —
  confirmation. The agent-builder **"Add to my team"** (which stored silently) now confirms and
  takes you to Design; and promote/certify, create-system, approve/reject, save-metric, and
  compile-guardrails all confirm on press.

## [os-ui 0.5.21] — 2026-07-16

### Fixed (governance)
- **A builder can propose promoting an artifact to Domain, and it's reviewed by a domain admin** —
  not by another builder. The Files and Data promote requests were routing approval to the wrong
  role (defaulting to builder), and a personal Knowledge entry could be self-promoted by a builder;
  all now correctly require **domain admin+** approval. The Files action reads "Propose to Domain →"
  with a clear "awaiting a domain admin's approval" pending state. (Owner still proposes their own
  artifact regardless of role; only the approver gate changed.)

## [os-ui 0.5.20] — 2026-07-16

### Changed
- **Tenant admin can manage all Domain and Company artifacts, across every domain** — view, edit,
  archive, restore, delete — via one scope-aware permission rule applied to every tab.

### Fixed (governance / privacy)
- **Personal ("My") artifacts are strictly owner-only.** A platform admin or domain admin can no
  longer view or manage another user's personal datasets, files, dashboards, connections, agent
  systems, knowledge, workflows, science models, pillars, or **personal folders**. (Previously an
  admin could reach some of these.)
- **Creating a Domain folder now requires domain admin (or platform admin).** A builder/creator can
  no longer create domain-scoped folders (server-enforced 403), and the "New folder" affordance for
  the Domain root is hidden from them in Files/Data/Metrics. Personal folders are unchanged.
- Promotion/approval paths are unaffected (a builder still proposes; domain admin+ approves).

## [os-ui 0.5.19] — 2026-07-16

### Changed
- **MCP surface synced to the current product.** Tool descriptions, prompts, instructions, and the
  per-tab briefs now consistently use My/Domain/Company (promote→Domain, certify→Company), name the
  **Operating Model** (7 sections), and teach the agent **grant schema** (`commit_agent_files`:
  Context vs Plan items, per-item access levels, folder grants). Connector templates and
  `create_big_bet`'s required pillar were already correct. No tool identifiers changed.
- **Agent grant-picker Plan Items** now read "Operating Model" (matching the tab rename).

## [os-ui 0.5.18] — 2026-07-16

### Changed
- **Official guide refreshed** (`docs/Sovereign-Agentic-OS-Guide.md` + PDF) to the current product:
  My/Domain/Company vocabulary, the Operating Model, the shared folder UX, the full connector
  catalogue, the interactive agent-grants surface, per-agent Evaluate context, and Big-Bets-under-a-pillar.

### Internal
- **Refactor (#171 phases C–D, behavior-preserving):** cross-tab imports routed through public tab
  barrels; two barrels widened for genuinely-public server-side symbols. No behavior change; client
  bundles kept free of server-only modules (verified by the production build). tsc + tests + build green.

## [os-ui 0.5.17] — 2026-07-16

### Added
- **Strategy pillars and Big Bets can now be granted to an agent team** as read-only context,
  completing the Plan Items group in "What your team can use" (alongside Workflows and the
  Operating Model). Granting a pillar or bet provisions its governed read tools
  (`get_pillar`/`get_big_bet`), DLS-scoped to what the caller may view — the same governance the
  Strategy and Big Bets tabs use.

## [os-ui 0.5.16] — 2026-07-16

An interactive agent-grants surface, four cloud governance/ML connectors, and an honest
Components registry.

### Added
- **"What your team can use" is now interactive.** Per item, choose **read-only ·
  read + propose · read + write** (a clear labelled selector — no more ambiguous toggle),
  capped by the agent system's overall access setting (locked at read-only or full-in-scope;
  otherwise downgrade-only, explained inline). Grants are grouped into **Plan Items** (Strategy ·
  Big Bets · Operating Model · Workflows) and **Context** (Knowledge · Files · Data · Connections ·
  Metrics), with prominent category headings. **Workflows and the Operating Model are now genuinely
  grantable** to a team (Strategy and Big Bets remain labelled for a later pass).
- **Cloud governance / ML connectors — Microsoft Entra · Purview · Azure AI Foundry · AWS
  SageMaker.** Read-only, governed (identity, catalog/lineage, model deployments, ML endpoints/jobs).
  SageMaker uses a dependency-free, test-verified AWS SigV4 signer; secrets are write-only. Setup
  (Azure app registration / read-only AWS IAM keys) is documented as the operator's step.

### Fixed
- **Files folders now appear in the agent grant picker** (the Files feed returns its scoped folders).
- **Components tab tells the truth.** Trino (not DuckDB) as the query engine, the real runtimes
  (agent-runtime, data-runner) added from what the chart actually deploys, mock-model marked
  local-dev-only, and versions corrected.

## [os-ui 0.5.15] — 2026-07-16

Consistent folder UX across every context tab, deep links that open the actual item, five
messaging/calendar connectors, and Big Bets that always sit under a pillar.

### Added
- **Messaging & calendar connectors — Slack · Gmail · Google Calendar · Outlook · Teams.** Real,
  governed, hand-built (reads auto; sending a message/email is approval-gated and never automatic;
  deletes blocked; secrets write-only). Each ships an install guide; creating the Slack app /
  Google OAuth client / Azure app registration is the operator's step, and OAuth token-refresh is
  a documented follow-up.
- **Evaluate deep links open the real item.** The per-agent "context used" links now open the
  actual dataset / doc / file / metric / connection (via `?focus`), switching scope so it's visible.

### Changed
- **One folder UX on every context tab.** Data, Metrics and Knowledge now use the same shared
  layout as Files (a factored `FolderLayout`): a scope segment + one active-scope folder rail +
  the grid. Knowledge's redundant three-lane view is gone — the scope tabs alone drive it.

### Fixed
- **Folder rail no longer overlaps the tiles** on Data and Metrics (a min-width overflow in the
  grid layout).
- **A Big Bet must sit under a Strategic Pillar.** Creation now requires a pillar from both entry
  points (the Big Bets "New" panel and "New bet under this pillar" from Strategy) and via MCP;
  existing unlinked bets are grandfathered.

## [os-ui 0.5.14] — 2026-07-16

One consistent scope vocabulary, a clearer Operating Model, sharper folder handling, and a
per-agent view of the context each agent actually used.

### Added
- **One scope vocabulary across the whole OS: My · Domain · Company.** "Shared" → **Domain**,
  "Marketplace" → **Company**, everywhere, driven from one place in core (`lib/core/scopes.ts`).
  Promote reads "Promote to Domain"; certify "…to Company". Display + verbs only — no stored
  value, policy key, or route changed. (The Marketplace *storefront* keeps its name.)
- **Operating Manual → Operating Model.** The tab and its three scopes are now "My / Domain /
  Company Operating Model", and each holds a fixed set of sections: **General · Strategy ·
  Business · Organization · Architecture · Data · Glossary** (existing content migrated into the
  closest new section; nothing lost).
- **Evaluate shows what each agent actually used, per agent.** The "context used" panel now
  attributes artifacts per agent, each a clickable deep link, and shows how it was used
  (tool + read/retrieved/written + a short args hint). Errored/inferred items stay honestly marked.
- **Folder Rename.** A "Rename…" action on the folder ••• menu (in-place leaf rename), across
  Files · Data · Knowledge · Metrics.

### Fixed
- **Folders show only the root that matches the active scope.** No more empty "Shared folders"
  section under My (or vice-versa) — the rail and pickers render just the active-scope root, the
  same way on every tab.
- **Archive is available on every folder you see** — implicit folders (made only by moving items
  in) now materialise a registry row on demand so Archive/Rename/Move always appear.
- **Big Bets: Archive is easy to find** — moved from the bottom of the detail page into the detail
  header, next to Edit (Restore/Delete when archived; owner/admin only).
- **Data explore: the Bronze/Silver/Gold picker is colour-coded per tier** with a clear selected
  state; the highest available layer stays selected by default.

## [os-ui 0.5.13] — 2026-07-16

Folders + lifecycle become one shared core primitive across the context tabs; four real
service connectors; and a batch of Agents-builder and Big Bets fixes.

### Added
- **One shared folder + archive/restore/delete primitive across Files · Data · Knowledge ·
  Metrics.** A core `ArtifactAdapter` registry + a single folder-lifecycle orchestrator (mirrors
  the warehouse-provider registry): folder logic and the archive→delete/restore lifecycle are
  written once in core and each tab registers a thin adapter — no per-tab divergence. Metrics gain
  folders too. Moving a folder now carries its contents; archiving a folder cascades to the items
  inside (with a clear warning; move items out first to keep them active); physical delete is
  archived-only, per-item permission-checked.
- **Four real, governed service connectors — GitHub · Supabase · Notion · Atlassian.** Hand-built
  typed API clients on the Airflow reference pattern (reads auto; writes approval-gated;
  destructive ops blocked; secrets write-only). Notion's tool execution is now real (was a mock).
  `runAllow` moves from an Airflow-only branch to an executor registry.

### Fixed
- **Moving a file now lands it in the destination folder.** The folder rail + move picker are tied
  to the active My/Domain scope, so a move can only target a valid (tier-bound) root — the moved
  file no longer vanishes. The folder "Move" action is a tree picker, not a text field.
- **Big Bets: "Show archived" toggle** — archived bets were unreachable; they now appear (dimmed)
  with Restore + Delete via the shared lifecycle controls.
- **Agents Simple builder:** always opens on Define with no pre-set phase checkmarks; "What your
  team can use" lists each item once (no My/Shared duplication); an agent's editable role is its
  name and templates prefill it; Simple mode auto-connects agents linearly (Developer rewiring
  still wins); rebuilt capability picker — recommended capabilities prefilled, a described
  per-domain picker, selected chips shown in a box (click to explain, ✕ to remove).

## [os-ui 0.5.12] — 2026-07-16

Connector wave (batch 1): operational databases, a grouped/searchable Connections tab, and a
proper folder picker.

### Added
- **Operational-database connectors via Trino — PostgreSQL · MySQL · SQL Server · MongoDB.**
  Real, governed, federated (reuse the warehouse framework). Deep-researched per engine (Trino
  476 catalog config, identifier rules, discovery, type mapping, pushdown notes); credentials
  vaulted via `${ENV:}` (Mongo's whole connection URL is the secret — nothing inlined); one
  Installation Guide each. Meets the CONNECTOR-STANDARD Definition of Done.
- **Connections tab: grouped by type + search.** Supported Connectors now group into 11
  categories (Messaging · Calendar · Code & DevOps · Docs & Knowledge · Operational databases ·
  Data warehouses · Data ingest · Enterprise apps · Orchestration · Catalog · LLM providers)
  with a live search bar; the 4-section IA intact.

### Fixed
- **"Move to folder…" is now a folder-tree picker, not a text field** (Data · Knowledge ·
  Files) — browse and click the destination folder, with inline New-folder, like a file explorer.

## [os-ui 0.5.11] — 2026-07-16

Folders, end to end — the agent-builder folder-grant browse-tree (completes #175).

### Added
- **Agent builder: grant folders or items via a browse-tree.** In "What your team can use",
  Data · Knowledge · Files now render a `FolderTree` with tri-state checkboxes — tick a
  **folder** to grant everything in it (and future contents), or tick individual **items**.
  A folder grant (`ArtifactGrant.folder`) resolves to the folder's contents at run time
  (late-binding — add an item later and the team gets it next run), capped by a budget, and
  **every resolved item is still per-item DLS/OPA-checked** — so a folder grant is provably a
  *subset* of what the owner could grant, never a widening. `system.yaml` stays byte-stable
  when no folder grant is present.

This closes the full folder feature: create folders on Data/Knowledge/Files → file items into
them → grant folders or items to agents by checkbox.

## [os-ui 0.5.10] — 2026-07-16

Folder management for Data/Knowledge/Files + "context actually used" in Evaluate.

### Added
- **Folders on Data · Knowledge · Files.** Create folders, move items into them (single +
  multi-select), and navigate a folder tree per tab. Governed (`canManageArtifact`), folders
  persist even when empty, and Files' old implicit rail is reconciled to explicit folders with
  zero migration. Built on a shared primitive (`lib/core/folders.ts` pure algebra +
  `lib/folders/` governed store + `components/core/FolderTree.tsx`). *(The agent-builder
  folder-grant browse-tree — checkbox folders or items — is the next wave.)*
- **Evaluate: "Context actually used" per run.** Each agent's Evaluate/Run view now shows the
  real artifacts it consumed — data · files · knowledge · metrics · connections — with
  read/retrieved/written, per-agent and a run-level roll-up, each chip deep-linked to its tab.
  Plus a **granted-vs-used** strip flagging "dead grants" (granted but never used). Derived
  from the already-persisted tool-call trace; honest about inferred (`query_data`) vs captured.

## [os-ui 0.5.9] — 2026-07-16

Internal refactor — **no user-facing change** (behavior-preserving; 2417 tests green).

### Changed (structure/docs/heal)
- **Documented** 13 previously-undocumented `lib/` modules (READMEs) + refreshed
  `ARCHITECTURE.md` to the actual state.
- **Contract barrels** — added `index.ts`/`schema.ts` to the 13 tab modules that lacked
  them (off the `connections` reference template), so every module exposes a clean public
  API (additive; no importers changed yet).
- **Layering fix** — moved the Forgejo client type to `lib/infra`, removing the one
  `core → tab` upward-import violation.
- Removed the orphaned `ContextPanel.tsx` (dead after the workflow Context sub-tab removal).

_(The deeper structural moves — routing cross-tab imports onto the barrels, extracting
shared code to core, relocating external clients into `lib/infra`, and the components
folder reorg — continue incrementally under #171, gated by the test suite + `next build`.)_

## [os-ui 0.5.8] — 2026-07-16

Big Bet solution wizard, self-service model providers, simpler agent tooling, and a real
Superset embed fix.

### Added
- **Big Bet solution wizard (Phase 3).** A 3-step wizard (Anchor workflow · Components ·
  Context) with attach-existing / create-new deep-links, plus **connect-mode** on the
  interplay canvas (click source → target → relation). New governed write API + MCP tools
  (`set_bet_workflow`, `attach_bet_component`, `wire/unwire_bet_components`,
  `get_bet_solution`). (software/connection are attachable by id today; the browsable
  picker for those two is a follow-up.)
- **Models & Providers — self-service (MVP).** Durable model persistence
  (`store_model_in_db`), a provider-grouped catalog, and an "Add provider" wizard
  (OpenAI-compatible + STACKIT live; Azure/Bedrock scaffolded). Credentials are write-only
  secrets. Model list pruned to the STACKIT set.
- **Connector Design Standard** — `docs/CONNECTOR-STANDARD.md`, the high quality-bar every
  new connector must meet (governance, write-only secrets, federate-first-party-MCP rule,
  lifecycle, tests, DoD checklist).

### Changed
- **Agent builder: per-agent tooling simplified.** Each agent defaults to **Auto** (the OS
  picks tools from its job + the team's resources); optional plain **capability chips**
  (Read data · Search knowledge · Use a connection · …) that only appear for what the team
  was granted; Developer view keeps the raw tool list.

### Fixed
- **Superset dashboards now embed same-origin.** They failed because Superset sends
  `X-Frame-Options: SAMEORIGIN` (cross-origin iframe blocked) and the dashboard was looked
  up by title. The embed now routes through the OS's same-origin `/tools/superset` proxy
  (no CSP/CORS/cookie issues), matches the exact title only (no wrong-dashboard fallback),
  and enables Superset ProxyFix so prefixed URLs resolve. (Needs a published dashboard in
  Superset + a browser check to confirm the render.)

## [os-ui 0.5.7] — 2026-07-16

Big Bet solution canvas, a real "members-only" fix, and Governance consolidation.

### Added
- **Big Bet solution-design canvas (Phase 2).** The bet detail now opens on a **Design**
  view: a banded **interplay canvas** (Anchor workflow ▸ Components ▸ Context) with typed,
  labeled edges (dashed for `triggers`/`monitors`), click-through to each artifact's tab,
  and a read-only anchor-workflow swimlane. Value tracking moves under a **Value** tab,
  untouched. (Wizard + write path come in Phase 3.)

### Fixed
- **Big Bet components no longer show "🔒 members only" for everyone.** They were resolved
  through an in-memory registry that resets on every pod restart; after any redeploy all
  components (even for an admin) fell back to "members only". They now resolve from the
  **durable per-tab stores** with the real viewer gate — real titles across restarts, admin
  sees all, genuine cross-domain restrictions preserved — plus an honest **"unavailable"**
  state for a truly-missing artifact.

### Changed (Governance → Policies & Approvals consolidation)
- Deleted the orphaned duplicate **Users** panel (Admin owns user administration).
- **Audit** now writes through to the persistent `os-audit` store (one durable trail that
  survives restart), keeping the hash-chain integrity check.
- **Egress** allowlist consolidated onto Admin → Security's real store.
- **Cost caps now actually enforce** — checked at the assistant-completion chokepoint
  (over-cap → 402, model never runs); honest caveat that self-hosted spend reconciles via
  live LiteLLM accounting.

## [os-ui 0.5.6] — 2026-07-16

MCP surface brought up to date with this session's capabilities; workflow-detail tidy.

### Added
- **MCP: Operating Manual tools** — read/update/list-versions/restore the My · Domain ·
  Company operating manual, governed per scope.
- **MCP: pillar `personal` (My) scope + full pillar lifecycle** — `create_pillar` accepts
  the personal scope (creator-floored; per-scope create rights enforced in-lib); new
  `archive_pillar`/`unarchive_pillar`/`delete_pillar`/`promote_pillar`/`restore_pillar_version`.
- **MCP: Big Bet lifecycle** — `archive_big_bet`/`unarchive_big_bet`/`delete_big_bet`/
  `restore_big_bet_version`, plus `create_big_bet` now requires a real, viewable `pillarId`
  (containment; dropped the stub pillar/metric defaults).
- Refreshed the MCP orientation NAV line + strategy/knowledge guides to the current nav
  (Console, Govern, Policies & Approvals, Operating Manual tab, Workflows as its own tab).

### Changed
- **Workflow detail: removed the "Context" sub-tab** (the pinned/retrieved context layer) —
  trimming the detail toward the planned two-view layout.

## [os-ui 0.5.5] — 2026-07-15

Navigation restructure + Big Bet solution-blueprint foundation.

### Changed
- **Navigation is now five tabs per section.** **Console** (Terminal + Query merged into
  one admin page with a Shell | Query switch) joins **Build**; the **Admin group is
  dissolved** — the Admin tab moves into **Govern** (renamed from Monitor), and About /
  Licenses moves into **Entry** (readable by everyone, for transparency). The
  **Governance** tab is renamed **Policies & Approvals** (route unchanged; page content
  unchanged — the consolidation is separate). `/terminal` and `/admin-query` redirect to
  `/console`.
- The Operating Manual's personal scope now reads **"My Operating Manual."**

### Added (foundation, not yet surfaced)
- **Big Bet solution-blueprint model + store** (Phase 1) — typed interplay edges
  (`consumes/produces/triggers/feeds/monitors`, kept separate from build-order
  `dependsOn`), an anchor-workflow role, and governed store setters
  (`setBetWorkflow`/`wireComponents`/`getSolution`/…), versioned through the existing
  mirror. Stored on `blueprint` (the existing free-text `solution` field is untouched).
  The wizard + interplay canvas that use it come in later phases.

## [os-ui 0.5.4] — 2026-07-15

Operating Manual gets its own tab; Strategy/Big-Bet foundations; admin tidy-up.

### Added
- **Operating Manual is its own top-level tab** (Plan group, after Big Bets) with a
  **My · Domain · Company** switcher, governed per scope: My = owner-only; Domain =
  domain-admin+ edit / domain read; Company = admin-only edit / everyone read. Reuses
  the domain-knowledge card + version history for all three. Removed from the Workflows
  tab (Workflows is workflows-only again); Knowledge stays reference-only.
- **My/Domain/Company tiering for Strategic Pillars + Big Bets.** Pillars gain a personal
  **My** tier on top of Domain/Company (`personal|domain|tenant`); bets inherit their
  pillar's tier by containment. Both tabs get a My·Domain·Company segment. Governance:
  My=owner, Domain=Builder+/domain-admin, Company=Admin; promote My→Domain→Company.
- **Full lifecycle for pillars + bets** — archive → restore / physical-delete (confirm
  popups) + version history, via the shared lifecycle components. Deleting a pillar with
  linked bets is blocked (unlink first); bets are never cascaded.

### Fixed / Changed
- Removed the duplicate **Components** quick-link from the Admin overview (it has its own tab).

## [os-ui 0.5.3] — 2026-07-15

Workflows + builder polish (follow-up to 0.5.2).

### Changed
- **Domain Operating Manual moved to the Workflows tab.** The domain operating-manual
  card (overview/glossary/goals/context) now renders at the top of the Workflows tab,
  where it belongs — above the workflow list. The **Knowledge tab is now reference-only**:
  personal/certified markdown entries + Talk-to, for adding additional knowledge as needed.
  Pure relocation — same `/api/knowledge/domain` wiring, schema, and edit gate. (#164 Phase 2, Domain scope.)
- **Agent builder: "What your team can use" moved to the bottom of the Define phase**
  (from the top of Design). Define now reads goal → deliverable → resources, so the team's
  allowed context is the closing step of scoping the job, before you design the team.

## [os-ui 0.5.2] — 2026-07-15

Workflows: richer actors, a standalone tab, PDF export, and an MCP how-to guide.

### Added
- **Actors registry in workflows.** Five actor categories — Human · Software · Agent ·
  **Customer** · **Partner** — each a first-class described entity (name · category ·
  description) defined once in a new **Actors** tab and chosen per step from a dropdown
  (with an inline "＋ New actor"). Customer and Partner are *external* actors, rendered
  as dashed, muted swimlane lanes. Back-compat: existing workflows derive a registry
  from their steps. The `author_knowledge` MCP tool gained the 5 categories + a
  workflow-level `actors[]`.
- **Standalone Workflows tab.** Workflows moved out from under Knowledge into their own
  top-level tab (Plan group, right after Big Bets). Knowledge is now knowledge-only
  (domain manual + personal entries).
- **Workflow PDF export.** An "Export PDF" button (top-right of the workflow detail)
  produces a PDF that leads with the swimlane visual flow on page 1, then the full
  workflow — actors with descriptions, ordered steps (actor, inputs/outputs, rules,
  know-how), and handover/gaps. Reuses the OS's existing jsPDF pipeline.
- **"How to use this MCP" guidance.** `get_guide()` with no argument now returns a
  role-aware orientation (governance model, the three first moves, the pathway list,
  the role summary), also exposed as `sovereign-os://guide/how-to-use`.

## [os-ui 0.5.1] — 2026-07-15

Metrics-tab polish — two surgical fixes, no backend/chart change.

### Fixed
- **Newly-defined metric no longer shows "Cube failed".** During the ~5s window
  after Define, the model-sync sidecar hasn't yet pushed the measure to Cube, so a
  resolve returns "not found for path" — which `buildMetric` already fail-softs to
  `pending: true`. But `BuildRowsView` ignored that flag and rendered a hard
  `✗ Build failed` beneath the "saved, syncing" banner. It now shows `⟳ Build
  syncing` and per-row `⟳ … syncing — resolves shortly` while pending, never a hard
  ✗. The sync path itself was verified healthy end-to-end (sidecar → `.cube.yml` →
  Cube `/meta` → governed `/load` 200); this was purely a mislabel.
- **Metric tile domain chip no longer wraps across several lines.** The source-domain
  chip had no `nowrap`, so a long domain name broke mid-word and cramped the tile.
  It now stays on one line and ellipsizes (full name in the hover title), and tiles
  are slightly wider. CSS-only, so every tab's domain chip benefits.

## [os-ui 0.5.0] — 2026-07-15

Connectors deepened into real per-engine services, a real Science training runtime, and
OpenMetadata write-back. `tsc` clean; **2336 tests pass**. Pieces needing a live source /
cloud creds are labeled honestly, not faked.

### Feature — real per-engine warehouse connectors (not a generic template)
- Each warehouse provider is now genuinely engine-specific: **identifier casing/quoting** (Snowflake upper-folds + quotes; BigQuery/Databricks/Fabric preserve; Glue lower), **native discovery forms** (Snowflake `SHOW TERSE SCHEMAS IN DATABASE`, Fabric honestly *none* → operator-configured OneLake locations), **engine-aware import type-casts** (VARIANT/STRUCT/ARRAY/MAP/GEOGRAPHY → sane Iceberg types via `buildTypedImportCtas`, with lossy-cast warnings), and real **guardrail notes** (BigQuery bytes-scanned billing; Databricks Unity-is-Starburst-only → prefer Thrift/Glue; Glue IRSA/partition-projection; Fabric experimental).
- **Connections UI**: the single "External data warehouse" card is now **five real cards** — Snowflake · BigQuery · Databricks/Delta · AWS Glue/Athena · Microsoft Fabric/OneLake (experimental) — each Connect pre-set to its platform. **Every** connector (warehouses + Drive/OneDrive/Notion/Airflow/OpenMetadata) now has an **Installation Guide** button (prerequisites · steps · what the OS does).

### Feature — Airflow deepened (operate · observe · retrieve)
- From 3 tools to **12**: `list_dag_runs`, `get_task_instances`, `get_task_logs`, `get_xcom`, `list_datasets`/`get_dataset_events` (Read); `pause_dag`/`unpause_dag`/`clear_task` (Write-approval, honoring the DAG allowlist); plus the existing list/trigger/get-run. v2-first with v1 fallback. (Airflow's REST API operates *existing* DAGs — it cannot author DAGs; large outputs land in a warehouse the OS reads via its connectors, not XCom.)

### Feature — Science training runtime (Phase 2/3)
- A real, governed **on-platform training Job** (`images/ml-trainer` + a `batch/v1` Job builder + submit/poll state machine): ＋New model → Define → **▶Train** trains sklearn from a governed **Gold** product (read as a least-privilege Trino principal), MLflow-tracks, uploads a KServe-servable artifact, and a per-model InferenceService serves it. The os-ui RBAC now permits `batch/jobs` (gated on `ml.enabled`). Live train E2E needs a real Gold product + the deployed job (a cluster step); the code + chart are complete and unit-tested.

### Feature — OpenMetadata Phase-2: integrity-safe write-back (flag-gated off)
- Scoped **additive** write of OS-produced assets into a customer's existing OM, with all seven integrity guards enforced in code: namespace isolation (`sovereign_os` service + OS domain), **additive JSON-Patch only** (no `remove` is even representable in the type), `managedBy` markers, idempotency, optimistic-concurrency **yield** on a human edit, **preview-diff before write**, and an OM-side least-privilege writer bot. `preview_om_sync` (read) + `apply_om_sync` (**held for approval**, executed via the governance effect). Live verification needs a real OM instance.

### Fixes
- **Dataset Restore** now works from the detail view (the GET route wasn't returning the record-level `archived` flag, so it offered Archive instead of Restore/Delete).
- **Knowledge delete** genuinely fixed — the real cause was `deleteWorkflow` hard-blocking *any* published (`live`/Shared) workflow ("unpublish first", but there's no unpublish), so shared workflows could be archived but never deleted; now archive-first then delete regardless of tier, purging all three stores + the search index.

## [os-ui 0.4.0] — 2026-07-15

Integration + honesty release. `tsc` clean; **2262 tests pass**. Several features ship as
explicitly-labeled Phase-1 slices (their next phases need new infra or the customer's cloud
credentials — called out honestly, never faked).

### Feature — Science tab, reworked into an integrated lifecycle (Phase 1)
- The Science tab is no longer a launcher of four raw consoles. It's now an **integrated model-as-a-service tab** matching every other tab: All/My/Shared/Marketplace list + **＋New model**, detail-on-click with **Predict** ("Try it" against the live KServe model), tier ladder (promote), version history, and lifecycle — wrapping the live churn/KServe slice as the first model. The raw MLflow/Featureform/JupyterHub/KServe consoles move to a **Developer → Open console** escape hatch. `app/science/page.tsx` shrank from ~1000 lines to a thin shell. Honestly Phase-2+: guided train + a real on-platform **training runtime** (new infra) and inline eval/monitor charts render as labeled "coming" states.

### Feature — OpenMetadata as a Connection, read/discover (Phase 1, flag-gated off)
- A customer's existing OpenMetadata can be connected as a first-class **`om-catalog` Connection** (base URL + vaulted bot JWT) with **read-only** tools (`list_domains`/`list_data_products`/`list_tables`/`search_catalog`/`get_om_lineage`), a per-connection OM client with version detection, and a DLS-scoped fold of their catalog into OS discovery — **zero writes to OM** by construction. Behind `OPENMETADATA_CONNECT_ENABLED` (default off). Phase 2 (scoped additive JSON-Patch write into an OS-owned OM namespace, with a preview diff + approval) and Phase 3 (lineage/DQ + domain binding) are designed and scoped, not built.

### Feature — Connections page restructured (the approved 4-section IA)
- The Connections tab is now: **header** (All/My/Shared/Marketplace · Show archived · **＋New connector** wizard) → **Connections list** (App-MCP connections folded in by scope, badged "App", linking to their app) → **Supported Connectors** (a dynamic gallery that auto-lists every connector type — warehouses, Drive, OneDrive, Notion, Airflow, OpenMetadata — each **Connect** opening a guided wizard) → **Outbound access** → **Talk to Connectors**. A shared stepper (`ConnectorWizard`) drives both the supported-type and custom flows. *Honest carry-over:* a fully-arbitrary custom API/MCP endpoint still hits the backend's known-template gate (it errors honestly, doesn't fake success) — the generic custom-connector backend is a fast-follow.

### Feature — Apache Airflow as a Supported Connector
- Governed outbound connection to a member's Airflow REST API: `list_dags`/`get_dag_run` (Read) + `trigger_dag` (**Write-approval** — a DAG trigger is held for governance approval, honoring an optional DAG allowlist). Client tries Airflow **v2 then v1**, Basic or Bearer auth (vaulted). So a member who runs Airflow can drive + monitor their DAGs from the OS (and agents can). Live verification needs their real Airflow + token.

### Fix — deleting an ARCHIVED knowledge artifact now works
- Same UI-surface bug as archived datasets: archived knowledge tiles rendered `LifecycleActions surface="tile"` (which returns `null`), so the Restore/Delete controls were absent, and the "Show archived" toggle didn't reach the General/"My knowledge" view. Fixed both areas (Workflows + Personal); the delete route + physical OpenSearch purge were already correct.

### Polish — Agents tab
- Bigger **Judge this run** + **Download PDF report** buttons; the PDF report now contains **Run results** (final output + per-agent outputs) alongside the **Assessment** (diagnostics), so it's one complete shareable report.

## [os-ui 0.3.5] — 2026-07-15

### Feature — external-warehouse connectors usable end-to-end (no YAML / no helm)
- **One-click Register**: a warehouse connection now registers its Trino catalog **live** from the UI — merges the generated `<catalog>.properties` into the read-only `trino-catalog` ConfigMap, materializes the vaulted secret(s) + wires the Trino env (keyless IRSA/Workload-Identity for Glue/BigQuery; `${ENV}` secret-ref for Snowflake/Databricks/Fabric), and rolls Trino — governed (Builder+/edit-rights), audit-logged, credential never returned. The os-ui RBAC role gains `configmaps`+`secrets` (gated on the flag).
- **Discover + Import**: `discover_warehouse_tables` (governed `SHOW SCHEMAS`/`SHOW TABLES`) + a Data-tab "Import from warehouse" flow that CTAS-imports a federated table as a normal governed dataset (`iceberg.<domain>.<name>`). The connection UX is **Create → Register → Test → Browse → Import** — no catalog properties or YAML ever shown. (Fabric/OneLake honestly degrades to a manual table-path input — no metastore probe.)

### Feature — Power BI consumption via Cube's SQL API (per-domain principal)
- Cube's Postgres-wire **SQL API** (`cube.sqlApi.enabled`, port 15432) exposes the governed semantic layer to Power BI. Each domain gets a read-only **`bi_<domain>`** principal — Cube's `checkSqlAuth` parses the domain from the username and resolves that domain's `securityContext` → OPA/RLS, so a Power BI connection sees only its domain's governed metrics. A `/api/powerbi/connection-info` route advertises host/port/database/user (password stays in the `cube-sql-secrets` vault, never in the response) + `docs/powerbi-consumption.md`. Honest limit: **domain-level** scope (all viewers of a domain share it) — per-viewer RLS is a later phase. External Power BI needs the operator to publish a **TCP** LoadBalancer to `cube-sql:15432` (Postgres wire, not HTTP).

### Fix — "Show archived" toggle always solid
- Dropped the `opacity: 0.7` dimming on the "Show archived" toggle across all 7 tabs (Data, Connections, Metrics, Agents, Dashboards, Files, Artifacts) — it read as disabled even though it worked. Now always solid.

## [os-ui 0.3.4] — 2026-07-14

Live-QA fixes found by exercising the deployed OS tab-by-tab. `tsc` clean; 2195 tests pass.

### Fix — deleting an ARCHIVED dataset now works (was the blocker)
- Root cause was a UI gate divergence, not the route/purge (those were correct). The Data tab used a hand-rolled permission check that **omitted `domain_admin`** and wrongly required a platform admin to be a member of the dataset's domain; and archived tiles rendered `LifecycleActions surface="tile"` which returns `null`, so the **Restore/Delete buttons the copy promised were literally absent**. Now `components/data/DatasetTiles.tsx` uses the shared `canManageArtifact` (identical to the DELETE route + every other tab) and renders the real Restore/Delete cluster on archived tiles → archive→delete works for the owner/admin, 403 for a non-owner non-admin.

### Fix — Superset embed auto-heal (dashboards created before the embed fix)
- `mintEmbed` now takes the dashboard spec and, when the dashboard isn't yet in Superset, **builds it on the fly** then embeds — so a dashboard created before the build-on-create fix (e.g. "Contribution") self-repairs on first view instead of staying OFFLINE-MOCK. Idempotent for already-built dashboards.

### Fix — Science tab: Jupyter/KServe links (were `localhost`/404)
- The chart never emitted the Science **console URLs**, so they fell back to `localhost`. Now `os-ui.yaml` emits `JUPYTERHUB/MLFLOW/FEATUREFORM/KSERVE_CONSOLE_URL` via the `soa.consoleUrl` helper; a new `proxy-public` ingress (`jupyter.<domain>`, WebSocket-annotated) gives JupyterHub (which was already deployed + serving, just had no front door) a real browser entrance; KServe — which has no human UI — now shows an honest "No console" state instead of a dead localhost link. MLflow/Featureform keep opening via the in-cluster tool-proxy (why they already worked).

### Fix — Featureform comes up green (opt-in Layer 4)
- The all-in-one image assumes an embedded Postgres and never creates its metadata schema against our external PG (so its coordinator errored `ff_task_metadata does not exist`); and its :80 dashboard (the endpoint the OS probes) couldn't start because the hardened container dropped `CAP_CHOWN` that nginx needs. Added an `ff-migrate` init container that runs the image's own `goose` migrations against the external `featureform` DB, and restored just `CAP_CHOWN` on the main container. (Also: a `post-upgrade` reconcile hook now creates the `featureform` role+db that was missing on the long-lived volume.)

### Fix — Google Drive / OneDrive: `testConnection` is real, not a stub
- The OAuth authorization-code flow (authorize + callback routes, admin OAuth-app registry, token-in-Secrets-Manager, silent refresh, honest "not configured" UI) already existed; the one remaining "pretends to connect" gap was `testConnection` doing a generic HEAD poke that **always returned ok**. It now makes a real Drive `about.get` / Graph `/me/drive` call with the stored token — honest healthy / needs-reconnect / not-connected. (To actually connect, an admin must register a Google/Microsoft OAuth app under Platform → OAuth apps; the UI says so honestly until then.)

### Feature — external-warehouse connectors are now surfaceable
- `EXTERNAL_CONNECTORS_ENABLED` is wired into the chart (`osUI.externalConnectorsEnabled`), so the warehouse create-flow + MCP tools appear when an operator turns it on. Deployed **on** for this tenant.

## [os-ui 0.3.3] — 2026-07-14

### Fix — OS-built apps now serve a real UI (closes the Software image-build gap, #132)
- **Proven end-to-end:** a created app's CI now genuinely `docker build`s and pushes an image to the Forgejo registry, the node pulls it, and the runner deploys it (verified live — the first OS-built app image ever produced; the prior app-path CI was a no-op `echo` stub that reported success while pushing nothing).
- **Scaffold produces a runnable app:** the `nextjs-supabase` template now seeds a minimal Next.js **App Router** app (`app/page.tsx` + `app/layout.tsx`, no runtime Supabase calls so it boots without secrets) and a correct Dockerfile — `npm install` (no lockfile is seeded; the old `npm ci || true` silently produced no `node_modules` → `next: not found`), a real `next build`, and `PORT=8080`/`HOSTNAME=0.0.0.0`/`EXPOSE 8080` to match the runner's readiness probe. TS devDependencies are seeded so `next build` type-checks in the network-less DinD runner.

### Feature (flag-gated, default OFF) — external-warehouse connectors, integration layer
- Building on the provider registry (Glue/Athena · Snowflake · BigQuery · Databricks-Delta · Fabric/OneLake — all real `catalogProps` generators, secrets referenced via `${ENV:…}`/mounted files, never inlined), this wires the connectors end-to-end behind `EXTERNAL_CONNECTORS_ENABLED`: a generic Connections create-flow that renders each provider's `credentialFields` (secrets vaulted to Secrets Manager, never on the record); **live Trino catalog registration** via a new `values.trino.externalCatalogs` list rendered into the read-only `trino-catalog` ConfigMap with per-catalog secret-env / IRSA injection; a governed **import-to-Iceberg** CTAS (`import_warehouse_table`, reusing the materialize path); MCP `create_connection`/`test_connection` (honoring each provider's `testProbe`) + `warehouse_registration`/`import_warehouse_table`; and an OpenMetadata connector-hint stub. Default render is unchanged (empty catalog list); nothing activates until an operator sets the flag + adds a catalog. Live "returns rows" verification against a real AWS/Azure/Snowflake/GCP/Databricks account remains the operator's step.

## [os-ui 0.3.2] — 2026-07-14

Four-tab operability pass (Dashboards, Monitoring, Science, Software) plus a
medallion-layer choice on agent data grants. All code `tsc`-clean; 2120 tests pass.

### Fix — Dashboards embed actually mounts (was permanently OFFLINE-MOCK)
- **Guest-token mint no longer 403s.** The Superset service handshake now sends `X-Forwarded-Roles` on both the CSRF GET (the first request, which triggers `_sso_login`) and every service call, and the chart injects `SUPERSET_SERVICE_USER`/`SUPERSET_SERVICE_ROLES` — so the embed service user is `Admin`, not a role-less `Gamma` that the mint endpoint rejected.
- **Dashboards now import into Superset on create.** MCP `create_dashboard` calls `buildDashboard(...)` after save (delegated domain token), so a created dashboard exists in Superset to embed instead of only in the OS store.
- **The embed is mounted, not summarised.** `EmbedPanel` now mounts the real `@superset-ui/embedded-sdk` `embedDashboard(...)` against the embedded UUID with the OS-minted guest token, with clean unmount. `mintEmbed` now surfaces a `reason` when it can't embed (honest failure instead of silent mock).

### Fix — Monitoring shows real numbers, not placeholders
- **Cost lens reconciles live LiteLLM spend.** `collectCost` always reads LiteLLM `/spend/tags` (parsing the real `individual_request_tag`/`total_spend` shape, dropping `User-Agent:` transport noise), and `governance/cost.ts` seeds its cap ledger from that live read so cap-breach alerts fire on real usage. (On STACKIT the self-hosted models are free per-token, so spend is honestly `$0` — grouped, not mocked.)
- **Native trace drawer fills Context pack + Logs.** `fetchTrace` derives `contextPack` from the generation observation's `input.messages` (falling back to the governed trace input) and emits structured `logs` lines per observation — so the drawer shows the real packed context + `principal=… decision=allow`, not empty arrays.

### Fix — Science infra: predictor + feature store come up (Science tab was red)
- **Featureform's Postgres backend is provisioned on existing volumes.** A new `post-upgrade` reconcile Job idempotently creates the `featureform` role+db in the plain-engine Postgres (the init script only ran on first boot of an empty volume, so a database added later never existed — Featureform looped forever authenticating). 
- **KServe sample model is seeded.** A new `post-upgrade` Job trains + uploads the `churn_model` artifact to the path the InferenceService expects, so the predictor's storage-initializer stops crash-looping and the service goes Ready. Both hooks are chart-native and idempotent.

### Fix — Software: OS-built apps actually build + can deploy (#132)
- **The scaffolded CI is a real build, on both paths.** The legacy `POST /api/software` scaffolder emitted an `echo` stub with an external `actions/checkout` the sovereign runner can't run; it now emits the same real `runs-on: docker` in-pod `docker build && push` workflow the app path uses, and seeds a `REGISTRY_PASS` secret so `docker login` works.
- **Workflow is committed last.** `scaffoldRepo` now commits all source before `.forgejo/workflows/*`, so the CI-triggering push lands against a complete build context (matching the proven demo-app seed order).

### Feature — medallion-layer choice on agent DATA grants
- A data grant can now target **Bronze / Silver / Gold**. The Simple-builder selector shows **only the layers actually built** for that dataset and defaults to the **highest available** (Gold if built, else Silver, else Bronze); it hides entirely when a dataset has a single layer. The choice is enforced server-side for `get_dataset`/`profile_dataset` (the granted layer's physical FQN is injected, viewer-aware, with graceful fallback to the furthest built layer), and steers ad-hoc `query_data` via discovery. Backward-compatible: no layer = Gold; existing `system.yaml` stays byte-stable. Metrics/Dashboards remain Gold-locked.

## [os-ui 0.3.1] — 2026-07-14

### Hardening — Northpeak durability guards (belt-and-suspenders on the 0.1.99 fix)
- **CTAS won't zero-out populated data.** `assertNoZeroRowReplace` (in `lib/data/build/live-clients.ts`) runs before any `CREATE OR REPLACE TABLE <fqn> AS <select>` in the Silver/Gold build + promote-publish paths: if the target already has rows and the incoming SELECT would produce 0, it aborts instead of replacing. Fresh targets / >0-row results / transient probe errors proceed normally.
- **Post-upgrade OPA hook re-asserts domain self-principals.** A new `post-install,post-upgrade` Job re-`PUT`s each governed domain's self-principal into live OPA (the row-filter membership the governed query tool depends on), idempotent + non-blocking — so a stray UI policy push can never leave a domain's tables invisible across an upgrade.

### Repo hygiene
- Removed two stray tracked duplicate files (`* 2.*`); added a `.gitleaks.toml` allowlist for the obviously-fake unit-test password fixtures.

## [os-ui 0.3.0] — 2026-07-13

### Feature (Phase 1, behind a flag) — external-warehouse connector foundation
- First slice of "connect any lakehouse, govern it in one plane": a design (`docs/external-warehouse-connectors.md`) and the pure, unit-tested core under `lib/connections/warehouse/` — a typed `WarehouseSource` model, a `trinoCatalogProps()` generator (**AWS Glue** fully implemented, IRSA-only, provably no static keys; Snowflake/BigQuery/Databricks/Fabric are typed stubs), external-table FQN mapping, and a `FederatedDataset` shape + mapper. All gated behind `EXTERNAL_CONNECTORS_ENABLED` (**default off**), so nothing changes at runtime yet. Live catalog registration, OpenMetadata ingestion, cloud auth, and import-as-product are Phase 1b/2 (they need a real source to validate). Architecture: external sources federate through **central Trino** (one governed path + OPA); a *data product* = imported into the sovereign Iceberg lakehouse; OpenMetadata mirrors the estate for discovery.

## [os-ui 0.2.1] — 2026-07-13

### Fix — embedded Superset dashboards: "guest token mint failed" (4 stacked defects)
- **Embedding was never enabled.** Superset gates its guest-token API behind `FEATURE_FLAGS.EMBEDDED_SUPERSET`, which was off → 403 for everyone. Now set in `superset.configOverrides` (with `GUEST_ROLE_NAME = "Gamma"`, a 300s token TTL, and a **stable** `GUEST_TOKEN_JWT_SECRET` from `extraSecretEnv` — was the insecure 27-char default).
- **The mint call was unauthenticated.** `realEmbed().mint()` POSTed the guest-token endpoint with no CSRF/cookie/service-user headers (the source of the 400/403). It now runs the same authenticated handshake as every other Superset call — shared `lib/superset/auth.ts` (`csrf`/`serviceUser`/`serviceHeaders`).
- **Dashboards weren't registered as embeddable.** Guest tokens require a dashboard's *embedded UUID*, not the OS id. New `ensureEmbedded()` auto-registers a dashboard for embedding on first view and mints against that UUID; the embed API now returns `embeddedId` for the SDK.

## [os-ui 0.2.0] — 2026-07-13

### Feature — Simple agent-builder bundle: usable grants + clearer phases

The "What your team can use" section is now truthful and the 5-phase builder is clearer:

- **Grants that actually work.** The section grows from Data+Knowledge to **Data · Knowledge · Files · Connections**, each with a **Read / Can-write** toggle that **auto-provisions the matching governed tools** into the team (via `capability-tools`), so granting a resource makes it *usable* — not just listed. Writes run directly or need approval per the team-wide safety setting (one honest knob, noted inline).
- **Trigger moved to Define.** "How is this team triggered?" (Manual · On schedule · Called by another system) + the Outlook-style recurrence editor now live in **Define** (team setup, next to the safety preset). **Run** is execution-only.
- **Run leaner, Evaluate richer.** The per-agent status + output breakdown moved from Run into **Evaluate** (understanding the run = evaluating it); Run shows progress + the final result.
- **Runtime badge.** The builder header shows whether a team is **Graph (LangGraph)** or **Autonomous (Hermes)**.
- **Sharper AI judge.** Define's description is now persisted and feeds the Evaluate judge (which also auto-gathers granted-workflow tacit criteria, 0.1.100) — so it grades the real task, not a generic one.

## [os-ui 0.1.103] — 2026-07-13

### Change (UX consistency) — Metrics & Dashboards are single-view now, with the standard Promote button
- **Metrics detail** drops its Explore/Govern/Alert subtabs for one scrolling view: Explore → **Alerts inline** → a Lifecycle row (Promote + Archive/Delete/Version) at the bottom.
- **Dashboards detail** drops its subtabs the same way: View (Superset embed) → **Reports inline** → Lifecycle row.
- New shared `components/lifecycle/PromoteButton.tsx` gives every tab the **same Promote experience**: a non-approver owner's press *files a request* ("⏳ Requested — awaiting a domain admin's approval", persisted across reload) and an approver promotes directly; Certify runs behind a confirm. Backed by new `dashboards`/`metrics` `[id]/promote` routes (with GET status) on the 0.1.102 `promoteOrRequest` contract.

## [os-ui 0.1.102] — 2026-07-13

### Change (governance) — Promote = propose everywhere (no more "requires a Domain admin" dead-end)
- Pressing **Promote to Shared** on an artifact you OWN but can't yet approve (creator/builder) now **files a promotion request** that a domain-admin approves in Governance — consistent with the Data/Files/Knowledge tabs — instead of a hard 403. Approvers still promote directly. New shared `promoteOrRequest` ladder helper; the **Apps, Connections, Agent-systems and generic Artifacts** promote routes now route through it, each with a GET status endpoint so the UI can show "awaiting approval". Separation-of-duties is unchanged (only the owner may propose; a non-owner still can't publish someone's draft; certification stays admin-only).
- An OS-wide audit confirmed **Builders can already create/build in every tab** — the 0.1.95 edit-scope tightening only affected editing others' shared work, not creating your own. (The one exception, metric-define, was fixed in 0.1.101.)

### Polish — Users & Access
- The **Reset password** button (admin → edit user → set a new temporary password) is now a full-size, prominent button with a 🔑 label (was a tiny link).

## [os-ui 0.1.101] — 2026-07-13

### Fix (cohort blockers) — metric creation for Builders + the Cube "did not resolve" collision
- **Builders can define metrics again.** The 0.1.95 edit-scope tightening accidentally gated metric definition behind *structural dataset edit* (owner/domain_admin/admin), so a Builder defining a metric on a shared-in-domain gold mart got "Not permitted to edit this dataset". Defining a metric is additive semantic work (the Metrics tab is built for it), not a structural edit — `defineMeasure`/`removeMeasure` now use a dedicated scope: the dataset **owner** (any rank) or a **Builder+** who can use the data. Structural edits (silver/gold rebuild, docs, promote, delete) stay owner/admin.
- **"metric did not resolve" root cause fixed.** Two datasets with the SAME name map to the same Cube model file (`metrics/<slug>.cube.yml`) and the same domain gold table, so the model-sync sidecar overwrote one with the other every poll — a newly-defined measure silently vanished from live Cube. Now `createDataset` rejects a duplicate name within a domain (409, clear message), and `buildCubeModels` collapses any pre-existing duplicate to one entry per file (keeping the richest) so the delivered payload can never thrash.

## [os-ui 0.1.100] — 2026-07-13

### Builder — Build & Evaluate phases now show completion (first slice of the 0.2.0 bundle)
- The **Build** phase gets a green ✓ in the stepper once the team is built, the button reads **Rebuild** afterward, and a "Last built …" note shows when — no more guessing whether a build finished.
- The **Evaluate** phase gets a green ✓ once a run's deterministic checks all pass.
- **Sharper AI judge:** the Evaluate judge now scores against the REAL task — it uses a persisted team description when set and **auto-gathers the success criteria (tacit notes) from the granted knowledge workflows**, instead of a generic fallback. Groundwork also landed for capability→tool auto-provisioning (`lib/agents/capability-tools.ts`) surfaced in the next bundle slice.

## [os-ui 0.1.99] — 2026-07-13

### Fix (data governance) — a UI policy push could blank every domain-scoped table
- Root cause of "Northpeak Campaign Performance suddenly empty": the governed query tool runs **as the domain name** (`user.domains[0]`), so OPA must carry a **domain self-principal** (`agentic-leader-q3-2026 → domains:[agentic-leader-q3-2026]`) or the Trino row filter resolves the domain's membership to `[]` and injects `WHERE false` → **0 rows** (the data is untouched, just hidden on read). Two durable guards so a publish/promote can never blank a table again:
  - `lib/data/policy/compiler.ts` now **emits a domain self-principal for every governing/shared domain** on every compile — independent of whether the user directory lists it.
  - `lib/data/build/live-clients.ts` now pushes governance as an **upsert-per-key merge** (`PUT …/principals/<id>`) instead of a whole-object replace, so a push can never delete the statically-seeded self-principals it didn't recompute.
- Live remediation applied: re-pushed the `agentic-leader-q3-2026` / `sales` / `test` self-principals; the 14 Northpeak rows are visible again for the domain session user.

## [os-ui 0.1.98] — 2026-07-13

### Fix (blocker) — bounded / full-in-scope agent teams could not write or create artifacts
- An agent system's **safety preset** (Read-only · Read+propose · Read+bounded · Full-in-scope) was ignored by the run-time tool executor: **every** write tool (`upload_file`, `create_dataset`, `author_knowledge`, …) was unconditionally held for Governance approval, so even a team explicitly set to **Read+bounded** or **Full in-scope** could never create a new file/dataset — it reported "requires approval — enqueued to Governance" and stalled. The executor (`lib/agents/build/os-tools.ts`) now honours the preset, matching `governance.ts` `resolveAutonomous`: `read-only`/`read-propose` still HOLD writes for a human; `read-bounded`/`full-in-scope` run the write **directly as the acting user**. This is safe — the write still passes gate 2 (the runner's own OPA/DLS/role, exactly what they could do by hand in the UI), and promotion (Personal→Shared) keeps its own separate approval gate. Creating a Personal-lane artifact never needs approval, so a team acting as its runner no longer waits on one.

## [os-ui 0.1.97] — 2026-07-13

### Feature — business-friendly recurring schedule + run/build/deploy prominence
- The agent-system "On schedule" trigger now uses an **Outlook-style recurrence editor** (Daily · Weekly · Monthly + time + weekday picker, plain-language summary like "Every Monday at 09:00"), generating the cron under the hood; a raw-cron "Advanced" option remains for power users. The trigger TYPE is shown read-only in the header; changing it happens in the editor. Build / ▶ Run / Deploy are now consistently prominent primary buttons.

### Fix — a completed run no longer shows as still "running"
- The run route set the persistent running flag on COMPLETION (backwards), so a finished manual run lingered as "running" with a live Stop button. It now clears the flag when the run finishes.

### Change — DuckDB → Trino labels
- The query engine was Trino stack-wide since 2026-06-29, but the Components tab, the data-parity proof, a tutorial label, and the license list still said "DuckDB". Relabeled to Trino.

## [os-ui 0.1.96] — 2026-07-13

### Feature — the agent-system builder is now a clear 5-phase flow
- **Simple mode is reorganized into Define · Design · Build · Run · Evaluate.** Define (name, description, safety/rights preset up front); Design (the team, with a **template picker** on "+ Add agent": curated roles — blank/analyst/recommender/reviewer/researcher — plus marketplace-shared agents); **Build** (renamed from "Build & run", compile+verify only); **Run** (a separate step with three clear trigger modes — Manual · On schedule · Called from system — the schedule editor moved here, and a one-click **▶ Run** of the defined task replacing the confusing "What should the team do?" prompt, with an optional per-run input; results shown here); **Evaluate** (diagnostics + Langfuse + PDF report relocated here, plus deterministic **checks** — non-empty · no error/denial · within budget — and a one-click **LLM-judge** scoring Clarity/Grounding/Actionability). All phases still write the same `system.yaml` through the same commit path and reuse the existing run engine; Developer mode is unchanged.

### Fix — creating a metric no longer errors while Cube catches up
- **Defining a metric no longer shows a scary `Cube 400 … not found for path`.** Runtime-defined metrics reach Cube via a model-sync sidecar within a few seconds; the app used to query the new measure immediately and hard-fail. Now the define + live-preview paths **fail-soft**: the metric is always saved and the UI shows "✓ saved — its live value appears within a few seconds as Cube syncs" instead of an error. The sidecar poll interval was shortened (30s → 5s) for snappier convergence, and a hint nudges you to promote the dataset to Shared + build Gold if its metrics aren't reaching the query engine. (Corrected a stale code comment that wrongly claimed Cube schema was git-deployed.)

### Change — consistent artifact-tab headers
- **The All/My/Shared/Marketplace scope pills and the Show-archived / + New buttons now render at a consistent size and alignment across every tab**, and **Connections** gained the standard Show-archived + "+ New connection" header controls it was missing.

## [os-ui 0.1.95] — 2026-07-13

### Governance — shared artifacts are owner/admin-managed; sharing is admin-approved
- **A shared (domain/marketplace) artifact can now only be edited, archived, deleted, or un-shared by its OWNER (even if just a Builder), a domain admin of the owning domain, or a platform admin.** A non-owner Builder may view and use shared artifacts but can no longer modify or archive someone else's. Enforced fail-closed server-side via one `canManageArtifact` helper across every artifact type (data, files, knowledge, personal knowledge, connections, agents, software, dashboards, big bets, science models) — including the demote/revoke-sharing path — with the edit/archive/delete UI controls hidden from non-owners as defense in depth. (This also fixed a latent gap where domain admins could not manage in-domain artifacts, and where dashboards were owner-only.)
- **Approving a Personal→Shared promotion now requires a domain admin or platform admin** (a Builder can still press Promote to FILE the request; it just no longer self-approves). Shared→Certified/Marketplace stays platform-admin-only. MCP approval tools (`approve_promotion`, `publish_knowledge`, `promote_connection`) raised to domain-admin.

### Fix — creating a metric no longer 400s on an id column
- **Slicing a metric by a dataset's primary key (e.g. `campaign_id`) no longer throws a Cube 400.** The dimension picker offered the key column, but the Cube view intentionally excludes the key — so the query targeted a non-member. The picker and the query builder now reconcile requested dimensions against the view's real members (mirroring the region-RLS fix), dropping non-members fail-soft instead of erroring.

### Fix — Knowledge workflow step titles are fully readable
- **Workflow step boxes now wrap the full title onto multiple lines** instead of truncating past ~3 words; the box grows to fit so nothing is clipped.

## [os-ui 0.1.94] — 2026-07-13

### Fix — Ask the OS input pinned to the bottom
- **The Ask-the-OS message log now fills the drawer and the input box stays at the bottom.** The log inherited a 460px max-height cap, so in the tall assistant drawer the input floated mid-panel and long answers were awkward to read. The log now grows + scrolls, with the input + Send button anchored at the end so the whole conversation is readable.

## [os-ui 0.1.93] — 2026-07-13

### Fix — Simple builder: tools land on the right agent
- **Adding a tool to an agent in the Simple builder now shows on THAT agent**, not on a different (the first) one. Tools are managed per-agent: an agent that had no explicit tool list used to inherit the whole system pool, so a tool added to one agent appeared on every inheriting agent instead of the one you clicked. Add/remove now affect only the target agent (siblings are frozen to their current set), preserving the invariant that an agent's tools are a subset of the system grant pool.

### Fix — Simple builder: any agent is deletable
- **You can now delete any agent card, including the START agent.** Deleting the entrypoint hands START to the next remaining agent automatically (or clears it when the team becomes empty), so you're never stuck with an agent you can't remove.

### Feature — restore an older version of an agent system
- **Agent systems now show Version history with per-version Restore** in the system detail (it was hidden). Every save already commits `system.yaml` + the agent files to a git repo, so the full history was there — restoring re-commits a prior version onto HEAD (auditable).

### Change — navigation
- **Marketplace moved under Plan** (below Big Bets), and **Tutorials + MCP moved up to the top entry area** (under Cockpit), so the sidebar groups read more naturally.

## [os-ui 0.1.92] — 2026-07-13

### Change — multi-agent teams run cheap-first (big token + latency saving)
- **A team run's fast/gatherer nodes now run on the STANDARD model (gpt-oss-20b), not the 235B reasoning model.** The graph's exec ("tools") tier previously followed the reasoning model, so *every* node — even read-only data-gatherers — ran on Qwen3‑235B, the main token/latency sink of a run. Now the Auto per-node router genuinely saves: read-only gatherers → the cheap standard tier, and only write/decide/synthesis nodes escalate to reasoning. gpt-oss-20b's "harmony" tool-call framing is stripped defensively, so it degrades gracefully. Fully reversible: set `LITELLM_TOOLS_MODEL` (or the `tools` model role) back to the reasoning model, or pin any single agent to **Reasoning**. The between-node context budget already sizes to the smaller model window, so this is safe with the 128k standard model.

### Feature — Science tab gains the OS-wide lifecycle
- **A model-as-a-service can now be Archived → Restored / Deleted**, the same consistent lifecycle every other artifact tab has (it was the only tab missing it). The controls sit in the model's tier-ladder detail card; archive is reversible, delete is reachable only once archived and is edit-scoped (owner or domain Admin, agents rejected). Adds a `model` lifecycle kind, an `archived` flag that drops archived models out of the tab list, and the `/api/science/model/[model]` archive/unarchive/delete route.

## [os-ui 0.1.91] — 2026-07-13

### Fix — multi-agent run no longer 400s on ContextWindowExceededError
- **The last agent in a longer team (e.g. the campaign "recommender") could crash** with `LiteLLM 400 ContextWindowExceededError` (~192k input + 8k output = the whole 200k window, zero slack). Two root causes fixed: (1) the input budget was `contextWindow − reservedOutput`, but the request *also* sends `reservedOutput` as `max_tokens` — double-spending the reserve; `inputBudget` now subtracts an additional **safety headroom** (~4% of the window) so `input + max_tokens` stays strictly under the window. (2) the token estimator ignored `tool_calls` argument JSON (a big `query_data` call carries none in `content`) + the message envelope; it now counts both, so the budget reflects the real request. A new invariant test guards `inputBudget + reservedOutput < contextWindow`.

### Fix — PDF run report renders real tables
- **The downloadable run report showed markdown tables as raw `| a | b |` text.** The PDF now parses GFM tables in each agent's output and the final output and renders them as **real tables** (jspdf-autotable), with headings/bullets formatted instead of dumped as markdown source.

### Change — Connections lifecycle is discoverable
- **Archive / Restore / Delete for a connection moved out of the buried "Capabilities" expand** into the card's action row, next to Promote / Unshare — the same clear, consistent lifecycle placement every other artifact tab uses (live → Archive; archived → Restore + Delete, reachable via the "Show archived" toggle).

### Change — system.yaml is a read-only source view (Developer mode)
- **The raw `system.yaml` is now read-only by default with an explicit "✎ Edit YAML" button**, and moved to the **last** Developer tab (the tabs open on Build & run). It stays the single source of truth behind the canvas, grants, and per-agent fields — but raw hand-editing is now a deliberate opt-in rather than the first thing you see.

## [os-ui 0.1.90] — 2026-07-13

### Feature — Simple builder can grant Data & Knowledge
- **The Simple (guided) agent-system builder now has a "What your team can use" section** — plain add/remove chips for **Data** and **Knowledge**, sourced from the same role-scoped `grants/available` catalog the Developer grants table uses and written to the same `grants.data` / `grants.knowledge` (at **Read**). Previously grants lived only in the Developer-only "Grants & routing" tab, so a non-coder building in Simple mode could not attach the dataset or workflow knowledge their team needed. Write access and Metrics/Connections stay in Developer mode to keep Simple uncluttered.

### Change — Simple is the default builder mode for everyone
- **The agent builder now opens in Simple mode for all roles** (admins included), with **Developer** one click away and the choice remembered per user. The raw `system.yaml` editor, canvas, and full grants table remain exactly as they were — in Developer mode — for people who want them. `system.yaml` is still the single source of truth behind every surface; only the default landing changed.

### Change — Knowledge sub-tabs reordered
- **Knowledge opens on Workflows first, then General.** The two sub-tabs were swapped and the tab now lands on Workflows by default (the day-to-day surface), with General (the domain operating manual) second.

## [os-ui 0.1.89] — 2026-07-13

### Feature — revoke sharing (demote down the ladder)
- **You can now pull an artifact back down the sharing ladder.** Previously things only promoted up (Personal → Shared → Certified/Marketplace) with no way back. A governed **demote / "Revoke sharing"** now lowers visibility one rung (Marketplace → Shared, Shared → Personal) for datasets, files, knowledge, agents, apps, connections, and marketplace artifacts — via a central `demoteThroughSeam` mirroring promotion, with the same **role gates** (revoking from Marketplace needs Admin; Shared → Personal needs the owner or an in-domain Builder) and **lineage guards** (blocked if another artifact still depends on it — never orphan a live consumer). Every demote is audited. A "Revoke sharing" control with a confirm sits in each artifact's detail.

### Feature — run diagnostics + downloadable PDF report
- **A simple diagnostics table at the bottom of a completed agent run** — one row per agent (model · tier · governed calls · decision), with tokens / latency / cost columns when the Langfuse trace is reachable (honest "metrics unavailable" note otherwise; the table always renders from the run's own data).
- **A "Download PDF report" button** on a completed run — exports the task, per-agent status + output, the diagnostics table, and the final output as a shareable PDF, so students can send their results to instructors.

### Fix
- **Agent tool-grants show knowledge by NAME, not a raw id.** The grantable-knowledge list only included workflows (`wf_…`) and missed personal knowledge entries (`pk_…`, e.g. "Purchasing Details"), so a granted personal-knowledge item rendered as its machine id. Both are now listed with their titles; a genuinely orphaned grant reads `(removed) …` instead of a bare id.
- **Workflow diagram no longer clips step text, and boxes are clearly editable.** Step boxes are wider with a full-title hover tooltip (no more cut-off), a pointer cursor + hover lift + ✎ badge signal that a box is editable (click → step editor), and the derived Mermaid view is labelled "(read-only)".

## [os-ui 0.1.88] — 2026-07-13

### Feature — Admin → Users & Access is now the one full user-admin console
- **An admin can set (and reset) a user's password in the console.** The live Users & Access surface (`/platform/access`) previously delegated to an identity provider that didn't deliver a credential on this deployment, so invited users couldn't sign in. It now has a **Password** field (Show/Hide, Copy, Generate-strong, live strength meter) validated on client **and** server; the password is hashed (scrypt) and the created user **can log in with it** (proven by test). Existing users get a **Reset password** action. (The earlier 0.1.86 password field had landed on a deprecated component that isn't live — this puts it on the real surface.)
- **Domain picker is a dropdown with checkboxes** (was pill toggles), in both invite and edit.
- **Deactivate asks for confirmation.** **Offboard** now appears only for **deactivated** users (who sort to the bottom), and opens a strong-danger dialog warning the account + its personal "My artifacts" are permanently deleted — with an option to **reassign "My artifacts" to another user** (data · files · knowledge · agents · software; dashboards/bigbets/science reported as deferred) before deletion. Guards: can't deactivate/offboard yourself or the last active admin.

### Fix — Cube RLS no longer 400s on a missing dimension
- **A metric on a domain-scoped cube no longer fails with `'region' not found`.** The per-viewer `securityContext` spread low-cardinality attributes (e.g. `region`) that Cube turned into RLS filters — 400ing on cubes without that dimension. `cubeLoad()` now scrubs the security context against the queried cubes' **actual** dimensions: structural keys (identity/domain/scope) are always kept (RLS stays sound), attributes no queried cube has are dropped. General guard for every cube.

### Cleanup — model settings show only the sovereign set
- The model picker/catalog now presents exactly **`sovereign-default` (gpt-oss-20b) · `sovereign-reasoning` (Qwen3-VL-235B) · `sovereign-embed` (Qwen3-VL-Embedding-8B)** plus **`sovereign-mock`** (offline/testing, the default for every role when no live gateway model is wired). Stale duplicate aliases (`sovereign-vision`/`sovereign-premium`/`sovereign-reasoning-fast`) removed. Still admin/env-configurable.

## [os-ui 0.1.87] — 2026-07-13

### Feature — free-form agent-team scaffolder + `retire_knowledge` MCP
- **"Describe what your team should do" now builds a real multi-agent team from free text.** A plain-language description is turned by the reasoning model into a validated linear team (agents + per-agent instructions + handoff edges), applied through the same `system.yaml` commit path as everything else; the LLM only proposes *structure* — tools are derived deterministically by the suggester within the caller's role floor, models stay Auto. The deterministic structured fast-path (`add a <role> sub-agent…`) still applies; a malformed plan is rejected, never written.
- **`retire_knowledge` MCP tool** — archive (reversible) or delete (physical) a knowledge workflow via MCP, closing the gap where the MCP surface could author/publish/index knowledge but never retire it. Lineage-aware (blocked if any app/agent still consumes it) and role-gated exactly like the UI delete.

## [os-ui 0.1.86] — 2026-07-13

### Fix — an admin can set a user's password in the UI (create + reset)
- **The New-user form now has a Password field**, so an admin can set a user's initial password directly instead of it silently posting an empty one (which produced an un-loginnable account). Includes a **Generate strong password** button, show/hide + copy, and a live strength meter; the password is validated for strength on the client **and** server (empty/weak → 400, no account created). The server always hashes it (`lib/core/password`) — plaintext is never stored or logged.
- **Reset password** for an existing user: a platform-admin action in the user edit panel (same field + generate/strength), gated to admins (domain_admins are denied). A newly created/reset user is asked to change the password at next login.

## [os-ui 0.1.85] — 2026-07-12

### Fix — an app's declared knowledge is now authoritative (stale dependency edges are pruned)
- **Removing a knowledge reference from an app now drops its `consumes`/lineage edge.** Committing an app's `app.yaml` only ever *added* knowledge consumes edges (a union), never removed them — so an undeclared workflow stayed a live dependency and blocked deleting it (delete is lineage-aware). `commitToApp` now **reconciles** the knowledge consumes edges to exactly match `declares.knowledge` (adds new, drops undeclared, keeps labels), on every governed commit including via MCP. Non-knowledge edges (data/connections) are untouched.
- **Also fixed a latent parse bug:** `findFile` matched a suffix before the exact root path, so `app.yaml` could resolve to `manifests/app.yaml` (the k8s Deployment, which has no `declares`) and silently parse empty declares — which would have undermined the reconcile on real templates. It now prefers an exact root match.

## [os-ui 0.1.84] — 2026-07-11

### Feature — a simpler agent-system builder (without taking anything from developers)
- **Simple ⇄ Developer view toggle on the Agents builder.** Simple mode is a guided, plain-fields flow for non-coders; Developer mode is today's full surface (React-Flow graph, Monaco YAML, raw `AGENT.md`/`MEMORY.md`, explicit tool grants) — unchanged. Both edit the **same `system.yaml` / `AGENT.md`** through the same commit path, so a developer sees exactly what Simple mode produced (a test asserts the two produce byte-identical YAML). Default: Simple for builders/creators, Developer for admins; the choice is remembered.
- **The four simplifications in Simple mode:** (1) a prominent **"Describe what your team should do"** box that scaffolds the system; (2) a **guided linear flow** (Describe & name → Your team → Build & run) instead of a canvas; (3) **plain per-agent cards** — Role + an Instructions textarea (losslessly mapped to `AGENT.md`) with the model shown as **Auto** (0.1.82) and its resolved tier; (4) **auto-suggested tools** as accept/remove chips derived from each agent's role, intersected with the caller's role-scoped catalog (never offered a tool above their floor). *(The describe-to-scaffold currently recognizes the structured "add a <role> sub-agent…" class; a richer free-form scaffolder is a follow-up.)*

## [os-ui 0.1.83] — 2026-07-11

### Fix — the general domain-knowledge card is now versioned too
- **Everything in the Knowledge tab now has version history.** Workflows and personal "My knowledge" already snapshotted on every edit with a reversible restore; the general **domain-knowledge card** (the pinned, domain-wide operating manual) was the only knowledge artifact without it. It now uses the identical mechanism — a snapshot on every content change (no churn on no-op saves), a newest-first view-scoped history, and an edit-scoped, itself-reversible restore (the current card is snapshotted before a restore) — surfaced via the same shared **Version history** panel and a new `/api/knowledge/domain/[domain]/versions` route.

## [os-ui 0.1.82] — 2026-07-11

### Feature — Auto model selection per agent (faster multi-agent runs)
- **The OS now picks the right model for each agent automatically.** A node's model defaults to **Auto**, which classifies the agent from its **granted tools** (read-only gatherers — `query_data`, `search_knowledge`, `list_*`… → the **fast** model; agents that write/decide, or have no tools, i.e. pure judgment → the **reasoning** model), with a role/keyword tiebreak. The chosen tier + the reason ("read-only gatherer: …") show in the agent editor and the run drill-down. It's **deterministic** (no LLM call — decided from tools), and an explicit **Reasoning/Standard pin always overrides**. This lets a team put its analysts on the fast model and reserve the big reasoning model for the evaluator/recommender — cutting run time. (An LLM tie-breaker for genuinely ambiguous agents is a defined seam for later.)

### Fix — Software: a visible Promote button
- **Apps can now be promoted from the header, like every other artifact.** The Promote action existed but was tucked inside the collapsed "Manage" panel, so it looked missing. There's now a prominent, role-gated **Promote to Shared / Promote to Marketplace** button next to the app's visibility badge (Personal→Shared for Builder+, Shared→Marketplace for Admin); the full "cascades to the app's data/files/MCP" context still lives in the Manage panel.

## [os-ui 0.1.81] — 2026-07-11

### Feature — live progress: "Running the team…" now shows what's happening *now*
- **A team run streams its progress.** Instead of a static banner, the Run panel now shows the current step live — e.g. `performance_analyst · query_data — running · step 5` — and lights up each agent in the path as it starts (▹) and completes (✓). Implemented over Server-Sent Events (reusing the same streaming grammar as the interactive software-team builder), with the exact same final result on completion and a clean fallback to the non-streaming path if the stream isn't available — never a stuck spinner.

### Security — close two unauthenticated routes (GATE-5 sign-off)
- **`POST /api/classify`** now requires a session. It proxies to the LLM gateway with the server-side master key; leaving it open allowed anonymous, unmetered use of the paid model. Fixed with `requireUser()` (401 for anon).
- **`POST /api/software`** now requires a session. It creates a real Forgejo git repository and writes files as the platform service account; the GET was already gated but the POST was not. Fixed with `requireUser()`.
- (Found by a full cohort security audit; every other area — fail-closed governance, role/DLS isolation, MCP front door, destructive-action gates, secret handling, participant lockdown — passed.)

## [os-ui 0.1.80] — 2026-07-11

### Feature — the Context Librarian (need-aware context curation)
- **A governed, embedding-driven curator that gives each agent the context it actually needs — in full — instead of a naively head-truncated dump.** New `lib/infra/context/librarian.ts` (`curateContext` + `curateThenAssemble`) runs in front of the budget packer: when the candidate pool exceeds the model window it embeds the agent's *need* (role + task) and each competing chunk with the `sovereign-embed` model, keeps pinned + the clearly-relevant material **whole**, compacts the mid-relevance, and drops the low — so a recommender reliably receives its predecessor's **complete scorecard** by relevance rather than the first N rows. It only curates when crowded (no embedding cost in the common case), only ever selects among **already-entitled** items (DLS/OPA preserved — a curator, never a bypass), and **falls back gracefully** to the existing packer if embeddings are unavailable. Wired into the multi-agent handoff and the Talk-to copilots; a Phase-2 LLM-curator escalation seam is in place for later.

### Fix — multi-agent runs are now reliable *and* readable
- **The trailing-semicolon SQL loop is gone.** An agent whose generated SQL ended in `;` hit Trino `SYNTAX_ERROR` and retried dozens of times. The governed `query_data` path (and Talk-to's NL→SQL) now strip a trailing `;` via a shared guard; a genuine multi-statement query gets a clear *"Only one SQL statement is allowed — remove extra semicolons"* instead of a raw stack trace.
- **A node that keeps erroring now stops.** The loop-breaker also trips after several *consecutive tool errors from the same tool* (not only identical calls), so a run can't burn its budget thrashing on slightly-varied bad SQL — it breaks to a graceful final answer and hands off.
- **"DENIED" now means denied.** A bad-SQL/execution failure was mislabeled as a policy denial. Node/step status now distinguishes **`error`** (execution — e.g. a Trino syntax error) from **`denied`** (a real OPA/grant denial), so the run view stops implying a permissions problem when there isn't one.
- **Run asks what you want done.** The Run panel now has a *"What should the team do?"* prompt; an empty box uses a real, purpose-derived task instead of the old literal `"Test invocation"` default that made the recommender no-op.
- **The "team, step by step" is legible.** Consecutive repeated tool rows collapse (34 error rows → one `query_data ×34` line), each agent shows a calm correct status, the **Final Output** is a clearly-separated markdown panel, and a one-line summary up top says whether the run *"Completed through … → END"*, stopped at the step cap, or failed — so you can tell at a glance if it worked.

## [os-ui 0.1.79] — 2026-07-11

### Fix — agent loop-breaker (the platform now stops degenerate re-query loops)
- **An agent that re-fires the identical tool call no longer loops forever.** A node could get stuck ("I have the data, now I'll compute it manually…") re-running the *same* `query_data` every turn, re-appending the full result each time — ballooning context to ~60k tokens and consuming its whole step budget without ever handing off. The ACT loop now **deduplicates identical tool calls**: the first runs normally (OPA-gated as always), and each exact repeat is **not re-executed** — the agent gets a short "you already have this result above; compute and continue" note (progressively firmer), which keeps context bounded. After a small repeated-call budget the node **breaks to a graceful final answer and hands off** instead of thrashing. General harness hardening — it protects every agent a builder creates, not just the seeded example. Also nudges team agents to aggregate in a single SQL query rather than fetch raw rows to "compute manually."

## [os-ui 0.1.78] — 2026-07-11

### Fix — multi-agent handoff carries the full teammate result; more step headroom
- **A teammate's result is no longer truncated in the handoff.** The inter-node handoff compacted a prior node's row-set to its first 5 rows, so a recommender receiving an evaluator's multi-campaign scorecard saw only the head and re-queried the rest — exhausting its step budget. The handoff now keeps up to **60 rows** whole (still bounded by the overall handoff budget), so a downstream node reasons over the complete scorecard instead of re-deriving it. (A proper embedding-driven context curator — the "Context Librarian" — will supersede this heuristic.)
- **More step headroom.** Single-agent runs `assistantMaxSteps` 20 → **30**; team-run per-node `agentTeamNodeMaxSteps` 40 → **60** (both still env-overridable; the runaway cap remains finite).

## [os-ui 0.1.77] — 2026-07-11

### Agents — Build & Run polish (observability + reliability)
- **Per-agent run drill-down.** Each agent node in a run is now expandable — click it to see its **input** (the handoff context / role prompt it received), its **output**, its **status** (ok/failed/denied), and each tool call's **args → result**. The per-node cards now also **persist across a tab-switch** (previously a reseed fell back to a flat call table).
- **Team runs get a higher step cap.** A single analytical node (an evaluator scoring N campaigns, a recommender reasoning over a full scorecard) legitimately needs more than the single-agent one-shot cap of 20. Team runs now use `agentTeamNodeMaxSteps` (env `AGENT_TEAM_NODE_MAX_STEPS`, default **40**). And when a node does hit the cap it now makes one final synthesis pass and returns its **best answer** with a soft cap note, instead of a bare "reached the step limit" stub.
- **Build: Langfuse check is "needs a run first," not a failure.** Before an agent's first run there is no trace to verify, so the observability row used to show ✗. It now shows a neutral **"needs a run first"** state that does not count against the build; it verifies ✓ once a run has produced a trace.

## [os-ui 0.1.76] — 2026-07-11

### Fix — multi-agent "Build & Run" is now observable and correct
- **Inter-node handoff no longer drops structured output (the real bug).** In a team graph (e.g. `performance_analyst → margin_analyst → evaluator → recommender`), each node's handoff was built from its *narration* (`finalText`) only — every node's **tool outputs** (`query_metric`/`query_data` rows, the evaluator's scorecard) were discarded, and the narration could be further truncated by the handoff budget. So the recommender asked the user for a scorecard it should have received. Now each node's handoff carries its narration **plus a compact rendering of its material tool results**, the most-recent node's block is **pinned against truncation** (packed newest→oldest), and a directive tells downstream nodes to **use prior data and never ask the user** for what a prior agent already produced.
- **Per-node observability.** The run response now returns, per node, a `status` (`ok`/`failed`/`denied`), its `finalText`, and each tool call with a one-line result summary — and the Run panel renders a node-by-node card list (status badge · output · tool calls) with a clearly delimited **Final output** section, so you can see what each agent did and what the result is.
- **Visible progress + no silent failure.** Pressing Run now immediately shows an animated "Running the team… `a → b → c → END`" banner. A node that throws is recorded as `failed` with its reason and returns the **partial** results up to that point, instead of aborting the whole run with an opaque 500.

## [os-ui 0.1.75] — 2026-07-11

### Fix — assistant answers now render as formatted markdown
- **Ask the OS and every "Talk to X" copilot rendered the model's markdown as RAW TEXT** (literal `**bold**`, `| tables |`, `### headings`) — there was no markdown renderer in the app at all. Added `react-markdown` + `remark-gfm` and a shared, safe `<Markdown>` component (raw-HTML off, links forced to `target=_blank rel=noopener`, wide tables scroll, house typography) used for assistant/copilot answers (user input stays plain).

### Fix — Talk to Data now returns real rows (and never lies about it)
- **Talk-to-Data answered about columns but never returned actual data.** Root cause: on any NL→SQL failure, the data grounding **silently swallowed the reason** and attached no evidence, so the copilot only saw the schema overview and reported "the context does not include actual data rows" — it couldn't even say a query was attempted. (The marts, the gold FQN `iceberg.<snake_domain>.gold_<slug>`, and the read principal were all verified correct.) Now: a successful query returns the real rows (presented as a compact markdown table); a failed query surfaces its honest `kind: message` so the copilot explains what happened and asks you to clarify — instead of denying the data exists.

## [os-ui 0.1.74] — 2026-07-10

### Feature — "Talk to…" Context Copilots (all 5 Context tabs)
- **A governed, read-only copilot on every Context tab** (Data · Knowledge · Files · Metrics · Connections). Each `Talk to X` panel assembles a DLS-scoped, metadata-driven overview of what *you* can see on that tab, runs the tab's existing governed retrieval **as the caller** (Data → NL→SQL over the lakehouse, Knowledge → knn retrieval, Files → file search; Metrics/Connections grounded on their catalog), packs it within the reasoning model's window via the **Context Assembler** (hard ceiling — no more 200K blow-ups), and answers with the reasoning model. New tab-module `lib/talk/` (contract-compliant) + `POST /api/talk/[tab]` (session-gated). Degrades honestly on retrieval/model failure — never fabricates.
- **Reasoning shown *separately* from the answer.** A dedicated reasoner keeps `reasoning_content` intact; the UI puts it behind a muted, collapsible "Show thinking" panel above the prominent answer, with real citation chips (only entitled ids, real deep links) and a collapsible "what ran" (SQL/retrieval) disclosure below.

### Fix
- **Pillar↔bet link is now two-way.** Linking a Big Bet to a Strategy pillar stamped only one side (`pillar.betIds`) and left `bet.pillarId` unset (and unlink didn't clear it); both directions now stay consistent.

### Infra
- **OpenSearch snapshot register Job is now a proper Helm hook** (`post-install,post-upgrade` + `before-hook-creation`), so it recreates cleanly on every `helm upgrade` instead of failing on the immutable-Job re-apply.
- **OpenSearch snapshot Jobs now actually run.** Both the register Job and the daily CronJob used `curlimages/curl` (named user `curl_user`) under `runAsNonRoot`, which the kubelet can't verify without a numeric uid → `CreateContainerConfigError` (the manual `#112` snapshot test passed, but the *automated* Jobs never started). Pinned `runAsUser/runAsGroup/fsGroup: 100` so the container starts and can write the snapshot-repo PVC.

## [os-ui 0.1.73] — 2026-07-10

### Infra
- **OpenSearch Backup & Restore now works.** The cluster had no snapshot repository (and couldn't register one — no `repository-s3` plugin, no `path.repo`). Added `path.repo` + a dedicated 20Gi snapshot PVC, an idempotent `register-opensearch-snapshot-repo` Job (fs repo `sovereign-fs`), and a daily 03:00 snapshot CronJob (gated on `opensearchSnapshots.enabled`, on for STACKIT). *(Deploying it rolls the OpenSearch StatefulSet once so the snapshot volume + `path.repo` take effect.)*
- **App image pull from the in-cluster Forgejo registry fixed** (node-level): a small additive DaemonSet configures each node's containerd to resolve `forgejo-http` + use plain HTTP for that one registry — so OS-built apps (e.g. the Campaign Manager) actually deploy instead of `ImagePullBackOff`.

### Refactor (Phase 2)
- **Tab-loose files consolidated into their modules** (per `ARCHITECTURE.md`): `apps.ts`→software · `governance.ts`/`approvals.ts`→governance · `platform*.ts`/`users.ts`/`recovery.ts`/`terminal-session.ts`→platform-admin · `gateway-usage.ts`→monitoring · `agent-*.ts`→agents · `data-handoff.ts`→data · `planning.ts`→strategy. 15 history-preserving `git mv`s; behavior identical (1857 tests). The `lib/` root is now essentially free of tab-loose files (only the two client hooks remain for Phase 3).

## [os-ui 0.1.72] — 2026-07-10

### Governance / OPA (the definitive flip-flop fix)
- **Fix (the recurring `query_data`/`retrieve` OPA-deny "flip-flop") — root-caused and made durable.** The chart seeds `data.grants` with **bare** principal keys, but os-ui's policy-compiler publishes at runtime via `PUT /v1/data/grants` with **`domain:`/`user:`-prefixed** keys — and a PUT is a *full-document replace*, so publishing **wiped the chart's bare seed**, after which `authz.rego`'s bare lookup missed → deny (until the next OPA restart re-read the seed → allow: the nondeterministic flip-flop). Now the chart seed lives at a **disjoint `seed_grants` path** (the runtime PUT to `data.grants` can never clobber it) and **`authz.rego` unions both documents**, resolving each principal under bare + `domain:` + `user:` forms. Fail-closed preserved. Verified with the real `opa` CLI (9/9 authz + 29/29 full policy suite). *(Also on the chart: OPA `--watch` + a complete `checksum/policy` annotation so a grant change reloads deterministically.)*

### Refactor (Phase 1b)
- **`lib/core` + `lib/infra` carved out** of the loose `lib/*.ts` files, per `ARCHITECTURE.md`: 48 files moved (history-preserving `git mv`) into `lib/core/` (config · session · auth · scopes · lifecycle · versioning · artifact-model · tabs · …) and `lib/infra/` (governed spine + clients: governed · agent-governed · os-mirror · secrets · k8s · …), 414 importers rewritten. Pure structural change — behavior identical (1857 tests unchanged). Establishes the one-way `tab → infra → core` dependency layering.

## [os-ui 0.1.71] — 2026-07-10

### Agents / context (the 200K fix)
- **Context Assembler** — a first-class, budget-aware context builder (`lib/infra/context/`) with a model-context registry (per-model window + reserved output, admin/env-overridable), tool-result **compaction** (row-sets → header + sample + "…N more", long text → head/tail), and a greedy pinned-first pack that **guarantees the prompt never exceeds the model window**. Wired into the single-agent harness, the multi-node graph handoff (assembled summary, not the full transcript), **and Ask the OS**. Fixes the `ContextWindowExceededError` (200K) agent-run failures. Ships with an embedding-relevance seam for Phase 2.
- **Agent data discovery** — an agent granted `query_data` now auto-gets `list_datasets`/`get_dataset`/`profile_dataset` (and knowledge/files equivalents), plus a "discover-before-you-act, never guess identifiers" directive, so agents resolve real FQNs instead of hallucinating table names.
- **Stale-FQN defense** — the ACT prompt now treats any table name in an agent's stored instructions as possibly stale and re-resolves to the current domain-gold FQN (a promoted dataset lives at `iceberg.<domain>.gold_<slug>`, never the owner's `personal_<uid>` lane).
- **Workspace default routing** now offers only **Standard / Reasoning** (the live admin role models), not the raw LiteLLM catalog.
- **Build/Run persistence** — a persisted activity marker + last-run report, so returning to the Agents tab shows "building/running…" or the last outcome instead of a blank slate.

### Knowledge
- **Tacit knowledge over MCP** — `author_knowledge` now takes per-step **and** workflow-level (`TACIT.md`) `tacit`; the knowledge guide (which described a non-existent `type`/`body`/`actors` API) is rewritten to the real tool.
- **Markdown-only knowledge is retrievable** — the chunker now chunks the workflow's prose body into citable units (previously prose-only workflows indexed 0 units).
- Knowledge tab sub-area **"Knowledge" → "General"** (siblings: General + Workflows).

### Data / Nav
- **Data tab: "Talk to Data"** replaces the raw Query-the-Lakehouse SQL editor (raw SQL lives in the Admin **Query** console); NL question → governed `/api/data/ask` → answer + results + the SQL it ran.
- **Users & Access** now lives only under **Admin** (removed the duplicate from Governance).

### Refactor (Phase 1a)
- **Connections** consolidated into `lib/connections/` as the reference **tab-module** (index/schema/store/README) per the new `ARCHITECTURE.md` contract.

## [os-ui 0.1.70] — 2026-07-09

Agent data-plane hardening — from a live end-to-end test of an agent reading/writing data, files, and knowledge through Trino/dbt/OPA.

### Governance / OPA (the recurring `query_data` deny — root-caused + fixed)
- **OPA no longer serves stale grants.** OPA loaded `/policies/data.json` once at boot with no reload and the Deployment's checksum annotation omitted `requiresApproval` — so a grant change (e.g. the cohort's `query`/`retrieve`) could silently never take effect, denying `query_data`/`search_knowledge` until a manual restart (the "flip-flop"). Now: the checksum annotation covers all policy/data fields **and** OPA runs with `--watch` (hot-reload). *(Live-confirmed: after reload, `query_data` returns rows and the cohort grant is present.)*
- **Fix (knowledge retrieval always denied):** `search_knowledge`/`retrieve` authorized on the **user id** instead of the **domain** (grants are domain-keyed), so it fell to an empty offline mock for everyone. Now gates on the domain principal, exactly like `query_data`.

### Agents
- **Reliable tool-calling on gpt-oss.** The worker model (`gpt-oss-20b`, OpenAI "harmony" format) leaked channel control tokens into tool names (`query_data<|channel|>commentary`) → intermittent tool errors that exhausted the agent's step budget. The tool-call parser now **strips harmony tokens** and **recovers commentary-channel tool calls**, and agent tool-calling routes to a new **admin-configurable `tools` model role** (defaults to the Qwen tier for native tool-calls; `LITELLM_TOOLS_MODEL` / Admin settings override).

### Data / Metrics (Cube)
- **Promotion is fail-closed.** Publishing a dataset to a domain asset now **independently verifies the physical gold materialized in the domain schema** before flipping the tier (502, tier untouched, if absent) — no more "promoted" assets whose gold only exists in the owner's personal lane. Added a governed **re-materialize/repair** path for an already-promoted-but-missing asset.
- **Cube fixes:** defining a metric requires a **promoted (domain-schema) gold** with a clear "promote to Shared first" message (a cube can only read the domain schema its `cube-sales` principal is entitled to); cube dimensions/`drill_members` are **reconciled to real mart columns** (can't reference a missing column like `region`); and the **Metrics tab is fail-soft** — one broken model renders an inline "unavailable" tile instead of 500-ing the whole tab.

### Infra
- **ClickHouse (Langfuse) is PVC-backed** with a `wait-for-clickhouse` init-container gating langfuse-web, so trace-schema migrations always run against a ready CH across redeploys. *(Deployed in 0.1.69; PVC live.)*

## [os-ui 0.1.69] — 2026-07-09

### Navigation / access
- **Menu now hides what a role can't use.** `LLM Gateway`, `Monitoring`, and the `MCP` setup tab are **builder+/admin only** (hidden from creators/students). Creators still connect over MCP — the `/api/mcp` endpoint + their per-user token are unaffected; only the configuration tab is hidden. (Governance was already builder+, and Admin/Components/Terminal/Query/About already admin-only.)
- **New Admin "Query" console** (Admin → Terminal → **Query** → About) — dual-mode **Lakehouse SQL + Cube** console for admins, over the governed read path (admin-scoped, 403 for non-admins).
- **Rename:** the visibility label **"Shared" → "Shared in Domain"** across every tab (scope switcher, badges, tiles) — internal keys/enums unchanged.

### Data (detail rework)
- **Removed the confusing "Advanced Build Rail."** Everything is now inline on one screen with section-level **Edit** (Documentation, Data quality, Metrics, Bring-in-data/Bronze, Configuration/dbt SQL). The three primary actions — **Turn into Silver · Turn into Gold · Archive** — moved to a single **action row at the bottom**.

### Strategy
- **Strategic-pillar headline target.** Each pillar now shows a **big target number** tied to a value-metric type — **EBIT · Revenue · Time Back Hours · # Risks Mitigated · Custom** (user-named, with an optional unit + monetary flag) — and a smaller **"so far: …"** achieved-to-date figure below it, with a subtle on-track/behind cue. Targets carry a **horizon** (year-end · 6 · 12 · 24 · 36-month) that computes a clear **end date** (default: year-end of the current calendar year). Only Builder/Admin set targets; creators view. New MCP tool `set_pillar_target` keeps agents in lockstep.
- **Currency is a tenant Admin setting** (EUR/CHF/USD + other ISO currencies), applied to monetary metrics only (Hours → `h`, Risks → integer count) — the Strategy tab never picks currency locally.

### Governance / Admin
- **Fix (User & Access edit):** the Platform Admin users surface had **no edit form** — only deactivate/reactivate/tenant-admin. Added an edit panel + `edit` op so an admin can change a user's **name/email/role/domains** and have it persist to the `os-users` mirror (admin-gated).

### Versioning
- **Software** version history is now **git-backed** — the app's Forgejo commit log is the version list, and *restore* re-commits a prior commit's files onto HEAD as a new auditable commit (non-destructive, governed). Version panel now shown on Software detail.
- **Data** datasets (no per-dataset repo) get an **append-only snapshot history** — each edit snapshots the prior `dataset.yaml`; restore is reversible. Version panel now shown on Dataset detail.
- **Knowledge:** a creator on a live + Shared **workflow** can now file **Request certification** (Marketplace rung) — admin-gated, no self-publish. (Personal-knowledge promote ladder already existed.)

### LLM Gateway
- **Fix (usage showed 0 requests / 0 tokens):** the usage panel called LiteLLM `/global/activity` **without a date range** (a bare call 400s) and read a `sum_*` shape this LiteLLM version doesn't return. Now passes a rolling 30-day window and sums the `daily_data[]` rollup (keeps `sum_*` back-compat) — real tenant totals show again.
- **Fix (Model Hub blank `[]`):** replaced the iframe to LiteLLM's empty `/public/model_hub` with an **OS-native model list** rendered from `/v1/models` (server-side, key-free) — the brokered models always show.

### Durability (infra)
- **Langfuse ClickHouse hardening.** ClickHouse was `emptyDir` (a pod/node roll wiped all trace tables); it is now **PVC-backed** (10Gi) on STACKIT. Added a `wait-for-clickhouse` **initContainer** on langfuse-web that polls CH `/ping` before the web container starts, so the schema migration always runs against a ready ClickHouse on every redeploy — no manual web-pod bounce. *(Enabling the PVC on an existing cluster needs a one-time `kubectl delete deployment clickhouse`.)*

## [os-ui 0.1.68] — 2026-07-09

### Agents / Governance (durability fix)
- **Fix (agent `query_data` flip-flop):** an agent-run's tool grants (`os-<systemId>` principal) lived only in an **in-memory registry** set at build time, so every os-ui pod restart (any redeploy) wiped them and the agent lost `query_data`/`query` until it was rebuilt — the recurring "works today, denied tomorrow" OPA-deny. The governed-tool endpoint (`/api/agents/tool`) now **lazily rehydrates a principal's grants from the persisted agent record** (the durable `os-agent-systems` mirror) on the first cold-start request, reproducing the exact Build grant vocabulary. **Fail-closed:** a missing/corrupt record grants nothing and falls through to OPA-deny; rehydration never broadens a grant. (App-MCP `app-<slug>` principals already self-healed via `rehydrateConnection`.) *(6 new fail-closed tests.)*

### Connections
- **Consolidated the three Connections sub-tabs into one screen** (matching Data/Metrics): existing connections grouped **All · My · Shared · Marketplace** at the top (with counts + source-domain tags), the **new-connection** flow below, then App-MCP connections, the connector catalog, and outbound access. Tile Open-only lifecycle preserved.

### LLM Gateway (STACKIT)
- **Fix (`sovereign-default` 404):** STACKIT's model id keeps its org prefix (`openai/gpt-oss-20b`); LiteLLM strips the first path segment as the provider, so it was sending bare `gpt-oss-20b` upstream → STACKIT 404 ("no fallback model group"). Model refs now doubled to `openai/openai/gpt-oss-20b`. *(Live-verified: `sovereign-default` + `sovereign-reasoning` return 200 through the gateway.)*

## [os-ui 0.1.67] — 2026-07-09

### Metrics / Cube
- **Fix (Cube 500):** generated Cube **view names contained spaces** (invalid Cube identifier) → the whole schema failed to compile and the Metrics tab 500'd. `cubeViewName` now emits a valid identifier; the gold→Cube scaffold also **skips a dimension whose name collides with a measure** ("defined more than once"). *(Live-verified: cube `/meta` returns 200.)*
- Removed a leftover demo **"Query" panel hardcoded to `daily_revenue`** (the phantom metric users never defined); the governed metric registry is the metric surface. `daily_revenue` stays in Cube (Superset + sales-agent depend on it).

### Nav
- **Marketplace** moved to the top entry row (after Cockpit), out of the Context section.

## [os-ui 0.1.63–0.1.66 · query-tool 0.4.1] — 2026-07-09

### Data
- Radically simplified **Bronze→Silver→Gold** refinement: two guided CTAs ("Turn into clean Silver Dataset" / "Turn into a harmonized Gold dataset"), key **auto-match + adapt** (text-normalize / cast reconcile), a **visual join graph**, and Bronze can no longer be promoted to Shared. Dataset preview auto-loads on detail open. **DuckDB removed** from the stack (Trino-only; docs + PDF updated).
- **Fix (query_data):** the `query_data` handler ran Trino as the caller's *first domain*, so a user was denied on their own `personal_<uid>` schema — now uses the uid for the owner's personal lane (cross-user isolation intact). *(os-ui 0.1.66; live-verified: owner reads own rows, others denied.)*
- **Fix (promotion):** the query-tool write guard compared the underscore schema to the dash domain → 403 on hyphenated-domain mart writes — now `sanitize_ident`s the domain. *(query-tool 0.4.1.)*

### Metrics
- Guided **Cube.js metric editor** (count/count-distinct[-approx]/sum/avg/min/max, ratio/derived, filtered measures, rolling/running windows, format, drill members, time granularity) with **live preview**.

### Nav / UX
- **5-section sidebar** (Plan · Context · Build · Monitor · Admin; Governance→Admin, Admin-first); standalone Settings tab removed. Shared-count badge counts promoted items.
- **Fix:** knowledge workflow detail crashed (`useConfirm` outside `ConfirmProvider`) — `WorkflowView` now self-wraps. *(os-ui 0.1.66.)*

### Admin / platform
- Domains **rename** control; dead **Spark toggle removed** (ML kept). Components status fixes; Sample-RAG entry + Seed-demo-queue button removed.
- Software: app creation now seeds a **real build→push CI workflow** + `REGISTRY_PASS` (fixes the app-image / UI-button pipeline for new apps).
- **Langfuse** ClickHouse schema migrated — traces persist. LiteLLM restored to the STACKIT 3-tier runtime (`sovereign-default` → gpt-oss-20b).

### MCP + Ask-the-OS
- MCP `build_gold_join` key-adapt + `define_metric` rich measures; guides/prompts + Ask-the-OS context brought to UI parity.

## [os-ui 0.1.62] — 2026-07-08

The deployed **os-ui image** carries its own version line (`osUI.image.tag` in
`values.stackit-selfhosted.yaml`). 0.1.62 is the STACKIT three-tier models +
embeddings migration + OS-wide lifecycle UX + Data/Metrics consolidation release,
live on the STACKIT tenant.

### Models & inference

- **STACKIT three-tier model set, admin-configurable.** All in-cluster Mistral
  model workloads (**Ministral** and **Magistral**) and the **model-server**
  component are **deleted** — all inference is STACKIT-managed, so no local model
  weights sit on the node disk.
  - **Standard / worker** — `openai/gpt-oss-20b` (`sovereign-default`)
  - **Reasoning** — `Qwen/Qwen3-VL-235B-A22B-Instruct-FP8` (`sovereign-reasoning`)
  - **Embeddings** — `Qwen/Qwen3-VL-Embedding-8B` (`sovereign-embed`), **4096-dim**
- **Models & Providers admin page** unified to a single live-sourced store. Each
  role (standard / reasoning / embeddings) is independently configurable by an
  Administrator; the catalog is sourced live from the LiteLLM gateway (generic /
  open-source — operators register their own models; the three above are helm
  defaults). Replaces the former split "Models" + "Providers" pages.
- **Agent builder** now offers only **Auto / Standard / Reasoning** — the
  embeddings tier is infrastructure-only, not a user-facing model choice.

### Embeddings migration

- **4096-dim embeddings** replace the prior 384-dim mock. OpenSearch knowledge
  and files indices recreated; `KNOWLEDGE_EMBED_DIM` and `FILES_EMBED_DIM` are
  wired from `retrieval.knnDimension` in the chart.

### OS-wide lifecycle UX

- **Artifact tiles show only "Open".** Archive / Restore and Version history live
  inside the opened detail view. **Delete** is surfaced only on already-archived
  items. Applied consistently across every tab.
- **Show-archived** reveals archived items in each tab's detail lists so Delete
  remains reachable without cluttering the working view.

### Data + Metrics tabs

- **Collapsed to a single screen** — subtabs removed; the query sandbox sits below
  the dataset / metric tiles on one page.
- **Dataset detail** gained a governed **"Preview first 50 rows"** section
  (DLS-filtered; never fabricated).

### Knowledge tab

- Prominent **"New knowledge"** action and My-knowledge focal view.
- **Full Personal → Domain → Marketplace promotion** via the governance ladder.
- **Git-backed versioning** for personal knowledge items.

### Provenance tags

- **Source-domain tags** appear on every artifact shown in Shared or Marketplace
  scope (all tabs), making same-named artifacts from different domains unambiguous.

### Sidebar restructured

- **5 named sections:** Plan / Context / Build / Monitor / Admin (was a flat
  business-tabs list + a Platform group).

### Components tab & Governance

- **Postgres** now detected via StatefulSet fallback (fixes false-negative status).
- **dbt** status shows `"on-demand"` (was incorrectly red).
- **Sample RAG agent** removed from the component registry.
- **"Seed demo queue"** button removed from the Governance page.

### Software delivery pipeline

- **`appImageRef`** now serves the real CI-published image (was the whoami
  placeholder).
- **`ci-runner` pod** gains `fsGroup: 1000` so it can register its runner,
  fixing the `CrashLoopBackOff` that blocked pipeline runs.

### User & Access

- Edit path regression-tested — **6 new route tests** covering the User & Access
  edit flow.

## [os-ui 0.1.32] — 2026-07-05

The deployed **os-ui image** carries its own version line (`osUI.image.tag` in
`values.stackit-selfhosted.yaml`), independent of the chart/app semver. 0.1.32
is the durability + 4-role release, live on the STACKIT tenant.

### Added

- **DURABILITY: one shared OpenSearch mirror behind every user-facing store**
  (`os-ui/lib/os-mirror.ts`). Approvals, audit, artifacts, apps, agent systems
  (incl. `AGENT.md`/`MEMORY.md`), datasets, knowledge, files, dashboards, big
  bets, users, domains, marketplace, pillars, prefs and role-config all
  write-through to OpenSearch and hydrate on boot — **artifacts survive
  redeploys and node-rolls**. Root cause fixed once, centrally: the old
  per-store probe treated a missing index (404 on a fresh cluster) as "mirror
  down forever", so the index was never created and every pod roll wiped state;
  the shared core creates the index on 404, never throws into a request, and
  lazily re-probes/self-heals. Requires the OpenSearch PVC
  (`deploy/opensearch-pvc-migration.sh` migrates a live cluster). See
  `docs/decisions/0003-durability-os-mirror.md`.
- **Data M1 — the Data golden path is physical end to end**: upload → a real
  Bronze Iceberg table in a per-user schema (`iceberg.personal_<uid>`) →
  Explore → Silver → Gold join → **publish-on-approval** (the Builder's
  approval runs the physical publish; the tier flips only on ✓) → Cube →
  **Talk to your data v2** (governed NL→SQL: canView-scoped schema context, one
  validated read-only SELECT, executed through governed Trino under the
  caller's row filters/masks, grounded answers). Live Iceberg writes verified
  on **Polaris 1.1.0-incubating**.
- **MCP Waves A + B**: the physical pipeline tools (`ingest_dataset`,
  `transform_silver`, `build_gold_join`, `profile_dataset`), the sharing-ladder
  split (`request_promotion` owner-filed / `approve_promotion` Builder-applied),
  `query_metric`, `run_agent_system`, Science reads (`list_models`/`get_model`),
  Big Bet updates, Connections tools, and read-back parity (`list_*`/`get_*`
  for every buildable artifact) — ~55 governed tools total. Internal Agent-tab
  systems dispatch through the **same governed toolset** under their owner's
  identity (`lib/agents/build/os-tools.ts`) — front door, no back door
  (`docs/decisions/0005-mcp-front-door-invariant.md`).
- **Backups Tier 0–2** documented and wired: nightly `pg-dump` CronJob, nightly
  Velero off-cluster volume backups, and the standing pre-upgrade backup gate
  (`deploy/pre-upgrade-backup.sh`); honest gap list in `docs/backups.md`,
  drills in `docs/runbooks/restore-drill.md`
  (`docs/decisions/0004-backups-tiers.md`).
- **SECURITY / role model: 4 ranks** — `creator (0) < builder (1) < domain_admin (2) < admin (3)`.
  The new **`domain_admin`** role carries every Builder capability PLUS (a) user
  administration scoped to their OWN domain(s) only — invite, edit, deactivate/
  reactivate, and role assignment **up to builder** (never `domain_admin` or
  `admin`; only the platform Admin appoints domain admins) — and (b) all
  domain-scoped governance approvals (incl. within-domain cost caps). Enforced
  server-side per call in `/api/governance/users` via new pure predicates in
  `lib/governance/roles.ts` (`canAdministerUsers` floor, `userAdminInScope`
  domains-subset rule, `canTouchUser` no-lateral/no-upward), every mutation
  audited with the actor. Builders are approvers, NOT people-admins (user admin
  moved from builder → domain_admin). Tenant powers (strategy pillars,
  cross-domain bets, marketplace certification, the whole Platform group, cost
  caps, role matrix, models, domains) stay platform-admin-only; the Platform
  Users tab keeps its 0.1.31 admin-only gating. Legacy/unknown stored roles
  still normalise to `creator`; nobody is auto-promoted. Builder-floor gates
  across the OS now compare by rank (`roleAtLeast`), so `domain_admin` inherits
  every Builder surface, incl. the 6 builder-floor MCP tools; `whoami`,
  `list_capabilities`, the MCP orientation and prompt role-banners describe all
  4 roles. The `/platform/roles` matrix gains a Domain admin column
  (`manage @ governance` = memberships + domain user-admin); the admin
  never-locked-out invariant is unchanged. See
  `docs/decisions/0001-four-rank-roles.md` and
  `docs/decisions/0002-sharing-ladder.md`.

### Changed

- **Nav consolidation**: Tutorials moved into the main tab group; **Governance**
  tops the Platform group at **builder+** (Domain admins included by rank); the
  remaining Platform entries (Admin, Components, Terminal, About/Licenses) are
  admin-only; the **Workbench tab is retired** from the sidebar (the workload
  stays chart-optional; old routes redirect).
- **Console UX**: the Terminal auto-connects on open and re-attaches to a live
  session across navigation; Dagster's public ingress now requires operator
  basic-auth (`ingress.dagsterBasicAuthSecret`) since Dagster OSS ships no
  login of its own.

### Documentation

- OS guide refreshed to the current architecture (sharing ladder, physical Data
  path, MCP surface, durability, tab map) + regenerated PDF; new ADRs in
  `docs/decisions/`; new runbooks `docs/runbooks/helm-upgrade.md` (pre-upgrade
  backup rule + the ClickHouse SSA `--force-conflicts` recovery) and
  `docs/runbooks/deploy-os-ui.md` (the image-only update path).

## [0.2.0-alpha.11] — 2026-06-30

Headline: **documented STACKIT sizing & capacity recommendations** learned from
the live deploy — the node disk holds container images + local model weights and
is fixed; real data scales independently on object storage / PVCs.

### Changed

- **Node disk default 200 GB.** `node_volume_size_gb` (Terraform) now defaults to
  200 (was 50), with a comment explaining the disk holds container IMAGES + local
  MODEL weights (all Layer 1–4 images ~40–60 GB + the in-box model), NOT user
  data. 80 GB filled during deploy → disk-pressure → node cordoned → pods
  unschedulable; 200 GB is the verified floor. Mirrored in
  `terraform.tfvars.example`.

### Documentation

- **Sizing & capacity guidance.** New "Sizing & capacity" subsection in the OS
  guide (+ regenerated PDF) and a deploy README note: a small RAM / node-disk /
  data-storage table clarifying what each is for and how it scales. Key facts:
  STACKIT `m3i.16` = 16 vCPU / 128 GB RAM (ran ~2–4%); the node disk is FIXED and
  does NOT grow with the dataset; real DATA lives on independently-scalable
  storage (Iceberg lakehouse on object storage — in-cluster MinIO for the demo →
  STACKIT Object Storage / S3 for TB-scale — plus PVCs for OpenSearch, Postgres,
  ClickHouse, MLflow). Don't confuse node RAM (128 GB) with node disk.

## [0.2.0-alpha.10] — 2026-06-30

Headline: **the live platform** — every tab reworked to Apple-grade simplicity,
real Microsoft Graph + SMTP mailer, the full Layer 1–4 stack deployed and
green on STACKIT, a reworked Apple-grade user guide + PDF, and the Northpeak
e-commerce seed running live across all tabs.

### Added

- **Home / Cockpit split.** Home is now a welcoming entry point; Cockpit is the
  at-a-glance operational overview. Navigation restructured to match.
- **Microsoft Graph + SMTP pluggable mailer.** Microsoft Graph is the preferred
  delivery path (OAuth 2.0 client-credentials); SMTP is the automatic fallback.
  Auth onboarding works without email (SMTP optional, verification skipped when
  unconfigured).
- **Full Layer 1–4 self-hosted overlay for STACKIT.** Everything-on deploy
  brings up Trino, Cube, Dagster (dbt-trino adapter), Workbench, Terminal,
  Forgejo, MLflow, KServe, ml-agent, and JupyterHub in one overlay.
  Five re-upgrade issues resolved; Layer 4 gated on `ml.enabled`.
- **Northpeak e-commerce seed (aligned).** Fictional Northpeak case-study seed
  updated to match the reworked Big Bets and Strategy APIs; runs live across
  all 16 tabs for the capstone teaching demo.
- **Reworked Apple-grade user guide + PDF.** Full guide rewritten with Apple
  design philosophy — complexity hidden behind elegant surfaces, every section
  covers a real tab end-to-end.

### Changed

- **Strategy tab → 3 sections.** Pillars as centerpiece; full-screen bet detail
  replaces the old drawer pattern. Big Bets reworked: create / portfolio /
  detail flow.
- **Agents tab → one page.** Collapsed to a single operational view; Mine
  relabelled **Personal**, My Domain relabelled dynamically to the tenant name.
- **Software tab → chat-centric one-pager.** Four-step flow: one page → create
  → build → monitor, with Forgejo and Claude-chat wired in.
- **Platform-section scoping.** Platform internals (governance, infra config,
  admin) moved to the Platform tab; user-facing tabs stay focused on work.
- **Knowledge tab → vertical workflow flow.** Ingest → enrich → retrieve →
  publish flow replaces the flat layout; nav reorder puts Knowledge in context.
- **Data and Personal labels.** "Data" label clarifies data-plane tabs; personal
  workspace relabelled for consistency across the UI.
- **Graceful degradation.** `FORGEJO_PASSWORD` is now optional; os-ui boots
  cleanly when Forgejo is disabled or unconfigured.
- **Sales Assistant removed.** ACME worked-example removed; `listModels()` is
  now RLS-scoped.
- **ml-agent startupProbe + Harbor image fix.** Blocking warmup no longer kills
  liveness; Harbor image reference corrected to a pullable tag.

## [0.2.0-alpha.9] — 2026-06-30

Headline: **the full platform** — every workspace tab is now integrated and real
authentication replaces the mock/fake-user auth. On top of the alpha.8 Agents
tab + governed Trino + live agent-runtime + local reasoning tier, this release
brings up all sixteen tabs as one consolidated, OPA-governed surface, secured by
real scrypt-hashed credentials and a secure first-run bootstrap. **636 tests.**

### Added

- **All 16 tabs integrated.** The OS UI is now the full platform — **Data,
  Files, Knowledge, Connections, Software, Metrics, Dashboards, Science,
  Marketplace, Monitoring, Governance, Strategy, Big Bets, Home, Tutorials,**
  and **Platform Admin** — consolidated onto `main` on top of the alpha.8
  **Agents** tab, governed **Trino** query engine, **live agent-runtime**, and
  **local reasoning** tier. Cross-tab seams are **OPA-governed**: every
  cross-surface read/write is routed through policy, so a capability granted in
  one tab does not silently leak into another.
- **Real authentication.** The mock/fake-user auth is **replaced** with real
  credentials: **scrypt-hashed** passwords, a **secure first-run admin
  bootstrap** (one-time bootstrap token → **forced email + password** on first
  sign-in → the bootstrap credential **auto-deletes**), **master-key recovery**
  for locked-out admins, and an **onboarding wizard** for first-run setup. No
  fake user, no default password.

### Changed

- **Mock auth → real auth across the OS UI.** Sign-in, session, and the
  auth/me/login/logout routes now authenticate against real, hashed credentials
  with the secure bootstrap/recovery flow above, replacing the alpha.1
  teaching-mode mock user.

## [0.2.0-alpha.8] — 2026-06-29

Headline: the **consolidation release** — agents now **execute for real**. This
folds together the central governed query engine, a **live agent-runtime** that
replaces the alpha.6 in-process mocks, a **local reasoning tier**, and a
**two-local-Mistral** model default — all on the alpha.7 governance fixes.

### Added

- **Central governed Trino + a DuckDB personal/sandbox lane.** A central,
  policy-governed **Trino** query engine is the shared analytics plane (every
  query routed through the governed spine), with **DuckDB** providing the
  fast, embedded **personal / sandbox** lane for individual exploration that
  never touches the shared engine.
- **Live agent-runtime + 5 live BuildAdapters.** The Agents tab no longer runs
  against in-process mocks (alpha.6): a **live agent-runtime** with **five live
  BuildAdapters** means agents **execute for real**, fully governed —
  model/connection/tool calls routed **LiteLLM → OPA → Langfuse**, **Cilium
  default-deny egress** on agent workloads, and **CronJob**-backed schedules for
  scheduled systems.
- **Local Magistral 24B reasoning tier.** A self-hosted **Magistral 24B**
  reasoning model served on **llama.cpp** (capped at **6 cores**) adds an in-box
  reasoning tier — no provider key, fully offline.

### Changed

- **Default model routing → two local Mistral models.** The default is now
  **two-local-Mistral**: the **reasoning** tier resolves to the local
  **Magistral 24B** and the **fallback/light** tier to the **in-box Ministral**,
  with **STACKIT off by default**. The stack's default reasoning + chat path is
  now fully self-hosted and permissive out of the box.

### Fixed

- Consolidated the **alpha.7 governance/authorization fixes** (the six Agents-tab
  view-vs-edit / read-only-authorizes-write / disabled-agents-still-run /
  phantom-handoff / Marketplace double-list findings) into this release.

## [0.2.0-alpha.7] — 2026-06-29

### Fixed

- **Agents tab — fixed 6 governance/authorization findings from code review**
  (view-vs-edit auth on Run/Probe, read-only-authorizes-write,
  disabled-agents-still-run, phantom-handoff, Marketplace double-list).

## [0.2.0-alpha.6] — 2026-06-29

Headline: the new **Agents tab** — a three-level agent IDE for building, governing,
and running multi-agent systems entirely inside the OS UI.

### Added

- **Agents tab — three-level agent IDE.** Navigate **Systems → canvas → agent
  editor**: a list of agent systems, a per-system visual canvas (supervisor +
  members with derived routes), and a focused editor for each individual agent.
- **Dual-mode editing, one source of truth.** A drag/connect **SVG canvas**, a
  self-hosted **Monaco** text editor, and an **agent-system helper** (chat) all
  edit the *same* `system.yaml`, which is versioned in Forgejo. Edits made in any
  mode round-trip losslessly through the shared schema/compiler.
- **Build = execute + verify, with the governed-gateway invariant.** "Build" does
  not just generate config — it executes the compiled system and verifies it,
  with **every** model/connection/tool call routed through the governed gateway
  (no agent reaches a capability it was not granted).
- **Per-agent model picker** over the LiteLLM model list (light/reasoning/vision
  tiers), **grants & capability governance** (granted connections work;
  non-granted are blocked; writes are held for approval), **routing** rules,
  **run / schedule / toggle** at the system level, **fork-to-own**, and a
  **validation gate** that must pass before a system can build/run.

> **Note (honest scope):** in this release **Build executes against in-process
> mocks** (five mock Build adapters + a mock Forgejo-backed store). The
> live-service adapter implementations (real Forgejo, real model/connection
> backends) are a deliberate follow-up before real deployment.

## [0.2.0-alpha.5] — 2026-06-29

Headline: the **default light model is now Ministral 3 (3B, Apache-2.0)** — the
**only in-box self-hosted default**. The self-hosted default tier is now
**Apache-clean** and the model server is **right-sized** for the smaller weights.

### Changed

- **Default self-hosted model → Ministral 3 3B (Apache-2.0).** `modelServer.model`
  is now `ministral-3:3b-instruct-2512-q4_K_M` (~2.95 GB, verified against the
  Ollama library), serving the **light tier** (chat, coding, tool-selection).
  LiteLLM `sovereign-default` / `sovereign-mock` routes and
  `values.private.example.yaml` updated to match. Escalation/fallback tiers
  (optional bigger self-host, STACKIT premium/vision) are unchanged.
- **Model server right-sized.** `modelServer.resources` dropped from 5Gi/8Gi back
  to **3Gi req / 4Gi limit** to fit the ~3 GB Ministral 3 3B working set.

### Removed

- **No non-permissive model option ships in-box.** The previous non-permissive
  opt-in default alternative — and its license records — are removed. The
  self-hosted tier is now **Apache-2.0 only** (Ministral 3).

## [0.2.0-alpha.4] — 2026-06-29

Headline: the OS gains an **in-browser code editor** for Layer 3 apps, a
**self-hosted model-serving + routing** stack (self-hosted default + LiteLLM
fallback/cost-caps/rate-limits to STACKIT), and **experimental** in-UI
**terminal** and **domain-builder workbench** tabs (off by default).

### Added

- **In-browser code editor for Layer 3 apps (Monaco).** The Software golden path
  gains a **Code** panel beside the build assistant: a file tree of the app's
  Forgejo repo with a **Monaco** editor; Save commits back to Forgejo on `main`
  (CI → Harbor → Argo CD pick it up). Repo access is **Builder/Admin-gated**
  through a server route — no Forgejo URL/credential reaches the browser.
  - **Sovereignty / air-gap:** Monaco's `vs/` assets are **self-hosted from the
    app** (`public/monaco/vs`, generated at build time from the pinned
    `monaco-editor` dependency by `scripts/copy-monaco.mjs`) and the loader is
    pinned to the **same-origin** path `/monaco/vs`. **No CDN fetch** — the
    editor works fully offline.
- **Self-hosted model serving + routing.** New `model-server` component: a CPU
  OpenAI-compatible LLM runtime (**Ollama**, MIT) serving **Ministral 3 3B
  (`ministral-3:3b-instruct-2512-q4_K_M`, Apache-2.0)** as the **default chat
  backend**, replacing the mock LLM — fully offline, no provider key, **N
  replicas** behind LiteLLM load-balancing (`modelServer.replicas`). The mock
  model is retained for offline embeddings.
  - **License:** Ministral 3 ships under **Apache-2.0** (OSI-permissive). We ship
    only the Ollama engine; the weights are **pulled at runtime, not
    redistributed** (recorded `bundled=no` in `licenses/components.tsv`;
    documented in `NOTICE` + `THIRD-PARTY-LICENSES.md`). The self-hosted default
    is **Apache-clean**.
  - **LiteLLM router:** fallback chain (self-hosted Ministral 3 → optional bigger
    self-host → STACKIT last-resort), with retries, timeouts, circuit-breaking
    (`allowed_fails`/`cooldown_time`), and load-balancing. **STACKIT AI Model
    Serving** (`Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`) is wired as the
    **vision** route + **last-resort** only — never the default; key via
    **External Secrets**, with a dedicated **per-model spend cap** and per-key
    **rate limits** on the agent virtual key.
  - **Config alternatives/toggles:** swap the default model
    (`modelServer.model`); optional GPU **vLLM** bigger model
    (`modelServer.big.enabled`, off by default).
  - **Private overlay:** `values.private.yaml` (gitignored) registers extra
    self-hosted endpoints + extends the fallback chain without touching public
    defaults — see `values.private.example.yaml`.
- **Experimental — in-UI Terminal (off by default).** A sandboxed web terminal
  tab (`terminal.enabled=false`): xterm.js front-end + a token-brokered
  WebSocket to a locked-down `sandbox-shell` pod. **Prototype**, pending the
  design decisions in `docs/terminal-tab-design.md`. Not wired into the default
  deploy.
- **Experimental — domain-builder Workbench (off by default).** A code-server
  workbench tab (`workbench.enabled=false`) for domain builders, brokered through
  a session API to a per-user `code-server-workbench` pod. **Prototype**, pending
  the user's 7 open design decisions in `docs/workbench-tab-design.md §6`. Not
  wired into the default deploy.

### Changed

- **UI labels:** the **Structured Data** tab/page is now **“Data”** and
  **Unstructured Data** is now **“Files”** (display labels only; routes
  `/data` and `/unstructured`, type keys and internal identifiers are unchanged).

### Governance

- **Open-source Git governance.** Added `GOVERNANCE.md` (roles, lazy-consensus
  decision-making, how to become a maintainer, SemVer release process),
  `SECURITY.md` (private vulnerability reporting via GitHub Security Advisories +
  `security@datamasterclass.com`, coordinated disclosure), `.github/CODEOWNERS`
  (the `@Data-Masterclass/maintainers` team owns the tree), a pull-request
  template, and YAML issue forms (`bug_report.yml`, `feature_request.yml`,
  `config.yml` — blank issues disabled, security routed to advisories).
- **CI workflow** (`.github/workflows/ci.yml`) running on pull requests to `main`
  with stable, required-check job names: `build` (os-ui), `helm-lint`, and
  `secret-scan` (gitleaks); actions pinned to commit SHAs.
- **Branch protection** on `main` (public repo): PR required with 1 approval +
  CODEOWNERS review + green CI, **signed commits required**, linear history, and
  admin self-merge bypass for the sole maintainer.

## [0.2.0-alpha.3] — 2026-06-29

Headline: a **clean deploy now brings the agents up green on its own** — the
LiteLLM schema is migrated and the scoped agent key registered without relying
on Helm/Argo hooks — plus the public console links, a stable ingress IP, and a
ClickHouse OOM fix from the live STACKIT shakedown.

### Fixed

- **Agent-Core clean-deploy fix — agents come up green without `--no-hooks`
  gaps.** A fresh install left the agents returning **401s**: the LiteLLM Prisma
  schema was never created and the scoped agent virtual key was never
  registered. Both steps were **hook-gated**, and the deploy is forced to run
  `helm ... --no-hooks` (the argo-cd `argocd-redis-secret-init` pre-upgrade hook
  fails on this cluster), so both were silently skipped.
  - **Schema migration** now runs as a `db-migrate` **initContainer** on the
    LiteLLM proxy pod (`prisma migrate deploy`), part of the Deployment so it
    runs on every pod start regardless of `--no-hooks` / hooks-disabled / ArgoCD
    sync. It gates the proxy (the proxy never serves before the schema exists)
    and is independent of `DISABLE_SCHEMA_UPDATE`. 2Gi limit (1Gi OOMKills on a
    cold DB). The subchart `migrationJob` stays enabled only for the
    `DISABLE_SCHEMA_UPDATE=true` it sets on the proxy.
  - **Agent key** (`litellm-agent-key-init`) is converted from a Helm
    post-install/post-upgrade **hook** to a **normal sync-wave resource** (apps
    tier) so a plain `helm install` (hooks on OR off) and ArgoCD sync always run
    it; an ArgoCD `Replace=true` sync-option lets the immutable Job recreate
    idempotently on later syncs.
  - Validated on local kind: schema migrates from an empty DB (0 → 66 tables);
    a clean apply brings LiteLLM + sample-agent + poet-agent up green with the
    agent key returning 200 (no 401) and no manual steps.
- **OS UI console links use the public ingress URLs when deployed**, not
  `localhost`: the Next.js console route is `force-dynamic` and derives each
  console URL from its `consoleEnv` / matching ingress host at request time.
- **Static reserved ingress public IP.** The ingress-nginx LoadBalancer is
  pinned to a reserved STACKIT public IP via the
  `lb.stackit.cloud/external-address` annotation, with the address tracked in
  Terraform — so the IP (and the DNS records pointing at it) survive LB
  re-creation.
- **ClickHouse memory limit 2Gi → 3Gi** to stop the `OOMKilled` crashloop
  (resident caches + Langfuse schema migrations exceeded 2Gi).

## [0.2.0-alpha.2] — 2026-06-29

Headline: **four golden paths** become demonstrable end-to-end, the in-cluster
database moves to a **plain Postgres** that survives STACKIT's SKE-in-an-SNA
internal-DNS wall, startup is **orchestrated** so the node no longer OOMs, and
the bare zone **apex** now serves the OS UI.

### Added

- **Four golden paths** (agent / science / software / connections).
  - **Agent** — a Sales Assistant vertical slice: `AGENT.md` + `MEMORY.md`
    shipped as a versioned ConfigMap, a supervisor running in the OS UI over the
    governed LiteLLM + OPA + Langfuse spine, with a scoped key and approval-gated
    high-stakes tools (CRM write, knowledge certify).
  - **Science** — churn model as a governed tool (`predict`), a Dagster
    retrain pipeline (off by default), MLflow-tracked re-train → re-certify loop.
  - **Software** — per-app builds in the Software tab (Forgejo Actions → registry
    → Argo CD → subdomain), with an optional Harbor registry (off by default).
  - **Connections** — manually-credentialed API/MCP/Database/SaaS connections
    whose capability profile compiles into per-connection OPA policy data; the
    credential lives only in Secrets Manager (External Secrets, opt-in). Worked
    examples: Notion MCP + Salesforce API, allowlisted on the egress proxy.
- **Apex route.** `ingress.hosts.osUIApex` adds a second os-ui Ingress on the
  bare zone apex (e.g. `agentic.datamasterclass.com`), with its own TLS, so the
  apex serves the OS UI instead of 404ing next to `os.<zone>`. Set in the
  self-hosted overlay.
- **PriorityClasses** (`sovereign-os-infra` / `sovereign-os-app`) protecting the
  data layer under memory pressure; gated so local-kind still admits every pod.

### Changed

- **Plain in-cluster Postgres is now the default** (`postgres.engine: plain`,
  `cnpg` opt-in). A self-contained StatefulSet on the official `postgres` image
  that never talks to the Kubernetes API — fixing the **STACKIT SKE-in-an-SNA
  internal-DNS wall** that hung CloudNativePG's API-dependent bootstrap. It
  reproduces the CNPG path exactly (same `pg-rw`/`pg-ro`/`pg-r` Services, app DB
  + per-`extraDatabases` role/db/grants) so every consumer connects unchanged.
- **Orchestrated startup — no OOM.** Argo CD **sync-waves** (infra 0 / middleware
  1 / apps 2) stage the rollout, **resource requests** add memory backpressure,
  and **PriorityClasses** evict app pods before the DB — replacing the ~30-pods-
  at-once boot that spiked > 32 GB and OOMKilled LiteLLM / errored OpenMetadata.
  Both database engines (plain StatefulSet **and** CNPG cluster) carry the wave-0
  annotation, infra priority, and bumped memory requests/limits.

### Fixed

- **NetworkPolicy DNS egress on `:8053` — the SKE-in-an-SNA root cause.**
  Gardener/SKE runs CoreDNS listening on **8053** (the `kube-dns` Service remaps
  `53 → 8053`), and Calico enforces egress **post-DNAT**, so a policy that only
  allowed port 53 silently dropped every pod's DNS. `allow-dns-egress` now
  permits UDP/TCP **8053** alongside 53, fixing the all-night cluster-internal
  resolution failures (`pg-rw` and internal-API i/o timeouts) on both the
  multi-node and single-node STACKIT SKE deploys. With this fix plus the default
  **plain in-cluster Postgres**, the stack was validated **GREEN on live
  STACKIT** — Postgres up, all 5 governed tools reachable, and the Components
  API healthy.
- **OS UI console links** no longer point at `localhost` when deployed: each
  console URL derives from the matching ingress host (`soa.consoleUrl`); tools
  with no public host hide their "Open" link.

## [0.2.0-alpha.1] — 2026-06-28

Headline: the OS UI becomes a **teaching-ready, multi-tenant workspace**, the
**Admin Console is merged natively into the OS UI** (one app, one image), and a
full **STACKIT (EU) deploy path** lands with both a self-hosted (Mode A) and a
managed-services (Mode B) topology.

### Added

- **Teaching-ready multi-tenant OS UI.**
  - Identity & sessions: sign-in page, cookie session, auth/me/login/logout API
    routes, and route-guarding middleware.
  - Tenancy: per-user **domains** as the tenant scope, plus **user management**
    (users page + users API).
  - **Artifact lifecycle** `Personal → Shared → Certified` with admin-gated
    promotion. Certified artifacts publish cross-domain into a **Marketplace**;
    other users "add" a Certified artifact, which drops a scoped
    `certified-copy` into their own workspace. The server-side scoping rules are
    the security boundary regardless of backing store.
  - **In-app authoring** surfaces for datasets, dbt transformations, Cube
    metrics, dashboards, agents, and knowledge docs — each created and versioned
    as a lifecycle artifact.
- **STACKIT deploy automation** (`deploy/`):
  - Terraform for an SKE cluster + DNS zone, and (Mode B) STACKIT managed
    Postgres Flex, OpenSearch, Object Storage, Secrets Manager, AI Model
    Serving, and Container Registry.
  - Argo CD **app-of-apps** GitOps bootstrap (ingress-nginx, cert-manager,
    external-secrets, CloudNativePG, Velero, KEDA) and the umbrella app.
  - `deploy/Makefile`, `render-values.sh`, `publish-images.sh`,
    `push-secrets.sh`, and example `terraform.tfvars.example` / `.env.stackit.example`
    (placeholders only; real state/creds are git-ignored).
  - A local **`deploy/stackit` control CLI** + launchd scheduler
    (`on`/`off`/`deploy`/`destroy`/`urls`/`open`/`schedule`) to drive cost
    windows from a workstation.
- **Mode A (self-hosted on SKE)** topology: `enable_managed_backends=false` runs
  every backend in-cluster from the self-contained chart and pauses fully with
  the node pool. New `values.stackit-selfhosted.yaml` overlay.
- **Single-node STACKIT install guide** (`docs/stackit-deployment-guide.md`) —
  the **recommended, end-to-end-verified** path: one `g2i.8` node (8 vCPU / 32 GB)
  in a single AZ, node pool pinned `min=1/max=1`, the full self-contained L1–L3
  stack (~14 GB) bundled in-cluster, scaled to 0 off-hours. Captures every issue
  hit on the first real deploy and the validated config that fixes each.
- **Chart Mode-B production templating**: a per-tool **Ingress** template
  (`ingress.yaml`, off unless `ingress.enabled=true`), external-backend wiring,
  `imagePullSecrets`, and an os-ui ServiceAccount/Role.
- **Licensing/governance**: Contributor License Agreement (`CLA.md`) + CLA CI
  workflow, `TRADEMARKS.md`, and brand trademark-lockup assets.

### Changed

- **Admin Console merged into the OS UI.** Its functionality now lives natively
  as the **Platform → Components** surface. The standalone `admin-console` image
  is **deprecated and off by default** (`adminConsole.enabled=false`); the OS UI
  image now builds from the repo root and bakes in the component docs.
- **Entity corrected to Borek Data Ventures UG (haftungsbeschränkt)** across SPDX
  headers, `LICENSE`/`NOTICE`, and scripts (previously "Data Masterclass GmbH").
- OS UI branding/title refresh; docs (the end-user Guide + PDF, getting-started,
  component docs) updated for OS UI v1.0 and the Components surface.
- `values.stackit-managed.yaml` expanded for the Mode-B managed topology.

### Fixed

- Mode A binds bundled stateful components against the **SKE default
  storageClass** (empty class) instead of a hard-coded class.
- Production chart-templating corrections for external backends, image pull
  secrets, and Ingress gating so the local/Mode-A path renders unchanged.
- **STACKIT Terraform hardened from the first real SKE deploy:**
  - Kubernetes default raised to **`1.34`** (the old `1.31` is no longer offered
    by SKE and is rejected at apply).
  - Default machine flavor **`g2i.8`** (8 vCPU / 32 GB; `c1.4` is deprecated).
  - SKE **cluster name truncated to ≤ 11 chars** (`substr(replace(name,"-",""),0,11)`)
    — SKE rejects longer names.
  - New **`network.tf`** creates a routed `/24` so the cluster can attach to the
    project's **STACKIT Network Area (SNA)** (`stackit_ske_cluster.network`).
  - **Kubeconfig `expiration = 2592000`** (30 days) — the ~1 h default expired
    mid-deploy and corrupted installs.
  - **Terraform defaults are now the verified single-node setup** — a plain
    `tofu apply` yields one **`g2i.8`** node in a **single AZ (`eu01-1`)**, node
    pool pinned **`min=1/max=1`**, Kubernetes **`1.34`**. Multi-node and Mode-B
    stay available via explicit tfvars overrides but are now **known-blocked**
    (see Known limitations). (Multi-AZ requires `max ≥ #AZs`.)
- **OS UI console links no longer hard-code `localhost` on a real deploy.** The
  os-ui chart template now **derives every browser-reachable console URL from the
  ingress host** as `https://<tool>.<domain>` (new `soa.consoleUrl` helper) when
  `ingress.enabled` — so Superset/Langfuse/Forgejo/Argo CD/OpenMetadata links in
  the deployed UI point at the public ingress, not `http://localhost:8088` etc.
  Tools with no public ingress host (e.g. Dagster) resolve to an empty URL and the
  UI **hides their "Open" link** instead of linking to an unreachable localhost.
  Local-kind keeps the port-forward defaults.
- **`global.profile: local`** is required for the self-contained overlay so the
  chart generates the bundled credential Secrets (`profile: stackit` skips them,
  causing `CreateContainerConfigError` on ~17 pods). The private-registry pull
  secret is attached to the namespace **ServiceAccounts** (the `global.imagePullSecrets`
  map/string formats clash between bespoke and subchart pods). Bespoke images must
  be built **`linux/amd64`** (ARM images crash on SKE with `exec format error`).

### Known limitations / scaffolded

- The **in-app authoring backends are partly scaffolded.** Authoring produces
  **draft specs/plans stored as lifecycle artifacts** (with full Personal/
  Shared/Certified scoping enforced server-side); **compiling or executing** those
  drafts into the live dbt / Cube / LangGraph (and software scaffold → CI →
  GitOps) runtimes is **draft-for-review**, not yet a one-click live build.
- Artifact/user **persistence** is an authoritative in-process cache with
  **best-effort OpenSearch write-through** — durable when OpenSearch is reachable,
  in-memory otherwise (so the teaching flows work with no live cluster).
- STACKIT Terraform now defaults to the validated single-node values
  (`kubernetes_version_min` `1.34`, `g2i.8`, single-AZ node pool). Still
  **confirm flavor/plan names and sizing in the STACKIT catalog before `apply`**
  — they change per project/region.
- **BLOCKER — cross-node pod networking is broken on SKE-in-an-SNA; single node
  is the only verified path.** On an SKE cluster attached to a STACKIT Network
  Area (SNA), **a pod scheduled on a node *without* a CoreDNS replica cannot reach
  DNS or any pod on another node** — verified: same-node traffic works, cross-node
  is **100% loss** ("no servers could be reached"). This — not the SNA's external
  resolvers — is the real root cause that took down the Postgres-backed components
  on the first multi-node deploy: **CloudNativePG's init pod landed on the bad
  node, could not resolve, and the stateful bootstrap cascaded.** A **single node
  sidesteps it entirely** (no cross-node traffic), which is why single-node is now
  the default and only-verified topology. Multi-node HA and Mode-B managed are
  therefore **known-blocked** until STACKIT confirms cross-node overlay.
  - *Correction to the earlier note:* this was first framed as an **"SNA DNS"**
    problem — the SNA's `8.8.8.8` resolvers "couldn't resolve the internal SKE API
    hostname". That was a **downstream symptom on the multi-node cluster**, not the
    root cause; the defect is the **cross-node overlay dataplane**, and it
    disappears on a single node. Still run `nslookup kubernetes.default` from a
    throwaway pod before deploying (it just works on one node); if it fails there,
    the **SNA itself** is misconfigured — open a STACKIT support ticket.

## [0.1.0-alpha.1]

Initial public pre-release: the umbrella Helm chart (Layers 1–4 + a
secure-by-default baseline), the OS UI front door, the Apache-2.0 licensing
baseline (LICENSE/NOTICE, third-party manifest, SBOM), and the end-user guide.

[0.2.0-alpha.4]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.4
[0.2.0-alpha.3]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.1.0-alpha.1
