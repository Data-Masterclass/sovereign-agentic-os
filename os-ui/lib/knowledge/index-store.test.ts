/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { upsertUnits, allUnits, __resetIndex, type IndexedUnit } from './index-store.ts';

beforeEach(() => __resetIndex());

function unit(id: string, workflowId = 'wf-1'): IndexedUnit {
  return {
    id,
    title: id,
    text: 'content',
    embedding: [0.1, 0.2],
    indexedAt: new Date().toISOString(),
    provenance: { workflowId, domain: 'sales', visibility: 'Shared' },
  } as IndexedUnit;
}

test('globalThis pin: create survives a fresh idx() call', () => {
  upsertUnits('wf-1', [unit('u1'), unit('u2')]);

  // Confirm item is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.knowledge.index')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has('u1'), 'u1 visible via globalThis pin');

  // Also confirm allUnits() (which calls idx() afresh) returns the same data.
  assert.equal(allUnits().length, 2);
});
