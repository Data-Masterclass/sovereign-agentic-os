# Data Quality — Phased Build Plan (deferred work)

Date: 2026-07-19 · status: Phase 0 shipped; the rest is a concrete plan, not yet built.

This file records what was BUILT in Phase 0 and the concrete, low-risk plan for the
DEFERRED capabilities from `data-quality-ux.md` §5–§8. Nothing below is built yet — each
section names the exact files/endpoints to touch so the next agent can execute directly.

---

## Shipped in Phase 0 (Validate stage · `os-ui/lib/data/dq*`)

- **Result persistence** — `os-ui/lib/data/dq-results.ts`: a durable time-series store
  (osMirror write-through + `os-dq-results` OpenSearch index), one record per governed
  run `{ datasetId, ranAt, badge, healthScore, results[], ranBy, domain }`, recent-window
  trimmed per dataset. Appended by the checks route's `action:'run'`. Unit-tested.
- **Health score** — `healthScore()` in `os-ui/lib/data/dq.ts`: 0–100 pass-rate weighted
  by clean-row fraction, honest `null`/`unknown` when nothing ran (never a fake 100), a
  real failure capped below 100. Unit-tested.
- **Suggest-from-profile** — `os-ui/lib/data/dq-suggest.ts`: deterministic profile→rule
  mapping (0 nulls ⇒ not_null; ~100% distinct ⇒ unique; small closed category set ⇒
  accepted_values; numeric min/max ⇒ range), each citing its profile evidence; dedupes
  against existing rules. Served read-only by `GET /api/data/datasets/[id]/dq`. Unit-tested.
- **Validate-stage UX** — health score + trend sparkline (honest gap on null runs),
  passing/failing/not-run summary, exception-first "Suggested checks" cards with one-click
  Add / Accept all, atop the existing rule editor + Run. The Validate assistant now
  explains the deterministic suggestions in plain language (rationale layer).

All governed (runs AS the owner, OPA/RLS), honesty contract preserved, no secrets logged.

---

## DEFERRED — concrete plan

### D1 · Freshness / volume / schema monitors, ON by default
*Monte-Carlo's "coverage without writing rules" lesson. Heuristic/statistical first — NOT ML.*

- **Freshness** = `now − last-loaded` vs an expected cadence (derive the cadence from the
  gap distribution in `dq-results` history, or let the owner set it). Violation when late.
- **Volume** = row-count band = `mean ± k·σ` over the persisted run history (add `rowCount`
  to each `DqRunRecord`, or a dedicated volume series). Violation when out of band.
- **Schema** = column-set stability: snapshot `parseDescribe` output per run; violation on
  an unexpected add/drop/type-change vs the last snapshot.
- Files: extend `lib/data/dq-results.ts` to carry `rowCount` + a `schemaFingerprint`; add a
  pure `lib/data/dq-monitors.ts` (band/freshness/schema evaluators, unit-tested); render
  three default-ON toggles under the Validate "Your checks" block. Keep evaluators pure and
  explainable (mean±kσ, not a black box) for sovereignty.
- **Open decision (from ux doc):** default-ON vs opt-in. Recommend default-ON with a
  visible [Manage] to disable, matching the research mock.

### D2 · Scheduled DQ runs + failure alerts
*Reuse the alert-store / CronJob substrate — no new alert engine.*

- Add a K8s CronJob `charts/sovereign-agentic-os/templates/metrics/dq-cronjob.yaml`
  (mirror `metrics-alert-cronjob.yaml`, e.g. `*/15 * * * *`) hitting a new
  `POST /api/data/dq/run-all` that, for each governed dataset, runs its checks + monitors,
  appends a `DqRunRecord`, and on a NEW failure fires through the existing
  `lib/metrics/alert-store.ts` / notification path (Slack/email/inbox connectors exist).
- Extend `AlertRuleRecord` with a DQ member type: "notify when dataset X health < H / any
  check fails / freshness SLA missed." No new engine; the diff is the run-all route + the
  CronJob template + the DQ alert-rule shape.

### D3 · Monitoring-tab DQ rollup + incident feed
*Author in Data (Validate stage), monitor in Monitoring — the hybrid IA from the ux doc §3/§5.2.*

- Read-only tenant/domain overview: datasets ranked by risk (health, open incidents,
  freshness), each row deep-linking back to that dataset's Validate stage. Scope-aware
  My/Domain/Company per the OS vocabulary standard.
- Source it from `dq-results` (`healthTrend`/`latestRun` per dataset) + the DQ alert rules.
  Files: a `lib/monitoring/dq-overview.ts` aggregator (pure, unit-tested) + a Monitoring-tab
  panel. A failing check the user tracks becomes an incident (ack/assign/RCA-note/resolve),
  modeled on OM's Incident Manager so it maps 1:1 for D4 write-back.

### D4 · OpenMetadata TestSuite/TestCase/result write-back
*Leverage the already-built #163 guards + `createOmTestCaseResult` — don't rebuild.*

- Add a DQ leg to `lib/connections/openmetadata-sync.ts` `buildOmSyncPlan`: on promote,
  PUT a Basic (executable) `TestSuite` bound to the gold mart's OM FQN, then one `TestCase`
  per OS rule referencing the built-in `TestDefinition` (mapping table in ux doc §6:
  not_null→columnValuesToBeNotNull, unique→columnValuesToBeUnique,
  accepted_values→columnValuesToBeInSet, range→columnValuesToBeBetween, not_blank→
  columnValuesToBeNotNull + columnValueLengthsToBeBetween(min:1)). All under the
  `sovereign_os` namespace, `managedBy=SovereignOS`, additive JSON-Patch, idempotent,
  behind `test` preconditions — all 7 guards honored.
- On each governed run, append the verdict via the EXISTING `createOmTestCaseResult()` →
  `PUT /api/v1/dataQuality/testCases/{fqn}/testCaseResult` (OM stores the time-series → its
  DQ dashboard trend fills for free). Sync incidents to OM's `TestCaseResolutionStatus`.
- **Honest boundary:** writes fail closed outside OM `1.3.0–1.9.99` and require a valid
  writer-bot JWT; no live OM ⇒ DQ still runs governed-SQL locally (OM enrichment is additive,
  never a hard dependency). **Open decision:** turn on now vs. validate the writer bot on the
  live tenant first.

### D5 · ML / anomaly detection (big bet — needs a call)
*Anomalo/Soda-class distribution monitors.*

- Given the EU-sovereign + open-source constraints, recommend **in-cluster statistical
  monitors** (mean±kσ distribution bands from the persisted history, seasonality-aware later)
  BEFORE any heavy ML, and before leaning on OM's evolving native anomaly features. No
  external SaaS. Only after D1's statistical monitors prove out.

### D6 · MCP surface + lineage RCA (follow-on)
- New governed MCP tools mirroring the UI: `suggest_quality_rules` (wrap `dq-suggest` +
  the profile), `get_quality_report` (read `dq-results` trend + incidents),
  `sync_quality_to_catalog` (gated, dry-run-first D4 trigger).
- Lineage-aware incident RCA / blast-radius (which downstream marts are affected) via OM
  lineage — powerful but a genuine build; sequence after D3/D4.

---

**Sequencing (low-risk first):** D1 → D2 → D3 → D4 → (D5/D6 on decision). D1–D3 are pure
extensions of the Phase-0 substrate (`dq-results`, alert-store, the profiler); D4 leverages
the #163 write-back guards; D5/D6 are the flagged bigger bets.
