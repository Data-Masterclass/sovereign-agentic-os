# Monitoring tab — build context

**Purpose:** The read/observe plane — runs, pipeline/cost/artifact health, and drill-into-trace. Read-only and HARD-scoped to your identity.

**Tools (MCP `monitoring`):**
- `get_monitoring_overview()` — attention-first overview (worst-first): per-lens roll-ups + operational alerts, scoped to you. Each item carries `source` (live/mock).
- `list_runs(limit?)` — your recent runs with health, detail, owner, domain, cost. `filterScope` removes anything you may not see.
- `get_run_trace(runId)` — drill into one trace (steps, tool calls, context pack, logs). `assertInScope` throws BEFORE any step is returned.

**Golden path** (slash command `check_my_runs`): `whoami` → `get_monitoring_overview` → `list_runs` → `get_run_trace`.

**Constraints:** hard scope — creator = own runs, builder/domain-admin = their domain, admin = tenant + cluster; guessing another user's run id → forbidden/not_found. Runs/traces are live Langfuse + fallback; pipeline/cost/artifact lenses include mock adapters (as the UI shows). READ-ONLY: no ack/silence — fix the artifact in its own tab.
