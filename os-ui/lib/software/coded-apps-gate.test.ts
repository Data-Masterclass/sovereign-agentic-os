/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * os-ui 0.6.133 — CODED APPS OFF BY DEFAULT (platform-admin gated).
 *
 * The create-gate is the SERVER-SIDE fail-closed boundary: when the platform admin
 * has coded apps OFF (the default), createApp must REJECT a coded app (`kind:'code'`)
 * from any front door, while a DECLARATIVE (spec) app is always allowed. When ON, a
 * coded app creates as before. The UI is not the gate — this proves the library is.
 *
 * The shared test harness (scripts/test-setup.mjs) enables coded apps process-wide;
 * each test here sets the flag explicitly and the final restore returns it to ON so
 * sibling coded-path suites are unaffected regardless of file ordering.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Offline-stub fetch so the app registry initialises an empty in-process Map (parity
// with apps.test.ts) — no cluster/OpenSearch is needed to exercise the pure gate.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, __resetAppsCache, serveModeOf } = await import('./apps.ts');
const { updateSettings, codedAppsEnabled } = await import('../platform-admin/settings.ts');

const user = { id: 'ug1', name: 'Gate User', domains: ['sales'], role: 'admin' as const };

// Restore the harness default (coded ON) after every test so other suites are safe.
afterEach(() => { updateSettings({ codedAppsEnabled: true }); });

test('coded apps OFF: creating a CODED app is rejected 403', async () => {
  __resetAppsCache();
  updateSettings({ codedAppsEnabled: false });
  assert.equal(codedAppsEnabled(), false);
  await assert.rejects(
    () => createApp(user, { name: 'Coded When Off', kind: 'code' }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /disabled by the platform administrator/i);
      return true;
    },
  );
});

test('coded apps OFF: an app with NO kind (defaults to code) is also rejected', async () => {
  __resetAppsCache();
  updateSettings({ codedAppsEnabled: false });
  await assert.rejects(
    () => createApp(user, { name: 'Default Kind When Off' }),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('coded apps OFF: a DECLARATIVE (spec) app is ALWAYS allowed', async () => {
  __resetAppsCache();
  updateSettings({ codedAppsEnabled: false });
  const app = await createApp(user, { name: 'Spec When Off', kind: 'spec' });
  assert.equal(serveModeOf(app), 'spec');
});

test('coded apps ON: a coded app creates as before', async () => {
  __resetAppsCache();
  updateSettings({ codedAppsEnabled: true });
  const app = await createApp(user, { name: 'Coded When On', kind: 'code', template: 'empty' });
  assert.equal(serveModeOf(app), 'image');
});

test('restore real fetch', () => {
  globalThis.fetch = _realFetch;
});
