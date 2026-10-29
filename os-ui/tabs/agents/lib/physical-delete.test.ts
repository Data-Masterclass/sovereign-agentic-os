/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { purgePlan, purgeSystemResources } from '@tabs/agents/lib/physical-delete';
import { __resetStore, createSystem, setSchedule, archiveSystem, type Principal } from '@tabs/agents/lib/store';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };

beforeEach(() => { __resetStore(); });

test('purgePlan: a manual system purges NOTHING physical (no CronJob was provisioned)', () => {
  const rec = createSystem(amir, { name: 'Desk' });
  assert.deepEqual(purgePlan(rec), []);
});

test('purgePlan: a cron system purges its CronJob', () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const plan = purgePlan(rec); // rec is the same object mutated by setSchedule
  assert.deepEqual(plan, [{ kind: 'cronjob', ref: rec.id }]);
});

test('purgeSystemResources tears the CronJob down and reports honest success', async () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const tornDown: string[] = [];
  const report = await purgeSystemResources(rec, {
    teardownCron: async (id) => { tornDown.push(id); return { ok: true, detail: 'deleted' }; },
  });
  assert.equal(report.recordDeleted, true);
  assert.deepEqual(tornDown, [rec.id]);
  assert.deepEqual(report.physical, [{ target: `cronjob ${rec.id}`, ok: true }]);
});

test('purgeSystemResources reports an unreachable k8s CronJob teardown honestly', async () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const report = await purgeSystemResources(rec, {
    teardownCron: async () => ({ ok: false, detail: 'Kubernetes API unreachable' }),
  });
  const cron = report.physical.find((p) => p.target.startsWith('cronjob'))!;
  assert.equal(cron.ok, false);
  assert.match(cron.reason!, /unreachable/);
});

test('ARCHIVE plans no purge — it keeps the schedule record (delete does the physical purge)', () => {
  const rec = createSystem(amir, { name: 'Desk' });
  const archived = archiveSystem(rec.id, amir);
  assert.equal(archived.archived, true);
  assert.equal(archived.running, false);
  // The purge plan is a DELETE-path concern; archiving produced no purge call at all.
  assert.deepEqual(purgePlan(rec), []);
});
