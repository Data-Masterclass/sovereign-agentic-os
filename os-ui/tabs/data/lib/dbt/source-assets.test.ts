/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for `os/sources.yml` — observable external source assets (engine rebuild B3)
 * USER STORY: As a reviewer I want proof that every federated sync source becomes exactly one
 *             observable asset pointing at the model that reads it, that its freshness window comes
 *             from its own cron, and that a source with no resolvable catalog claims nothing.
 * ARCHITECTURE: Pure — literal `Dataset` fixtures through `planModels`, no store and no cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { planModels } from '@tabs/data/lib/dbt/models';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { cronIntervalMinutes, freshnessMinutesFor, renderSourceAssets } from '@tabs/data/lib/dbt/source-assets';

function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return {
    version: '1',
    tier: 'dataset',
    visibility: 'private',
    folder: '/',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
    viewNamespaced: true,
    ...input,
  };
}

const built = (artifact: string | null) => ({ built: true, passThrough: false, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

function syncDataset(over: Partial<Dataset> & { id: string }, sync: NonNullable<Dataset['sync']>): Dataset {
  return ds({
    name: 'Events',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    origin: 'connected',
    connected: { connectionId: sync.connectionId, exposureId: 'exp_1', source: { catalog: 'wh', schema: sync.source.schema, table: sync.source.table }, mode: 'sync', tier: 'silver', status: 'ok' },
    sync,
    versions: { ...emptyVersions(), silver: built(null) },
    ...over,
  });
}

test('cronIntervalMinutes covers the shapes the OS schedule picker produces, and only those', () => {
  assert.equal(cronIntervalMinutes('*/15 * * * *'), 15);
  assert.equal(cronIntervalMinutes('*/5 * * * *'), 5);
  assert.equal(cronIntervalMinutes('0 * * * *'), 60);
  assert.equal(cronIntervalMinutes('30 */4 * * *'), 240);
  assert.equal(cronIntervalMinutes('0 6 * * *'), 1440);
  assert.equal(cronIntervalMinutes('0 6 * * 1'), 10080);
  // Richer expressions: no claim rather than a wrong one.
  assert.equal(cronIntervalMinutes('0 6 1 * *'), null);
  assert.equal(cronIntervalMinutes('H/5 * * * *'), null);
  assert.equal(cronIntervalMinutes('0 6 * *'), null);
  assert.equal(cronIntervalMinutes('*/0 * * * *'), null);
  assert.equal(freshnessMinutesFor('*/15 * * * *'), 30, 'two intervals of tolerance');
  assert.equal(freshnessMinutesFor('0 6 1 * *'), null);
});

test('one observable asset per federated sync source, pointing at the model that reads it', () => {
  const events = syncDataset({ id: 'ds_events01' }, {
    connectionId: 'conn_wh',
    source: { schema: 'public', table: 'events' },
    mode: 'append',
    cursor: { kind: 'timestamp', column: 'updated_at' },
    schedule: { cron: '*/15 * * * *' },
    enabled: true,
  });
  const snap: ProjectSnapshot = { domain: 'sales', datasets: [{ dataset: events, artifacts: {} }], catalogs: { conn_wh: 'wh' } };
  const plan = planModels(snap);
  assert.equal(plan.sourceAssets.length, 1);
  assert.deepEqual(plan.sourceAssets[0], {
    source: 'wh__public',
    table: 'events',
    database: 'wh',
    schema: 'public',
    dataset: 'ds_events01',
    principal: 'bea',
    model: 'silver_events',
    mode: 'append',
    observe: 'max_updated',
    updatedColumn: 'updated_at',
    cron: '*/15 * * * *',
    freshnessMinutes: 30,
    enabled: true,
  });
  // The model really does read that source — the lineage edge is not asserted, it is generated.
  const model = plan.models.find((m) => m.name === 'silver_events')!;
  assert.match(model.sql, /\{\{ source\('wh__public', 'events'\) \}\}/);
});

test('a non-timestamp cursor observes the row count; an unresolved catalog claims nothing', () => {
  const byVersion = syncDataset({ id: 'ds_a0000001', name: 'Accounts' }, {
    connectionId: 'conn_wh',
    source: { schema: 'public', table: 'accounts' },
    mode: 'merge',
    cursor: { kind: 'number', column: 'version' },
    mergeKeys: ['account_id'],
    schedule: { cron: '0 6 * * *' },
    enabled: true,
  });
  const unresolved = syncDataset({ id: 'ds_b0000001', name: 'Mystery', connected: undefined, origin: undefined }, {
    connectionId: 'conn_x',
    source: { schema: 's', table: 't' },
    mode: 'full-refresh',
    schedule: { cron: '0 0 * * *' },
    enabled: true,
  });
  const plan = planModels({
    domain: 'sales',
    datasets: [{ dataset: byVersion, artifacts: {} }, { dataset: unresolved, artifacts: {} }],
    catalogs: { conn_wh: 'wh' },
  });
  assert.deepEqual(plan.sourceAssets.map((a) => [a.table, a.observe, a.updatedColumn]), [['accounts', 'row_count', undefined]]);
  assert.ok(!plan.sourceAssets.some((a) => a.schema === 's'), 'an unresolved catalog has nothing to probe');
});

test('renderSourceAssets is sorted, stable, and null when there is nothing to observe', () => {
  assert.equal(renderSourceAssets([]), null);
  const entry = {
    source: 'wh__public', table: 'z', database: 'wh', schema: 'public', dataset: 'ds_1', principal: 'bea',
    model: 'silver_z', mode: 'append' as const, observe: 'row_count' as const, cron: '0 * * * *',
    freshnessMinutes: 120, enabled: true,
  };
  const two = renderSourceAssets([entry, { ...entry, table: 'a', model: 'silver_a' }])!;
  const doc = yaml.load(two) as { version: number; source_assets: { table: string }[] };
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.source_assets.map((e) => e.table), ['a', 'z']);
  assert.equal(renderSourceAssets([entry, { ...entry, table: 'a', model: 'silver_a' }]), two);
  assert.doesNotMatch(two, /password|secret|token/i);
});
