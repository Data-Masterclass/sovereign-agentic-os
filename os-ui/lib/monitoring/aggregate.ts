/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import { recentTraces } from '@/lib/agent-governed';
import { listCaps, getSpend } from '@/lib/governance/cost';
import { collectRuns } from './adapters/run-trace';
import { collectPipelines } from './adapters/pipeline-health';
import { collectCost } from './adapters/cost';
import { collectArtifacts } from './adapters/artifact-health';
import { filterScope, scopeForUser } from './scope';
import { pickAttention, summarize } from './rollup';
import { deriveAlerts, type AlertTraceInput, type AlertCapInput } from './alerts-derive';
import { LENS_IDS, type HealthItem, type LensSummary, type Overview, type Scope } from './types';

/**
 * OPA-SCOPED MULTI-SOURCE AGGREGATION (the Opus core). Fans out to the five
 * read-only adapters IN PARALLEL, applies the SINGLE scope filter to every signal
 * (so each lens shows only what the viewer's identity entitles), then uses the
 * pure roll-up to order everything attention-first (the few red/amber lead — NOT
 * a wall of green).
 *
 * Alerts here are OPERATIONAL only (system/run health → self-heal-or-notify).
 * Business/KPI alerts are excluded by construction — they live in Dashboards.
 */

/**
 * Collect the user-facing lenses (runs · pipelines · cost · artifacts) in
 * parallel — the signals Monitoring renders + correlates. System/infra health is
 * deliberately NOT here: it belongs to Platform→Components, which collects it via
 * `collectSystem` directly (so the same adapter is reused, never duplicated).
 */
export async function collectAll(): Promise<HealthItem[]> {
  const [runs, pipelines, cost, artifacts] = await Promise.all([
    collectRuns(),
    collectPipelines(),
    collectCost(),
    collectArtifacts(),
  ]);
  return [...runs, ...pipelines, ...cost, ...artifacts];
}

/** The scoped, attention-first overview the UI renders in one fetch. */
export async function buildOverview(user: CurrentUser): Promise<Overview> {
  const scope = await scopeForUser(user);
  const all = await collectAll();
  const visible = filterScope(scope, all);

  const lenses: LensSummary[] = LENS_IDS.map((id) =>
    summarize(id, visible.filter((it) => it.lens === id)),
  );
  const attention = pickAttention(visible);
  const alerts = scopedAlerts(scope);

  return { scope, lenses, attention, alerts, generatedAt: new Date().toISOString() };
}

/**
 * Operational alerts derived from REAL in-process signals — no mocks.
 * Sources: failed/denied runs (governed-run ring) + cost-cap breaches (governance
 * cost store). If neither source has anything, returns [] (honest empty).
 */
function scopedAlerts(scope: Scope) {
  const traces: AlertTraceInput[] = recentTraces(50).map((r) => ({
    id: r.id,
    principal: r.principal,
    tool: r.tool,
    decision: r.decision,
    output: r.output,
  }));

  const caps: AlertCapInput[] = listCaps().map((c) => ({
    id: c.id,
    scope: c.scope,
    subject: c.subject,
    limit: c.limit,
    period: c.period,
    modelClass: c.modelClass,
    createdBy: c.createdBy,
    spent: getSpend(c.scope, c.subject, c.modelClass),
  }));

  return deriveAlerts(traces, caps, scope);
}
