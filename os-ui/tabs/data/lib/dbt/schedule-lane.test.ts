/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A sync schedule selects only models in its owner's own lane
 * USER STORY: As a data owner I want my schedule to run my models, not another person's: a model that
 *             another person put downstream of my landing table needs its own schedule and owner.
 * ARCHITECTURE:
 *   - `scheduleEntries` writes the dbt selection of each sync schedule. A personal-lane landing is
 *     intersected with its own directory (`<model>+,path:models/personal/<uid>`); a domain-lane landing
 *     keeps the owner's models (`config.meta.os_owner:<uid>`) and excludes every personal directory
 *     (`dbt_exclude`, dagster-dbt's `build_dbt_asset_selection`). Selection semantics were checked with
 *     `dbt ls` 1.9.11 in the Dagster image (images/extensions/dagster/tests/image/lane_select.sh).
 *   - The native generator and the legacy `os/schedules.yml` carry the same two fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEntries } from '@tabs/data/lib/dbt/schedules';
import type { ModelPlan } from '@tabs/data/lib/dbt/models';

function plan(over: Partial<ModelPlan> & { owner: string }): ModelPlan {
  const { owner, ...rest } = over;
  return {
    name: 'silver_events', path: 'models/silver/silver_events.sql', dir: 'models/silver', layer: 'silver', kind: 'sync-append',
    schema: 'sales', tested: true, sql: '',
    dataset: { id: 'ds_events01', owner, sync: { schedule: { cron: '0 * * * *' }, enabled: true } },
    ...rest,
  } as unknown as ModelPlan;
}

test('a personal-lane landing selects only its own lane directory', () => {
  const [e] = scheduleEntries([plan({ owner: 'bea', name: 'bronze_events', dir: 'models/personal/bea', path: 'models/personal/bea/bronze_events.sql', schema: 'personal_bea', layer: 'bronze' })]);
  assert.equal(e.select, 'bronze_events+,path:models/personal/bea');
  assert.equal(e.exclude, undefined);
});

test('a domain-lane landing keeps only the owner\'s models and excludes every personal lane', () => {
  const [e] = scheduleEntries([plan({ owner: 'bea' })]);
  assert.equal(e.select, 'silver_events+,config.meta.os_owner:bea');
  assert.equal(e.exclude, 'path:models/personal');
});

test('NEGATIVE TWIN: another owner\'s personal lane is never inside either selection', () => {
  const mine = scheduleEntries([plan({ owner: 'bea', name: 'bronze_a', dir: 'models/personal/bea', path: 'models/personal/bea/bronze_a.sql', schema: 'personal_bea', layer: 'bronze' })])[0];
  assert.doesNotMatch(mine.select, /personal\/amir/);
  assert.match(mine.select, /,path:models\/personal\/bea$/, 'an intersection with the owner\'s own directory');
  const dom = scheduleEntries([plan({ owner: 'bea' })])[0];
  assert.equal(dom.exclude, 'path:models/personal', 'models/personal/amir is under the excluded path');
  assert.match(dom.select, /,config\.meta\.os_owner:bea$/, 'a shared-path model of another owner is outside the selection');
});
