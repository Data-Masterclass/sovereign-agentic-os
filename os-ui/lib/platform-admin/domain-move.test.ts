/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Tests for the cross-domain governance move (admin-only + audited). Drives the
 * central lib/platform-admin/domain-move.ts against a REAL store adapter
 * (lib/core/artifacts) so the whole path is exercised: gate → set → persist →
 * audit. Proves:
 *   • admin can move one artifact and bulk-assign unassigned artifacts,
 *   • creator/builder/domain_admin are denied (403),
 *   • the bulk sweep touches ONLY unassigned records (assigned ones untouched),
 *   • per-kind counts are correct, and
 *   • an audit entry is written for both the single and bulk move.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { moveArtifactDomain, moveUnassignedToDomain } from './domain-move.ts';
import { createArtifact, getArtifact, moveArtifactsDomain, __resetArtifactsCache } from '../core/artifacts.ts';
import { createDataset, getDataset, __resetStore as __resetData } from '../data/store.ts';
import { _resetAudit, listAudit } from './audit.ts';

type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';
function user(role: Role, domains = ['sales']) {
  return { id: `u_${role}`, name: role, domains, allDomains: domains, activeDomain: null, role } as const;
}
const admin = user('admin', ['sales', 'finance']);

beforeEach(() => {
  __resetArtifactsCache();
  __resetData();
  _resetAudit();
});

async function seedAssigned(name: string, domain: string) {
  return createArtifact(user('admin', [domain]), { type: 'dataset', name, domain });
}
/** Create an artifact then blank its domain to simulate an unassigned record. */
async function seedUnassigned(name: string) {
  const a = await createArtifact(user('admin', ['sales']), { type: 'dataset', name });
  await moveArtifactsDomain({ id: a.id }, '');
  return a;
}

test('admin can move a single artifact to a different domain (and it is audited)', async () => {
  const a = await seedAssigned('Orders', 'sales');
  const res = await moveArtifactDomain(admin, { kind: 'artifact', id: a.id, targetDomain: 'finance' });
  assert.equal(res.targetDomain, 'finance');
  assert.equal((await getArtifact(a.id))?.domain, 'finance');

  const entries = listAudit({ prefix: 'artifact.domain.move' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, admin.id);
  assert.equal(entries[0].target, `artifact:${a.id}`);
});

test('creator, builder and domain_admin are all denied (403) — single move', async () => {
  const a = await seedAssigned('Orders', 'sales');
  for (const role of ['creator', 'builder', 'domain_admin'] as Role[]) {
    await assert.rejects(
      () => moveArtifactDomain(user(role), { kind: 'artifact', id: a.id, targetDomain: 'finance' }),
      (e: { status?: number }) => e.status === 403,
      `${role} must be denied`,
    );
  }
  // The artifact was never moved by a denied caller.
  assert.equal((await getArtifact(a.id))?.domain, 'sales');
  // No audit entry for a denied attempt.
  assert.equal(listAudit({ prefix: 'artifact.domain' }).length, 0);
});

test('non-admin is denied (403) — bulk assign', async () => {
  await seedUnassigned('Loose');
  for (const role of ['creator', 'builder', 'domain_admin'] as Role[]) {
    await assert.rejects(
      () => moveUnassignedToDomain(user(role), 'finance'),
      (e: { status?: number }) => e.status === 403,
    );
  }
});

test('bulk sweep sets domain ONLY on unassigned records; assigned ones untouched', async () => {
  const assigned = await seedAssigned('Has domain', 'sales');
  const loose1 = await seedUnassigned('Loose 1');
  const loose2 = await seedUnassigned('Loose 2');

  const res = await moveUnassignedToDomain(admin, 'finance');

  // Exactly the two unassigned artifacts moved (per-kind count under 'artifact').
  assert.equal(res.total, 2);
  assert.equal(res.counts.artifact, 2);
  assert.equal((await getArtifact(loose1.id))?.domain, 'finance');
  assert.equal((await getArtifact(loose2.id))?.domain, 'finance');
  // The already-assigned artifact keeps its original domain.
  assert.equal((await getArtifact(assigned.id))?.domain, 'sales');

  // A summary audit entry is written for the bulk assign.
  const entries = listAudit({ prefix: 'artifact.domain.bulk-assign' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, admin.id);
  assert.equal(entries[0].target, 'domain:finance');
});

test('bulk sweep is a no-op when there are no unassigned records', async () => {
  await seedAssigned('A', 'sales');
  const res = await moveUnassignedToDomain(admin, 'finance');
  assert.equal(res.total, 0);
  assert.equal(res.counts.artifact, 0);
});

test('unknown kind → 400, empty target → 400', async () => {
  await assert.rejects(
    () => moveArtifactDomain(admin, { kind: 'nope', id: 'x', targetDomain: 'finance' }),
    (e: { status?: number }) => e.status === 400,
  );
  await assert.rejects(
    () => moveArtifactDomain(admin, { kind: 'artifact', id: 'x', targetDomain: '  ' }),
    (e: { status?: number }) => e.status === 400,
  );
});

test('moving a missing id → 404', async () => {
  await assert.rejects(
    () => moveArtifactDomain(admin, { kind: 'artifact', id: 'does_not_exist', targetDomain: 'finance' }),
    (e: { status?: number }) => e.status === 404,
  );
});

test('dataset move updates the yaml-embedded domain (scoping reads the yaml)', async () => {
  // A dataset carries its domain in BOTH the record field and its canonical yaml;
  // getDataset() parses the yaml, so a correct move must re-serialize it.
  const d = createDataset(admin, { name: 'Yaml-backed', domain: 'sales' });
  const res = await moveArtifactDomain(admin, { kind: 'dataset', id: d.id, targetDomain: 'finance' });
  assert.equal(res.targetDomain, 'finance');
  assert.equal(getDataset(d.id, admin).domain, 'finance');
});

test('MOVABLE_KINDS covers the expected artifact kinds and excludes metrics', async () => {
  const { MOVABLE_KINDS } = await import('./domain-move.ts');
  for (const k of ['artifact', 'dataset', 'dashboard', 'file', 'workflow', 'knowledge', 'agent', 'model', 'pillar', 'bigbet', 'connection', 'app']) {
    assert.ok(MOVABLE_KINDS.includes(k), `expected kind ${k}`);
  }
  assert.ok(!MOVABLE_KINDS.includes('metric'), 'metrics have no domain of their own');
});
