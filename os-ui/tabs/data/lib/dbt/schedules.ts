/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `os/schedules.yml` + `os/external.yml` — what Dagster schedules and what dbt cannot express
 * USER STORY: As a data engineer I want each OS sync schedule written down as a selection + cron +
 *             principal entry that the Dagster code location turns into a `ScheduleDefinition`
 *             (B2), and the sources dbt cannot model (Kafka offsets, API batch) listed honestly
 *             instead of being faked as models.
 * ARCHITECTURE:
 *   - Pure renderers over the planner output. UTC always (today's CronJobs run `timeZone: UTC`);
 *     Dagster does not fire missed ticks by default, which matches the skip-missed-slot semantics.
 *   - `principal` = the dataset owner — syncs run as the owner today and keep doing so.
 */
import { yml } from '@tabs/data/lib/dbt/emit';
import type { ModelPlan, ExternalAsset } from '@tabs/data/lib/dbt/models';

export type ScheduleEntry = {
  dataset: string;
  name: string;
  select: string;
  cron: string;
  timezone: 'UTC';
  principal: string;
  enabled: boolean;
};

/** One schedule per sync-landing model (the dbt selection `<model>+` rebuilds everything downstream). */
export function scheduleEntries(models: ModelPlan[]): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  for (const m of models) {
    if (!m.kind.startsWith('sync-') || !m.dataset.sync) continue;
    out.push({
      dataset: m.dataset.id,
      name: m.name,
      select: `${m.name}+`,
      cron: m.dataset.sync.schedule.cron,
      timezone: 'UTC',
      principal: m.dataset.owner,
      enabled: m.dataset.sync.enabled,
    });
  }
  return out.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

export function renderSchedules(models: ModelPlan[]): string | null {
  const entries = scheduleEntries(models);
  if (entries.length === 0) return null;
  return yml({ version: 1, schedules: entries });
}

export function renderExternal(externals: ExternalAsset[]): string | null {
  if (externals.length === 0) return null;
  return yml({
    version: 1,
    external_assets: externals.map((e) => ({
      dataset: e.dataset,
      name: e.name,
      kind: e.kind,
      connection: e.connectionId,
      source: e.source,
      mode: e.mode,
      cron: e.cron,
      timezone: 'UTC',
      principal: e.principal,
      enabled: e.enabled,
      note: e.note,
    })),
  });
}
