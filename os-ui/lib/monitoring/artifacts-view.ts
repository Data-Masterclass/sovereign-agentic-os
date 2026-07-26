/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { agentHealthRows, ensureHydrated as ensureAgentsHydrated, type AgentHealthRow } from '@/lib/agents/store';
import { listDatasets, ensureHydrated } from '@/lib/data/store';
import { latestRun, ensureHydrated as ensureDqHydrated } from '@/lib/data/dq-results';
import { latestSyncRun, ensureSyncRunsHydrated } from '@/lib/data/sync-runs';
import { type Health, combine, pipelineHealth, dqHealth, ageInDays } from './artifact-health-core';
import { agentTelemetryBatch } from './adapters/agent-telemetry';
import { rollupAgentTelemetry, summarizeDq, type AgentTelemetry } from './telemetry-core';

/**
 * The ARTIFACT-CENTRIC monitoring feed — the redesigned Monitor tab. Two sections,
 * each grouped My · Domain · Company, so a user monitors the things they actually
 * built or use, not a firehose of raw signals:
 *
 *   • Agent Monitoring — every accessible agent SYSTEM + its last-run health.
 *   • Data Monitoring  — every accessible DATASET, with pipeline (freshness/build)
 *                        and data-quality (DQ) rolled into ONE health per dataset.
 *
 * Read-only, scoped to the caller's own governed lists (never widens). RAG (files +
 * knowledge) is a deliberate later addition; this covers Agents + Data.
 */

/** An agent tile: the store's health row + the real 7-day telemetry key-facts. */
export type AgentTile = AgentHealthRow & {
  /** Real 7-day rollup (cost · tokens · runs · last-run · warnings/errors). */
  telemetry: AgentTelemetry;
  /** ms epoch of the most recent run in the 7d window, or null (Langfuse+ring). */
  lastRunAt7d: number | null;
};

export type DataHealthRow = {
  id: string;
  name: string;
  scope: 'mine' | 'domain' | 'marketplace';
  /** Combined dot = the worse of pipeline + DQ (grey only when neither has a signal). */
  health: Health;
  /** Pipeline freshness/build health on its own. */
  pipeline: Health;
  /** Data-quality (DQ checks) health on its own. */
  dq: Health;
  quality: 'unknown' | 'passing' | 'failing';
  freshness: string | null;
  /** Whole-days since the furthest layer was built, or null if never built. */
  ageDays: number | null;
  gold: boolean;
  /** Real DQ from the last persisted run: how many rules, and how many violated. */
  dqRules: number;
  dqViolations: number;
  /** True once a DQ run has ever been recorded (else the tile shows neutral). */
  dqHasRun: boolean;
  /** Last scheduled-sync run time (ISO), or null when the dataset has never synced. */
  lastSync: string | null;
  /** Last sync run outcome, or null when never synced. */
  syncStatus: 'ok' | 'error' | 'skipped' | 'running' | null;
};

export type AgentScopeGroups = { mine: AgentTile[]; domain: AgentTile[]; marketplace: AgentTile[] };
export type DataScopeGroups = { mine: DataHealthRow[]; domain: DataHealthRow[]; marketplace: DataHealthRow[] };
/** True when Langfuse was reachable for the agent telemetry this call (honest degradation). */
export type ArtifactMonitoring = { agents: AgentScopeGroups; data: DataScopeGroups; telemetryLive: boolean };

/** Build the two scoped feeds for the redesigned Monitor tab. `nowMs` is injected so
 *  the caller stamps the clock (the store layer forbids `Date.now()` in some contexts). */
export async function artifactMonitoring(user: CurrentUser, nowMs: number): Promise<ArtifactMonitoring> {
  const principal = { id: user.id, domains: user.domains, role: user.role };

  // Agents — already scoped + health-derived by the store. Decorate each with the
  // REAL 7-day telemetry (one Langfuse read for the whole grid + the in-process ring).
  await ensureAgentsHydrated();
  const agentRows = agentHealthRows(principal);
  const { runsBySystem, langfuseReachable } = await agentTelemetryBatch(nowMs);
  const agents: AgentScopeGroups = { mine: [], domain: [], marketplace: [] };
  for (const r of agentRows) {
    const runs = runsBySystem.get(r.id) ?? [];
    const telemetry = rollupAgentTelemetry(runs, nowMs);
    agents[r.scope].push({ ...r, telemetry, lastRunAt7d: telemetry.lastRunAt });
  }

  // Data — enumerate the caller's datasets, roll pipeline + DQ into one health, and
  // attach the REAL DQ violation count from the last persisted DQ run per dataset.
  await ensureHydrated();
  await ensureDqHydrated().catch(() => {});
  await ensureSyncRunsHydrated().catch(() => {}); // fail-soft: no sync signal ⇒ nulls
  const groups = listDatasets(principal);
  const toRow = (scope: DataHealthRow['scope']) => (d: (typeof groups.mine)[number]): DataHealthRow => {
    const anyBuilt = d.dots.bronze || d.dots.silver || d.dots.gold;
    const ageDays = ageInDays(d.freshness, nowMs);
    const pipeline = pipelineHealth(anyBuilt, ageDays);
    const last = latestRun(d.id);
    const dqSummary = summarizeDq(last?.results ?? null);
    const dq = dqHealth(d.quality);
    const lastSyncRun = latestSyncRun(d.id);
    return {
      id: d.id, name: d.name, scope,
      pipeline, dq, health: combine(pipeline, dq),
      quality: d.quality, freshness: d.freshness, ageDays, gold: d.dots.gold,
      dqRules: dqSummary.rules, dqViolations: dqSummary.violated, dqHasRun: dqSummary.hasRun,
      lastSync: lastSyncRun?.startedAt ?? null, syncStatus: lastSyncRun?.status ?? null,
    };
  };
  const data: DataScopeGroups = {
    mine: groups.mine.map(toRow('mine')),
    domain: groups.domain.map(toRow('domain')),
    marketplace: groups.marketplace.map(toRow('marketplace')),
  };

  return { agents, data, telemetryLive: langfuseReachable };
}
