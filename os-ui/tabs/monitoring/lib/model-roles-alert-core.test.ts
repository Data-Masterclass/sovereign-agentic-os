/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: the model roles are not mapped
 * USER STORY: As a platform admin a first role mapping that keeps failing is a critical alert, gone once mapped.
 * ARCHITECTURE: pure over the retry status of `core/models/role-seed-retry.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRolesAlerts } from '@tabs/monitoring/lib/model-roles-alert-core';
import { PERSISTENT_AFTER, type RoleSeedStatus } from '@core/models/role-seed-retry';

const persistent: RoleSeedStatus = { state: 'persistent', attempts: PERSISTENT_AFTER, failures: PERSISTENT_AFTER, lastState: 'unreadable', lastError: 'LiteLLM catalog: timeout after 12000ms', firstFailureAt: 0, nextAttemptAt: 60_000 };

test('a persistent first-mapping failure is a critical, admin-only Monitoring alert', () => {
  const [a, ...rest] = modelRolesAlerts(persistent, false);
  assert.equal(rest.length, 0);
  assert.equal(a.id, 'al-model-roles-not-mapped');
  assert.equal(a.severity, 'critical');
  assert.equal(a.title, 'Model roles not mapped');
  assert.equal(a.cluster, true);
  assert.equal(a.source, 'live');
  assert.match(a.detail, /timeout after 12000ms/);
});

test('no alert while still in the first attempts, once mapped, or with no status (gateway not configured)', () => {
  assert.deepEqual(modelRolesAlerts({ ...persistent, state: 'running', failures: 1 }, false), []);
  assert.deepEqual(modelRolesAlerts(persistent, true), []);
  assert.deepEqual(modelRolesAlerts({ ...persistent, state: 'mapped' }, false), []);
  assert.deepEqual(modelRolesAlerts(null, false), []);
});
