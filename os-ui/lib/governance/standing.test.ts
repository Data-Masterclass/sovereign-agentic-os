/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { remember, listStanding, __resetStanding } from './standing.ts';

beforeEach(() => __resetStanding());

test('globalThis pin: create survives a fresh standingStore() call', () => {
  remember({ kind: 'tool_call', payload: { tool: 'write_file' }, domain: 'sales', createdBy: 'u1', fromApproval: 'apv_1' });

  // Confirm item is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.governance.standing')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.equal(pinned.size, 1, 'one policy in the pinned map');

  // Also confirm listStanding() (which calls standingStore() afresh) sees it.
  assert.equal(listStanding().length, 1);
});
