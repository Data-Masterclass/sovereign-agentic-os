<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Session digest — July 2026 (through 2026-07-08)

_Scope: commits from os-ui 0.1.32 → 0.1.62 + all staged/uncommitted changes._

---

## 1. Headline

This session completed a full three-tier STACKIT model migration (standard / reasoning / embeddings), flipped the embeddings layer to Qwen3-VL-Embedding-8B at 4096 dimensions (replacing the 384-dim mock), and executed an OS-wide lifecycle / navigation / UX overhaul that touched every tab. The result is os-ui 0.1.62, staged for deploy on the STACKIT tenant, with model-server and all local Mistral weights gone and the platform ready for the Agentic Leader Q3-2026 cohort.

---

## 2. Key decisions (with rationale)

- **STACKIT 3-tier model set, admin-configurable as helm defaults.**
  - Standard/worker: `openai/gpt-oss-20b` (alias `sovereign-default`)
  - Reasoning: `Qwen/Qwen3-VL-235B-A22B-Instruct-FP8` (alias `sovereign-reasoning`)
  - Embeddings: `Qwen/Qwen3-VL-Embedding-8B` (alias `sovereign-embed`), 4096-dim
  - Rationale: STACKIT-managed inference only; no local weights on the node. These are helm defaults only — any admin can reconfigure via the Admin UI; the OS is open source and must run on other infra with different providers.

- **Delete model-server (Ministral + Magistral) and all in-cluster Mistral workloads.**
  - Rationale: Ministral wedged on CPU (AMX/flash-attn); consumed 2–12 CPU / 4–6 GiB with no live traffic route. Freed immediately; all real inference already running on STACKIT Qwen.

- **Embeddings flip strategy: "now, empty + re-seed".**
  - 384-dim mock → 4096-dim real model. OpenSearch knowledge and files indices recreated (dimension mismatch prevents in-place migration). Seed demo re-run is the follow-on step.
  - `KNOWLEDGE_EMBED_DIM` / `FILES_EMBED_DIM` wired from `retrieval.knnDimension` in the chart.

- **Tile lifecycle = Open-only on tiles; Archive/Delete inside detail.**
  - Rationale: cluttered tile cards with status-management actions users rarely need. Tiles now show only "Open". Archive / Restore / Version history / Delete appear inside the opened detail. Delete surfaces only on already-archived items.

- **5-section sidebar: Plan / Context / Build / Monitor / Admin.**
  - Was a flat list of business tabs plus a Platform group. Governance moved under Admin.

- **Data + Metrics each collapsed to a single screen** (subtabs removed).
  - Query sandbox sits below tiles. Alerts moved from Dashboards → Metrics (they are metric-threshold rules).

- **Source-domain provenance tags on every shared/marketplace artifact.**
  - Makes same-named artifacts from different domains unambiguous at a glance.

- **Knowledge: new/promote-ladder/versioning.**
  - Prominent "New knowledge" action; full Personal → Domain → Marketplace promotion via the governance ladder; git-backed versioning for personal knowledge items.

- **Open-source = admin-configurable, our picks are helm defaults only.**
  - App code sources model catalog live from the LiteLLM gateway (`/v1/models`). Hardcoded model lists removed. Operators register their own models; our three tiers are defaults, not mandates.

- **Delegate implementation to subagents; parallelize workstreams.**
  - Main chat stays for orchestration, decisions, and live-cluster ops. Independent coding workstreams run as parallel background agents in separate worktrees. Established in memory as a standing rule.

- **Velero deferred.** Cluster is running without backup snapshots. Decision: deploy velero before go-live (needs a Terraform-provisioned object-storage bucket first).

- **OAuth apps (Google Drive, OneDrive) need one-time admin registration.**
  - Notion auto-registers (PKCE + RFC 8414 dynamic client registration). Google Cloud + Azure require a user/admin step (redirect URIs at `/api/connections/oauth/{google,microsoft}/callback`).

---

## 3. Changes shipped (by area)

### Models & inference
- Deleted `charts/.../model-server/magistral-reasoning.yaml` and `model-server.yaml`
- `models/` lib (`os-ui/lib/models/`) + admin page unified to single live-sourced store
- Agent builder: model picker reduced to Auto / Standard / Reasoning (embeddings is infrastructure-only)
- `lib/agents/routing.ts` updated for 3-tier routing

### Embeddings
- `lib/knowledge/embed.ts` + `lib/files/embed.ts`: dimension → 4096, model → `sovereign-embed`
- Helm `retrieval.knnDimension` wires both env vars
- OpenSearch indices for knowledge and files scheduled for recreation on next deploy

### Lifecycle UX (OS-wide)
- Shared `components/lifecycle/{ConfirmDialog,LifecycleActions,VersionHistory}` already shipped (0.1.59); 0.1.62 finishes the tile-only-Open rule across remaining tabs
- Show-archived toggle per tab (keeps Delete reachable without cluttering working view)

### Data tab
- Collapsed to single screen: Datasets + Query below tiles; subtabs removed
- Dataset detail: governed "Preview first 50 rows" (DLS-filtered, never fabricated)

### Metrics tab
- Collapsed: Metrics + Query on one page; subtabs (Explore/Govern/Alert) folded into metric detail

### Knowledge tab
- "New knowledge" prominent action + My-knowledge focal view
- Full promotion ladder: Personal → Domain → Marketplace
- Git-backed versioning for personal knowledge (`lib/knowledge/personal-store.ts`)
- New API routes: `app/api/knowledge/personal/[id]/promote/` and `/versions/`

### Sidebar
- Restructured to 5 named sections; `components/Sidebar.tsx` updated

### Components tab & Governance
- Postgres detected via StatefulSet fallback (fixes false-negative status)
- dbt status: `"on-demand"` (was red)
- Sample RAG agent removed from registry
- "Seed demo queue" button removed from Governance page

### Software delivery
- `appImageRef` now serves the real CI-published image
- `ci-runner` pod gains `fsGroup: 1000` (fixes CrashLoopBackOff blocking pipeline runs)

### Provenance tags
- New `components/DomainTag.tsx` component
- Applied across all tabs for Shared and Marketplace scope views

### User & Access
- 6 new route tests covering the edit flow (`lib/governance/users-route.test.ts`)

### Dashboards
- `components/dashboards/Tiles.tsx` + `shared.ts` updated for Open-only tile lifecycle

### Big Bets
- `app/big-bets/[id]/page.tsx` + `page.tsx`: lifecycle/provenance consistency pass

### Helm chart / values
- Deleted: `charts/.../model-server/` templates, `values 2.yaml`, `values 3.yaml`, `values.private.example 2.yaml`, `values.stackit-selfhosted 2.yaml` (duplicate files)
- `values.yaml`, `values.stackit-selfhosted.yaml`, `values.stackit-managed.yaml`, `values.selfcontained.yaml` updated for 3-tier model config and embeddings dimension
- `deploy/terraform/variables.tf`: prepared for velero bucket
- `deploy/velero/values.yaml`: updated

### Docs
- `docs/components/litellm.md` updated; `docs/components/model-server.md` deleted
- `docs/backups.md`, `docs/cloud-configuration.md`, `docs/components/kserve.md` updated
- `docs/Sovereign-Agentic-OS-Guide.md` + PDF regenerated
- `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`, `NOTICE` updated
- `CI-LAYER4-INTEGRATION.md` updated

---

## 4. Final state

| Item | State |
|---|---|
| **os-ui version** | 0.1.62 (staged; not yet committed + pushed) |
| **Last deployed** | 0.1.61 (live on STACKIT) |
| **Helm chart status** | Staged changes against rev matching 0.1.61 |
| **LB IP** | `193.148.171.38` |
| **Inference** | STACKIT-managed; standard=`gpt-oss-20b`, reasoning=`Qwen3-VL-235B`, embed=`Qwen3-VL-Embedding-8B` |
| **Embeddings dim** | 4096 (OpenSearch indices to be recreated on deploy) |
| **model-server** | Deleted from chart |
| **mock-model** | Deleted (no longer needed once embeddings use real STACKIT model) |
| **Staged files** | ~95 modified, 10 deleted, 6 new (see `git status`) |
| **Uncommitted** | Yes — entire 0.1.62 delta is in working tree, not committed |

---

## 5. Open items / next

- **Velero (backups):** needs Terraform bucket provisioned first (`deploy/terraform/variables.tf` prepped). Must deploy before cohort go-live. Runbook in `docs/backups.md`.
- **OAuth apps:** Google Cloud + Azure app registrations still required (one-time admin step; redirect URIs at `/api/connections/oauth/{google,microsoft}/callback`). Notion self-registers.
- **GATE 4 — Student E2E:** browser walkthrough proving a creator can complete the Northpeak case study end-to-end with zero glitches. Not yet run on 0.1.62.
- **GATE 5 — Onboarding:** mail for cohort invites (in-cluster maddy MTA built but not deployed; awaiting EU SMTP smarthost choice + DNS SPF/DKIM/DMARC in Route 53) OR pre-created accounts as bridge.
- **Repopulate the exercise:** re-seed Northpeak Bronze/Silver/Gold + knowledge MDs + Campaign Evaluation Agent after embeddings indices are recreated (dimensions changed).
- **`#56` polish:** open issue for final UI polish pass before go-live (run `/polish` via Impeccable skill).
- **`*.apps.agentic.datamasterclass.com` wildcard DNS:** needed so Software live-app runner can serve app URLs (LB already at `193.148.171.38`; cert-manager per-host HTTP-01 also needed).
- **Commit + push + helm deploy 0.1.62:** the staged working tree needs to be committed, image built + pushed to `ghcr.io/aborek/sovereign-os/os-ui:0.1.62`, then `helm upgrade`.
