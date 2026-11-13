/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 — the identity a queued run executes as is re-read LIVE, never trusted
 * USER STORY: As a security reviewer I want a job that sat in the queue (or was retried an hour
 *             later by the reaper) to execute under the runner's CURRENT identity, and to be
 *             refused — typed, visibly — when that identity no longer holds what the run was filed
 *             under: the account gone or disabled, the role downgraded, the domain left.
 * ARCHITECTURE:
 *   - `hydrateRunner` with the directory lookup injected, so no store and no session are needed.
 *     This is the queue's form of A2's resume rule (`engine/resume.ts`), applied to `run_jobs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrateRunner, principalSnapshotOf } from '@tabs/agents/lib/engine/runner-identity';
import type { PrincipalSnapshot } from '@tabs/agents/lib/engine/jobs';

const SNAP: PrincipalSnapshot = { id: 'u1', name: 'Ada', role: 'builder', domains: ['sales', 'ops'], activeDomain: 'sales' };
const live = (over: Partial<{ role: PrincipalSnapshot['role']; domains: string[] }> = {}) =>
  async () => ({ id: 'u1', name: 'Ada Live', role: over.role ?? ('builder' as const), domains: over.domains ?? ['sales', 'ops'] });

test('A4 identity: the snapshot records what was true, including the active domain', () => {
  const snap = principalSnapshotOf({ id: 'u1', name: 'Ada', role: 'builder', domains: ['sales'], allDomains: ['sales', 'ops'], activeDomain: 'sales' });
  assert.deepEqual(snap, { id: 'u1', name: 'Ada', role: 'builder', domains: ['sales', 'ops'], activeDomain: 'sales' });
});

test('A4 identity: the LIVE principal is what executes, with the filed active domain kept', async () => {
  const out = await hydrateRunner(SNAP, 'sales', live());
  assert.ok('user' in out);
  assert.equal(out.user.name, 'Ada Live', 'the live record wins over the snapshot');
  assert.equal(out.user.activeDomain, 'sales');
  assert.deepEqual(out.user.domains, ['sales'], 'scoped to the active domain the run was filed in');
  assert.deepEqual(out.user.allDomains, ['sales', 'ops']);
});

test('A4 identity: an active domain the runner has since left falls back to their full scope', async () => {
  const out = await hydrateRunner(SNAP, 'ops', live({ domains: ['ops'] }));
  assert.ok('user' in out);
  assert.equal(out.user.activeDomain, null);
  assert.deepEqual(out.user.domains, ['ops']);
});

test('A4 identity: a deleted or disabled runner refuses the job', async () => {
  const out = await hydrateRunner(SNAP, 'sales', async () => null);
  assert.ok('refused' in out);
  assert.equal(out.refused.code, 'runner_unavailable');
});

test('A4 identity: a DOWNGRADED role refuses the job', async () => {
  const out = await hydrateRunner(SNAP, 'sales', live({ role: 'creator' }));
  assert.ok('refused' in out);
  assert.equal(out.refused.code, 'runner_role_changed');
  assert.match(out.refused.reason, /now creator, below the builder/);
});

test('A4 identity: a role UPGRADE runs — the yaml is re-governed against the owner on every run', async () => {
  const out = await hydrateRunner(SNAP, 'sales', live({ role: 'admin' }));
  assert.ok('user' in out);
  assert.equal(out.user.role, 'admin');
});

test('A4 identity: losing the run’s DOMAIN refuses the job', async () => {
  const out = await hydrateRunner(SNAP, 'sales', live({ domains: ['ops'] }));
  assert.ok('refused' in out);
  assert.equal(out.refused.code, 'runner_domain_lost');
  assert.match(out.refused.reason, /no longer a member of domain 'sales'/);
});
