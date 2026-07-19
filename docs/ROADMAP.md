# Sovereign Agentic OS — Master Plan

Live: **os-ui 0.5.62** (rev 176); **0.5.63 building** (Wave 2). All releases live + public + strictly-permissive-gated.

## Shipped tonight (0.5.62 → 0.5.63)
- **Data pass-through fix** (0.5.62, live-verified): medallion pass-through PROBES physical
  reality instead of trusting stale registry flags — copies the newest existing lower layer,
  ADOPTS an already-materialized target (the directly-seeded gold-only mart), or returns a
  clear message. No more raw `TABLE_NOT_FOUND` on a phantom `silver_`. Verified on Northpeak.
- **DQ Phase 2** (0.5.62): OpenMetadata TestSuite/TestCase/result write-back (default OFF, 7 guards).
- **Cloud install foundation**: `values.{gke,eks,aks}.yaml` + CNPG cloud-durable (Barman/HA) +
  keyless catalogs + `sos install` wizard + per-cloud bootstrap. Static-validated; **pending live
  cloud runs** (user will test each cloud over the coming days).
- **Power BI DAX/TMDL bridge** (#143, 0.5.63): one-way generated semantic model from Cube meta.
- **OpenMetadata full ingestion** (#147, 0.5.63): governed orchestrator + scheduled refresh
  (default OFF); catalog population pending live OM verify.
- **Full developer mode**: `sos push` (commit-through-policy) + devcontainer + Homebrew tap.
- **chart**: trino cloudCatalog + OM catalog-refresh made nil-safe under `helm --reuse-values`.

Prior baseline (0.5.60):
Cadence: each **wave** = several agents on **disjoint file lanes** in parallel → gate (tsc + tests + 46/46 build + `check:licenses`) → **release** (image, STACKIT deploy, public sync) → next wave.
**Parallelism rule:** at most ONE agent per builder file (`DataBuilder`/`SoftwareBuilder`/`MetricBuilder`/…) per wave; infra/chart, new-file packages, docs, and *different* builders run together freely.

## Shipped this run (0.5.47 → 0.5.60)
Self-completing git mirror · Data medallion flow + labels · Connections vendor-stacks + jump-links + Custom Connector · Cube #142 root-caused + `schemaVersion` hardening · lifecycle-in-header (all builders) · Simple/Developer views (Data/Metrics/Dashboards/Science/Software) · Software MCP parity · **Builder Framework core** (ContextGrants + BuilderModeToggle) · **Software re-architected** to *governed-frontend-over-OS-API* (OS-client SDK + `vite-os` scaffold + `@sovereign-os/ui` design system + AI build Plan/Build+diffs+story-target + preview) · Data Quality Ph0+Ph1 (checks + health + suggest + monitors + cron + Monitoring rollup) · Power BI `.pbids` connect + RLS · OpenMetadata active-only · **`sos` CLI** Ph0 · **strictly-permissive licensing + `check:licenses` gate** (evicted proprietary nodebox) · Superset dashboard-auth fix · 5 research reports persisted (`docs/research/`).

## In flight NOW (parallel)
- **Docs**: regenerate the OS guide + PDF for all the above.
- **esbuild-wasm instant preview** (permissive) — restores instant, real-data preview.
- **Software Design stage**: push EPICs/stories→Jira + code→Git (governed, user's own connection) + **Import a Claude Design** to seed the frontend.

## Wave — Cohort-readiness (GATE 5, #47) → target next
- [in flight] Docs + PDF regenerated.
- **Activate scheduled jobs** — YOU create the `dq-run-principal` + `metrics-alert-principal` secrets, then flip `data.quality.cron.enabled` / `metrics.alerts.cron.enabled`. (Built; needs a credential I won't handle.)
- **Onboarding + security pass** — confirm cohort accounts, roles (creators→builder), egress allowlist, secrets hygiene.
- **Public release checkpoint** — tag + verify the public mirror.

## Wave — finish the feature depth (parallel, disjoint)
- **Migrate Agents onto the shared Builder-Framework primitives** (Wave-2 leftover; agents kept their own until last). — agents builder lane.
- **DQ Phase 2**: OpenMetadata TestSuite/TestCase/result write-back (reuse the 7-guard sync). — lib/connections/openmetadata + Validate. *Decision: turn OM DQ write-back on now?*
- **Science live-verify E2E** — create→train→deploy→predict on STACKIT, fix any gaps. — science lane + live.
- **Software polish** — FE+BE scaffold options; per-story build refinements. — software lane.

## Epics — multi-session (each its own mini-plan when picked)
- ✅ **OpenMetadata full ingestion** (#147) — shipped 0.5.63 (orchestrator + scheduled refresh; live-verify pending).
- ✅ **Full developer mode** — shipped 0.5.63 (`sos push` + devcontainer + brew tap; typed `/api/v1` still open).
- ✅ **Power BI DAX/XMLA adapter** (#143) — shipped 0.5.63 (one-way TMDL from Cube meta).
- **Analytics-as-code monorepo** (#146) — dbt+Cube+Dagster co-located in Forgejo; OM ingests from it. (Next epic; `sos push` Phase-2 push-through-policy pipeline lands here.)
- **External-OM interplay** (#163) — implement the read/write-with-a-customer's-OM design.
- **Cloud install live-verify** — bring `sos install` up on a real GKE/EKS/AKS cluster (user-run over the coming days).

## Decisions pending (bring up when their wave arrives)
1. **Retire the shared Forgejo service account** → per-user tokens (unblocks *full* Git/Jira + `sos push`).
2. **DQ anomaly-detection stance** — in-cluster statistical vs OM-native (gates DQ Ph2 ML).
3. **OM DQ write-back on now?** (Ph2).
4. Kata/KVM — now largely moot: the governed-frontend model removed the need for a full-stack HMR sandbox.

## Standing guards (never regress)
Every release must pass **`check:licenses`** (strictly permissive) + gitleaks + the 3 code gates + live-verify before "done". Cube/Superset/OM live-diagnosis playbooks recorded in memory.
