/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The agent worker sees metrics defined, archived and deleted in the web app after it booted
 * USER STORY: As a builder I define, archive or delete a metric; an agent run a minute later that
 *             lists or queries metrics sees exactly that, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - A metric is a measure on a dataset (data store) plus a lifecycle overlay (archive flag,
 *     folder: `tabs/metrics/lib/lifecycle.ts`). Both are refreshed in the worker. The shared
 *     scenarios (`core/infra/worker-refresh-suite.ts`) run with a metric's dataset as the item;
 *     two more cover a measure removed and a metric archived in the web app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMetrics, getMetric } from '@tabs/metrics/lib/store';
import * as lifecycle from '@tabs/metrics/lib/lifecycle';
import { workerRefreshSuite, later } from '@core/infra/worker-refresh-suite';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';
import { config } from '@core/kernel/config';

// A metric IS a measure on a dataset, so the scenarios drive the data store the metrics store reads.
const data = await import('@tabs/data/lib/store');

const amir: import('@tabs/data/lib/store').Principal = { id: 'amir', domains: ['sales'], role: 'builder' };
const KEYS = [Symbol.for('soa.data.store'), Symbol.for('soa.metrics.lifecycle')];
const seen = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
const metricIds = () => [...listMetrics(amir).mine, ...listMetrics(amir).domain].map((m) => m.id);

/** A Gold dataset with a `revenue` measure; returns the METRIC id. */
function defineMetric(label: string): string {
  const d = data.createDataset(amir, { name: label });
  data.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  data.buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  data.buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  data.transition(d.id, amir, 'promote');
  data.defineMeasure(d.id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  return `${d.id}.revenue`;
}
const datasetOf = (metricId: string) => metricId.slice(0, metricId.lastIndexOf('.'));
const read = () => Promise.all([data.ensureHydrated(), lifecycle.ensureHydrated()]);
const enable = () => data.enableMirrorRefresh() && lifecycle.enableMirrorRefresh();
const reset = () => {
  data.__resetStore();
  lifecycle.__resetLifecycle();
};

workerRefreshSuite({
  name: 'metrics',
  keys: KEYS,
  index: config.datasetsIndex,
  reset,
  read,
  enable,
  create: (label) => datasetOf(defineMetric(label)),
  remove: (id) => { data.deleteDataset(id, amir); },
  visible: (id) => metricIds().includes(`${id}.revenue`),
  edit: (id, value) => { data.setMeasureLabel(id, amir, 'revenue', value); },
  marker: (id) => seen(() => getMetric(`${id}.revenue`, amir))?.measure.label,
});

async function bootWithMetric() {
  const os = fakeCluster();
  reset();
  const web = proc();
  const worker = proc(true);
  const id = await as(web, KEYS, async () => {
    await read();
    return defineMetric('Orders');
  });
  await as(worker, KEYS, async () => {
    assert.equal(enable(), true);
    await read();
  });
  return { os, web, worker, id };
}

test('metrics: a measure removed in the web app is gone from the worker after one refresh', async () => {
  const { os, web, worker, id } = await bootWithMetric();
  try {
    assert.ok(await as(worker, KEYS, () => metricIds().includes(id)), 'the worker lists it at boot');
    await as(web, KEYS, () => lifecycle.deleteMetric(id, amir));
    later();
    assert.equal(await as(worker, KEYS, async () => { await read(); return metricIds().includes(id); }), false);
  } finally {
    os.restore();
    reset();
  }
});

test('metrics: a metric archived in the web app is archived in the worker after one refresh', async () => {
  const { os, web, worker, id } = await bootWithMetric();
  try {
    await as(web, KEYS, () => lifecycle.archiveMetric(id, amir));
    later();
    assert.equal(await as(worker, KEYS, async () => { await read(); return lifecycle.isMetricArchived(id); }), true);
  } finally {
    os.restore();
    reset();
  }
});
