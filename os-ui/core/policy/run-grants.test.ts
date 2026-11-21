/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The pure run-start check of a Dagster run grant (WP-15).
 * USER STORY: As a data owner I want a run that differs from my grant in any way to be refused.
 * ARCHITECTURE:
 * Unit contracts of `verifyRun` and the ids/hashes the generator and the OS share. The real proof
 * (Dagster + Trino 476 + OPA + Postgres) is tests/dagster/run-identity.int.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeUntil, selectionHash, standingGrantId, verifyRun, type RunGrantRow, type RunView } from '@core/policy/run-grants';

const now = new Date('2026-11-21T12:00:00Z');
const SHA = 'a'.repeat(40);
const ds: RunGrantRow = {
  id: 'rg_ds_1', kind: 'dataset', principal_uid: 'alice', domain: 'sales', dataset: 'ds_1',
  selection_hash: selectionHash([['sales', 'gold_x'], ['sales', 'silver_x']]), commit: SHA,
  expires_at: new Date('2026-11-21T13:00:00Z'), revoked_at: null, active_run_id: null, active_until: null, scopes: [],
};
const run: RunView = {
  runId: 'r1', status: 'STARTED', jobName: 'sales__all', assetSelection: ['sales/silver_x', 'sales/gold_x'],
  tags: { 'os/run_grant': 'rg_ds_1', 'os/principal': 'alice', 'os/domain': 'sales', 'os/dataset': 'ds_1', 'os/commit': SHA },
};

test('a run that matches its launched grant is allowed (selection order does not matter)', () => {
  assert.deepEqual(verifyRun(ds, run, now), { ok: true });
});

test('every mismatch is refused, with its reason', () => {
  const cases: [string, RunGrantRow, RunView, RegExp][] = [
    ['tampered principal', ds, { ...run, tags: { ...run.tags, 'os/principal': 'bob' } }, /another principal/],
    ['wrong commit', ds, { ...run, tags: { ...run.tags, 'os/commit': 'b'.repeat(40) } }, /another commit/],
    ['wider selection', ds, { ...run, assetSelection: [...run.assetSelection, 'sales/gold_other'] }, /other assets/],
    ['other dataset', ds, { ...run, tags: { ...run.tags, 'os/dataset': 'ds_2' } }, /another dataset/],
    ['other domain', ds, { ...run, tags: { ...run.tags, 'os/domain': 'hr' } }, /another domain/],
    ['no grant tag', ds, { ...run, tags: { ...run.tags, 'os/run_grant': '' } }, /does not carry/],
    ['expired', { ...ds, expires_at: new Date('2026-11-21T11:00:00Z') }, run, /expired/],
    ['revoked', { ...ds, revoked_at: new Date('2026-11-21T11:00:00Z') }, run, /revoked/],
    ['agent grant', { ...ds, kind: 'run' }, run, /agent run grant/],
    ['run already over', ds, { ...run, status: 'SUCCESS' }, /not starting/],
  ];
  for (const [what, g, r, reason] of cases) {
    const v = verifyRun(g, r, now);
    assert.equal(v.ok, false, what);
    assert.match(v.ok ? '' : v.reason, reason, what);
  }
});

test('a standing grant spans commits, but only scheduled runs on a commit of the domain', () => {
  const st: RunGrantRow = { ...ds, id: 'rg_std_x', kind: 'standing', selection_hash: null, commit: null };
  const sched: RunView = { ...run, tags: { ...run.tags, 'os/run_grant': 'rg_std_x', 'os/schedule': 'sales__ds_1', 'os/commit': 'c'.repeat(40) } };
  assert.deepEqual(verifyRun(st, sched, now, () => true), { ok: true });
  assert.match((verifyRun(st, sched, now, () => false) as { reason: string }).reason, /not on the domain repository/);
  const adhoc = { ...sched, tags: { ...sched.tags, 'os/schedule': '' } };
  assert.match((verifyRun(st, adhoc, now, () => true) as { reason: string }).reason, /scheduled runs only/);
});

test('ids and hashes are stable and order-independent', () => {
  assert.equal(standingGrantId('sales', 'ds_1', 'alice', 's'), standingGrantId('sales', 'ds_1', 'alice', 's'));
  assert.notEqual(standingGrantId('sales', 'ds_1', 'alice', 's'), standingGrantId('sales', 'ds_1', 'bob', 's'));
  assert.match(standingGrantId('sales', 'ds_1', 'alice', 's'), /^rg_std_[0-9a-f]{24}$/);
  assert.equal(selectionHash([['a', 'b'], ['c', 'd']]), selectionHash(['c/d', 'a/b']));
});

test('a standing grant is bound to its Dagster job: another job (another selection) is refused', () => {
  const st: RunGrantRow = { ...ds, id: 'rg_std_x', kind: 'standing', selection_hash: null, commit: null, scopes: ['dagster-job:sales__ds_1'] };
  const tags = { ...run.tags, 'os/run_grant': 'rg_std_x', 'os/schedule': 'sales__ds_1', 'os/commit': 'c'.repeat(40) };
  assert.deepEqual(verifyRun(st, { ...run, jobName: 'sales__ds_1', tags }, now, () => true), { ok: true });
  const other = verifyRun(st, { ...run, jobName: 'sales__all', tags }, now, () => true);
  assert.match(other.ok ? '' : other.reason, /another job/);
  const retag = verifyRun(st, { ...run, jobName: 'sales__ds_1', tags: { ...tags, 'os/schedule': 'sales__ds_2' } }, now, () => true);
  assert.match(retag.ok ? '' : retag.reason, /another job/);
});

test('activation never moves the window: a second step of the same run keeps the first active_until', () => {
  assert.equal(activeUntil({ ...ds, active_run_id: 'r1', active_until: new Date('2026-11-21T12:30:00Z') }, 'r1', now).toISOString(), '2026-11-21T12:30:00.000Z');
  assert.equal(activeUntil({ ...ds, expires_at: new Date('2026-11-22T00:00:00Z') }, 'r1', now).toISOString(), '2026-11-21T18:00:00.000Z', 'a first activation: now + 6 h');
  assert.equal(activeUntil({ ...ds, expires_at: new Date('2026-11-21T13:00:00Z') }, 'r1', now).toISOString(), '2026-11-21T13:00:00.000Z', 'never past the grant');
});
