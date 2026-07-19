# Sovereign Agentic OS — Master Plan

Live: **os-ui 0.5.60** (all releases live + public + strictly-permissive-gated).
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
- **OpenMetadata full ingestion** (#147) — dbt + Trino + DQ + lineage into the catalog.
- **Analytics-as-code monorepo** (#146) — dbt+Cube+Dagster co-located in Forgejo; OM ingests from it.
- **Full developer mode** — devcontainer + GoReleaser/self-hosted brew tap + typed `/api/v1` + `sos push` git-through-policy. (Builds on the shipped `sos` CLI Ph0.)
- **External-OM interplay** (#163) — implement the read/write-with-a-customer's-OM design.
- **Power BI DAX/XMLA adapter** (#143) — beyond `.pbids`, a semantic-model bridge.

## Decisions pending (bring up when their wave arrives)
1. **Retire the shared Forgejo service account** → per-user tokens (unblocks *full* Git/Jira + `sos push`).
2. **DQ anomaly-detection stance** — in-cluster statistical vs OM-native (gates DQ Ph2 ML).
3. **OM DQ write-back on now?** (Ph2).
4. Kata/KVM — now largely moot: the governed-frontend model removed the need for a full-stack HMR sandbox.

## Standing guards (never regress)
Every release must pass **`check:licenses`** (strictly permissive) + gitleaks + the 3 code gates + live-verify before "done". Cube/Superset/OM live-diagnosis playbooks recorded in memory.
