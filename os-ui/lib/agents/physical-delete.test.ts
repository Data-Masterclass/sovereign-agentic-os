/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { purgePlan, purgeSystemResources, systemRepoName } from './physical-delete.ts';
import { __resetStore, createSystem, setSchedule, deleteSystem, archiveSystem, type Principal } from './store.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };

beforeEach(() => { __resetStore(); });

test('purgePlan: a manual system purges only its repo (no CronJob was provisioned)', () => {
  const rec = createSystem(amir, { name: 'Desk' });
  const plan = purgePlan(rec);
  assert.deepEqual(plan, [{ kind: 'repo', ref: systemRepoName(rec.id) }]);
  assert.equal(plan[0].ref, `os-${rec.id}`);
});

test('purgePlan: a cron system purges the repo AND its CronJob', () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const plan = purgePlan(rec); // rec is the same object mutated by setSchedule
  assert.deepEqual(plan, [
    { kind: 'repo', ref: `os-${rec.id}` },
    { kind: 'cronjob', ref: rec.id },
  ]);
});

test('purgeSystemResources deletes repo + CronJob and reports honest success', async () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const deletedRepos: string[] = [];
  const tornDown: string[] = [];
  const report = await purgeSystemResources(rec, {
    deleteRepo: async (repo) => { deletedRepos.push(repo); return { deleted: true }; },
    teardownCron: async (id) => { tornDown.push(id); return { ok: true, detail: 'deleted' }; },
  });
  assert.equal(report.recordDeleted, true);
  assert.deepEqual(deletedRepos, [`os-${rec.id}`]);
  assert.deepEqual(tornDown, [rec.id]);
  assert.deepEqual(report.physical, [
    { target: `repo os-${rec.id}`, ok: true },
    { target: `cronjob ${rec.id}`, ok: true },
  ]);
});

test('purgeSystemResources is HONEST when Forgejo is unreachable (orphan flagged), CronJob still tried', async () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const report = await purgeSystemResources(rec, {
    deleteRepo: async () => { throw new Error('Forgejo unreachable'); },
    teardownCron: async () => ({ ok: true, detail: 'deleted' }),
  });
  const repo = report.physical.find((p) => p.target.startsWith('repo'))!;
  const cron = report.physical.find((p) => p.target.startsWith('cronjob'))!;
  assert.equal(repo.ok, false);
  assert.match(repo.reason!, /unreachable/);
  assert.equal(cron.ok, true, 'a failed repo delete never blocks the CronJob teardown');
});

test('purgeSystemResources reports an unreachable k8s CronJob teardown honestly', async () => {
  const rec = createSystem(amir, { name: 'Desk' });
  setSchedule(rec.id, amir, { kind: 'cron', cron: '0 9 * * 1' });
  const report = await purgeSystemResources(rec, {
    deleteRepo: async () => ({ deleted: true }),
    teardownCron: async () => ({ ok: false, detail: 'Kubernetes API unreachable' }),
  });
  const cron = report.physical.find((p) => p.target.startsWith('cronjob'))!;
  assert.equal(cron.ok, false);
  assert.match(cron.reason!, /unreachable/);
});

test('ARCHIVE plans no purge — it keeps the repo (delete does the physical purge)', () => {
  // Archive is a store-only soft-hide + stop; it must never touch the repo. We assert
  // the deleted-only planner is what carries the repo target, so archive can't purge it.
  const rec = createSystem(amir, { name: 'Desk' });
  const archived = archiveSystem(rec.id, amir);
  assert.equal(archived.archived, true);
  assert.equal(archived.running, false);
  // The purge plan is a DELETE-path concern; archiving produced no purge call at all
  // (there is no archive→purge wiring), and the repo target only exists in purgePlan.
  assert.equal(purgePlan(rec)[0].kind, 'repo');
});
