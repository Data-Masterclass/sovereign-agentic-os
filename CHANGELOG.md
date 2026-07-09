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
