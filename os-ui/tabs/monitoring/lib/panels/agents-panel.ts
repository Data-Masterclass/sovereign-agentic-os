/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Agents panels — per agent system: runs over time, p50/p95 latency,
 *             tokens and cost, error classes, last failures with deep links, approvals waiting
 * USER STORY: As an agentic engineer I want one screen per agent system with how its runs went,
 *             how fast and how expensive they were, why the failed ones failed and what is waiting
 *             on a human — each number from the component that holds it, for my systems only.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Systems = the Agents store's own scoped list (`agentHealthRows`,
 *     injected through `sources.ts` — a tab never imports another tab).
 *     Every upstream read is narrowed to those ids IN the request (design:
 *     docs/superpowers/plans/2026-11-21-monitoring.md):
 *       run store (Postgres)  → `runStats` with the `list_runs` scope predicate
 *       Langfuse Metrics API  → `systemTraceStats` (sessionId any of system:<id>)
 *       LiteLLM `/key/list`   → spend of alias os-<id>
 *       VictoriaLogs          → OPA decision log of principals os-<id>[:<node>]
 *       OS approvals store    → pending approvals of these systems
 *   - A source that does not answer is `unavailable` with its reason; its per-system fields are
 *     absent (never zero).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { agentRunsPool, configuredAgentRunsDatabaseUrl } from '@core/adapters/postgres/pool';
import { systemTraceStats, type SystemTraceStats } from '@core/adapters/langfuse/metrics';
import { logsQuery } from '@core/adapters/victoria-logs/query';
import { readAllKeys } from '@core/infra/litellm-admin';
import { traceUrlFor } from '@core/infra/langfuse';
import { listApprovals, ensureHydrated as ensureApprovalsHydrated } from '@core/policy/approvals';
import { scopeForUser } from '@tabs/monitoring/lib/scope';
import { monitoringSources, SOURCES_MISSING } from '@tabs/monitoring/lib/panels/sources';
import { visibleToOf } from '@tabs/monitoring/lib/adapters/run-store-runs';
import { runStats, type DayCounts, type RunFailure } from '@tabs/monitoring/lib/adapters/run-stats';
import { foldDecisions, keySpendBySystem, live, opaDecisionQuery, unavailable, type NotUpstream, type PolicyCounts, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

export const AGENT_WINDOW_DAYS = 7;
const RUN_WINDOW_DAYS = 14;

export type AgentSystemPanel = {
  id: string;
  name: string;
  scope: 'mine' | 'domain' | 'marketplace';
  agentsUrl: string;
  runs?: { days: DayCounts[]; failureClasses: { budget_exceeded: number; other: number }; lastFailures: (RunFailure & { runUrl: string; traceUrl?: string })[] };
  traces?: SystemTraceStats | null;
  keySpendUsd?: number | null;
  policy?: PolicyCounts | null;
  /** Absent when the approvals store could not be read (sources.approvals says why). */
  approvalsWaiting?: { id: string; title: string; tool: string; createdAt: string; node?: string }[];
};

export type AgentsView = {
  view: 'agents';
  generatedAt: string;
  windowDays: number;
  runWindowDays: number;
  sources: { inventory: SourceState; runStore: SourceState; langfuse: SourceState; litellm: SourceState; opaDecisionLog: SourceState; approvals: SourceState };
  links: { langfuse?: string };
  systems: AgentSystemPanel[];
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  {
    panel: 'Guardrail violations per agent system',
    reason: 'OPA’s guardrails decision (os/guardrails/decision) is asked per knowledge workflow, not per agent principal, so its decision log cannot be attributed to an agent system. Policy denials per system are shown from the agent-authz decision log.',
  },
];

export async function agentsView(user: CurrentUser, nowMs = Date.now()): Promise<AgentsView> {
  const scope = await scopeForUser(user);
  const src = monitoringSources();
  const listed = src
    ? await src.agentSystems({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: SOURCES_MISSING };
  const rows = listed.ok ? listed.rows : [];
  const ids = rows.map((r) => r.id);
  const now = new Date(nowMs);
  const since = new Date(nowMs - AGENT_WINDOW_DAYS * 86_400_000);

  const [runs, traces, keys, decisions] = await Promise.all([
    (async () => {
      const url = configuredAgentRunsDatabaseUrl();
      if (!url) return { state: unavailable('no durable run store is configured (AGENT_RUNS_DATABASE_URL)') } as const;
      try {
        const pool = await agentRunsPool(url);
        const visibleTo = visibleToOf(scope);
        return { state: live, data: await runStats(pool, { systemIds: ids, since: new Date(nowMs - RUN_WINDOW_DAYS * 86_400_000), ...(visibleTo ? { visibleTo } : {}) }) } as const;
      } catch (e) {
        return { state: unavailable(`run store: ${(e as Error).message}`) } as const;
      }
    })(),
    systemTraceStats(ids, { from: since, to: now }),
    ids.length ? readAllKeys() : Promise.resolve({ ok: true as const, data: [] }),
    ids.length ? logsQuery(opaDecisionQuery(ids, `${AGENT_WINDOW_DAYS}d`)) : Promise.resolve({ ok: true as const, value: [], at: now.toISOString() }),
  ]);

  const traceState = traces.ok ? live : unavailable(`Langfuse: ${traces.detail}`);
  const keyState = keys.ok ? live : unavailable(`LiteLLM: ${keys.error}`);
  const opaState = decisions.ok ? live : unavailable(`VictoriaLogs: ${decisions.detail}`);
  const spend = keys.ok ? keySpendBySystem(keys.data, ids) : null;
  const policy = decisions.ok ? foldDecisions(decisions.value, ids) : null;

  const asked = new Set(ids);
  const approvals = await ensureApprovalsHydrated().then(
    () => ({ ok: true as const, pending: listApprovals({ status: 'pending' }).filter((a) => a.systemId && asked.has(a.systemId)) }),
    (e: Error) => ({ ok: false as const, error: e.message }),
  );
  const pending = approvals.ok ? approvals.pending : [];

  const systems: AgentSystemPanel[] = [];
  for (const r of rows) {
    const s = 'data' in runs ? runs.data?.get(r.id) : undefined;
    const lastFailures = s
      ? await Promise.all(
          s.lastFailures.map(async (f) => ({
            ...f,
            runUrl: `/monitoring?agent=${encodeURIComponent(r.id)}`,
            traceUrl: await traceUrlFor(f.runId, { probe: false }),
          })),
        )
      : [];
    systems.push({
      id: r.id,
      name: r.name,
      scope: r.scope,
      agentsUrl: `/agents?system=${encodeURIComponent(r.id)}`,
      ...(runs.state.state === 'live' ? { runs: { days: s?.days ?? [], failureClasses: s?.failureClasses ?? { budget_exceeded: 0, other: 0 }, lastFailures } } : {}),
      ...(traces.ok ? { traces: traces.value.get(r.id) ?? null } : {}),
      ...(spend ? { keySpendUsd: spend.has(r.id) ? spend.get(r.id)! : null } : {}),
      ...(policy ? { policy: policy.get(r.id) ?? null } : {}),
      ...(approvals.ok
        ? { approvalsWaiting: pending.filter((a) => a.systemId === r.id).map((a) => ({ id: a.id, title: a.title, tool: a.tool, createdAt: a.createdAt, ...(a.node ? { node: a.node } : {}) })) }
        : {}),
    });
  }

  return {
    view: 'agents',
    generatedAt: now.toISOString(),
    windowDays: AGENT_WINDOW_DAYS,
    runWindowDays: RUN_WINDOW_DAYS,
    sources: { inventory: listed.ok ? live : unavailable(`agent systems: ${listed.error}`), runStore: runs.state, langfuse: traceState, litellm: keyState, opaDecisionLog: opaState, approvals: approvals.ok ? live : unavailable(`approvals: ${approvals.error}`) },
    links: config.langfuseConsoleUrl ? { langfuse: config.langfuseConsoleUrl } : {},
    systems,
    notUpstream: NOT_UPSTREAM,
  };
}
