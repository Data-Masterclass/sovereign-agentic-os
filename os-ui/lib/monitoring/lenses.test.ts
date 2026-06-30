/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LENS_IDS } from './types.ts';
import { correlate } from './correlate.ts';
import { deriveScope } from './scope-core.ts';
import { allMockItems } from './mock.ts';

/**
 * Scope/boundary invariants for the Monitoring ↔ Platform→Components split:
 * Monitoring is the user's artifact-observability plane; infrastructure/system
 * health moved to Platform Admin → Components.
 */

test('Monitoring renders the user lenses only — system/infra is NOT one of them', () => {
  assert.deepEqual(LENS_IDS, ['runs', 'pipelines', 'cost', 'artifacts']);
  assert.ok(!LENS_IDS.includes('system'), 'system/infra health must not be a Monitoring lens');
});

test('Components REUSES the correlation engine: the infra → pipeline → run → artifact chain still resolves from a system anchor', () => {
  // Platform → Components anchors the dependency/impact chain on a system signal
  // (admin scope sees everything), reusing the same correlate() — no duplication.
  const admin = deriveScope('admin', 'a_root', ['sales', 'finance', 'platform']);
  const c = correlate(admin, 'sys-4001', allMockItems());
  assert.ok(c, 'chain should resolve from the infra incident');
  assert.equal(c!.system?.id, 'sys-4001');
  assert.equal(c!.pipeline?.id, 'pl-3001');
  assert.equal(c!.run?.id, 'run-2002');
  assert.equal(c!.artifact?.id, 'art-6001');
});
