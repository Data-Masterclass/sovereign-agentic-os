/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Live schedule and sensor state from Dagster for Monitoring (read only)
 * ARCHITECTURE: one GraphQL read (`instigatorStates`), the OS's own expectation (sync enabled) from
 *   the store, then the pure core. An unreadable Dagster gives a warning alert and no items.
 */
import 'server-only';
import type { Alert, HealthItem } from '@tabs/monitoring/lib/types';
import { config } from '@core/kernel/config';
import { dagsterConfigured, instigatorStates, scheduleNameFor, type InstigatorStatus } from '@core/infra/dagster';
import { listAllDatasets } from '@tabs/data/lib/store';
import { listRepos } from '@core/infra/git-store';
import { dagsterStateAlerts, dagsterStateItems, type ExpectedSchedule } from '@tabs/monitoring/lib/dagster-state-core';

let memo: { at: number; value: Promise<{ items: HealthItem[]; alerts: Alert[] }> } | null = null;
/** One Dagster read per overview: items and alerts share it for a few seconds. */
export function collectDagsterState(deps: Parameters<typeof readDagsterState>[0] = {}): Promise<{ items: HealthItem[]; alerts: Alert[] }> {
  if (deps.read) return readDagsterState(deps);
  if (!memo || Date.now() - memo.at > 10_000) memo = { at: Date.now(), value: readDagsterState(deps) };
  return memo.value;
}

async function readDagsterState(deps: { read?: () => Promise<{ ok: true; data: InstigatorStatus[] } | { ok: false; error: string }> } = {}): Promise<{ items: HealthItem[]; alerts: Alert[] }> {
  if (!config.dataProjectGit || !dagsterConfigured()) return { items: [], alerts: [] };
  const r = await (deps.read ?? (() => instigatorStates({ timeoutMs: 3000 })))();
  if (!r.ok) return { items: [], alerts: dagsterStateAlerts(null, r.error) };
  const domains = await listRepos().then((x) => x.map((y) => y.name)).catch(() => [] as string[]);
  const expected = new Map<string, ExpectedSchedule>();
  for (const d of listAllDatasets()) if (d.sync?.enabled && d.domain) expected.set(scheduleNameFor(d.domain, d.id, domains), { domain: d.domain, owner: d.owner, datasetId: d.id });
  return { items: dagsterStateItems(r.data, expected), alerts: dagsterStateAlerts(r.data) };
}
