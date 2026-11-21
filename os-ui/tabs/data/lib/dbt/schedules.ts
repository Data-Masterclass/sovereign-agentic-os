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
import { standingGrantId } from '@core/policy/run-grant-ids';

export type ScheduleEntry = {
  dataset: string;
  name: string;
  select: string;
  /**
   * The OS-generated models of this schedule's owner: the only models the run may select (the legacy
   * loader intersects the downstream with it). Not author-writable, unlike a model's own `meta`.
   */
  models?: string[];
  /** The same models as exact project file paths: what the selection uses (a bare name equal to a directory selects the directory). */
  paths?: string[];
  cron: string;
  timezone: 'UTC';
  principal: string;
  enabled: boolean;
  /** WP-15: the schedule's standing run grant id, when the deployment runs Dagster with run grants. */
  run_grant?: string;
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
      models: models.filter((x) => x.dataset.owner === m.dataset.owner).map((x) => x.name).sort(),
      paths: models.filter((x) => x.dataset.owner === m.dataset.owner).map((x) => x.path).sort(),
      cron: m.dataset.sync.schedule.cron,
      timezone: 'UTC',
      principal: m.dataset.owner,
      enabled: m.dataset.sync.enabled,
    });
  }
  return out.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

/**
 * `domain` + `runGrants` (WP-15): each ENABLED entry names its standing grant id, which the
 * Dagster wrapper stamps on the run as `os/run_grant`; the OS creates the grant rows on commit
 * (`reconcileStandingGrants`). Without `runGrants` the file is byte-identical to before.
 */
export function renderSchedules(models: ModelPlan[], opts: { domain?: string; runGrants?: boolean } = {}): string | null {
  const entries = scheduleEntries(models).map((e) =>
    opts.runGrants && opts.domain && e.enabled ? { ...e, run_grant: standingGrantId(opts.domain, e.dataset, e.principal, e.name) } : e,
  );
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
