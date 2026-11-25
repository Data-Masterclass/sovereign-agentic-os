/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete window: a domain delete that would remove ANY artifact needs it open
 * USER STORY: As the owner I want a domain holding anything — data, files, knowledge, connections,
 *             metrics, dashboards, agents, apps — deletable only during an announced delete
 *             window; only a truly empty domain may go without one. The backup gate stays.
 * ARCHITECTURE:
 *   - Engine rule (core/kernel/domain-delete.ts `planDomainDelete`): ONE block, component
 *     `delete-window`, counted over every component's `remove`, except the domain's own
 *     bookkeeping (`DOMAIN_BOOKKEEPING_COMPONENTS`: the record, memberships, policy entries,
 *     gateway team/keys), which every domain has, empty or not.
 *   - Owner's rule, 2026-11-25: "or any artifacts in the domain, not only data".
 *   - Twins: empty → no block; one file, no tables → blocked; tables → blocked; window open → not
 *     blocked; and the block refuses the run before the backup gate is even asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteDomain, planDomainDelete, DELETE_WINDOW_COMPONENT, type DomainDeleteComponent } from '@core/kernel/domain-delete';

const admin = { id: 'alex', role: 'admin' as const, domains: ['k'] };
const ctx = { domainId: 'k', actor: admin };
const freshBackup = async () => ({ ok: true as const, name: 'velero-x', at: new Date(Date.now() - 10 * 60_000).toISOString() });

function holds(component: string, n: number): DomainDeleteComponent {
  return {
    component,
    async plan() {
      return { component, remove: Array.from({ length: n }, (_, i) => ({ component, kind: 'thing', id: `${component}-${i}`, label: `${component}-${i}` })), keep: [] };
    },
    async remove() { return 'gone'; },
  };
}

// Every domain has these, empty or not: the record, its members' memberships, its policy entries.
const bookkeeping = () => [holds('opa', 3), holds('users', 2), holds('domain', 1)];
const windowBlock = (p: Awaited<ReturnType<typeof planDomainDelete>>) => p.components.find((c) => c.component === DELETE_WINDOW_COMPONENT)?.blocked ?? [];

test('an empty domain (bookkeeping only) needs no delete window', async () => {
  const p = await planDomainDelete([holds('os.files', 0), holds('trino', 0), ...bookkeeping()], ctx, true, { windowOpen: () => false });
  assert.deepEqual(windowBlock(p), []);
  assert.equal(p.totals.blocked, 0);
});

test('one file and no tables, window closed → blocked, with the count', async () => {
  const p = await planDomainDelete([holds('os.files', 1), holds('trino', 0), ...bookkeeping()], ctx, true, { windowOpen: () => false });
  const b = windowBlock(p);
  assert.equal(b.length, 1);
  assert.equal(p.totals.blocked, 1);
  assert.match(b[0].reason, /delete window closed — 1 item would be removed/);
});

test('tables, window closed → blocked (one block, all artifacts counted)', async () => {
  const p = await planDomainDelete([holds('trino', 8), holds('os.datasets', 2), ...bookkeeping()], ctx, true, { windowOpen: () => false });
  const b = windowBlock(p);
  assert.equal(b.length, 1);
  assert.match(b[0].reason, /10 items would be removed/);
});

test('window open → not blocked, whatever the domain holds', async () => {
  const p = await planDomainDelete([holds('os.files', 1), holds('trino', 8), ...bookkeeping()], ctx, true, { windowOpen: () => true });
  assert.deepEqual(windowBlock(p), []);
  assert.equal(p.totals.blocked, 0);
});

test('the run is refused while the window is closed, and goes once it is open', async () => {
  const audit = () => {};
  const comps = () => [holds('knowledge', 1), ...bookkeeping()];
  const closed = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: comps(), audit, backup: freshBackup, deleteWindow: () => false });
  assert.equal(closed.status, 'refused');
  assert.match(closed.status === 'refused' ? closed.reason : '', /delete-window/);
  const open = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: comps(), audit, backup: freshBackup, deleteWindow: () => true });
  assert.equal(open.status, 'done');
});

test('an empty domain runs with the window closed, but still needs the backup', async () => {
  const audit = () => {};
  const noBackup = async () => ({ ok: false as const, reason: 'no Velero' });
  const r = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: bookkeeping(), audit, backup: noBackup, deleteWindow: () => false });
  assert.equal(r.status, 'refused');
  assert.match(r.status === 'refused' ? r.reason : '', /backup/i);
  const ok = await deleteDomain('k', { dryRun: false, confirm: 'k' }, { actor: admin, components: bookkeeping(), audit, backup: freshBackup, deleteWindow: () => false });
  assert.equal(ok.status, 'done');
});
