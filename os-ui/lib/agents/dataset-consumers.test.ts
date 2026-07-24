/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createSystem, getSystemsUsingDataset, type Principal } from './store.ts';

// Reverse lookup: which agent systems hold a per-ITEM data grant on a dataset id.
// A folder grant (id: '') must NOT count — it targets a subtree, not this item.

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function yamlWithData(name: string, dataGrants: string): string {
  return [
    `system: { name: ${name}, domain: sales, visibility: Personal }`,
    'entrypoint: a',
    `grants: { data: [${dataGrants}], knowledge: [], tools: [], connections: [] }`,
    'agents: [{ id: a, role: does stuff }]',
  ].join('\n');
}

beforeEach(() => __resetStore());

test('lists a system that grants the exact dataset id (per-item grant)', () => {
  createSystem(amir, { name: 'uses_ds', yaml: yamlWithData('uses_ds', '{ id: ds_sales, capability: Read }') });
  const found = getSystemsUsingDataset('ds_sales', amir);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'uses_ds');
});

test('does NOT list a system granting a different dataset', () => {
  createSystem(amir, { name: 'other', yaml: yamlWithData('other', '{ id: ds_other, capability: Read }') });
  assert.equal(getSystemsUsingDataset('ds_sales', amir).length, 0);
});

test('a FOLDER data grant (no item id) is NOT a match', () => {
  createSystem(amir, { name: 'folder', yaml: yamlWithData('folder', '{ folder: { path: /, scope: personal }, capability: Read }') });
  assert.equal(getSystemsUsingDataset('ds_sales', amir).length, 0);
});

test('a system with no data grants is NOT a match', () => {
  createSystem(amir, { name: 'empty', yaml: yamlWithData('empty', '') });
  assert.equal(getSystemsUsingDataset('ds_sales', amir).length, 0);
});

test('visibility holds — a stranger sees no personal systems', () => {
  createSystem(amir, { name: 'uses_ds', yaml: yamlWithData('uses_ds', '{ id: ds_sales, capability: Read }') });
  const stranger: Principal = { id: 'zed', domains: [], role: 'creator' };
  assert.equal(getSystemsUsingDataset('ds_sales', stranger).length, 0);
});
