/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A directory WRITE reaches the Trino rules reconciler (B3-review-H-2)
 * USER STORY: As a reviewer I want proof that adding a user to a domain reconciles the engine's
 *             rules file — and that a burst of writes is ONE reconcile, not one per row — so
 *             "membership changes take effect without a restart" is a tested claim, not a comment.
 * ARCHITECTURE:
 *   - Drives the REAL store API (`createUser` / `updateUser` / `archiveUser`, `createDomain` /
 *     `setArchived`), so the emit cannot be faked here: it has to come from the stores' own
 *     write-through.
 *   - The reconcile step is counted and the debounce is test-sized; the periodic pass is off
 *     (`periodMs: 0`) because `core/infra/trino-rules-server.test.ts` covers it.
 *   - Lives on the TAB side because a test under `core/` may not import a tab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onDirectoryChange, _resetKernelEvents } from '@core/kernel/events';
import { startTrinoRulesReconciler, type ReconcileOutcome } from '@core/infra/trino-rules-server';
import { createUser, updateUser, archiveUser } from '@tabs/admin/lib/users';
import { createDomain, setArchived, _reset as resetDomains } from '@tabs/admin/lib/domains';

function reconciler() {
  const calls: string[] = [];
  const handle = startTrinoRulesReconciler({
    resolve: async () => ({ serviceUsers: ['dbt-runner'], principalPattern: 'x', domains: [], personalLanes: [] }),
    reconcile: async () => {
      calls.push('reconcile');
      return { ok: true, changed: false, code: 'unchanged', detail: 'x', at: Date.now() } as ReconcileOutcome;
    },
    debounceMs: 15,
    periodMs: 0,
    log: () => {},
  });
  onDirectoryChange((reason) => handle.trigger(reason));
  return { handle, calls };
}

test('a USER write reaches the reconciler — exactly once per debounce window', async () => {
  _resetKernelEvents();
  const { handle, calls } = reconciler();
  await handle.idle();
  assert.equal(calls.length, 1, 'the boot pass');

  await createUser({ id: 'rv_amir', name: 'Amir', password: 'Str0ng!Passw0rd!x', domains: ['sales'], role: 'creator', email: 'rv_amir@x.example' });
  await handle.idle();
  assert.equal(calls.length, 2, 'a user write triggered one reconcile');

  // Two writes inside one debounce window collapse into ONE reconcile — a bulk membership import
  // must not be one ConfigMap PATCH per row.
  await updateUser('rv_amir', { domains: ['sales', 'finance'] });
  await archiveUser('rv_amir');
  await handle.idle();
  assert.equal(calls.length, 3, 'two rapid writes are one reconcile');
  handle.stop();
  _resetKernelEvents();
});

test('a DOMAIN write reaches the reconciler too', async () => {
  _resetKernelEvents();
  resetDomains();
  const { handle, calls } = reconciler();
  await handle.idle();
  const before = calls.length;

  createDomain({ name: 'Review Domain', owner: 'rv_amir' });
  await handle.idle();
  assert.equal(calls.length, before + 1);

  setArchived('review-domain', true);
  await handle.idle();
  assert.equal(calls.length, before + 2, 'archiving a domain changes who owns its schema');
  handle.stop();
  _resetKernelEvents();
  resetDomains();
});
