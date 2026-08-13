/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * change-summary.test — the deterministic Publish diff (os-ui 0.6.135). Proves the summary
 * reports added/removed/changed tabs + rename + description honestly, "Initial publish" on the
 * first publish, and "No changes" when the specs are behaviourally identical. Pure — no stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeSpecChange, autoVersionName } from './change-summary.ts';
import type { AppSpec } from './schema.ts';

function tab(id: string, label: string, datasetId: string): AppSpec['tabs'][number] {
  return {
    id,
    label,
    body: {
      kind: 'pattern',
      pattern: 'records-table',
      config: { source: { datasetId }, columns: [{ field: 'order_id' }] },
    },
  } as AppSpec['tabs'][number];
}

function spec(name: string, tabs: AppSpec['tabs']): AppSpec {
  return { version: 2, name, description: 'x', tabs } as AppSpec;
}

test('summarizeSpecChange: first publish reports the tab count', () => {
  const s = spec('App', [tab('t1', 'Orders', 'ds1'), tab('t2', 'Invoices', 'ds1')]);
  assert.equal(summarizeSpecChange(null, s), 'Initial publish — 2 tabs');
  assert.equal(summarizeSpecChange(null, spec('App', [tab('t1', 'Orders', 'ds1')])), 'Initial publish — 1 tab');
});

test('summarizeSpecChange: identical specs → No changes', () => {
  const s = spec('App', [tab('t1', 'Orders', 'ds1')]);
  const clone = spec('App', [tab('t1', 'Orders', 'ds1')]);
  assert.equal(summarizeSpecChange(s, clone), 'No changes');
});

test('summarizeSpecChange: added + removed tabs are named', () => {
  const before = spec('App', [tab('t1', 'Orders', 'ds1'), tab('t2', 'Calendar', 'ds1')]);
  const after = spec('App', [tab('t1', 'Orders', 'ds1'), tab('t3', 'Invoices', 'ds1')]);
  const summary = summarizeSpecChange(before, after);
  assert.match(summary, /added Invoices tab/i);
  assert.match(summary, /removed Calendar tab/i);
});

test('summarizeSpecChange: a changed tab (different data source) is reported', () => {
  const before = spec('App', [tab('t1', 'Orders', 'ds1')]);
  const after = spec('App', [tab('t1', 'Orders', 'ds2')]);
  assert.match(summarizeSpecChange(before, after), /changed Orders tab/i);
});

test('summarizeSpecChange: a rename is reported', () => {
  const before = spec('App', [tab('t1', 'Orders', 'ds1')]);
  const after = spec('Renamed App', [tab('t1', 'Orders', 'ds1')]);
  assert.match(summarizeSpecChange(before, after), /renamed to "Renamed App"/i);
});

test('autoVersionName: is a monotonic v-label', () => {
  assert.equal(autoVersionName(1), 'v1');
  assert.equal(autoVersionName(7), 'v7');
});
