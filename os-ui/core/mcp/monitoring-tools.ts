/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from '@core/mcp/server';

// --- The EXACT governed monitoring spine the Monitoring tab + /api/monitoring call
import { buildOverview, scopeForUser, filterScope, fetchTrace, assertInScope, isPanelView, monitoringPanels, PANEL_VIEWS } from '@tabs/monitoring/lib/index';
import { collectRunList, isRunListStatus, RUN_LIST_STATUSES } from '@tabs/monitoring/lib/adapters/run-trace';
import { isRunId } from '@core/kernel/run-id';

/**
 * THE MONITORING MCP SURFACE (mcp-v2 P4) — READ-ONLY and HARD-SCOPED. Three thin
 * wrappers over the SAME OPA-scoping spine the Monitoring tab renders: every item
 * is passed through `filterScope`/`assertInScope`, derived from the caller's
 * identity server-side (creator = own runs · builder/domain_admin = their domain ·
 * admin = tenant + cluster). A creator can NEVER see another user's run or trace —
 * the same hard invariant the UI enforces; there is no privileged side-channel.
 *
 * HONESTY: the runs/traces lens is LIVE (Langfuse public API + the in-process
 * governed trace ring) with an offline-mock fallback. The pipeline-health and
 * system/cost/artifact lenses in the overview include MOCK adapters today — the
 * overview surfaces them EXACTLY as the UI does (parity holds), never claiming
 * live telemetry it does not have. Each item carries its own `source` ('live' |
 * 'mock'), so a consumer always knows which is which.
 */

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, examples: [{}] };

export const MONITORING_TOOLS: McpTool[] = [
  {
    name: 'get_monitoring_overview',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'Read the attention-first monitoring overview scoped to YOU: the few things needing attention (worst-first, not a wall of green), the per-lens roll-ups (runs · pipelines · cost · artifacts), and operational alerts. Purpose: one read of "is my work healthy" — the same overview the Monitoring tab renders. Before: whoami. After: list_runs / get_run_trace to drill in. Governance: read-only; scope is derived server-side from your identity (creator = own · builder = your domain · admin = tenant + cluster) — you never receive out-of-scope signals. HONESTY: each item carries a `source` ("live" | "mock"); pipeline/cost/artifact lenses include mock adapters today (as the UI shows), runs are live Langfuse + fallback.',
    inputSchema: NO_ARGS,
    call: async (user) => buildOverview(user),
  },
  {
    name: 'get_monitoring_panels',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'Read one Monitoring view — the same payload the Monitoring tab renders. `agents`: per agent system you can see — runs per day (done · failed · held for approval) from the run store, p50/p95 latency, traces and tokens from the Langfuse Metrics API, the system key\'s spend from LiteLLM, OPA denials and approval holds from OPA\'s decision log (VictoriaLogs), the last failures with Langfuse deep links, and approvals waiting. `data`: per dataset you can see — Dagster run health and last success per job and schedule, dbt test / source-test results with the failing ones, the quality trend (Dagster check executions) and the assets impacted downstream (Dagster lineage). `files`: per file you can see — Docling conversion status and failure reason (as recorded), indexing status checked against the rows OpenSearch itself holds; plus per connected drive (Google Drive / OneDrive) in your scope — last sync and its result (added · changed · unchanged · duration · error text), lag since the last successful sync, files imported, paused state and reason, and whether its connection needs reconnecting, with the Dagster schedule and its last run (removals in the drive and per-file sync failures are not recorded upstream). `knowledge`: per knowledge workflow you can see — OpenSearch rows and last ingest time, stale when edited after it (admin also gets OpenSearch\'s index-wide search latency). `data` also lists every dbt test (Dagster asset check) per dataset with type, pass/fail/warn, failing rows, last run, failing-since, severity, Dagster run link and trend. `kpis`: per metric you can see — registry load errors, last successful build of its dataset (Dagster), alerts firing, and each alert\'s Dagster evaluation runs (a failed run is a MetricFlow error). `dashboards`: per dashboard you can see — panels asking for members the served model does not expose (render errors and query latency are not available upstream). `platform` (admin only): component probes, node and pod pressure (VictoriaMetrics), error-log counts (VictoriaLogs), backups and the alerts firing now. Purpose: the first look for an operator, an agentic engineer or a data engineer. Before: whoami. After: list_runs / get_run_trace / get_dagster_run to drill in. Governance: read-only; every upstream read is narrowed server-side to your systems and datasets; `platform` answers forbidden below admin. HONESTY: `sources.*.state` says whether each component answered (`unavailable` + reason otherwise — its numbers are then absent, never zero); `notUpstream` lists what the components do not offer.',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: [...PANEL_VIEWS], description: 'agents (default) · data · files · knowledge · kpis · dashboards · platform (admin only).' } },
      examples: [{ view: 'agents' }, { view: 'data' }, { view: 'files' }, { view: 'knowledge' }, { view: 'kpis' }, { view: 'dashboards' }, { view: 'platform' }],
    },
    call: async (user, args) => {
      const view = str(args.view).trim() || 'agents';
      if (!isPanelView(view)) fail(`get_monitoring_panels: \`view\` must be one of ${PANEL_VIEWS.join(', ')}`, 400);
      return monitoringPanels(user, view);
    },
  },
  {
    name: 'list_runs',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'List recent agent RUNS (and governed tool-call traces) you are entitled to see, newest first — each with its health (green/amber/red), a one-line detail, owner, domain and, for an agent run, its `status` (queued · running · done · failed · parked · interrupted · incomplete) and `links.systemId`. Purpose: the run-trace lens as a list — find a run to inspect. Before: whoami / get_monitoring_overview. After: get_run_trace(runId) or get_agent_run(runId) to drill into one. READS: agent runs from the durable RUN STORE (the `run_jobs` rows every run is filed in, wherever it executed — a run the worker finished a moment ago is listed even before Langfuse has ingested it; a failed run reads `failed`, red); governed tool-call traces from Langfuse + this process’s trace ring. `systemId` and `status` filter agent runs (a filtered list holds agent runs only). If the run store does not answer, `runStore.available` is false with a reason — agent runs are then NOT listed, which does not mean there are none. Governance: read-only and HARD-scoped — every row is passed through `filterScope`, so a creator sees ONLY their own runs, a builder their own and their domain’s. NOTE the ladder (A5-review-L-4): this LISTING is scope-wide, so a builder sees that a colleague’s run exists and its health; the run CONTENTS are owner-only — `get_agent_run` and `get_run_trace` on an agent run id answer not_found unless you started it. Each row carries `source`.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max runs to return (default 25, capped 50).' },
        systemId: { type: 'string', description: 'Only agent runs of this agent system (id from list_agent_systems).' },
        status: { type: 'string', enum: [...RUN_LIST_STATUSES], description: 'Only agent runs with this status.' },
      },
      examples: [{}, { limit: 10 }, { systemId: 'sys_ab12cd34', status: 'failed' }],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim() || undefined;
      const rawStatus = str(args.status).trim();
      if (rawStatus && !isRunListStatus(rawStatus)) fail(`list_runs: \`status\` must be one of ${RUN_LIST_STATUSES.join(', ')}`, 400);
      const status = isRunListStatus(rawStatus) ? rawStatus : undefined;
      const scope = await scopeForUser(user);
      const cap = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 25;
      // One past the cap answers "are there more?" (Track B: a full page is not "all the runs").
      const { items, runStore } = await collectRunList({ scope, filter: { systemId, status }, limit: cap + 1 });
      const visible = filterScope(scope, items); // HARD scope: only what this identity may see
      const hasMore = visible.length > cap;
      return {
        scope: { level: scope.level, via: scope.via },
        count: Math.min(visible.length, cap),
        runs: visible.slice(0, cap),
        ...(hasMore ? { hasMore: true, note: `Showing the ${cap} most recent runs; there are more. Narrow with systemId or status, or raise limit (max 50).` } : {}),
        // Additive: where agent runs were read from, and whether it answered.
        runStore,
        ...(systemId || status ? { filters: { ...(systemId ? { systemId } : {}), ...(status ? { status } : {}) } } : {}),
      };
    },
  },
  {
    name: 'get_run_trace',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'Drill into ONE run trace: its steps (LLM calls, tool calls, spans), context pack, inputs/outputs, tokens and logs. Purpose: the core promise of Monitoring — see exactly what a governed run did. For an AGENT run the trace id IS the run id (`run_<uuid>` from run_agent_system): agents are spans, model calls are generations with token usage, tool calls are spans carrying the governance decision — one run, one trace. Before: list_runs, or the `runId` run_agent_system / get_agent_run returned. After: act on what you find. Governance: HARD gate, BEFORE any step/log is returned. An AGENT run id (`run_<uuid>`) is OWNER-only — only the user who started that run can read it, and any other id is a typed not_found, never a forbidden, so a run id cannot be probed for existence (the same gate `get_agent_run` uses). Any other trace id is scope-gated: out-of-scope is a typed forbidden, a missing id a typed not_found. LIVE from Langfuse; offline-mock fallback carries `source: "mock"`.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run/trace id — from list_runs, or an agent run id (run_<uuid>).' } },
      required: ['runId'],
      examples: [{ runId: 'trace_ab12cd' }, { runId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427' }],
    },
    call: async (user, args) => {
      const id = str(args.runId).trim();
      if (!id) fail('get_run_trace needs a `runId` (from list_runs)', 400);
      // A5-review-M-1: an AGENT run id is OWNER-gated, not scope-gated. `assertInScope` is
      // builder-domain-wide and answers 403 for an in-scope-but-foreign trace, which both lets a
      // builder read a colleague's run contents AND confirms the id exists. A run id is a
      // capability: for `run_<uuid>` the same gate every other run door uses decides, and its
      // answer is 404 whether the run is missing or someone else's.
      if (isRunId(id)) {
        const { assertRunVisible } = await import('@tabs/agents/lib/engine/run-visibility');
        const { peekRunOwner } = await import('@tabs/agents/lib/build/agentic-graph-server');
        let owner: { userId: string; systemId: string } | null = null;
        try {
          owner = (await peekRunOwner(id)) ?? null;
        } catch {
          // An unreadable checkpointer must never widen the gate — fall through to 404.
          owner = null;
        }
        assertRunVisible(owner ? { requestedBy: owner.userId, systemId: owner.systemId } : null, id, user.id);
        return fetchTrace(id);
      }
      const scope = await scopeForUser(user);
      const trace = await fetchTrace(id);
      // Throws 404 if missing, 403 if out of scope — BEFORE any step/log is returned.
      assertInScope(scope, trace);
      return trace;
    },
  },
];
