/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { upsertUnits, removeUnits, allUnits, hasWorkflowUnits, __resetIndex, type IndexedUnit } from './index-store.ts';

function unit(id: string, workflowId: string): IndexedUnit {
  return {
    id, title: id, text: 't', type: 'workflow',
    provenance: { domain: 'sales', workflowId, stepId: 's', type: 'workflow', actor: 'a', owner: 'o', version: '1', visibility: 'Shared', trust: 0.7, authority: 0.7, updatedAt: '2026-01-01' },
    embedding: [0.1], indexedAt: '2026-01-01',
  } as unknown as IndexedUnit;
}

beforeEach(() => __resetIndex());

test('removeUnits purges exactly the deleted workflow, leaving others retrievable', () => {
  upsertUnits('wf_a', [unit('u1', 'wf_a'), unit('u2', 'wf_a')]);
  upsertUnits('wf_b', [unit('u3', 'wf_b')]);
  assert.equal(allUnits().length, 3);
  removeUnits('wf_a'); // the physical-delete side (offline mirror)
  assert.equal(hasWorkflowUnits('wf_a'), false, 'deleted workflow no longer retrievable');
  assert.equal(hasWorkflowUnits('wf_b'), true, 'other workflow untouched');
  assert.equal(allUnits().length, 1);
});
