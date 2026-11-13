/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `os/sources.yml` — one OBSERVABLE Dagster asset per external source a sync reads
 * USER STORY: As a data engineer I want the warehouse table my sync copies to be a node in the asset
 *             graph with its own freshness, not an invisible edge — so the lineage is complete and
 *             "the source has not moved in three hours" is a check, not a guess (checklist D7, D16).
 * ARCHITECTURE:
 *   - Pure planner output. `planModels` records one entry per FEDERATED sync source (a Trino catalog
 *     that is not `iceberg`); this module renders it. The Iceberg Bronze landing is NOT one: it is
 *     written by the data-runner inside the same lakehouse and already carries `_loaded_at`
 *     freshness as a dbt source.
 *   - The asset KEY must be the key dagster-dbt derives for the dbt source — `[<domain>, <source>,
 *     <table>]` under the OS's prefixing translator — or the observation would create a second,
 *     parallel node instead of describing the one the silver model depends on.
 *   - `observe` says WHICH probe the code location runs: `max_updated` where the sync has a
 *     timestamp cursor (the same column the incremental model filters on), else `row_count`. The
 *     SQL itself is built in `os_projects.py` so the probe is validated where it runs.
 *   - `freshnessMinutes` = two schedule intervals: one missed tick is normal jitter, two is late.
 *     Derived from the cron here (pure, tested) so the Python side needs no cron parser.
 */
import { yml } from '@tabs/data/lib/dbt/emit';
import type { SourceAssetEntry } from '@tabs/data/lib/dbt/models';

/**
 * The interval between two ticks of a cron the OS writes, in minutes — `null` when the expression
 * is richer than the shapes the OS's own schedule picker produces.
 */
export function cronIntervalMinutes(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, , dow] = f;
  const step = (field: string): number | null => {
    const m = /^\*\/(\d{1,4})$/.exec(field);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const fixed = (field: string): boolean => /^\d{1,2}(,\d{1,2})*$/.test(field);
  const minStep = step(min);
  if (minStep && hour === '*') return minStep;
  if (!fixed(min) && min !== '*') return null;
  const hourStep = step(hour);
  if (hourStep) return hourStep * 60;
  if (hour === '*') return 60;
  if (!fixed(hour)) return null;
  if (dom === '*' && dow === '*') return 1440;
  if (dom === '*' && fixed(dow)) return 10080;
  return null;
}

/** Two intervals of tolerance; `null` when the cron shape is unknown (no freshness claim then). */
export function freshnessMinutesFor(cron: string): number | null {
  const i = cronIntervalMinutes(cron);
  return i === null ? null : i * 2;
}

/** Render `os/sources.yml`. Returns null when the project reads no external source. */
export function renderSourceAssets(entries: SourceAssetEntry[]): string | null {
  if (entries.length === 0) return null;
  return yml({
    version: 1,
    source_assets: [...entries]
      .sort((a, b) => `${a.source}::${a.table}`.localeCompare(`${b.source}::${b.table}`))
      .map((e) => ({
        source: e.source,
        table: e.table,
        ...(e.database ? { database: e.database } : {}),
        schema: e.schema,
        dataset: e.dataset,
        principal: e.principal,
        downstream: e.model,
        mode: e.mode,
        observe: e.observe,
        ...(e.updatedColumn ? { updated_column: e.updatedColumn } : {}),
        cron: e.cron,
        timezone: 'UTC',
        ...(e.freshnessMinutes === null ? {} : { freshness_minutes: e.freshnessMinutes }),
        enabled: e.enabled,
      })),
  });
}
