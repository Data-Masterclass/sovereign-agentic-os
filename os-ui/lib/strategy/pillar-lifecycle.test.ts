/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase-0 pillar lifecycle + versioning (server store, lib/strategy/pillars.ts):
 *   • archive → restore → physical delete, each version-logged;
 *   • a create + edit + archive/restore snapshot the version history;
 *   • deleting a pillar that still has linked bets is BLOCKED (409, non-destructive);
 *   • personal (My) create + list; archived pillars hidden unless opted in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPillar,
  listPillars,
  archivePillar,
  unarchivePillar,
  deletePillar,
  listPillarVersions,
  restorePillarVersion,
  updatePillar,
  promotePillar,
  demotePillar,
  __resetForTests,
} from './pillars.ts';
import type { CurrentUser } from '../core/auth.ts';

const admin: CurrentUser = { id: 'u-admin', name: 'Ada', role: 'admin', domains: ['platform'] };
const builder: CurrentUser = { id: 'u-b', name: 'Bo', role: 'builder', domains: ['sales'] };

test('personal (My) create: owner-only visibility + hidden from a peer', async () => {
  __resetForTests();
  const p = await createPillar(builder, { name: 'My focus', scope: 'personal' });
  assert.equal(p.scope, 'personal');
  assert.ok((await listPillars(builder)).some((x) => x.id === p.id), 'owner sees their My pillar');
  const peer: CurrentUser = { id: 'u-peer', name: 'Pi', role: 'builder', domains: ['sales'] };
  assert.equal((await listPillars(peer)).some((x) => x.id === p.id), false, 'a peer never sees a My pillar');
});

test('archive → restore → delete, each version-logged; delete purges history', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  // create snapshot
  assert.equal((await listPillarVersions(admin, p.id)).length, 1, 'create logs v1');

  await updatePillar(admin, p.id, { description: 'edited' });
  assert.equal((await listPillarVersions(admin, p.id)).length, 2, 'edit logs a version');

  const archived = await archivePillar(admin, p.id);
  assert.equal(archived.archived, true, 'archive sets the flag');
  // hidden by default, visible with includeArchived
  assert.equal((await listPillars(admin)).some((x) => x.id === p.id), false, 'archived hidden by default');
  assert.ok((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), 'opt-in shows it');

  const restored = await unarchivePillar(admin, p.id);
  assert.equal(restored.archived, false, 'restore clears the flag');
  assert.ok((await listPillars(admin)).some((x) => x.id === p.id), 'restored back into the working list');

  const versionsBeforeDelete = (await listPillarVersions(admin, p.id)).length;
  assert.ok(versionsBeforeDelete >= 4, 'create+edit+archive+restore all logged');

  await deletePillar(admin, p.id);
  assert.equal((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), false, 'gone');
  // The pillar itself is gone → a version query is a typed 404 (nothing to view),
  // and the underlying history was purged.
  await assert.rejects(
    () => listPillarVersions(admin, p.id),
    (e: Error & { status?: number }) => e.status === 404,
    'version history unavailable after hard delete',
  );
});

test('restorePillarVersion reverts content + is itself reversible (snapshots current first)', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'V1', scope: 'tenant' });
  await updatePillar(admin, p.id, { name: 'V2' });
  const versions = await listPillarVersions(admin, p.id); // newest-first
  const v1 = versions.find((v) => (v.state as { name?: string }).name === 'V1')!;
  assert.ok(v1, 'the v1 snapshot exists');

  const restored = await restorePillarVersion(admin, p.id, v1.version);
  assert.equal(restored.name, 'V1', 'content reverted to v1');
  // Restore snapshots the current (V2) state first → the V2 state is recoverable.
  const after = await listPillarVersions(admin, p.id);
  assert.ok(after.some((v) => (v.state as { name?: string }).name === 'V2'), 'V2 kept as a version, restore is reversible');
});

test('promote My→Domain→Company then demote back down, each tier round-trips + is version-logged', async () => {
  __resetForTests();
  // A builder OWNS a My pillar in their domain.
  const p = await createPillar(builder, { name: 'Retention', scope: 'personal' });
  assert.equal(p.scope, 'personal');

  // My → Domain (owning in-domain builder promotes).
  const dom = await promotePillar(builder, p.id);
  assert.equal(dom.scope, 'domain');
  assert.equal(dom.domain, 'sales', 'keeps its owning domain');

  // Domain → Company (Admin only).
  const co = await promotePillar(admin, p.id);
  assert.equal(co.scope, 'tenant');
  assert.equal(co.domain, 'tenant', 'a Company pillar carries the literal tenant domain');

  // Company → Domain (Admin revoke) restores a real owning domain (the admin's).
  const backDom = await demotePillar(admin, p.id);
  assert.equal(backDom.scope, 'domain');
  assert.equal(backDom.domain, 'platform', 'revoke from Company lands in the acting admin\'s domain');

  // Domain → My (owning builder unshares). Owner is the builder, so re-home first
  // is irrelevant — but the admin re-homed it to 'platform', so demote as admin.
  const backMy = await demotePillar(admin, p.id);
  assert.equal(backMy.scope, 'personal', 'unshared back down to My');

  // The pillar is now a My pillar owned by the builder → the OWNER views its history.
  const log = await listPillarVersions(builder, p.id);
  assert.ok(log.some((v) => /revoke to Domain/i.test(v.summary ?? '')), 'demote to Domain is version-logged');
  assert.ok(log.some((v) => /revoke to My/i.test(v.summary ?? '')), 'demote to My is version-logged');
});

test('demotePillar is fail-closed: My has nothing to revoke; a creator cannot unshare from Domain', async () => {
  __resetForTests();
  // A My pillar cannot be demoted (already at the bottom).
  const my = await createPillar(builder, { name: 'Focus', scope: 'personal' });
  await assert.rejects(
    () => demotePillar(builder, my.id),
    (e: Error & { status?: number }) => e.status === 400 && /already at the My tier/i.test(e.message),
    'My pillar → 400 nothing to revoke',
  );

  // A Domain pillar cannot be unshared by a non-owner creator peer.
  const dom = await createPillar(builder, { name: 'Shared', scope: 'domain' });
  const creatorPeer: CurrentUser = { id: 'u-peer', name: 'Pi', role: 'creator', domains: ['sales'] };
  await assert.rejects(
    () => demotePillar(creatorPeer, dom.id),
    (e: Error & { status?: number }) => e.status === 403,
    'a creator peer cannot unshare a Domain pillar',
  );
});

test('deleting a pillar with linked bets is BLOCKED (409, non-destructive)', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Has bets', scope: 'tenant' });
  // Inject a linked bet id directly on the record (bypassing the bets-bridge stub,
  // which this unit does not exercise) to assert the delete-guard rule.
  const listed = await listPillars(admin, { includeArchived: true });
  const rec = listed.find((x) => x.id === p.id)!;
  rec.betIds.push('bet_linked');

  await assert.rejects(
    () => deletePillar(admin, p.id),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409, 'must be a 409 conflict');
      return /linked big bet/i.test(e.message);
    },
    'a pillar with live bets must not be deletable',
  );
  // Still present — nothing destroyed.
  assert.ok((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), 'pillar survives the blocked delete');
});
