/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The key-drift report is scoped like the rest of Monitoring: a viewer sees the drift of
 *             the systems they may see, and nothing about any other system.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftForSystems, lastKeyReconcile, setKeyReconcile, type KeyReconcileReport } from '@core/infra/agent-key-drift';

const report = (over: Partial<KeyReconcileReport> = {}): KeyReconcileReport => ({
  at: 1, ok: true, scanned: 2, inSync: 0, notBuilt: 0, inFlight: 0, unchecked: [],
  entries: [
    { systemId: 'a', alias: 'os-a', kind: 'drift', changes: ['budget $9 → $5'], firstSeenAt: 1, action: 'alert' },
    { systemId: 'b', alias: 'os-b', kind: 'missing', changes: ['the gateway no longer holds this key'], firstSeenAt: 1, action: 'alert' },
  ],
  ...over,
});

test('only the viewer\'s systems are returned', () => {
  assert.deepEqual(driftForSystems(report(), ['a']).map((e) => e.systemId), ['a']);
  assert.deepEqual(driftForSystems(report(), []).map((e) => e.systemId), []);
  assert.deepEqual(driftForSystems(report(), ['a', 'b']).length, 2);
});

test('the slot keeps the last report; none before the first pass', () => {
  assert.equal(lastKeyReconcile(), null);
  setKeyReconcile(report());
  assert.equal(lastKeyReconcile()?.entries.length, 2);
});
