/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Delete domain's admin-side rules: which target may be deleted, which backup counts,
 *             and that an admin is never deactivated
 * USER STORY: As the admin I want a delete refused for anything that is not a plain registered
 *             domain, refused without a fresh backup PAIR, and never to lock out another admin.
 * ARCHITECTURE:
 *   - In-memory user and domain stores; the Velero read is the injected Kubernetes GET (the live
 *     read itself is not exercised here). Each rule has a negative twin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertDeletableDomain, veleroBackupCheck, membersComponent } from '@tabs/admin/lib/domain-delete';
import { createDomain, _reset as resetDomains } from '@tabs/admin/lib/domains';
import { createUser, __resetUsers } from '@tabs/admin/lib/users';

beforeEach(() => { resetDomains(); __resetUsers(); });

test('only a registered, non-reserved domain that is not a user id may be deleted', async () => {
  createDomain({ name: 'kiekert', owner: 'a' });
  await assertDeletableDomain('kiekert');
  for (const id of ['platform', 'user-abc', 'company', 'nope', 'Kiekert', '../x']) {
    await assert.rejects(assertDeletableDomain(id), /reserved|not a registered|not a domain id/, id);
  }
  createDomain({ name: 'tobias', owner: 'a' });
  await createUser({ id: 'tobias', password: 'Tobias-Passw0rd!x', domains: ['kiekert'], role: 'creator', email: 't@example.org' });
  await assert.rejects(assertDeletableDomain('tobias'), /user id/);
});

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const backup = (o: { name?: string; vel?: number; pg?: number; ns?: string[]; polaris?: string; label?: string }) => ({
  metadata: {
    name: o.name ?? 'pre-upgrade-1',
    labels: { 'sovereign-os.io/pre-upgrade-backup': o.label ?? 'true' },
    annotations: { 'sovereign-os.io/pg-dump-completed': iso(o.pg ?? 10), 'sovereign-os.io/pg-dump-polaris': o.polaris ?? 'verified' },
  },
  spec: { includedNamespaces: o.ns ?? ['agentic-os', 'agentic-apps'] },
  status: { phase: 'Completed', completionTimestamp: iso(o.vel ?? 5) },
});
const gate = (items: unknown[]) => veleroBackupCheck({ veleroNamespace: 'velero', namespaces: ['agentic-os', 'agentic-apps'], get: async () => ({ status: 200, body: { items } }) })();

test('the backup gate takes a pre-upgrade-backup.sh PAIR and dates it by its OLDER half', async () => {
  const r = await gate([backup({ vel: 5, pg: 30 })]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.at, iso(30));
});

test('negative twins: no apps namespace, an unverified dump, a plain Velero backup, an unreadable API', async () => {
  assert.equal((await gate([backup({ ns: ['agentic-os'] })])).ok, false);
  assert.equal((await gate([backup({ polaris: 'missing' })])).ok, false);
  assert.equal((await gate([backup({ label: 'false' })])).ok, false);
  const down = await veleroBackupCheck({ veleroNamespace: 'velero', get: async () => ({ status: 0, body: {} }) })();
  assert.equal(down.ok, false);
});

test('an admin whose only domain is the deleted one is BLOCKED, never deactivated; a creator is', async () => {
  await createUser({ id: 'boss', password: 'Boss-Passw0rd!x1', domains: ['k'], role: 'admin', email: 'b@example.org' });
  await createUser({ id: 'jo', password: 'Jo-Passw0rd!x12', domains: ['k'], role: 'creator', email: 'j@example.org' });
  const p = await membersComponent().plan({ domainId: 'k', actor: { id: 'other', role: 'admin', domains: ['k'] } });
  assert.deepEqual(p.blocked?.map((b) => b.id), ['boss']);
  assert.deepEqual(p.remove.map((i) => `${i.kind}:${i.id}`), ['deactivate:jo']);
});
