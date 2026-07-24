/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { agentHealthRows, type AgentHealthRow } from '@/lib/agents/store';
import { listDatasets, ensureHydrated } from '@/lib/data/store';
import { type Health, combine, pipelineHealth, dqHealth, ageInDays } from './artifact-health-core';

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
};

export type AgentScopeGroups = { mine: AgentHealthRow[]; domain: AgentHealthRow[]; marketplace: AgentHealthRow[] };
export type DataScopeGroups = { mine: DataHealthRow[]; domain: DataHealthRow[]; marketplace: DataHealthRow[] };
export type ArtifactMonitoring = { agents: AgentScopeGroups; data: DataScopeGroups };

/** Build the two scoped feeds for the redesigned Monitor tab. `nowMs` is injected so
 *  the caller stamps the clock (the store layer forbids `Date.now()` in some contexts). */
export async function artifactMonitoring(user: CurrentUser, nowMs: number): Promise<ArtifactMonitoring> {
  const principal = { id: user.id, domains: user.domains, role: user.role };

  // Agents — already scoped + health-derived by the store.
  const agentRows = agentHealthRows(principal);
  const agents: AgentScopeGroups = { mine: [], domain: [], marketplace: [] };
  for (const r of agentRows) agents[r.scope].push(r);

  // Data — enumerate the caller's datasets, roll pipeline + DQ into one health.
  await ensureHydrated();
  const groups = listDatasets(principal);
  const toRow = (scope: DataHealthRow['scope']) => (d: (typeof groups.mine)[number]): DataHealthRow => {
    const anyBuilt = d.dots.bronze || d.dots.silver || d.dots.gold;
    const ageDays = ageInDays(d.freshness, nowMs);
    const pipeline = pipelineHealth(anyBuilt, ageDays);
    const dq = dqHealth(d.quality);
    return {
      id: d.id, name: d.name, scope,
      pipeline, dq, health: combine(pipeline, dq),
      quality: d.quality, freshness: d.freshness, ageDays, gold: d.dots.gold,
    };
  };
  const data: DataScopeGroups = {
    mine: groups.mine.map(toRow('mine')),
    domain: groups.domain.map(toRow('domain')),
    marketplace: groups.marketplace.map(toRow('marketplace')),
  };

  return { agents, data };
}
