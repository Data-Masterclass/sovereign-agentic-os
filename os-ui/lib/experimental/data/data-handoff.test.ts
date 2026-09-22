/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _clearHandoffs, registerBronzeSource, indexToFiles, bronzeFor, filesFor, listBronzeSources } from './data-handoff.ts';

beforeEach(() => _clearHandoffs());

test('registerBronzeSource creates a record and listBronzeSources returns it', () => {
  const src = registerBronzeSource({ connectionId: 'conn_1', name: 'Sales DB', connector: 'postgres', registeredBy: 'amir' });
  assert.equal(src.connectionId, 'conn_1');
  assert.equal(src.table, 'bronze.sales_db');
  assert.equal(listBronzeSources().length, 1);
  assert.equal(bronzeFor('conn_1')?.id, src.id);
});

test('indexToFiles creates a files index record', () => {
  const idx = indexToFiles({ connectionId: 'conn_2', name: 'Drive', indexedBy: 'sara' });
  assert.equal(idx.connectionId, 'conn_2');
  assert.equal(filesFor('conn_2')?.id, idx.id);
  assert.equal(bronzeFor('conn_2'), null);
});

test('re-registering preserves the original id', () => {
  const first = registerBronzeSource({ connectionId: 'conn_3', name: 'Ops', connector: 'mysql', registeredBy: 'tom' });
  const second = registerBronzeSource({ connectionId: 'conn_3', name: 'Ops', connector: 'mysql', rows: 999, registeredBy: 'tom' });
  assert.equal(first.id, second.id);
  assert.equal(second.rows, 999);
});

test('globalThis pin: handoff state is shared under soa.dataHandoff.state', () => {
  registerBronzeSource({ connectionId: 'conn_g', name: 'Global', connector: 'pg', registeredBy: 'x' });
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.dataHandoff.state')] as { bronze: Map<string, unknown> };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.ok(pinned.bronze.has('conn_g'), 'bronze entry must appear in globalThis state');
});
