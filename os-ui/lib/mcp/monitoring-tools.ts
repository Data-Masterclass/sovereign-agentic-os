/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from './server';

// --- The EXACT governed monitoring spine the Monitoring tab + /api/monitoring call
import { buildOverview, scopeForUser, filterScope, fetchTrace, assertInScope } from '@/lib/monitoring';
import { collectRuns } from '@/lib/monitoring/adapters/run-trace';

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
    name: 'list_runs',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'List recent agent/tool RUNS you are entitled to see — each with its health (green/amber/red), a one-line detail, owner, domain and cost. Purpose: the run-trace lens as a list — find a run to inspect. Before: whoami / get_monitoring_overview. After: get_run_trace(runId) to drill into one. Governance: read-only and HARD-scoped — every run is passed through `filterScope`, so a creator sees ONLY their own runs, a builder only their domain’s. LIVE from Langfuse + the in-process governed trace ring (offline-mock only when nothing live is found); each row carries `source`.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max runs to return (default 25, capped 50).' } },
      examples: [{}, { limit: 10 }],
    },
    call: async (user, args) => {
      const scope = await scopeForUser(user);
      const all = await collectRuns();
      const visible = filterScope(scope, all); // HARD scope: only what this identity may see
      const cap = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 25;
      return { scope: { level: scope.level, via: scope.via }, count: visible.length, runs: visible.slice(0, cap) };
    },
  },
  {
    name: 'get_run_trace',
    tab: 'monitoring',
    minRole: 'creator',
    description:
      'Drill into ONE run trace: its steps (LLM calls, tool calls, spans), context pack, inputs/outputs, tokens and logs. Purpose: the core promise of Monitoring — see exactly what a governed run did. Before: list_runs (take a runId). After: act on what you find. Governance: HARD gate — the trace is fetched, then `assertInScope` throws BEFORE any step/log is returned, so a creator CANNOT open another user’s trace by guessing its id: out-of-scope is a typed forbidden, a missing id a typed not_found (indistinguishable from denied). LIVE from Langfuse; offline-mock fallback carries `source: "mock"`.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run/trace id from list_runs.' } },
      required: ['runId'],
      examples: [{ runId: 'trace_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.runId).trim();
      if (!id) fail('get_run_trace needs a `runId` (from list_runs)', 400);
      const scope = await scopeForUser(user);
      const trace = await fetchTrace(id);
      // Throws 404 if missing, 403 if out of scope — BEFORE any step/log is returned.
      assertInScope(scope, trace);
      return trace;
    },
  },
];
