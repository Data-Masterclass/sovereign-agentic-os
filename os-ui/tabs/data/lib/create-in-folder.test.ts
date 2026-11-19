/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    A dataset can be created in a folder
 * USER STORY: As a person (or the engine acting as me) creating a dataset for a folder I chose,
 *             I want it filed there in the same act — not created at the top level and moved.
 * ARCHITECTURE:
 *   - `createDatasetService` (the one create behind the Data tab and MCP `create_dataset`)
 *     applies the same edit-scoped `moveDataset` the tab's "Move to folder" runs, right after
 *     the create. No `folder` → exactly the dataset it always made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetService } from '@tabs/data/lib/mutations-server';
import { __resetStore, getDataset, listDatasets } from '@tabs/data/lib/store';

const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };

test('create_dataset with a folder files the new dataset there; without one it stays at the top level', () => {
  __resetStore();
  const filed = createDatasetService(amir, { name: 'Processed invoices', folder: 'Finance/Processed' });
  assert.equal(filed.folder, '/Finance/Processed');
  assert.equal(getDataset(filed.id, amir).folder, '/Finance/Processed');
  assert.equal(filed.owner, 'amir');
  assert.equal(filed.tier, 'dataset', 'still the creator\'s private dataset');
  const top = createDatasetService(amir, { name: 'Plain' });
  assert.equal(top.folder, '/');
  assert.deepEqual(listDatasets(amir).mine.map((d) => d.folder).sort(), ['/', '/Finance/Processed']);
});

test('column docs are still seeded when a folder is given', () => {
  __resetStore();
  const d = createDatasetService(amir, { name: 'Orders', folder: '/sales', columns: [{ name: 'order_id', description: 'key' }] });
  assert.equal(d.folder, '/sales');
  assert.deepEqual(d.columns.map((c) => c.name), ['order_id']);
});
