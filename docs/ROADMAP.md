# Sovereign Agentic OS — Parallel Build Roadmap

Live: **os-ui 0.5.53**. Cadence: each **wave** = several agents on **disjoint file lanes**, run in parallel → gate (tsc + tests + 46/46 build) → **release** (build image, deploy STACKIT, public sync) → next wave. Full designs in `docs/research/`.

**Parallelism rule:** at most ONE agent per builder file (`DataBuilder`/`SoftwareBuilder`/`MetricBuilder`/Dashboards/`ScienceBuilder`) per wave. Infra/chart, new-file workstreams, docs, and *different* builders are conflict-free and run together.

---

## Wave A — RUNNING NOW → ships as **0.5.54**
| Lane | Files | What |
|---|---|---|
| Lifecycle-in-header | all builder headers | Archive/Restore/Delete in the persistent detail header (Data/Software/Science/Dashboards) — Metrics already shipped 0.5.53 |
| W1 Software Build Ph0 | SoftwareBuilder `BuildStage` | Plan⇄Build toggle + inline diffs + story-targeted build (+ plan file for Sandpack/scaffold/HMR) |
| W2 Data Quality Ph0 | DataBuilder Validate + lib/data/dq* | Persist DQ results (time-series) + health score + suggest-rules-from-profile + Data Assistant |
| W3 Simple/Dev Wave 2 | Metrics + Dashboards + Science builders | Simple⇄Developer toggle + raw-artifact Developer view |
Merge order: lifecycle first, then W1/W2/W3 (headers vs stage-bodies = disjoint).

## Wave B → **0.5.55** (all disjoint, parallel)
- **Data Developer view** (DataBuilder) — the piece W3 excluded to avoid the DQ collision.
- **Software: Git/Jira push** from the Design stage (Design lane) — needs *retire shared Forgejo service account* decision.
- **Power BI Phase 0** (connections/powerbi + Cube RLS) — `.pbids` connect button + per-user RLS. New/isolated files.
- **OpenMetadata: active-only datasets** (lib/data + OM sync) — hide archived; soft-delete on archive; re-ingest on restore. (You flagged this.)
- **Metrics alert CronJob** (chart + lib/metrics/alerts) — scheduled alert evaluation.

## Wave C → **0.5.56 + infra** (parallel)
- **Data Quality Phase 1** (DataBuilder + chart) — freshness/volume/schema monitors-on-by-default + DQ CronJob + Monitoring-tab rollup. *Decision: monitors default-on? anomaly stance?*
- **Software Build Phase 1** — Sandpack instant preview + Vite/shadcn/Supabase scaffold. *Decision: Vite scaffold default? Kata/KVM available on STACKIT?*
- **Developer mode Phase 0** — `sos` CLI scaffold (Go, thin-over-MCP) + devcontainer + self-hosted brew. New repo/files. *Decision: commit to /api/v1 contract?*
- **Cube Store deploy** (chart) — enables dev-mode OFF (closes playground, drops polling). Optional hardening; metrics already work.

## Wave D — bigger bets (each mostly standalone)
- **Software hot-reload preview** (Kata-isolated Vite HMR pod) — infra-heavy; gated on KVM availability.
- **OpenMetadata full ingestion** (#147) — dbt + Trino + DQ + lineage into the catalog.
- **Analytics-as-code monorepo** (#146) — dbt+Cube+Dagster co-located in Forgejo (git mirror is the seed).
- **Claude Design import** (Software Design) — seed the FE scaffold from a pasted design.
- **Power BI DAX/XMLA adapter** (#143); **external-OM interplay** (#163, research in progress).
- **Docs/guide + PDF regen** — after the redesign waves settle.

## Always-interleaved
Your tab-by-tab testing → targeted bug-fixes, folded into whatever release is in flight.

## Decisions that gate later waves (bring to you per report)
1. Kata/KVM nodes on STACKIT (gates Software hot-reload, DQ heavy ML).
2. Retire shared Forgejo service account for per-user tokens (gates dev-mode git-push + Git/Jira).
3. Anomaly-detection stance: in-cluster statistical vs OM-native (gates DQ Phase 2).
4. Commit to a versioned `/api/v1` + MCP contract (gates the `sos` CLI).
5. Vite scaffold as the new-app default (gates Software Build Phase 1).
